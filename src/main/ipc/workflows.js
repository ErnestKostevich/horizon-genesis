'use strict';

// IPC handlers — workflow engine + screen recorder + Google OAuth +
// license + marketplace.
// Channels: workflowList, workflowCreate, workflowUpdate, workflowDelete,
// workflowRun, workflowActiveRuns, workflowExamples, recorderGetSources,
// recorderStart, recorderStop, recorderSave, recorderStatus,
// recorderNarrate, marketplaceList, marketplaceSearch, marketplacePublish,
// googleAuth, googleAuthStatus, googleLogout, googleGetToken,
// licenseState, licenseRefresh, licenseCreateCryptoPayment,
// licensePollInvoice, licenseOpenUpgradePage, licenseOpenContactLink,
// ownerContacts, marketRemoteList, marketRemoteInstall,
// marketRemoteInstallWorkflow, marketGetUrl, marketGetWebUrl, marketSetUrl,
// marketSetWebUrl, marketLogin, marketSignup, marketLogout, marketMe,
// marketOpenWebAuth.

function _sanitiseWorkflowTrigger(trigger) {
  const raw = String(trigger || 'manual').trim();
  if (!raw || raw === 'manual') return 'manual';
  if (raw === 'startup') return 'startup';
  if (raw.startsWith('interval:')) {
    const n = Number(raw.slice('interval:'.length));
    return (Number.isFinite(n) && n > 0 && n <= 60 * 24 * 30) ? `interval:${Math.floor(n)}` : 'manual';
  }
  if (raw.startsWith('schedule:')) {
    const m = raw.slice('schedule:'.length).match(/^(\d{1,2}):(\d{1,2})$/);
    if (m) {
      const hh = Number(m[1]), mm = Number(m[2]);
      if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
        return `schedule:${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      }
    }
    return 'manual';
  }
  if (raw.startsWith('wake:')) {
    const kw = raw.slice('wake:'.length).trim();
    if (kw && kw.length <= 32 && /^[\p{L}\p{N}\s_\-]+$/u.test(kw)) return `wake:${kw}`;
    return 'manual';
  }
  return 'manual';
}

function register(deps) {
  const {
    ipcMain,
    loadAgentModules,
    getWorkflowEngine, getScreenRecorder, getMcpManager, getGoogleAuth,
    getPluginManager,
    settingsStore,
    marketClient, licenseManager,
    getMarketplaceWebBase,
    openExternalReliable,
    OWNER_EMAIL_PRIMARY, OWNER_EMAIL_SECONDARY,
    OWNER_TG_PRIMARY, OWNER_TG_SECONDARY,
  } = deps;

  // ── WORKFLOW ENGINE ───────────────────────────────────────────────────────────
  ipcMain.handle('workflowList', () => {
    loadAgentModules();
    const workflowEngine = getWorkflowEngine();
    if (!workflowEngine) return [];
    return workflowEngine.loadAll();
  });

  ipcMain.handle('workflowCreate', (_, name, trigger, steps, desc) => {
    loadAgentModules();
    const workflowEngine = getWorkflowEngine();
    if (!workflowEngine) return { ok: false, error: 'Workflow engine not loaded' };
    return workflowEngine.create(name, _sanitiseWorkflowTrigger(trigger), steps, desc);
  });

  ipcMain.handle('workflowUpdate', (_, id, updates) => {
    loadAgentModules();
    const workflowEngine = getWorkflowEngine();
    if (!workflowEngine) return { ok: false, error: 'Workflow engine not loaded' };
    return workflowEngine.update(id, updates);
  });

  ipcMain.handle('workflowDelete', (_, id) => {
    loadAgentModules();
    const workflowEngine = getWorkflowEngine();
    if (!workflowEngine) return { ok: false, error: 'Workflow engine not loaded' };
    return workflowEngine.delete(id);
  });

  ipcMain.handle('workflowRun', async (event, id) => {
    loadAgentModules();
    const workflowEngine = getWorkflowEngine();
    if (!workflowEngine) return { ok: false, error: 'Workflow engine not loaded' };
    const onStep = (step) => { try { event.sender.send('workflowStep', step); } catch {} };
    return workflowEngine.run(id, onStep, { sender: event.sender });
  });

  ipcMain.handle('workflowActiveRuns', () => {
    loadAgentModules();
    const workflowEngine = getWorkflowEngine();
    if (!workflowEngine) return [];
    return workflowEngine.getActiveRuns();
  });

  ipcMain.handle('workflowExamples', () => {
    const { WorkflowEngine } = require('../workflowEngine');
    return WorkflowEngine.getExampleWorkflows();
  });

  // ── SCREEN RECORDER + AI NARRATOR ────────────────────────────────────────────
  ipcMain.handle('recorderGetSources', async () => {
    loadAgentModules();
    const screenRecorder = getScreenRecorder();
    if (!screenRecorder) return { ok: false, error: 'Recorder not loaded' };
    return screenRecorder.getSources();
  });

  ipcMain.handle('recorderStart', (_, outputPath) => {
    loadAgentModules();
    const screenRecorder = getScreenRecorder();
    if (!screenRecorder) return { ok: false, error: 'Recorder not loaded' };
    return screenRecorder.startRecording(outputPath);
  });

  ipcMain.handle('recorderStop', () => {
    loadAgentModules();
    const screenRecorder = getScreenRecorder();
    if (!screenRecorder) return { ok: false, error: 'Recorder not loaded' };
    return screenRecorder.stopRecording();
  });

  ipcMain.handle('recorderSave', (_, b64, mime) => {
    loadAgentModules();
    const screenRecorder = getScreenRecorder();
    if (!screenRecorder) return { ok: false, error: 'Recorder not loaded' };
    return screenRecorder.saveRecording(b64, mime);
  });

  ipcMain.handle('recorderStatus', () => {
    loadAgentModules();
    const screenRecorder = getScreenRecorder();
    if (!screenRecorder) return { isRecording: false };
    return screenRecorder.getStatus();
  });

  ipcMain.handle('recorderNarrate', async (_, b64, mime, ctx) => {
    loadAgentModules();
    const screenRecorder = getScreenRecorder();
    if (!screenRecorder) return { ok: false, error: 'Recorder not loaded' };
    return screenRecorder.generateNarration(b64, mime, ctx);
  });

  // ── MARKETPLACE STUBS ─────────────────────────────────────────────────────────
  ipcMain.handle('marketplaceList', () => []);
  ipcMain.handle('marketplaceSearch', () => []);

  ipcMain.handle('marketplacePublish', async () => {
    const base = marketClient?.webBase || process.env.HORIZON_MARKETPLACE_WEB_URL || 'https://horizonaai.dev';
    const url = `${String(base).replace(/\/+$/, '')}/publish`;
    return {
      ok: false,
      url,
      error: 'Desktop publishing is disabled. Publish from the web dashboard so moderation, account ownership, and payouts are recorded correctly.',
    };
  });

  // ── GOOGLE OAUTH ─────────────────────────────────────────────────────────────
  ipcMain.handle('googleAuth', async (_, clientId, clientSecret) => {
    loadAgentModules();
    const googleAuth = getGoogleAuth();
    const mcpManager = getMcpManager();
    if (!googleAuth) return { ok: false, error: 'Google Auth not loaded' };
    const result = await googleAuth.authenticate(clientId, clientSecret);
    if (result.ok && mcpManager) {
      mcpManager.setGmailToken(result.access_token);
      mcpManager.setCalendarToken(result.access_token);
    }
    return result;
  });

  ipcMain.handle('googleAuthStatus', () => {
    loadAgentModules();
    const googleAuth = getGoogleAuth();
    if (!googleAuth) return { ok: false };
    return { ok: true, authenticated: googleAuth.isAuthenticated() };
  });

  ipcMain.handle('googleLogout', () => {
    loadAgentModules();
    const googleAuth = getGoogleAuth();
    const mcpManager = getMcpManager();
    if (!googleAuth) return { ok: false };
    if (mcpManager) {
      mcpManager.setGmailToken(null);
      mcpManager.setCalendarToken(null);
    }
    return googleAuth.logout();
  });

  ipcMain.handle('googleGetToken', async () => {
    loadAgentModules();
    const googleAuth = getGoogleAuth();
    const mcpManager = getMcpManager();
    if (!googleAuth) return { ok: false, error: 'Google Auth not loaded' };
    const result = await googleAuth.getAccessToken();
    if (result.ok && mcpManager) {
      mcpManager.setGmailToken(result.token);
      mcpManager.setCalendarToken(result.token);
    }
    return result;
  });

  // ── LICENSE ───────────────────────────────────────────────────────────────────
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
  ipcMain.handle('licenseOpenUpgradePage', async () => {
    const base = getMarketplaceWebBase();
    const url = `${base}/pricing?src=desktop&intent=upgrade`;
    return openExternalReliable(url, 'Horizon Pro');
  });

  ipcMain.handle('licenseOpenContactLink', (_, channel) => {
    const links = {
      telegram_primary:   `https://t.me/${OWNER_TG_PRIMARY}`,
      telegram_secondary: `https://t.me/${OWNER_TG_SECONDARY}`,
      email_primary:      `mailto:${OWNER_EMAIL_PRIMARY}`,
      email_secondary:    `mailto:${OWNER_EMAIL_SECONDARY}`,
    };
    const url = links[channel];
    if (!url) return { ok: false, url };
    return openExternalReliable(url, 'Horizon Support');
  });

  ipcMain.handle('ownerContacts', () => ({
    emailPrimary:   OWNER_EMAIL_PRIMARY,
    emailSecondary: OWNER_EMAIL_SECONDARY,
    tgPrimary:      OWNER_TG_PRIMARY,
    tgSecondary:    OWNER_TG_SECONDARY,
  }));

  // ── MARKETPLACE (remote) ─────────────────────────────────────────────────────
  ipcMain.handle('marketRemoteList', async (_, filters = {}) => {
    try { return { ok: true, items: await marketClient.list(filters) }; }
    catch (e) { return { ok: false, error: e.message, items: [] }; }
  });

  ipcMain.handle('marketRemoteInstall', async (_, pluginId) => {
    try {
      loadAgentModules();
      const pluginManager = getPluginManager();
      if (!pluginManager) return { ok: false, error: 'Plugin manager not ready' };
      try { await marketClient.install(pluginId); } catch (_) {}
      const bundle = await marketClient.bundle(pluginId);
      const m = bundle.manifest;
      const r = pluginManager.install({
        id: m.id, name: m.name, version: m.version,
        description: m.description, author: m.author,
        category: m.category,
        tier: ['built_in', 'demo', 'local', 'marketplace'].includes(m.tier) ? m.tier : 'marketplace',
        icon: m.icon,
        tools: m.tools, settings: m.settings || [],
        permissions: m.permissions || [],
        handler: bundle.handler || '',
      });
      return r;
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('marketRemoteInstallWorkflow', async (_, workflowId) => {
    try {
      loadAgentModules();
      const workflowEngine = getWorkflowEngine();
      if (!workflowEngine) return { ok: false, error: 'Workflow engine not ready' };
      try { await marketClient.install(workflowId); } catch (_) {}
      const bundle = await marketClient.bundle(workflowId);
      const m = bundle.manifest || {};
      let trigger = 'manual';
      let steps = [];
      let name = m.name || 'Imported workflow';
      let desc = m.description || '';

      if (bundle.handler && typeof bundle.handler === 'string') {
        try {
          const parsed = JSON.parse(bundle.handler);
          if (parsed && typeof parsed === 'object') {
            if (parsed.trigger) trigger = parsed.trigger;
            if (Array.isArray(parsed.steps)) steps = parsed.steps;
            if (parsed.name) name = parsed.name;
            if (parsed.description) desc = parsed.description;
          }
        } catch (_) {}
      }

      if (!steps.length && Array.isArray(m.tools) && m.tools.length) {
        steps = m.tools.map(t => ({
          action: t.name || 'shell',
          args: t.params || {}
        }));
      }

      if (!steps.length) {
        return { ok: false, error: 'Workflow bundle has no steps (neither handler JSON nor tools[])' };
      }

      const result = workflowEngine.create(name, _sanitiseWorkflowTrigger(trigger), steps, desc);
      return { ok: true, workflow: result };
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
    catch (e) {
      marketClient.logout();
      licenseManager.clearCache();
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('marketOpenWebAuth', async (_, mode = 'login') => {
    const base = getMarketplaceWebBase();
    const pathName = mode === 'signup' ? '/signup' : '/login';
    const url = `${base}${pathName}?desktop=1`;
    return openExternalReliable(url, 'Horizon Account');
  });

  // expose sanitiser for main.js callers
  return { _sanitiseWorkflowTrigger };
}

module.exports = { register, _sanitiseWorkflowTrigger };
