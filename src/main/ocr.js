'use strict';
/**
 * Horizon AI — OCR module (Tesseract.js wrapper)
 *
 * Sprint 7D — replaces the LLM-vision "smart_click" loop with cheap, fast,
 * fully-offline text recognition.
 *
 * Tesseract.js is listed as an OPTIONAL dependency (~50 MB) — we lazy-load
 * it on first call and gracefully fall back when it isn't installed. The
 * single worker is cached across calls so the language data file (~10 MB)
 * is only mapped into memory once.
 *
 * Exports:
 *   - isAvailable() — boolean, true iff `tesseract.js` requires successfully
 *   - loadWorker()  — returns the cached worker (creates it on first call)
 *   - runOcr(buf)   — { text, blocks: [{text, x, y, w, h, confidence}] }
 *   - findInImage(buf, query) — { x, y, w, h, text, confidence } | null
 *   - terminate()   — shuts down the worker (used on quit / for tests)
 *
 * Image input is a Node Buffer (PNG or JPEG) — `desktopCapturer` already
 * gives us `thumbnail.toPNG()`, so the caller just passes that directly.
 */

let _Tesseract = null;
let _tesseractAvailable = null; // tri-state: null=unknown, true/false=cached
let _worker = null;
let _workerPromise = null;     // de-dupe concurrent loadWorker() calls

function _tryRequireTesseract() {
  if (_tesseractAvailable !== null) return _tesseractAvailable;
  try {
    _Tesseract = require('tesseract.js');
    _tesseractAvailable = true;
  } catch (_) {
    _Tesseract = null;
    _tesseractAvailable = false;
  }
  return _tesseractAvailable;
}

function isAvailable() {
  return _tryRequireTesseract();
}

/**
 * Returns the error message to surface when OCR is unavailable.
 * Kept as a function so the CLI / UI / tools share identical phrasing.
 */
function unavailableMessage() {
  return 'OCR requires `npm i tesseract.js`. Falling back to vision LLM.';
}

async function loadWorker(lang = 'eng') {
  if (!_tryRequireTesseract()) {
    throw new Error(unavailableMessage());
  }
  if (_worker) return _worker;
  if (_workerPromise) return _workerPromise;

  _workerPromise = (async () => {
    // tesseract.js v4+ uses createWorker; older v2 uses Tesseract.recognize
    if (typeof _Tesseract.createWorker === 'function') {
      const worker = await _Tesseract.createWorker(lang);
      _worker = worker;
      return worker;
    }
    // Fallback: v2-style — wrap recognize in a worker-like object.
    _worker = {
      _v2: true,
      recognize: async (img) => _Tesseract.recognize(img, lang),
      terminate: async () => {},
    };
    return _worker;
  })();

  try {
    return await _workerPromise;
  } finally {
    _workerPromise = null;
  }
}

async function terminate() {
  if (_worker) {
    try { await _worker.terminate(); } catch (_) {}
    _worker = null;
  }
}

/**
 * Normalize a tesseract.js result into our flat block shape.
 * Tesseract returns nested blocks → paragraphs → lines → words; we flatten
 * to "words" (the most useful level for click targeting) and also keep the
 * full extracted text.
 */
function _normalizeResult(res) {
  const data = res?.data || res || {};
  const text = String(data.text || '').trim();
  const words = Array.isArray(data.words) ? data.words : [];

  const blocks = words.map(w => {
    const bbox = w.bbox || w.box || {};
    const x0 = Number(bbox.x0 ?? bbox.x ?? 0);
    const y0 = Number(bbox.y0 ?? bbox.y ?? 0);
    const x1 = Number(bbox.x1 ?? (x0 + (bbox.width || 0)));
    const y1 = Number(bbox.y1 ?? (y0 + (bbox.height || 0)));
    return {
      text: String(w.text || '').trim(),
      x: x0,
      y: y0,
      w: Math.max(0, x1 - x0),
      h: Math.max(0, y1 - y0),
      confidence: Math.round(Number(w.confidence || 0)),
    };
  }).filter(b => b.text.length > 0);

  return { text, blocks };
}

/**
 * Run OCR on the full image. `imageBuffer` is a Node Buffer (PNG/JPEG)
 * or anything tesseract.js accepts (string path, ImageData, Canvas).
 */
async function runOcr(imageBuffer) {
  if (!_tryRequireTesseract()) {
    return { ok: false, error: unavailableMessage(), text: '', blocks: [] };
  }
  try {
    const worker = await loadWorker();
    const res = await worker.recognize(imageBuffer);
    const { text, blocks } = _normalizeResult(res);
    return { ok: true, text, blocks };
  } catch (e) {
    return { ok: false, error: e.message, text: '', blocks: [] };
  }
}

/**
 * Run OCR on a sub-region. We use sharp (already a devDependency) to crop
 * before handing to tesseract — Tesseract has a built-in rect option but
 * cropping first is faster and avoids edge issues with display scaling.
 *
 * Returns same shape as runOcr, with coordinates offset back to the
 * original image's coordinate space.
 */
async function runOcrRegion(imageBuffer, x, y, w, h) {
  if (!_tryRequireTesseract()) {
    return { ok: false, error: unavailableMessage(), text: '', blocks: [] };
  }
  let cropped = imageBuffer;
  try {
    // sharp is a devDep — present in production via electron-builder?
    // Treat it as optional too: if missing, fall back to full-image OCR
    // and let Tesseract's rectangle option do the work.
    const sharp = require('sharp');
    cropped = await sharp(imageBuffer)
      .extract({ left: Math.max(0, x|0), top: Math.max(0, y|0), width: Math.max(1, w|0), height: Math.max(1, h|0) })
      .png()
      .toBuffer();
  } catch (_) {
    // sharp missing — pass through and use tesseract's rectangle param
    try {
      const worker = await loadWorker();
      const res = await worker.recognize(imageBuffer, { rectangle: { left: x|0, top: y|0, width: w|0, height: h|0 } });
      const { text, blocks } = _normalizeResult(res);
      const offsetBlocks = blocks.map(b => ({ ...b, x: b.x + (x|0), y: b.y + (y|0) }));
      return { ok: true, text, blocks: offsetBlocks };
    } catch (e) {
      return { ok: false, error: e.message, text: '', blocks: [] };
    }
  }

  try {
    const worker = await loadWorker();
    const res = await worker.recognize(cropped);
    const { text, blocks } = _normalizeResult(res);
    const offsetBlocks = blocks.map(b => ({ ...b, x: b.x + (x|0), y: b.y + (y|0) }));
    return { ok: true, text, blocks: offsetBlocks };
  } catch (e) {
    return { ok: false, error: e.message, text: '', blocks: [] };
  }
}

/**
 * Find the first OCR block matching `query` in `imageBuffer`.
 *
 * Match strategy:
 *   1. Exact (case-insensitive) word match — best for "Save", "Submit"
 *   2. Substring match on the joined word text
 *   3. Multi-word sequence match (e.g. "Sign In" matches two adjacent words)
 *
 * @param {Buffer} imageBuffer
 * @param {string} query
 * @param {object} [opts]
 * @param {boolean} [opts.exact=false]
 * @param {boolean} [opts.caseSensitive=false]
 * @returns {Promise<{x:number,y:number,w:number,h:number,text:string,confidence:number}|null>}
 */
async function findInImage(imageBuffer, query, opts = {}) {
  if (!_tryRequireTesseract()) {
    return { ok: false, error: unavailableMessage(), match: null };
  }
  const q = String(query || '').trim();
  if (!q) return { ok: true, match: null };

  const { exact = false, caseSensitive = false } = opts;
  const res = await runOcr(imageBuffer);
  if (!res.ok) return res;
  const blocks = res.blocks;

  const norm = (s) => caseSensitive ? s : s.toLowerCase();
  const needle = norm(q);
  const tokens = needle.split(/\s+/).filter(Boolean);

  // 1) exact / single-word case
  if (tokens.length === 1) {
    for (const b of blocks) {
      const t = norm(b.text);
      if (exact ? t === needle : (t === needle || t.includes(needle))) {
        return { ok: true, match: b };
      }
    }
  } else {
    // 2) multi-word: find consecutive blocks whose .text values match in order
    for (let i = 0; i <= blocks.length - tokens.length; i++) {
      let allMatch = true;
      for (let k = 0; k < tokens.length; k++) {
        const t = norm(blocks[i + k].text);
        if (exact ? t !== tokens[k] : !t.includes(tokens[k])) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        // merge bboxes of the matched run
        const run = blocks.slice(i, i + tokens.length);
        const x0 = Math.min(...run.map(b => b.x));
        const y0 = Math.min(...run.map(b => b.y));
        const x1 = Math.max(...run.map(b => b.x + b.w));
        const y1 = Math.max(...run.map(b => b.y + b.h));
        const avgConf = Math.round(run.reduce((s, b) => s + b.confidence, 0) / run.length);
        return {
          ok: true,
          match: {
            text: run.map(b => b.text).join(' '),
            x: x0, y: y0, w: x1 - x0, h: y1 - y0,
            confidence: avgConf,
          },
        };
      }
    }
  }

  return { ok: true, match: null };
}

module.exports = {
  isAvailable,
  unavailableMessage,
  loadWorker,
  terminate,
  runOcr,
  runOcrRegion,
  findInImage,
  // internals exported for unit tests
  _normalizeResult,
};
