'use strict';

// IPC handlers — system / window / clipboard / misc.
// Channels: minimize, hide, quit, go, copy, paste, getClipboard, openUrl,
// notify, sysInfo, getPort, settingsDiagnostics, openSettingsFolder,
// openrouterListModels, localProviderStatus, getDetailedSysInfo,
// getRunningApps, showWindow, executeCode.

function register(deps) {
  const {
    ipcMain, app, clipboard, Notification, BrowserWindow, shell,
    os, path,
    win, // getter via deps.getWin if needed; here win is the reference setter helper
    getWin,
    isQuitting,
    setQuitting,
    createWindow,
    settingsStore,
    openExternalReliable,
    localOpenAIEndpoint,
    getPort,
    IS_WIN, IS_MAC,
    loadAgentModules,
    getAgentTools,
    withPermission,
  } = deps;

  ipcMain.on('minimize', () => { const w = getWin(); w?.minimize(); });
  ipcMain.on('hide',     () => { const w = getWin(); w?.hide(); });
  ipcMain.on('quit',     () => { setQuitting(true); app.quit(); });
  ipcMain.on('toggle-maximize', () => {
    const w = getWin();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else                 w.maximize();
  });
  ipcMain.handle('go',   (_, p) => { createWindow(p); return true; });

  ipcMain.handle('getPort',   ()        => getPort());
  ipcMain.handle('settingsDiagnostics', () => {
    const userDataPath = app.getPath('userData');
    return {
      ok: true,
      version: app.getVersion(),
      userDataPath,
      settingsPath: settingsStore.path || path.join(userDataPath, 'horizon-settings.json'),
      hasMarketplaceToken: !!settingsStore.get('marketplaceToken'),
      marketplaceUser: settingsStore.get('marketplaceUser') || null,
      saved: {
        userName: settingsStore.get('userName') || null,
        lang: settingsStore.get('lang') || null,
        provider: settingsStore.get('provider') || null,
        mode: settingsStore.get('mode') || null,
        voiceProvider: settingsStore.get('voiceProvider') || null,
        ttsProvider: settingsStore.get('ttsProvider') || null,
        wakeOn: !!settingsStore.get('wakeOn'),
        searchOn: !!settingsStore.get('searchOn'),
        screenWatcher: !!settingsStore.get('screenWatcher'),
        ambientOn: !!settingsStore.get('ambientOn'),
        notificationsOn: !!settingsStore.get('notificationsOn'),
        persona: settingsStore.get('persona') || null,
        ollamaUrl: settingsStore.get('ollamaUrl') || null,
        ollamaModel: settingsStore.get('ollamaModel') || null,
        lmStudioUrl: settingsStore.get('lmStudioUrl') || null,
        lmStudioModel: settingsStore.get('lmStudioModel') || null,
        settingsHealthCheckAt: settingsStore.get('settingsHealthCheckAt') || null,
      },
    };
  });
  ipcMain.handle('openSettingsFolder', async () => {
    const userDataPath = app.getPath('userData');
    const error = await shell.openPath(userDataPath);
    return error ? { ok: false, path: userDataPath, error } : { ok: true, path: userDataPath };
  });
  // Pull the OpenRouter model catalog (200+ entries). Public endpoint — no key
  // required to list. Returns {ok, models:[{id,name,context_length}]}.
  ipcMain.handle('openrouterListModels', async () => {
    try {
      const fetch = require('node-fetch');
      const r = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'HTTP-Referer': 'https://horizonaai.dev', 'X-Title': 'Horizon Genesis' },
        timeout: 8000,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: data.error?.message || `HTTP ${r.status}` };
      const models = Array.isArray(data.data)
        ? data.data.map((m) => ({ id: m.id, name: m.name || m.id, context_length: m.context_length })).filter((m) => m.id)
        : [];
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('localProviderStatus', async (_, provider) => {
    const ep = localOpenAIEndpoint(provider);
    if (!ep) return { ok: false, error: 'Unknown local provider' };
    const modelsUrl = ep.url.replace(/\/chat\/completions$/, '/models');
    const installUrl = provider === 'ollama' ? 'https://ollama.com' : provider === 'lmstudio' ? 'https://lmstudio.ai' : '';
    try {
      const fetch = require('node-fetch');
      const headers = {};
      if (ep.key) headers.Authorization = `Bearer ${ep.key}`;
      const r = await fetch(modelsUrl, { headers, timeout: 2500 });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, installed: true, status: r.status, error: data.error?.message || data.error || `HTTP ${r.status}`, installUrl };
      const models = Array.isArray(data.data) ? data.data.map((m) => m.id || m.name).filter(Boolean) : [];
      return { ok: true, installed: true, provider, url: modelsUrl, models };
    } catch (e) {
      return {
        ok: false,
        installed: false,
        provider,
        url: modelsUrl,
        installUrl,
        error: provider === 'ollama'
          ? 'Ollama is not reachable. Install Ollama, run a model, then test again.'
          : 'LM Studio server is not reachable. Install LM Studio, start the local server, then test again.',
        detail: e.message,
      };
    }
  });

  // ── IPC: Misc ─────────────────────────────────────────────────────────────────
  ipcMain.handle('copy',         (_, t) => { clipboard.writeText(t); return true; });
  ipcMain.handle('paste',        ()     => clipboard.readText());
  ipcMain.handle('getClipboard', ()     => ({ text: clipboard.readText() }));
  ipcMain.handle('openUrl',      async (_, u) => openExternalReliable(u, 'Horizon Link'));
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

  // ── CODE EXECUTION ────────────────────────────────────────────────────────────
  ipcMain.handle('executeCode', async (event, code, language) => {
    loadAgentModules();
    const agentTools = getAgentTools();
    if (!agentTools) return { ok: false, err: 'Agent not loaded' };
    return withPermission(
      event.sender,
      'shell_command',
      { command: String(code || '').slice(0, 1200), language: language || 'python' },
      'Execute code',
      () => agentTools.executeCode(code, language || 'python')
    );
  });

  // ── DETAILED SYSTEM INFO ──────────────────────────────────────────────────────
  ipcMain.handle('getDetailedSysInfo', async () => {
    loadAgentModules();
    const agentTools = getAgentTools();
    if (!agentTools) return {};
    return agentTools.getDetailedSysInfo();
  });

  ipcMain.handle('getRunningApps', async () => {
    loadAgentModules();
    const agentTools = getAgentTools();
    if (!agentTools) return { ok: false, out: '' };
    const out = await agentTools.getRunningApps();
    return { ok: true, out };
  });

  // ── SHOW WINDOW (for wake word) ───────────────────────────────────────────────
  ipcMain.handle('showWindow', () => { const w = getWin(); w?.show(); w?.focus(); return true; });
}

module.exports = { register };
