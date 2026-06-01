'use strict';
/**
 * v0.0.3 — Memory consolidation / insights layer (memory layer 10).
 *
 * Periodically (or on demand) clusters recent EPISODIC memories and asks the
 * user's configured provider to compress each cluster into ONE higher-order
 * "insight" memory — the episodic -> semantic step that makes long-term memory
 * feel intelligent (Generative-Agents style reflection).
 *
 * Insights are stored as ordinary memories with category 'insight' + source
 * 'consolidation', so they flow through FTS + embeddings + SQLite + recall for
 * free (no new table).
 *
 * Fully offline-safe: with no embedding key, clustering falls back to grouping
 * by category; with no chat key, synthesize is skipped and consolidate() returns
 * { created: 0, skipped: 'offline' } without throwing.
 *
 * Cost: one ~150-in / ~80-out provider call per cluster, capped at 120 recent
 * memories per pass. OFF by default in the periodic reviewer — runs on the
 * explicit `horizon mem consolidate` command / Inspector button.
 */

const PROVIDER_ENDPOINTS = {
  openai:   'https://api.openai.com/v1/chat/completions',
  claude:   'https://api.anthropic.com/v1/messages',
  groq:     'https://api.groq.com/openai/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  mistral:  'https://api.mistral.ai/v1/chat/completions',
};

function _defaultModelFor(provider) {
  return {
    openai:   'gpt-5.4-mini',
    groq:     'llama-3.3-70b-versatile',
    deepseek: 'deepseek-chat',
    mistral:  'mistral-medium-latest',
  }[provider] || '';
}

function providerHasKey(provider, keysStore) {
  if (!keysStore || typeof keysStore.get !== 'function') return false;
  if (provider === 'gemini') return !!keysStore.get('k_gemini');
  return PROVIDER_ENDPOINTS[provider] ? !!keysStore.get(`k_${provider}`) : false;
}

function parseInsight(raw) {
  if (!raw) return null;
  let txt = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(txt); }
  catch (_) {
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { parsed = JSON.parse(m[0]); } catch (_) { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const insight = typeof parsed.insight === 'string' ? parsed.insight.trim().slice(0, 240) : '';
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
  return { insight, confidence };
}

const SYSTEM_PROMPT = [
  'You compress a cluster of related memories about ONE user into a single higher-order insight.',
  'The insight must state a PATTERN, preference, or theme that the individual memories do not state outright.',
  'Return RAW JSON ONLY: {"insight":"<= 200 chars generalization","confidence":0.0..1.0}',
  'If the cluster has no non-trivial generalization, return {"insight":""}.',
  'No prose, no markdown fences.',
].join('\n');

/** Generic single-shot JSON chat call against the active provider. Mirrors the
 *  dialecticExtractor dispatch; returns '' on any failure (offline-safe). */
async function callProviderJson(system, user, { settingsStore, keysStore, maxTokens = 220 } = {}) {
  try {
    const provider = settingsStore?.get?.('provider') || 'gemini';
    if (provider === 'gemini') {
      const key = keysStore?.get?.('k_gemini');
      if (!key) return '';
      const model = settingsStore?.get?.('geminiModel') || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
      };
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) return '';
      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
    const url = PROVIDER_ENDPOINTS[provider];
    if (!url) return '';
    const key = keysStore?.get?.(`k_${provider}`);
    if (!key) return '';
    if (provider === 'claude') {
      const body = {
        model: settingsStore?.get?.('model.claude') || 'claude-sonnet-4-6',
        max_tokens: maxTokens, temperature: 0.2, system,
        messages: [{ role: 'user', content: user }],
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return '';
      const data = await res.json();
      return data?.content?.[0]?.text || '';
    }
    const body = {
      model: settingsStore?.get?.(`model.${provider}`) || _defaultModelFor(provider),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.2, max_tokens: maxTokens,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  } catch (_) { return ''; }
}

function clusterByEmbedding(items, embeddings, threshold) {
  const { cosine } = require('./embeddings');
  const vecs = items.map(m => embeddings.index.get(m.key) || null);
  const used = new Array(items.length).fill(false);
  const clusters = [];
  for (let i = 0; i < items.length; i++) {
    if (used[i] || !vecs[i]) continue;
    const cluster = [items[i]];
    used[i] = true;
    for (let j = i + 1; j < items.length; j++) {
      if (used[j] || !vecs[j]) continue;
      if (cosine(vecs[i], vecs[j]) >= threshold) { cluster.push(items[j]); used[j] = true; }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function clusterByCategory(items) {
  const byCat = new Map();
  for (const m of items) {
    const c = m.category || 'general';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(m);
  }
  return [...byCat.values()];
}

/** Cluster recent episodic memories (excluding existing insights). */
function clusterRecent(agentMemory, opts = {}) {
  const maxMemories = opts.maxMemories || 120;
  const minClusterSize = opts.minClusterSize || 3;
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.82;
  const recent = (typeof agentMemory.getRecent === 'function' ? agentMemory.getRecent(maxMemories) : [])
    .filter(m => m && m.content && m.category !== 'insight' && m.source !== 'consolidation');
  if (recent.length < minClusterSize) return [];
  const emb = agentMemory.embeddings;
  const clusters = (emb && typeof emb.isAvailable === 'function' && emb.isAvailable())
    ? clusterByEmbedding(recent, emb, threshold)
    : clusterByCategory(recent);
  return clusters.filter(c => c.length >= minClusterSize);
}

/** Synthesize one insight from a cluster. deps.synthFn overrides the provider
 *  call (used by tests). Returns { insight, confidence } or null. */
async function synthesize(cluster, deps = {}) {
  if (typeof deps.synthFn === 'function') {
    const r = await deps.synthFn(cluster);
    return r && typeof r === 'object' ? r : parseInsight(r);
  }
  const bullets = cluster.slice(0, 12).map(m => `- ${String(m.content).slice(0, 200)}`).join('\n');
  const text = await callProviderJson(SYSTEM_PROMPT, 'MEMORIES:\n' + bullets, deps);
  return parseInsight(text);
}

/**
 * Run a consolidation pass. Returns { ok, created, clusters, skipped }.
 * Never throws — offline / no-key → { created: 0, skipped: 'offline' }.
 */
async function consolidate(agentMemory, deps = {}, opts = {}) {
  try {
    if (!agentMemory || typeof agentMemory.remember !== 'function') {
      return { ok: false, error: 'no agent memory', created: 0, clusters: 0 };
    }
    const clusters = clusterRecent(agentMemory, opts);
    if (!clusters.length) return { ok: true, created: 0, clusters: 0, skipped: 'no-clusters' };

    // A real provider call needs a key — unless a test stub is supplied.
    if (typeof deps.synthFn !== 'function') {
      const provider = deps.settingsStore?.get?.('provider') || 'gemini';
      if (!providerHasKey(provider, deps.keysStore)) {
        return { ok: true, created: 0, clusters: clusters.length, skipped: 'offline' };
      }
    }

    let created = 0;
    for (const cluster of clusters) {
      const obj = await synthesize(cluster, deps);
      if (!obj || !obj.insight || obj.insight.length < 8) continue;
      // Dedup: skip if an identical normalized insight already exists.
      const norm = typeof agentMemory._normalizeText === 'function' ? agentMemory._normalizeText(obj.insight) : obj.insight;
      const key = typeof agentMemory._memoryKey === 'function' ? agentMemory._memoryKey(norm, 'insight') : null;
      if (key && (agentMemory._data.memories || []).some(m => m.key === key)) continue;
      const importance = Math.max(6, Math.min(9, 6 + Math.round((obj.confidence || 0.5) * 3)));
      agentMemory.remember(obj.insight, 'insight', importance, 'consolidation');
      created++;
    }
    return { ok: true, created, clusters: clusters.length };
  } catch (e) {
    return { ok: false, error: e.message, created: 0, clusters: 0 };
  }
}

module.exports = { consolidate, clusterRecent, synthesize, parseInsight, providerHasKey, callProviderJson };
