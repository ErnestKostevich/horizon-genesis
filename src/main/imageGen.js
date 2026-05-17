'use strict';
/**
 * Horizon Image Generation — BYOK adapters (Phase 4.1).
 *
 * Generates images via the user's own API key (BYOK / local-first):
 * Horizon never proxies image-gen prompts, the keys live in the
 * same electron-store as chat provider keys (`k_openai`, `k_gemini`).
 *
 * Supported providers (real API model IDs as of May 2026):
 *
 *   openai:
 *     - gpt-image-2, gpt-image-1.5, gpt-image-1, gpt-image-1-mini
 *       via /v1/images/generations. These may require Organization
 *       Verification depending on the account.
 *
 *   gemini:
 *     - gemini-3.1-flash-image-preview (Nano Banana 2 preview)
 *     - gemini-3-pro-image-preview (Nano Banana Pro preview)
 *     - gemini-2.5-flash-image (Nano Banana)
 *       Native image generation via generateContent.
 *     - imagen-4.0-generate-001, imagen-4.0-ultra-generate-001,
 *       imagen-4.0-fast-generate-001 via the Gemini API :predict endpoint.
 *
 * Removed: imagen-3.0-generate-002. Google docs mark it discontinued,
 * and users saw "model not found" with that stale ID.
 *
 * Returns { ok, images: [{ b64, mime, prompt, revised_prompt?, model, provider }], error }.
 */

const HORIZON_UA = 'Horizon AI / image-gen plugin';

// What model strings count as "image generation" per provider. Picker
// + auto-routing checks these to know whether to call /images/generations
// (DALL-E path) or :generateContent (Gemini native multimodal path).
const OPENAI_IMAGE_MODELS = new Set([
  'gpt-image-2',
  'gpt-image-1.5',
  'gpt-image-1',
  'gpt-image-1-mini',
]);
const GEMINI_IMAGE_MODELS = new Set([
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
  'gemini-2.5-flash-image',
]);
const GEMINI_IMAGEN_MODELS = new Set([
  'imagen-4.0-generate-001',
  'imagen-4.0-ultra-generate-001',
  'imagen-4.0-fast-generate-001',
]);

const DEFAULTS = {
  openai: { model: 'gpt-image-2', size: '1024x1024', quality: 'auto', n: 1 },
  gemini: { model: 'gemini-2.5-flash-image', size: '1024x1024', n: 1 },
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
 * OpenAI Images API — GPT Image models on /v1/images/generations.
 * Docs: https://platform.openai.com/docs/api-reference/images/create
 */
async function callOpenAI({ apiKey, prompt, size, quality, model, n }) {
  if (!apiKey) throw new Error('OpenAI API key not set. Add it in Settings → Providers → OpenAI.');
  const chosenModel = model || DEFAULTS.openai.model;
  const body = {
    model: chosenModel,
    prompt: String(prompt || '').slice(0, 4000),
    n: Math.max(1, Math.min(4, Number(n) || 1)),
    size: size || DEFAULTS.openai.size,
  };
  if (quality) {
    body.quality = quality || DEFAULTS.openai.quality;
  }
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
    120_000,
    'OpenAI image-gen'
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    if (res.status === 403 && /^gpt-image-/.test(chosenModel)) {
      throw new Error(`OpenAI: ${chosenModel} may require Organization Verification. Verify at platform.openai.com/settings/organization. (${msg})`);
    }
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
 * Gemini native multimodal image generation via generateContent.
 * Uses native Gemini image models (Nano Banana family) on a plain Gemini
 * API key — no Vertex AI / OAuth required.
 *
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent
 * Body: { contents: [{ parts: [{ text: prompt }] }],
 *         generationConfig: { responseModalities: ['IMAGE','TEXT'] } }
 *
 * Response parts contain inlineData with base64 image payload.
 */
async function callGemini({ apiKey, prompt, size, model, n }) {
  if (!apiKey) throw new Error('Gemini API key not set. Add it in Settings → Providers → Gemini.');
  const modelId = model || DEFAULTS.gemini.model;
  if (GEMINI_IMAGEN_MODELS.has(modelId)) {
    return callImagen({ apiKey, prompt, size, model: modelId, n });
  }
  const body = {
    contents: [{
      role: 'user',
      parts: [{ text: String(prompt || '').slice(0, 2000) }],
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      candidateCount: Math.max(1, Math.min(4, Number(n) || 1)),
    },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': HORIZON_UA },
      body: JSON.stringify(body),
    }),
    120_000,
    'Gemini image-gen'
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    // Helpful hint if the user picked a model name that isn't actually
    // image-capable (e.g. plain `gemini-2.5-flash` which only does text).
    if (/not found|not supported/i.test(msg)) {
      throw new Error(`Gemini: ${modelId} doesn't support image generation. Try 'gemini-2.5-flash-image', 'gemini-3.1-flash-image-preview', or 'gemini-3-pro-image-preview'. (${msg})`);
    }
    throw new Error(`Gemini: ${msg}`);
  }
  // Walk the candidates → content.parts and collect inlineData (base64 image).
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const images = [];
  let textNote = '';
  for (const cand of candidates) {
    const parts = cand?.content?.parts || [];
    for (const part of parts) {
      if (part?.inlineData?.data) {
        images.push({
          b64: part.inlineData.data,
          mime: part.inlineData.mimeType || 'image/png',
          prompt: body.contents[0].parts[0].text,
          revised_prompt: null,
          model: modelId,
          provider: 'gemini',
        });
      } else if (part?.text) {
        textNote += part.text + '\n';
      }
    }
  }
  if (!images.length) {
    // Gemini sometimes refuses with a text-only response (safety / unsupported).
    const detail = textNote.trim() || JSON.stringify(json).slice(0, 200);
    throw new Error(`Gemini returned no image. Model said: ${detail}`);
  }
  // Attach the optional text note as a revised_prompt so the UI can show it.
  if (textNote.trim()) images[0].revised_prompt = textNote.trim();
  return images;
}

function collectImagenPayloads(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (typeof value.bytesBase64Encoded === 'string') {
    out.push({ b64: value.bytesBase64Encoded, mime: value.mimeType || value.mime_type || 'image/png' });
  }
  if (typeof value.imageBytes === 'string') {
    out.push({ b64: value.imageBytes, mime: value.mimeType || value.mime_type || 'image/png' });
  }
  if (typeof value.base64 === 'string') {
    out.push({ b64: value.base64, mime: value.mimeType || value.mime_type || 'image/png' });
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(item => collectImagenPayloads(item, out));
    else if (child && typeof child === 'object') collectImagenPayloads(child, out);
  }
  return out;
}

async function callImagen({ apiKey, prompt, size, model, n }) {
  const modelId = model || 'imagen-4.0-generate-001';
  const parameters = {
    sampleCount: Math.max(1, Math.min(4, Number(n) || 1)),
  };
  if (size && /^2k$/i.test(size)) parameters.imageSize = '2K';
  const body = {
    instances: [{ prompt: String(prompt || '').slice(0, 4000) }],
    parameters,
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:predict`;
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'User-Agent': HORIZON_UA,
      },
      body: JSON.stringify(body),
    }),
    120_000,
    'Imagen image-gen'
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Gemini Imagen: ${msg}`);
  }
  const payloads = collectImagenPayloads(json)
    .filter(item => item && item.b64)
    .slice(0, parameters.sampleCount);
  if (!payloads.length) {
    throw new Error(`Gemini Imagen returned no image payload. Raw response: ${JSON.stringify(json).slice(0, 240)}`);
  }
  return payloads.map(item => ({
    b64: item.b64,
    mime: item.mime || 'image/png',
    prompt: body.instances[0].prompt,
    revised_prompt: null,
    model: modelId,
    provider: 'gemini',
  }));
}

/**
 * Main entry — picks provider, validates input, dispatches.
 *
 * @param {object} opts
 * @param {string} opts.provider    'openai' | 'gemini'
 * @param {string} opts.prompt      what to draw
 * @param {string} [opts.size]      '1024x1024' etc (openai only; gemini auto)
 * @param {string} [opts.model]     model id — see *_IMAGE_MODELS sets above
 * @param {number} [opts.n]         number of images
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

// Exposed so the renderer's model picker / autocompletion can know
// which model IDs are valid for image generation per provider.
function listImageModels() {
  return {
    openai: [
      { id: 'gpt-image-2',      label: 'GPT Image 2' },
      { id: 'gpt-image-1.5',    label: 'GPT Image 1.5' },
      { id: 'gpt-image-1',      label: 'GPT Image 1' },
      { id: 'gpt-image-1-mini', label: 'GPT Image 1 mini' },
    ],
    gemini: [
      { id: 'gemini-2.5-flash-image',         label: 'Gemini 2.5 Flash Image (Nano Banana)' },
      { id: 'gemini-3.1-flash-image-preview', label: 'Gemini 3.1 Flash Image Preview (Nano Banana 2)' },
      { id: 'gemini-3-pro-image-preview',     label: 'Gemini 3 Pro Image Preview (Nano Banana Pro)' },
      { id: 'imagen-4.0-generate-001',         label: 'Imagen 4' },
      { id: 'imagen-4.0-ultra-generate-001',   label: 'Imagen 4 Ultra' },
      { id: 'imagen-4.0-fast-generate-001',    label: 'Imagen 4 Fast' },
    ],
  };
}

module.exports = {
  generateImage,
  listImageModels,
  DEFAULTS,
  OPENAI_IMAGE_MODELS,
  GEMINI_IMAGE_MODELS,
  GEMINI_IMAGEN_MODELS,
};
