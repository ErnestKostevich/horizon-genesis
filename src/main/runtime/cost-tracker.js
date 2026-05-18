// Cost tracker — appends one JSONL line per AI call so we can show
// the user how much they're actually spending.
//
// Persists to <userData>/horizon-cost.jsonl. Each line is:
//   {at, provider, model, prompt, completion, total, source, costUsd}
//
// `costUsd` is computed from a small price table (mid-2026 list prices).
// Prices are intentionally approximate — we want to surface "you spent
// roughly $X today", not be a billing system. If the table is missing a
// model the cost field is null and we count only token totals.

const fs = require('fs');
const path = require('path');

// Per-million-token USD prices, prompt + completion separately.
// Source: provider pricing pages (mid-2026). Update when prices change.
const PRICES = {
  // Anthropic
  'claude-sonnet-4-6':    { in: 3.00,  out: 15.00 },
  'claude-opus-4-7':      { in: 15.00, out: 75.00 },
  'claude-haiku-4-5':     { in: 0.80,  out: 4.00 },
  // OpenAI
  'gpt-5.5':              { in: 5.00,  out: 20.00 },
  'gpt-5.4':              { in: 1.25,  out: 10.00 },
  'gpt-5.4-mini':         { in: 0.15,  out: 0.60 },
  'gpt-5.3-codex':        { in: 1.50,  out: 12.00 },
  'gpt-5.2':              { in: 0.50,  out: 4.00 },
  'o3':                   { in: 10.00, out: 40.00 },
  'o4-mini':              { in: 1.10,  out: 4.40 },
  // Google Gemini
  'gemini-2.5-flash':     { in: 0.10,  out: 0.40 },  // also free tier
  'gemini-2.5-flash-lite':{ in: 0.05,  out: 0.20 },
  'gemini-2.5-pro':       { in: 1.25,  out: 5.00 },
  'gemini-3.1-flash-preview':{ in: 0.12, out: 0.50 },
  'gemini-3.1-pro-preview':  { in: 2.50, out: 10.00 },
  'gemini-3.0-pro-preview':  { in: 1.50, out: 6.00 },
  // Groq — much cheaper than OpenAI hosted versions
  'llama-3.3-70b-versatile': { in: 0.59, out: 0.79 },
  'llama-3.1-8b-instant':    { in: 0.05, out: 0.08 },
  'openai/gpt-oss-120b':     { in: 0.15, out: 0.75 },  // groq's hosting
  'moonshotai/kimi-k2-instruct': { in: 1.00, out: 3.00 },
  'qwen/qwen3-32b':          { in: 0.29, out: 0.39 },
  // DeepSeek — cheapest non-local
  'deepseek-chat':           { in: 0.14, out: 0.28 },
  'deepseek-reasoner':       { in: 0.55, out: 2.19 },
  // Grok (xAI)
  'grok-4':                  { in: 5.00,  out: 15.00 },
  'grok-4-fast-reasoning':   { in: 0.20,  out: 0.50 },
  'grok-4-mini':             { in: 0.30,  out: 1.50 },
  'grok-code-fast-1':        { in: 0.20,  out: 1.50 },
  // Mistral
  'mistral-large-latest':    { in: 2.00,  out: 6.00 },
  'mistral-medium-latest':   { in: 0.40,  out: 2.00 },
  'mistral-small-latest':    { in: 0.10,  out: 0.30 },
  'codestral-latest':        { in: 0.20,  out: 0.60 },
  // Qwen
  'qwen-plus':               { in: 0.40,  out: 1.20 },
  'qwen3-max':               { in: 1.60,  out: 6.40 },
  'qwen3-coder-plus':        { in: 1.00,  out: 5.00 },
  // Perplexity
  'sonar':                   { in: 1.00,  out: 1.00 },
  'sonar-pro':               { in: 3.00,  out: 15.00 },
  'sonar-reasoning':         { in: 1.00,  out: 5.00 },
  'sonar-reasoning-pro':     { in: 2.00,  out: 8.00 },
  // Cohere
  'command-a-03-2025':       { in: 2.50,  out: 10.00 },
  'command-a-reasoning-08-2025': { in: 2.50, out: 10.00 },
  // Local providers — always free
  'llama3.1':                { in: 0, out: 0 },
  'local-model':             { in: 0, out: 0 },
};

function priceOf(model) {
  if (!model) return null;
  if (PRICES[model]) return PRICES[model];
  // OpenRouter passes the underlying model id — try to match
  const compact = model.replace(/^.+\//, '');
  if (PRICES[compact]) return PRICES[compact];
  return null;
}

function costUsd(model, usage) {
  if (!usage) return null;
  const p = priceOf(model);
  if (!p) return null;
  const cost = (usage.prompt * p.in + usage.completion * p.out) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimals
}

class CostTracker {
  constructor(userDataDir) {
    this.path = path.join(userDataDir, 'horizon-cost.jsonl');
  }

  record({ provider, model, usage, source }) {
    if (!usage) return null;
    const entry = {
      at: new Date().toISOString(),
      provider, model,
      prompt: usage.prompt || 0,
      completion: usage.completion || 0,
      total: usage.total || 0,
      source: source || 'cli',
      costUsd: costUsd(model, usage),
    };
    try {
      fs.appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf8');
    } catch (_) { /* tracker is best-effort */ }
    return entry;
  }

  /**
   * Load up to the last N entries (default last 10000 = ~100 days of
   * heavy usage). Older entries stay on disk but aren't aggregated.
   */
  load(limit = 10000) {
    if (!fs.existsSync(this.path)) return [];
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const slice = lines.slice(-limit);
      const out = [];
      for (const l of slice) {
        try { out.push(JSON.parse(l)); } catch (_) {}
      }
      return out;
    } catch (_) { return []; }
  }

  summary({ days = 30 } = {}) {
    const entries = this.load();
    const since = Date.now() - days * 86400_000;
    const recent = entries.filter(e => new Date(e.at).getTime() >= since);

    const byProvider = {};
    const byModel = {};
    const byDay = {};
    let totalCost = 0;
    let totalTokens = 0;
    let calls = 0;

    for (const e of recent) {
      calls++;
      totalTokens += e.total || 0;
      totalCost += e.costUsd || 0;

      const dayKey = e.at.slice(0, 10);
      byDay[dayKey] = byDay[dayKey] || { calls: 0, tokens: 0, costUsd: 0 };
      byDay[dayKey].calls++;
      byDay[dayKey].tokens += e.total || 0;
      byDay[dayKey].costUsd += e.costUsd || 0;

      byProvider[e.provider] = byProvider[e.provider] || { calls: 0, tokens: 0, costUsd: 0 };
      byProvider[e.provider].calls++;
      byProvider[e.provider].tokens += e.total || 0;
      byProvider[e.provider].costUsd += e.costUsd || 0;

      const modelKey = `${e.provider}/${e.model}`;
      byModel[modelKey] = byModel[modelKey] || { calls: 0, tokens: 0, costUsd: 0 };
      byModel[modelKey].calls++;
      byModel[modelKey].tokens += e.total || 0;
      byModel[modelKey].costUsd += e.costUsd || 0;
    }

    return {
      since: new Date(since).toISOString(),
      days,
      totals: { calls, tokens: totalTokens, costUsd: round(totalCost) },
      byProvider: mapRound(byProvider),
      byModel: mapRound(byModel),
      byDay: mapRound(byDay),
    };
  }

  prune({ olderThanDays = 365 } = {}) {
    if (!fs.existsSync(this.path)) return { ok: true, kept: 0, removed: 0 };
    const cutoff = Date.now() - olderThanDays * 86400_000;
    const entries = this.load(Infinity);
    const kept = entries.filter(e => new Date(e.at).getTime() >= cutoff);
    const removed = entries.length - kept.length;
    fs.writeFileSync(this.path, kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
    return { ok: true, kept: kept.length, removed };
  }
}

function round(n) { return Math.round(n * 10000) / 10000; }
function mapRound(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = { ...v, costUsd: round(v.costUsd) };
  }
  return out;
}

module.exports = { CostTracker, PRICES, priceOf, costUsd };
