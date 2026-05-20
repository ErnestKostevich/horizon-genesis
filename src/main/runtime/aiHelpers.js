'use strict';

// Pure helpers used by main.js + every ipc/*.js module.
// Sprint 6: pulled out of main.js to keep the entrypoint lean.
// Includes provider/model registries, response-profile shaping, SSE stream
// parsing, and tool-format conversion (Anthropic ↔ OpenAI ↔ generic).

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

module.exports = {
  DEFAULT_PROVIDER_MODELS,
  KNOWN_PROVIDER_MODELS,
  normalizeSelectedModel,
  firstTextFromAnthropic,
  normaliseUsage,
  lastUserMessageText,
  readSseStream,
  extractStreamPayload,
  toolParamsToJsonSchema,
  nativeToolName,
  nativeToolPack,
  toOpenAITools,
  toAnthropicTools,
  safeJsonParseArgs,
  toOpenAIChatMessages,
  asAnthropicBlocks,
  appendAnthropicMessage,
  toAnthropicMessages,
  parseAnthropicToolCalls,
  parseOpenAIToolCalls,
  mapNativeToolCalls,
};
