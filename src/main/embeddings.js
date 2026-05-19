'use strict';
/**
 * Horizon Embeddings — semantic recall service.
 *
 * Provides a small async API on top of OpenAI (preferred) or Gemini text
 * embeddings. Stores per-memory embedding vectors in a sidecar JSON file
 * next to horizon_memory.json so the main memory file stays human-
 * readable. Vectors are quantised to 256 dimensions to keep the index
 * compact (~1 KB per memory; 2000 memories ≈ 2 MB).
 *
 * AgentMemory wires this in via setEmbeddingService(svc). Without a
 * configured key, every call returns null and recall transparently
 * falls back to the keyword scorer — no regression.
 *
 * Design choices:
 *  - 256 dims (OpenAI text-embedding-3-small supports `dimensions` param;
 *    Gemini text-embedding-004 supports `outputDimensionality`). Cosine
 *    quality at 256 is close to full 1536 for retrieval use cases per
 *    OpenAI's own ablation.
 *  - Float32Array on the hot path; serialise as plain number[] to JSON
 *    (slightly wasteful but human-debuggable).
 *  - LRU cache (capacity 128) for query embeddings — embeddings are
 *    deterministic and queries repeat (especially during testing).
 *  - All network calls are guarded by a per-request timeout; failures
 *    log + bubble null, never throw, so callers can `?.` through.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DIM = 256;
const REQUEST_TIMEOUT_MS = 12000;
const QUERY_LRU_CAP = 128;
const BATCH_SIZE = 32; // OpenAI accepts up to 2048 inputs per call; Gemini 100.

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

class LruCache {
  constructor(cap) {
    this.cap = cap;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.cap) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
  }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

class EmbeddingService {
  /**
   * @param {object} opts
   * @param {object} opts.keysStore   — electron-store keysStore for k_openai / k_gemini
   * @param {object} opts.settingsStore — for provider preference
   * @param {string} [opts.sidecarPath] — explicit path; otherwise derived from memoryPath
   * @param {string} [opts.memoryPath]  — used to derive sidecar path
   * @param {number} [opts.dim]         — vector dimensionality (default 256)
   */
  constructor(opts = {}) {
    this.keysStore = opts.keysStore || null;
    this.settingsStore = opts.settingsStore || null;
    this.dim = Number(opts.dim) || DEFAULT_DIM;
    if (opts.sidecarPath) {
      this.sidecarPath = opts.sidecarPath;
    } else if (opts.memoryPath) {
      const dir = path.dirname(opts.memoryPath);
      this.sidecarPath = path.join(dir, 'horizon_embeddings.json');
    } else {
      this.sidecarPath = null;
    }
    this.index = new Map();     // key → Float32Array
    this.indexProvider = null;  // 'openai' | 'gemini' | null
    this.indexDim = this.dim;
    this.queryCache = new LruCache(QUERY_LRU_CAP);
    this.dirty = false;
    this.lastError = '';
    this.lastErrorAt = null;
    this.lastRunAt = null;
    this.embedCount = 0;
    this.fetchImpl = opts.fetch || global.fetch || null;
    if (!this.fetchImpl) {
      try { this.fetchImpl = require('node-fetch'); }
      catch (_) { /* will fail at call time with a clear error */ }
    }
    this._loadSidecar();
  }

  // ── Provider selection ───────────────────────────────────────────────
  _key(id) {
    try { return this.keysStore?.get?.(`k_${id}`) || ''; } catch { return ''; }
  }

  preferredProvider() {
    const pref = this.settingsStore?.get?.('embeddings.provider') || '';
    if (pref === 'openai' && this._key('openai')) return 'openai';
    if (pref === 'gemini' && this._key('gemini')) return 'gemini';
    if (this._key('openai')) return 'openai';
    if (this._key('gemini')) return 'gemini';
    return null;
  }

  isAvailable() { return Boolean(this.preferredProvider()); }

  // ── Sidecar persistence ──────────────────────────────────────────────
  _loadSidecar() {
    if (!this.sidecarPath) return;
    try {
      if (!fs.existsSync(this.sidecarPath)) return;
      const raw = fs.readFileSync(this.sidecarPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.indexProvider = parsed?.provider || null;
      this.indexDim = parsed?.dim || this.dim;
      this.dim = this.indexDim;
      const entries = parsed?.vectors || {};
      this.index.clear();
      for (const [key, arr] of Object.entries(entries)) {
        if (Array.isArray(arr) && arr.length === this.indexDim) {
          this.index.set(key, Float32Array.from(arr));
        }
      }
      this.embedCount = this.index.size;
    } catch (e) {
      console.warn('[embeddings] load failed:', e.message);
    }
  }

  saveSidecar() {
    if (!this.sidecarPath || !this.dirty) return;
    try {
      const out = {
        version: 1,
        provider: this.indexProvider,
        dim: this.indexDim,
        savedAt: new Date().toISOString(),
        vectors: {},
      };
      for (const [key, vec] of this.index.entries()) {
        out.vectors[key] = Array.from(vec);
      }
      fs.writeFileSync(this.sidecarPath, JSON.stringify(out));
      this.dirty = false;
    } catch (e) {
      console.warn('[embeddings] save failed:', e.message);
    }
  }

  status() {
    return {
      available: this.isAvailable(),
      provider: this.preferredProvider() || this.indexProvider,
      activeIndexProvider: this.indexProvider,
      indexed: this.index.size,
      dim: this.indexDim,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      lastRunAt: this.lastRunAt,
      cacheSize: this.queryCache.size,
      sidecarPath: this.sidecarPath,
    };
  }

  // ── Embedding API calls ──────────────────────────────────────────────
  async _embedOpenAI(texts) {
    const key = this._key('openai');
    if (!key) throw new Error('no openai key');
    const body = {
      model: 'text-embedding-3-small',
      input: texts,
      dimensions: this.dim,
      encoding_format: 'float',
    };
    const res = await this._fetchWithTimeout('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!Array.isArray(data.data)) throw new Error('OpenAI embeddings: missing data array');
    return data.data.map(d => Float32Array.from(d.embedding || []));
  }

  async _embedGemini(texts) {
    const key = this._key('gemini');
    if (!key) throw new Error('no gemini key');
    // PHASE 28.1 — text-embedding-004 was deprecated from v1beta in mid-2026
    // and now 404s. The current GA model is gemini-embedding-001 (still
    // served on v1beta, just under a new name). We try it first and fall
    // back to the old name only if the new one also 404s — that keeps the
    // old keys working while we cut over.
    //
    // BATCH endpoint takes an array of {content, outputDimensionality} in a
    // single request. The sequential per-text path used to hang reindex
    // for 60+ seconds on 159 memories; batchEmbedContents collapses this
    // to one network round-trip per batch of 32.
    const tryModel = async (modelId) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:batchEmbedContents?key=${encodeURIComponent(key)}`;
      const body = {
        requests: texts.map(text => ({
          model: `models/${modelId}`,
          content: { parts: [{ text }] },
          outputDimensionality: this.dim,
        })),
      };
      const res = await this._fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res;
    };

    const MODEL_CHAIN = ['gemini-embedding-001', 'text-embedding-004'];
    let res = null;
    let lastErr = '';
    for (const m of MODEL_CHAIN) {
      try {
        res = await tryModel(m);
        if (res.ok) break;
        if (res.status === 404) {
          lastErr = `${m} → 404`;
          continue; // try next model in the chain
        }
        const errText = await res.text().catch(() => '');
        throw new Error(`Gemini embeddings HTTP ${res.status} (${m}): ${errText.slice(0, 300)}`);
      } catch (e) {
        if (/404/.test(e.message)) { lastErr = e.message; continue; }
        throw e;
      }
    }
    if (!res || !res.ok) {
      throw new Error(`Gemini embeddings: all models 404'd. Last error: ${lastErr || 'unknown'}. Hint: your Gemini key may not have embedding-API access — try an OpenAI key (text-embedding-3-small is cheap) or check console.cloud.google.com → enabled APIs.`);
    }
    const data = await res.json();
    if (!Array.isArray(data?.embeddings)) {
      throw new Error(`Gemini embeddings: malformed response (${JSON.stringify(data).slice(0, 200)})`);
    }
    return data.embeddings.map(e => {
      const vec = e?.values || [];
      if (!Array.isArray(vec) || !vec.length) return null;
      return Float32Array.from(vec);
    });
  }

  async _fetchWithTimeout(url, init) {
    if (!this.fetchImpl) throw new Error('no fetch implementation available');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Compute embeddings for a batch of texts. Returns array of Float32Array
   * aligned 1:1 with `texts`. On error returns null array entries — caller
   * decides whether to mark items as failed or retry.
   */
  async embedBatch(texts) {
    if (!Array.isArray(texts) || !texts.length) return [];
    const provider = this.preferredProvider();
    if (!provider) {
      this.lastError = 'no embedding key (configure OpenAI or Gemini)';
      return texts.map(() => null);
    }
    const cleaned = texts.map(t => String(t || '').trim().slice(0, 8000));
    try {
      const out = provider === 'openai'
        ? await this._embedOpenAI(cleaned)
        : await this._embedGemini(cleaned);
      this.lastError = '';
      this.lastErrorAt = null;
      this.lastRunAt = new Date().toISOString();
      this.indexProvider = provider;
      this.indexDim = out[0]?.length || this.indexDim;
      return out;
    } catch (e) {
      this.lastError = e.message || String(e);
      this.lastErrorAt = new Date().toISOString();
      console.warn('[embeddings] batch failed:', this.lastError);
      return texts.map(() => null);
    }
  }

  /** Embed a single text, with LRU caching by exact-text key. */
  async embed(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const cacheKey = `${this.preferredProvider() || 'none'}:${t.slice(0, 200)}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached) return cached;
    const [vec] = await this.embedBatch([t]);
    if (vec) this.queryCache.set(cacheKey, vec);
    return vec || null;
  }

  // ── Index management ────────────────────────────────────────────────
  has(key) { return this.index.has(key); }

  setVector(key, vec) {
    if (!vec) return;
    this.index.set(String(key), vec);
    this.dirty = true;
    this.embedCount = this.index.size;
  }

  removeVector(key) {
    if (this.index.delete(String(key))) {
      this.dirty = true;
      this.embedCount = this.index.size;
    }
  }

  pruneKeys(activeKeys) {
    const live = new Set((activeKeys || []).map(String));
    let removed = 0;
    for (const key of [...this.index.keys()]) {
      if (!live.has(key)) {
        this.index.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      this.dirty = true;
      this.embedCount = this.index.size;
    }
    return removed;
  }

  /**
   * Score every indexed vector against a query embedding. Returns
   * [{key, score}] sorted desc, no threshold (caller filters/picks topK).
   */
  scoreAgainst(queryVec) {
    if (!queryVec || !this.index.size) return [];
    const out = [];
    for (const [key, vec] of this.index.entries()) {
      out.push({ key, score: cosine(queryVec, vec) });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  /**
   * Fill in missing embeddings for a list of {key, text} items in batches.
   * Reports progress via onProgress({done, total, failed, lastError}).
   * Returns {ok, indexed, alreadyIndexed, bad, failed, skipped}.
   *
   * `alreadyIndexed` — items the caller asked us to index that already
   * have a vector in this.index. These are NOT failures.
   *
   * `bad` — items rejected because they were missing `key` or `text`.
   * Surfacing this separately so the UI can distinguish "159 vectors
   * already cached" from "159 records had no key field" — the old
   * `skipped` lumped both together which made the inspector report
   * 0/N indexed even though the chat said "all indexed".
   */
  async backfill(items, opts = {}) {
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const total = (items || []).length;
    const good = (items || []).filter(i => i && i.key && i.text);
    const bad = total - good.length;
    const work = good.filter(i => !this.index.has(i.key));
    const alreadyIndexed = good.length - work.length;
    if (!work.length) {
      this.saveSidecar();
      return {
        ok: true,
        indexed: 0,
        alreadyIndexed,
        bad,
        failed: 0,
        // `skipped` kept for back-compat — equals everything we didn't write.
        skipped: alreadyIndexed + bad,
      };
    }
    if (!this.isAvailable()) {
      return {
        ok: false,
        indexed: 0,
        alreadyIndexed,
        bad,
        failed: 0,
        skipped: work.length + alreadyIndexed + bad,
        error: 'no embedding key',
      };
    }
    let indexed = 0;
    let failed = 0;
    let consecutiveTotalFailures = 0;  // count batches where 100% failed
    for (let i = 0; i < work.length; i += BATCH_SIZE) {
      const slice = work.slice(i, i + BATCH_SIZE);
      const vecs = await this.embedBatch(slice.map(s => s.text));
      let batchOk = 0;
      let batchFail = 0;
      for (let j = 0; j < slice.length; j++) {
        const vec = vecs[j];
        if (vec && vec.length) {
          this.setVector(slice[j].key, vec);
          indexed++;
          batchOk++;
        } else {
          failed++;
          batchFail++;
        }
      }
      // Save after every batch — interrupted runs keep partial progress.
      this.saveSidecar();
      onProgress({ done: i + slice.length, total: work.length, indexed, failed, lastError: this.lastError });
      // Bail only if TWO batches in a row had zero success — that's almost
      // certainly an auth/quota/network issue, not a per-item bad input.
      if (batchOk === 0 && batchFail > 0) {
        consecutiveTotalFailures++;
        if (consecutiveTotalFailures >= 2) break;
      } else {
        consecutiveTotalFailures = 0;
      }
    }
    return {
      ok: indexed > 0 && failed === 0,
      indexed,
      alreadyIndexed,
      bad,
      failed,
      skipped: alreadyIndexed + bad + (work.length - indexed - failed),
      error: failed > 0 ? this.lastError : '',
    };
  }
}

module.exports = { EmbeddingService, cosine };
