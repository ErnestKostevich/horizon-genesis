// AI provider client — compact, headless-safe version of main.js's
// runAiCompletion. Used by the CLI/TUI/serve runtime so we can hit Claude /
// OpenAI / Gemini / Groq / DeepSeek / Grok / Mistral / Qwen / Perplexity /
// Cohere / OpenRouter / Ollama / LM Studio / LocalAI without dragging in
// any Electron-only modules.
//
// Why a separate copy of the provider switch:
//   - main.js's runAiCompletion calls into Electron-only paths (persona
//     overlay store, skills resolution that touches the BrowserWindow IPC
//     queue, image-attachment normalisation). Extracting it intact would
//     mean either pulling those code paths along or refactoring main.js,
//     both higher-risk than maintaining a tight headless variant.
//   - The CLI doesn't need image attachments, vision blocks, or live
//     skills-resolution against the renderer's current chat draft. It just
//     needs `(messages, provider, system, opts) → {reply, model, usage}`.
//   - Persona is injected by `headless.js` via the system prompt before
//     calling us, so we treat `system` as authoritative.
//
// If a provider grows a quirky behaviour in main.js, mirror it here.
// Default models intentionally match main.js DEFAULT_PROVIDER_MODELS.

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

const OPENAI_COMPAT_ENDPOINTS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  grok: 'https://api.x.ai/v1/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
  perplexity: 'https://api.perplexity.ai/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

const KEY_NAMES = {
  claude: 'k_claude',
  openai: 'k_openai',
  gemini: 'k_gemini',
  groq: 'k_groq',
  deepseek: 'k_deepseek',
  grok: 'k_grok',
  mistral: 'k_mistral',
  qwen: 'k_qwen',
  perplexity: 'k_perplexity',
  cohere: 'k_cohere',
  openrouter: 'k_openrouter',
};

function normalizeUsage(d, provider) {
  try {
    if (provider === 'claude') {
      const u = d?.usage; if (!u) return null;
      return { prompt: u.input_tokens || 0, completion: u.output_tokens || 0,
               total: (u.input_tokens || 0) + (u.output_tokens || 0) };
    }
    if (provider === 'gemini') {
      const u = d?.usageMetadata; if (!u) return null;
      return { prompt: u.promptTokenCount || 0, completion: u.candidatesTokenCount || 0,
               total: u.totalTokenCount || 0 };
    }
    if (provider === 'cohere') {
      const t = d?.usage?.tokens || d?.meta?.tokens; if (!t) return null;
      return { prompt: t.input_tokens || 0, completion: t.output_tokens || 0,
               total: (t.input_tokens || 0) + (t.output_tokens || 0) };
    }
    const u = d?.usage; if (!u) return null;
    return { prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0,
             total: u.total_tokens || 0 };
  } catch (_) { return null; }
}

/**
 * Build a headless AI client.
 *
 * @param {object} deps
 * @param {object} deps.keysStore     conf instance with `.get(name)` returning API keys
 * @param {object} deps.settingsStore conf instance with `.get(name)` for provider/model prefs
 * @param {Function} [deps.fetchImpl] optional fetch override (defaults to global fetch / node-fetch)
 *
 * @returns {object} client with `.complete(messages, opts) → {reply,model,usage,error?}`
 */
function createAiClient({ keysStore, settingsStore, fetchImpl } = {}) {
  if (!keysStore || !settingsStore) {
    throw new Error('createAiClient: keysStore and settingsStore required');
  }
  const fetch = fetchImpl
    || (typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch'));

  function selectModel(provider, opts = {}) {
    if (opts.model) return opts.model;
    const stored = settingsStore.get(`model.${provider}`);
    if (stored) return stored;
    return DEFAULT_PROVIDER_MODELS[provider] || '';
  }

  async function complete(messages, opts = {}) {
    const provider = opts.provider || settingsStore.get('provider') || 'gemini';
    const system = opts.system || '';
    const respProfile = settingsStore.get('responseProfile') || 'balanced';
    const model = selectModel(provider, opts);

    try {
      if (provider === 'claude') {
        const k = keysStore.get('k_claude');
        if (!k) return { error: 'Claude key not set' };
        const body = { model, max_tokens: 4096, system, messages };
        if (respProfile === 'deep') {
          body.thinking = { type: 'enabled', budget_tokens: 8000 };
          body.max_tokens = 16000;
        }
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (d.error) return { error: d.error.message };
        const textBlock = (d.content || []).find(b => b && b.type === 'text');
        return {
          reply: textBlock?.text || d.content?.[0]?.text || '',
          model,
          usage: normalizeUsage(d, 'claude'),
        };
      }

      if (provider === 'gemini') {
        const k = keysStore.get('k_gemini');
        if (!k) return { error: 'Gemini key not set' };
        // Gemini requires strict alternating user/model. Same logic as main.js.
        const raw = messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content || '...' }],
        }));
        const contents = [];
        for (const msg of raw) {
          if (!contents.length) {
            if (msg.role === 'user') contents.push(msg);
          } else if (contents[contents.length - 1].role !== msg.role) {
            contents.push(msg);
          } else {
            contents[contents.length - 1].parts[0].text += '\n' + msg.parts[0].text;
          }
        }
        if (!contents.length) contents.push({ role: 'user', parts: [{ text: '...' }] });
        if (contents[contents.length - 1].role !== 'user') {
          contents.push({ role: 'user', parts: [{ text: '...' }] });
        }
        const generationConfig = { maxOutputTokens: 4096, temperature: 0.7 };
        if (/^gemini-(2\.5|3)/.test(model)) {
          if (respProfile === 'deep') generationConfig.thinkingConfig = { thinkingBudget: -1 };
          else if (respProfile === 'fast') generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${k}`;
        const r = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents, generationConfig }),
        });
        const d = await r.json();
        if (d.error) return { error: d.error.message };
        const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          const reason = d.candidates?.[0]?.finishReason || d.promptFeedback?.blockReason || 'empty response';
          return { error: `Gemini: ${reason}` };
        }
        return { reply: text, model, usage: normalizeUsage(d, 'gemini') };
      }

      if (provider === 'cohere') {
        const k = keysStore.get('k_cohere');
        if (!k) return { error: 'Cohere key not set' };
        // Cohere chat v2: simple messages array with role+content.
        const r = await fetch('https://api.cohere.com/v2/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` },
          body: JSON.stringify({
            model,
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              ...messages,
            ],
          }),
        });
        const d = await r.json();
        if (d.message && r.status >= 400) return { error: d.message };
        const txt = d.message?.content?.[0]?.text || '';
        return { reply: txt, model, usage: normalizeUsage(d, 'cohere') };
      }

      // Local providers — no key required.
      if (provider === 'ollama') {
        const url = settingsStore.get('ollamaUrl') || 'http://127.0.0.1:11434';
        const r = await fetch(`${url}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: settingsStore.get('ollamaModel') || model,
            messages: [{ role: 'system', content: system }, ...messages],
            stream: false,
          }),
        });
        const d = await r.json();
        if (d.error) return { error: d.error.message || String(d.error) };
        return { reply: d.choices?.[0]?.message?.content || '', model, usage: normalizeUsage(d, 'ollama') };
      }
      if (provider === 'lmstudio' || provider === 'localai') {
        const baseKey = provider === 'lmstudio' ? 'lmStudioUrl' : 'localAiUrl';
        const modelKey = provider === 'lmstudio' ? 'lmStudioModel' : 'localAiModel';
        const url = settingsStore.get(baseKey) || (provider === 'lmstudio' ? 'http://127.0.0.1:1234' : 'http://127.0.0.1:8080');
        const r = await fetch(`${url}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: settingsStore.get(modelKey) || model,
            messages: [{ role: 'system', content: system }, ...messages],
            max_tokens: 4096,
          }),
        });
        const d = await r.json();
        if (d.error) return { error: d.error.message || String(d.error) };
        return { reply: d.choices?.[0]?.message?.content || '', model, usage: normalizeUsage(d, provider) };
      }

      // OpenAI-compatible providers.
      const endpoint = OPENAI_COMPAT_ENDPOINTS[provider];
      if (!endpoint) return { error: `Unknown provider: ${provider}` };
      const k = keysStore.get(KEY_NAMES[provider]);
      if (!k) return { error: `${provider} key not set` };
      const body = {
        model,
        max_tokens: 4096,
        messages: [{ role: 'system', content: system }, ...messages],
      };
      // OpenAI reasoning models honour reasoning_effort
      if (provider === 'openai') {
        const isReasoning = /^o[134]/.test(model) || /thinking|reasoning/.test(model);
        if (isReasoning) {
          if (respProfile === 'deep') body.reasoning_effort = 'high';
          else if (respProfile === 'fast') body.reasoning_effort = 'low';
        }
      }
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.error) return { error: d.error.message || String(d.error) };
      return { reply: d.choices?.[0]?.message?.content || '', model, usage: normalizeUsage(d, provider) };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  /**
   * agentLoop-compatible aiFn(messages, system, agentMeta) → {reply,toolCalls?,error?}
   * agentLoop.js takes a system string AS THE SECOND ARG (not as part of opts).
   */
  function asAgentAiFn(opts = {}) {
    return async (messages, system, _agentMeta) => {
      return complete(messages, { ...opts, system });
    };
  }

  /**
   * Streaming completion — emits tokens via onToken(text) as they arrive,
   * then resolves to the same shape `complete()` returns.
   *
   * Supports: claude, openai (+ all openai-compat), gemini, ollama,
   * lmstudio, localai. cohere falls back to non-streaming.
   *
   * @param {Array} messages
   * @param {object} opts             same shape as complete()
   * @param {Function} onToken        called with each delta string
   * @returns {Promise<{reply, model, usage, error?}>}
   */
  async function completeStream(messages, opts = {}, onToken = () => {}) {
    const provider = opts.provider || settingsStore.get('provider') || 'gemini';
    const system = opts.system || '';
    const model = selectModel(provider, opts);
    const respProfile = settingsStore.get('responseProfile') || 'balanced';

    try {
      if (provider === 'claude') {
        const k = keysStore.get('k_claude');
        if (!k) return { error: 'Claude key not set' };
        const body = { model, max_tokens: 4096, system, messages, stream: true };
        if (respProfile === 'deep') {
          body.thinking = { type: 'enabled', budget_tokens: 8000 };
          body.max_tokens = 16000;
        }
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          return { error: d.error?.message || `HTTP ${r.status}` };
        }
        return readSseClaude(r, onToken, model);
      }

      if (provider === 'gemini') {
        const k = keysStore.get('k_gemini');
        if (!k) return { error: 'Gemini key not set' };
        const { contents } = normaliseGeminiMessages(messages);
        const generationConfig = { maxOutputTokens: 4096, temperature: 0.7 };
        if (/^gemini-(2\.5|3)/.test(model)) {
          if (respProfile === 'deep') generationConfig.thinkingConfig = { thinkingBudget: -1 };
          else if (respProfile === 'fast') generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${k}`;
        const r = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents, generationConfig,
          }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          return { error: d.error?.message || `HTTP ${r.status}` };
        }
        return readSseGemini(r, onToken, model);
      }

      // OpenAI-compatible (openai/groq/deepseek/grok/mistral/qwen/perplexity/
      // openrouter/ollama/lmstudio/localai) — share the same SSE format.
      const isLocal = ['ollama', 'lmstudio', 'localai'].includes(provider);
      let endpoint = OPENAI_COMPAT_ENDPOINTS[provider];
      let headers = { 'Content-Type': 'application/json' };
      if (!isLocal) {
        const k = keysStore.get(KEY_NAMES[provider]);
        if (!k) return { error: `${provider} key not set` };
        headers['Authorization'] = `Bearer ${k}`;
      } else {
        const baseKey = provider === 'ollama' ? 'ollamaUrl'
                      : provider === 'lmstudio' ? 'lmStudioUrl' : 'localAiUrl';
        const defaultUrl = provider === 'ollama' ? 'http://127.0.0.1:11434'
                         : provider === 'lmstudio' ? 'http://127.0.0.1:1234'
                         : 'http://127.0.0.1:8080';
        const base = settingsStore.get(baseKey) || defaultUrl;
        endpoint = `${base}/v1/chat/completions`;
      }
      if (!endpoint) return { error: `streaming not supported for ${provider}` };
      const body = {
        model, max_tokens: 4096, stream: true,
        messages: [{ role: 'system', content: system }, ...messages],
      };
      if (provider === 'openai') {
        const isReasoning = /^o[134]/.test(model) || /thinking|reasoning/.test(model);
        if (isReasoning) {
          if (respProfile === 'deep') body.reasoning_effort = 'high';
          else if (respProfile === 'fast') body.reasoning_effort = 'low';
        }
      }
      const r = await fetch(endpoint, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        return { error: d.error?.message || `HTTP ${r.status}` };
      }
      return readSseOpenAi(r, onToken, model);
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  return { complete, completeStream, asAgentAiFn, selectModel };
}

// ── SSE readers ──────────────────────────────────────────────────────────
// Each fetch() returns either a WHATWG ReadableStream (Node 18+ global fetch)
// or a node-fetch Response with .body as a Readable. Treat both uniformly.

async function readBodyLines(response, onLine) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    // WHATWG ReadableStream
    const reader = body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line) onLine(line);
      }
    }
  } else if (body && typeof body.on === 'function') {
    // node-fetch Readable
    await new Promise((resolve, reject) => {
      body.on('data', chunk => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (line) onLine(line);
        }
      });
      body.on('end', resolve);
      body.on('error', reject);
    });
  } else {
    throw new Error('response body has no readable interface');
  }
  if (buf) onLine(buf);
}

async function readSseClaude(response, onToken, model) {
  let reply = '';
  let usage = null;
  await readBodyLines(response, (line) => {
    if (!line.startsWith('data: ')) return;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const evt = JSON.parse(payload);
      if (evt.type === 'content_block_delta' && evt.delta?.text) {
        reply += evt.delta.text;
        onToken(evt.delta.text);
      } else if (evt.type === 'message_delta' && evt.usage) {
        usage = {
          prompt: evt.usage.input_tokens || 0,
          completion: evt.usage.output_tokens || 0,
          total: (evt.usage.input_tokens || 0) + (evt.usage.output_tokens || 0),
        };
      }
    } catch (_) { /* malformed event, skip */ }
  });
  return { reply, model, usage };
}

async function readSseOpenAi(response, onToken, model) {
  let reply = '';
  let usage = null;
  await readBodyLines(response, (line) => {
    if (!line.startsWith('data: ')) return;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const evt = JSON.parse(payload);
      const delta = evt.choices?.[0]?.delta?.content;
      if (delta) {
        reply += delta;
        onToken(delta);
      }
      if (evt.usage) {
        usage = {
          prompt: evt.usage.prompt_tokens || 0,
          completion: evt.usage.completion_tokens || 0,
          total: evt.usage.total_tokens || 0,
        };
      }
    } catch (_) { /* malformed event */ }
  });
  return { reply, model, usage };
}

async function readSseGemini(response, onToken, model) {
  let reply = '';
  let usage = null;
  await readBodyLines(response, (line) => {
    if (!line.startsWith('data: ')) return;
    const payload = line.slice(6).trim();
    if (!payload) return;
    try {
      const evt = JSON.parse(payload);
      const delta = evt.candidates?.[0]?.content?.parts?.[0]?.text;
      if (delta) {
        reply += delta;
        onToken(delta);
      }
      if (evt.usageMetadata) {
        usage = {
          prompt: evt.usageMetadata.promptTokenCount || 0,
          completion: evt.usageMetadata.candidatesTokenCount || 0,
          total: evt.usageMetadata.totalTokenCount || 0,
        };
      }
    } catch (_) {}
  });
  return { reply, model, usage };
}

// Shared between complete() and completeStream() for Gemini's strict
// alternating user/model rule.
function normaliseGeminiMessages(messages) {
  const raw = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content || '...' }],
  }));
  const contents = [];
  for (const msg of raw) {
    if (!contents.length) {
      if (msg.role === 'user') contents.push(msg);
    } else if (contents[contents.length - 1].role !== msg.role) {
      contents.push(msg);
    } else {
      contents[contents.length - 1].parts[0].text += '\n' + msg.parts[0].text;
    }
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '...' }] });
  if (contents[contents.length - 1].role !== 'user') {
    contents.push({ role: 'user', parts: [{ text: '...' }] });
  }
  return { contents };
}

module.exports = {
  createAiClient,
  DEFAULT_PROVIDER_MODELS,
};
