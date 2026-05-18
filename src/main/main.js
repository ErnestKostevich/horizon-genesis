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
]);
const ALLOWED_MODEL_SETTING_PROVIDERS = new Set([
  'claude', 'openai', 'gemini', 'groq', 'deepseek',
  'grok', 'mistral', 'qwen', 'perplexity', 'cohere',
  'openrouter', 'ollama', 'lmstudio', 'localai',
]);
const ALLOWED_SETTING_KEYS = new Set([
  'userName', 'lang', 'provider', 'geminiModel', 'voiceProvider', 'subagentProvider',
  'executionMode', 'dockerWorkspaceMount',
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

const DEFAULT_PROVIDER_MODELS = {
  claude: 'claude-sonnet-4-6',
  openai: 'gpt-5.4',
  gemini: 'gemini-2.5-flash',
  groq: 'llama-3.3-70b-versatile',
  deepseek: 'deepseek-chat',
  grok: 'grok-4',
  mistral: 'mistral-large-latest',
  qwen: 'qwen-plus',
  perplexity: 'sonar-pro',
  cohere: 'command-a-03-2025',
  openrouter: 'openai/gpt-5.4-mini',
  ollama: 'llama3.1',
  lmstudio: 'local-model',
  localai: 'local-model',
};

const KNOWN_PROVIDER_MODELS = {
  claude: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'],
  openai: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2', 'o3', 'o4-mini'],
  gemini: ['gemini-3.1-pro-preview', 'gemini-3.1-flash-preview', 'gemini-3.0-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen/qwen3-32b', 'moonshotai/kimi-k2-instruct', 'openai/gpt-oss-120b'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  grok: ['grok-4', 'grok-4-fast-reasoning', 'grok-4-mini', 'grok-code-fast-1'],
  mistral: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest'],
  qwen: ['qwen-plus', 'qwen3-max', 'qwen3-coder-plus'],
  perplexity: ['sonar-pro', 'sonar', 'sonar-reasoning', 'sonar-reasoning-pro'],
  cohere: ['command-a-03-2025', 'command-a-reasoning-08-2025', 'command-a-vision-07-2025', 'command-r-plus-08-2024'],
};

function normalizeSelectedModel(provider, model) {
  const id = String(model || '').trim();
  if (!id) return DEFAULT_PROVIDER_MODELS[provider] || '';
  if (provider === 'openrouter') return id.includes('/') ? id : DEFAULT_PROVIDER_MODELS.openrouter;
  if (provider === 'ollama' || provider === 'lmstudio' || provider === 'localai') return id;
  const known = KNOWN_PROVIDER_MODELS[provider];
  if (!known || known.includes(id)) return id;
  return DEFAULT_PROVIDER_MODELS[provider] || id;
}

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

function firstTextFromAnthropic(d) {
  return (d.content || []).find(b => b && b.type === 'text')?.text || d.content?.[0]?.text || 'No response';
}

function normaliseUsage(d, provider) {
  try {
    if (!d) return null;
    if (provider === 'claude') {
      const u = d.usage; if (!u) return null;
      const p = u.input_tokens || 0, c = u.output_tokens || 0;
      return { prompt: p, completion: c, total: p + c };
    }
    if (provider === 'gemini') {
      const u = d.usageMetadata; if (!u) return null;
      return {
        prompt: u.promptTokenCount || 0,
        completion: u.candidatesTokenCount || 0,
        total: u.totalTokenCount || ((u.promptTokenCount || 0) + (u.candidatesTokenCount || 0)),
      };
    }
    if (provider === 'cohere') {
      const t = d.usage?.tokens || d.meta?.tokens || d.delta?.usage?.tokens;
      if (!t) return null;
      const p = t.input_tokens || 0, c = t.output_tokens || 0;
      return { prompt: p, completion: c, total: p + c };
    }
    const u = d.usage; if (!u) return null;
    return {
      prompt: u.prompt_tokens || 0,
      completion: u.completion_tokens || 0,
      total: u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0)),
    };
  } catch (_) { return null; }
}

function lastUserMessageText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] || {};
    if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content.trim();
    }
  }
  const last = messages[messages.length - 1];
  return typeof last?.content === 'string' ? last.content.trim() : '';
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

async function readSseStream(response, onEvent) {
  let buffer = '';
  let eventName = 'message';
  let dataLines = [];
  const flush = async () => {
    if (!dataLines.length) { eventName = 'message'; return; }
    const data = dataLines.join('\n');
    dataLines = [];
    const ev = eventName || 'message';
    eventName = 'message';
    await onEvent({ event: ev, data });
  };
  for await (const chunk of response.body) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk).toString('utf8');
    buffer = buffer.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line === '') { await flush(); continue; }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) { eventName = line.slice(6).trim() || 'message'; continue; }
      if (line.startsWith('data:')) { dataLines.push(line.slice(5).trimStart()); }
    }
  }
  if (buffer.trim()) {
    if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
    else dataLines.push(buffer.trim());
  }
  await flush();
}

function extractStreamPayload(provider, eventName, rawData) {
  if (!rawData || rawData === '[DONE]') return { done: true };
  let d;
  try { d = JSON.parse(rawData); }
  catch (_) { return { text: '' }; }
  if (d.error) return { error: d.error.message || d.error };

  if (provider === 'gemini') {
    const parts = d.candidates?.[0]?.content?.parts || [];
    return {
      text: parts.map(p => p?.text || '').join(''),
      usage: normaliseUsage(d, 'gemini'),
      done: Boolean(d.candidates?.[0]?.finishReason),
    };
  }

  if (provider === 'cohere') {
    const type = d.type || eventName;
    if (type === 'content-delta') {
      return { text: d.delta?.message?.content?.text || '' };
    }
    if (type === 'message-end') {
      return { done: true, usage: normaliseUsage(d, 'cohere') };
    }
    return { text: '' };
  }

  const choice = d.choices?.[0] || {};
  const delta = choice.delta || {};
  const message = choice.message || {};
  const text = delta.content || delta.text || '';
  const reasoning = delta.reasoning_content || delta.reasoning || d.delta?.reasoning || '';
  const fallbackFullText = !text && typeof message.content === 'string' ? message.content : '';
  return {
    text: text || fallbackFullText,
    reasoning,
    usage: normaliseUsage(d, provider),
    done: rawData === '[DONE]' || Boolean(choice.finish_reason),
    error: choice.finish_reason === 'error' ? (d.error?.message || `${provider} stream ended with error`) : null,
  };
}

// ── Source-preview build check ────────────────────────────────────────────────
// The CI release workflow (.github/workflows/release.yml) writes build-info.json
// into this directory before packaging. When the app is run from a source clone
// the file doesn't exist — we show a preview window and exit. Source is BSL 1.1 and
// readable for audit/contribution; runnable builds come from GitHub Releases.
// Native tool-call conversion helpers for agent mode.
function toolParamsToJsonSchema(params = {}) {
  const properties = {};
  for (const [name, hint] of Object.entries(params || {})) {
    const text = String(hint || '');
    let type = 'string';
    if (/number|integer|float/i.test(text)) type = 'number';
    else if (/boolean|bool/i.test(text)) type = 'boolean';
    else if (/array|list/i.test(text)) type = 'array';
    else if (/object/i.test(text)) type = 'object';
    properties[name] = { type, description: text || name };
  }
  return { type: 'object', properties, additionalProperties: true };
}

function nativeToolName(rawName, used = new Set()) {
  const base = String(rawName || 'tool')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^_+/, '')
    .slice(0, 58) || 'tool';
  let name = /^[a-zA-Z_]/.test(base) ? base : `tool_${base}`;
  let idx = 2;
  while (used.has(name)) {
    const suffix = `_${idx++}`;
    name = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
  }
  used.add(name);
  return name;
}

function nativeToolPack(tools = []) {
  const used = new Set();
  const map = {};
  const native = (tools || []).map(t => {
    const safeName = nativeToolName(t.name, used);
    map[safeName] = t.name;
    return { ...t, nativeName: safeName, name: safeName, originalName: t.name };
  });
  return { tools: native, map };
}

function toOpenAITools(tools = []) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.desc || t.description || t.name,
      parameters: t.inputSchema || toolParamsToJsonSchema(t.params)
    }
  }));
}

function toAnthropicTools(tools = []) {
  return tools.map(t => ({
    name: t.name,
    description: t.desc || t.description || t.name,
    input_schema: t.inputSchema || toolParamsToJsonSchema(t.params)
  }));
}

function safeJsonParseArgs(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function toOpenAIChatMessages(messages = [], systemPrompt = '') {
  const out = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
  for (const m of messages || []) {
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId || m.id || m.name || 'tool_call',
        name: m.name,
        content: String(m.content || '')
      });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map(call => ({
          id: call.id || `${call.providerTool || call.tool || call.name || 'tool'}_call`,
          type: 'function',
          function: { name: call.providerTool || call.tool || call.name, arguments: JSON.stringify(call.args || {}) }
        }))
      });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });
  }
  return out;
}

function asAnthropicBlocks(content) {
  return Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
}

function appendAnthropicMessage(out, message) {
  const last = out[out.length - 1];
  if (last && last.role === message.role) {
    last.content = [...asAnthropicBlocks(last.content), ...asAnthropicBlocks(message.content)];
  } else {
    out.push(message);
  }
}

function toAnthropicMessages(messages = []) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'tool') {
      appendAnthropicMessage(out, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId || m.id || m.name || 'tool_call', content: String(m.content || '') }]
      });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: String(m.content) });
      for (const call of m.toolCalls) {
        content.push({ type: 'tool_use', id: call.id || `${call.providerTool || call.tool || call.name || 'tool'}_call`, name: call.providerTool || call.tool || call.name, input: call.args || {} });
      }
      appendAnthropicMessage(out, { role: 'assistant', content });
      continue;
    }
    appendAnthropicMessage(out, { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });
  }
  return out;
}

function parseAnthropicToolCalls(d) {
  return (d.content || [])
    .filter(block => block && block.type === 'tool_use')
    .map(block => ({ id: block.id, tool: block.name, args: block.input || {}, reason: 'Claude tool_use' }));
}

function parseOpenAIToolCalls(message = {}) {
  return (message.tool_calls || [])
    .filter(call => call?.type === 'function' && call.function?.name)
    .map(call => ({
      id: call.id,
      tool: call.function.name,
      args: safeJsonParseArgs(call.function.arguments),
      reason: 'OpenAI tool_call'
    }));
}

function mapNativeToolCalls(toolCalls = [], nameMap = {}) {
  return (toolCalls || []).map(call => ({
    ...call,
    providerTool: call.tool,
    tool: nameMap[call.tool] || call.tool
  }));
}

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
ipcMain.on('minimize', () => win?.minimize());
ipcMain.on('hide',     () => win?.hide());
ipcMain.on('quit',     () => { isQuitting = true; app.quit(); });
ipcMain.handle('go',   (_, p) => { createWindow(p); return true; });

// ── IPC: Keys & Settings ──────────────────────────────────────────────────────
ipcMain.handle('saveKey',   (_, s, k) => { assertAllowedKey(s); keysStore.set(`k_${s}`, k); return true; });
ipcMain.handle('getKey',    (_, s)    => { assertAllowedKey(s); return keysStore.get(`k_${s}`, null); });
ipcMain.handle('hasKey',    (_, s)    => { assertAllowedKey(s); return !!keysStore.get(`k_${s}`); });
ipcMain.handle('deleteKey', (_, s)    => { assertAllowedKey(s); keysStore.delete(`k_${s}`); return true; });
ipcMain.handle('set',       (_, k, v) => { assertAllowedSetting(k); settingsStore.set(k, v); return true; });
ipcMain.handle('get',       (_, k)    => { assertAllowedSetting(k); return settingsStore.get(k, null); });
ipcMain.handle('getPort',   ()        => port);
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

// ── VOICE: Multiple external providers ───────────────────────────────────────
// Provider pricing and quotas change often, so Horizon does not hardcode them.
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
      // Deepgram param tuning for wake/command clips:
      //  - `smart_format=true` was the previous default; it formats numbers /
      //    dates / punctuation. On its own that's harmless, but combined with
      //    `language=multi` it tends to drop low-confidence segments to
      //    empty for clips that include echo of the bot's TTS reply. We turn
      //    it off — short transcripts don't need smart formatting anyway.
      //  - Pick an explicit language code per user setting (ru/en) instead of
      //    `multi`. Explicit-language gives much more reliable transcripts on
      //    Nova-2 for short utterances; `multi` was useful when we didn't
      //    know the user's tongue, but Horizon already has `lang` in
      //    settings.
      //  - `punctuate=true` produces cleaner output (capitals + punctuation)
      //    for the command-send path.
      //  - `filler_words=false` strips "um/ah" that often poisons matching.
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
      // Deepgram error shapes vary by error class:
      //   - top-level { err_code, err_msg } for legacy paths
      //   - { error: "..." } or { message: "..." } for newer / auth errors
      //   - HTTP 4xx with empty body for rate limits
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
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose Horizon workspace',
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths?.[0]) return { ok:false, canceled:true };
    settingsStore.set('codeWorkspace', r.filePaths[0]);
    return { ok:true, path:r.filePaths[0] };
  } catch(e) { return { ok:false, err:e.message }; }
});

ipcMain.handle('wsChooseFolder', async () => {
  try {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose Horizon code workspace',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths?.[0]) return { ok:false, canceled:true };
    const root = path.resolve(r.filePaths[0]);
    settingsStore.set('codeWorkspace', root);
    // PR-D2 — kick off symbol indexing in the background. Doesn't
    // block the IPC response; renderer can poll wsIndexStatus to know
    // when @symbol autocomplete becomes useful.
    setImmediate(() => {
      try { _getWsIndexer().build(root).catch(() => {}); } catch (_) {}
    });
    return { ok:true, path:root };
  } catch(e) { return { ok:false, err:e.message }; }
});

ipcMain.handle('wsGetWorkspace', () => {
  try {
    const root = currentWorkspaceRoot();
    return { ok:true, path:root };
  } catch(e) {
    return { ok:false, err:e.message, path:settingsStore.get('codeWorkspace') || '' };
  }
});

ipcMain.handle('wsList', (_, rel = '') => {
  try {
    const { root, target } = resolveWorkspacePath(rel);
    if (!fs.statSync(target).isDirectory()) return { ok:false, err:'Not a directory' };
    return { ok:true, root, rel:String(rel || '').replace(/\\/g, '/'), entries:safeDirEntries(target) };
  } catch(e) { return { ok:false, err:e.message }; }
});

ipcMain.handle('wsRead', (_, rel = '') => {
  try {
    const { root, target, rel: safeRel } = resolveWorkspacePath(rel);
    const stat = fs.statSync(target);
    if (!stat.isFile()) return { ok:false, err:'Not a file' };
    if (stat.size > 2 * 1024 * 1024) return { ok:false, err:'File is larger than 2MB' };
    return { ok:true, root, rel:safeRel, content:fs.readFileSync(target, 'utf8'), size:stat.size };
  } catch(e) { return { ok:false, err:e.message }; }
});

ipcMain.handle('wsWrite', async (event, rel = '', content = '') => {
  try {
    const { root, target, rel: safeRel } = resolveWorkspacePath(rel);
    return withPermission(
      event.sender,
      'fs.write_file',
      { path: safeRel, bytes: Buffer.byteLength(String(content ?? ''), 'utf8') },
      'Write workspace file',
      () => {
        fs.mkdirSync(path.dirname(target), { recursive:true });
        fs.writeFileSync(target, String(content ?? ''), 'utf8');
        return { ok:true, root, rel:safeRel, bytes:Buffer.byteLength(String(content ?? ''), 'utf8') };
      }
    );
  } catch(e) { return { ok:false, err:e.message }; }
});

ipcMain.handle('wsSearch', (_, query = '', rel = '') => {
  try {
    const q = String(query || '').trim();
    if (!q) return { ok:true, results:[] };
    const { root, target } = resolveWorkspacePath(rel);
    const start = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : root;
    return { ok:true, root, query:q, results:searchWorkspaceFiles(root, start, q) };
  } catch(e) { return { ok:false, err:e.message }; }
});

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

ipcMain.handle('projectConfigGet', () => {
  try {
    const root = currentWorkspaceRoot();
    if (!root) return { ok: false, err: 'no workspace open' };
    return { ok: true, ...(_getProjectConfig().get(root)) };
  } catch (e) { return { ok: false, err: e.message }; }
});
ipcMain.handle('projectConfigWriteRules', (_, content) => {
  try {
    const root = currentWorkspaceRoot();
    if (!root) return { ok: false, error: 'no workspace open' };
    return _getProjectConfig().writeRules(root, content);
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('projectConfigWriteHooks', (_, hooks) => {
  try {
    const root = currentWorkspaceRoot();
    if (!root) return { ok: false, error: 'no workspace open' };
    return _getProjectConfig().writeHooks(root, hooks || {});
  } catch (e) { return { ok: false, error: e.message }; }
});

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

ipcMain.handle('wsIndexBuild', async (_, opts = {}) => {
  try {
    const root = currentWorkspaceRoot();
    if (!root) return { ok: false, err: 'no workspace open' };
    return await _getWsIndexer().build(root, opts || {});
  } catch (e) { return { ok: false, err: e.message }; }
});

ipcMain.handle('wsIndexStatus', () => {
  try { return _getWsIndexer().status(); }
  catch (e) { return { ok: false, err: e.message }; }
});

ipcMain.handle('wsIndexQuery', (_, q = '', opts = {}) => {
  try { return _getWsIndexer().query(q, opts || {}); }
  catch (e) { return { ok: false, err: e.message }; }
});

ipcMain.handle('wsIndexClear', () => {
  try { _getWsIndexer().clear(); return { ok: true }; }
  catch (e) { return { ok: false, err: e.message }; }
});

ipcMain.handle('wsShell', async (event, cmd) => {
  try {
    const root = currentWorkspaceRoot();
    return await withPermission(
      event.sender,
      'shell_command',
      { command: String(cmd || ''), cwd: root },
      'Run workspace command',
      () => runShell(String(cmd || ''), 30000, { cwd: root })
    );
  } catch(e) { return { ok:false, err:e.message }; }
});

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

ipcMain.handle('terminalCreate', async (event, id, rel = '', cols = 100, rows = 30) => {
  try {
    const { target } = resolveWorkspacePath(rel || '.');
    const cwd = fs.statSync(target).isDirectory() ? target : path.dirname(target);
    const termId = String(id || `term-${Date.now().toString(36)}`);
    if (terminalSessions.has(termId)) {
      try { terminalSessions.get(termId).kill(); } catch (_) {}
      terminalSessions.delete(termId);
    }
    const send = data => {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
      try { event.sender.send('terminalData', { id: termId, data: text.replace(/\n/g, '\r\n') }); } catch (_) {}
    };
    const onExit = (exitCode, signal) => {
      terminalSessions.delete(termId);
      try { event.sender.send('terminalData', { id: termId, data: `\r\n[process exited ${exitCode}${signal ? ` ${signal}` : ''}]\r\n`, exitCode, signal }); } catch (_) {}
    };
    const term = createPtyTerminal({ termId, cwd, cols, rows, send, onExit })
      || createPipeTerminal({ termId, cwd, send, onExit });
    terminalSessions.set(termId, term);
    return {
      ok:true,
      id:termId,
      cwd,
      shell:term.shell,
      backend:term.backend,
      nativePty:term.backend === 'pty',
      nativeError:term.nativeError || '',
    };
  } catch(e) {
    return { ok:false, err:e.message };
  }
});

ipcMain.handle('terminalWrite', (_, id, data) => {
  const term = terminalSessions.get(String(id || ''));
  if (!term) return { ok:false, err:'Terminal session not found' };
  term.write(String(data ?? ''));
  return { ok:true };
});

ipcMain.handle('terminalResize', (_, id, cols, rows) => {
  const term = terminalSessions.get(String(id || ''));
  if (!term) return { ok:false, err:'Terminal session not found' };
  term.resize(cols, rows);
  return {
    ok:true,
    backend:term.backend,
    note:term.backend === 'pty' ? 'resized native PTY' : 'resize is ignored by the pipe-backed terminal transport',
  };
});

ipcMain.handle('terminalKill', (_, id) => {
  const term = terminalSessions.get(String(id || ''));
  if (!term) return { ok:true };
  try { term.kill(); } catch (_) {}
  terminalSessions.delete(String(id || ''));
  return { ok:true };
});

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

  // Try Claude first (best vision)
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

  // Try GPT-4o
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

  // Try Gemini
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
ipcMain.handle('aiStream', async (event, messages, provider, system, opts = {}) => {
  const fetch = require('node-fetch');
  const runId = opts.streamId || _streamRunId();
  const abort = new AbortController();
  const p = provider || settingsStore.get('provider') || 'gemini';
  const skillsResolved = resolveSkillsForMessages(messages, opts);
  const sysMsg = appendSkillsToSystemPrompt(
    String(system || '').trim() || 'You are Horizon AI. Use Markdown.',
    skillsResolved
  );
  let reply = '';
  let reasoning = '';
  let usage = null;
  let model = '';
  const emit = (type, payload = {}) => {
    try { event.sender.send('aiStreamChunk', { runId, type, provider: p, ...payload }); } catch (_) {}
    try {
      if (type === 'delta' && payload.delta) _broadcast('ai:chunk', { runId, delta: payload.delta });
      if (type === 'reasoning' && payload.delta) _broadcast('ai:chunk', { runId, delta: payload.delta, reasoning: true });
      if (type === 'done') _broadcast('ai:done', {
        runId,
        ok: true,
        fullText: payload.reply || reply,
        reply: payload.reply || reply,
        model: payload.model || model,
        usage: payload.usage || usage,
        reasoning: payload.reasoning || reasoning,
        skillsSelected: payload.skillsSelected || skillsResolved,
      });
      if (type === 'error') _broadcast('ai:done', {
        runId,
        ok: false,
        error: payload.error || 'Stream failed',
        fullText: reply,
        reply,
        model,
        usage,
        reasoning,
      });
    } catch (_) {}
  };
  const fail = (error) => {
    emit('error', { error });
    return { ok: false, error, runId, model };
  };
  _activeStreams.set(runId, abort);
  const openaiCompatible = {
    openai:     { url: 'https://api.openai.com/v1/chat/completions',                    model: selectedModel('openai', opts),     key: keysStore.get('k_openai') },
    groq:       { url: 'https://api.groq.com/openai/v1/chat/completions',               model: selectedModel('groq', opts),       key: keysStore.get('k_groq') },
    grok:       { url: 'https://api.x.ai/v1/chat/completions',                          model: selectedModel('grok', opts),       key: keysStore.get('k_grok') },
    deepseek:   { url: 'https://api.deepseek.com/chat/completions',                      model: selectedModel('deepseek', opts),   key: keysStore.get('k_deepseek') },
    mistral:    { url: 'https://api.mistral.ai/v1/chat/completions',                     model: selectedModel('mistral', opts),    key: keysStore.get('k_mistral') },
    qwen:       { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: selectedModel('qwen', opts), key: keysStore.get('k_qwen') },
    perplexity: { url: 'https://api.perplexity.ai/chat/completions',                     model: selectedModel('perplexity', opts), key: keysStore.get('k_perplexity') },
    openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions',                  model: selectedModel('openrouter', opts), key: keysStore.get('k_openrouter') },
  };

  try {
    let url, headers, body;
    const localEp = localOpenAIEndpoint(p);

    if (p === 'gemini') {
      const k = keysStore.get('k_gemini');
      if (!k) return fail('Gemini key not set');
      model = selectedModel('gemini', opts);
      const rawContents = (messages || []).map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content || '...' }],
      }));
      const contents = [];
      for (const msg of rawContents) {
        if (!contents.length) {
          if (msg.role === 'user') contents.push(msg);
        } else if (contents[contents.length - 1].role !== msg.role) {
          contents.push(msg);
        } else {
          contents[contents.length - 1].parts[0].text += '\n' + msg.parts[0].text;
        }
      }
      if (!contents.length) {
        const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
        contents.push({ role: 'user', parts: [{ text: lastMsg?.content || '...' }] });
      }
      if (contents[contents.length - 1].role !== 'user') contents.push({ role: 'user', parts: [{ text: 'continue' }] });
      url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
      headers = { 'Content-Type': 'application/json', 'x-goog-api-key': k };
      body = applyReasoningProfile('gemini', model, {
        system_instruction: { parts: [{ text: sysMsg }] },
        contents,
        generationConfig: { maxOutputTokens: 4096, temperature: 0.7 },
      });
    } else if (p === 'cohere') {
      const k = keysStore.get('k_cohere');
      if (!k) return fail('Cohere key not set');
      model = selectedModel('cohere', opts);
      url = 'https://api.cohere.com/v2/chat';
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` };
      body = { model, messages: [{ role: 'system', content: sysMsg }, ...(messages || [])], max_tokens: 4096, stream: true };
    } else if (localEp || openaiCompatible[p]) {
      const ep = localEp || openaiCompatible[p];
      model = selectedModel(p, opts);
      if (!localEp && !ep.key) return fail(`${p} key not set`);
      url = ep.url;
      headers = { 'Content-Type': 'application/json' };
      if (!localEp || ep.key) headers.Authorization = `Bearer ${ep.key}`;
      if (p === 'openrouter') {
        headers['HTTP-Referer'] = 'https://horizonaai.dev';
        headers['X-Title'] = 'Horizon Genesis';
      }
      body = applyReasoningProfile(p, model, {
        model,
        max_tokens: 4096,
        stream: true,
        messages: [{ role: 'system', content: sysMsg }, ...(messages || [])],
      });
      if (p === 'perplexity') body.stream_mode = 'concise';
    } else {
      return fail(`Streaming is not configured for ${p}`);
    }

    emit('start', { model });
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: abort.signal });
    if (!response.ok || !response.body) {
      const d = await response.json().catch(async () => ({ error: await response.text().catch(() => '') }));
      const msg = d.error?.message || d.message || d.error || `${p} stream failed (${response.status})`;
      return fail(msg);
    }

    await readSseStream(response, async ({ event: eventName, data }) => {
      if (abort.signal.aborted) throw new Error('aborted');
      const chunk = extractStreamPayload(p, eventName, data);
      if (chunk.error) {
        emit('error', { error: chunk.error });
        throw new Error(chunk.error);
      }
      if (chunk.usage) usage = chunk.usage;
      if (chunk.reasoning) {
        reasoning += chunk.reasoning;
        emit('reasoning', { delta: chunk.reasoning });
      }
      if (chunk.text) {
        reply += chunk.text;
        emit('delta', { delta: chunk.text });
      }
      if (chunk.done) emit('done-part', { usage });
    });
    emit('done', { reply, model, usage, reasoning, skillsSelected: skillsResolved });
    return { ok: true, reply, model, usage, reasoning, runId, skillsSelected: skillsResolved };
  } catch (e) {
    const msg = abort.signal.aborted ? 'aborted' : (e?.message || String(e));
    emit('error', { error: msg });
    return { ok: false, error: msg, runId };
  } finally {
    _activeStreams.delete(runId);
  }
});

// Phase 4.1 — image generation IPC (BYOK: caller picks provider + model,
// we read the user's stored key, never proxy). Returns base64 image data
// so renderer can render via <img src="data:..."> without disk round-trip.
ipcMain.handle('aiImage', async (_, opts) => {
  try {
    const { generateImage } = require('./imageGen');
    // getKey passed in so imageGen.js doesn't have to know about
    // electron-store directly (keeps it testable + provider-agnostic).
    return await generateImage(opts || {}, (svc) => keysStore.get(`k_${svc}`, null));
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('aiImageModels', async () => {
  try {
    const { listImageModels, DEFAULTS } = require('./imageGen');
    return { ok: true, models: listImageModels(), defaults: DEFAULTS };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), models: {} };
  }
});

async function runAiCompletion(_, messages, provider, system, opts) {
  const fetch    = require('node-fetch');
  const userName = settingsStore.get('userName') || 'user';
  const lang     = settingsStore.get('lang') || 'en';

  // IDENTITY: Horizon always knows who it is
  const identity = lang === 'ru'
    ? `Ты — Хорайзон (Horizon AI), продвинутый персональный AI-агент для ПК. Тебя создал Эрнест Костевич (Ernest Kostevich). Ты НЕ являешься Claude, ChatGPT, Gemini или любым другим AI — ты Хорайзон. Пользователь: ${userName}. Время: ${new Date().toLocaleString()}. Ты умный, дружелюбный, немного как Джарвис из Marvel. Можешь управлять ПК, видеть экран. Используй Markdown.`
    : `You are Horizon AI — an advanced personal desktop agent. You were created by Ernest Kostevich. You are NOT Claude, ChatGPT, Gemini, or any other AI — you are Horizon. User: ${userName}. Time: ${new Date().toLocaleString()}. You are intelligent, friendly, somewhat like JARVIS from Marvel. You can control the PC, see the screen. Use Markdown.`;

  // PERSONA INJECTION (defense-in-depth): the renderer's chat send path
  // already prepends the active persona's prompt to `system` before
  // invoking H.ai (chat.html ~line 5921). But other call sites — agent
  // loop, voice bursts, plugin re-asks — sometimes hand us a system
  // string that doesn't carry the persona, or pass null entirely. So we
  // also read the active persona from settingsStore here and merge it
  // in. This is what makes the user-visible persona dropdown actually
  // shape every assistant reply, not just the ones initiated from the
  // chat UI.
  let personaPrompt = '';
  try {
    loadAgentModules();
    if (personas) {
      const personaId = settingsStore.get('persona') || 'jarvis';
      // Skip if the renderer already inlined the persona text — cheap
      // substring check on the persona's signature opening line keeps us
      // from doubling the prompt for the common chat path.
      const pp = personas.getPersonaPrompt(personaId, lang);
      if (pp && (!system || !system.includes(pp.slice(0, 32)))) {
        personaPrompt = pp;
      }
    }
  } catch (_) { /* persona is optional; never block a send */ }

  const sysParts = [identity];
  if (personaPrompt) sysParts.push(personaPrompt);
  if (system && (!system.includes('Ты') && !system.includes('You are'))) {
    sysParts.push(system);
  } else if (system) {
    // Renderer supplied a self-contained system message (already includes
    // identity + persona) — use it verbatim so we don't double up.
    sysParts.length = 0;
    sysParts.push(system);
  }
  const skillsResolved = resolveSkillsForMessages(messages, opts || {});
  const sysMsg = appendSkillsToSystemPrompt(sysParts.join('\n\n'), skillsResolved);

  // Normalise per-provider usage shapes to {prompt, completion, total}.
  // Returns null if the response didn't include usage info (e.g. local models
  // that don't surface token counts) — renderer falls back to estimate.
  const _usage = (d, provider) => {
    try {
      if (provider === 'claude') {
        const u = d?.usage; if (!u) return null;
        const p = u.input_tokens || 0, c = u.output_tokens || 0;
        return { prompt: p, completion: c, total: p + c };
      }
      if (provider === 'gemini') {
        const u = d?.usageMetadata; if (!u) return null;
        return {
          prompt: u.promptTokenCount || 0,
          completion: u.candidatesTokenCount || 0,
          total: u.totalTokenCount || ((u.promptTokenCount||0)+(u.candidatesTokenCount||0))
        };
      }
      if (provider === 'cohere') {
        const t = d?.usage?.tokens || d?.meta?.tokens; if (!t) return null;
        const p = t.input_tokens || 0, c = t.output_tokens || 0;
        return { prompt: p, completion: c, total: p + c };
      }
      // OpenAI-compatible: openai, groq, deepseek, mistral, qwen, grok, perplexity, ollama, lmstudio
      const u = d?.usage; if (!u) return null;
      return {
        prompt: u.prompt_tokens || 0,
        completion: u.completion_tokens || 0,
        total: u.total_tokens || ((u.prompt_tokens||0)+(u.completion_tokens||0))
      };
    } catch (_) { return null; }
  };

  try {
    switch (provider) {
      case 'claude': {
        const k = keysStore.get('k_claude');
        if (!k) return { error: lang==='ru'?'Ключ Claude не задан → Настройки':'Claude key not set → Settings' };
        // Default: Sonnet 4.6 — best speed/intelligence balance per Anthropic.
        // User can override via settingsStore.get('model.claude') or opts.model.
        const claudeModel = selectedModel('claude', opts);
        const respProfile = settingsStore.get('responseProfile') || 'balanced';
        const claudeBody = { model: claudeModel, max_tokens: 4096, system: sysMsg, messages };
        // Deep → enable extended thinking. Need headroom on max_tokens because
        // the budget is debited from it. Anthropic also requires temperature
        // to be unset (which it already is) when thinking is on.
        if (respProfile === 'deep') {
          claudeBody.thinking = { type: 'enabled', budget_tokens: 8000 };
          claudeBody.max_tokens = 16000;
        }
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST', headers:{'Content-Type':'application/json','x-api-key':k,'anthropic-version':'2023-06-01'},
          body:JSON.stringify(claudeBody)
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        // With thinking enabled the first content block is `{type:'thinking'}`
        // and the user-visible reply is the first `{type:'text'}` block.
        const textBlock = (d.content || []).find(b => b && b.type === 'text');
        return { reply: textBlock?.text || d.content?.[0]?.text || 'No response', model: claudeModel, usage: _usage(d,'claude') };
      }
      case 'openai': {
        const k = keysStore.get('k_openai');
        if (!k) return { error: lang==='ru'?'Ключ OpenAI не задан':'OpenAI key not set' };
        const openaiModel = selectedModel('openai', opts);
        const respProfile = settingsStore.get('responseProfile') || 'balanced';
        // reasoning_effort is only honoured by reasoning models.
        const isReasoningModel = /^o[134]/.test(openaiModel) || /thinking|reasoning/.test(openaiModel);
        const openaiBody = { model: openaiModel, max_tokens: 4096, messages: [{role:'system',content:sysMsg},...messages] };
        if (isReasoningModel) {
          if (respProfile === 'deep') openaiBody.reasoning_effort = 'high';
          else if (respProfile === 'fast') openaiBody.reasoning_effort = 'low';
          // balanced: leave unset → provider default (medium)
        }
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify(openaiBody)
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: openaiModel, usage: _usage(d,'openai') };
      }
      case 'gemini': {
        const k = keysStore.get('k_gemini');
        if (!k) return { error: lang==='ru'?'Ключ Gemini не задан. Бесплатно: aistudio.google.com':'Gemini key not set. Free at aistudio.google.com' };
        const model = selectedModel('gemini', opts);

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

        const respProfile = settingsStore.get('responseProfile') || 'balanced';
        const generationConfig = { maxOutputTokens:4096, temperature:0.7 };
        // Gemini 2.5+ exposes a `thinkingConfig`. budget = -1 → dynamic (model
        // decides). budget = 0 → no thinking, fastest path. Older 2.0 / 1.x
        // models don't support the field at all.
        if (/^gemini-(2\.5|3)/.test(model)) {
          if (respProfile === 'deep') generationConfig.thinkingConfig = { thinkingBudget: -1 };
          else if (respProfile === 'fast') generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${k}`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ system_instruction:{parts:[{text:sysMsg}]}, contents, generationConfig })
        });
        const d = await r.json();
        if (d.error) return { error: d.error.message };
        const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          // Blocked or empty response
          const reason = d.candidates?.[0]?.finishReason || d.promptFeedback?.blockReason || 'empty response';
          return { error: `Gemini: ${reason}. Check your API key at aistudio.google.com` };
        }
        return { reply: text, model, usage: _usage(d,'gemini') };
      }
      case 'groq': {
        const k = keysStore.get('k_groq');
        if (!k) return { error: lang==='ru'?'Ключ Groq не задан. Бесплатно: groq.com':'Groq key not set. Free at groq.com' };
        const groqModel = selectedModel('groq', opts);
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify({ model:groqModel, max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: groqModel, usage: _usage(d,'groq') };
      }
      case 'grok': {
        const k = keysStore.get('k_grok');
        if (!k) return { error: lang==='ru'?'Ключ Grok (xAI) не задан → console.x.ai':'Grok (xAI) key not set → console.x.ai' };
        // Keep Grok model selection centralized with the rest of the providers.
        const grokModel = selectedModel('grok', opts);
        const r = await fetch('https://api.x.ai/v1/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify({ model:grokModel, max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: grokModel, usage: _usage(d,'grok') };
      }
      case 'deepseek': {
        const k = keysStore.get('k_deepseek');
        if (!k) return { error: lang==='ru'?'Ключ DeepSeek не задан → platform.deepseek.com':'DeepSeek key not set → platform.deepseek.com' };
        // 'deepseek-chat' is the cheap-fast alias (currently → V3.1). For the
        const deepseekModel = selectedModel('deepseek', opts);
        const r = await fetch('https://api.deepseek.com/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify({ model:deepseekModel, max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: deepseekModel, usage: _usage(d,'deepseek') };
      }
      case 'mistral': {
        const k = keysStore.get('k_mistral');
        if (!k) return { error: lang==='ru'?'Ключ Mistral не задан → console.mistral.ai':'Mistral key not set → console.mistral.ai' };
        const mistralModel = selectedModel('mistral', opts);
        const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify({ model:mistralModel, max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: mistralModel, usage: _usage(d,'mistral') };
      }
      case 'qwen': {
        const k = keysStore.get('k_qwen');
        if (!k) return { error: lang==='ru'?'Ключ Qwen не задан → dashscope.aliyuncs.com':'Qwen key not set → dashscope.aliyuncs.com' };
        // qwen-plus is the cheap workhorse. qwen3-max is the flagship.
        const qwenModel = selectedModel('qwen', opts);
        const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify({ model:qwenModel, max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
        });
        const d = await r.json(); if (d.error) return { error: d.error.message };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: qwenModel, usage: _usage(d,'qwen') };
      }
      case 'perplexity': {
        const k = keysStore.get('k_perplexity');
        if (!k) return { error: lang==='ru'?'Ключ Perplexity не задан → perplexity.ai/settings/api':'Perplexity key not set → perplexity.ai/settings/api' };
        // Sonar models hit the live web for grounded answers — different
        // cost/latency profile than other providers but the OpenAI-shape
        // /chat/completions endpoint is the same.
        const pplxModel = selectedModel('perplexity', opts);
        const r = await fetch('https://api.perplexity.ai/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify({ model:pplxModel, max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
        });
        const d = await r.json(); if (d.error) return { error: d.error.message || d.error };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: pplxModel, usage: _usage(d,'perplexity') };
      }
      case 'cohere': {
        const k = keysStore.get('k_cohere');
        if (!k) return { error: lang==='ru'?'Ключ Cohere не задан → dashboard.cohere.com':'Cohere key not set → dashboard.cohere.com' };
        const cohereModel = selectedModel('cohere', opts);
        // Cohere v2 chat API: takes `messages` (system role supported), returns
        // d.message.content[0].text. Different shape from OpenAI-compatible.
        const r = await fetch('https://api.cohere.com/v2/chat', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
          body:JSON.stringify({ model:cohereModel, messages:[{role:'system',content:sysMsg},...messages], max_tokens:4096 })
        });
        const d = await r.json(); if (d.message?.error || d.error) return { error: d.message?.error || d.error || 'Cohere error' };
        const text = d.message?.content?.[0]?.text || d.text || 'No response';
        return { reply: text, model: cohereModel, usage: _usage(d,'cohere') };
      }
      case 'openrouter': {
        const k = keysStore.get('k_openrouter');
        if (!k) return { error: lang==='ru'?'Ключ OpenRouter не задан → openrouter.ai/keys':'OpenRouter key not set → openrouter.ai/keys' };
        // OpenRouter is a router across 200+ models behind one OpenAI-compatible
        // endpoint. The HTTP-Referer + X-Title headers are recommended by their
        // attribution policy and unlock the per-app analytics page.
        const orModel = selectedModel('openrouter', opts);
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${k}`,
            'HTTP-Referer': 'https://horizonaai.dev',
            'X-Title': 'Horizon Genesis',
          },
          body: JSON.stringify({ model: orModel, max_tokens: 4096, messages: [{role:'system',content:sysMsg},...messages] })
        });
        const d = await r.json();
        if (d.error) return { error: d.error.message || d.error };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: orModel, usage: _usage(d,'openrouter') };
      }
      case 'ollama':
      case 'lmstudio':
      case 'localai': {
        const ep = localOpenAIEndpoint(provider);
        const headers = { 'Content-Type': 'application/json' };
        if (ep.key) headers.Authorization = `Bearer ${ep.key}`;
        const r = await fetch(ep.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: selectedModel(provider, opts),
            max_tokens: 4096,
            messages: [{ role: 'system', content: sysMsg }, ...messages],
          }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) return { error: d.error?.message || d.error || `${provider} connection failed (${r.status})` };
        return { reply: d.choices?.[0]?.message?.content || 'No response', model: selectedModel(provider, opts), usage: _usage(d, provider) };
      }
      default: return { error: `Unknown provider: ${provider}` };
    }
  } catch(e) { return { error: `Network error: ${e.message}` }; }
}

ipcMain.handle('ai', runAiCompletion);

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

async function _streamClaude({ runId, sysMsg, messages, opts, abort }) {
  const model = selectedModel('claude', opts);
  const respProfile = settingsStore.get('responseProfile') || 'balanced';
  const k = keysStore.get('k_claude');
  if (!k) {
    _broadcast('ai:done', { runId, ok: false, error: 'Claude key not set → Settings' });
    return;
  }
  const body = { model, max_tokens: 4096, system: sysMsg, messages, stream: true };
  if (respProfile === 'deep') {
    body.thinking = { type: 'enabled', budget_tokens: 8000 };
    body.max_tokens = 16000;
  }
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': k,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (e) {
    _broadcast('ai:done', { runId, ok: false, error: 'Network: ' + e.message });
    return;
  }
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try { const j = await res.json(); errMsg = j.error?.message || errMsg; } catch (_) {}
    _broadcast('ai:done', { runId, ok: false, error: errMsg });
    return;
  }
  let fullText = '';
  let usage = null;
  let buf = '';
  try {
    for await (const chunk of res.body) {
      if (abort.signal.aborted) break;
      buf += chunk.toString('utf8');
      // Anthropic frames are separated by `\n\n`.
      const frames = buf.split(/\n\n/);
      buf = frames.pop() || '';
      for (const frame of frames) {
        const lines = frame.split('\n');
        let event = '';
        let data = '';
        for (const ln of lines) {
          if (ln.startsWith('event: ')) event = ln.slice(7).trim();
          else if (ln.startsWith('data: ')) data = ln.slice(6).trim();
        }
        if (!data) continue;
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) { continue; }
        if (event === 'content_block_delta') {
          const delta = parsed?.delta?.text || '';
          if (delta) {
            fullText += delta;
            _broadcast('ai:chunk', { runId, delta });
          }
        } else if (event === 'message_delta') {
          const u = parsed?.usage;
          if (u) {
            usage = {
              prompt: u.input_tokens || 0,
              completion: u.output_tokens || 0,
              total: (u.input_tokens || 0) + (u.output_tokens || 0),
            };
          }
        } else if (event === 'message_start') {
          const u = parsed?.message?.usage;
          if (u) {
            usage = {
              prompt: u.input_tokens || 0,
              completion: u.output_tokens || 0,
              total: (u.input_tokens || 0) + (u.output_tokens || 0),
            };
          }
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      _broadcast('ai:done', { runId, ok: false, error: 'aborted', aborted: true, fullText, model, usage });
      return;
    }
    _broadcast('ai:done', { runId, ok: false, error: 'Stream: ' + e.message, fullText, model, usage });
    return;
  }
  _broadcast('ai:done', { runId, ok: true, fullText, usage, model });
}

async function _streamOpenAI({ runId, sysMsg, messages, opts, abort }) {
  const model = selectedModel('openai', opts);
  const respProfile = settingsStore.get('responseProfile') || 'balanced';
  const k = keysStore.get('k_openai');
  if (!k) {
    _broadcast('ai:done', { runId, ok: false, error: 'OpenAI key not set' });
    return;
  }
  const isReasoningModel = /^o[134]/.test(model) || /thinking|reasoning/.test(model);
  const body = {
    model,
    max_tokens: 4096,
    messages: [{ role: 'system', content: sysMsg }, ...messages],
    stream: true,
    stream_options: { include_usage: true },
  };
  if (isReasoningModel) {
    if (respProfile === 'deep') body.reasoning_effort = 'high';
    else if (respProfile === 'fast') body.reasoning_effort = 'low';
  }
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (e) {
    _broadcast('ai:done', { runId, ok: false, error: 'Network: ' + e.message });
    return;
  }
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try { const j = await res.json(); errMsg = j.error?.message || errMsg; } catch (_) {}
    _broadcast('ai:done', { runId, ok: false, error: errMsg });
    return;
  }
  let fullText = '';
  let usage = null;
  let buf = '';
  try {
    for await (const chunk of res.body) {
      if (abort.signal.aborted) break;
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('data: ')) continue;
        const data = t.slice(6).trim();
        if (data === '[DONE]') continue;
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) { continue; }
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          _broadcast('ai:chunk', { runId, delta });
        }
        if (parsed?.usage) {
          const u = parsed.usage;
          usage = {
            prompt: u.prompt_tokens || 0,
            completion: u.completion_tokens || 0,
            total: u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0)),
          };
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      _broadcast('ai:done', { runId, ok: false, error: 'aborted', aborted: true, fullText, model, usage });
      return;
    }
    _broadcast('ai:done', { runId, ok: false, error: 'Stream: ' + e.message, fullText, model, usage });
    return;
  }
  _broadcast('ai:done', { runId, ok: true, fullText, usage, model });
}

async function _disabledLegacyAiStreamHandler(_, messages, provider, system, opts) {
  // Build sysMsg the same way the non-streaming `ai` handler does — both
  // identity injection and persona injection must stay in sync. Cheapest
  // approach: call our internal builder via shared helper that the `ai`
  // handler also uses. Currently it's inline in `ai`, so duplicate the
  // exact same logic here. (TODO: extract to a shared _buildSysMsg().)
  const userName = settingsStore.get('userName') || 'user';
  const lang = settingsStore.get('lang') || 'en';
  const identity = lang === 'ru'
    ? `Ты — Хорайзон (Horizon AI), продвинутый персональный AI-агент для ПК. Тебя создал Эрнест Костевич (Ernest Kostevich). Ты НЕ являешься Claude, ChatGPT, Gemini или любым другим AI — ты Хорайзон. Пользователь: ${userName}. Время: ${new Date().toLocaleString()}. Ты умный, дружелюбный, немного как Джарвис из Marvel. Можешь управлять ПК, видеть экран. Используй Markdown.`
    : `You are Horizon AI — an advanced personal desktop agent. You were created by Ernest Kostevich. You are NOT Claude, ChatGPT, Gemini, or any other AI — you are Horizon. User: ${userName}. Time: ${new Date().toLocaleString()}. You are intelligent, friendly, somewhat like JARVIS from Marvel. You can control the PC, see the screen. Use Markdown.`;
  let personaPrompt = '';
  try {
    loadAgentModules();
    if (personas) {
      const personaId = settingsStore.get('persona') || 'jarvis';
      const pp = personas.getPersonaPrompt(personaId, lang);
      if (pp && (!system || !system.includes(pp.slice(0, 32)))) personaPrompt = pp;
    }
  } catch (_) {}
  const sysParts = [identity];
  if (personaPrompt) sysParts.push(personaPrompt);
  if (system && (!system.includes('Ты') && !system.includes('You are'))) sysParts.push(system);
  else if (system) { sysParts.length = 0; sysParts.push(system); }
  const sysMsg = sysParts.join('\n\n');

  const runId = _streamRunId();
  const abort = new AbortController();
  _activeStreams.set(runId, abort);
  // Cleanup on done.
  const cleanup = () => _activeStreams.delete(runId);

  // Don't await — the IPC call returns runId immediately so the renderer
  // can wire up listeners and start rendering. The actual stream runs
  // in the background and broadcasts via webContents.
  const fn = provider === 'claude' ? _streamClaude
            : provider === 'openai' ? _streamOpenAI
            : null;
  if (!fn) {
    cleanup();
    return { ok: false, error: `Streaming not supported for provider "${provider}". Use H.ai for non-streaming providers.` };
  }
  setImmediate(async () => {
    try {
      await fn({ runId, sysMsg, messages, opts: opts || {}, abort });
    } catch (e) {
      _broadcast('ai:done', { runId, ok: false, error: e?.message || String(e) });
    } finally {
      cleanup();
    }
  });
  return { ok: true, runId };
}

ipcMain.handle('aiAbort', (_, runId) => {
  const ctl = _activeStreams.get(runId);
  if (!ctl) return { ok: false, error: 'no active stream for runId' };
  try { ctl.abort(); } catch (_) {}
  _activeStreams.delete(runId);
  return { ok: true };
});

// ═══════════════════════════════════════════════════════════════════════════════
// HORIZON V12 — FULL AGENT CAPABILITIES
// ═══════════════════════════════════════════════════════════════════════════════

let agentTools = null;
let agentMemory = null;
let chatStore = null;
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

ipcMain.handle('mcpServersList', async () => {
  loadAgentModules();
  if (!mcpRegistry) return { ok: false, error: 'MCP registry not loaded', servers: [] };
  return { ok: true, servers: await mcpRegistry.listServers() };
});

ipcMain.handle('mcpServerUpsert', async (_, config) => {
  loadAgentModules();
  if (!mcpRegistry) return { ok: false, error: 'MCP registry not loaded' };
  try { return { ok: true, server: await mcpRegistry.upsertServer(config) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('mcpServerRemove', async (_, id) => {
  loadAgentModules();
  if (!mcpRegistry) return { ok: false, error: 'MCP registry not loaded' };
  try { await mcpRegistry.removeServer(id); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('mcpServerEnable', async (_, id, enabled) => {
  loadAgentModules();
  if (!mcpRegistry) return { ok: false, error: 'MCP registry not loaded' };
  try { return { ok: true, server: await mcpRegistry.setEnabled(id, enabled) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('mcpServerTest', async (_, config) => {
  loadAgentModules();
  if (!mcpRegistry) return { ok: false, error: 'MCP registry not loaded' };
  try { return await mcpRegistry.testServer(config); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('mcpToolsRefresh', async () => {
  loadAgentModules();
  if (!mcpRegistry) return { ok: false, error: 'MCP registry not loaded' };
  try { return { ok: true, tools: await mcpRegistry.refreshTools() }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('agentControl', async (event, runId, action) => {
  const run = findActiveRun(runId);
  if (!run) return { ok: false, error: 'No active agent run' };
  // PR-Plan-Act — approve-plan / reject-plan resolve the pending
  // plan-pending Promise stored in _planActPending for this run.
  // approve-plan optionally takes a follow-up flag to make the run
  // Always-approve for the rest of the session.
  if (action === 'approve-plan' || action === 'reject-plan') {
    const pending = _planActPending.get(runId);
    if (!pending) return { ok: false, error: 'No plan-pending state for run' };
    if (action === 'approve-plan') {
      pending.resolve('approve');
      _planActApprovedRuns.add(runId);
      const payload = { type: 'plan-decision', runId, decision: 'approve' };
      run.observe(payload);
      broadcastAgentStep(payload, event.sender);
      return { ok: true };
    } else {
      pending.resolve('reject');
      const payload = { type: 'plan-decision', runId, decision: 'reject' };
      run.observe(payload);
      broadcastAgentStep(payload, event.sender);
      // Also stop the run so no tools execute.
      try { run.stop(); } catch (_) {}
      return { ok: true };
    }
  }
  let result;
  if (action === 'pause') result = run.pause();
  else if (action === 'resume') result = run.resume();
  else if (action === 'step') result = run.step();
  else if (action === 'stop') result = run.stop();
  else return { ok: false, error: `Unknown agent control: ${action}` };
  const payload = { type: 'control', runId: run.record.id, action, status: run.record.status, currentStepId: run.record.currentStepId || null };
  run.observe(payload);
  broadcastAgentStep(payload, event.sender);
  return result;
});

// PR-Plan-Act — registry of runs that have an outstanding plan-pending
// gate, plus a per-session set of runs the user has Approved-All-Plans
// on. Runs in the latter skip the gate for subsequent executing steps.
const _planActPending = new Map(); // runId → { resolve, reject, broadcastedAt }
const _planActApprovedRuns = new Set();

ipcMain.handle('agentStep', async (_, stepId, decision) => {
  const run = pendingAgentSteps.get(stepId);
  if (!run) return { ok: false, error: 'No waiting step for this id' };
  return run.resolveStep(stepId, decision);
});

ipcMain.handle('permissionAllowlistList', async () => ({
  ok: true,
  entries: getPermissionAllowlist(),
}));

ipcMain.handle('permissionAllowlistRevoke', async (_, id) => ({
  ok: true,
  revoked: revokePermissionAllowlist(String(id || '')),
  entries: getPermissionAllowlist(),
}));

ipcMain.handle('agentRuns', async (_, limit = 50) => {
  const active = [...activeAgentRuns.values()].map(r => compactAgentRun(r.record)).reverse();
  return { ok: true, active, history: readAgentRuns(limit).map(compactAgentRun) };
});

ipcMain.handle('agentRunDetails', async (_, runId) => {
  const active = activeAgentRuns.get(runId);
  if (active) return { ok: true, run: scrubRunValue(active.record), active: true };
  const found = readAgentRuns(200).find(r => r.id === runId);
  return found ? { ok: true, run: found, active: false } : { ok: false, error: 'Run not found' };
});

ipcMain.handle('agentRun', async (event, userMessage, opts = {}) => {
  loadAgentModules();

  if (!agentLoop) {
    return { ok: false, error: 'Agent module not loaded', steps: [] };
  }

  const runId = opts.runId || `agent-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  // Register this top-level run at depth 0 so any spawn_subagent calls
  // can compute their depth relative to it. Cleaned up in the finally
  // block when the run ends (whether ok, errored, or stopped).
  subagentDepthByRunId.set(runId, 0);
  const provider = opts.provider || settingsStore.get('provider') || 'gemini';
  const lang     = settingsStore.get('lang') || 'en';
  const userName = settingsStore.get('userName') || 'User';
  const runRecord = {
    id: runId,
    prompt: String(userMessage || ''),
    provider,
    model: opts.model || selectedModel(provider, opts),
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    steps: [],
    events: [],
  };
  const controller = new AgentRunController(runRecord);
  activeAgentRuns.set(runId, controller);

  // Get system info for agent context
  let sysInfo = null;
  try { sysInfo = await agentTools.getDetailedSysInfo(); } catch(e) {}
  sysInfo = sysInfo || {};
  if (agentMemory) {
    try {
      // Prefer semantic recall when embeddings are available — paraphrased
      // queries (e.g. "what's my project name" vs the stored fact
      // "user told me they work on Horizon Genesis") now surface their
      // matching memory. Falls back to keyword recall on missing key or
      // embedding failure, no regression.
      // Tell AgentMemory which persona is active so any remember()
      // call during this turn is tagged correctly. PHASE 7/8.
      const personaForMemory = opts.personaId || settingsStore.get('persona') || 'jarvis';
      if (typeof agentMemory.setActivePersona === 'function') {
        agentMemory.setActivePersona(personaForMemory);
      }
      const relevant = (typeof agentMemory.semanticRecall === 'function')
        ? await agentMemory.semanticRecall(userMessage, 8, { activePersona: personaForMemory }).catch(() => agentMemory.recall(userMessage, 8))
        : agentMemory.recall(userMessage, 8);
      sysInfo.memory = {
        facts: agentMemory.getAllFacts(),
        relevant,
        recentConversations: agentMemory.searchConversations(userMessage, 5),
        // PHASE 5/8 memory: user profile block (Big Five + style) ready
        // to inject into the system prompt. Empty string when confidence
        // is still below the 0.2 threshold (we don't invent a profile
        // we can't justify).
        userProfileBlock: typeof agentMemory.buildUserProfileBlock === 'function'
          ? agentMemory.buildUserProfileBlock()
          : '',
      };
    } catch (_) {}
  }
  // PHASE 8/8 — workspace memory injection. Read .horizon/memory.json
  // from the active workspace and pass the rendered block to
  // agentLoop so it lands in the system prompt right after rules.md.
  try {
    const ws = currentWorkspaceRoot();
    if (ws) {
      const block = _getWorkspaceMemory().buildSystemBlock(ws);
      if (block) sysInfo.workspaceMemoryBlock = block;
    }
  } catch (_) {}
  if (githubConnector) {
    try { sysInfo.github_repos = githubConnector.listRepos(); } catch (_) {}
  }
  if (connectionsManager) {
    try { sysInfo.connections = connectionsManager.list().filter(c => c.connected).map(c => ({ id: c.id, name: c.name, toolCount: c.toolCount })); } catch (_) {}
  }
  if (googleAuth) {
    try {
      sysInfo.google_workspace = { connected: Boolean(googleAuth.isAuthenticated?.()) };
      if (sysInfo.google_workspace.connected) await ensureGoogleWorkspaceTools().catch(() => null);
    } catch (_) {}
  }

  // AI function wrapper
  const aiFn = async (messages, systemPrompt, agentMeta = {}) => {
    const fetch = require('node-fetch');
    const localEp = localOpenAIEndpoint(provider);
    const k = localEp ? (localEp.key || '__local_no_key__') : keysStore.get(`k_${provider}`);
    if (!k) return { error: `${provider} key not set → Settings` };

    try {
      if (provider === 'gemini') {
        const model = selectedModel('gemini', opts);
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
        const geminiBody = applyReasoningProfile('gemini', model, {
          system_instruction:{parts:[{text:systemPrompt}]},
          contents:fixed,
          generationConfig:{maxOutputTokens:4096}
        });
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${k}`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify(geminiBody)
        });
        const d = await r.json();
        if (d.error) return { error: d.error.message };
        return { reply: d.candidates?.[0]?.content?.parts?.[0]?.text || 'No response', model };
      }

      if (provider === 'claude') {
        const model = selectedModel('claude', opts);
        const useNativeTools = Boolean(agentMeta.nativeTools && agentMeta.tools?.length);
        const toolPack = useNativeTools ? nativeToolPack(agentMeta.tools) : { tools: [], map: {} };
        const body = applyReasoningProfile('claude', model, {
          model,
          max_tokens:4096,
          system:systemPrompt,
          messages: useNativeTools ? toAnthropicMessages(messages) : messages
        });
        if (useNativeTools) body.tools = toAnthropicTools(toolPack.tools);
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':k,'anthropic-version':'2023-06-01'},
          body:JSON.stringify(body)
        });
        const d = await r.json();
        if (d.error) return { error: d.error.message };
        if (!d.content || !d.content[0]) return { error: 'Empty response from Claude' };
        const toolCalls = mapNativeToolCalls(parseAnthropicToolCalls(d), toolPack.map);
        const text = (d.content || []).find(b => b && b.type === 'text')?.text || '';
        return { reply: text || (toolCalls.length ? '' : firstTextFromAnthropic(d)), toolCalls, model };
      }

      // OpenAI-compatible (openai, groq, grok, deepseek, mistral, qwen, perplexity, cohere)
      const endpoints = {
        openai:     { url:'https://api.openai.com/v1/chat/completions',                    model:selectedModel('openai', opts) },
        groq:       { url:'https://api.groq.com/openai/v1/chat/completions',               model:selectedModel('groq', opts) },
        grok:       { url:'https://api.x.ai/v1/chat/completions',                          model:selectedModel('grok', opts) },
        deepseek:   { url:'https://api.deepseek.com/chat/completions',                     model:selectedModel('deepseek', opts) },
        mistral:    { url:'https://api.mistral.ai/v1/chat/completions',                    model:selectedModel('mistral', opts) },
        qwen:       { url:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model:selectedModel('qwen', opts) },
        perplexity: { url:'https://api.perplexity.ai/chat/completions',                    model:selectedModel('perplexity', opts) },
        openrouter: { url:'https://openrouter.ai/api/v1/chat/completions',                 model:selectedModel('openrouter', opts) },
      };
      const ep = localEp || endpoints[provider] || endpoints.openai;
      const headers = {'Content-Type':'application/json'};
      if (!localEp || localEp.key) headers.Authorization = `Bearer ${k}`;
      if (provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://horizonaai.dev';
        headers['X-Title'] = 'Horizon Genesis';
      }
      if (provider === 'cohere') {
        const model = selectedModel('cohere', opts);
        const r = await fetch('https://api.cohere.com/v2/chat', {
          method:'POST',
          headers,
          body:JSON.stringify({ model, messages:[{role:'system',content:systemPrompt},...messages], max_tokens:4096 })
        });
        const d = await r.json();
        if (d.message?.error || d.error) return { error: d.message?.error || d.error || 'Cohere error' };
        return { reply: d.message?.content?.[0]?.text || d.text || 'No response', model };
      }
      const useNativeOpenAITools = provider === 'openai' && Boolean(agentMeta.nativeTools && agentMeta.tools?.length);
      const toolPack = useNativeOpenAITools ? nativeToolPack(agentMeta.tools) : { tools: [], map: {} };
      const body = applyReasoningProfile(provider, ep.model, {
        model:ep.model,
        max_tokens:4096,
        messages: useNativeOpenAITools ? toOpenAIChatMessages(messages, systemPrompt) : [{role:'system',content:systemPrompt},...messages]
      });
      if (useNativeOpenAITools) body.tools = toOpenAITools(toolPack.tools);
      const r = await fetch(ep.url, {
        method:'POST',
        headers,
        body:JSON.stringify(body)
      });
      const d = await r.json();
      if (d.error) return { error: d.error.message };
      if (!d.choices || !d.choices[0]) return { error: `Empty response from ${provider}` };
      const message = d.choices[0].message || {};
      const toolCalls = useNativeOpenAITools ? mapNativeToolCalls(parseOpenAIToolCalls(message), toolPack.map) : [];
      return { reply: message.content || '', toolCalls, model: ep.model };

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

  let mcpTools = [];
  if (mcpRegistry && settingsStore.get('mcp.enabled') !== false) {
    try { mcpTools = await mcpRegistry.toolsForAgent(); }
    catch (e) { console.warn('MCP tools unavailable:', e.message); }
  }

  // Plugin tools — pluginManager.getToolDefinitions() returns the list of
  // tool descriptors from every enabled plugin's manifest in the format
  // the agent loop already understands (`{name, desc, params, _plugin}`).
  // Without this branch the agent never *saw* installed plugins and the
  // user's complaint that "all plugins are stubs that don't do anything"
  // was correct — even a fully-implemented Spotify plugin had no path
  // from the LLM's tool call to its handler. Dispatch routes plugin
  // tools (prefixed `plugin.<id>.<tool>` or matched via _plugin marker)
  // to pluginManager.executeTool().
  let pluginTools = [];
  if (pluginManager && typeof pluginManager.getToolDefinitions === 'function') {
    try { pluginTools = pluginManager.getToolDefinitions() || []; }
    catch (e) { console.warn('Plugin tools unavailable:', e.message); }
  }

  let connectionTools = [];
  if (connectionsManager && typeof connectionsManager.toolsForAgent === 'function') {
    try { connectionTools = connectionsManager.toolsForAgent() || []; }
    catch (e) { console.warn('Connection tools unavailable:', e.message); }
  }
  connectionTools.push(...googleConnectionToolsForAgent(), ...githubConnectionToolsForAgent());

  const activePersonaId = settingsStore.get('persona') || 'jarvis';
  let allowedToolGroups = null;
  try {
    if (personas && typeof personas.getPersonaFull === 'function') {
      const personaFull = personas.getPersonaFull(activePersonaId);
      if (Array.isArray(personaFull?.allowedTools)) allowedToolGroups = personaFull.allowedTools;
    }
  } catch (_) {}
  const personaAllowsTool = (toolName) => {
    if (!agentLoop?.toolAllowedByPersona) return true;
    return agentLoop.toolAllowedByPersona(toolName, allowedToolGroups);
  };

  const dispatchToolFn = async (tool, args) => {
    if (!personaAllowsTool(tool)) {
      return {
        ok: false,
        err: `Tool ${tool} is disabled for persona ${activePersonaId}`,
        error: `Tool ${tool} is disabled for persona ${activePersonaId}`,
      };
    }
    if (mcpRegistry && String(tool || '').includes('__')) {
      const mcpResult = await mcpRegistry.dispatch(tool, args);
      if (mcpResult) return mcpResult;
    }
    const connToolName = String(tool || '');
    if (connToolName.startsWith('conn_google_')) {
      return dispatchGoogleConnectionTool(connToolName, args || {});
    }
    if (connToolName.startsWith('conn_github_')) {
      return dispatchGithubConnectionTool(connToolName, args || {});
    }
    if (connToolName.startsWith('conn_') && connectionsManager) {
      const connResult = await connectionsManager.dispatch(tool, args || {});
      if (connResult) return connResult;
    }
    // Plugin tool name format from pluginManager.getToolDefinitions():
    // `plugin_<pluginId>_<toolName>`. Look up the descriptor by name in
    // the pluginTools list (richer match — pluginId might itself contain
    // underscores, so we can't safely split blindly). Fall through to
    // built-in tools when not found.
    const t = String(tool || '');
    if (t.startsWith('plugin_') && pluginManager) {
      const def = pluginTools.find(d => d && d.name === t);
      if (def && def.pluginId) {
        const toolName = t.slice(`plugin_${def.pluginId}_`.length);
        try {
          const r = await pluginManager.executeTool(def.pluginId, toolName, args || {});
          return r;
        } catch (e) {
          return { ok: false, error: 'Plugin tool failed: ' + (e?.message || e) };
        }
      }
    }
    // Pass runId/event so spawn_subagent (in agent.js dispatchTool) knows
    // its parent context for depth tracking + step broadcasting.
    return agentTools.dispatchTool(tool, args, { runId, event });
  };

  // Send step updates to renderer via the event sender.
  // PR-Plan-Act — when planActGate setting is on AND this is the run's
  // first 'executing' step, broadcast a `plan-pending` step instead
  // and pause until the user clicks Approve plan / Reject plan in
  // the renderer (resolves the Promise via agentControl IPC).
  const planActGateOn = settingsStore.get('planActGate') === true;
  let firstExecutingSeen = false;
  const onStep = async (step) => {
    if (planActGateOn
        && step?.type === 'executing'
        && !firstExecutingSeen
        && !_planActApprovedRuns.has(runId)) {
      firstExecutingSeen = true;
      // Broadcast the first executing step as a `plan-pending` event
      // so the renderer can render the step-rail-gate UI.
      const planPending = {
        type: 'plan-pending',
        runId,
        firstTool: step.tool,
        firstArgs: step.args,
        reason: step.reason,
      };
      controller.observe(planPending);
      broadcastAgentStep(planPending, event.sender);
      // Wait for the user's decision via agentControl(runId, 'approve-plan'|'reject-plan')
      const decision = await new Promise((resolve) => {
        _planActPending.set(runId, { resolve, broadcastedAt: Date.now() });
      });
      _planActPending.delete(runId);
      if (decision === 'reject') {
        // Run was already stop()'d by the IPC handler; emit a
        // plan-rejected step so the renderer cleans up its UI, then
        // bail without dispatching the original step.
        const rejected = { type: 'plan-rejected', runId };
        controller.observe(rejected);
        broadcastAgentStep(rejected, event.sender);
        return;
      }
      // approved → fall through to the normal observe + broadcast path.
    }
    controller.observe(step);
    broadcastAgentStep(step, event.sender);
  };

  let result;
  try {
    const startStep = { type: 'run-start', runId, provider, model: runRecord.model, prompt: runRecord.prompt };
    controller.observe(startStep);
    broadcastAgentStep(startStep, event.sender);
    // Resolve any Claude Code-style skills matching the user's message and
    // pass them to the agent loop. forcedSkillIds (from `/skill <name>` slash
    // command) live in opts.forcedSkillIds passed by the renderer.
    let skillsBlock = '';
    let skillsSelected = null;
    if (skillsManager) {
      try {
        const res = skillsManager.getSkillsBlock(userMessage, {
          forcedIds: Array.isArray(opts.forcedSkillIds) ? opts.forcedSkillIds : [],
        });
        skillsBlock = res.block || '';
        skillsSelected = {
          selected: (res.selected || []).map(s => ({ id: s.id, score: s.score, breakdown: s.breakdown, scope: s.scope, forced: s.forced, truncated: s.truncated, bytes: s.bytes })),
          scored: (res.scored || []).map(s => ({ id: s.id, score: s.score, breakdown: s.breakdown, scope: s.scope, forced: s.forced })),
        };
        skillsManager.recordUsage(skillsSelected.selected.map(s => s.id), userMessage, 'selected');
        // Emit a dedicated step so the inspector can render a "Skills loaded"
        // panel. Same channel agentLoop uses for tool dispatches, so the
        // renderer's existing onAgentStep listener picks it up.
        const skillsStep = { type: 'skills-selected', runId, payload: skillsSelected };
        controller.observe(skillsStep);
        broadcastAgentStep(skillsStep, event.sender);
      } catch (e) {
        console.warn('skills resolve failed:', e.message);
      }
    }

    result = await agentLoop.runAgentLoop(userMessage, {
      aiFn,
      sysInfo,
      lang,
      userName,
      history: opts.history || [],
      maxSteps: opts.maxSteps || 8,
      onStep,
      analyzeScreenFn: screenCapFn,
      runId,
      control: controller,
      nativeTools: provider === 'claude' || provider === 'openai',
      extraTools: [...mcpTools, ...pluginTools, ...connectionTools],
      personaId: activePersonaId,
      allowedToolGroups,
      dispatchToolFn,
      skillsBlock,
      skillsSelected
    });
  } catch (e) {
    result = { ok: false, error: e.message, steps: runRecord.steps };
  } finally {
    runRecord.status = controller.stopped || result?.stopped ? 'stopped' : (result?.ok ? 'done' : 'error');
    runRecord.endedAt = new Date().toISOString();
    runRecord.answer = result?.answer || null;
    runRecord.error = result?.error || null;
    activeAgentRuns.delete(runId);
    subagentDepthByRunId.delete(runId);
    if (controller.pending) pendingAgentSteps.delete(controller.pending.stepId);
    const endStep = { type: 'run-end', runId, status: runRecord.status, result: scrubRunValue(result) };
    controller.observe(endStep);
    appendAgentRun(runRecord);
    broadcastAgentStep(endStep, event.sender);
  }

  // Save to memory
  if (agentMemory) {
    try {
      if (typeof agentMemory.learnFromTurn === 'function') {
        agentMemory.learnFromTurn(userMessage, result?.answer || result?.error || '', {
          provider,
          model: runRecord.model,
          persona: activePersonaId,
          runId,
        });
      } else {
        agentMemory.remember(`Task: ${userMessage}`, 'agent_task', 7);
        if (result.ok && result.answer) {
          agentMemory.remember(`Result: ${result.answer.slice(0, 200)}`, 'agent_result', 6);
        }
      }
    } catch (e) {
      console.warn('Memory learning failed:', e.message);
    }
  }

  // PHASE Auto-skill suggester — feed the suggester after each turn so
  // it can detect repeated query patterns / partial goals. Suggestions
  // are broadcast to all renderer windows as `skill:suggestion` events.
  if (skillSuggester) {
    try {
      // Refresh known-skill ids so we don't suggest a skill name that
      // already exists.
      if (skillsManager && typeof skillsManager.list === 'function') {
        skillSuggester.setKnownSkills((skillsManager.list() || []).map(s => s.id));
      }
      // Find the latest reflection step for this run to feed goal_met.
      // run-end carries result; reflection step has goalMet. We use the
      // final answer + (if any) the cached reflection from the agent loop.
      skillSuggester.ingestTurn(userMessage, {
        goalMet: result?.reflection?.goalMet || null,
        answer: result?.answer || '',
        runId,
      });
    } catch (e) {
      console.warn('SkillSuggester ingestTurn failed:', e.message);
    }
  }

  return { ...result, runId };
});

// ── DIRECT TOOL CALLS (from chat toolbar/quick actions) ──────────────────────
ipcMain.handle('agentTool', async (event, toolName, args) => {
  loadAgentModules();
  if (!agentTools) return { ok: false, err: 'Agent not loaded' };
  if (mcpRegistry && String(toolName || '').includes('__')) {
    const mcpResult = await mcpRegistry.dispatch(toolName, args);
    if (mcpResult) return mcpResult;
  }
  const tool = String(toolName || '');
  if (tool.startsWith('conn_google_')) {
    return withPermission(
      event.sender,
      tool,
      args || {},
      'Run Google connection tool',
      () => dispatchGoogleConnectionTool(tool, args || {})
    );
  }
  if (tool.startsWith('conn_github_')) {
    return withPermission(
      event.sender,
      tool,
      args || {},
      'Run GitHub connection tool',
      () => dispatchGithubConnectionTool(tool, args || {})
    );
  }
  if (tool.startsWith('conn_') && connectionsManager) {
    return withPermission(
      event.sender,
      tool,
      args || {},
      'Run connection tool',
      () => connectionsManager.dispatch(tool, args || {})
    );
  }
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

// Embedding index status + manual reindex trigger. Used by the Learned tab
// to show "X/Y indexed" and the optional "Reindex now" button.
ipcMain.handle('memEmbedStatus', () => {
  loadAgentModules();
  if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
  try { return { ok: true, ...agentMemory.embeddingStatus() }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('memEmbedReindex', async () => {
  loadAgentModules();
  if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
  try {
    const r = await agentMemory.embedAllPending(progress => {
      try {
        const wins = BrowserWindow.getAllWindows();
        for (const w of wins) {
          if (w && !w.isDestroyed() && w.webContents) w.webContents.send('memory:embeddingProgress', progress);
        }
      } catch (_) {}
    });
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Single-shot snapshot for the inspector's Learned tab — facts + most-recent
// memories + learning.stats + user profile in one IPC roundtrip. Cheap
// because everything lives in-memory in AgentMemory._data.
ipcMain.handle('memSnapshot', (_, opts) => {
  loadAgentModules();
  if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
  const factLimit = Math.max(1, Math.min(200, Number(opts?.factLimit) || 50));
  const memLimit = Math.max(1, Math.min(200, Number(opts?.memLimit) || 30));
  try {
    // Project raw facts dict into UI-friendly array with provenance.
    const factsRaw = agentMemory._data?.facts || {};
    const factEntries = Object.entries(factsRaw)
      .map(([key, v]) => ({
        key,
        value: typeof v === 'object' && v !== null ? (v.value ?? '') : String(v ?? ''),
        seen: typeof v === 'object' && v !== null ? (v.seen || 0) : 0,
        updated: typeof v === 'object' && v !== null ? v.updated : null,
        source: typeof v === 'object' && v !== null ? (v.source || 'unknown') : 'unknown',
        lastSource: typeof v === 'object' && v !== null ? (v.lastSource || v.source || 'unknown') : 'unknown',
      }))
      .sort((a, b) => (b.updated || 0) - (a.updated || 0))
      .slice(0, factLimit);
    const recent = typeof agentMemory.getRecent === 'function' ? agentMemory.getRecent(memLimit) : [];
    const stats = agentMemory._data?.learning?.stats || {};
    const userProfile = typeof agentMemory.getUserProfile === 'function' ? agentMemory.getUserProfile() : null;
    return {
      ok: true,
      facts: factEntries,
      memories: recent,
      userProfile,
      stats: {
        totalFacts: Object.keys(factsRaw).length,
        totalMemories: agentMemory._data?.memories?.length || 0,
        learnedItems: stats.learnedItems || 0,
        lastLearnedAt: stats.lastLearnedAt || null,
        conversations: agentMemory._data?.conversations?.length || 0,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Memory edit/forget + user profile IPC ───────────────────────────────
// Used by the Inspector → Learned tab edit/delete UI. Each handler returns
// {ok, ...} so the renderer can show success/failure inline.
ipcMain.handle('memForgetFact', (_, key) => {
  loadAgentModules();
  if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
  return { ok: agentMemory.forgetFact(String(key || '')) };
});

ipcMain.handle('memForgetMemory', (_, idOrKey) => {
  loadAgentModules();
  if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
  return { ok: agentMemory.forgetMemory(String(idOrKey || '')) };
});

ipcMain.handle('memEditFact', (_, key, value) => {
  loadAgentModules();
  if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
  return { ok: agentMemory.setFact(String(key || ''), String(value || ''), 'manual') };
});

ipcMain.handle('memEditMemory', (_, idOrKey, partial) => {
  loadAgentModules();
  if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
  return { ok: agentMemory.editMemory(String(idOrKey || ''), partial || {}) };
});

ipcMain.handle('memGetUserProfile', () => {
  loadAgentModules();
  if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
  return { ok: true, profile: agentMemory.getUserProfile() };
});

ipcMain.handle('memUpdateUserProfile', (_, partial) => {
  loadAgentModules();
  if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
  return { ok: true, profile: agentMemory.updateUserProfile(partial || {}, 'manual') };
});

// PHASE 6/8 — Full-text search across memories + facts + conversations.
ipcMain.handle('memFtsSearch', (_, query, limit) => {
  loadAgentModules();
  if (!agentMemory || typeof agentMemory.ftsSearch !== 'function') return { ok: false, error: 'fts unavailable' };
  return { ok: true, results: agentMemory.ftsSearch(String(query || ''), Math.max(1, Math.min(200, Number(limit) || 30))), stats: agentMemory.ftsStats?.() || {} };
});

ipcMain.handle('memFtsStats', () => {
  loadAgentModules();
  if (!agentMemory || typeof agentMemory.ftsStats !== 'function') return { ok: false, error: 'fts unavailable' };
  return { ok: true, stats: agentMemory.ftsStats() };
});

// PHASE 8/8 — Workspace memory (committable .horizon/memory.json).
ipcMain.handle('workspaceMemoryGet', () => {
  try {
    const root = currentWorkspaceRoot();
    if (!root) return { ok: false, error: 'no workspace open' };
    return { ok: true, root, ...(_getWorkspaceMemory().get(root)) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Executor status — used by Settings UI to show "Docker available · Y" /
// "Docker not installed · falling back to host". Read-only, no PRO gate.
ipcMain.handle('executorStatus', () => {
  loadAgentModules();
  if (!executor) return { ok: false, error: 'executor not loaded' };
  return { ok: true, ...executor.status() };
});

ipcMain.handle('workspaceMemoryWrite', (_, partial) => {
  try {
    const root = currentWorkspaceRoot();
    if (!root) return { ok: false, error: 'no workspace open' };
    return _getWorkspaceMemory().write(root, partial || {});
  } catch (e) { return { ok: false, error: e.message }; }
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

ipcMain.handle('githubAttachRepo', async (_, repoUrl) => {
  loadAgentModules();
  if (!githubConnector) return { ok: false, error: 'GitHub connector not loaded' };
  try { return { ok: true, repo: await githubConnector.attachRepo(repoUrl) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('githubListRepos', () => {
  loadAgentModules();
  return githubConnector ? githubConnector.listRepos() : [];
});
ipcMain.handle('githubRemoveRepo', (_, fullName) => {
  loadAgentModules();
  return githubConnector ? githubConnector.removeRepo(fullName) : false;
});
ipcMain.handle('githubRepoContext', async (_, fullName) => {
  loadAgentModules();
  if (!githubConnector) return { ok: false, error: 'GitHub connector not loaded' };
  try { return { ok: true, ...(await githubConnector.repoContext(fullName)) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('connectionsList', () => {
  loadAgentModules();
  try { return { ok: true, connections: connectionsManager ? connectionsManager.list() : [] }; }
  catch (e) { return { ok: false, error: e.message, connections: [] }; }
});

ipcMain.handle('connectionsTest', async (_, id) => {
  loadAgentModules();
  if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
  try { return await connectionsManager.testConnection(String(id || '')); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('connectionsSetLive', async (_, id, enabled) => {
  loadAgentModules();
  if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
  try {
    if (String(id || '') === 'telegram_bot') return await connectionsManager.setTelegramLive(!!enabled);
    return { ok: false, error: `Live runtime is not available for ${id}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('connectionsRuntimeStatus', async (_, id) => {
  loadAgentModules();
  if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
  try {
    if (String(id || '') === 'telegram_bot') return connectionsManager.telegramStatus();
    return { ok: false, error: `Runtime status is not available for ${id}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── TELEGRAM CHAT VIEWER ─────────────────────────────────────────────────
// Lets the desktop UI show the same chats the bot is having on Telegram.
// History is persisted per-chat in settingsStore (see connectionsManager
// TG_HISTORY_CAP); these handlers expose it + outbound send.
ipcMain.handle('tgListChats', () => {
  loadAgentModules();
  if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded', chats: [] };
  try { return connectionsManager.telegramListChats(); }
  catch (e) { return { ok: false, error: e.message, chats: [] }; }
});

ipcMain.handle('tgGetHistory', (_, chatId, limit) => {
  loadAgentModules();
  if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
  try { return connectionsManager.telegramGetHistory(chatId, limit); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('tgClearHistory', (_, chatId) => {
  loadAgentModules();
  if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
  try { return connectionsManager.telegramClearHistory(chatId); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('tgSendFromUI', async (_, chatId, text) => {
  loadAgentModules();
  if (!connectionsManager) return { ok: false, error: 'Connections manager not loaded' };
  try { return await connectionsManager.telegramSendFromUI(chatId, text); }
  catch (e) { return { ok: false, error: e.message }; }
});

// ── CHAT MANAGEMENT ──────────────────────────────────────────────────────────
ipcMain.handle('chatList', () => {
  loadAgentModules();
  try { return chatStore ? chatStore.list() : []; } catch (e) { return []; }
});
ipcMain.handle('chatGet', (_, id) => {
  loadAgentModules();
  try { return chatStore ? chatStore.get(id) : null; } catch (e) { return null; }
});
ipcMain.handle('chatCreate', (_, opts) => {
  loadAgentModules();
  try { return chatStore ? chatStore.create(opts) : null; } catch (e) { return null; }
});
ipcMain.handle('chatSwitch', (_, id) => {
  loadAgentModules();
  try { return chatStore ? chatStore.switchTo(id) : null; } catch (e) { return null; }
});
ipcMain.handle('chatRename', (_, id, title) => {
  loadAgentModules();
  try { return chatStore ? chatStore.rename(id, title) : false; } catch (e) { return false; }
});
ipcMain.handle('chatDelete', (_, id) => {
  loadAgentModules();
  try { return chatStore ? chatStore.remove(id) : { ok: false }; } catch (e) { return { ok: false }; }
});
ipcMain.handle('chatAddMessage', (_, id, role, content, meta) => {
  loadAgentModules();
  try { return chatStore ? chatStore.addMessage(id, role, content, meta) : { ok: false }; } catch (e) { return { ok: false }; }
});
ipcMain.handle('chatGetLogs', (_, id) => {
  loadAgentModules();
  try { return chatStore ? chatStore.getLogs(id) : { ok: false, logs: [] }; } catch (e) { return { ok: false, logs: [] }; }
});
ipcMain.handle('chatSetLogs', (_, id, logs) => {
  loadAgentModules();
  try { return chatStore ? chatStore.setLogs(id, logs) : { ok: false }; } catch (e) { return { ok: false }; }
});
ipcMain.handle('chatClearLogs', (_, id) => {
  loadAgentModules();
  try { return chatStore ? chatStore.clearLogs(id) : { ok: false }; } catch (e) { return { ok: false }; }
});
ipcMain.handle('chatGetCurrent', () => {
  loadAgentModules();
  try { return chatStore ? chatStore.getCurrent() : null; } catch (e) { return null; }
});

// ── CODE EXECUTION ────────────────────────────────────────────────────────────
ipcMain.handle('executeCode', async (event, code, language) => {
  loadAgentModules();
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
ipcMain.handle('smartClick', async (event, targetDescription) => withPermission(
  event.sender,
  'computer.smart_click',
  { target: String(targetDescription || '') },
  'Analyze screen and click target',
  async () => {
  loadAgentModules();
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

// ── BROWSER AUTOMATION ───────────────────────────────────────────────────────
ipcMain.handle('browserOpenUrl', async (event, url) => withPermission(
  event.sender,
  'browser.open',
  { url: String(url || '') },
  'Open browser URL',
  async () => {
  loadAgentModules();
  if (!browserManager) return { ok: false, error: 'Browser not loaded' };
  return browserManager.openUrl(url);
  }
));

ipcMain.handle('browserSearch', async (event, query, engine) => withPermission(
  event.sender,
  'browser.search',
  { query: String(query || ''), engine: engine || 'google' },
  'Search in browser',
  async () => {
  loadAgentModules();
  if (!browserManager) return { ok: false, error: 'Browser not loaded' };
  return browserManager.search(query, engine);
  }
));

ipcMain.handle('browserOpenSite', async (event, name) => withPermission(
  event.sender,
  'browser.open_site',
  { site: String(name || '') },
  'Open browser site',
  async () => {
  loadAgentModules();
  if (!browserManager) return { ok: false, error: 'Browser not loaded' };
  return browserManager.openSite(name);
  }
));

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

// Full persona shape (with prompts, memories, allowed tools) — used by
// the Personas editor in the renderer.
ipcMain.handle('getPersonaFull', (_, id) => {
  loadAgentModules();
  if (!personas || typeof personas.getPersonaFull !== 'function') return null;
  return personas.getPersonaFull(id);
});

// Upsert overlay (built-in edit OR new custom persona). Patch is partial.
ipcMain.handle('personaUpsert', (_, id, patch) => {
  loadAgentModules();
  if (!personas || typeof personas.upsertPersona !== 'function') {
    return { ok: false, error: 'Personas module unavailable' };
  }
  return personas.upsertPersona(id, patch || {});
});

// Delete overlay (resets built-in OR removes custom).
ipcMain.handle('personaDelete', (_, id) => {
  loadAgentModules();
  if (!personas || typeof personas.deletePersona !== 'function') {
    return { ok: false, error: 'Personas module unavailable' };
  }
  return personas.deletePersona(id);
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

// ── SKILLS (Claude Code-style markdown skills) ───────────────────────────────
ipcMain.handle('skillsList', () => {
  loadAgentModules();
  if (!skillsManager) return [];
  skillsManager.refreshIfStale();
  return skillsManager.list();
});

ipcMain.handle('skillsRead', (_, id, scope) => {
  loadAgentModules();
  if (!skillsManager) return '';
  return skillsManager.readSource(id, scope);
});

ipcMain.handle('skillsWrite', (_, id, content, scope) => {
  loadAgentModules();
  if (!skillsManager) return { ok: false, error: 'Skills manager not loaded' };
  return skillsManager.writeSource(id, content, scope);
});

ipcMain.handle('skillsToggle', (_, id, scope) => {
  loadAgentModules();
  if (!skillsManager) return { ok: false, error: 'Skills manager not loaded' };
  return skillsManager.toggleEnable(id, scope);
});

ipcMain.handle('skillsUninstall', (_, id, scope) => {
  loadAgentModules();
  if (!skillsManager) return { ok: false, error: 'Skills manager not loaded' };
  return skillsManager.uninstall(id, scope);
});

ipcMain.handle('skillsInstallBundle', (_, bundle, opts) => {
  loadAgentModules();
  if (!skillsManager) return { ok: false, error: 'Skills manager not loaded' };
  return skillsManager.installFromBundle(bundle, opts || {});
});

ipcMain.handle('skillsInstallFromUrl', (_, url) => {
  loadAgentModules();
  if (!skillsManager) return { ok: false, error: 'Skills manager not loaded' };
  return skillsManager.installFromShareUrl(url);
});

ipcMain.handle('skillsShareUrl', (_, id) => {
  loadAgentModules();
  if (!skillsManager) return null;
  return skillsManager.generateShareUrl(id);
});

ipcMain.handle('skillsPreviewMatch', (_, query, opts) => {
  loadAgentModules();
  if (!skillsManager) return { block: '', selected: [], scored: [] };
  skillsManager.refreshIfStale();
  return skillsManager.getSkillsBlock(query || '', opts || {});
});

// Forwarded to agent.js dispatchTool — gated by withPermission so the standard
// approval UX fires before any helper script runs.
ipcMain.handle('skillsPreviewSource', (_, query, content, opts) => {
  loadAgentModules();
  if (!skillsManager) return { ok: false, error: 'Skills manager not loaded', selected: [], scored: [] };
  skillsManager.refreshIfStale();
  return skillsManager.previewSource(query || '', content || '', opts || {});
});

ipcMain.handle('skillsRunHelper', async (event, skillId, helperRel, helperArgs, timeoutMs) => {
  loadAgentModules();
  if (!agentTools || !skillsManager) return { ok: false, error: 'Skills manager not loaded' };
  return withPermission(
    event.sender,
    `skill_run_helper:${skillId || '?'}/${helperRel || '?'}`,
    { skill: skillId, helper: helperRel, args: helperArgs },
    `Run helper from skill "${skillId}"`,
    () => agentTools.runSkillHelper(skillId, helperRel, helperArgs, timeoutMs)
  );
});

ipcMain.handle('pluginExecTool', async (event, pluginId, toolName, args) => {
  loadAgentModules();
  if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
  let permissionTool = `${pluginId || 'plugin'}__${toolName || 'run'}`;
  try {
    const manifest = pluginManager.plugins?.get?.(pluginId) || {};
    const spec = (manifest.tools || []).find(t => t && t.name === toolName);
    if (spec?.action) permissionTool = `${pluginId || 'plugin'}__${spec.action}`;
  } catch (_) {}
  return withPermission(
    event.sender,
    permissionTool,
    args || {},
    'Run plugin tool',
    () => pluginManager.executeTool(pluginId, toolName, args)
  );
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
ipcMain.handle('pluginTemplates', () => {
  loadAgentModules();
  const { PluginManager } = require('./pluginManager');
  return PluginManager.getBuiltinTemplates();
});

// ── WORKFLOW ENGINE ───────────────────────────────────────────────────────────
ipcMain.handle('workflowList', () => {
  loadAgentModules();
  if (!workflowEngine) return [];
  return workflowEngine.loadAll();
});

// Server-side trigger sanitiser. Mirrors the renderer's
// normaliseWorkflowTrigger() — defense-in-depth so a malformed trigger
// from a marketplace install / external IPC consumer can't crash the
// engine at run time. Anything we can't recognise drops to "manual".
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

ipcMain.handle('workflowCreate', (_, name, trigger, steps, desc) => {
  loadAgentModules();
  if (!workflowEngine) return { ok: false, error: 'Workflow engine not loaded' };
  return workflowEngine.create(name, _sanitiseWorkflowTrigger(trigger), steps, desc);
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
  return workflowEngine.run(id, onStep, { sender: event.sender });
});

// Snapshot of currently-running workflows for the premium Workflows panel
// (animated graph view of the live run). Renderer also listens for the
// workflow:running:start / step / end events emitted by the engine bridge.
ipcMain.handle('workflowActiveRuns', () => {
  loadAgentModules();
  if (!workflowEngine) return [];
  return workflowEngine.getActiveRuns();
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
    telegram_primary:   'https://t.me/Ernest_Kostevich',
    telegram_secondary: 'https://t.me/ernest0kostevich',
    email_primary:      'mailto:ernest2011kostevich@gmail.com',
    email_secondary:    'mailto:ernestkostevich@gmail.com',
  };
  const url = links[channel];
  if (!url) return { ok: false, url };
  return openExternalReliable(url, 'Horizon Support');
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

// Install a published workflow from the marketplace into the local engine.
// Marketplace stores workflows in the same `plugins` collection with
// `type: 'workflow'`. The bundle's `handler` field carries a JSON-encoded
// workflow definition `{ trigger, steps }`. We tolerate two shapes:
//   1. Modern: handler is a JSON string with {trigger, steps, name?}
//   2. Legacy: handler is empty, steps live inside manifest.tools (each
//      tool acts as a step with action / args)
// Either way we end up calling workflowEngine.create(name, trigger, steps).
ipcMain.handle('marketRemoteInstallWorkflow', async (_, workflowId) => {
  try {
    loadAgentModules();
    if (!workflowEngine) return { ok: false, error: 'Workflow engine not ready' };
    try { await marketClient.install(workflowId); } catch (_) { /* anonymous install OK for free items */ }
    const bundle = await marketClient.bundle(workflowId);
    const m = bundle.manifest || {};
    let trigger = 'manual';
    let steps = [];
    let name = m.name || 'Imported workflow';
    let desc = m.description || '';

    // Shape 1: handler is JSON for the workflow.
    if (bundle.handler && typeof bundle.handler === 'string') {
      try {
        const parsed = JSON.parse(bundle.handler);
        if (parsed && typeof parsed === 'object') {
          if (parsed.trigger) trigger = parsed.trigger;
          if (Array.isArray(parsed.steps)) steps = parsed.steps;
          if (parsed.name) name = parsed.name;
          if (parsed.description) desc = parsed.description;
        }
      } catch (_) { /* handler wasn't JSON — fall through to tools shape */ }
    }

    // Shape 2: derive steps from manifest.tools (each tool ↔ workflow step).
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

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => {}); // tray keeps alive
app.on('activate', () => { win?.show(); });
