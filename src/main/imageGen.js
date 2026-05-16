'use strict';
/**
 * Horizon Image Generation — BYOK adapters (Phase 4.1).
 *
 * Generates images via the user's own API key (BYOK / local-first):
 * Horizon never proxies image-gen prompts, the keys live in the
 * same electron-store as chat provider keys (`k_openai`, `k_gemini`).
 *
 * Supported providers (initial):
 *   - openai   — DALL-E 3 (`dall-e-3` model). Strong photorealism + text.
 *   - gemini   — Imagen 3 (`imagen-3.0-generate-002`). Photorealism + style.
 *
 * Returns { ok, images: [{ b64, mime, prompt, revised_prompt?, model, provider }], error }.
 *
 * Image payload format: returned as base64 data so the renderer can
 * pipe it straight into an <img src="data:image/...;base64,..."/>
 * without a roundtrip through disk. Caller can choose to download.
 *
 * IPC handler exposed via main.js as `aiImage(opts)` →
 *   opts: { provider, prompt, size?, model?, n?, quality? }
 */

const HORIZON_UA = 'Horizon AI / image-gen plugin';

const DEFAULTS = {
  openai: { model: 'dall-e-3', size: '1024x1024', quality: 'standard', n: 1 },
  gemini: { model: 'imagen-3.0-generate-002', size: '1024x1024', n: 1 },
};

function withTimeout(promise, ms, label = 'request') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * DALL-E 3 — OpenAI Images API.
 * Docs: https://platform.openai.com/docs/api-reference/images/create
 * Returns base64 payload (`response_format=b64_json`) so renderer
 * doesn't have to round-trip a URL (also avoids 1h-expiry signed URL).
 */
async function callOpenAI({ apiKey, prompt, size, quality, model, n }) {
  if (!apiKey) throw new Error('OpenAI API key not set. Add it in Settings → Providers → OpenAI.');
  const body = {
    model: model || DEFAULTS.openai.model,
    prompt: String(prompt || '').slice(0, 4000), // DALL-E 3 cap
    n: 1, // DALL-E 3 hard-limits n=1; ignored if user passes other
    size: size || DEFAULTS.openai.size,
    quality: quality || DEFAULTS.openai.quality,
    response_format: 'b64_json',
  };
  const res = await withTimeout(
    fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': HORIZON_UA,
      },
      body: JSON.stringify(body),
    }),
    90_000,
    'OpenAI image-gen'
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`OpenAI: ${msg}`);
  }
  const items = Array.isArray(json.data) ? json.data : [];
  if (!items.length) throw new Error('OpenAI returned no images');
  return items.map((item) => ({
    b64: item.b64_json,
    mime: 'image/png',
    prompt: body.prompt,
    revised_prompt: item.revised_prompt || null,
    model: body.model,
    provider: 'openai',
  }));
}

/**
 * Gemini Imagen 3 — Google AI Generative API.
 * Docs: https://ai.google.dev/api/rest/v1beta/models/predict
 * Endpoint shape mirrors the text generateContent endpoint but uses
 * the `:predict` action on imagen-3.0-generate-002.
 */
async function callGemini({ apiKey, prompt, size, model, n }) {
  if (!apiKey) throw new Error('Gemini API key not set. Add it in Settings → Providers → Gemini.');
  const modelId = model || DEFAULTS.gemini.model;
  // Map common aspect strings to Imagen's expected aspectRatio values.
  const ratioMap = {
    '1024x1024': '1:1',
    '1024x1792': '9:16',
    '1792x1024': '16:9',
    '1024x1536': '3:4',
    '1536x1024': '4:3',
  };
  const aspectRatio = ratioMap[size] || '1:1';
  const body = {
    instances: [{ prompt: String(prompt || '').slice(0, 2000) }],
    parameters: {
      sampleCount: Math.max(1, Math.min(4, Number(n) || 1)),
      aspectRatio,
      personGeneration: 'allow_all',
    },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:predict?key=${encodeURIComponent(apiKey)}`;
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': HORIZON_UA },
      body: JSON.stringify(body),
    }),
    90_000,
    'Gemini Imagen'
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Gemini: ${msg}`);
  }
  const preds = Array.isArray(json.predictions) ? json.predictions : [];
  if (!preds.length) throw new Error('Gemini Imagen returned no predictions');
  return preds.map((p) => ({
    b64: p.bytesBase64Encoded || p.image?.bytesBase64Encoded || null,
    mime: 'image/png',
    prompt: body.instances[0].prompt,
    revised_prompt: null,
    model: modelId,
    provider: 'gemini',
  })).filter(im => im.b64);
}

/**
 * Main entry — picks provider, validates input, dispatches.
 *
 * @param {object} opts
 * @param {string} opts.provider    'openai' | 'gemini'
 * @param {string} opts.prompt      what to draw
 * @param {string} [opts.size]      '1024x1024' etc
 * @param {string} [opts.model]
 * @param {number} [opts.n]         number of images (gemini only)
 * @param {string} [opts.quality]   'standard' | 'hd' (openai only)
 * @param {Function} [getKey]       (svc) => string|null — injected by main.js
 * @returns {Promise<{ok: boolean, images?: Array, error?: string}>}
 */
async function generateImage(opts, getKey) {
  try {
    const provider = String(opts?.provider || 'openai').toLowerCase();
    const prompt = String(opts?.prompt || '').trim();
    if (!prompt) return { ok: false, error: 'prompt is required' };
    if (typeof getKey !== 'function') {
      return { ok: false, error: 'getKey function not provided' };
    }
    if (provider === 'openai') {
      const images = await callOpenAI({
        apiKey: getKey('openai'),
        prompt,
        size: opts.size,
        quality: opts.quality,
        model: opts.model,
        n: opts.n,
      });
      return { ok: true, images };
    }
    if (provider === 'gemini') {
      const images = await callGemini({
        apiKey: getKey('gemini'),
        prompt,
        size: opts.size,
        model: opts.model,
        n: opts.n,
      });
      return { ok: true, images };
    }
    return { ok: false, error: `Unknown image-gen provider: ${provider}` };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

module.exports = { generateImage, DEFAULTS };
