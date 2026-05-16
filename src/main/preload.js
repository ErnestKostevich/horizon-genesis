'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('H', {
  // ── Keys & Settings ──────────────────────────────────────────────────────────
  saveKey:              (s, k)       => ipcRenderer.invoke('saveKey', s, k),
  getKey:               (s)          => ipcRenderer.invoke('getKey', s),
  hasKey:               (s)          => ipcRenderer.invoke('hasKey', s),
  deleteKey:            (s)          => ipcRenderer.invoke('deleteKey', s),
  set:                  (k, v)       => ipcRenderer.invoke('set', k, v),
  get:                  (k)          => ipcRenderer.invoke('get', k),
  settingsDiagnostics:  ()           => ipcRenderer.invoke('settingsDiagnostics'),
  openSettingsFolder:   ()           => ipcRenderer.invoke('openSettingsFolder'),
  localProviderStatus:  (provider)   => ipcRenderer.invoke('localProviderStatus', provider),
  openrouterListModels: ()           => ipcRenderer.invoke('openrouterListModels'),
  getPort:              ()           => ipcRenderer.invoke('getPort'),
  go:                   (p)          => ipcRenderer.invoke('go', p),
  // ── Window ───────────────────────────────────────────────────────────────────
  minimize:             ()           => ipcRenderer.send('minimize'),
  hide:                 ()           => ipcRenderer.send('hide'),
  quit:                 ()           => ipcRenderer.send('quit'),
  // ── Clipboard & URLs ─────────────────────────────────────────────────────────
  copy:                 (t)          => ipcRenderer.invoke('copy', t),
  paste:                ()           => ipcRenderer.invoke('paste'),
  getClipboard:         ()           => ipcRenderer.invoke('getClipboard'),
  openUrl:              (u)          => ipcRenderer.invoke('openUrl', u),
  notify:               (t, b)       => ipcRenderer.invoke('notify', t, b),
  // ── System ───────────────────────────────────────────────────────────────────
  sysInfo:              ()           => ipcRenderer.invoke('sysInfo'),
  // ── STT (Speech-to-Text) ─────────────────────────────────────────────────────
  transcribeAudio:      (b, m)       => ipcRenderer.invoke('transcribeAudio', b, m),
  // ── TTS (Text-to-Speech) — 4 providers ───────────────────────────────────────
  ttsElevenLabs:        (t, v)       => ipcRenderer.invoke('ttsElevenLabs', t, v),
  ttsOpenAI:            (t, v)       => ipcRenderer.invoke('ttsOpenAI', t, v),
  // ── Screen / Vision ───────────────────────────────────────────────────────────
  captureScreen:        ()           => ipcRenderer.invoke('captureScreen'),
  analyzeScreen:        (q)          => ipcRenderer.invoke('analyzeScreen', q),
  // ── AI & Web Search ───────────────────────────────────────────────────────────
  ai:                   (m, p, s, o) => ipcRenderer.invoke('ai', m, p, s, o),
  aiStream:             (m, p, s, o) => ipcRenderer.invoke('aiStream', m, p, s, o),
  aiAbort:              (runId)      => ipcRenderer.invoke('aiAbort', runId),
  // Phase 4.1 — image generation (BYOK). opts = { provider, prompt, size?, model?, quality?, n? }
  // Returns { ok, images: [{ b64, mime, prompt, revised_prompt?, model, provider }], error? }
  aiImage:              (opts)       => ipcRenderer.invoke('aiImage', opts),
  onAIStreamChunk:      (cb)         => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on('aiStreamChunk', handler);
    return () => ipcRenderer.removeListener('aiStreamChunk', handler);
  },
  // PR-C5 — streaming AI (Claude + OpenAI SSE).
  // aiStream returns { ok, runId } immediately; chunks arrive via
  // ai:chunk events, completion via ai:done. aiAbort cancels the
  // in-flight request.
  onAiChunk:            (cb)         => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on('ai:chunk', handler);
    return () => ipcRenderer.removeListener('ai:chunk', handler);
  },
  onAiDone:             (cb)         => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on('ai:done', handler);
    return () => ipcRenderer.removeListener('ai:done', handler);
  },
  search:               (q)          => ipcRenderer.invoke('search', q),
  // ── PC Apps & URLs ────────────────────────────────────────────────────────────
  pcOpen:               (a)          => ipcRenderer.invoke('pcOpen', a),
  pcOpenUrl:            (u)          => ipcRenderer.invoke('pcOpenUrl', u),
  pcSearch:             (q, e)       => ipcRenderer.invoke('pcSearch', q, e),
  // ── PC Screen & Files ────────────────────────────────────────────────────────
  pcScreenshot:         ()           => ipcRenderer.invoke('pcScreenshot'),
  pcShell:              (c)          => ipcRenderer.invoke('pcShell', c),
  pcProcesses:          ()           => ipcRenderer.invoke('pcProcesses'),
  pcKillProc:           (n)          => ipcRenderer.invoke('pcKillProc', n),
  pcClipboard:          ()           => ipcRenderer.invoke('pcClipboard'),
  pcSetClip:            (t)          => ipcRenderer.invoke('pcSetClip', t),
  pcReadFile:           (p)          => ipcRenderer.invoke('pcReadFile', p),
  pcWriteFile:          (p, c)       => ipcRenderer.invoke('pcWriteFile', p, c),
  pcListDir:            (d)          => ipcRenderer.invoke('pcListDir', d),
  pcChooseFolder:       ()           => ipcRenderer.invoke('pcChooseFolder'),
  wsChooseFolder:       ()           => ipcRenderer.invoke('wsChooseFolder'),
  wsGetWorkspace:       ()           => ipcRenderer.invoke('wsGetWorkspace'),
  wsList:               (rel)        => ipcRenderer.invoke('wsList', rel),
  wsRead:               (rel)        => ipcRenderer.invoke('wsRead', rel),
  wsWrite:              (rel, c)     => ipcRenderer.invoke('wsWrite', rel, c),
  wsSearch:             (q, rel)     => ipcRenderer.invoke('wsSearch', q, rel),
  wsShell:              (cmd)        => ipcRenderer.invoke('wsShell', cmd),
  // PR-C4 — git branch indicator + recent-branch dropdown.
  gitBranch:            (abs)        => ipcRenderer.invoke('gitBranch', abs),
  gitRecentBranches:    (abs)        => ipcRenderer.invoke('gitRecentBranches', abs),
  // PR-D3 — project config (.horizon/rules.md + hooks.json).
  projectConfigGet:        ()         => ipcRenderer.invoke('projectConfigGet'),
  projectConfigWriteRules: (content)  => ipcRenderer.invoke('projectConfigWriteRules', content),
  projectConfigWriteHooks: (hooks)    => ipcRenderer.invoke('projectConfigWriteHooks', hooks),
  // PR-D2 — workspace symbol index (built lazily on workspace open).
  wsIndexBuild:         (opts)       => ipcRenderer.invoke('wsIndexBuild', opts),
  wsIndexStatus:        ()           => ipcRenderer.invoke('wsIndexStatus'),
  wsIndexQuery:         (q, opts)    => ipcRenderer.invoke('wsIndexQuery', q, opts),
  wsIndexClear:         ()           => ipcRenderer.invoke('wsIndexClear'),
  terminalCreate:       (id, rel, c, r) => ipcRenderer.invoke('terminalCreate', id, rel, c, r),
  terminalWrite:        (id, data)   => ipcRenderer.invoke('terminalWrite', id, data),
  terminalResize:       (id, c, r)   => ipcRenderer.invoke('terminalResize', id, c, r),
  terminalKill:         (id)         => ipcRenderer.invoke('terminalKill', id),
  onTerminalData:       (cb)         => ipcRenderer.on('terminalData', (_, payload) => cb(payload)),
  // ── PC Keyboard ──────────────────────────────────────────────────────────────
  pcType:               (t)          => ipcRenderer.invoke('pcType', t),
  pcKeyPress:           (k)          => ipcRenderer.invoke('pcKeyPress', k),
  pcVolume:             (v)          => ipcRenderer.invoke('pcVolume', v),
  // ── PC Mouse ─────────────────────────────────────────────────────────────────
  pcMouseMove:          (x, y)       => ipcRenderer.invoke('pcMouseMove', x, y),
  pcMouseClick:         (x, y, b)    => ipcRenderer.invoke('pcMouseClick', x, y, b),
  pcMouseDoubleClick:   (x, y)       => ipcRenderer.invoke('pcMouseDoubleClick', x, y),
  pcMouseScroll:        (dir, amt)   => ipcRenderer.invoke('pcMouseScroll', dir, amt),
  pcMouseDrag:          (x1,y1,x2,y2)=> ipcRenderer.invoke('pcMouseDrag', x1, y1, x2, y2),
  pcGetMousePos:        ()           => ipcRenderer.invoke('pcGetMousePos'),
  pcScreenSize:         ()           => ipcRenderer.invoke('pcScreenSize'),
  pcCheckMouseBackends: ()           => ipcRenderer.invoke('pcCheckMouseBackends'),
  // ── File/Image analysis ───────────────────────────────────────────────────────
  analyzeImage:         (b, m, q)    => ipcRenderer.invoke('analyzeImage', b, m, q),
  readUploadedFile:     (b, n, m)    => ipcRenderer.invoke('readUploadedFile', b, n, m),

  // ── REAL AGENT ────────────────────────────────────────────────────────────────
  agentRun:    (msg, opts)     => ipcRenderer.invoke('agentRun', msg, opts),
  agentControl:(runId, action) => ipcRenderer.invoke('agentControl', runId, action),
  agentStep:   (stepId, decision) => ipcRenderer.invoke('agentStep', stepId, decision),
  agentRuns:   (limit)         => ipcRenderer.invoke('agentRuns', limit),
  agentRunDetails: (runId)     => ipcRenderer.invoke('agentRunDetails', runId),
  permissionAllowlistList:   () => ipcRenderer.invoke('permissionAllowlistList'),
  permissionAllowlistRevoke: (id) => ipcRenderer.invoke('permissionAllowlistRevoke', id),
  mcpServersList:  ()          => ipcRenderer.invoke('mcpServersList'),
  mcpServerUpsert: (config)    => ipcRenderer.invoke('mcpServerUpsert', config),
  mcpServerRemove: (id)        => ipcRenderer.invoke('mcpServerRemove', id),
  mcpServerEnable: (id, on)    => ipcRenderer.invoke('mcpServerEnable', id, on),
  mcpServerTest:   (config)    => ipcRenderer.invoke('mcpServerTest', config),
  mcpToolsRefresh: ()          => ipcRenderer.invoke('mcpToolsRefresh'),
  agentTool:   (tool, args)    => ipcRenderer.invoke('agentTool', tool, args),
  onAgentStep: (cb)            => ipcRenderer.on('agentStep', (_, step) => cb(step)),

  // ── CODE EXECUTION ────────────────────────────────────────────────────────────
  execCode:    (code, lang)    => ipcRenderer.invoke('executeCode', code, lang),

  // ── MEMORY ────────────────────────────────────────────────────────────────────
  memRemember: (c, cat, imp)   => ipcRenderer.invoke('memRemember', c, cat, imp),
  memRecall:   (q, lim)        => ipcRenderer.invoke('memRecall', q, lim),
  memSetFact:  (k, v)          => ipcRenderer.invoke('memSetFact', k, v),
  memGetFact:  (k)             => ipcRenderer.invoke('memGetFact', k),
  memGetFacts: ()              => ipcRenderer.invoke('memGetFacts'),
  memGetRecent:(lim)           => ipcRenderer.invoke('memGetRecent', lim),
  memSaveConversation: (u, a)  => ipcRenderer.invoke('memSaveConversation', u, a),
  memSearchConversations: (q, l) => ipcRenderer.invoke('memSearchConversations', q, l),
  githubAttachRepo: (repo)     => ipcRenderer.invoke('githubAttachRepo', repo),
  githubListRepos:  ()         => ipcRenderer.invoke('githubListRepos'),
  githubRemoveRepo: (repo)     => ipcRenderer.invoke('githubRemoveRepo', repo),
  githubRepoContext:(repo)     => ipcRenderer.invoke('githubRepoContext', repo),

  // ── CHAT MANAGEMENT ────────────────────────────────────────────────────────
  chatList:         ()              => ipcRenderer.invoke('chatList'),
  chatGet:          (id)            => ipcRenderer.invoke('chatGet', id),
  chatCreate:       (opts)          => ipcRenderer.invoke('chatCreate', opts),
  chatSwitch:       (id)            => ipcRenderer.invoke('chatSwitch', id),
  chatRename:       (id, title)     => ipcRenderer.invoke('chatRename', id, title),
  chatDelete:       (id)            => ipcRenderer.invoke('chatDelete', id),
  chatAddMessage:   (id, r, c, m)   => ipcRenderer.invoke('chatAddMessage', id, r, c, m),
  chatGetCurrent:   ()              => ipcRenderer.invoke('chatGetCurrent'),

  // ── NUTRITION ─────────────────────────────────────────────────────────────────
  nutritionLog:     (d, cal, p, c, f) => ipcRenderer.invoke('nutritionLog', d, cal, p, c, f),
  nutritionGet:     (days)            => ipcRenderer.invoke('nutritionGet', days),
  nutritionToday:   ()                => ipcRenderer.invoke('nutritionToday'),

  // ── MCP: LOCATION & WEATHER ───────────────────────────────────────────────────
  mcpGetLocation:   ()                => ipcRenderer.invoke('mcpGetLocation'),
  mcpGetWeather:    ()                => ipcRenderer.invoke('mcpGetWeather'),
  mcpGetTimezone:   ()                => ipcRenderer.invoke('mcpGetTimezone'),

  // ── MCP: WEB SEARCH ───────────────────────────────────────────────────────────
  mcpWebSearch:     (q)               => ipcRenderer.invoke('mcpWebSearch', q),
  mcpWikipedia:     (q, l)            => ipcRenderer.invoke('mcpWikipedia', q, l),
  mcpWikiSummary:   (t)               => ipcRenderer.invoke('mcpWikipediaSummary', t),

  // ── MCP: GMAIL ────────────────────────────────────────────────────────────────
  mcpGmailSetToken: (t)               => ipcRenderer.invoke('mcpGmailSetToken', t),
  mcpGmailList:     (q, m)            => ipcRenderer.invoke('mcpGmailList', q, m),
  mcpGmailRead:     (id)              => ipcRenderer.invoke('mcpGmailRead', id),
  mcpGmailSend:     (to,s,b,cc,bcc)   => ipcRenderer.invoke('mcpGmailSend', to, s, b, cc, bcc),

  // ── MCP: CALENDAR ─────────────────────────────────────────────────────────────
  mcpCalSetToken:   (t)               => ipcRenderer.invoke('mcpCalendarSetToken', t),
  mcpCalList:       (cal, max)        => ipcRenderer.invoke('mcpCalendarList', cal, max),
  mcpCalToday:      ()                => ipcRenderer.invoke('mcpCalendarToday'),
  mcpCalCreate:     (cal,s,st,en,d,l,a)=> ipcRenderer.invoke('mcpCalendarCreate',cal,s,st,en,d,l,a),
  mcpCalQuickAdd:   (text)            => ipcRenderer.invoke('mcpCalendarQuickAdd', text),

  // ── COMPUTER USE ──────────────────────────────────────────────────────────────
  smartClick:       (desc)            => ipcRenderer.invoke('smartClick', desc),
  findUIElements:   ()                => ipcRenderer.invoke('findUIElements'),

  // ── BROWSER AUTOMATION ────────────────────────────────────────────────────────
  browserOpenUrl:   (url)             => ipcRenderer.invoke('browserOpenUrl', url),
  browserSearch:    (q, e)            => ipcRenderer.invoke('browserSearch', q, e),
  browserOpenSite:  (name)            => ipcRenderer.invoke('browserOpenSite', name),

  // ── PERSONAS ──────────────────────────────────────────────────────────────────
  getPersonas:      ()                => ipcRenderer.invoke('getPersonas'),
  getPersona:       (id)              => ipcRenderer.invoke('getPersona', id),
  getPersonaFull:   (id)              => ipcRenderer.invoke('getPersonaFull', id),
  getPersonaPrompt: (id, lang)        => ipcRenderer.invoke('getPersonaPrompt', id, lang),
  getWakeResponse:  (id, lang)        => ipcRenderer.invoke('getWakeResponse', id, lang),
  personaUpsert:    (id, patch)       => ipcRenderer.invoke('personaUpsert', id, patch),
  personaDelete:    (id)              => ipcRenderer.invoke('personaDelete', id),

  // ── PLUGIN MANAGER ────────────────────────────────────────────────────────────
  pluginList:           ()            => ipcRenderer.invoke('pluginList'),
  pluginInstall:        (json)        => ipcRenderer.invoke('pluginInstall', json),
  pluginUninstall:      (id)          => ipcRenderer.invoke('pluginUninstall', id),
  pluginToggle:         (id)          => ipcRenderer.invoke('pluginToggle', id),
  pluginTemplates:      ()            => ipcRenderer.invoke('pluginTemplates'),
  pluginInstallTpl:     (id)          => ipcRenderer.invoke('pluginInstallTemplate', id),
  pluginExecTool:       (pid, tool, args) => ipcRenderer.invoke('pluginExecTool', pid, tool, args),
  pluginSetConfig:      (pid, cfg)    => ipcRenderer.invoke('pluginSetConfig', pid, cfg),
  pluginShareUrl:       (id)          => ipcRenderer.invoke('pluginShareUrl', id),
  pluginInstallFromUrl: (url)         => ipcRenderer.invoke('pluginInstallFromUrl', url),

  // ── WORKFLOW ENGINE ───────────────────────────────────────────────────────────
  workflowList:         ()            => ipcRenderer.invoke('workflowList'),
  workflowCreate:       (name, trigger, steps, desc) => ipcRenderer.invoke('workflowCreate', name, trigger, steps, desc),
  workflowUpdate:       (id, updates) => ipcRenderer.invoke('workflowUpdate', id, updates),
  workflowDelete:       (id)          => ipcRenderer.invoke('workflowDelete', id),
  workflowRun:          (id)          => ipcRenderer.invoke('workflowRun', id),
  workflowExamples:     ()            => ipcRenderer.invoke('workflowExamples'),
  workflowActiveRuns:   ()            => ipcRenderer.invoke('workflowActiveRuns'),
  onWorkflowStep:       (cb)          => ipcRenderer.on('workflowStep', (_, step) => cb(step)),
  // Live run-state events emitted by WorkflowEngine.run() — the premium
  // Workflows panel uses these to animate the graph nodes in real time.
  onWorkflowRunningStart: (cb)        => ipcRenderer.on('workflow:running:start', (_, p) => cb(p)),
  onWorkflowRunningStep:  (cb)        => ipcRenderer.on('workflow:running:step',  (_, p) => cb(p)),
  onWorkflowRunningEnd:   (cb)        => ipcRenderer.on('workflow:running:end',   (_, p) => cb(p)),

  // ── SCREEN RECORDER + AI NARRATOR ────────────────────────────────────────────
  recorderGetSources:   ()            => ipcRenderer.invoke('recorderGetSources'),
  recorderStart:        (path)        => ipcRenderer.invoke('recorderStart', path),
  recorderStop:         ()            => ipcRenderer.invoke('recorderStop'),
  recorderSave:         (b64, mime)   => ipcRenderer.invoke('recorderSave', b64, mime),
  recorderStatus:       ()            => ipcRenderer.invoke('recorderStatus'),
  recorderNarrate:      (b64, mime, ctx) => ipcRenderer.invoke('recorderNarrate', b64, mime, ctx),

  // ── MARKETPLACE ───────────────────────────────────────────────────────────────
  marketplaceList:      ()            => ipcRenderer.invoke('marketplaceList'),
  marketplaceSearch:    (q, cat)      => ipcRenderer.invoke('marketplaceSearch', q, cat),
  marketplacePublish:   (data)        => ipcRenderer.invoke('marketplacePublish', data),
  marketRemoteList:     (filters)     => ipcRenderer.invoke('marketRemoteList', filters),
  marketRemoteInstall:  (pluginId)    => ipcRenderer.invoke('marketRemoteInstall', pluginId),
  // Install a marketplace workflow item into the local engine. Routes
  // through workflowEngine.create instead of pluginManager.install so
  // triggers / steps actually fire on schedule.
  marketRemoteInstallWorkflow: (id)   => ipcRenderer.invoke('marketRemoteInstallWorkflow', id),
  marketGetUrl:         ()            => ipcRenderer.invoke('marketGetUrl'),
  marketGetWebUrl:      ()            => ipcRenderer.invoke('marketGetWebUrl'),
  marketSetUrl:         (url)         => ipcRenderer.invoke('marketSetUrl', url),
  marketSetWebUrl:      (url)         => ipcRenderer.invoke('marketSetWebUrl', url),
  marketLogin:          (email, pw)   => ipcRenderer.invoke('marketLogin', email, pw),
  marketSignup:         (email, pw, n) => ipcRenderer.invoke('marketSignup', email, pw, n),
  marketLogout:         ()            => ipcRenderer.invoke('marketLogout'),
  marketMe:             ()            => ipcRenderer.invoke('marketMe'),
  marketOpenWebAuth:    (mode)        => ipcRenderer.invoke('marketOpenWebAuth', mode),
  onMarketAuthenticated:(cb)          => ipcRenderer.on('market-authenticated', (_, user) => cb(user)),

  // ── GOOGLE OAUTH ──────────────────────────────────────────────────────────────
  googleAuth:       (cid, cs)         => ipcRenderer.invoke('googleAuth', cid, cs),
  googleAuthStatus: ()                => ipcRenderer.invoke('googleAuthStatus'),
  googleLogout:     ()                => ipcRenderer.invoke('googleLogout'),
  googleGetToken:   ()                => ipcRenderer.invoke('googleGetToken'),

  // ── SYSTEM ────────────────────────────────────────────────────────────────────
  getDetailedSysInfo: () => ipcRenderer.invoke('getDetailedSysInfo'),
  getRunningApps:     () => ipcRenderer.invoke('getRunningApps'),
  showWindow:         () => ipcRenderer.invoke('showWindow'),

  // ── LICENSE / PRO ─────────────────────────────────────────────────────────────
  licenseState:            ()              => ipcRenderer.invoke('licenseState'),
  licenseRefresh:          ()              => ipcRenderer.invoke('licenseRefresh'),
  licenseCreateCrypto:     (plan)          => ipcRenderer.invoke('licenseCreateCryptoPayment', plan),
  licensePollInvoice:      (id)            => ipcRenderer.invoke('licensePollInvoice', id),
  licenseOpenUpgradePage:  ()              => ipcRenderer.invoke('licenseOpenUpgradePage'),
  licenseOpenContact:      (channel)       => ipcRenderer.invoke('licenseOpenContactLink', channel),
  onLicenseChange:         (cb)            => ipcRenderer.on('license-state', (_, s) => cb(s)),
});

// ── Auto-wire renderer add-ons ──────────────────────────────────────────────
// When chat.html loads we inject `apex-alive.css` (icon-centering fix + the
// AI-alive aura) and `license-ui.js` (titlebar license pill). This keeps
// chat.html untouched — the main stylesheet/script list there stays minimal
// while preload owns all the optional visual polish.
try {
  const isChatPage = () => {
    const p = (location.pathname || '').toLowerCase();
    return p.endsWith('/chat.html') || p.endsWith('chat.html');
  };
  const injectChatAddons = () => {
    if (!isChatPage()) return;
    if (document.getElementById('hz-apex-alive-css')) return;
    const link = document.createElement('link');
    link.id   = 'hz-apex-alive-css';
    link.rel  = 'stylesheet';
    link.href = 'apex-alive.css';
    document.head.appendChild(link);
    const s = document.createElement('script');
    s.id    = 'hz-license-ui-js';
    s.src   = 'license-ui.js';
    s.defer = true;
    document.head.appendChild(s);
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', injectChatAddons, { once: true });
  } else {
    injectChatAddons();
  }
} catch (_) { /* preload runs in an isolated context — ignore DOM timing */ }
