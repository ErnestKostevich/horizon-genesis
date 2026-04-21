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
  getPersonaPrompt: (id, lang)        => ipcRenderer.invoke('getPersonaPrompt', id, lang),
  getWakeResponse:  (id, lang)        => ipcRenderer.invoke('getWakeResponse', id, lang),

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
  onWorkflowStep:       (cb)          => ipcRenderer.on('workflowStep', (_, step) => cb(step)),

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
  marketGetUrl:         ()            => ipcRenderer.invoke('marketGetUrl'),
  marketGetWebUrl:      ()            => ipcRenderer.invoke('marketGetWebUrl'),
  marketSetUrl:         (url)         => ipcRenderer.invoke('marketSetUrl', url),
  marketSetWebUrl:      (url)         => ipcRenderer.invoke('marketSetWebUrl', url),
  marketLogin:          (email, pw)   => ipcRenderer.invoke('marketLogin', email, pw),
  marketSignup:         (email, pw, n) => ipcRenderer.invoke('marketSignup', email, pw, n),
  marketLogout:         ()            => ipcRenderer.invoke('marketLogout'),
  marketMe:             ()            => ipcRenderer.invoke('marketMe'),

  // ── GOOGLE OAUTH ──────────────────────────────────────────────────────────────
  googleAuth:       (cid, cs)         => ipcRenderer.invoke('googleAuth', cid, cs),
  googleAuthStatus: ()                => ipcRenderer.invoke('googleAuthStatus'),
  googleLogout:     ()                => ipcRenderer.invoke('googleLogout'),
  googleGetToken:   ()                => ipcRenderer.invoke('googleGetToken'),

  // ── SYSTEM ────────────────────────────────────────────────────────────────────
  getDetailedSysInfo: () => ipcRenderer.invoke('getDetailedSysInfo'),
  getRunningApps:     () => ipcRenderer.invoke('getRunningApps'),
  showWindow:         () => ipcRenderer.invoke('showWindow'),
});
