'use strict';

// IPC handlers — computer use / screen / mouse / keyboard / smart click.
// Channels: transcribeAudio, captureScreen, analyzeScreen, pcOpen,
// pcOpenPath, pcScreenshot, pcShell, pcProcesses, pcKillProc, pcClipboard,
// pcSetClip, pcType, pcKeyPress, pcVolume, pcReadFile, pcWriteFile,
// pcListDir, pcChooseFolder, pcMouseMove, pcMouseClick, pcMouseDoubleClick,
// pcMouseScroll, pcMouseDrag, pcGetMousePos, pcScreenSize, analyzeImage,
// readUploadedFile, pcOpenUrl, pcSearch, smartClick, findUIElements.

const PS_MOUSE_CLASS = `Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class HorizonMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,int x,int y,int d,int e);
  public const uint MOVE=0x1,L_DOWN=0x2,L_UP=0x4,R_DOWN=0x8,R_UP=0x10,WHEEL=0x800;
}
'@ -PassThru`;

function register(deps) {
  const {
    ipcMain, desktopCapturer, screen, clipboard, shell, dialog,
    fs, os, path,
    IS_WIN, IS_MAC,
    keysStore, settingsStore,
    selectedModel, applyReasoningProfile, firstTextFromAnthropic,
    runShell, withPermission,
    WEB_APPS, APP_WIN_MAP, APP_MAC_MAP,
    resolveAppName, smartOpenUrl,
    getWin,
    loadAgentModules,
    getAgentTools, getComputerUse,
  } = deps;

  // ── VOICE: Multiple external providers ───────────────────────────────────────
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
        if (!key) { cleanup(); return { error: 'Deepgram key needed -> Settings -> Voice.' }; }
        const audioData = fs.readFileSync(tmp);
        const userLang = String(settingsStore.get('lang') || 'en').toLowerCase();
        const dgLang = userLang.startsWith('ru') ? 'ru' : 'en';
        const dgParams = new URLSearchParams({
          model: 'nova-2',
          language: dgLang,
          punctuate: 'true',
          filler_words: 'false',
        }).toString();
        const r = await fetch(`https://api.deepgram.com/v1/listen?${dgParams}`, {
          method: 'POST', headers: { 'Authorization': `Token ${key}`, 'Content-Type': mimeType.split(';')[0] }, body: audioData
        });
        const d = await r.json();
        cleanup();
        if (!r.ok) {
          return { error: d?.err_msg || d?.message || d?.error || `Deepgram HTTP ${r.status}` };
        }
        if (d?.err_msg || d?.error) {
          return { error: d.err_msg || (typeof d.error === 'string' ? d.error : 'Deepgram error') };
        }
        return { text: d.results?.channels?.[0]?.alternatives?.[0]?.transcript || '' };
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
        const model = selectedModel('claude');
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(applyReasoningProfile('claude', model, {
            model, max_tokens: 1024,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
              { type: 'text', text: q }
            ]}]
          }))
        });
        const d = await r.json();
        if (!d.error) return { reply: firstTextFromAnthropic(d), model, base64 };
      }

      // Try GPT-4o Vision
      const openaiKey = keysStore.get('k_openai');
      if (openaiKey) {
        const model = selectedModel('openai');
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
          body: JSON.stringify(applyReasoningProfile('openai', model, {
            model, max_tokens: 1024,
            messages: [{ role: 'user', content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
              { type: 'text', text: q }
            ]}]
          }))
        });
        const d = await r.json();
        if (!d.error) return { reply: d.choices?.[0]?.message?.content || 'No response', model, base64 };
      }

      // Try Gemini Vision
      const geminiKey = keysStore.get('k_gemini');
      if (geminiKey) {
        const model = selectedModel('gemini');
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(applyReasoningProfile('gemini', model, { contents: [{ parts: [
            { inline_data: { mime_type: 'image/png', data: base64 } },
            { text: q }
          ]}]}))
        });
        const d = await r.json();
        if (!d.error && d.candidates?.[0]?.content?.parts?.[0]?.text) return { reply: d.candidates[0].content.parts[0].text, model, base64 };
      }

      return { error: lang === 'ru'
        ? 'Нет ключа для Vision AI. Добавь Claude, OpenAI или Gemini в Настройках.'
        : 'No Vision AI key. Add Claude, OpenAI, or Gemini key in Settings.' };
    } catch(e) { return { error: e.message }; }
  });

  ipcMain.handle('pcOpen', async (event, appName = '') => {
    const target = String(appName || '').trim();
    if (!target) return { ok: false, err: 'Empty target' };
    return withPermission(
      event.sender,
      'app.open',
      { target },
      'Open app, URL, or folder',
      async () => {
    const raw = target;

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
      }
    );
  });

  ipcMain.handle('pcOpenPath', async (event, p) => withPermission(
    event.sender,
    'app.open_path',
    { path: String(p || '') },
    'Open local path',
    () => {
    if (!p) return { ok: false };
    shell.openPath(p);
    return { ok: true, opened: p };
    }
  ));

  ipcMain.handle('pcScreenshot', async (event) => withPermission(
    event.sender,
    'screen.capture',
    { target: 'primary-display' },
    'Capture screen',
    async () => {
    try {
      const sources = await desktopCapturer.getSources({ types:['screen'], thumbnailSize:{ width:1920, height:1080 } });
      if (!sources.length) return { ok:false, err:'No source' };
      const buf = sources[0].thumbnail.toPNG();
      const tmp = path.join(os.tmpdir(), `horizon_ss_${Date.now()}.png`);
      fs.writeFileSync(tmp, buf);
      return { ok:true, base64:buf.toString('base64'), path:tmp };
    } catch(e) { return { ok:false, err:e.message }; }
    }
  ));

  ipcMain.handle('pcShell',      async (event, cmd) => withPermission(
    event.sender,
    'shell_command',
    { command: String(cmd || '') },
    'Run shell command',
    () => runShell(cmd)
  ));
  ipcMain.handle('pcProcesses',  async ()        => runShell(IS_WIN ? 'tasklist /FO CSV /NH' : 'ps aux --sort=-%cpu | head -25'));
  ipcMain.handle('pcKillProc',   async (event, n) => withPermission(
    event.sender,
    'process.kill',
    { target: String(n || '') },
    'Kill process',
    () => runShell(IS_WIN ? `taskkill /F /IM "${n}"` : `pkill -f "${n}"`)
  ));
  ipcMain.handle('pcClipboard',  ()              => ({ ok:true, out: clipboard.readText()||'(empty)' }));
  ipcMain.handle('pcSetClip',    async (event, t) => withPermission(
    event.sender,
    'clipboard.write',
    { text: String(t || '').slice(0, 240) },
    'Write clipboard',
    () => { clipboard.writeText(t); return { ok:true }; }
  ));

  ipcMain.handle('pcType', async (event, text) => {
    text = String(text ?? '');
    const esc = text.replace(/'/g, "''");
    let cmd;
    if (IS_WIN)      cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 200; [System.Windows.Forms.SendKeys]::SendWait('${esc.replace(/[+^%~(){}[\]]/g,'{$&}')}')"`;
    else if (IS_MAC) cmd = `osascript -e 'tell application "System Events" to keystroke "${text.replace(/"/g,'\\"')}"'`;
    else             cmd = `xdotool type --clearmodifiers --delay 20 '${esc}'`;
    return withPermission(event.sender, 'computer.type', { text: String(text || '').slice(0, 240) }, 'Type into the active app', () => runShell(cmd));
  });

  ipcMain.handle('pcKeyPress', async (event, key) => {
    key = String(key ?? '');
    const wm = {'ctrl+c':'^c','ctrl+v':'^v','ctrl+z':'^z','ctrl+a':'^a','ctrl+s':'^s',
                 'alt+f4':'%{F4}','alt+tab':'%{TAB}','enter':'{ENTER}','escape':'{ESC}','tab':'{TAB}',
                 'win':'{LWIN}','f5':'{F5}','delete':'{DEL}','backspace':'{BS}'};
    let cmd;
    if (IS_WIN)      cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${wm[key.toLowerCase()]||`{${key.toUpperCase()}}`}')"`;
    else if (IS_MAC) cmd = `osascript -e 'tell application "System Events" to keystroke "${key}"'`;
    else             cmd = `xdotool key ${key}`;
    return withPermission(event.sender, 'computer.press_key', { key: String(key || '') }, 'Press key in the active app', () => runShell(cmd));
  });

  ipcMain.handle('pcVolume', async (event, level) => {
    let cmd;
    if (IS_WIN)      cmd = `powershell -NoProfile -Command "& {$v=[uint32](${level}/100.0*65535);Add-Type -TypeDefinition 'using System.Runtime.InteropServices;public class A{[DllImport(\\"winmm.dll\\")]public static extern int waveOutSetVolume(System.IntPtr h,uint v);}';[A]::waveOutSetVolume([System.IntPtr]::Zero,$v -bor ($v -shl 16))}"`;
    else if (IS_MAC) cmd = `osascript -e 'set volume output volume ${level}'`;
    else             cmd = `amixer sset Master ${level}%`;
    return withPermission(event.sender, 'system.volume', { level: Number(level) }, 'Change system volume', () => runShell(cmd));
  });

  ipcMain.handle('pcReadFile',  (_, p) => { try { return {ok:true,content:fs.readFileSync(p,'utf8')}; } catch(e) { return {ok:false,err:e.message}; } });
  ipcMain.handle('pcWriteFile', async (event, p, c) => withPermission(
    event.sender,
    'fs.write_file',
    { path: String(p || ''), bytes: Buffer.byteLength(String(c ?? ''), 'utf8') },
    'Write file',
    () => { try { fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,c,'utf8');return {ok:true}; } catch(e) { return {ok:false,err:e.message}; } }
  ));
  ipcMain.handle('pcListDir',   (_, d) => { try { return {ok:true,entries:fs.readdirSync(d,{withFileTypes:true}).map(e=>({name:e.name,isDir:e.isDirectory()}))}; } catch(e) { return {ok:false,err:e.message}; } });
  ipcMain.handle('pcChooseFolder', async () => {
    try {
      const r = await dialog.showOpenDialog(getWin(), {
        title: 'Choose Horizon workspace',
        properties: ['openDirectory']
      });
      if (r.canceled || !r.filePaths?.[0]) return { ok:false, canceled:true };
      settingsStore.set('codeWorkspace', r.filePaths[0]);
      return { ok:true, path:r.filePaths[0] };
    } catch(e) { return { ok:false, err:e.message }; }
  });

  // ── MOUSE & KEYBOARD — PowerShell only (no external deps, works on all Windows)

  ipcMain.handle('pcMouseMove', async (event, x, y) => withPermission(
    event.sender,
    'computer.mouse_move',
    { x: Number(x), y: Number(y) },
    'Move mouse cursor',
    () => {
    if (IS_WIN) return runShell(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})"`);
    if (IS_MAC) return runShell(`osascript -e 'tell application "System Events" to set the position of the mouse to {${x}, ${y}}'`);
    return runShell(`xdotool mousemove ${x} ${y}`);
    }
  ));

  ipcMain.handle('pcMouseClick', async (event, x, y, button) => withPermission(
    event.sender,
    'computer.mouse_click',
    { x: Number(x), y: Number(y), button: button || 'left' },
    'Click mouse',
    () => {
    button = button || 'left';
    if (IS_WIN) {
      const flags = button === 'right'
        ? '[HorizonMouse]::mouse_event([HorizonMouse]::R_DOWN,0,0,0,0);[HorizonMouse]::mouse_event([HorizonMouse]::R_UP,0,0,0,0)'
        : '[HorizonMouse]::mouse_event([HorizonMouse]::L_DOWN,0,0,0,0);[HorizonMouse]::mouse_event([HorizonMouse]::L_UP,0,0,0,0)';
      return runShell(`powershell -NoProfile -Command "${PS_MOUSE_CLASS} | Out-Null; [HorizonMouse]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 100; ${flags}"`);
    }
    if (IS_MAC) return runShell(`osascript -e 'tell application "System Events" to ${button === 'right' ? 'secondary click' : 'click'} at {${x}, ${y}}'`);
    return runShell(`xdotool mousemove ${x} ${y} click ${button === 'right' ? '3' : '1'}`);
    }
  ));

  ipcMain.handle('pcMouseDoubleClick', async (event, x, y) => withPermission(
    event.sender,
    'computer.mouse_double_click',
    { x: Number(x), y: Number(y) },
    'Double-click mouse',
    () => {
    if (IS_WIN) return runShell(`powershell -NoProfile -Command "${PS_MOUSE_CLASS} | Out-Null; [HorizonMouse]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 80; [HorizonMouse]::mouse_event([HorizonMouse]::L_DOWN,0,0,0,0);[HorizonMouse]::mouse_event([HorizonMouse]::L_UP,0,0,0,0);Start-Sleep -Milliseconds 60;[HorizonMouse]::mouse_event([HorizonMouse]::L_DOWN,0,0,0,0);[HorizonMouse]::mouse_event([HorizonMouse]::L_UP,0,0,0,0)"`);
    if (IS_MAC) return runShell(`osascript -e 'tell application "System Events" to double click at {${x}, ${y}}'`);
    return runShell(`xdotool mousemove ${x} ${y} click --repeat 2 1`);
    }
  ));

  ipcMain.handle('pcMouseScroll', async (event, direction, amount) => withPermission(
    event.sender,
    'computer.mouse_scroll',
    { direction: String(direction || ''), amount: Number(amount || 3) },
    'Scroll mouse wheel',
    () => {
    amount = amount || 3;
    if (IS_WIN) return runShell(`powershell -NoProfile -Command "${PS_MOUSE_CLASS} | Out-Null; [HorizonMouse]::mouse_event([HorizonMouse]::WHEEL,0,0,${direction === 'down' ? -120*amount : 120*amount},0)"`);
    if (IS_MAC) return runShell(`osascript -e 'tell application "System Events" to scroll ${direction === 'down' ? 'down' : 'up'} 3'`);
    return runShell(`xdotool click ${direction === 'down' ? '5' : '4'} --repeat ${amount}`);
    }
  ));

  ipcMain.handle('pcMouseDrag', async (event, x1, y1, x2, y2) => withPermission(
    event.sender,
    'computer.mouse_drag',
    { from: [Number(x1), Number(y1)], to: [Number(x2), Number(y2)] },
    'Drag mouse',
    () => {
    if (IS_WIN) return runShell(`powershell -NoProfile -Command "${PS_MOUSE_CLASS} | Out-Null; [HorizonMouse]::SetCursorPos(${x1},${y1}); Start-Sleep -Milliseconds 50; [HorizonMouse]::mouse_event([HorizonMouse]::L_DOWN,0,0,0,0); Start-Sleep -Milliseconds 50; [HorizonMouse]::SetCursorPos(${x2},${y2}); Start-Sleep -Milliseconds 50; [HorizonMouse]::mouse_event([HorizonMouse]::L_UP,0,0,0,0)"`);
    return runShell(`xdotool mousemove ${x1} ${y1} mousedown 1 mousemove ${x2} ${y2} mouseup 1`);
    }
  ));

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

    const claudeKey = keysStore.get('k_claude');
    if (claudeKey) {
      const model = selectedModel('claude');
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(applyReasoningProfile('claude', model, {
          model, max_tokens: 2048,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: base64 } },
            { type: 'text', text: q }
          ]}]
        }))
      });
      const d = await r.json();
      if (!d.error) return { reply: firstTextFromAnthropic(d), model };
    }

    const openaiKey = keysStore.get('k_openai');
    if (openaiKey) {
      const model = selectedModel('openai');
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
        body: JSON.stringify(applyReasoningProfile('openai', model, {
          model, max_tokens: 2048,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${base64}` } },
            { type: 'text', text: q }
          ]}]
        }))
      });
      const d = await r.json();
      if (!d.error) return { reply: d.choices?.[0]?.message?.content || 'No response', model };
    }

    const geminiKey = keysStore.get('k_gemini');
    if (geminiKey) {
      const model = selectedModel('gemini');
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(applyReasoningProfile('gemini', model, { contents: [{ parts: [
          { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64 } },
          { text: q }
        ]}]}))
      });
      const d = await r.json();
      if (!d.error && d.candidates?.[0]?.content?.parts?.[0]?.text) return { reply: d.candidates[0].content.parts[0].text, model };
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

      const textExts = ['txt','md','js','ts','jsx','tsx','py','html','css','json','csv','xml','yaml','yml','sh','bat','sql','log','ini','env','gitignore','dockerfile'];
      if (textExts.includes(ext)) {
        const text = buf.toString('utf8').slice(0, 50000);
        return { ok: true, type: 'text', content: text, ext };
      }

      if (ext === 'zip') {
        const tmp = path.join(os.tmpdir(), `horizon_zip_${Date.now()}`);
        const zipPath = tmp + '.zip';
        fs.writeFileSync(zipPath, buf);
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
  ipcMain.handle('pcOpenUrl', async (event, url) => withPermission(
    event.sender,
    'browser.open',
    { url: String(url || '') },
    'Open URL',
    () => { shell.openExternal(url); return { ok: true }; }
  ));

  // ── Smart Web Search / YouTube opener ────────────────────────────────────────
  ipcMain.handle('pcSearch', async (event, query, engine) => {
    const urls = {
      google:   `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      youtube:  `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      yandex:   `https://yandex.ru/search/?text=${encodeURIComponent(query)}`,
      bing:     `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      github:   `https://github.com/search?q=${encodeURIComponent(query)}`,
      reddit:   `https://www.reddit.com/search/?q=${encodeURIComponent(query)}`,
    };
    const url = urls[engine || 'google'];
    return withPermission(
      event.sender,
      'browser.search',
      { query: String(query || ''), engine: engine || 'google', url },
      'Open web search',
      () => { shell.openExternal(url); return { ok: true, url }; }
    );
  });

  // ── COMPUTER USE: Smart click by description ─────────────────────────────────
  ipcMain.handle('smartClick', async (event, targetDescription) => withPermission(
    event.sender,
    'computer.smart_click',
    { target: String(targetDescription || '') },
    'Analyze screen and click target',
    async () => {
    loadAgentModules();
    const computerUse = getComputerUse();
    const agentTools = getAgentTools();
    if (!computerUse || !agentTools) return { ok: false, error: 'Computer Use not loaded' };

    const captureScreenFn = async () => {
      try {
        const src = await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1920,height:1080}});
        if (!src.length) return null;
        return { ok: true, base64: src[0].thumbnail.toPNG().toString('base64') };
      } catch { return null; }
    };

    const geminiKey = keysStore.get('k_gemini');
    if (!geminiKey) return { ok: false, error: 'Gemini key needed for vision' };

    const aiVisionFn = async (base64, prompt) => {
      const fetch = require('node-fetch');
      const model = selectedModel('gemini');
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(applyReasoningProfile('gemini', model, {
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'image/png', data: base64 } }
            ]
          }]
        }))
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
    }
  ));

  // ── COMPUTER USE: Find UI Elements ───────────────────────────────────────────
  ipcMain.handle('findUIElements', async () => {
    loadAgentModules();
    const computerUse = getComputerUse();
    if (!computerUse) return { ok: false, error: 'Computer Use not loaded' };

    try {
      const src = await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1920,height:1080}});
      if (!src.length) return { ok: false, error: 'No screen' };
      const base64 = src[0].thumbnail.toPNG().toString('base64');

      const geminiKey = keysStore.get('k_gemini');
      if (!geminiKey) return { ok: false, error: 'Gemini key needed for vision' };

      const fetch = require('node-fetch');
      const aiVisionFn = async (b64, prompt) => {
        const model = selectedModel('gemini');
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(applyReasoningProfile('gemini', model, {
            contents: [{role:'user', parts:[{text:prompt},{inline_data:{mime_type:'image/png',data:b64}}]}]
          }))
        });
        const d = await r.json();
        return { text: d.candidates?.[0]?.content?.parts?.[0]?.text || '' };
      };

      return computerUse.findUIElements(base64, aiVisionFn);
    } catch(e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { register };
