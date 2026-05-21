'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, Notification,
  shell, clipboard, nativeImage, desktopCapturer, screen, dialog
} = require('electron');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');
const fs     = require('fs');
const http   = require('http');
const { exec, spawn } = require('child_process');
const Store  = require('electron-store');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function getMarketplaceWebBase() {
  const configured = settingsStore?.get?.('marketplaceWebUrl') || process.env.HORIZON_MARKETPLACE_WEB_URL || 'https://horizonaai.dev';
  return String(configured || 'https://horizonaai.dev').replace(/\/+$/, '');
}

async function openExternalReliable(rawUrl, title = 'Horizon') {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url) && !/^horizon:\/\//i.test(url)) {
    return { ok: false, url, error: 'Unsupported URL' };
  }
  try {
    await shell.openExternal(url, { activate: true });
    return { ok: true, url, method: 'system-browser' };
  } catch (externalError) {
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, url, error: externalError.message };
    }
    try {
      const browser = new BrowserWindow({
        width: 1180,
        height: 820,
        title,
        show: true,
        backgroundColor: '#080b10',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      browser.setMenuBarVisibility(false);
      await browser.loadURL(url);
      return { ok: true, url, method: 'fallback-window', warning: externalError.message };
    } catch (fallbackError) {
      return { ok: false, url, error: `${externalError.message}; fallback failed: ${fallbackError.message}` };
    }
  }
}

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
  'ai', 'agentRun', 'agentControl', 'agentStep', 'agentTool', 'analyzeScreen', 'analyzeImage',
  'ttsElevenLabs', 'ttsOpenAI', 'transcribeAudio',
  'search', 'mcpWebSearch',
  'captureScreen', 'pcScreenshot',
  'executeCode',
  // Computer use / OS control
  'pcShell', 'pcKillProc', 'pcOpen',
  'pcType', 'pcKeyPress', 'pcVolume',
  'pcReadFile', 'pcWriteFile', 'pcListDir', 'pcChooseFolder',
  'wsChooseFolder', 'wsGetWorkspace', 'wsList', 'wsRead', 'wsWrite', 'wsSearch', 'wsShell',
  'projectConfigWriteRules', 'projectConfigWriteHooks',
  'terminalCreate', 'terminalWrite', 'terminalResize', 'terminalKill',
  'pcMouseMove', 'pcMouseClick', 'pcMouseDoubleClick',
  'pcMouseScroll', 'pcMouseDrag',
  'smartClick', 'findUIElements',
  // Browser automation
  'browserOpenUrl', 'browserSearch', 'browserOpenSite',
  // MCP write actions
  'mcpGmailSend', 'mcpCalendarCreate', 'mcpCalendarQuickAdd',
  'mcpServerUpsert', 'mcpServerRemove', 'mcpServerEnable', 'mcpServerTest', 'mcpToolsRefresh',
  // Workflows / recorder
  'workflowRun',
  'recorderStart', 'recorderStop', 'recorderSave', 'recorderNarrate',
  // Skills — write/exec paths gated; read-only listing/reading are free.
  'skillsWrite', 'skillsToggle', 'skillsUninstall',
  'skillsInstallBundle', 'skillsInstallFromUrl',
  'skillsRunHelper',
  // Telegram destructive/outbound — read paths (tgListChats/tgGetHistory)
  // stay free so the UI can render without a pro check.
  'tgClearHistory', 'tgSendFromUI',
  // Discord destructive/outbound — same shape as Telegram.
  'dcClearHistory', 'dcSendFromUI',
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

// Expose the settings store on this module's exports so sibling modules
// (e.g. agentLoop.js) can read user preferences (active persona, etc)
// without us having to thread them through every call signature.
// `module.exports.settingsStore = ...` is intentional — agentLoop
// reaches us via `require.cache[require.resolve('./main')].exports`
// rather than a direct require() loop.
module.exports.settingsStore = settingsStore;
module.exports.keysStore = keysStore;

const ALLOWED_KEY_IDS = new Set([
  'gemini', 'groq', 'groq_voice', 'deepseek', 'mistral', 'qwen', 'grok',
  'claude', 'openai', 'tavily', 'elevenlabs', 'deepgram', 'localai',
  'perplexity', 'cohere', 'openrouter', 'github', 'google_client_secret',
  'slack', 'notion', 'linear', 'telegram_bot', 'discord_bot',
  // Phase 9 — additional providers
  'together', 'fireworks', 'deepinfra', 'cerebras', 'sambanova',
  'moonshot', 'zai', 'nebius', 'azure', 'custom',
  // Phase 15 — channel + executor BYOK credentials
  'twilio_sid', 'twilio_token',
]);
const ALLOWED_MODEL_SETTING_PROVIDERS = new Set([
  'claude', 'openai', 'gemini', 'groq', 'deepseek',
  'grok', 'mistral', 'qwen', 'perplexity', 'cohere',
  'openrouter', 'ollama', 'lmstudio', 'localai',
]);
const ALLOWED_SETTING_KEYS = new Set([
  'userName', 'lang', 'provider', 'geminiModel', 'voiceProvider', 'subagentProvider',
  'executionMode', 'dockerWorkspaceMount',
  // Phase 15 — BYOK remote executor backends. Set from Settings → Models
  // when executionMode = ssh/modal/daytona.
  'ssh.host', 'ssh.port', 'ssh.keyPath', 'ssh.workdir',
  'modal.tokenId', 'modal.tokenSecret', 'modal.appName', 'modal.endpoint',
  'daytona.serverUrl', 'daytona.apiKey', 'daytona.workspaceId',
  // Phase 28.3 — Singularity / Apptainer executor for HPC clusters.
  'singularity.image', 'singularity.bind', 'singularity.binary',
  // Phase 15 — multi-field channel adapters
  'whatsapp.from', 'whatsapp.enabled',
  'signal.url', 'signal.number', 'signal.enabled',
  'imessage.enabled', 'imessage.lastRowid',
  // Phase 28.3 — Email channel adapter (IMAP inbound + SMTP outbound).
  'email.enabled',
  'email.imap.host', 'email.imap.port', 'email.imap.user', 'email.imap.pass',
  'email.imap.tls', 'email.imap.mailbox', 'email.imap.pollSec',
  'email.smtp.host', 'email.smtp.port', 'email.smtp.user', 'email.smtp.pass',
  'email.smtp.from',
  // Phase 21 — Discord runtime (token stored in keysStore as k_discord,
  // but the live toggle + allowed-guilds list live in settingsStore).
  'discord.enabled', 'discord.allowed_guild_ids',
  'connection.discord.live',
  // Phase 18 — TUI welcome flag (set once on first launch so the
  // animated reveal only plays for new users)
  'tui.welcomedAt',
  'ttsProvider', 'elevenLabsVoice', 'openaiTtsVoice', 'tts',
  'screenWatcher', 'wakeOn', 'ambientOn', 'notificationsOn',
  'mode', 'searchOn', 'responseProfile',
  'workflows', 'persona', 'onboarded', 'marketplaceUrl', 'marketplaceWebUrl',
  'ollamaUrl', 'ollamaModel', 'lmStudioUrl', 'lmStudioModel',
  'localAiUrl', 'localAiModel',
  'wakeStrictMode', 'wakeVolumeThreshold', 'wakeConfirmBeep',
  'settingsHealthCheckAt', 'googleClientId',
  'settingsTab',
  'openrouter.modelsCache', 'openrouter.modelsCacheAt',
  'mcp.enabled', 'mcp.servers', 'mcp.toolsCache', 'mcp.toolsCacheAt',
  'connection.telegram_bot.live', 'connection.telegram_bot.allowed_user_ids',
  'codeWorkspace', 'codeOpenFiles', 'codeActiveTabIdx', 'wsListIgnore',
  'inspectorActive', 'chatSidebarCollapsed', 'chatSidebarWidth',
  'customPersonas',
  'permissionAllowlist',
  'image.provider', 'image.model.openai', 'image.model.gemini',
  // PR-D1.5 — ⌘K edit history (LRU 10) + auto-commit toggle.
  'cmdKHistory', 'cmdKAutoCommit',
  // PR-Plan-Act — toggle gates the first agent tool execution behind
  // a user-visible "Approve plan" CTA. + shellClean / settingsScroll
  // (set elsewhere but added here for completeness).
  'planActGate', 'shellClean', 'settingsScroll',
]);

// Provider model registries, SSE stream parsing, native-tool conversion,
// and similar pure helpers live in runtime/aiHelpers.js.
const {
  DEFAULT_PROVIDER_MODELS,
  KNOWN_PROVIDER_MODELS,
  normalizeSelectedModel,
  firstTextFromAnthropic,
  normaliseUsage,
  lastUserMessageText,
  readSseStream,
  extractStreamPayload,
  nativeToolPack,
  toOpenAITools,
  toAnthropicTools,
  toOpenAIChatMessages,
  toAnthropicMessages,
  parseAnthropicToolCalls,
  parseOpenAIToolCalls,
  mapNativeToolCalls,
} = require('./runtime/aiHelpers');

function assertAllowedKey(service) {
  if (!ALLOWED_KEY_IDS.has(String(service || ''))) {
    throw new Error(`Unsupported secret slot: ${service}`);
  }
}

function assertAllowedSetting(key) {
  const safeKey = String(key || '');
  if (safeKey.startsWith('model.')) {
    const provider = safeKey.slice('model.'.length);
    if (ALLOWED_MODEL_SETTING_PROVIDERS.has(provider)) return;
  }
  // Subagent model override: subagentModel.<provider> — uses the same
  // provider allowlist as the main model picker.
  if (safeKey.startsWith('subagentModel.')) {
    const provider = safeKey.slice('subagentModel.'.length);
    if (ALLOWED_MODEL_SETTING_PROVIDERS.has(provider)) return;
  }
  if (!ALLOWED_SETTING_KEYS.has(safeKey)) {
    throw new Error(`Unsupported setting: ${key}`);
  }
}

function localOpenAIEndpoint(provider) {
  if (provider === 'ollama') {
    const base = settingsStore.get('ollamaUrl') || 'http://127.0.0.1:11434/v1';
    return {
      url: `${String(base).replace(/\/+$/, '')}/chat/completions`,
      model: settingsStore.get('model.ollama') || settingsStore.get('ollamaModel') || DEFAULT_PROVIDER_MODELS.ollama,
      key: '',
      label: 'ollama/local',
    };
  }
  if (provider === 'lmstudio') {
    const base = settingsStore.get('lmStudioUrl') || 'http://127.0.0.1:1234/v1';
    return {
      url: `${String(base).replace(/\/+$/, '')}/chat/completions`,
      model: settingsStore.get('model.lmstudio') || settingsStore.get('lmStudioModel') || DEFAULT_PROVIDER_MODELS.lmstudio,
      key: '',
      label: 'lm-studio/local',
    };
  }
  if (provider === 'localai') {
    const base = settingsStore.get('localAiUrl') || 'http://127.0.0.1:8080/v1';
    return {
      url: `${String(base).replace(/\/+$/, '')}/chat/completions`,
      model: settingsStore.get('model.localai') || settingsStore.get('localAiModel') || DEFAULT_PROVIDER_MODELS.localai,
      key: keysStore.get('k_localai') || '',
      label: 'openai-compatible/local',
    };
  }
  return null;
}

function selectedModel(provider, opts = {}) {
  if (opts && typeof opts.model === 'string' && opts.model.trim()) return normalizeSelectedModel(provider, opts.model);
  if (provider === 'gemini') {
    return normalizeSelectedModel(provider, settingsStore.get('model.gemini') || settingsStore.get('geminiModel') || DEFAULT_PROVIDER_MODELS.gemini);
  }
  const localEp = localOpenAIEndpoint(provider);
  if (localEp) return localEp.model;
  return normalizeSelectedModel(provider, settingsStore.get(`model.${provider}`) || DEFAULT_PROVIDER_MODELS[provider] || DEFAULT_PROVIDER_MODELS.openai);
}

function responseProfile() {
  const value = settingsStore.get('responseProfile') || 'balanced';
  return value === 'fast' || value === 'deep' ? value : 'balanced';
}

function applyReasoningProfile(provider, model, body) {
  const profile = responseProfile();
  if (provider === 'claude' && profile === 'deep') {
    body.thinking = { type: 'enabled', budget_tokens: 8000 };
    body.max_tokens = Math.max(body.max_tokens || 4096, 16000);
  }
  if (provider === 'openai') {
    const isReasoningModel = /^o[134]/.test(model || '') || /thinking|reasoning/.test(model || '');
    if (isReasoningModel && profile === 'deep') body.reasoning_effort = 'high';
    if (isReasoningModel && profile === 'fast') body.reasoning_effort = 'low';
  }
  if (provider === 'gemini') {
    body.generationConfig = body.generationConfig || {};
    if (/^gemini-(2\.5|3)/.test(model || '')) {
      if (profile === 'deep') body.generationConfig.thinkingConfig = { thinkingBudget: -1 };
      if (profile === 'fast') body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
  }
  return body;
}

function resolveSkillsForMessages(messages, opts = {}) {
  const forcedIds = Array.isArray(opts?.forcedSkillIds)
    ? opts.forcedSkillIds.map(String).map(s => s.trim()).filter(Boolean)
    : [];
  const shouldUseSkills = opts?.useSkills === true || forcedIds.length > 0;
  if (!shouldUseSkills) return { block: '', selected: [], scored: [] };
  try {
    loadAgentModules();
    if (!skillsManager) return { block: '', selected: [], scored: [] };
    const query = String(opts.skillQuery || lastUserMessageText(messages) || '').trim();
    const res = skillsManager.getSkillsBlock(query, { forcedIds });
    const selected = (res.selected || []).map(s => ({
      id: s.id,
      score: s.score,
      breakdown: s.breakdown,
      scope: s.scope,
      forced: s.forced,
      truncated: s.truncated,
      bytes: s.bytes,
    }));
    const scored = (res.scored || []).map(s => ({
      id: s.id,
      score: s.score,
      breakdown: s.breakdown,
      scope: s.scope,
      forced: s.forced,
    }));
    if (selected.length) {
      try { skillsManager.recordUsage(selected.map(s => s.id), query, forcedIds.length ? 'forced' : 'selected'); } catch (_) {}
    }
    return { block: res.block || '', selected, scored };
  } catch (e) {
    console.warn('skills resolve failed:', e.message);
    return { block: '', selected: [], scored: [], error: e.message };
  }
}

function appendSkillsToSystemPrompt(systemPrompt, skillsResolved) {
  const block = String(skillsResolved?.block || '').trim();
  if (!block) return String(systemPrompt || '');
  return `${String(systemPrompt || '').trim()}\n\n## Skills loaded for this turn\n\n${block}`;
}

// Non-streaming chat completion + dialectic extractor. Factory binds
// keysStore / settingsStore / model helpers, then exposes runAiCompletion
// (the `ai` IPC handler) + `_extractDialecticDiffs` (background user-model
// extractor wired into agentMemory). Lazy `getPersonas` / `getDialecticModel`
// avoid the chicken-and-egg with loadAgentModules() which constructs them.
const { runAiCompletion, _extractDialecticDiffs } = require('./runtime/aiCompletion').createAiCompletion({
  keysStore,
  settingsStore,
  selectedModel,
  applyReasoningProfile,
  localOpenAIEndpoint,
  resolveSkillsForMessages,
  appendSkillsToSystemPrompt,
  loadAgentModules: () => loadAgentModules(),
  getPersonas: () => personas,
  getDialecticModel: () => dialecticModel,
});

// ── Source-preview build check ────────────────────────────────────────────────
// The CI release workflow (.github/workflows/release.yml) writes build-info.json
// into this directory before packaging. When the app is run from a source clone
// the file doesn't exist — we show a preview window and exit. Source is BSL 1.1 and
// readable for audit/contribution; runnable builds come from GitHub Releases.
// Native tool-call conversion helpers for agent mode.

// Source-preview build check.
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
      if (p.startsWith('/vendor/monaco/')) {
        const monacoRoot = path.join(__dirname, '../../node_modules/monaco-editor/min/vs');
        const rel = p.replace(/^\/vendor\/monaco\//, '');
        const full = path.resolve(monacoRoot, rel);
        const rootCmp = path.resolve(monacoRoot).toLowerCase();
        if (full.toLowerCase() !== rootCmp && !full.toLowerCase().startsWith(rootCmp + path.sep)) {
          rsp.writeHead(403); rsp.end('Forbidden'); return;
        }
        fs.readFile(full, (err, data) => {
          if (err) { rsp.writeHead(404); rsp.end('Not found'); return; }
          const ext = path.extname(full);
          const mime = {
            '.js': 'application/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.ttf': 'font/ttf',
            '.json': 'application/json; charset=utf-8',
          }[ext] || 'application/octet-stream';
          rsp.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
          rsp.end(data);
        });
        return;
      }
      if (p.startsWith('/vendor/xterm/')) {
        const xtermRoot = path.join(__dirname, '../../node_modules/@xterm/xterm');
        const rel = p.replace(/^\/vendor\/xterm\//, '');
        const full = path.resolve(xtermRoot, rel);
        const rootCmp = path.resolve(xtermRoot).toLowerCase();
        if (full.toLowerCase() !== rootCmp && !full.toLowerCase().startsWith(rootCmp + path.sep)) {
          rsp.writeHead(403); rsp.end('Forbidden'); return;
        }
        fs.readFile(full, (err, data) => {
          if (err) { rsp.writeHead(404); rsp.end('Not found'); return; }
          const ext = path.extname(full);
          const mime = {
            '.js': 'application/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.map': 'application/json; charset=utf-8',
          }[ext] || 'application/octet-stream';
          rsp.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
          rsp.end(data);
        });
        return;
      }
      if (p === '/') p = '/chat.html';
      const full = path.join(PAGES, p);
      fs.readFile(full, (err, data) => {
        if (err) { rsp.writeHead(404); rsp.end('Not found'); return; }
        const ext = path.extname(full);
        const mime = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.txt': 'text/plain; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml; charset=utf-8',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
        }[ext] || 'text/plain; charset=utf-8';
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

  // Open the window large enough that the multi-chat sidebar (280 px) +
  // the provider row (~12 chips + Wake + persona) + the modes row
  // (12 chips) + the title bar pills + the chat status bar all fit on
  // screen without horizontal clipping. We always maximize on launch
  // so the user starts with every control visible; they can resize
  // back down via the standard window-restore button if they prefer.
  const { screen } = require('electron');
  const primary = screen.getPrimaryDisplay();
  const work = primary.workAreaSize;
  const _shouldMaximizeOnLaunch = true;
  const initW = Math.min(1600, Math.max(1280, Math.round(work.width  * 0.85)));
  const initH = Math.min(980,  Math.max(800,  Math.round(work.height * 0.88)));

  // PR-B5 — native window-control treatment per platform.
  //   • macOS: titleBarStyle: 'hiddenInset' shows the native traffic-
  //     lights in the top-left while the rest of the title bar stays
  //     transparent for our custom drag region. trafficLightPosition
  //     pushes them down 18px so they sit centered in our 52px .tb
  //     bar instead of clipping at the very top.
  //   • Windows/Linux: keep a frameless window and let the renderer draw
  //     small controls. The native Windows titleBarOverlay looked oversized
  //     and sat on top of Horizon's own toolbar at several widths.
  // The renderer's existing `body { -webkit-app-region: drag }` +
  // `.no-drag` markers continue to work unchanged.
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const winOpts = {
    width: initW, height: initH,
    minWidth: 1280, minHeight: 760,
    center: true,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  };
  if (isMac) {
    winOpts.frame = false;
    winOpts.titleBarStyle = 'hiddenInset';
    winOpts.trafficLightPosition = { x: 14, y: 18 }; // centre in 52px .tb
  } else if (isWin) {
    winOpts.frame = false;
  } else {
    // Linux fallback — unchanged.
    winOpts.frame = false;
  }
  win = new BrowserWindow(winOpts);

  const isLocalRenderer = (wc) => {
    try {
      const u = new URL(wc.getURL() || '');
      return u.hostname === '127.0.0.1' && String(u.port) === String(port);
    } catch {
      return false;
    }
  };
  const isLocalOrigin = (origin) => {
    try {
      const u = new URL(origin || '');
      return u.hostname === '127.0.0.1' && String(u.port) === String(port);
    } catch {
      return false;
    }
  };
  const allowedPermissions = new Set(['media', 'display-capture', 'notifications']);
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => {
    cb(isLocalRenderer(wc) && allowedPermissions.has(perm));
  });
  win.webContents.session.setPermissionCheckHandler((wc, perm) => {
    return isLocalRenderer(wc) && allowedPermissions.has(perm);
  });
  win.webContents.session.setDevicePermissionHandler((details) => {
    const local = details.webContents ? isLocalRenderer(details.webContents) : isLocalOrigin(details.origin);
    return local && ['audioinput', 'videoinput'].includes(details.deviceType);
  });

  // Let the Pro guard redirect here if a user hits a Pro handler after expiry.
  _proGuardWindowRef = win;

  win.loadURL(url);

  // Dev-only: F12 / Ctrl+Shift+I open DevTools, and DevTools open
  // automatically once the first page finishes loading. Skipped entirely
  // for packaged installs (app.isPackaged === true) so end users do not
  // see or accidentally trigger the inspector.
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const isF12 = input.key === 'F12';
      const isCtrlShiftI = input.control && input.shift && input.key === 'I';
      if (isF12 || isCtrlShiftI) {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
    win.webContents.once('did-finish-load', () => {
      try { win.webContents.openDevTools({ mode: 'detach' }); } catch (_) {}
    });
  }

  // On laptop-class displays open maximized so all toolbar/sidebar
  // controls (Wake button, persona dropdown, every provider chip,
  // every mode chip, title-bar icons) are visible from the start.
  if (_shouldMaximizeOnLaunch) {
    try { win.maximize(); } catch (_) {}
  }

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
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── IPC: Keys & Settings ──────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Pull the OpenRouter model catalog (200+ entries). Public endpoint — no key
// required to list. Returns {ok, models:[{id,name,context_length}]}.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── IPC: Misc ─────────────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── VOICE: Multiple external providers ───────────────────────────────────────
// Provider pricing and quotas change often, so Horizon does not hardcode them.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── Screen Capture ────────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── Analyze Screen with Vision AI ─────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── Shell helper ──────────────────────────────────────────────────────────────
function runShell(cmd, timeout = 12000, options = {}) {
  return new Promise(resolve => {
    exec(cmd, { timeout, encoding: 'utf8', shell: true, cwd: options.cwd }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || stderr || '').trim().slice(0, 3000), err: err?.message });
    });
  });
}

function comparePath(p) {
  return path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function currentWorkspaceRoot() {
  const root = settingsStore.get('codeWorkspace') || '';
  if (!root) throw new Error('No workspace selected');
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error('Workspace folder does not exist');
  return abs;
}

function resolveWorkspacePath(rel = '') {
  const root = currentWorkspaceRoot();
  const input = String(rel || '').trim();
  if (path.isAbsolute(input)) throw new Error('Use workspace-relative paths');
  const target = path.resolve(root, input || '.');
  const rootCmp = comparePath(root);
  const targetCmp = comparePath(target);
  if (targetCmp !== rootCmp && !targetCmp.startsWith(rootCmp + path.sep)) {
    throw new Error('Path escapes workspace');
  }
  return { root, target, rel: path.relative(root, target).replace(/\\/g, '/') };
}

function safeDirEntries(target) {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'out']);
  return fs.readdirSync(target, { withFileTypes: true })
    .filter(e => !ignored.has(e.name))
    .map(e => {
      const full = path.join(target, e.name);
      let stat = null;
      try { stat = fs.statSync(full); } catch (_) {}
      return {
        name: e.name,
        isDir: e.isDirectory(),
        size: stat?.size || 0,
        mtime: stat?.mtime?.toISOString?.() || null,
      };
    });
}

function searchWorkspaceFiles(root, startDir, query) {
  const q = String(query || '').toLowerCase();
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'out']);
  const results = [];
  let visited = 0;
  const textExt = new Set(['.js','.jsx','.ts','.tsx','.json','.md','.txt','.css','.html','.py','.ps1','.sh','.yml','.yaml','.xml','.sql']);
  function walk(dir) {
    if (results.length >= 100 || visited >= 1200) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes:true }); } catch (_) { return; }
    for (const entry of entries) {
      if (results.length >= 100 || visited >= 1200) return;
      if (ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      visited++;
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase().includes(q)) results.push({ rel, name:entry.name, isDir:true, match:'name' });
        walk(full);
        continue;
      }
      let matched = entry.name.toLowerCase().includes(q);
      let match = matched ? 'name' : '';
      if (!matched && textExt.has(path.extname(entry.name).toLowerCase())) {
        try {
          const stat = fs.statSync(full);
          if (stat.size <= 256 * 1024) {
            const content = fs.readFileSync(full, 'utf8');
            const idx = content.toLowerCase().indexOf(q);
            if (idx >= 0) {
              matched = true;
              match = content.slice(Math.max(0, idx - 40), Math.min(content.length, idx + q.length + 80)).replace(/\s+/g, ' ');
            }
          }
        } catch (_) {}
      }
      if (matched) results.push({ rel, name:entry.name, isDir:false, match });
    }
  }
  walk(startDir);
  return results;
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
  
  // Single word top-level sites
  const topSites = {
    'ютуб': 'https://youtube.com', 'youtube': 'https://youtube.com',
    'вк': 'https://vk.com', 'vk': 'https://vk.com',
    'гугл': 'https://google.com', 'google': 'https://google.com',
    'телеграм': 'https://web.telegram.org', 'telegram': 'https://web.telegram.org',
    'ватсап': 'https://web.whatsapp.com', 'whatsapp': 'https://web.whatsapp.com',
    'инста': 'https://instagram.com', 'instagram': 'https://instagram.com',
    'чатгпт': 'https://chat.openai.com', 'chatgpt': 'https://chat.openai.com',
    'твитч': 'https://twitch.tv', 'twitch': 'https://twitch.tv'
  };
  if (topSites[lo]) return topSites[lo];
  if (raw.includes('.')) return `https://${raw}`;
  return null;
}

// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// PR-D3 — Project config (.horizon/rules.md + hooks.json). Per-
// workspace agent customisation; agentLoop.js pulls rules.md via
// require.cache → getProjectConfig() so every agent turn includes
// the project's instructions.
let _projectConfig = null;
function _getProjectConfig() {
  if (!_projectConfig) {
    const { ProjectConfig } = require('./projectConfig');
    _projectConfig = new ProjectConfig();
  }
  return _projectConfig;
}
module.exports.getProjectConfig = _getProjectConfig;
module.exports.currentWorkspaceRoot = currentWorkspaceRoot;

// PHASE 8/8 — Workspace memory loader. Reads .horizon/memory.json on
// demand; agentLoop injects it into the system prompt right after the
// project rules block. Cache-invalidated by mtime; manual edits via
// the renderer go through writeWorkspaceMemory IPC.
let _workspaceMemory = null;
function _getWorkspaceMemory() {
  if (!_workspaceMemory) {
    const { WorkspaceMemory } = require('./workspaceMemory');
    _workspaceMemory = new WorkspaceMemory();
  }
  return _workspaceMemory;
}
module.exports.getWorkspaceMemory = _getWorkspaceMemory;

// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// PR-D2 — Workspace symbol indexer (lazy singleton). Build runs in
// the main process; caps inside workspaceIndexer.js keep it bounded
// on huge monorepos (returns truncated:true at the file/symbol cap).
let _wsIndexer = null;
function _getWsIndexer() {
  if (!_wsIndexer) {
    const { WorkspaceIndexer } = require('./workspaceIndexer');
    _wsIndexer = new WorkspaceIndexer();
  }
  return _wsIndexer;
}

// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

const terminalSessions = new Map();
let nodePtyState = { tried: false, mod: null, error: null };

function terminalShell() {
  if (IS_WIN) return process.env.ComSpec || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

function terminalArgs() {
  if (!IS_WIN) return ['-l'];
  return [];
}

function terminalEnv() {
  return {
    ...process.env,
    TERM: process.env.TERM || 'xterm-256color',
    COLORTERM: process.env.COLORTERM || 'truecolor',
    FORCE_COLOR: process.env.FORCE_COLOR || '1',
  };
}

function loadNodePty() {
  if (nodePtyState.tried) return nodePtyState;
  nodePtyState.tried = true;
  try {
    // Optional native dependency. If it is not rebuilt for this Electron ABI,
    // Horizon falls back to the pipe-backed shell instead of breaking startup.
    const mod = require('node-pty');
    if (!mod || typeof mod.spawn !== 'function') throw new Error('node-pty did not expose spawn()');
    nodePtyState.mod = mod;
  } catch (e) {
    nodePtyState.error = e;
  }
  return nodePtyState;
}

function createPtyTerminal({ termId, cwd, cols, rows, send, onExit }) {
  const state = loadNodePty();
  if (!state.mod) return null;
  const term = state.mod.spawn(terminalShell(), terminalArgs(), {
    name: 'xterm-256color',
    cols: Number(cols) || 100,
    rows: Number(rows) || 30,
    cwd,
    env: terminalEnv(),
  });
  if (typeof term.onData === 'function') term.onData(send);
  else if (typeof term.on === 'function') term.on('data', send);
  if (typeof term.onExit === 'function') {
    term.onExit(({ exitCode, signal }) => onExit(exitCode, signal));
  } else if (typeof term.on === 'function') {
    term.on('exit', onExit);
  }
  return {
    id: termId,
    backend: 'pty',
    shell: terminalShell(),
    cwd,
    write(data) { term.write(String(data ?? '')); },
    resize(nextCols, nextRows) {
      const c = Number(nextCols) || 100;
      const r = Number(nextRows) || 30;
      if (typeof term.resize === 'function') term.resize(c, r);
    },
    kill() { term.kill(); },
  };
}

function createPipeTerminal({ termId, cwd, send, onExit }) {
  const term = spawn(terminalShell(), terminalArgs(), {
    cwd,
    env: terminalEnv(),
    shell: false,
    windowsHide: true,
  });
  term.stdout?.on?.('data', send);
  term.stderr?.on?.('data', send);
  term.on('error', err => send(`\r\n[terminal error: ${err.message}]\r\n`));
  term.on('exit', onExit);
  return {
    id: termId,
    backend: 'pipe',
    shell: terminalShell(),
    cwd,
    nativeError: nodePtyState.error?.message || '',
    write(data) { term.stdin?.write?.(String(data ?? '').replace(/\r/g, '\n')); },
    resize() {},
    kill() { term.kill(); },
  };
}

// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

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

// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── Image/File analysis via AI Vision ────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── File reading for ZIP/TXT/code ────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── Direct URL opener ─────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── Smart Web Search / YouTube opener ────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── OpenAI TTS ────────────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── AI Providers ──────────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Phase 4.1 — image generation IPC (BYOK: caller picks provider + model,
// we read the user's stored key, never proxy). Returns base64 image data
// so renderer can render via <img src="data:..."> without disk round-trip.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── Web Search ────────────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ═══════════════════════════════════════════════════════════════════════════════
// PR-C5 — STREAMING AI (Claude + OpenAI SSE)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Token-by-token rendering for Claude + OpenAI. Other providers fall back
// to the legacy `ai` handler (no SSE = no streaming).
//
// Wire shape:
//   const runId = await H.aiStream(messages, provider, system, opts);
//   H.onAiChunk(({ runId, delta }) => append delta to bubble)
//   H.onAiDone(({ runId, ok, error, fullText, usage, model }) => trackTokens etc)
//   H.aiAbort(runId);  // user clicks Stop
//
// Renderer is responsible for:
//   - allocating a placeholder <div> bubble before calling aiStream
//   - threading runId so multiple sends can interleave (rare but safe)
//   - calling H.aiAbort on send-button-as-stop click
//
// Parsing notes:
//   - Anthropic emits SSE blocks with `event: ...\ndata: {...}\n\n`. We only
//     act on `content_block_delta` (text body) and `message_delta` (usage).
//   - OpenAI emits `data: {choices:[{delta:{content:...}}]}\n\n` lines and
//     a final `data: [DONE]`. Usage is in the `usage` field of the LAST
//     non-DONE chunk when stream_options.include_usage is true.
const _activeStreams = new Map(); // runId → AbortController
let _streamSeq = 0;

function _streamRunId() {
  _streamSeq++;
  return 'stream_' + Date.now().toString(36) + '_' + _streamSeq;
}
function _broadcast(channel, payload) {
  try {
    const wins = require('electron').BrowserWindow.getAllWindows();
    for (const w of wins) {
      if (w && !w.isDestroyed() && w.webContents) {
        w.webContents.send(channel, payload);
      }
    }
  } catch (_) { /* best-effort */ }
}

// PHASE 28.5 — removed `_disabledLegacyAiStreamHandler` (was a 53-line
// dead-code function from an earlier refactor, never registered as an
// IPC handler). Active streaming lives in the `aiStream` handler near
// line 2253 and the non-streaming path in `runAiCompletion`. Both
// inject identity + persona + dialectic the same way.

// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ═══════════════════════════════════════════════════════════════════════════════
// HORIZON V12 — FULL AGENT CAPABILITIES
// ═══════════════════════════════════════════════════════════════════════════════

let agentTools = null;
let agentMemory = null;
let chatStore = null;
// Sprint 7C — durable Kanban queue. Initialised lazily by
// loadAgentModules() the first time the renderer / IPC asks for it.
let kanbanQueue = null;
let kanbanWorkers = [];
let kanbanReclaimTimer = null;
let agentLoop = null;
let mcpManager = null;
let computerUse = null;
let browserManager = null;
let pluginManager = null;
let skillsManager = null;
let googleAuth = null;
let personas = null;
let workflowEngine = null;
let screenRecorder = null;
let cronRunner = null;
let canvasManager = null;
let memoryReviewer = null;
let dialecticModel = null;
let githubConnector = null;
let mcpRegistry = null;
let connectionsManager = null;
let executor = null;
let skillSuggester = null;
const activeAgentRuns = new Map();
const pendingAgentSteps = new Map();
// ── SUBAGENT INFRASTRUCTURE ────────────────────────────────────────────────
// Subagents are isolated runAgentLoop invocations spawned by a parent via
// the spawn_subagent tool. Each gets its own runId, own message history,
// own steps, and its own controller, but reuses the parent's aiFn /
// sysInfo / persona for consistency. Depth is capped so a runaway tool
// chain can't blow the stack; concurrency caps avoid unbounded fan-out.
const MAX_SUBAGENT_DEPTH = 2;
const MAX_CONCURRENT_SUBAGENTS = 4;
const subagentDepthByRunId = new Map(); // runId -> depth (0 = root, 1+ = nested)
const activeSubagents = new Set();      // current in-flight child runIds

/**
 * Spawn an isolated child agent run. Invoked by agent.js' spawn_subagent
 * tool. Reuses the parent's runAiCompletion under the hood for provider/
 * key/model selection, so the subagent always matches the user's chosen
 * model without us duplicating that wiring.
 *
 * @param {object} opts
 * @param {string} opts.task        - concrete self-contained task
 * @param {string} [opts.parentRunId]
 * @param {object} [opts.event]     - parent's IPC event (for broadcastAgentStep)
 * @param {string[]} [opts.allowedTools] - whitelist subset; default = safe non-destructive
 * @param {number} [opts.maxSteps]  - cap on subagent steps (default 4)
 * @param {number} [opts.timeoutMs] - overall subagent timeout (default 60s)
 */
async function spawnSubagent(opts = {}) {
  loadAgentModules();
  if (!agentLoop || !agentTools) {
    return { ok: false, err: 'Agent runtime not loaded' };
  }
  const task = String(opts.task || '').trim();
  if (!task) return { ok: false, err: 'task is required' };

  const parentRunId = opts.parentRunId || 'root';
  const parentDepth = subagentDepthByRunId.get(parentRunId) || 0;
  if (parentDepth >= MAX_SUBAGENT_DEPTH) {
    return { ok: false, err: `subagent depth cap reached (${MAX_SUBAGENT_DEPTH})` };
  }
  if (activeSubagents.size >= MAX_CONCURRENT_SUBAGENTS) {
    return { ok: false, err: `too many concurrent subagents (${MAX_CONCURRENT_SUBAGENTS})` };
  }

  const childRunId = `${parentRunId}.sub-${Date.now().toString(36).slice(-4)}-${Math.floor(Math.random()*9000+1000)}`;
  const childDepth = parentDepth + 1;
  subagentDepthByRunId.set(childRunId, childDepth);
  activeSubagents.add(childRunId);

  const parentProvider = settingsStore.get('provider') || 'gemini';
  // ── Subagent model selection ─────────────────────────────────────────
  // Users can pick a different (usually cheaper / faster) model for
  // subagents than for the main agent. Common setup: Claude Opus 4.7 for
  // the parent, Gemini 2.5 Flash for subagents — slashes cost & latency
  // for parallel-friendly research tasks while keeping the main loop
  // smart. Falls back to the main provider/model when not configured,
  // so existing behaviour is preserved.
  const subProvider = settingsStore.get('subagentProvider') || parentProvider;
  const subModelOverride = settingsStore.get(`subagentModel.${subProvider}`) || '';
  const lang = settingsStore.get('lang') || 'en';
  const userName = settingsStore.get('userName') || 'User';
  const personaId = settingsStore.get('persona') || 'jarvis';

  // Subagent aiFn — thin wrapper around runAiCompletion (already handles
  // model selection, persona injection, key lookup for all 13 providers).
  // We force the configured subagent provider/model via opts.model, which
  // selectedModel() in main.js already honours as an explicit override.
  // No native tools — subagent uses JSON tool-call format which is more
  // portable across providers.
  const aiFn = async (messages, systemPrompt) => {
    try {
      const aiOpts = { source: 'subagent', subagent: true };
      if (subModelOverride) aiOpts.model = subModelOverride;
      const res = await runAiCompletion(null, messages || [], subProvider, systemPrompt || '', aiOpts);
      return { reply: res?.reply || '', model: res?.model, usage: res?.usage, error: res?.error };
    } catch (e) {
      return { error: e.message || 'subagent aiFn failed' };
    }
  };

  // sysInfo: lightweight — subagent doesn't need workspace/memory/connections
  // bloat. Just identity + clock keeps the prompt tight + cheaper.
  let sysInfo = {};
  try { sysInfo = await agentTools.getDetailedSysInfo(); } catch (_) {}
  sysInfo = sysInfo || {};
  // Drop expensive bits to keep subagent prompts lean.
  delete sysInfo.memory;
  delete sysInfo.github_repos;
  delete sysInfo.connections;

  // Tool filter: by default subagents only get NON-destructive tools.
  // Parent can override via opts.allowedTools to grant specific extras.
  const SAFE_TOOLS_DEFAULT = new Set([
    'read_file', 'list_dir', 'search_files',
    'get_system_info', 'get_running_apps', 'shell_command',
    'get_location', 'get_weather', 'web_search', 'wikipedia',
    'recall', 'get_facts',
  ]);
  const allowedTools = Array.isArray(opts.allowedTools) && opts.allowedTools.length
    ? new Set(opts.allowedTools)
    : SAFE_TOOLS_DEFAULT;
  const safeExtra = (agentTools.TOOL_DEFINITIONS || []).filter(t => allowedTools.has(t.name));

  // Step broadcaster — forwards subagent steps tagged with parent runId so
  // the inspector can group them under the parent run's panel.
  const broadcast = (step) => {
    try {
      if (opts.event?.sender) broadcastAgentStep(step, opts.event.sender);
    } catch (_) {}
  };

  const startStep = {
    type: 'subagent-spawned',
    runId: childRunId,
    parentRunId,
    depth: childDepth,
    task: task.slice(0, 200),
    startedAt: new Date().toISOString(),
  };
  broadcast(startStep);

  const onStep = (step) => {
    // Tag every subagent's step so the inspector can group/show them.
    broadcast({ ...step, runId: childRunId, parentRunId, isSubagent: true });
  };

  // Lightweight controller — subagents are non-cancellable from UI v1; the
  // overall timeout below is the only hard stop.
  const childController = {
    isStopped: () => false,
    isPaused: () => false,
    beforeTool: async () => ({ decision: 'allow' }),
    observe: () => {},
  };

  const maxSteps = Math.max(1, Math.min(8, opts.maxSteps || 4));
  const timeoutMs = Math.max(5000, Math.min(180000, opts.timeoutMs || 60000));

  let result;
  try {
    result = await Promise.race([
      agentLoop.runAgentLoop(task, {
        aiFn,
        sysInfo,
        lang,
        userName,
        history: [],
        maxSteps,
        onStep,
        runId: childRunId,
        control: childController,
        nativeTools: false,
        extraTools: safeExtra,
        personaId,
        // Subagents share the parent's dispatch with the runId context so
        // they can — in principle — spawn deeper subagents (depth cap will
        // refuse). Keep the context threaded.
        dispatchToolFn: (n, a) => agentTools.dispatchTool(n, a, { runId: childRunId, event: opts.event }),
        // Skip reflection epilogue — subagents are atomic and the parent
        // does its own reflection over the whole turn.
        reflect: false,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`subagent timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
  } catch (e) {
    result = { ok: false, error: e.message || 'subagent crashed', steps: [] };
  } finally {
    activeSubagents.delete(childRunId);
    subagentDepthByRunId.delete(childRunId);
    const endStep = {
      type: 'subagent-end',
      runId: childRunId,
      parentRunId,
      depth: childDepth,
      status: result?.ok ? 'done' : 'error',
      answer: (result?.answer || '').slice(0, 400),
      error: result?.error || null,
      stepsCount: Array.isArray(result?.steps) ? result.steps.length : 0,
      endedAt: new Date().toISOString(),
    };
    broadcast(endStep);
  }

  // Surface a compact result string to the parent agent's tool result.
  if (result?.ok && result.answer) {
    return {
      ok: true,
      out: `Subagent (${childRunId.split('.').pop()}) finished in ${result.steps?.length || 0} step(s):\n\n${result.answer}`,
      runId: childRunId,
      answer: result.answer,
      steps: result.steps?.length || 0,
    };
  }
  return {
    ok: false,
    err: result?.error || 'subagent failed without a final answer',
    runId: childRunId,
    steps: result?.steps?.length || 0,
  };
}
module.exports.spawnSubagent = spawnSubagent;
// Lazy accessor for agent.js' canvas_read / canvas_write tools.
// Returns null until main.js init has constructed CanvasManager.
module.exports.getCanvasManager = () => canvasManager;

function agentRunsPath() {
  return path.join(app.getPath('userData'), 'horizon-runs.jsonl');
}

function scrubRunValue(value, key = '') {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (/base64|image|data/i.test(key) && value.length > 120) return `[omitted ${value.length} chars]`;
    return value.length > 4000 ? `${value.slice(0, 4000)}\n...[truncated ${value.length - 4000} chars]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 80).map(v => scrubRunValue(v, key));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubRunValue(v, k);
    return out;
  }
  return value;
}

function appendAgentRun(record) {
  try {
    fs.mkdirSync(path.dirname(agentRunsPath()), { recursive: true });
    fs.appendFileSync(agentRunsPath(), `${JSON.stringify(scrubRunValue(record))}\n`, 'utf8');
  } catch (e) {
    console.warn('Could not persist agent run:', e.message);
  }
}

function readAgentRuns(limit = 50) {
  try {
    const raw = fs.readFileSync(agentRunsPath(), 'utf8').trim();
    if (!raw) return [];
    return raw.split(/\r?\n/).slice(-Math.max(1, Number(limit) || 50)).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).reverse();
  } catch (_) {
    return [];
  }
}

function compactAgentRun(record) {
  return {
    id: record.id,
    prompt: record.prompt,
    provider: record.provider,
    model: record.model,
    status: record.status,
    currentStepId: record.currentStepId || null,
    currentTool: record.steps?.find?.(s => s.id === record.currentStepId)?.tool || null,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    stepCount: record.steps?.length || 0,
    eventCount: record.events?.length || 0,
  };
}

function findActiveRun(id) {
  if (id && activeAgentRuns.has(id)) return activeAgentRuns.get(id);
  return [...activeAgentRuns.values()].at(-1) || null;
}

function getPermissionAllowlist() {
  const raw = settingsStore.get('permissionAllowlist', []);
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (raw && typeof raw === 'object') return Object.values(raw).filter(Boolean);
  return [];
}

function setPermissionAllowlist(entries) {
  settingsStore.set('permissionAllowlist', (entries || []).filter(Boolean).slice(-300));
}

function permissionContext() {
  return {
    workspace: String(settingsStore.get('codeWorkspace') || settingsStore.get('workspace') || '*'),
    persona: String(settingsStore.get('persona') || settingsStore.get('activePersona') || 'default'),
  };
}

function permissionEntryId(entry) {
  const stable = {
    workspace: entry.workspace || '*',
    persona: entry.persona || 'default',
    tool: entry.tool || '',
    operation: entry.operation || '',
    scope: entry.scope || '*',
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 24);
}

function addPermissionAllowlist(permission) {
  const now = new Date().toISOString();
  const entry = {
    id: permission.id,
    workspace: permission.workspace || '*',
    persona: permission.persona || 'default',
    tool: permission.tool || '',
    operation: permission.operation || '',
    scope: permission.scope || '*',
    title: permission.title || permission.tool || 'tool',
    createdAt: now,
  };
  entry.id = entry.id || permissionEntryId(entry);
  const entries = getPermissionAllowlist().filter(e => e.id !== entry.id);
  entries.push(entry);
  setPermissionAllowlist(entries);
  return entry;
}

function revokePermissionAllowlist(id) {
  const before = getPermissionAllowlist();
  const next = before.filter(e => e.id !== id);
  setPermissionAllowlist(next);
  return before.length !== next.length;
}

function looksSafeReadOnlyShell(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (/[;&|`>$]/.test(cmd)) return false;
  return /^(pwd|whoami|hostname|date|dir|ls(\s|$)|rg(\s|$)|findstr(\s|$)|type\s+|Get-ChildItem(\s|$)|Get-Content(\s|$)|Select-String(\s|$)|git\s+(status|diff|log|show|branch|rev-parse)(\s|$)|node\s+(-v|--version)|npm\s+(-v|--version)|pnpm\s+(-v|--version))/.test(cmd);
}

function permissionScopeFor(tool, args = {}) {
  const candidates = [
    args.path, args.file, args.filePath, args.relPath, args.target,
    args.url, args.href, args.repo, args.repository,
    args.command, args.cmd, args.query,
  ];
  const scope = candidates.find(v => typeof v === 'string' && v.trim());
  if (scope) return String(scope).slice(0, 240);
  if (args.code) return String(args.code).slice(0, 160);
  return String(tool || '*');
}

function classifyToolOperation(tool, args = {}) {
  const name = String(tool || '').toLowerCase();
  const base = name.includes('__') ? name.split('__').pop() : name;
  if (base.startsWith('conn_')) {
    if (/_(get|list|search|read|query|describe|status|find|context|today)_?/.test(base) || /_(get|list|search|read|query|describe|status|find|context|today)$/.test(base)) return 'read';
    if (/(create|post|send|update|delete|remove|write|patch)/.test(base)) return 'side_effect';
    return 'network';
  }
  if (base === 'shell_command') return looksSafeReadOnlyShell(args.command || args.cmd) ? 'read_shell' : 'shell';
  if (/^(read|get|list|search|find|query|describe|status|inspect|recall|wikipedia|weather|calendar_list|gmail_search|github_read)/.test(base)) return 'read';
  if (/(write|save|create|delete|remove|update|move|rename|patch|commit|push|exec|shell|run|launch|kill|type|press|click|mouse|scroll|open|browser|fetch|http|post|put|send|email|calendar|remember|set_|log_meal|clipboard|screenshot|capture)/.test(base)) return base.includes('fetch') || base.includes('http') ? 'network' : 'side_effect';
  if (name.includes('__')) return 'mcp_tool';
  return 'read';
}

function resolvePermissionToolName(tool) {
  const raw = String(tool || '');
  if (!raw || !pluginManager?.plugins) return raw;
  try {
    for (const [pluginId, manifest] of pluginManager.plugins) {
      const prefix = `plugin_${pluginId}_`;
      let toolName = null;
      if (raw.startsWith(prefix)) {
        toolName = raw.slice(prefix.length);
      } else if (raw.startsWith(`${pluginId}__`)) {
        toolName = raw.slice(`${pluginId}__`.length);
      }
      if (!toolName) continue;
      const spec = (manifest.tools || []).find(t => t && t.name === toolName);
      if (spec?.action) return `${pluginId}__${spec.action}`;
      return `${pluginId}__${toolName}`;
    }
  } catch (_) {}
  return raw;
}

function permissionRequiresApproval(operation) {
  return !['read', 'read_shell'].includes(operation);
}

function classifyAgentPermission(payload) {
  const args = payload?.args || {};
  const displayTool = String(payload?.tool || '');
  const tool = resolvePermissionToolName(displayTool);
  const operation = classifyToolOperation(tool, args);
  const required = permissionRequiresApproval(operation);
  const ctx = permissionContext();
  const scope = permissionScopeFor(tool, args);
  const basePermission = {
    required,
    allowed: !required,
    tool,
    operation,
    scope,
    workspace: ctx.workspace,
    persona: ctx.persona,
    risk: required ? 'side-effect' : 'read-only',
    title: `${displayTool || tool || 'tool'} approval`,
    description: required
      ? 'This tool can affect files, shell, network, browser, external services, or MCP state.'
      : 'Read-only tool allowed automatically.',
    detail: (() => {
      try { return JSON.stringify(args, null, 2).slice(0, 1600); }
      catch (_) { return String(args).slice(0, 1600); }
    })(),
  };
  basePermission.id = permissionEntryId(basePermission);
  if (!required) return basePermission;
  const match = getPermissionAllowlist().find(e => e.id === basePermission.id);
  if (match) {
    return { ...basePermission, allowed: true, allowlistId: match.id, description: 'Allowed by saved workspace/persona/tool approval.' };
  }
  return basePermission;
}

class AgentRunController {
  constructor(record) {
    this.record = record;
    this.paused = false;
    this.stopped = false;
    this.stepNext = false;
    this.pending = null;
  }

  isPaused() { return this.paused; }
  isStopped() { return this.stopped; }

  classifyTool(payload) {
    return classifyAgentPermission(payload);
  }

  observe(step) {
    this.record.events.push({ ...scrubRunValue(step), at: new Date().toISOString() });
    if (step?.type === 'waiting') {
      this.record.currentStepId = step.stepId;
      this.record.steps.push({
        id: step.stepId,
        index: step.step,
        tool: step.tool,
        args: scrubRunValue(step.args || {}),
        reason: step.reason || '',
        permission: scrubRunValue(step.permission || null),
        status: step.permission?.required && !step.permission?.allowed ? 'waiting_permission' : 'waiting',
        startedAt: new Date().toISOString(),
      });
    }
    const existing = step?.stepId ? this.record.steps.find(s => s.id === step.stepId) : null;
    if (existing) {
      if (step.type === 'executing') existing.status = 'executing';
      if (step.type === 'denied') existing.status = 'denied';
      if (step.type === 'stopped') existing.status = 'stopped';
      if (step.type === 'result') existing.status = step.result?.ok ? 'done' : 'error';
      if (step.result) {
        existing.result = scrubRunValue(step.result);
        existing.endedAt = new Date().toISOString();
      }
    }
  }

  pause() {
    this.paused = true;
    this.record.status = 'paused';
    return { ok: true, id: this.record.id, status: 'paused' };
  }

  resume() {
    this.paused = false;
    this.record.status = 'running';
    if (this.pending) {
      const permission = this.pending.permission;
      if (permission?.required && !permission?.allowed) {
        return { ok: false, id: this.record.id, status: 'waiting_permission', error: 'Step is waiting for permission approval' };
      }
      this.resolveStep(this.pending.stepId, { decision: 'allow', reason: 'operator resume' });
    }
    return { ok: true, id: this.record.id, status: 'running' };
  }

  step() {
    this.paused = true;
    if (this.pending) return this.resolveStep(this.pending.stepId, { decision: 'allow_once', reason: 'operator step' });
    this.stepNext = true;
    return { ok: true, id: this.record.id, status: 'step-armed' };
  }

  stop() {
    this.stopped = true;
    this.paused = false;
    this.record.status = 'stopped';
    if (this.pending) this.resolveStep(this.pending.stepId, { decision: 'stop', reason: 'operator stop' });
    return { ok: true, id: this.record.id, status: 'stopped' };
  }

  beforeTool(payload) {
    if (this.stopped) return { decision: 'stop', reason: 'operator stop' };
    const permission = payload.permission || this.classifyTool(payload);
    if (permission.required && !permission.allowed) {
      return this.waitForStep(payload, permission);
    }
    if (this.stepNext) {
      this.stepNext = false;
      return { decision: 'allow', reason: 'operator step' };
    }
    if (!this.paused) return { decision: 'allow' };
    return this.waitForStep(payload, permission);
  }

  waitForStep(payload, permission = null) {
    return new Promise(resolve => {
      this.pending = { stepId: payload.stepId, resolve, permission };
      pendingAgentSteps.set(payload.stepId, this);
    });
  }

  resolveStep(stepId, decision) {
    if (!this.pending || this.pending.stepId !== stepId) return { ok: false, error: 'Step is not waiting' };
    const normalized = typeof decision === 'string' ? { decision } : (decision || { decision: 'allow' });
    let next = normalized.decision === 'step' ? { decision: 'allow_once', reason: 'operator step' } : normalized;
    if (next.decision === 'always_allow') {
      if (this.pending.permission) addPermissionAllowlist(this.pending.permission);
      next = { ...next, decision: 'allow', reason: next.reason || 'permission always allow' };
    } else if (next.decision === 'allow_once') {
      next = { ...next, decision: 'allow', reason: next.reason || 'permission allow once' };
    }
    const resolve = this.pending.resolve;
    this.pending = null;
    pendingAgentSteps.delete(stepId);
    resolve(next);
    return { ok: true, id: this.record.id, stepId, decision: next.decision };
  }
}

function sendAgentStepTo(target, step) {
  try { target?.send?.('agentStep', step); } catch (_) {}
}

function broadcastAgentStep(step, sender = null) {
  sendAgentStepTo(sender, step);
  if (win && !win.isDestroyed() && win.webContents !== sender) {
    sendAgentStepTo(win.webContents, step);
  }
}

function normalizePermissionDecision(decision) {
  const raw = typeof decision === 'string' ? { decision } : (decision || {});
  const next = String(raw.decision || raw.action || 'deny').toLowerCase();
  if (next === 'allow' || next === 'approve' || next === 'allow_once') return { ...raw, decision: 'allow_once' };
  if (next === 'always' || next === 'always_allow') return { ...raw, decision: 'always_allow' };
  if (next === 'stop') return { ...raw, decision: 'stop' };
  return { ...raw, decision: 'deny' };
}

async function requestToolPermission(sender, tool, args = {}, reason = '') {
  const stepId = `perm-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const runId = `direct-${Date.now().toString(36)}`;
  const payload = {
    type: 'waiting',
    runId,
    stepId,
    step: 0,
    tool,
    args,
    reason,
    permission: classifyAgentPermission({ tool, args }),
  };

  broadcastAgentStep(payload, sender);
  if (!payload.permission?.required || payload.permission?.allowed) {
    broadcastAgentStep({ ...payload, type: 'executing' }, sender);
    return { ok: true, allowed: true, permission: payload.permission };
  }

  return new Promise(resolve => {
    const controller = {
      resolveStep(id, decision) {
        if (id !== stepId) return { ok: false, error: 'Step is not waiting' };
        const normalized = normalizePermissionDecision(decision);
        pendingAgentSteps.delete(stepId);
        if (normalized.decision === 'always_allow') {
          addPermissionAllowlist(payload.permission);
          broadcastAgentStep({ ...payload, type: 'executing', approved: 'always_allow' }, sender);
          resolve({ ok: true, allowed: true, decision: 'always_allow', permission: payload.permission });
          return { ok: true, stepId, decision: 'always_allow' };
        }
        if (normalized.decision === 'allow_once') {
          broadcastAgentStep({ ...payload, type: 'executing', approved: 'allow_once' }, sender);
          resolve({ ok: true, allowed: true, decision: 'allow_once', permission: payload.permission });
          return { ok: true, stepId, decision: 'allow_once' };
        }
        const stopped = normalized.decision === 'stop';
        const denied = {
          type: stopped ? 'stopped' : 'denied',
          runId,
          stepId,
          step: 0,
          tool,
          reason: normalized.reason || (stopped ? 'Stopped by user' : 'Denied by user'),
          permission: payload.permission,
          result: { ok: false, err: normalized.reason || (stopped ? 'Stopped by user' : 'Denied by user') },
        };
        broadcastAgentStep(denied, sender);
        resolve({ ok: false, denied: !stopped, stopped, decision: normalized.decision, error: denied.result.err, permission: payload.permission });
        return { ok: true, stepId, decision: normalized.decision };
      }
    };
    pendingAgentSteps.set(stepId, controller);
  });
}

async function withPermission(sender, tool, args, reason, fn) {
  const approval = await requestToolPermission(sender, tool, args, reason);
  if (!approval.ok) {
    return { ok: false, denied: true, error: approval.error || 'Denied by user', err: approval.error || 'Denied by user' };
  }
  if (approval.permission?.operation === 'shell') {
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  return fn();
}

function loadAgentModules() {
  if (!agentTools) {
    try {
      agentTools = require('./agent');
      // Sprint 7D — wire userData into the macro recorder so saved macros
      // live under <userData>/macros/. Done here (right after agent.js
      // loads) because ./tools/computer.js is side-effect required from
      // inside ./agent.js and its singleton needs the dir before any
      // macro_* tool fires.
      try {
        const computerTools = require('./tools/computer');
        if (typeof computerTools._setUserDataDir === 'function') {
          computerTools._setUserDataDir(app.getPath('userData'));
        }
      } catch (_) { /* tools layer always loads with agent */ }
      const { AgentMemory, ChatStore, setMemoryInstance } = agentTools;
      const memPath = path.join(app.getPath('userData'), 'horizon_memory.db');
      agentMemory = new AgentMemory(memPath);
      agentMemory.init();
      setMemoryInstance(agentMemory);

      // Semantic recall — wire an EmbeddingService that shares the existing
      // keysStore. Sidecar JSON lives next to horizon_memory.json. The
      // service is lazy: if there's no OpenAI/Gemini key the index stays
      // empty and recall transparently uses keyword scoring.
      try {
        const { EmbeddingService } = require('./embeddings');
        const embedSvc = new EmbeddingService({
          keysStore,
          settingsStore,
          memoryPath: memPath.replace(/\.db$/, '.json'),
        });
        agentMemory.setEmbeddingService(embedSvc);
        module.exports.agentMemory = agentMemory;
        // Kick off backfill in the background; don't block the renderer.
        // First-time runs with thousands of memories take ~30-60s on
        // OpenAI's small embedder, fully asynchronous so the UI stays
        // responsive. Subsequent runs are no-ops since the sidecar is
        // populated.
        if (embedSvc.isAvailable() && agentMemory._data?.memories?.length) {
          setTimeout(() => {
            agentMemory.embedAllPending(progress => {
              try {
                const wins = BrowserWindow.getAllWindows();
                for (const w of wins) {
                  if (w && !w.isDestroyed() && w.webContents) {
                    w.webContents.send('memory:embeddingProgress', progress);
                  }
                }
              } catch (_) {}
            }).then(r => console.log('✓ Embeddings backfill:', r))
              .catch(e => console.warn('Embeddings backfill failed:', e.message));
          }, 4000);
        }
      } catch (e) {
        console.warn('EmbeddingService unavailable:', e.message);
      }
      // Initialize ChatStore for multi-chat persistence
      if (!chatStore) {
        const chatPath = path.join(app.getPath('userData'), 'horizon_chats.db');
        chatStore = new ChatStore(chatPath);
        chatStore.init();
        console.log('✓ ChatStore loaded');
      }

      // Sprint 7B — SQLite is the PRIMARY memory store (was: JSON +
      // SQLite mirror). On first boot we auto-migrate JSON → SQLite and
      // archive the JSON file so the two never drift. After this point
      // every write goes through SQLite via AgentMemory.setMemoryDb();
      // the JSON sidecar becomes an export-only artefact. Opt back to
      // old hybrid behaviour with HORIZON_MEMORY_BACKEND=json.
      try {
        const jsonPath = memPath.replace(/\.db$/, '.json');
        const sqlitePath = path.join(app.getPath('userData'), 'memory.sqlite');
        const fs = require('fs');
        const memoryBackend = String(process.env.HORIZON_MEMORY_BACKEND || 'sqlite').toLowerCase();

        if (memoryBackend === 'json') {
          console.log('[memoryDb] HORIZON_MEMORY_BACKEND=json — staying on legacy JSON-primary backend');
        } else {
          // Auto-migration: JSON exists but no SQLite → import + archive.
          // Skip the archive when total === 0 (fresh boot — init() just
          // created an empty JSON file and we'd otherwise litter the
          // userData dir with empty .legacy.<ts> files on every cold start).
          if (fs.existsSync(jsonPath) && !fs.existsSync(sqlitePath)) {
            try {
              const { migrateJsonToSqlite } = require('./runtime/migrateJsonToSqlite');
              const r = migrateJsonToSqlite({ jsonPath, dbPath: sqlitePath, backup: false });
              if (r.ok) {
                const total = (r.added?.memories || 0) + (r.added?.facts || 0) + (r.added?.conversations || 0);
                if (total > 0) {
                  const ts = new Date().toISOString().replace(/[:.]/g, '-');
                  const legacyPath = `${jsonPath}.legacy.${ts}`;
                  try {
                    fs.renameSync(jsonPath, legacyPath);
                    console.log(`[migration] memory.json → memory.sqlite — ${total} entries migrated (archived to ${path.basename(legacyPath)})`);
                  } catch (e) {
                    console.log(`[migration] memory.json → memory.sqlite — ${total} entries migrated (archive failed: ${e.message})`);
                  }
                }
              } else {
                console.log('[migration] failed:', r.error);
              }
            } catch (e) {
              console.log('[migration] threw:', e.message);
            }
          }

          // Open the SQLite primary handle synchronously — the rest of the
          // app expects agentMemory.memoryDb to be wired before learnFromTurn
          // fires. (Was a setTimeout in PHASE 28.2 because mirror was async;
          // now there's no mirror step to wait for.)
          try {
            const { MemoryDb } = require('./memoryDb');
            const liveDb = new MemoryDb(sqlitePath).open();
            agentMemory.setMemoryDb(liveDb);
            const s = liveDb.stats();
            console.log(`✓ MemoryDb wired (SQLite primary @ ${path.basename(sqlitePath)} — ${s.memories} mem, ${s.facts} facts, ${s.conversations} conv)`);
          } catch (e) {
            console.log('[memoryDb] live wire-up skipped:', e.message);
          }
        }

        // PHASE 28.4 — Dialectic user model (Honcho-inspired). The 9th
        // memory layer: a diff log of what we've learned about the user
        // over time. Lives next to horizon_memory.json as a separate
        // JSON sidecar so users can inspect / edit it manually.
        try {
          const { DialecticModel } = require('./dialecticModel');
          const dialecticPath = path.join(app.getPath('userData'), 'horizon_dialectic.json');
          dialecticModel = new DialecticModel(dialecticPath).init();
          if (typeof agentMemory.setDialecticModel === 'function') {
            agentMemory.setDialecticModel(dialecticModel);
          } else {
            agentMemory.dialectic = dialecticModel;
          }
          // Wire the LLM-driven extractor: after every non-trivial turn,
          // ask a small LLM (current chat provider) for a structured
          // JSON of new diffs. Cost is ~150 input + ~80 output tokens
          // per turn, halved by sampling once the user has 20+ records.
          if (typeof agentMemory.setDialecticExtractor === 'function') {
            agentMemory.setDialecticExtractor(async (user, assistant, recent, ctx) => {
              return await _extractDialecticDiffs(user, assistant, recent, ctx);
            });
          }
          console.log('✓ DialecticModel loaded (' + dialecticModel.records.length + ' diff records, LLM extractor active)');
        } catch (e) {
          console.log('[dialectic] skipped:', e.message);
        }

        // PHASE 28.3 — agent-curated memory reviewer (Hermes-style
        // periodic nudges). Decays stale memories, merges near-
        // duplicates by embedding cosine, and forgets long-untouched
        // low-importance entries. Runs first pass ~1h after boot, then
        // every 12h.
        try {
          const { MemoryReviewer } = require('./memoryReviewer');
          memoryReviewer = new MemoryReviewer(agentMemory, {
            onChange: (stats) => {
              try {
                const wins = BrowserWindow.getAllWindows();
                for (const w of wins) {
                  if (w && !w.isDestroyed() && w.webContents) w.webContents.send('memory:reviewerPass', stats);
                }
              } catch (_) {}
            },
          });
          memoryReviewer.start();
          console.log('✓ MemoryReviewer scheduled (first pass in ~1h, then every 12h)');
        } catch (e) {
          console.log('[memoryReviewer] skipped:', e.message);
        }
      } catch (e) {
        console.log('[memoryDb] mirror setup skipped:', e.message);
      }

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
  if (!mcpRegistry) {
    try {
      const { MCPRegistry } = require('./mcp/mcpRegistry');
      mcpRegistry = new MCPRegistry(settingsStore);
      console.log('✓ MCP client registry loaded');
    } catch(e) {
      console.error('MCP client registry failed:', e.message);
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
      for (const tpl of PluginManager.getBuiltinTemplates()) {
        if (!pluginManager.plugins.has(tpl.id)) {
          try { pluginManager.install(tpl); } catch (_) {}
        }
      }
      // Auto-install every bundle under builtin-plugins/. Ships:
      //   • spotify-control (demo, needs Client ID)
      //   • system-monitor / web-fetch / clipboard / screenshot
      //     / crypto-pulse — built-in utilities, no credentials required
      // Idempotent: existing installs get manifest refreshed with the
      // latest app version's bundle, but user config + enabled state
      // are preserved.
      try {
        const r = pluginManager.installAllBuiltins();
        if (r && r.installed) {
          console.log('✓ Built-in plugins installed:', r.installed.join(', '));
          if (r.failed?.length) {
            console.warn('Built-in plugin failures:', r.failed);
          }
        }
      } catch (e) {
        console.error('installAllBuiltins failed:', e.message);
      }
      console.log('✓ Plugin manager loaded');
    } catch(e) {
      console.error('Plugin manager failed:', e.message);
    }
  }
  if (!executor) {
    try {
      const { Executor } = require('./executor');
      executor = new Executor({
        settingsStore,
        workspaceProvider: () => currentWorkspaceRoot(),
      });
      module.exports.executor = executor;
      console.log('✓ Executor loaded (mode:', executor.status().mode + ')');
    } catch (e) {
      console.error('Executor failed:', e.message);
    }
  }
  if (!skillSuggester) {
    try {
      const { SkillSuggester } = require('./skillSuggester');
      skillSuggester = new SkillSuggester({
        emit: (s) => {
          // Broadcast to ALL renderer windows — the banner UI listens
          // via H.onSkillSuggestion.
          try {
            const wins = BrowserWindow.getAllWindows();
            for (const w of wins) {
              if (w && !w.isDestroyed() && w.webContents) w.webContents.send('skill:suggestion', s);
            }
          } catch (_) {}
        },
      });
      module.exports.skillSuggester = skillSuggester;
    } catch (e) {
      console.error('SkillSuggester failed:', e.message);
    }
  }
  if (!skillsManager) {
    try {
      const { SkillsManager } = require('./skillsManager');
      skillsManager = new SkillsManager({
        userDir: path.join(app.getPath('userData'), 'skills'),
        builtinDir: path.join(__dirname, '..', '..', 'builtin-skills'),
        workspaceProvider: () => currentWorkspaceRoot(),
        settingsStore,
      });
      skillsManager.loadAll();
      module.exports.skillsManager = skillsManager;
      const builtinReport = skillsManager.installAllBuiltins();
      if (builtinReport.installed?.length) {
        console.log('✓ Built-in skills:', builtinReport.installed.join(', '));
      }
      console.log('✓ Skills manager loaded');
    } catch(e) {
      console.error('Skills manager failed:', e.message);
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
      // Wire up the user-overlay store so the editor can persist edits
      // to built-in personas + add custom personas. All overlays live on
      // settingsStore under the 'customPersonas' key.
      if (typeof personas.setOverlayStore === 'function') {
        personas.setOverlayStore(settingsStore);
      }
      console.log('✓ Personas loaded');
    } catch(e) {
      console.error('Personas failed:', e.message);
    }
  }
  if (!workflowEngine) {
    try {
      const { WorkflowEngine } = require('./workflowEngine');
      workflowEngine = new WorkflowEngine(settingsStore, pluginManager);
      // Bridge workflow run events to the renderer so the Workflows panel
      // can animate the active run's graph in real time. We forward to the
      // first available BrowserWindow — the panel only listens while open.
      workflowEngine.setEventBridge((channel, payload) => {
        try {
          const { BrowserWindow } = require('electron');
          const wins = BrowserWindow.getAllWindows();
          for (const w of wins) {
            if (w && !w.isDestroyed() && w.webContents) {
              w.webContents.send(channel, payload);
            }
          }
        } catch (_) { /* best-effort */ }
      });
      if (typeof workflowEngine.setPermissionHook === 'function') {
        workflowEngine.setPermissionHook(async ({ sender, tool, args, reason }) => {
          const target = sender || (win && !win.isDestroyed() ? win.webContents : null);
          return requestToolPermission(target, tool, args || {}, reason || 'Run workflow step');
        });
      }
      workflowEngine.startAll();
      console.log('✓ Workflow Engine loaded');
    } catch(e) {
      console.error('Workflow Engine failed:', e.message);
    }
  }

  // Phase 22 — Electron also runs the full crontab scheduler (the CLI
  // already had this via `horizon serve --enable-cron` / `horizon cron
  // daemon`, but desktop users couldn't use 5-field cron expressions —
  // only the simpler workflowEngine `schedule:HH:MM`). Wire CronRunner
  // up with a minimal runtime that delegates back to the Electron
  // agent loop.
  if (!cronRunner) {
    try {
      const { CronRunner } = require('./runtime/cron-runner');
      cronRunner = new CronRunner({
        settingsStore,
        runtime: {
          runChat: async (task) => {
            try {
              const messages = [{ role: 'user', content: task }];
              const res = await aiFn(messages, 'You are a scheduled task. Reply concisely.');
              return { ok: true, reply: res?.text || res?.reply || '' };
            } catch (e) { return { ok: false, error: e.message }; }
          },
          runAgent: async (task, opts = {}) => {
            try {
              const { runAgentLoop } = require('./agent');
              const result = await runAgentLoop({
                userMessage: task,
                history: [],
                aiFn,
                maxSteps: opts.maxSteps || 8,
                reflect: opts.reflect !== false,
                permissionAsk: opts.askPermission || (async () => true),
                source: 'cron',
              });
              return { ok: true, answer: result?.answer || '', steps: result?.steps || [] };
            } catch (e) { return { ok: false, error: e.message }; }
          },
        },
      });
      cronRunner.start();
      console.log('✓ Cron Runner started — scheduled tasks will fire on schedule');
    } catch (e) {
      console.error('Cron Runner failed:', e.message);
    }
  }

  // Phase 26 — Live Canvas. Shared editable surface between the user
  // and the agent. canvas_read / canvas_write tools live in agent.js
  // and dispatch through this manager. Renderer hooks via the
  // `canvas:get`/`canvas:set`/`canvas:write` IPCs registered below.
  if (!canvasManager) {
    try {
      const { CanvasManager } = require('./canvasManager');
      canvasManager = new CanvasManager(app.getPath('userData'));
      // Forward every change to every BrowserWindow so the renderer can
      // re-paint when the agent (or another window) writes.
      canvasManager.subscribe((snap) => {
        try {
          const { BrowserWindow } = require('electron');
          for (const w of BrowserWindow.getAllWindows()) {
            if (w && !w.isDestroyed() && w.webContents) {
              w.webContents.send('canvas:changed', snap);
            }
          }
        } catch (_) {}
      });
      console.log('✓ Live Canvas ready (' + (canvasManager.get().content.length) + ' chars on disk)');
    } catch (e) {
      console.error('Live Canvas init failed:', e.message);
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
  if (!githubConnector) {
    try {
      const { GitHubConnector } = require('./githubConnector');
      githubConnector = new GitHubConnector(path.join(app.getPath('userData'), 'github-repos.json'), keysStore);
      console.log('GitHub connector loaded');
    } catch(e) {
      console.error('GitHub connector failed:', e.message);
    }
  }
  if (!connectionsManager) {
    try {
      const { ConnectionsManager } = require('./connectionsManager');
      connectionsManager = new ConnectionsManager(keysStore, settingsStore);
      connectionsManager.setReplyFn(async ({ messages, system }) => {
        const provider = settingsStore.get('provider') || 'gemini';
        const res = await runAiCompletion(null, messages || [], provider, system || '', { source: 'telegram' });
        return {
          ...res,
          provider,
          text: res?.reply || res?.error || '',
        };
      });
      connectionsManager.setEventBridge((channel, payload) => {
        try {
          const wins = BrowserWindow.getAllWindows();
          for (const w of wins) {
            if (w && !w.isDestroyed() && w.webContents) w.webContents.send(channel, payload);
          }
        } catch (_) {}
      });
      connectionsManager.startEnabledRuntimes().catch(e => console.error('Connections runtime failed:', e.message));
      console.log('Connections manager loaded');
    } catch(e) {
      console.error('Connections manager failed:', e.message);
    }
  }

  // ── Sprint 7C — durable Kanban queue + workers ─────────────────────
  // Opt out via HORIZON_KANBAN=off. Default: one in-process worker;
  // HORIZON_WORKERS=N to scale up. The reclaim() timer sweeps stale
  // running rows every 30s — anything without a heartbeat for >60s
  // moves back to 'queued' so a fresh worker can grab it.
  if (!kanbanQueue && String(process.env.HORIZON_KANBAN || 'on').toLowerCase() !== 'off') {
    try {
      const { KanbanQueue } = require('./kanbanQueue');
      const { startWorker } = require('./kanbanWorker');
      const kanbanPath = path.join(app.getPath('userData'), 'kanban.sqlite');
      kanbanQueue = new KanbanQueue(kanbanPath).open();
      module.exports.kanbanQueue = kanbanQueue;

      // runAgent shim — workers need a runtime.runAgent(). In Electron
      // we don't have the headless runtime; defer to spawnSubagent which
      // already builds the right ai/tool stack. Result shape matches
      // runAgentLoop's {ok, answer, steps}.
      const workerRuntimeStub = {
        runAgent: async (task, opts) => {
          const r = await spawnSubagent({
            task,
            parentRunId: opts?.parentRunId || 'kanban',
            event: null,
            allowedTools: null,
            maxSteps: opts?.maxSteps,
            timeoutMs: opts?.timeoutMs,
          });
          if (r && r.ok === false) throw new Error(r.err || 'subagent failed');
          return r;
        },
      };

      const wantWorkers = Math.max(0, Math.min(8,
        Number(process.env.HORIZON_WORKERS) || 1
      ));
      for (let i = 0; i < wantWorkers; i++) {
        const w = startWorker({
          queue: kanbanQueue,
          runtime: workerRuntimeStub,
          log: (...a) => console.log(...a),
          noSignalHandler: i > 0,
          onEvent: (type, data) => {
            // Broadcast kanban events to every renderer for live board
            // updates. Tagged with a dedicated channel so the agents
            // tab can subscribe without touching the regular agent run
            // stream.
            try {
              const wins = BrowserWindow.getAllWindows();
              for (const win of wins) {
                if (win && !win.isDestroyed() && win.webContents) {
                  win.webContents.send('kanban:event', { type, ...data });
                }
              }
            } catch (_) {}
          },
        });
        kanbanWorkers.push(w);
      }

      if (!kanbanReclaimTimer) {
        kanbanReclaimTimer = setInterval(() => {
          try {
            const r = kanbanQueue.reclaim();
            if (r.reclaimed > 0) console.log(`[kanban] reclaim: ${r.reclaimed} stale task(s) re-queued`);
          } catch (e) { console.warn('[kanban] reclaim failed:', e.message); }
        }, 30_000);
        kanbanReclaimTimer.unref?.();
      }

      console.log(`Kanban queue ready @ ${path.basename(kanbanPath)} (${wantWorkers} worker${wantWorkers === 1 ? '' : 's'})`);
    } catch (e) {
      console.warn('Kanban queue unavailable:', e.message);
    }
  }
}

// ── AGENT LOOP: autonomous multi-step task execution ─────────────────────────
const GOOGLE_CONNECTION_TOOLS = [
  {
    name: 'conn_google_gmail_search',
    desc: '[Connection: Google Gmail] Search Gmail messages visible to the connected Google account.',
    params: { query: 'string Gmail search query', limit: 'number optional' },
    connectionId: 'google'
  },
  {
    name: 'conn_google_gmail_read',
    desc: '[Connection: Google Gmail] Read a Gmail message by message id.',
    params: { messageId: 'string' },
    connectionId: 'google'
  },
  {
    name: 'conn_google_gmail_send',
    desc: '[Connection: Google Gmail] Send an email through the connected Google account. Requires permission approval.',
    params: { to: 'string', subject: 'string', body: 'string', cc: 'string optional', bcc: 'string optional' },
    connectionId: 'google'
  },
  {
    name: 'conn_google_calendar_list',
    desc: '[Connection: Google Calendar] List upcoming calendar events.',
    params: { calendarId: 'string optional default primary', limit: 'number optional', timeMin: 'ISO date optional' },
    connectionId: 'google'
  },
  {
    name: 'conn_google_calendar_today',
    desc: '[Connection: Google Calendar] List today calendar events.',
    params: { calendarId: 'string optional default primary' },
    connectionId: 'google'
  },
  {
    name: 'conn_google_calendar_quick_add',
    desc: '[Connection: Google Calendar] Create an event from natural language. Requires permission approval.',
    params: { calendarId: 'string optional default primary', text: 'string' },
    connectionId: 'google'
  },
  {
    name: 'conn_google_calendar_create',
    desc: '[Connection: Google Calendar] Create a calendar event. Requires permission approval.',
    params: { calendarId: 'string optional default primary', summary: 'string', start: 'ISO date/time', end: 'ISO date/time', description: 'string optional', location: 'string optional', attendees: 'array optional' },
    connectionId: 'google'
  }
];

const GITHUB_CONNECTION_TOOLS = [
  { name: 'conn_github_list_repos', desc: '[Connection: GitHub] List repositories attached in Horizon settings.', params: {}, connectionId: 'github' },
  { name: 'conn_github_repo_context', desc: '[Connection: GitHub] Read attached repository metadata and README.', params: { repo: 'owner/repo optional; defaults to first attached repo' }, connectionId: 'github' },
  { name: 'conn_github_read_file', desc: '[Connection: GitHub] Read one file or directory listing from a GitHub repo.', params: { repo: 'owner/repo optional', path: 'string', ref: 'branch/sha optional' }, connectionId: 'github' },
  { name: 'conn_github_search_code', desc: '[Connection: GitHub] Search code in an attached GitHub repo.', params: { repo: 'owner/repo optional', query: 'string', limit: 'number optional' }, connectionId: 'github' },
  { name: 'conn_github_list_issues', desc: '[Connection: GitHub] List issues in an attached GitHub repo.', params: { repo: 'owner/repo optional', state: 'open|closed|all optional', limit: 'number optional' }, connectionId: 'github' },
  { name: 'conn_github_create_issue', desc: '[Connection: GitHub] Create an issue in a GitHub repo. Requires permission approval.', params: { repo: 'owner/repo optional', title: 'string', body: 'string optional' }, connectionId: 'github' }
];

async function ensureGoogleWorkspaceTools() {
  if (!googleAuth || !mcpManager || !googleAuth.isAuthenticated?.()) {
    return { ok: false, error: 'Google Workspace is not connected.' };
  }
  const result = await googleAuth.getAccessToken();
  if (!result?.ok || !result.token) return { ok: false, error: result?.error || 'Google access token unavailable.' };
  mcpManager.setGmailToken(result.token);
  mcpManager.setCalendarToken(result.token);
  return { ok: true };
}

function googleConnectionToolsForAgent() {
  try {
    if (googleAuth?.isAuthenticated?.()) return GOOGLE_CONNECTION_TOOLS;
  } catch (_) {}
  return [];
}

function githubConnectionToolsForAgent() {
  try {
    if (!githubConnector) return [];
    const repos = githubConnector.listRepos?.() || [];
    return repos.length ? GITHUB_CONNECTION_TOOLS : [GITHUB_CONNECTION_TOOLS[0]];
  } catch (_) {
    return [];
  }
}

async function dispatchGoogleConnectionTool(tool, args = {}) {
  const ready = await ensureGoogleWorkspaceTools();
  if (!ready.ok) return { ok: false, err: ready.error, error: ready.error };
  const calendarId = args.calendarId || args.calendar || 'primary';
  switch (tool) {
    case 'conn_google_gmail_search':
      return mcpManager.searchEmails(args.query || '', args.limit || args.maxResults || 10);
    case 'conn_google_gmail_read':
      return mcpManager.readEmail(args.messageId || args.id);
    case 'conn_google_gmail_send':
      return mcpManager.sendEmail(args.to, args.subject || '', args.body || '', args.cc || '', args.bcc || '');
    case 'conn_google_calendar_list':
      return mcpManager.listEvents(calendarId, args.limit || args.maxResults || 10, args.timeMin || null);
    case 'conn_google_calendar_today':
      return mcpManager.getTodayEvents(calendarId);
    case 'conn_google_calendar_quick_add':
      return mcpManager.quickAddEvent(calendarId, args.text || args.query || '');
    case 'conn_google_calendar_create':
      return mcpManager.createEvent(
        calendarId,
        args.summary || args.title || '',
        args.start || args.startTime,
        args.end || args.endTime,
        args.description || '',
        args.location || '',
        Array.isArray(args.attendees) ? args.attendees : []
      );
    default:
      return { ok: false, err: `Unknown Google connection tool: ${tool}` };
  }
}

async function dispatchGithubConnectionTool(tool, args = {}) {
  if (!githubConnector) return { ok: false, err: 'GitHub connector not loaded.' };
  try {
    switch (tool) {
      case 'conn_github_list_repos': {
        const repos = githubConnector.listRepos();
        return { ok: true, repos, out: JSON.stringify(repos, null, 2) };
      }
      case 'conn_github_repo_context': {
        const data = await githubConnector.repoContext(args.repo || args.repository || args.fullName || '');
        return { ok: true, ...data, out: JSON.stringify(data, null, 2).slice(0, 30000) };
      }
      case 'conn_github_read_file': {
        const data = await githubConnector.readFile(args.repo || args.repository || '', args.path || args.file || '', args.ref || '');
        return { ok: true, ...data, out: data.content || JSON.stringify(data, null, 2).slice(0, 30000) };
      }
      case 'conn_github_search_code': {
        const data = await githubConnector.searchCode(args.repo || args.repository || '', args.query || '', args.limit || 10);
        return { ok: true, ...data, out: JSON.stringify(data, null, 2).slice(0, 30000) };
      }
      case 'conn_github_list_issues': {
        const data = await githubConnector.listIssues(args.repo || args.repository || '', args.state || 'open', args.limit || 20);
        return { ok: true, ...data, out: JSON.stringify(data, null, 2).slice(0, 30000) };
      }
      case 'conn_github_create_issue': {
        const data = await githubConnector.createIssue(args.repo || args.repository || '', args.title || '', args.body || '');
        return { ok: true, ...data, out: JSON.stringify(data, null, 2).slice(0, 30000) };
      }
      default:
        return { ok: false, err: `Unknown GitHub connection tool: ${tool}` };
    }
  } catch (e) {
    return { ok: false, err: e.message, error: e.message };
  }
}

// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// PR-Plan-Act — registry of runs that have an outstanding plan-pending
// gate, plus a per-session set of runs the user has Approved-All-Plans
// on. Runs in the latter skip the gate for subsequent executing steps.
const _planActPending = new Map(); // runId → { resolve, reject, broadcastedAt }
const _planActApprovedRuns = new Set();

// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── DIRECT TOOL CALLS (from chat toolbar/quick actions) ──────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── MEMORY ────────────────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── Live Canvas (Phase 26 MVP) ─────────────────────────────────────────
// Renderer → main: read current canvas state.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Renderer → main: user-driven write (debounced from the textarea).
// Source is forced to `user` regardless of what the renderer sent, so
// a malicious skin can't pretend an edit came from the agent.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Renderer → main: append (used by quick-action buttons).
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Embedding index status + manual reindex trigger. Used by the Learned tab
// to show "X/Y indexed" and the optional "Reindex now" button.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)


// PHASE 28.3 — manual trigger for the memory reviewer (Inspector
// "Review now" button) + status read-back.
// PHASE 28.4 — Dialectic user model (Honcho-inspired diff log).
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Single-shot snapshot for the inspector's Learned tab — facts + most-recent
// memories + learning.stats + user profile in one IPC roundtrip. Cheap
// because everything lives in-memory in AgentMemory._data.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── Memory edit/forget + user profile IPC ───────────────────────────────
// Used by the Inspector → Learned tab edit/delete UI. Each handler returns
// {ok, ...} so the renderer can show success/failure inline.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// PHASE 6/8 — Full-text search across memories + facts + conversations.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// PHASE 8/8 — Workspace memory (committable .horizon/memory.json).
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Executor status — used by Settings UI to show "Docker available · Y" /
// "Docker not installed · falling back to host". Read-only, no PRO gate.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── NUTRITION TRACKING (from jarvis) ─────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── CONVERSATION MEMORY ─────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── Mobile companion: one-click pairing ────────────────────────────────────
// The "Connect phone" button in Settings spawns `bin/horizon-serve.js` as a
// child process on a fixed local port (18789) and generates a QR-code
// data-URL of the pairing URL. The renderer drops the QR on screen — the
// user scans it with their phone camera and lands on the mobile PWA with
// the bearer token auto-prefilled in the query string.
//
// The serve binary already handles token auth + PWA hosting; we just glue
// the lifecycle to the desktop app so non-technical users never see a
// terminal. On `app.before-quit` we kill the child so it doesn't outlive
// the desktop window.
const HORIZON_MOBILE_PORT = 18789;
let mobileServerProc = null;
let mobileServerState = { running: false, url: null, qrDataUrl: null, token: null, since: 0 };

function _mobilePickLocalIp() {
  try {
    const ifaces = os.networkInterfaces();
    const candidates = [];
    for (const list of Object.values(ifaces || {})) {
      for (const it of list || []) {
        if (!it || it.internal) continue;
        if (it.family !== 'IPv4' && it.family !== 4) continue;
        candidates.push(it.address);
      }
    }
    // Prefer 192.168.*, then 10.*, then 172.16-31.*, then anything else.
    const score = (ip) => {
      if (/^192\.168\./.test(ip)) return 3;
      if (/^10\./.test(ip)) return 2;
      if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 1;
      return 0;
    };
    candidates.sort((a, b) => score(b) - score(a));
    return candidates[0] || 'localhost';
  } catch (_) {
    return 'localhost';
  }
}

async function _mobileBuildQrDataUrl(url) {
  try {
    const QRCode = require('qrcode');
    return await QRCode.toDataURL(String(url), {
      width: 200,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    });
  } catch (e) {
    console.error('[mobile] qr generation failed:', e.message);
    return null;
  }
}

function _mobileKillServer() {
  const proc = mobileServerProc;
  mobileServerProc = null;
  mobileServerState = { running: false, url: null, qrDataUrl: null, token: null, since: 0 };
  if (!proc) return;
  try {
    if (process.platform === 'win32') {
      // SIGTERM doesn't reliably propagate to detached node.exe on Windows
      // — fall back to taskkill /T to bring down the whole tree.
      try { exec(`taskkill /pid ${proc.pid} /T /F`, () => {}); } catch (_) {}
    } else {
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 2000).unref?.();
    }
  } catch (_) { /* already gone */ }
}

// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// PHASE 28.3 — Email runtime adapter lifecycle. Lives outside
// connectionsManager because the EmailAdapter has its own start/stop
// loop and emits 'incoming' events we wire into the agent loop.
let emailAdapter = null;
function _emailStatus() {
  if (!emailAdapter) return { connected: false, running: false, enabled: !!settingsStore.get('email.enabled') };
  return { connected: true, ...emailAdapter.status() };
}
async function _emailSetLive(enabled) {
  try {
    settingsStore.set('email.enabled', !!enabled);
    if (enabled) {
      if (!emailAdapter) {
        const { EmailAdapter } = require('./channelAdapters/email');
        emailAdapter = new EmailAdapter({ settingsStore, keysStore });
        emailAdapter.on('incoming', (msg) => {
          try {
            const wins = BrowserWindow.getAllWindows();
            for (const w of wins) {
              if (w && !w.isDestroyed() && w.webContents) w.webContents.send('email:incoming', msg);
            }
          } catch (_) {}
          // Hand the message to the agent loop. Reply is sent back via
          // a follow-up email_send tool call if the agent decides to.
          try {
            loadAgentModules();
            const fakeMsg = { role: 'user', content: `From: ${msg.from}\nSubject: ${msg.subject}\n\n${msg.text}` };
            // Fire-and-forget — no await; mail is async by nature.
            if (typeof connectionsManager?.replyFn === 'function') {
              connectionsManager.replyFn({ messages: [fakeMsg], source: 'email', chatId: msg.messageId }).catch(() => {});
            }
          } catch (e) { console.warn('[email] inbound → agent dispatch failed:', e.message); }
        });
      }
      const r = await emailAdapter.start();
      return r;
    } else {
      if (emailAdapter) { await emailAdapter.stop(); }
      return { ok: true, running: false };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Outbound `email_send` tool — let the agent send mail.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── Discord chat viewer ─────────────────────────────────────────────────
// Mirrors the Telegram tg* IPC. discord runtime stores per-channel history
// in settingsStore (same locality as keys). These handlers expose it +
// outbound send.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── TELEGRAM CHAT VIEWER ─────────────────────────────────────────────────
// Lets the desktop UI show the same chats the bot is having on Telegram.
// History is persisted per-chat in settingsStore (see connectionsManager
// TG_HISTORY_CAP); these handlers expose it + outbound send.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── CHAT MANAGEMENT ──────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── CODE EXECUTION ────────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── DETAILED SYSTEM INFO ──────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── SHOW WINDOW (for wake word) ───────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── MCP: LOCATION & WEATHER ──────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── MCP: WEB SEARCH ──────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── MCP: GMAIL ───────────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── MCP: CALENDAR ────────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── COMPUTER USE: Smart click by description ─────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── COMPUTER USE: Find UI Elements ───────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── BROWSER AUTOMATION ───────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── PERSONAS ─────────────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Full persona shape (with prompts, memories, allowed tools) — used by
// the Personas editor in the renderer.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Upsert overlay (built-in edit OR new custom persona). Patch is partial.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Delete overlay (resets built-in OR removes custom).
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── PLUGIN MANAGER v2 ────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── SKILLS (Claude Code-style markdown skills) ───────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Forwarded to agent.js dispatchTool — gated by withPermission so the standard
// approval UX fires before any helper script runs.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Legacy — fake templates removed; real plugins come from the marketplace backend.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── WORKFLOW ENGINE ───────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)


// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Snapshot of currently-running workflows for the premium Workflows panel
// (animated graph view of the live run). Renderer also listens for the
// workflow:running:start / step / end events emitted by the engine bridge.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── SCREEN RECORDER + AI NARRATOR ────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── MARKETPLACE ───────────────────────────────────────────────────────────────
// Legacy template-based marketplace is gone. The real one is `marketRemoteList`
// (FastAPI backend) — see further down. These stubs remain so old UI code that
// still calls them gets an empty list instead of 4 fake "plugins".
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// ── GOOGLE OAUTH ─────────────────────────────────────────────────────────────
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

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

// Local license guard — server polling runs once per hour, but trial
// expiration is purely date-based and should kick in within seconds of
// the trial day flipping over. Re-evaluate every 60 s and on every
// window focus, redirecting to progate.html if access dropped.
function _licenseTickRedirect() {
  if (!win || win.isDestroyed()) return;
  try {
    const state = licenseManager.evaluate();
    if (!state.allowed) {
      const cur = win.webContents.getURL();
      if (!cur.includes('/progate.html')) {
        win.loadURL(`http://127.0.0.1:${port}/progate.html`);
      }
    }
  } catch (_) {}
}
setInterval(_licenseTickRedirect, 60 * 1000);
app.on('browser-window-focus', _licenseTickRedirect);

// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// PHASE 28.5 — owner contact links pulled from env so corporate forks
// or hand-offs to a future maintainer don't require a code edit. The
// defaults stay the project owner so a fresh checkout works out of
// the box.
const OWNER_EMAIL_PRIMARY   = String(process.env.HORIZON_OWNER_EMAIL   || 'ernest2011kostevich@gmail.com');
const OWNER_EMAIL_SECONDARY = String(process.env.HORIZON_OWNER_EMAIL_2 || 'ernestkostevich@gmail.com');
const OWNER_TG_PRIMARY      = String(process.env.HORIZON_OWNER_TG     || 'Ernest_Kostevich');
const OWNER_TG_SECONDARY    = String(process.env.HORIZON_OWNER_TG_2   || 'ernest0kostevich');

// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// PHASE 28.5 — expose contacts so the renderer (progate.html etc.) can
// render the live values instead of baking them into HTML.
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Wipe the license cache when the user logs out of the marketplace account,
// so the next login forces a fresh server check.
const _origLogout = marketClient.logout.bind(marketClient);
marketClient.logout = function patchedLogout() {
  _origLogout();
  licenseManager.clearCache();
};

// ── Register every IPC handler module ────────────────────────────────────────
// Each ipc/*.js file owns a slice of the surface. Helpers, state vars, and
// the runtime closures live in this file so getters can fetch the current
// (possibly lazy-initialized) references at call time.
require('./ipc').registerAll({
  // Electron + Node modules
  ipcMain, app,
  BrowserWindow, Notification, clipboard, shell, dialog,
  desktopCapturer, screen,
  crypto, os, fs, path,
  spawn, exec,
  // platform flags
  IS_WIN, IS_MAC,
  // Stores
  keysStore, settingsStore,
  // Allow-listers
  assertAllowedKey, assertAllowedSetting,
  // Model selection / response shaping
  selectedModel, applyReasoningProfile, localOpenAIEndpoint,
  firstTextFromAnthropic,
  resolveSkillsForMessages, appendSkillsToSystemPrompt,
  readSseStream, extractStreamPayload,
  nativeToolPack, toAnthropicMessages, toAnthropicTools,
  toOpenAIChatMessages, toOpenAITools,
  parseAnthropicToolCalls, parseOpenAIToolCalls, mapNativeToolCalls,
  // Helpers
  runShell, withPermission,
  WEB_APPS, APP_WIN_MAP, APP_MAC_MAP,
  resolveAppName, smartOpenUrl,
  currentWorkspaceRoot, resolveWorkspacePath, safeDirEntries, searchWorkspaceFiles,
  getProjectConfig: _getProjectConfig,
  getWsIndexer: _getWsIndexer,
  getWorkspaceMemory: _getWorkspaceMemory,
  terminalSessions, createPtyTerminal, createPipeTerminal,
  // AI helpers
  runAiCompletion,
  activeStreams: _activeStreams,
  streamRunId: _streamRunId,
  broadcast: _broadcast,
  // Window getters / lifecycle hooks
  getWin: () => win,
  setQuitting: (v) => { isQuitting = v; },
  createWindow,
  getPort: () => port,
  openExternalReliable,
  getMarketplaceWebBase,
  // Lazy module getters
  loadAgentModules,
  getAgentTools: () => agentTools,
  getAgentMemory: () => agentMemory,
  getAgentLoop: () => agentLoop,
  getChatStore: () => chatStore,
  getMcpManager: () => mcpManager,
  getMcpRegistry: () => mcpRegistry,
  getComputerUse: () => computerUse,
  getBrowserManager: () => browserManager,
  getPluginManager: () => pluginManager,
  getSkillsManager: () => skillsManager,
  getGoogleAuth: () => googleAuth,
  getPersonas: () => personas,
  getWorkflowEngine: () => workflowEngine,
  getScreenRecorder: () => screenRecorder,
  getCanvasManager: () => canvasManager,
  // Sprint 7C — Kanban queue handle for ipc/agents.js
  getKanbanQueue: () => kanbanQueue,
  getMemoryReviewer: () => memoryReviewer,
  getDialecticModel: () => dialecticModel,
  getGithubConnector: () => githubConnector,
  getConnectionsManager: () => connectionsManager,
  getExecutor: () => executor,
  getSkillSuggester: () => skillSuggester,
  // Agent-run plumbing
  activeAgentRuns, pendingAgentSteps, subagentDepthByRunId,
  planActPending: _planActPending,
  planActApprovedRuns: _planActApprovedRuns,
  AgentRunController,
  findActiveRun,
  getPermissionAllowlist, revokePermissionAllowlist,
  readAgentRuns, compactAgentRun, scrubRunValue, appendAgentRun,
  broadcastAgentStep,
  ensureGoogleWorkspaceTools,
  googleConnectionToolsForAgent, githubConnectionToolsForAgent,
  dispatchGoogleConnectionTool, dispatchGithubConnectionTool,
  // Email runtime
  emailSetLive: _emailSetLive,
  emailStatus: _emailStatus,
  getEmailAdapter: () => emailAdapter,
  setEmailAdapter: (v) => { emailAdapter = v; },
  // Mobile pairing
  HORIZON_MOBILE_PORT,
  getMobileServerProc: () => mobileServerProc,
  setMobileServerProc: (v) => { mobileServerProc = v; },
  getMobileServerState: () => mobileServerState,
  setMobileServerState: (v) => { mobileServerState = v; },
  mobilePickLocalIp: _mobilePickLocalIp,
  mobileBuildQrDataUrl: _mobileBuildQrDataUrl,
  mobileKillServer: _mobileKillServer,
  // Marketplace + license
  marketClient, licenseManager,
  OWNER_EMAIL_PRIMARY, OWNER_EMAIL_SECONDARY,
  OWNER_TG_PRIMARY, OWNER_TG_SECONDARY,
});

// Install a published workflow from the marketplace into the local engine.
// Marketplace stores workflows in the same `plugins` collection with
// `type: 'workflow'`. The bundle's `handler` field carries a JSON-encoded
// workflow definition `{ trigger, steps }`. We tolerate two shapes:
//   1. Modern: handler is a JSON string with {trigger, steps, name?}
//   2. Legacy: handler is empty, steps live inside manifest.tools (each
//      tool acts as a step with action / args)
// Either way we end up calling workflowEngine.create(name, trigger, steps).
// (ipcMain handlers moved to src/main/ipc/*.js — see ipc/index.js)

// Register horizon:// protocol so the marketplace website can install
// plugins with one click (horizon://plugin/install?data=<base64>).
if (!app.isDefaultProtocolClient('horizon')) {
  try { app.setAsDefaultProtocolClient('horizon'); } catch (_) {}
}

async function handleHorizonUrl(url) {
  try {
    if (!url || !url.startsWith('horizon://')) return;
    if (url.startsWith('horizon://auth/desktop')) {
      const parsed = new URL(url);
      const token = parsed.searchParams.get('token');
      const api = parsed.searchParams.get('api');
      if (!token) throw new Error('Missing desktop auth token');
      if (api) settingsStore.set('marketplaceUrl', api.replace(/\/+$/, ''));
      const d = await marketClient.exchangeDesktopToken(token);
      licenseManager.clearCache();
      await licenseManager.refresh();
      new Notification({ title: 'Horizon', body: `Signed in as ${d.user?.email || d.user?.display_name || 'your account'}` }).show();
      if (win) {
        win.show();
        win.focus();
        win.webContents.send('market-authenticated', d.user);
      }
      return;
    }
    if (!url.startsWith('horizon://plugin/install')) return;
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
  if (marketClient.token) {
    try {
      await Promise.race([
        licenseManager.refresh(),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    } catch (_) {}
  }
  const state = licenseManager.evaluate();
  const initialPage = state.allowed
    ? (onboarded ? 'chat' : 'setup')
    : 'progate';
  createWindow(initialPage);

  // Kick off background license polling (server-side truth) — safe to fire
  // and forget, listeners will handle state transitions.
  licenseManager.startPolling();
});

app.on('before-quit', () => {
  isQuitting = true;
  // Gracefully bring down the mobile companion serve process so it doesn't
  // outlive the desktop window and squat on port 18789.
  try { _mobileKillServer(); } catch (_) {}
});
app.on('window-all-closed', () => {}); // tray keeps alive
app.on('activate', () => { win?.show(); });
