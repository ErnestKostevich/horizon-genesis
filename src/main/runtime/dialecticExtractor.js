'use strict';
/**
 * Shared dialectic extractor (PHASE 28.4) — used by both Electron's
 * main.js and the CLI's headless.js so the logic stays in one spot.
 *
 * The extractor turns "user message + assistant reply" into a JSON list
 * of new diff records the agent has learned about the user. It uses the
 * user's currently configured AI provider — no extra key required.
 *
 * Cost: ~150 input + ~80 output tokens per call. The caller in
 * AgentMemory.learnFromTurn samples to one call per ~2 turns once the
 * store is bootstrapped.
 */

const PROVIDER_ENDPOINTS = {
  openai:   'https://api.openai.com/v1/chat/completions',
  claude:   'https://api.anthropic.com/v1/messages',
  groq:     'https://api.groq.com/openai/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  mistral:  'https://api.mistral.ai/v1/chat/completions',
};

function buildSystemPrompt(recent) {
  const recentLines = (recent || [])
    .slice(0, 5)
    .map(r => `- [${r.kind}] ${r.after}${r.before ? ' (was: ' + r.before + ')' : ''}`)
    .join('\n') || '(empty — this is one of the first records)';
  return [
    'You are a user-model extractor. After each conversation turn, you emit a JSON object describing what NEW information the turn revealed about the user.',
    '',
    'Valid kinds:',
    '  belief          — a new opinion or preference the user revealed',
    '  desire          — a new goal or want',
    '  knowledge       — a fact about the user\'s skills / context they just stated',
    '  theory-of-mind  — an assumption we made that was confirmed or refuted',
    '  correction      — something the user explicitly corrected',
    '',
    'Recent diff log (do not re-emit these):',
    recentLines,
    '',
    'Rules:',
    '  • Emit AT MOST 3 entries. Empty {"updates":[]} is fine if nothing was learned.',
    '  • Skip trivial small-talk and acknowledgements.',
    '  • Skip facts the user has clearly stated before (see the log above).',
    '  • Each entry: {"kind":"...","before":null or "...","after":"<= 200 chars","evidence":"<= 120 chars quote","confidence":0.0..1.0}',
    '  • RESPOND WITH RAW JSON ONLY. No prose, no markdown fences.',
  ].join('\n');
}

function parseJsonResponse(raw) {
  if (!raw) return [];
  let txt = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(txt); }
  catch (_) {
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try { parsed = JSON.parse(m[0]); } catch (_) { return []; }
  }
  const list = Array.isArray(parsed) ? parsed
             : Array.isArray(parsed?.updates) ? parsed.updates
             : [];
  return list.filter(x => x && typeof x === 'object' && x.kind && x.after).slice(0, 3);
}

/**
 * Call the active provider's chat endpoint with the extraction prompt.
 * Provider selection follows settingsStore.get('provider'). Falls back
 * silently to [] if the provider doesn't have a key or returns garbage.
 */
async function extract({ user, assistant, recent, settingsStore, keysStore }) {
  try {
    if (!user || !assistant) return [];
    const provider = settingsStore?.get?.('provider') || 'gemini';
    const systemPrompt = buildSystemPrompt(recent);
    const turn = 'TURN:\nUser: ' + String(user).slice(0, 1200) + '\nAssistant: ' + String(assistant).slice(0, 1200);
    // Gemini uses a different endpoint shape, handle separately.
    if (provider === 'gemini') {
      const key = keysStore?.get?.('k_gemini');
      if (!key) return [];
      const model = settingsStore?.get?.('geminiModel') || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: turn }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 280 },
      };
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) return [];
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return parseJsonResponse(text);
    }
    // OpenAI-compatible providers (incl. groq / deepseek / mistral).
    const url = PROVIDER_ENDPOINTS[provider];
    if (!url) return [];
    const key = keysStore?.get?.(`k_${provider}`);
    if (!key) return [];
    if (provider === 'claude') {
      const body = {
        model: settingsStore?.get?.('model.claude') || 'claude-sonnet-4-6',
        max_tokens: 280,
        temperature: 0.1,
        system: systemPrompt,
        messages: [{ role: 'user', content: turn }],
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const text = data?.content?.[0]?.text || '';
      return parseJsonResponse(text);
    }
    // OpenAI / Groq / DeepSeek / Mistral all share the OpenAI shape.
    const body = {
      model: settingsStore?.get?.(`model.${provider}`) || _defaultModelFor(provider),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: turn },
      ],
      temperature: 0.1,
      max_tokens: 280,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return parseJsonResponse(text);
  } catch (e) {
    return [];
  }
}

function _defaultModelFor(provider) {
  return {
    openai:   'gpt-5.4-mini',
    groq:     'llama-3.3-70b-versatile',
    deepseek: 'deepseek-chat',
    mistral:  'mistral-medium-latest',
  }[provider] || '';
}

module.exports = extract;
module.exports.extract = extract;
module.exports.buildSystemPrompt = buildSystemPrompt;
module.exports.parseJsonResponse = parseJsonResponse;
