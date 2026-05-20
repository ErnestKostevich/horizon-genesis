'use strict';

// IPC handlers — channels (GitHub, connections, mobile pairing, email,
// Discord, Telegram, chat sessions).
// Channels: githubAttachRepo, githubListRepos, githubRemoveRepo,
// githubRepoContext, connectionsList, connectionsTest, connectionsSetLive,
// connectionsRuntimeStatus, mobile:start, mobile:stop, mobile:status,
// emailSend, dcListChats, dcGetHistory, dcClearHistory, dcSendFromUI,
// tgListChats, tgGetHistory, tgClearHistory, tgSendFromUI, chatList,
// chatGet, chatCreate, chatSwitch, chatRename, chatDelete, chatAddMessage,
// chatGetLogs, chatSetLogs, chatClearLogs, chatGetCurrent.

function register(deps) {
  const {
    ipcMain,
    BrowserWindow,
    crypto, os, fs, path,
    spawn, exec,
    loadAgentModules,
    getGithubConnector, getConnectionsManager, getChatStore,
    emailSetLive, emailStatus, getEmailAdapter, setEmailAdapter,
    keysStore, settingsStore,
    HORIZON_MOBILE_PORT,
    getMobileServerProc, setMobileServerProc,
    getMobileServerState, setMobileServerState,
    mobilePickLocalIp, mobileBuildQrDataUrl, mobileKillServer,
  } = deps;

  // GitHub
  ipcMain.handle('githubAttachRepo', async (_, repoUrl) => {
    loadAgentModules();
    const githubConnector = getGithubConnector();
    if (!githubConnector) return { ok: false, error: 'GitHub connector not loaded' };
    try { return { ok: true, repo: await githubConnector.attachRepo(repoUrl) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('githubListRepos', () => {
    loadAgentModules();
    const githubConnector = getGithubConnector();
    return githubConnector ? githubConnector.listRepos() : [];
  });
  ipcMain.handle('githubRemoveRepo', (_, fullName) => {
    loadAgentModules();
    const githubConnector = getGithubConnector();
    return githubConnector ? githubConnector.removeRepo(fullName) : false;
  });
  ipcMain.handle('githubRepoContext', async (_, fullName) => {
    loadAgentModules();
    const githubConnector = getGithubConnector();
    if (!githubConnector) return { ok: false, error: 'GitHub connector not loaded' };
    try { return { ok: true, ...(await githubConnector.repoContext(fullName)) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // Connections
  ipcMain.handle('connectionsList', () => {
    loadAgentModules();
    const connectionsManager = getConnectionsManager();
    try { return { ok: true, connections: connectionsManager ? connectionsManager.list() : [] }; }
    catch (e) { return { ok: false, error: e.message, connections: [] }; }
  });

  ipcMain.handle('connectionsTest', async (_, id) => {
    loadAgentModules();
    const connectionsManager = getConnectionsManager();
    if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
    try { return await connectionsManager.testConnection(String(id || '')); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('connectionsSetLive', async (_, id, enabled) => {
    loadAgentModules();
    const connectionsManager = getConnectionsManager();
    if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
    try {
      if (String(id || '') === 'telegram_bot') return await connectionsManager.setTelegramLive(!!enabled);
      if (String(id || '') === 'discord') return await connectionsManager.setDiscordLive(!!enabled);
      if (String(id || '') === 'email') return await emailSetLive(!!enabled);
      return { ok: false, error: `Live runtime is not available for ${id}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('connectionsRuntimeStatus', async (_, id) => {
    loadAgentModules();
    const connectionsManager = getConnectionsManager();
    if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
    try {
      if (String(id || '') === 'telegram_bot') return connectionsManager.telegramStatus();
      if (String(id || '') === 'discord') return connectionsManager.discordStatus();
      if (String(id || '') === 'email') return emailStatus();
      return { ok: false, error: `Runtime status is not available for ${id}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Mobile pairing
  ipcMain.handle('mobile:start', async () => {
    let mobileServerProc = getMobileServerProc();
    let mobileServerState = getMobileServerState();
    if (mobileServerProc && mobileServerState.running && mobileServerState.url) {
      return {
        ok: true,
        url: mobileServerState.url,
        qrDataUrl: mobileServerState.qrDataUrl,
        token: mobileServerState.token,
        port: HORIZON_MOBILE_PORT,
        since: mobileServerState.since,
      };
    }

    const token = crypto.randomBytes(16).toString('hex');
    const localIp = mobilePickLocalIp();
    const url = `http://${localIp}:${HORIZON_MOBILE_PORT}/?token=${encodeURIComponent(token)}`;
    const serveScript = path.resolve(__dirname, '..', '..', '..', 'bin', 'horizon-serve.js');
    if (!fs.existsSync(serveScript)) {
      return { ok: false, error: 'horizon-serve.js not found at ' + serveScript };
    }

    try {
      const child = spawn(process.execPath, [
        serveScript,
        '--port', String(HORIZON_MOBILE_PORT),
        '--host', '0.0.0.0',
        '--token', token,
      ], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let readyResolve;
      const ready = new Promise((resolve) => { readyResolve = resolve; });
      let stderrBuf = '';
      child.stderr?.on?.('data', (chunk) => {
        const s = String(chunk);
        stderrBuf += s;
        if (/Horizon serve\s+http:\/\//i.test(stderrBuf) && readyResolve) {
          readyResolve(true);
          readyResolve = null;
        }
      });
      child.on('exit', (code, sig) => {
        if (getMobileServerProc() === child) {
          setMobileServerProc(null);
          setMobileServerState({ running: false, url: null, qrDataUrl: null, token: null, since: 0 });
        }
        console.log('[mobile] serve exited', code, sig);
      });
      child.on('error', (err) => {
        console.error('[mobile] serve error:', err.message);
        if (readyResolve) { readyResolve(false); readyResolve = null; }
      });

      const winner = await Promise.race([
        ready,
        new Promise((r) => setTimeout(() => r(false), 4000)),
      ]);
      if (!winner || !child.pid) {
        try { child.kill(); } catch (_) {}
        return { ok: false, error: 'serve did not become ready in 4s: ' + stderrBuf.slice(-300) };
      }

      setMobileServerProc(child);
      const qrDataUrl = await mobileBuildQrDataUrl(url);
      const newState = {
        running: true,
        url,
        qrDataUrl,
        token,
        since: Date.now(),
      };
      setMobileServerState(newState);
      return { ok: true, url, qrDataUrl, token, port: HORIZON_MOBILE_PORT, since: newState.since };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('mobile:stop', () => {
    mobileKillServer();
    return { ok: true, running: false };
  });

  ipcMain.handle('mobile:status', () => {
    const mobileServerState = getMobileServerState();
    return {
      ok: true,
      running: !!mobileServerState.running,
      url: mobileServerState.url || null,
      qrDataUrl: mobileServerState.qrDataUrl || null,
      token: mobileServerState.token || null,
      port: HORIZON_MOBILE_PORT,
      since: mobileServerState.since || 0,
    };
  });

  // Outbound email tool
  ipcMain.handle('emailSend', async (_, payload) => {
    let emailAdapter = getEmailAdapter();
    if (!emailAdapter) {
      try {
        const { EmailAdapter } = require('../channelAdapters/email');
        emailAdapter = new EmailAdapter({ settingsStore, keysStore });
        setEmailAdapter(emailAdapter);
      } catch (e) { return { ok: false, error: 'email adapter unavailable: ' + e.message }; }
    }
    if (!emailAdapter.transporter) {
      try {
        const nodemailer = require('nodemailer');
        const cfg = emailAdapter._cfg();
        if (!cfg?.smtp) return { ok: false, error: 'SMTP not configured' };
        emailAdapter.transporter = nodemailer.createTransport({
          host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure, auth: cfg.smtp.auth,
        });
      } catch (e) { return { ok: false, error: 'nodemailer unavailable: ' + e.message }; }
    }
    return emailAdapter.send(payload || {});
  });

  // Discord chat viewer
  ipcMain.handle('dcListChats', () => {
    loadAgentModules();
    const connectionsManager = getConnectionsManager();
    if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded', chats: [] };
    try { return connectionsManager.discordListChats(); }
    catch (e) { return { ok: false, error: e.message, chats: [] }; }
  });

  ipcMain.handle('dcGetHistory', (_, channelId, limit) => {
    loadAgentModules();
    const connectionsManager = getConnectionsManager();
    if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
    try { return connectionsManager.discordGetHistory(channelId, limit); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('dcClearHistory', (_, channelId) => {
    loadAgentModules();
    const connectionsManager = getConnectionsManager();
    if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
    try { return connectionsManager.discordClearHistory(channelId); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('dcSendFromUI', async (_, channelId, content) => {
    loadAgentModules();
    const connectionsManager = getConnectionsManager();
    if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
    try { return await connectionsManager.discordSendFromUI(channelId, content); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // Telegram chat viewer
  ipcMain.handle('tgListChats', () => {
    loadAgentModules();
    const connectionsManager = getConnectionsManager();
    if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded', chats: [] };
    try { return connectionsManager.telegramListChats(); }
    catch (e) { return { ok: false, error: e.message, chats: [] }; }
  });

  ipcMain.handle('tgGetHistory', (_, chatId, limit) => {
    loadAgentModules();
    const connectionsManager = getConnectionsManager();
    if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
    try { return connectionsManager.telegramGetHistory(chatId, limit); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('tgClearHistory', (_, chatId) => {
    loadAgentModules();
    const connectionsManager = getConnectionsManager();
    if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
    try { return connectionsManager.telegramClearHistory(chatId); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('tgSendFromUI', async (_, chatId, text) => {
    loadAgentModules();
    const connectionsManager = getConnectionsManager();
    if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
    try { return await connectionsManager.telegramSendFromUI(chatId, text); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // Chat management
  ipcMain.handle('chatList', () => {
    loadAgentModules();
    const chatStore = getChatStore();
    try { return chatStore ? chatStore.list() : []; } catch (e) { return []; }
  });
  ipcMain.handle('chatGet', (_, id) => {
    loadAgentModules();
    const chatStore = getChatStore();
    try { return chatStore ? chatStore.get(id) : null; } catch (e) { return null; }
  });
  ipcMain.handle('chatCreate', (_, opts) => {
    loadAgentModules();
    const chatStore = getChatStore();
    try { return chatStore ? chatStore.create(opts) : null; } catch (e) { return null; }
  });
  ipcMain.handle('chatSwitch', (_, id) => {
    loadAgentModules();
    const chatStore = getChatStore();
    try { return chatStore ? chatStore.switchTo(id) : null; } catch (e) { return null; }
  });
  ipcMain.handle('chatRename', (_, id, title) => {
    loadAgentModules();
    const chatStore = getChatStore();
    try { return chatStore ? chatStore.rename(id, title) : false; } catch (e) { return false; }
  });
  ipcMain.handle('chatDelete', (_, id) => {
    loadAgentModules();
    const chatStore = getChatStore();
    try { return chatStore ? chatStore.remove(id) : { ok: false }; } catch (e) { return { ok: false }; }
  });
  ipcMain.handle('chatAddMessage', (_, id, role, content, meta) => {
    loadAgentModules();
    const chatStore = getChatStore();
    try { return chatStore ? chatStore.addMessage(id, role, content, meta) : { ok: false }; } catch (e) { return { ok: false }; }
  });
  ipcMain.handle('chatGetLogs', (_, id) => {
    loadAgentModules();
    const chatStore = getChatStore();
    try { return chatStore ? chatStore.getLogs(id) : { ok: false, logs: [] }; } catch (e) { return { ok: false, logs: [] }; }
  });
  ipcMain.handle('chatSetLogs', (_, id, logs) => {
    loadAgentModules();
    const chatStore = getChatStore();
    try { return chatStore ? chatStore.setLogs(id, logs) : { ok: false }; } catch (e) { return { ok: false }; }
  });
  ipcMain.handle('chatClearLogs', (_, id) => {
    loadAgentModules();
    const chatStore = getChatStore();
    try { return chatStore ? chatStore.clearLogs(id) : { ok: false }; } catch (e) { return { ok: false }; }
  });
  ipcMain.handle('chatGetCurrent', () => {
    loadAgentModules();
    const chatStore = getChatStore();
    try { return chatStore ? chatStore.getCurrent() : null; } catch (e) { return null; }
  });
}

module.exports = { register };
