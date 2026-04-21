'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, Notification,
  shell, clipboard, nativeImage, desktopCapturer, screen
} = require('electron');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');
const fs     = require('fs');
const http   = require('http');
const { exec } = require('child_process');
const Store  = require('electron-store');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ── Pro feature guard ────────────────────────────────────────────────────────
// Wraps ipcMain.handle for any channel that touches a Pro-only feature. When
// the license manager says the user is not allowed (trial ended, subscription
// lapsed) the call throws PRO_REQUIRED instead of running. Cannot be bypassed
// from the renderer — even if the devtools user calls window.H.agentRun() the
// check still fires here in the main process.
//
// The list is intentionally broad: anything that costs money (AI calls, TTS,
// STT), controls the OS (computer use, shell, file writes), or is the core
// differentiator (agent, workflows, recorder) goes in.
const PRO_HANDLERS = new Set([
  // AI / costly
  'ai', 'agentRun', 'agentTool', 'analyzeScreen', 'analyzeImage',
  'ttsElevenLabs', 'ttsOpenAI', 'transcribeAudio',
  'search', 'mcpWebSearch',
  'captureScreen', 'pcScreenshot',
  'executeCode',
  // Computer use / OS control
  'pcShell', 'pcKillProc', 'pcOpen',
  'pcType', 'pcKeyPress', 'pcVolume',
  'pcReadFile', 'pcWriteFile', 'pcListDir',
  'pcMouseMove', 'pcMouseClick', 'pcMouseDoubleClick',
  'pcMouseScroll', 'pcMouseDrag',
  'smartClick', 'findUIElements',
  // Browser automation
  'browserOpenUrl', 'browserSearch', 'browserOpenSite',
  // MCP write actions
  'mcpGmailSend', 'mcpCalendarCreate', 'mcpCalendarQuickAdd',
  // Workflows / recorder
  'workflowRun',
  'recorderStart', 'recorderStop', 'recorderSave', 'recorderNarrate',
]);

let _licenseManagerRef = null;  // populated once licenseManager is constructed.
let _proGuardWindowRef = null;  // populated once the main window exists.
const _origIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function proGuardedHandle(channel, fn) {
  if (!PRO_HANDLERS.has(channel)) return _origIpcHandle(channel, fn);
  return _origIpcHandle(channel, async (...args) => {
    const lm = _licenseManagerRef;
    if (lm) {
      const state = lm.evaluate();
      if (!state.allowed) {
        // Redirect the window to progate — users get a clear UX instead of
        // a mysterious red toast when they click a Pro feature after expiry.
        try {
          const w = _proGuardWindowRef;
          if (w && !w.isDestroyed()) {
            const cur = w.webContents.getURL();
            if (!cur.includes('/progate.html')) {
              w.loadURL(`http://127.0.0.1:${port}/progate.html`);
            }
          }
        } catch (_) {}
        const err = new Error('PRO_REQUIRED');
        err.code = 'PRO_REQUIRED';
        err.licenseState = state;
        throw err;
      }
    }
    return fn(...args);
  });
};

// ── Storage ───────────────────────────────────────────────────────────────────
const machineId = crypto.createHash('sha256')
  .update(os.hostname() + os.platform() + (os.cpus()[0]?.model || ''))
  .digest('hex').slice(0, 32);

const keysStore     = new Store({ name: 'horizon-keys',     encryptionKey: machineId });
const settingsStore = new Store({ name: 'horizon-settings' });

// ── Source-preview build check ────────────────────────────────────────────────
// The CI release workflow (.github/workflows/release.yml) writes build-info.json
// into this directory before packaging. When the app is run from a source clone
// the file doesn't exist — we show a preview window and exit. Source is MIT and
// readable for audit/contribution; runnable builds come from GitHub Releases.
const BUILD_INFO_PATH = path.join(__dirname, 'build-info.json');
let IS_OFFICIAL_BUILD = false;
let BUILD_INFO = null;
try {
  BUILD_INFO = JSON.parse(fs.readFileSync(BUILD_INFO_PATH, 'utf8'));
  IS_OFFICIAL_BUILD = BUILD_INFO && BUILD_INFO.official === true;
} catch { /* source clone — will show preview */ }

function showSourcePreview() {
  const pwin = new BrowserWindow({
    width: 620, height: 620,
    resizable: false, maximizable: false, fullscreenable: false,
    center: true, backgroundColor: '#0c0b09',
    title: 'Horizon AI — Source Preview',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  pwin.setMenu(null);
  pwin.loadFile(path.join(__dirname, '../renderer/pages/preview.html'));
  // Open all external links in the user's default browser, don't navigate inside the window
  pwin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  pwin.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); }
  });
  pwin.on('closed', () => { app.quit(); });
}

// ── HTTP server (mic permissions + voice proxy) ───────────────────────────────
let srv, port = 0;

function startServer() {
  return new Promise(res => {
    const PAGES = path.join(__dirname, '../renderer/pages');
    srv = http.createServer((req, rsp) => {
      rsp.setHeader('Access-Control-Allow-Origin', '*');
      rsp.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Api-Key,X-Lang,X-Provider');
      if (req.method === 'OPTIONS') { rsp.writeHead(204); rsp.end(); return; }
      // Static pages
      let p = req.url.split('?')[0];
      if (p === '/') p = '/chat.html';
      const full = path.join(PAGES, p);
      fs.readFile(full, (err, data) => {
        if (err) { rsp.writeHead(404); rsp.end('Not found'); return; }
        const ext = path.extname(full);
        const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.ico':'image/x-icon'}[ext]||'text/plain';
        rsp.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
        rsp.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => { port = srv.address().port; res(port); });
  });
}

// ── Window & Tray ─────────────────────────────────────────────────────────────
let win = null;
let tray = null;
let isQuitting = false;

function createWindow(page = 'chat') {
  const url = `http://127.0.0.1:${port}/${page}.html`;
  if (win) { win.loadURL(url); win.show(); return; }

  // Open at ~75% of the primary display, clamped to a sensible max.
  // User can still resize freely; this just avoids the old 420×820 postage-stamp.
  const { screen } = require('electron');
  const primary = screen.getPrimaryDisplay();
  const work = primary.workAreaSize;
  const initW = Math.min(1280, Math.max(1000, Math.round(work.width  * 0.75)));
  const initH = Math.min(860,  Math.max(720,  Math.round(work.height * 0.82)));

  win = new BrowserWindow({
    width: initW, height: initH,
    minWidth: 900, minHeight: 640,
    center: true,
    frame: false, transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    }
  });

  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(true));
  win.webContents.session.setPermissionCheckHandler(() => true);
  win.webContents.session.setDevicePermissionHandler(() => true);

  // Let the Pro guard redirect here if a user hits a Pro handler after expiry.
  _proGuardWindowRef = win;

  win.loadURL(url);

  win.on('close', e => {
    if (!isQuitting) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, '../../assets/icon.png');
    let img;
    try { img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }); }
    catch { img = nativeImage.createEmpty(); }
    tray = new Tray(img);
    tray.setToolTip('Horizon AI — Say "Horizon" to activate');
    updateTrayMenu();
    tray.on('click', () => { win?.isVisible() ? win.hide() : (win?.show(), win?.focus()); });
    tray.on('double-click', () => { win?.show(); win?.focus(); });
  } catch(e) { console.error('Tray:', e.message); }
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '◈ Horizon AI', enabled: false },
    { type: 'separator' },
    { label: 'Open',     click: () => { win?.show(); win?.focus(); } },
    { label: 'Settings', click: () => { win?.show(); win?.webContents?.executeJavaScript('openPanel&&openPanel()'); } },
    { type: 'separator' },
    { label: 'Quit',     click: () => { isQuitting = true; app.quit(); } }
  ]));
}

// ── IPC: Window ────────────────────────────────────────────────────────────────
ipcMain.on('minimize', () => win?.minimize());
ipcMain.on('hide',     () => win?.hide());
ipcMain.on('quit',     () => { isQuitting = true; app.quit(); });
ipcMain.handle('go',   (_, p) => { createWindow(p); return true; });

// ── IPC: Keys & Settings ──────────────────────────────────────────────────────
ipcMain.handle('saveKey',   (_, s, k) => { keysStore.set(`k_${s}`, k);    return true; });
ipcMain.handle('getKey',    (_, s)    => keysStore.get(`k_${s}`, null));
ipcMain.handle('hasKey',    (_, s)    => !!keysStore.get(`k_${s}`));
ipcMain.handle('deleteKey', (_, s)    => { keysStore.delete(`k_${s}`);     return true; });
ipcMain.handle('set',       (_, k, v) => { settingsStore.set(k, v);        return true; });
ipcMain.handle('get',       (_, k)    => settingsStore.get(k, null));
ipcMain.handle('getPort',   ()        => port);

// ── IPC: Misc ─────────────────────────────────────────────────────────────────
ipcMain.handle('copy',         (_, t) => { clipboard.writeText(t); return true; });
ipcMain.handle('paste',        ()     => clipboard.readText());
ipcMain.handle('getClipboard', ()     => ({ text: clipboard.readText() }));
ipcMain.handle('openUrl',      (_, u) => { shell.openExternal(u); return true; });
ipcMain.handle('notify',       (_, t, b) => { new Notification({ title: `◈ ${t}`, body: b }).show(); return true; });

ipcMain.handle('sysInfo', () => ({
  platform: IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux',
  hostname: os.hostname(),
  user:     os.userInfo().username,
  home:     os.homedir(),
  ram:      (os.totalmem() / 1e9).toFixed(1) + ' GB',
  freeRam:  (os.freemem()  / 1e9).toFixed(1) + ' GB',
  cpu:      os.cpus()[0]?.model || 'Unknown',
  cores:    os.cpus().length,
  uptime:   Math.round(os.uptime() / 3600) + 'h',
  time:     new Date().toLocaleString(),
  arch:     os.arch()
}));

// ── VOICE: Multiple free/paid providers ───────────────────────────────────────
// Groq Whisper  — FREE (2h audio/day, fastest)  → groq.com
// OpenAI Whisper — $0.006/min                   → platform.openai.com
// Deepgram Nova-2 — FREE $200 credit             → deepgram.com
ipcMain.handle('transcribeAudio', async (_, base64Audio, mimeType) => {
  const fetch    = require('node-fetch');
  const FormData = require('form-data');
  const voiceProv = settingsStore.get('voiceProvider') || 'groq';

  const buf = Buffer.from(base64Audio, 'base64');
  const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('ogg') ? 'ogg' : 'mp4';
  const tmp = path.join(os.tmpdir(), `horizon_audio_${Date.now()}.${ext}`);
  fs.writeFileSync(tmp, buf);
  const cleanup = () => { try { fs.unlinkSync(tmp); } catch {} };

  try {
    if (voiceProv === 'groq') {
      const key = keysStore.get('k_groq_voice') || keysStore.get('k_groq');
      if (!key) { cleanup(); return { error: 'Groq key needed for voice → Settings → Voice. Free at groq.com' }; }
      const form = new FormData();
      form.append('file', fs.createReadStream(tmp), { filename: `audio.${ext}`, contentType: mimeType.split(';')[0] });
      form.append('model', 'whisper-large-v3');
      form.append('response_format', 'json');
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST', headers: { 'Authorization': `Bearer ${key}`, ...form.getHeaders() }, body: form
      });
      const d = await r.json();
      cleanup();
      if (d.error) return { error: d.error.message };
      return { text: d.text };
    }

    if (voiceProv === 'openai') {
      const key = keysStore.get('k_openai');
      if (!key) { cleanup(); return { error: 'OpenAI key needed for voice → Settings' }; }
      const form = new FormData();
      form.append('file', fs.createReadStream(tmp), { filename: `audio.${ext}`, contentType: mimeType.split(';')[0] });
      form.append('model', 'whisper-1');
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { 'Authorization': `Bearer ${key}`, ...form.getHeaders() }, body: form
      });
      const d = await r.json();
      cleanup();
      if (d.error) return { error: d.error.message };
      return { text: d.text };
    }

    if (voiceProv === 'deepgram') {
      const key = keysStore.get('k_deepgram');
      if (!key) { cleanup(); return { error: 'Deepgram key needed → Settings. Free $200 credit at deepgram.com' }; }
      const audioData = fs.readFileSync(tmp);
      const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=multi', {
        method: 'POST', headers: { 'Authorization': `Token ${key}`, 'Content-Type': mimeType.split(';')[0] }, body: audioData
      });
      const d = await r.json();
      cleanup();
      if (d.err_msg) return { error: d.err_msg };
      return { text: d.results?.channels[0]?.alternatives[0]?.transcript || '' };
    }

    cleanup();
    return { error: `Unknown voice provider: ${voiceProv}` };
  } catch(e) { cleanup(); return { error: e.message }; }
});

// ── Screen Capture ────────────────────────────────────────────────────────────
ipcMain.handle('captureScreen', async () => {
  try {
    const disp    = screen.getPrimaryDisplay();
    const w       = Math.min(disp.workAreaSize.width, 1920);
    const h       = Math.min(disp.workAreaSize.height, 1080);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
    if (!sources.length) return { ok: false, error: 'No screen source' };
    const buf = sources[0].thumbnail.toPNG();
    const tmp = path.join(os.tmpdir(), `horizon_ss_${Date.now()}.png`);
    fs.writeFileSync(tmp, buf);
    return { ok: true, base64: buf.toString('base64'), path: tmp };
  } catch(e) { return { ok: false, error: e.message }; }
});

// ── Analyze Screen with Vision AI ─────────────────────────────────────────────
ipcMain.handle('analyzeScreen', async (_, question) => {
  const fetch = require('node-fetch');
  const userName = settingsStore.get('userName') || 'user';
  const lang = settingsStore.get('lang') || 'en';

  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
    if (!sources.length) return { error: 'Cannot capture screen' };
    const base64 = sources[0].thumbnail.toPNG().toString('base64');
    const q = question || (lang === 'ru'
      ? 'Что сейчас на экране? Опиши подробно. Если это игра — дай умный совет.'
      : 'What is on the screen? Describe everything. If it\'s a game, give smart strategic advice.');

    // Try Claude Vision
    const claudeKey = keysStore.get('k_claude');
    if (claudeKey) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-opus-4-5', max_tokens: 1024,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
            { type: 'text', text: q }
          ]}]
        })
      });
      const d = await r.json();
      if (!d.error) return { reply: d.content?.[0]?.text || 'No response', model: 'Claude Vision', base64 };
    }

    // Try GPT-4o Vision
    const openaiKey = keysStore.get('k_openai');
    if (openaiKey) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o', max_tokens: 1024,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
            { type: 'text', text: q }
          ]}]
        })
      });
      const d = await r.json();
      if (!d.error) return { reply: d.choices?.[0]?.message?.content || 'No response', model: 'GPT-4o Vision', base64 };
    }

    // Try Gemini Vision
    const geminiKey = keysStore.get('k_gemini');
    if (geminiKey) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [
          { inline_data: { mime_type: 'image/png', data: base64 } },
          { text: q }
        ]}]})
      });
      const d = await r.json();
      if (!d.error && d.candidates?.[0]?.content?.parts?.[0]?.text) return { reply: d.candidates[0].content.parts[0].text, model: 'Gemini Vision', base64 };
    }

    return { error: lang === 'ru'
      ? 'Нет ключа для Vision AI. Добавь Claude, OpenAI или Gemini в Настройках.'
      : 'No Vision AI key. Add Claude, OpenAI, or Gemini key in Settings.' };
  } catch(e) { return { error: e.message }; }
});

// ── Shell helper ──────────────────────────────────────────────────────────────
function runShell(cmd, timeout = 12000) {
  return new Promise(resolve => {
    exec(cmd, { timeout, encoding: 'utf8', shell: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || stderr || '').trim().slice(0, 3000), err: err?.message });
    });
  });
}

// ── PC Control ────────────────────────────────────────────────────────────────
const WEB_APPS = {
  youtube:'https://youtube.com', gmail:'https://mail.google.com', google:'https://google.com',
  github:'https://github.com', chatgpt:'https://chatgpt.com', instagram:'https://instagram.com',
  twitter:'https://x.com', linkedin:'https://linkedin.com', netflix:'https://netflix.com',
  reddit:'https://reddit.com', twitch:'https://twitch.tv', notion:'https://notion.so', figma:'https://figma.com',
  vk:'https://vk.com', telegram:'https://web.telegram.org', tiktok:'https://tiktok.com',
  spotify:'https://open.spotify.com', claude:'https://claude.ai', maps:'https://maps.google.com',
  pinterest:'https://pinterest.com', discord:'https://discord.com/app',
};

const APP_WIN_MAP = {
  chrome:'start "" "chrome" 2>nul || start "" "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" 2>nul || start "" "msedge"', firefox:'start "" "firefox" 2>nul || start "" "%ProgramFiles%\\Mozilla Firefox\\firefox.exe"', браузер:'start "" "chrome" 2>nul || start "" "msedge" 2>nul || start "" "firefox"',
  edge:'start "" "msedge"', notepad:'notepad', блокнот:'notepad',
  calc:'calc', calculator:'calc', калькулятор:'calc',
  explorer:'explorer', проводник:'explorer',
  spotify:'start "" "%APPDATA%\\Spotify\\Spotify.exe"',
  discord:'start "" "%LOCALAPPDATA%\\Discord\\Update.exe" --processStart Discord.exe',
  code:'code', vscode:'code', 'visual studio code':'code',
  telegram:'start "" "%APPDATA%\\Telegram Desktop\\Telegram.exe"',
  word:'start winword', excel:'start excel', powerpoint:'start powerpnt',
  taskmgr:'taskmgr', 'task manager':'taskmgr',
  cmd:'start cmd', terminal:'start cmd', консоль:'start cmd',
  powershell:'start powershell', paint:'mspaint',
  snipping:'snippingtool', scissors:'snippingtool',
  settings:'start ms-settings:', steam:'start "" "steam://open/main"',
  slack:'start "" "%LOCALAPPDATA%\\slack\\slack.exe"',
};

const APP_MAC_MAP = {
  chrome:'open -a "Google Chrome"', браузер:'open -a "Google Chrome"',
  firefox:'open -a Firefox', safari:'open -a Safari', edge:'open -a "Microsoft Edge"',
  terminal:'open -a Terminal', finder:'open -a Finder',
  spotify:'open -a Spotify', discord:'open -a Discord',
  vscode:'open -a "Visual Studio Code"', code:'open -a "Visual Studio Code"',
  telegram:'open -a Telegram', calculator:'open -a Calculator',
  notes:'open -a Notes', mail:'open -a Mail', slack:'open -a Slack'
};

// Russian→English app aliases
const APP_RU_ALIASES = {
  'ютуб':'youtube','ютьюб':'youtube','хром':'chrome','хромиум':'chrome',
  'файрфокс':'firefox','мозилла':'firefox','блокнот':'notepad',
  'калькулятор':'calculator','проводник':'explorer','эксплорер':'explorer',
  'терминал':'terminal','консоль':'cmd','командная строка':'cmd',
  'дискорд':'discord','телеграм':'telegram','тг':'telegram',
  'спотифай':'spotify','спотифи':'spotify','музыка':'spotify',
  'вскод':'vscode','визуал студио':'vscode','слак':'slack',
  'гугл':'google','нетфликс':'netflix','стим':'steam',
  'почта':'gmail','мейл':'gmail','инстаграм':'instagram','инста':'instagram',
  'твиттер':'twitter','реддит':'reddit','чатгпт':'chatgpt','линкедин':'linkedin',
  'ворд':'word','эксель':'excel','краска':'paint','браузер':'chrome',
};

// Smart open — handles "YouTube канал Мистер Бист", "поиск котов", etc.
function resolveAppName(raw) {
  const lo = raw.toLowerCase().trim();
  for (const [alias, target] of Object.entries(APP_RU_ALIASES)) {
    if (lo.includes(alias)) return target;
  }
  return lo;
}

function smartOpenUrl(raw) {
  const lo = raw.toLowerCase().trim();
  // YouTube channel
  const ytChanM = raw.match(/(?:youtube|ютуб|ютьюб)\s+(?:канал|channel)\s+(.+)/i);
  if (ytChanM) return `https://www.youtube.com/results?search_query=${encodeURIComponent(ytChanM[1]+'канал')}`;
  // YouTube search
  const ytSearchM = raw.match(/(?:youtube|ютуб)\s+(?:видео|поиск|search|смотреть|найди|открой)?\s*(.+)/i);
  if (ytSearchM && ytSearchM[1].length > 1) return `https://www.youtube.com/results?search_query=${encodeURIComponent(ytSearchM[1])}`;
  // Google search
  const gSearchM = raw.match(/(?:google|гугл)\s+(.+)/i);
  if (gSearchM) return `https://www.google.com/search?q=${encodeURIComponent(gSearchM[1])}`;
  // VK page
  const vkM = raw.match(/(?:вк|vk|вконтакте)\s+(.+)/i);
  if (vkM) return `https://vk.com/search?c[q]=${encodeURIComponent(vkM[1])}`;
  // Instagram profile
  const igM = raw.match(/(?:instagram|инстаграм)\s+(.+)/i);
  if (igM) return `https://www.instagram.com/${igM[1].replace(/\s+/g,'').replace(/^@/,'')}`;
  // Generic search on YouTube if the raw contains video/watch keywords
  if (/канал|видео|стрим|channel|stream|watch/i.test(raw)) {
    const q = raw.replace(/открой?|запусти|launch|open|start/i,'').trim();
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  }
  return null;
}

ipcMain.handle('pcOpen', async (_, appName) => {
  const raw = appName.trim();

  // 1. Smart URL
  const smartUrl = smartOpenUrl(raw);
  if (smartUrl) { shell.openExternal(smartUrl); return { ok: true, url: smartUrl }; }

  // 2. Absolute Windows path: D:\Game or C:\Users\...
  if (/^[A-Za-z]:[\\\/]/.test(raw)) {
    shell.openPath(raw); return { ok: true, opened: raw };
  }

  // 3. Folder request: "папку Game", "папку на D", "folder Game"
  const folderM = raw.match(/^(?:папку?|folder|директорию?|каталог|directory)\s+(.+)/i);
  if (folderM) {
    let name = folderM[1].trim();
    const driveM = name.match(/\s+(?:на\s+)?(?:диске\s+|drive\s+)?([A-Za-z])[:\s]*$/i);
    const drives = driveM ? [driveM[1].toUpperCase()] : ['D','C','E','F'];
    if (driveM) name = name.replace(driveM[0],'').trim();
    if (IS_WIN) {
      const user = os.userInfo().username;
      for (const d of drives) {
        const cands = [
          `${d}:\\${name}`,
          `${d}:\\Users\\${user}\\${name}`,
          `${d}:\\Users\\${user}\\Desktop\\${name}`,
          `${d}:\\Users\\${user}\\Documents\\${name}`,
          `${d}:\\Users\\${user}\\Downloads\\${name}`,
          `${d}:\\Games\\${name}`,
          `${d}:\\Program Files\\${name}`,
        ];
        for (const p of cands) {
          if (fs.existsSync(p)) { shell.openPath(p); return { ok: true, opened: p }; }
        }
      }
      const fallDrive = `${drives[0]}:\\`;
      shell.openPath(fallDrive);
      return { ok: false, notFound: name, opened: fallDrive };
    } else {
      const p = `${os.homedir()}/${name}`;
      shell.openPath(fs.existsSync(p) ? p : os.homedir());
      return { ok: true };
    }
  }

  // 4. Check if it's literally a folder on disk (no extension, no @, not a known app name)
  const KNOWN_APPS = /^(chrome|firefox|edge|discord|telegram|spotify|youtube|google|steam|code|vscode|notepad|calculator|slack|zoom|obs|paint|word|excel|powerpoint|settings|cmd|terminal|explorer|safari|finder)$/i;
  if (IS_WIN && !KNOWN_APPS.test(raw) && !/[.@:/]/.test(raw) && raw.length > 2) {
    const user = os.userInfo().username;
    const deskCands = [
      `D:\\${raw}`, `C:\\${raw}`,
      `C:\\Users\\${user}\\Desktop\\${raw}`,
      `D:\\Users\\${user}\\Desktop\\${raw}`,
      `C:\\Users\\${user}\\Documents\\${raw}`,
      `D:\\Users\\${user}\\Documents\\${raw}`,
    ];
    for (const p of deskCands) {
      if (fs.existsSync(p)) { shell.openPath(p); return { ok: true, opened: p }; }
    }
  }

  // 5. Known web apps
  const n = resolveAppName(raw);
  if (WEB_APPS[n]) { shell.openExternal(WEB_APPS[n]); return { ok: true }; }

  // 6. Native apps map
  let cmd;
  if (IS_WIN) {
    cmd = APP_WIN_MAP[n] || APP_WIN_MAP[raw.toLowerCase()];
    if (!cmd) cmd = `start "" "${raw}" 2>nul`;
  } else if (IS_MAC) {
    cmd = APP_MAC_MAP[n] || APP_MAC_MAP[raw.toLowerCase()] || `open -a "${raw}" 2>/dev/null || open "${raw}"`;
  } else {
    cmd = `xdg-open "${raw}" 2>/dev/null &`;
  }
  return runShell(cmd);
});

ipcMain.handle('pcOpenPath', (_, p) => {
  if (!p) return { ok: false };
  shell.openPath(p);
  return { ok: true, opened: p };
});

ipcMain.handle('pcScreenshot', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types:['screen'], thumbnailSize:{ width:1920, height:1080 } });
    if (!sources.length) return { ok:false, err:'No source' };
    const buf = sources[0].thumbnail.toPNG();
    const tmp = path.join(os.tmpdir(), `horizon_ss_${Date.now()}.png`);
    fs.writeFileSync(tmp, buf);
    return { ok:true, base64:buf.toString('base64'), path:tmp };
  } catch(e) { return { ok:false, err:e.message }; }
});

ipcMain.handle('pcShell',      async (_, cmd) => runShell(cmd));
ipcMain.handle('pcProcesses',  async ()        => runShell(IS_WIN ? 'tasklist /FO CSV /NH' : 'ps aux --sort=-%cpu | head -25'));
ipcMain.handle('pcKillProc',   async (_, n)    => runShell(IS_WIN ? `taskkill /F /IM "${n}"` : `pkill -f "${n}"`));
ipcMain.handle('pcClipboard',  ()              => ({ ok:true, out: clipboard.readText()||'(empty)' }));
ipcMain.handle('pcSetClip',    (_, t)          => { clipboard.writeText(t); return { ok:true }; });

ipcMain.handle('pcType', async (_, text) => {
  const esc = text.replace(/'/g, "''");
  let cmd;
  if (IS_WIN)      cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 200; [System.Windows.Forms.SendKeys]::SendWait('${esc.replace(/[+^%~(){}[\]]/g,'{$&}')}')"`;
  else if (IS_MAC) cmd = `osascript -e 'tell application "System Events" to keystroke "${text.replace(/"/g,'\\"')}"'`;
  else             cmd = `xdotool type --clearmodifiers --delay 20 '${esc}'`;
  return runShell(cmd);
});

ipcMain.handle('pcKeyPress', async (_, key) => {
  const wm = {'ctrl+c':'^c','ctrl+v':'^v','ctrl+z':'^z','ctrl+a':'^a','ctrl+s':'^s',
               'alt+f4':'%{F4}','alt+tab':'%{TAB}','enter':'{ENTER}','escape':'{ESC}','tab':'{TAB}',
               'win':'{LWIN}','f5':'{F5}','delete':'{DEL}','backspace':'{BS}'};
  let cmd;
  if (IS_WIN)      cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${wm[key.toLowerCase()]||`{${key.toUpperCase()}}`}')"`;
  else if (IS_MAC) cmd = `osascript -e 'tell application "System Events" to keystroke "${key}"'`;
  else             cmd = `xdotool key ${key}`;
  return runShell(cmd);
});

ipcMain.handle('pcVolume', async (_, level) => {
  let cmd;
  if (IS_WIN)      cmd = `powershell -NoProfile -Command "& {$v=[uint32](${level}/100.0*65535);Add-Type -TypeDefinition 'using System.Runtime.InteropServices;public class A{[DllImport(\\"winmm.dll\\")]public static extern int waveOutSetVolume(System.IntPtr h,uint v);}';[A]::waveOutSetVolume([System.IntPtr]::Zero,$v -bor ($v -shl 16))}"`;
  else if (IS_MAC) cmd = `osascript -e 'set volume output volume ${level}'`;
  else             cmd = `amixer sset Master ${level}%`;
  return runShell(cmd);
});

ipcMain.handle('pcReadFile',  (_, p) => { try { return {ok:true,content:fs.readFileSync(p,'utf8')}; } catch(e) { return {ok:false,err:e.message}; } });
ipcMain.handle('pcWriteFile', (_, p, c) => { try { fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,c,'utf8');return {ok:true}; } catch(e) { return {ok:false,err:e.message}; } });
ipcMain.handle('pcListDir',   (_, d) => { try { return {ok:true,entries:fs.readdirSync(d,{withFileTypes:true}).map(e=>({name:e.name,isDir:e.isDirectory()}))}; } catch(e) { return {ok:false,err:e.message}; } });

// ═══════════════════════════════════════════════════════════════════════════════
// MOUSE & KEYBOARD — PowerShell only (no external deps, works on all Windows)
// ═══════════════════════════════════════════════════════════════════════════════

const PS_MOUSE_CLASS = `Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class HorizonMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,int x,int y,int d,int e);
  public const uint MOVE=0x1,L_DOWN=0x2,L_UP=0x4,R_DOWN=0x8,R_UP=0x10,WHEEL=0x800;
}
'@ -PassThru`;

ipcMain.handle('pcMouseMove', async (_, x, y) => {
  if (IS_WIN) return runShell(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})"`);
  if (IS_MAC) return runShell(`osascript -e 'tell application "System Events" to set the position of the mouse to {${x}, ${y}}'`);
  return runShell(`xdotool mousemove ${x} ${y}`);
});

ipcMain.handle('pcMouseClick', async (_, x, y, button) => {
  button = button || 'left';
  if (IS_WIN) {
    const flags = button === 'right'
      ? '[HorizonMouse]::mouse_event([HorizonMouse]::R_DOWN,0,0,0,0);[HorizonMouse]::mouse_event([HorizonMouse]::R_UP,0,0,0,0)'
      : '[HorizonMouse]::mouse_event([HorizonMouse]::L_DOWN,0,0,0,0);[HorizonMouse]::mouse_event([HorizonMouse]::L_UP,0,0,0,0)';
    return runShell(`powershell -NoProfile -Command "${PS_MOUSE_CLASS} | Out-Null; [HorizonMouse]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 100; ${flags}"`);
  }
  if (IS_MAC) return runShell(`osascript -e 'tell application "System Events" to ${button === 'right' ? 'secondary click' : 'click'} at {${x}, ${y}}'`);
  return runShell(`xdotool mousemove ${x} ${y} click ${button === 'right' ? '3' : '1'}`);
});

ipcMain.handle('pcMouseDoubleClick', async (_, x, y) => {
  if (IS_WIN) return runShell(`powershell -NoProfile -Command "${PS_MOUSE_CLASS} | Out-Null; [HorizonMouse]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 80; [HorizonMouse]::mouse_event([HorizonMouse]::L_DOWN,0,0,0,0);[HorizonMouse]::mouse_event([HorizonMouse]::L_UP,0,0,0,0);Start-Sleep -Milliseconds 60;[HorizonMouse]::mouse_event([HorizonMouse]::L_DOWN,0,0,0,0);[HorizonMouse]::mouse_event([HorizonMouse]::L_UP,0,0,0,0)"`);
  if (IS_MAC) return runShell(`osascript -e 'tell application "System Events" to double click at {${x}, ${y}}'`);
  return runShell(`xdotool mousemove ${x} ${y} click --repeat 2 1`);
});

ipcMain.handle('pcMouseScroll', async (_, direction, amount) => {
  amount = amount || 3;
  if (IS_WIN) return runShell(`powershell -NoProfile -Command "${PS_MOUSE_CLASS} | Out-Null; [HorizonMouse]::mouse_event([HorizonMouse]::WHEEL,0,0,${direction === 'down' ? -120*amount : 120*amount},0)"`);
  if (IS_MAC) return runShell(`osascript -e 'tell application "System Events" to scroll ${direction === 'down' ? 'down' : 'up'} 3'`);
  return runShell(`xdotool click ${direction === 'down' ? '5' : '4'} --repeat ${amount}`);
});

ipcMain.handle('pcMouseDrag', async (_, x1, y1, x2, y2) => {
  if (IS_WIN) return runShell(`powershell -NoProfile -Command "${PS_MOUSE_CLASS} | Out-Null; [HorizonMouse]::SetCursorPos(${x1},${y1}); Start-Sleep -Milliseconds 50; [HorizonMouse]::mouse_event([HorizonMouse]::L_DOWN,0,0,0,0); Start-Sleep -Milliseconds 50; [HorizonMouse]::SetCursorPos(${x2},${y2}); Start-Sleep -Milliseconds 50; [HorizonMouse]::mouse_event([HorizonMouse]::L_UP,0,0,0,0)"`);
  return runShell(`xdotool mousemove ${x1} ${y1} mousedown 1 mousemove ${x2} ${y2} mouseup 1`);
});

ipcMain.handle('pcGetMousePos', async () => {
  if (IS_WIN) {
    const r = await runShell(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output ($p.X.ToString()+','+$p.Y.ToString())"`);
    return { ok: r.ok, pos: r.out };
  }
  return { ok: true, pos: '0,0' };
});

ipcMain.handle('pcScreenSize', () => {
  const d = screen.getPrimaryDisplay();
  return { width: d.workAreaSize.width, height: d.workAreaSize.height };
});

// ── Image/File analysis via AI Vision ────────────────────────────────────────
ipcMain.handle('analyzeImage', async (_, base64, mimeType, question) => {
  const fetch = require('node-fetch');
  const lang = settingsStore.get('lang') || 'en';
  const q = question || (lang === 'ru' ? 'Что на этом изображении? Опиши подробно.' : 'What is in this image? Describe in detail.');

  // Try Claude first (best vision)
  const claudeKey = keysStore.get('k_claude');
  if (claudeKey) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-5', max_tokens: 2048,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: base64 } },
          { type: 'text', text: q }
        ]}]
      })
    });
    const d = await r.json();
    if (!d.error) return { reply: d.content?.[0]?.text || 'No response', model: 'Claude Vision' };
  }

  // Try GPT-4o
  const openaiKey = keysStore.get('k_openai');
  if (openaiKey) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o', max_tokens: 2048,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${base64}` } },
          { type: 'text', text: q }
        ]}]
      })
    });
    const d = await r.json();
    if (!d.error) return { reply: d.choices?.[0]?.message?.content || 'No response', model: 'GPT-4o Vision' };
  }

  // Try Gemini
  const geminiKey = keysStore.get('k_gemini');
  if (geminiKey) {
    const model = settingsStore.get('geminiModel') || 'gemini-2.5-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64 } },
        { text: q }
      ]}]})
    });
    const d = await r.json();
    if (!d.error && d.candidates?.[0]?.content?.parts?.[0]?.text) return { reply: d.candidates[0].content.parts[0].text, model: 'Gemini Vision' };
  }

  return { error: lang === 'ru'
    ? 'Нужен ключ Claude, OpenAI или Gemini для анализа изображений'
    : 'Need Claude, OpenAI or Gemini key for image analysis' };
});

// ── File reading for ZIP/TXT/code ────────────────────────────────────────────
ipcMain.handle('readUploadedFile', async (_, base64, fileName, mimeType) => {
  try {
    const buf = Buffer.from(base64, 'base64');
    const ext = fileName.split('.').pop().toLowerCase();

    // Text-based files — read directly
    const textExts = ['txt','md','js','ts','jsx','tsx','py','html','css','json','csv','xml','yaml','yml','sh','bat','sql','log','ini','env','gitignore','dockerfile'];
    if (textExts.includes(ext)) {
      const text = buf.toString('utf8').slice(0, 50000); // limit 50k chars
      return { ok: true, type: 'text', content: text, ext };
    }

    // ZIP — list contents and read text files inside
    if (ext === 'zip') {
      const tmp = path.join(os.tmpdir(), `horizon_zip_${Date.now()}`);
      const zipPath = tmp + '.zip';
      fs.writeFileSync(zipPath, buf);
      // Use PowerShell/unzip to list contents
      let listing = '';
      if (IS_WIN) {
        const r = await runShell(`powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('${zipPath}'); $z.Entries | ForEach-Object{$_.FullName}; $z.Dispose()"`);
        listing = r.out;
      } else {
        const r = await runShell(`unzip -l "${zipPath}" 2>/dev/null | awk 'NR>3{print $4}' | head -50`);
        listing = r.out;
      }
      try { fs.unlinkSync(zipPath); } catch(_) {}
      return { ok: true, type: 'zip', content: `ZIP archive contents:
${listing}`, ext };
    }

    // PDF — extract text via shell tools
    if (ext === 'pdf') {
      const tmp = path.join(os.tmpdir(), `horizon_pdf_${Date.now()}.pdf`);
      fs.writeFileSync(tmp, buf);
      let text = '';
      if (IS_WIN) {
        const r = await runShell(`powershell -NoProfile -Command "try{Add-Type -Path 'C:\Program Files\iTextSharp\itextsharp.dll' -ErrorAction Stop}catch{};"`);
        text = 'PDF uploaded. I can see it as an image — use Claude or GPT-4o vision to read it.';
      } else {
        const r = await runShell(`pdftotext "${tmp}" - 2>/dev/null | head -200`);
        text = r.ok ? r.out : 'PDF uploaded (use vision AI to read)';
      }
      try { fs.unlinkSync(tmp); } catch(_) {}
      return { ok: true, type: 'pdf', content: text, ext };
    }

    return { ok: false, error: `Unsupported file type: .${ext}` };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// ── Direct URL opener ─────────────────────────────────────────────────────────
ipcMain.handle('pcOpenUrl', (_, url) => { shell.openExternal(url); return { ok: true }; });

// ── Smart Web Search / YouTube opener ────────────────────────────────────────
ipcMain.handle('pcSearch', async (_, query, engine) => {
  const urls = {
    google:   `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    youtube:  `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    yandex:   `https://yandex.ru/search/?text=${encodeURIComponent(query)}`,
    bing:     `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    github:   `https://github.com/search?q=${encodeURIComponent(query)}`,
    reddit:   `https://www.reddit.com/search/?q=${encodeURIComponent(query)}`,
  };
  const url = urls[engine || 'google'];
  shell.openExternal(url);
  return { ok: true, url };
});

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────
ipcMain.handle('ttsElevenLabs', async (_, text, voiceId) => {
  const fetch = require('node-fetch');
  const key = keysStore.get('k_elevenlabs');
  if (!key) return { error: 'ElevenLabs key not set → Settings' };
  const vid = voiceId || settingsStore.get('elevenLabsVoice') || 'pNInz6obpgDQGcFmaJgB'; // Adam
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
      body: JSON.stringify({ text: text.slice(0, 500), model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); return { error: e?.detail?.message || 'ElevenLabs TTS failed' }; }
    const buf = await r.buffer();
    return { ok: true, base64: buf.toString('base64'), mimeType: 'audio/mpeg' };
  } catch(e) { return { error: e.message }; }
});

// ── OpenAI TTS ────────────────────────────────────────────────────────────────
ipcMain.handle('ttsOpenAI', async (_, text, voice) => {
  const fetch = require('node-fetch');
  const key = keysStore.get('k_openai');
  if (!key) return { error: 'OpenAI key not set → Settings' };
  try {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'tts-1', input: text.slice(0, 4096), voice: voice || 'onyx' })
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); return { error: e?.error?.message || 'OpenAI TTS failed' }; }
    const buf = await r.buffer();
    return { ok: true, base64: buf.toString('base64'), mimeType: 'audio/mpeg' };
  } catch(e) { return { error: e.message }; }
});


// ── AI Providers ──────────────────────────────────────────────────────────────
ipcMain.handle('ai', async (_, messages, provider, system, opts) => {
  const fetch    = require('node-fetch');
  const userName = settingsStore.get('userName') || 'user';
  const lang     = settingsStore.get('lang') || 'en';

  // IDENTITY: Horizon always knows who it is
  const identity = lang === 'ru'
    ? `Ты — Хорайзон (Horizon AI), продвинутый персональный AI-агент для ПК. Тебя создал Эрнест Костевич (Ernest Kostevich). Ты НЕ являешься Claude, ChatGPT, Gemini или любым другим AI — ты Хорайзон. Пользователь: ${userName}. Время: ${new Date().toLocaleString()}. Ты умный, дружелюбный, немного как Джарвис из Marvel. Можешь управлять ПК, видеть экран. Используй Markdown.`
    : `You are Horizon AI — an advanced personal desktop agent. You were created by Ernest Kostevich. You are NOT Claude, ChatGPT, Gemini, or any other AI — you are Horizon. User: ${userName}. Time: ${new Date().toLocaleString()}. You are intelligent, friendly, somewhat like JARVIS from Marvel. You can control the PC, see the screen. Use Markdown.`;

  const sysMsg = system
    ? (system.includes('Ты') || system.includes('You are') ? system : `${identity}\n\n${system}`)
    : identity;

  try {
    switch (provider) {
      case 'claude': {
        const k = keysStore.get('k_claude');
        if (!k) return { error: lang==='ru'?'Ключ Claude не задан → Настройки':'Claude key not set → Settings' };
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST', headers:{'Content-Type':'application/json','x-api-key':k,'anthropic-version':'2023-06-01'},
          body:JSON.stringify({ model:opts?.model||'claude-opus-4-5', max_tokens:4096, system:sysMsg, messages })
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        return { reply: d.content?.[0]?.text || 'No response', model: 'claude' };
      }
      case 'openai': {
        const k = keysStore.get('k_openai');
        if (!k) return { error: lang==='ru'?'Ключ OpenAI не задан':'OpenAI key not set' };
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify({ model:opts?.model||'gpt-4o', max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: 'gpt-4o' };
      }
      case 'gemini': {
        const k = keysStore.get('k_gemini');
        if (!k) return { error: lang==='ru'?'Ключ Gemini не задан. Бесплатно: aistudio.google.com':'Gemini key not set. Free at aistudio.google.com' };
        const model = opts?.model || 'gemini-2.5-flash';

        // Fix alternating roles — Gemini requires user/model/user/model sequence
        // Remove consecutive duplicates and ensure starts with 'user'
        const rawContents = messages.map(m => ({ role: m.role==='assistant'?'model':'user', parts:[{text: m.content||'...'}] }));
        const contents = [];
        for (const msg of rawContents) {
          if (contents.length === 0) {
            if (msg.role === 'user') contents.push(msg);
            // skip leading assistant messages
          } else if (contents[contents.length-1].role !== msg.role) {
            contents.push(msg);
          } else {
            // Merge consecutive same-role messages
            contents[contents.length-1].parts[0].text += '\n' + msg.parts[0].text;
          }
        }
        // Gemini must end with user message
        if (!contents.length) contents.push({ role:'user', parts:[{text: messages[messages.length-1]?.content || '...'}] });
        if (contents[contents.length-1].role !== 'user') contents.push({ role:'user', parts:[{text:'...'}] });

        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${k}`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ system_instruction:{parts:[{text:sysMsg}]}, contents, generationConfig:{maxOutputTokens:4096,temperature:0.7} })
        });
        const d = await r.json();
        if (d.error) return { error: d.error.message };
        const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          // Blocked or empty response
          const reason = d.candidates?.[0]?.finishReason || d.promptFeedback?.blockReason || 'empty response';
          return { error: `Gemini: ${reason}. Check your API key at aistudio.google.com` };
        }
        return { reply: text, model };
      }
      case 'groq': {
        const k = keysStore.get('k_groq');
        if (!k) return { error: lang==='ru'?'Ключ Groq не задан. Бесплатно: groq.com':'Groq key not set. Free at groq.com' };
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify({ model:opts?.model||'llama-3.3-70b-versatile', max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: 'groq/llama3' };
      }
      case 'grok': {
        const k = keysStore.get('k_grok');
        if (!k) return { error: lang==='ru'?'Ключ Grok (xAI) не задан → console.x.ai':'Grok (xAI) key not set → console.x.ai' };
        const r = await fetch('https://api.x.ai/v1/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify({ model:opts?.model||'grok-3-latest', max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: 'grok-3' };
      }
      case 'deepseek': {
        const k = keysStore.get('k_deepseek');
        if (!k) return { error: lang==='ru'?'Ключ DeepSeek не задан → platform.deepseek.com':'DeepSeek key not set → platform.deepseek.com' };
        const r = await fetch('https://api.deepseek.com/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify({ model:'deepseek-chat', max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: 'deepseek-v3' };
      }
      case 'mistral': {
        const k = keysStore.get('k_mistral');
        if (!k) return { error: lang==='ru'?'Ключ Mistral не задан → console.mistral.ai':'Mistral key not set → console.mistral.ai' };
        const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify({ model:'mistral-large-latest', max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: 'mistral-large' };
      }
      case 'qwen': {
        const k = keysStore.get('k_qwen');
        if (!k) return { error: lang==='ru'?'Ключ Qwen не задан → dashscope.aliyuncs.com':'Qwen key not set → dashscope.aliyuncs.com' };
        const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify({ model:'qwen-plus', max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: 'qwen-plus' };
      }
      default: return { error: `Unknown provider: ${provider}` };
    }
  } catch(e) { return { error: `Network error: ${e.message}` }; }
});

// ── Web Search ────────────────────────────────────────────────────────────────
ipcMain.handle('search', async (_, query) => {
  const fetch = require('node-fetch');
  const key   = keysStore.get('k_tavily');
  if (!key) return { error: 'Tavily key not set', results: [] };
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ api_key:key, query, max_results:5, include_answer:true })
    });
    const d = await r.json();
    return { answer: d.answer, results: d.results?.slice(0, 5) || [] };
  } catch(e) { return { error: e.message, results: [] }; }
});


// ═══════════════════════════════════════════════════════════════════════════════
// HORIZON V12 — FULL AGENT CAPABILITIES
// ═══════════════════════════════════════════════════════════════════════════════

let agentTools = null;
let agentMemory = null;
let agentLoop = null;
let mcpManager = null;
let computerUse = null;
let browserManager = null;
let pluginManager = null;
let googleAuth = null;
let personas = null;
let workflowEngine = null;
let screenRecorder = null;

function loadAgentModules() {
  if (!agentTools) {
    try {
      agentTools = require('./agent');
      const { AgentMemory, setMemoryInstance } = agentTools;
      const memPath = path.join(app.getPath('userData'), 'horizon_memory.db');
      agentMemory = new AgentMemory(memPath);
      agentMemory.init();
      setMemoryInstance(agentMemory);
      console.log('✓ Agent tools loaded');
    } catch(e) {
      console.error('Agent tools failed:', e.message);
    }
  }
  if (!agentLoop) {
    try {
      agentLoop = require('./agentLoop');
      console.log('✓ Agent loop loaded');
    } catch(e) {
      console.error('Agent loop failed:', e.message);
    }
  }
  if (!mcpManager) {
    try {
      const { MCPManager } = require('./mcpServers');
      mcpManager = new MCPManager();
      console.log('✓ MCP servers loaded');
    } catch(e) {
      console.error('MCP servers failed:', e.message);
    }
  }
  if (!computerUse) {
    try {
      computerUse = require('./computerUse');
      console.log('✓ Computer Use loaded');
    } catch(e) {
      console.error('Computer Use failed:', e.message);
    }
  }
  if (!browserManager) {
    try {
      const { BrowserManager } = require('./browserAutomation');
      browserManager = new BrowserManager();
      console.log('✓ Browser automation loaded');
    } catch(e) {
      console.error('Browser automation failed:', e.message);
    }
  }
  if (!pluginManager) {
    try {
      const { PluginManager } = require('./pluginManager');
      pluginManager = new PluginManager(path.join(app.getPath('userData'), 'plugins'));
      pluginManager.loadAll();
      // Auto-install bundled Spotify Control demo on first run
      try { pluginManager.installBundledSpotify(); } catch (_) {}
      console.log('✓ Plugin manager loaded');
    } catch(e) {
      console.error('Plugin manager failed:', e.message);
    }
  }
  if (!googleAuth) {
    try {
      const { GoogleAuth } = require('./googleAuth');
      googleAuth = new GoogleAuth(settingsStore);
      console.log('✓ Google Auth loaded');
    } catch(e) {
      console.error('Google Auth failed:', e.message);
    }
  }
  if (!personas) {
    try {
      personas = require('./personas');
      console.log('✓ Personas loaded');
    } catch(e) {
      console.error('Personas failed:', e.message);
    }
  }
  if (!workflowEngine) {
    try {
      const { WorkflowEngine } = require('./workflowEngine');
      workflowEngine = new WorkflowEngine(settingsStore, pluginManager);
      workflowEngine.startAll();
      console.log('✓ Workflow Engine loaded');
    } catch(e) {
      console.error('Workflow Engine failed:', e.message);
    }
  }
  if (!screenRecorder) {
    try {
      const { ScreenRecorder } = require('./screenRecorder');
      screenRecorder = new ScreenRecorder(keysStore, settingsStore);
      console.log('✓ Screen Recorder loaded');
    } catch(e) {
      console.error('Screen Recorder failed:', e.message);
    }
  }
}

// ── AGENT LOOP: autonomous multi-step task execution ─────────────────────────
ipcMain.handle('agentRun', async (event, userMessage, opts = {}) => {
  loadAgentModules();

  if (!agentLoop) {
    return { ok: false, error: 'Agent module not loaded', steps: [] };
  }

  const provider = opts.provider || settingsStore.get('provider') || 'gemini';
  const lang     = settingsStore.get('lang') || 'en';
  const userName = settingsStore.get('userName') || 'User';

  // Get system info for agent context
  let sysInfo = null;
  try { sysInfo = await agentTools.getDetailedSysInfo(); } catch(e) {}

  // AI function wrapper
  const aiFn = async (messages, systemPrompt) => {
    const fetch = require('node-fetch');
    const k = keysStore.get(`k_${provider}`);
    if (!k) return { error: `${provider} key not set → Settings` };

    try {
      if (provider === 'gemini') {
        const model = settingsStore.get('geminiModel') || 'gemini-2.5-flash';
        const contents = messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content || '...' }]
        }));
        const fixed = [];
        for (const m of contents) {
          if (!fixed.length && m.role !== 'user') continue;
          if (fixed.length && fixed[fixed.length-1].role === m.role)
            fixed[fixed.length-1].parts[0].text += '\n' + m.parts[0].text;
          else fixed.push(m);
        }
        if (!fixed.length) fixed.push({ role:'user', parts:[{text: userMessage}] });
        if (fixed[fixed.length-1].role !== 'user') fixed.push({ role:'user', parts:[{text:'continue'}] });
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${k}`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ system_instruction:{parts:[{text:systemPrompt}]}, contents:fixed, generationConfig:{maxOutputTokens:4096} })
        });
        const d = await r.json();
        if (d.error) return { error: d.error.message };
        return { reply: d.candidates?.[0]?.content?.parts?.[0]?.text || 'No response' };
      }

      if (provider === 'claude') {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':k,'anthropic-version':'2023-06-01'},
          body:JSON.stringify({ model:'claude-opus-4-5', max_tokens:4096, system:systemPrompt, messages })
        });
        const d = await r.json();
        if (d.error) return { error: d.error.message };
        if (!d.content || !d.content[0]) return { error: 'Empty response from Claude' };
        return { reply: d.content[0].text };
      }

      // OpenAI-compatible (openai, groq, grok, deepseek, mistral, qwen, perplexity, cohere)
      const endpoints = {
        openai:     { url:'https://api.openai.com/v1/chat/completions',                    model:'gpt-4o' },
        groq:       { url:'https://api.groq.com/openai/v1/chat/completions',               model:'llama-3.3-70b-versatile' },
        grok:       { url:'https://api.x.ai/v1/chat/completions',                          model:'grok-3-latest' },
        deepseek:   { url:'https://api.deepseek.com/chat/completions',                     model:'deepseek-chat' },
        mistral:    { url:'https://api.mistral.ai/v1/chat/completions',                    model:'mistral-large-latest' },
        qwen:       { url:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model:'qwen-plus' },
        perplexity: { url:'https://api.perplexity.ai/chat/completions',                    model:'sonar-pro' },
        cohere:     { url:'https://api.cohere.com/v2/chat',                                model:'command-r-plus' },
      };
      const ep = endpoints[provider] || endpoints.openai;
      const r = await fetch(ep.url, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
        body:JSON.stringify({ model:ep.model, max_tokens:4096, messages:[{role:'system',content:systemPrompt},...messages] })
      });
      const d = await r.json();
      if (d.error) return { error: d.error.message };
      if (!d.choices || !d.choices[0]) return { error: `Empty response from ${provider}` };
      return { reply: d.choices[0].message.content };

    } catch(e) { return { error: e.message }; }
  };

  // Screen capture function for agent
  const screenCapFn = async () => {
    try {
      const src = await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1280,height:720}});
      if (!src.length) return null;
      return { ok:true, base64: src[0].thumbnail.toPNG().toString('base64') };
    } catch { return null; }
  };

  // Send step updates to renderer via the event sender
  const onStep = (step) => {
    try { event.sender.send('agentStep', step); } catch {}
  };

  const result = await agentLoop.runAgentLoop(userMessage, {
    aiFn,
    sysInfo,
    lang,
    userName,
    history: opts.history || [],
    maxSteps: opts.maxSteps || 8,
    onStep,
    analyzeScreenFn: screenCapFn
  });

  // Save to memory
  if (agentMemory) {
    agentMemory.remember(`Task: ${userMessage}`, 'agent_task', 7);
    if (result.ok && result.answer) {
      agentMemory.remember(`Result: ${result.answer.slice(0, 200)}`, 'agent_result', 6);
    }
  }

  return result;
});

// ── DIRECT TOOL CALLS (from chat toolbar/quick actions) ──────────────────────
ipcMain.handle('agentTool', async (_, toolName, args) => {
  loadAgentModules();
  if (!agentTools) return { ok: false, err: 'Agent not loaded' };
  return agentTools.dispatchTool(toolName, args);
});

// ── MEMORY ────────────────────────────────────────────────────────────────────
ipcMain.handle('memRemember', (_, content, category, importance) => {
  loadAgentModules();
  if (!agentMemory) return false;
  agentMemory.remember(content, category || 'general', importance || 5);
  return true;
});

ipcMain.handle('memRecall', (_, query, limit) => {
  loadAgentModules();
  if (!agentMemory) return [];
  return agentMemory.recall(query, limit || 10);
});

ipcMain.handle('memSetFact', (_, key, value) => {
  loadAgentModules();
  if (!agentMemory) return false;
  agentMemory.setFact(key, value);
  return true;
});

ipcMain.handle('memGetFact', (_, key) => {
  loadAgentModules();
  if (!agentMemory) return null;
  return agentMemory.getFact(key);
});

ipcMain.handle('memGetFacts', () => {
  loadAgentModules();
  if (!agentMemory) return {};
  return agentMemory.getAllFacts();
});

ipcMain.handle('memGetRecent', (_, limit) => {
  loadAgentModules();
  if (!agentMemory) return [];
  return agentMemory.getRecent(limit || 20);
});

// ── NUTRITION TRACKING (from jarvis) ─────────────────────────────────────────
ipcMain.handle('nutritionLog', (_, description, calories, protein, carbs, fat) => {
  loadAgentModules();
  if (!agentMemory) return false;
  return agentMemory.logMeal(description, calories, protein, carbs, fat);
});

ipcMain.handle('nutritionGet', (_, days) => {
  loadAgentModules();
  if (!agentMemory) return { meals: [], total: {} };
  return agentMemory.getMeals(days || 7);
});

ipcMain.handle('nutritionToday', () => {
  loadAgentModules();
  if (!agentMemory) return { meals: [], total: { calories: 0, protein: 0, carbs: 0, fat: 0 } };
  return agentMemory.getTodayNutrition();
});

// ── CONVERSATION MEMORY ─────────────────────────────────────────────────────
ipcMain.handle('memSaveConversation', (_, userMessage, assistantReply) => {
  loadAgentModules();
  if (!agentMemory) return false;
  agentMemory.saveConversation(userMessage, assistantReply);
  return true;
});

ipcMain.handle('memSearchConversations', (_, query, limit) => {
  loadAgentModules();
  if (!agentMemory) return [];
  return agentMemory.searchConversations(query, limit || 10);
});

// ── CODE EXECUTION ────────────────────────────────────────────────────────────
ipcMain.handle('executeCode', async (_, code, language) => {
  loadAgentModules();
  if (!agentTools) return { ok: false, err: 'Agent not loaded' };
  return agentTools.executeCode(code, language || 'python');
});

// ── DETAILED SYSTEM INFO ──────────────────────────────────────────────────────
ipcMain.handle('getDetailedSysInfo', async () => {
  loadAgentModules();
  if (!agentTools) return {};
  return agentTools.getDetailedSysInfo();
});

ipcMain.handle('getRunningApps', async () => {
  loadAgentModules();
  if (!agentTools) return { ok: false, out: '' };
  const out = await agentTools.getRunningApps();
  return { ok: true, out };
});

// ── SHOW WINDOW (for wake word) ───────────────────────────────────────────────
ipcMain.handle('showWindow', () => { win?.show(); win?.focus(); return true; });

// ── MCP: LOCATION & WEATHER ──────────────────────────────────────────────────
ipcMain.handle('mcpGetLocation', async () => {
  loadAgentModules();
  if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
  return mcpManager.getLocation();
});

ipcMain.handle('mcpGetWeather', async () => {
  loadAgentModules();
  if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
  return mcpManager.getWeather();
});

ipcMain.handle('mcpGetTimezone', async () => {
  loadAgentModules();
  if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
  return mcpManager.getTimezone();
});

// ── MCP: WEB SEARCH ──────────────────────────────────────────────────────────
ipcMain.handle('mcpWebSearch', async (_, query) => {
  loadAgentModules();
  if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
  return mcpManager.search(query);
});

ipcMain.handle('mcpWikipedia', async (_, query, limit) => {
  loadAgentModules();
  if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
  return mcpManager.searchWikipedia(query, limit);
});

ipcMain.handle('mcpWikipediaSummary', async (_, title) => {
  loadAgentModules();
  if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
  return mcpManager.getWikipediaSummary(title);
});

// ── MCP: GMAIL ───────────────────────────────────────────────────────────────
ipcMain.handle('mcpGmailSetToken', (_, token) => {
  loadAgentModules();
  if (!mcpManager) return false;
  mcpManager.setGmailToken(token);
  return true;
});

ipcMain.handle('mcpGmailList', async (_, query, max) => {
  loadAgentModules();
  if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
  return mcpManager.listEmails(query, max);
});

ipcMain.handle('mcpGmailRead', async (_, id) => {
  loadAgentModules();
  if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
  return mcpManager.readEmail(id);
});

ipcMain.handle('mcpGmailSend', async (_, to, subject, body, cc, bcc) => {
  loadAgentModules();
  if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
  return mcpManager.sendEmail(to, subject, body, cc, bcc);
});

// ── MCP: CALENDAR ────────────────────────────────────────────────────────────
ipcMain.handle('mcpCalendarSetToken', (_, token) => {
  loadAgentModules();
  if (!mcpManager) return false;
  mcpManager.setCalendarToken(token);
  return true;
});

ipcMain.handle('mcpCalendarList', async (_, cal, max) => {
  loadAgentModules();
  if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
  return mcpManager.listEvents(cal, max);
});

ipcMain.handle('mcpCalendarToday', async () => {
  loadAgentModules();
  if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
  return mcpManager.getTodayEvents();
});

ipcMain.handle('mcpCalendarCreate', async (_, cal, summary, start, end, desc, loc, attendees) => {
  loadAgentModules();
  if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
  return mcpManager.createEvent(cal, summary, start, end, desc, loc, attendees);
});

ipcMain.handle('mcpCalendarQuickAdd', async (_, text) => {
  loadAgentModules();
  if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
  return mcpManager.quickAddEvent('primary', text);
});

// ── COMPUTER USE: Smart click by description ─────────────────────────────────
ipcMain.handle('smartClick', async (_, targetDescription) => {
  loadAgentModules();
  if (!computerUse || !agentTools) return { ok: false, error: 'Computer Use not loaded' };
  
  const captureScreenFn = async () => {
    try {
      const src = await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1920,height:1080}});
      if (!src.length) return null;
      return { ok: true, base64: src[0].thumbnail.toPNG().toString('base64') };
    } catch { return null; }
  };
  
  const provider = settingsStore.get('provider') || 'gemini';
  const k = keysStore.get(`k_${provider}`);
  if (!k) return { ok: false, error: `${provider} key not set` };
  
  const aiVisionFn = async (base64, prompt) => {
    const fetch = require('node-fetch');
    // Use Gemini for vision since it supports images well
    const geminiKey = keysStore.get('k_gemini') || k;
    const model = 'gemini-2.5-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/png', data: base64 } }
          ]
        }]
      })
    });
    const d = await r.json();
    if (d.error) return { error: d.error.message };
    return { text: d.candidates?.[0]?.content?.parts?.[0]?.text || '' };
  };
  
  return computerUse.smartClick(
    targetDescription,
    captureScreenFn,
    aiVisionFn,
    agentTools.mouseClick
  );
});

// ── COMPUTER USE: Find UI Elements ───────────────────────────────────────────
ipcMain.handle('findUIElements', async () => {
  loadAgentModules();
  if (!computerUse) return { ok: false, error: 'Computer Use not loaded' };
  
  try {
    const src = await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1920,height:1080}});
    if (!src.length) return { ok: false, error: 'No screen' };
    const base64 = src[0].thumbnail.toPNG().toString('base64');
    
    const geminiKey = keysStore.get('k_gemini');
    if (!geminiKey) return { ok: false, error: 'Gemini key needed for vision' };
    
    const fetch = require('node-fetch');
    const aiVisionFn = async (b64, prompt) => {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          contents: [{role:'user', parts:[{text:prompt},{inline_data:{mime_type:'image/png',data:b64}}]}]
        })
      });
      const d = await r.json();
      return { text: d.candidates?.[0]?.content?.parts?.[0]?.text || '' };
    };
    
    return computerUse.findUIElements(base64, aiVisionFn);
  } catch(e) { return { ok: false, error: e.message }; }
});

// ── BROWSER AUTOMATION ───────────────────────────────────────────────────────
ipcMain.handle('browserOpenUrl', async (_, url) => {
  loadAgentModules();
  if (!browserManager) return { ok: false, error: 'Browser not loaded' };
  return browserManager.openUrl(url);
});

ipcMain.handle('browserSearch', async (_, query, engine) => {
  loadAgentModules();
  if (!browserManager) return { ok: false, error: 'Browser not loaded' };
  return browserManager.search(query, engine);
});

ipcMain.handle('browserOpenSite', async (_, name) => {
  loadAgentModules();
  if (!browserManager) return { ok: false, error: 'Browser not loaded' };
  return browserManager.openSite(name);
});

// ── PERSONAS ─────────────────────────────────────────────────────────────────
ipcMain.handle('getPersonas', () => {
  loadAgentModules();
  if (!personas) return [];
  return personas.getAllPersonas();
});

ipcMain.handle('getPersona', (_, id) => {
  loadAgentModules();
  if (!personas) return null;
  return personas.getPersona(id);
});

ipcMain.handle('getPersonaPrompt', (_, id, lang) => {
  loadAgentModules();
  if (!personas) return '';
  return personas.getPersonaPrompt(id, lang);
});

ipcMain.handle('getWakeResponse', (_, id, lang) => {
  loadAgentModules();
  if (!personas) return 'Ready.';
  return personas.getWakeResponse(id, lang);
});

// ── PLUGIN MANAGER v2 ────────────────────────────────────────────────────────
ipcMain.handle('pluginList', () => {
  loadAgentModules();
  if (!pluginManager) return [];
  return pluginManager.list();
});

ipcMain.handle('pluginInstall', (_, pluginJson) => {
  loadAgentModules();
  if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
  return pluginManager.install(pluginJson);
});

ipcMain.handle('pluginUninstall', (_, id) => {
  loadAgentModules();
  if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
  return pluginManager.uninstall(id);
});

ipcMain.handle('pluginInstallTemplate', (_, templateId) => {
  loadAgentModules();
  if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
  const { PluginManager } = require('./pluginManager');
  const templates = PluginManager.getBuiltinTemplates();
  const tpl = templates.find(t => t.id === templateId);
  if (!tpl) return { ok: false, error: 'Template not found' };
  return pluginManager.install(tpl);
});

ipcMain.handle('pluginToggle', (_, id) => {
  loadAgentModules();
  if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
  return pluginManager.toggleEnable(id);
});

ipcMain.handle('pluginExecTool', async (_, pluginId, toolName, args) => {
  loadAgentModules();
  if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
  return pluginManager.executeTool(pluginId, toolName, args);
});

ipcMain.handle('pluginSetConfig', (_, pluginId, config) => {
  loadAgentModules();
  if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
  return pluginManager.setConfig(pluginId, config);
});

ipcMain.handle('pluginShareUrl', (_, id) => {
  loadAgentModules();
  if (!pluginManager) return null;
  return pluginManager.generateShareUrl(id);
});

ipcMain.handle('pluginInstallFromUrl', (_, url) => {
  loadAgentModules();
  if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
  return pluginManager.installFromShareUrl(url);
});

// Legacy — fake templates removed; real plugins come from the marketplace backend.
ipcMain.handle('pluginTemplates', () => []);

// ── WORKFLOW ENGINE ───────────────────────────────────────────────────────────
ipcMain.handle('workflowList', () => {
  loadAgentModules();
  if (!workflowEngine) return [];
  return workflowEngine.loadAll();
});

ipcMain.handle('workflowCreate', (_, name, trigger, steps, desc) => {
  loadAgentModules();
  if (!workflowEngine) return { ok: false, error: 'Workflow engine not loaded' };
  return workflowEngine.create(name, trigger, steps, desc);
});

ipcMain.handle('workflowUpdate', (_, id, updates) => {
  loadAgentModules();
  if (!workflowEngine) return { ok: false, error: 'Workflow engine not loaded' };
  return workflowEngine.update(id, updates);
});

ipcMain.handle('workflowDelete', (_, id) => {
  loadAgentModules();
  if (!workflowEngine) return { ok: false, error: 'Workflow engine not loaded' };
  return workflowEngine.delete(id);
});

ipcMain.handle('workflowRun', async (event, id) => {
  loadAgentModules();
  if (!workflowEngine) return { ok: false, error: 'Workflow engine not loaded' };
  const onStep = (step) => { try { event.sender.send('workflowStep', step); } catch {} };
  return workflowEngine.run(id, onStep);
});

ipcMain.handle('workflowExamples', () => {
  const { WorkflowEngine } = require('./workflowEngine');
  return WorkflowEngine.getExampleWorkflows();
});

// ── SCREEN RECORDER + AI NARRATOR ────────────────────────────────────────────
ipcMain.handle('recorderGetSources', async () => {
  loadAgentModules();
  if (!screenRecorder) return { ok: false, error: 'Recorder not loaded' };
  return screenRecorder.getSources();
});

ipcMain.handle('recorderStart', (_, outputPath) => {
  loadAgentModules();
  if (!screenRecorder) return { ok: false, error: 'Recorder not loaded' };
  return screenRecorder.startRecording(outputPath);
});

ipcMain.handle('recorderStop', () => {
  loadAgentModules();
  if (!screenRecorder) return { ok: false, error: 'Recorder not loaded' };
  return screenRecorder.stopRecording();
});

ipcMain.handle('recorderSave', (_, b64, mime) => {
  loadAgentModules();
  if (!screenRecorder) return { ok: false, error: 'Recorder not loaded' };
  return screenRecorder.saveRecording(b64, mime);
});

ipcMain.handle('recorderStatus', () => {
  loadAgentModules();
  if (!screenRecorder) return { isRecording: false };
  return screenRecorder.getStatus();
});

ipcMain.handle('recorderNarrate', async (_, b64, mime, ctx) => {
  loadAgentModules();
  if (!screenRecorder) return { ok: false, error: 'Recorder not loaded' };
  return screenRecorder.generateNarration(b64, mime, ctx);
});

// ── MARKETPLACE ───────────────────────────────────────────────────────────────
// Legacy template-based marketplace is gone. The real one is `marketRemoteList`
// (FastAPI backend) — see further down. These stubs remain so old UI code that
// still calls them gets an empty list instead of 4 fake "plugins".
ipcMain.handle('marketplaceList', () => []);
ipcMain.handle('marketplaceSearch', () => []);

ipcMain.handle('marketplacePublish', async (_, data) => {
  // In production: POST to Horizon Marketplace API
  // For now: generate a share URL from local plugin
  loadAgentModules();
  if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
  const url = pluginManager.generateShareUrl(data.pluginId);
  if (!url) return { ok: false, error: 'Plugin not found' };
  return { ok: true, shareUrl: url, message: 'Plugin published! Share this URL with others.' };
});

// ── GOOGLE OAUTH ─────────────────────────────────────────────────────────────
ipcMain.handle('googleAuth', async (_, clientId, clientSecret) => {
  loadAgentModules();
  if (!googleAuth) return { ok: false, error: 'Google Auth not loaded' };
  const result = await googleAuth.authenticate(clientId, clientSecret);
  // Also connect to Gmail/Calendar MCP
  if (result.ok && mcpManager) {
    mcpManager.setGmailToken(result.access_token);
    mcpManager.setCalendarToken(result.access_token);
  }
  return result;
});

ipcMain.handle('googleAuthStatus', () => {
  loadAgentModules();
  if (!googleAuth) return { ok: false };
  return { ok: true, authenticated: googleAuth.isAuthenticated() };
});

ipcMain.handle('googleLogout', () => {
  loadAgentModules();
  if (!googleAuth) return { ok: false };
  if (mcpManager) {
    mcpManager.setGmailToken(null);
    mcpManager.setCalendarToken(null);
  }
  return googleAuth.logout();
});

ipcMain.handle('googleGetToken', async () => {
  loadAgentModules();
  if (!googleAuth) return { ok: false, error: 'Google Auth not loaded' };
  const result = await googleAuth.getAccessToken();
  // Auto-connect MCP when getting fresh token
  if (result.ok && mcpManager) {
    mcpManager.setGmailToken(result.token);
    mcpManager.setCalendarToken(result.token);
  }
  return result;
});

// ── Startup ───────────────────────────────────────────────────────────────────

// ── MARKETPLACE (remote) — live catalog from Horizon Marketplace backend ─────
const { MarketplaceClient } = require('./marketplaceApi');
const marketClient = new MarketplaceClient(settingsStore);

// ── LICENSE (trial + Pro) — gates app access behind subscription ─────────────
const { LicenseManager } = require('./licenseManager');
const licenseManager = new LicenseManager({
  settingsStore,
  marketplaceClient: marketClient,
  logger: (...a) => console.log(...a),
});
// Activate the Pro guard defined at the top of this file. Until this line the
// guard is a no-op (handlers registered during startup run unchecked); after
// it, every call to a Pro channel re-evaluates the license.
_licenseManagerRef = licenseManager;
// The guard also needs the window reference so it can redirect to progate when
// a user clicks a Pro feature after expiry. Kept in sync via the setter below.
Object.defineProperty(global, '_horizonProGuardWindow', {
  configurable: true,
  get() { return _proGuardWindowRef; },
  set(v) { _proGuardWindowRef = v; },
});

// Broadcast license state changes to the renderer so the UI can update banners.
licenseManager.onChange((state) => {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('license-state', state); } catch (_) {}
  }
  // If access revoked while app is running (expiry, server says inactive),
  // redirect to the Pro gate instead of letting the user keep working.
  if (!state.allowed && win && !win.isDestroyed()) {
    try {
      const cur = win.webContents.getURL();
      if (!cur.includes('/progate.html')) {
        win.loadURL(`http://127.0.0.1:${port}/progate.html`);
      }
    } catch (_) {}
  }
});

ipcMain.handle('licenseState',   () => licenseManager.evaluate());
ipcMain.handle('licenseRefresh', () => licenseManager.refresh());
ipcMain.handle('licenseCreateCryptoPayment', async (_, plan) => {
  try {
    if (!marketClient.token) return { ok: false, error: 'not-logged-in' };
    const invoice = await marketClient.createCryptoPayment(plan);
    return { ok: true, invoice };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('licensePollInvoice', async (_, invoiceId) => {
  try {
    const r = await marketClient.pollInvoice(invoiceId);
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('licenseOpenUpgradePage', () => {
  const url = `${marketClient.webBase}/upgrade?src=desktop`;
  shell.openExternal(url);
  return { ok: true, url };
});
ipcMain.handle('licenseOpenContactLink', (_, channel) => {
  const links = {
    telegram_primary:   'https://t.me/Ernest_Kostevich',
    telegram_secondary: 'https://t.me/ernest0kostevich',
    email_primary:      'mailto:ernest2011kostevich@gmail.com',
    email_secondary:    'mailto:ernestkostevich@gmail.com',
  };
  const url = links[channel];
  if (url) shell.openExternal(url);
  return { ok: !!url, url };
});
// Wipe the license cache when the user logs out of the marketplace account,
// so the next login forces a fresh server check.
const _origLogout = marketClient.logout.bind(marketClient);
marketClient.logout = function patchedLogout() {
  _origLogout();
  licenseManager.clearCache();
};

ipcMain.handle('marketRemoteList', async (_, filters = {}) => {
  try { return { ok: true, items: await marketClient.list(filters) }; }
  catch (e) { return { ok: false, error: e.message, items: [] }; }
});

ipcMain.handle('marketRemoteInstall', async (_, pluginId) => {
  try {
    loadAgentModules();
    if (!pluginManager) return { ok: false, error: 'Plugin manager not ready' };
    // Tell the server we installed (for download count + gating of paid plugins)
    try { await marketClient.install(pluginId); } catch (_) { /* ignore — anonymous install OK for free plugins */ }
    const bundle = await marketClient.bundle(pluginId);
    const m = bundle.manifest;
    const r = pluginManager.install({
      id: m.id, name: m.name, version: m.version,
      description: m.description, author: m.author,
      category: m.category, tier: m.tier, icon: m.icon,
      tools: m.tools, settings: m.settings || [],
      permissions: m.permissions || [],
      handler: bundle.handler || '',
    });
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('marketGetUrl', () => marketClient.base);
ipcMain.handle('marketGetWebUrl', () => marketClient.webBase);
ipcMain.handle('marketSetUrl', (_, url) => { settingsStore.set('marketplaceUrl', url); return true; });
ipcMain.handle('marketSetWebUrl', (_, url) => { settingsStore.set('marketplaceWebUrl', url); return true; });
ipcMain.handle('marketLogin', async (_, email, password) => {
  try { const d = await marketClient.login(email, password); return { ok: true, user: d.user }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('marketSignup', async (_, email, password, display_name) => {
  try { const d = await marketClient.signup(email, password, display_name); return { ok: true, user: d.user }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('marketLogout', () => { marketClient.logout(); return true; });
ipcMain.handle('marketMe', async () => {
  if (!marketClient.token) return { ok: false };
  try { const d = await marketClient.me(); return { ok: true, user: d }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Register horizon:// protocol so the marketplace website can install
// plugins with one click (horizon://plugin/install?data=<base64>).
if (!app.isDefaultProtocolClient('horizon')) {
  try { app.setAsDefaultProtocolClient('horizon'); } catch (_) {}
}

function handleHorizonUrl(url) {
  try {
    if (!url || !url.startsWith('horizon://plugin/install')) return;
    loadAgentModules();
    if (!pluginManager) return;
    const r = pluginManager.installFromShareUrl(url);
    if (r && r.ok) {
      new Notification({ title: '◈ Horizon', body: `Plugin installed: ${r.name || r.id}` }).show();
      if (win) { win.show(); win.webContents.send('plugin-installed', r); }
    } else {
      new Notification({ title: '◈ Horizon', body: `Install failed: ${r?.error || 'unknown'}` }).show();
    }
  } catch (e) { console.error('horizon:// handler error:', e.message); }
}

// Single-instance lock so the protocol URL always reaches the running app
const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) { win.show(); win.focus(); }
    const urlArg = argv.find((a) => a && a.startsWith('horizon://'));
    if (urlArg) handleHorizonUrl(urlArg);
  });
  app.on('open-url', (event, url) => { event.preventDefault(); handleHorizonUrl(url); });
}

app.whenReady().then(async () => {
  // Source-preview gate: no build-info.json → this is a clone, not an official build.
  if (!IS_OFFICIAL_BUILD) {
    showSourcePreview();
    return;
  }

  await startServer();
  createTray();

  // If launched via protocol URL on Windows/Linux, pick it up from argv
  const launchUrl = process.argv.find((a) => a && a.startsWith('horizon://'));
  if (launchUrl) setTimeout(() => handleHorizonUrl(launchUrl), 1500);

  // License gate: decide the initial page based on trial/subscription state.
  // - Trial active OR Pro active → onboarded? chat : setup
  // - Trial expired and no Pro    → progate.html (upgrade / enter key / contact)
  // We do a non-blocking server refresh too, so if the cache is stale it
  // gets corrected within a few seconds after the window is already shown.
  const onboarded = settingsStore.get('onboarded');
  const state = licenseManager.evaluate();
  const initialPage = state.allowed
    ? (onboarded ? 'chat' : 'setup')
    : 'progate';
  createWindow(initialPage);

  // Kick off background license polling (server-side truth) — safe to fire
  // and forget, listeners will handle state transitions.
  licenseManager.startPolling();
});

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => {}); // tray keeps alive
app.on('activate', () => { win?.show(); });
