'use strict';
/**
 * Horizon Skills — relevance scoring
 *
 * v1: bag-of-words overlap between query and skill {description, name, tags}.
 * Deterministic, debuggable, no model call. The skillsManager calls
 * selectRelevantSkills(skills, query, opts) once per turn; the result is
 * fenced into the system prompt as "## Skills loaded for this turn".
 *
 * Why not embeddings:
 *   - extra model call per turn (cost + latency, especially on local providers)
 *   - cache invalidation on every SKILL.md edit
 *   - silent failures when running offline on Ollama / LMStudio
 *   - keyword matching is inspectable; the inspector shows per-skill score breakdown
 * Swap-in path: replace scoreSkill() — selectRelevantSkills's contract stays the same.
 */

// Common English + Russian stopwords. Kept small on purpose — over-filtering
// hurts recall more than false-positive hits cost (we cap to 3 skills).
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'has',
  'have', 'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'that',
  'the', 'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'with', 'you', 'your',
  // Russian — high-frequency function words
  'и', 'в', 'не', 'на', 'я', 'что', 'он', 'с', 'как', 'это', 'но', 'у', 'к',
  'или', 'же', 'мне', 'мы', 'вы', 'ты', 'для', 'по', 'из', 'за', 'о', 'от',
  'до', 'при', 'над', 'под',
]);

const WORD_RE = /[\p{L}\p{N}]{2,}/gu;

const WEIGHTS = {
  description: 1.0,
  name: 0.6,
  tags: 0.4,
  aliases: 0.8,
  triggers: 1.2,
  examples: 0.7,
  recentUsage: 0.25,
};

const DEFAULT_THRESHOLD = 0.15;
const DEFAULT_MAX_SKILLS = 3;

function tokenize(text) {
  const out = [];
  const seen = new Set();
  const matches = String(text || '').toLowerCase().match(WORD_RE) || [];
  for (let w of matches) {
    if (STOPWORDS.has(w)) continue;
    // Trivial English stemming. Russian is left as-is — endings vary too much
    // for naive stripping and STOPWORDS already catches the worst offenders.
    if (w.length > 4) {
      if (w.endsWith('ing')) w = w.slice(0, -3);
      else if (w.endsWith('ed') && w.length > 5) w = w.slice(0, -2);
      else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    }
    if (w.length < 2) continue;
    if (!seen.has(w)) { seen.add(w); out.push(w); }
  }
  return out;
}

function overlap(queryTokens, fieldTokens) {
  if (!queryTokens.length || !fieldTokens.length) return 0;
  const fieldSet = new Set(fieldTokens);
  let hits = 0;
  for (const t of queryTokens) {
    if (fieldSet.has(t)) hits++;
  }
  // Normalise by the smaller set so a long description doesn't drown
  // out a short query (we want recall on the user's intent).
  return hits / Math.min(queryTokens.length, fieldTokens.length);
}

/**
 * Compute a [0..~1] relevance score for one skill against a query.
 * Returns { score, breakdown } — breakdown is shown in the inspector UI.
 */
function usageBoost(skillId, queryTokens, usageStats = {}) {
  const stat = usageStats?.[skillId];
  if (!stat) return { score: 0, hits: 0 };
  const recent = Array.isArray(stat.recentQueries) ? stat.recentQueries.slice(0, 8) : [];
  let hits = 0;
  for (const q of recent) {
    const qt = tokenize(q);
    if (overlap(queryTokens, qt) >= 0.34) hits++;
  }
  const countBoost = Math.min(0.08, Math.log10((stat.count || 0) + 1) * 0.03);
  const queryBoost = Math.min(WEIGHTS.recentUsage, hits * 0.08);
  return { score: countBoost + queryBoost, hits };
}

function scoreSkill(skill, queryTokens, opts = {}) {
  const fm = skill?.frontmatter || {};
  const descT = tokenize(fm.description || '');
  const nameT = tokenize(fm.name || '');
  const tagT = tokenize((fm.tags || []).join(' '));
  const aliasT = tokenize((fm.aliases || []).join(' '));
  const triggerT = tokenize((fm.triggers || []).join(' '));
  const exampleT = tokenize((fm.examples || []).join(' '));

  const dScore = overlap(queryTokens, descT) * WEIGHTS.description;
  const nScore = overlap(queryTokens, nameT) * WEIGHTS.name;
  const tScore = overlap(queryTokens, tagT) * WEIGHTS.tags;
  const aScore = overlap(queryTokens, aliasT) * WEIGHTS.aliases;
  const trScore = overlap(queryTokens, triggerT) * WEIGHTS.triggers;
  const eScore = overlap(queryTokens, exampleT) * WEIGHTS.examples;
  const u = usageBoost(skill?.id || fm.name, queryTokens, opts.usageStats || {});
  const total = dScore + nScore + tScore + aScore + trScore + eScore + u.score;

  return {
    score: Number(total.toFixed(4)),
    breakdown: {
      description: Number(dScore.toFixed(4)),
      name: Number(nScore.toFixed(4)),
      tags: Number(tScore.toFixed(4)),
      aliases: Number(aScore.toFixed(4)),
      triggers: Number(trScore.toFixed(4)),
      examples: Number(eScore.toFixed(4)),
      recentUsage: Number(u.score.toFixed(4)),
    },
  };
}

/**
 * Pick the most relevant skills for the user's query.
 *
 * @param {Array<object>} skills    — skill records from skillsManager.list()
 * @param {string}        query     — the user's message text
 * @param {object}        opts
 * @param {string[]}      opts.forcedIds — skill ids to always include (slash /skill <name>)
 * @param {number}        opts.maxSkills — cap on returned skills (default 3)
 * @param {number}        opts.threshold — min score to consider (default 0.15)
 * @returns {{selected: object[], scored: object[]}}
 *   scored is the full ranked list (with scores), useful for the inspector.
 */
function selectRelevantSkills(skills, query, opts = {}) {
  const enabled = (skills || []).filter(s => s && s.enabled !== false);
  const forced = new Set((opts.forcedIds || []).map(String));
  const maxSkills = Math.max(1, Math.min(8, opts.maxSkills || DEFAULT_MAX_SKILLS));
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
  const queryTokens = tokenize(query);

  const scoped = enabled.map(skill => {
    const { score, breakdown } = scoreSkill(skill, queryTokens, opts);
    return _scopedEntry(skill, score, breakdown, forced);
  });

  return _finalizeSelection(scoped, maxSkills, threshold);
}

// Build one scored entry in the shape both the sync and async paths return.
function _scopedEntry(skill, score, breakdown, forcedSet) {
  const fm = skill.frontmatter || {};
  const forcedNames = [
    skill.id,
    fm.name,
    ...(Array.isArray(fm.aliases) ? fm.aliases : []),
  ].filter(Boolean).map(String);
  return {
    id: skill.id,
    scope: skill.scope || 'user',
    score: Number(score.toFixed(4)),
    breakdown,
    forced: forcedNames.some(n => forcedSet.has(n)),
    skill,
  };
}

// Sort (forced first → score desc → scope priority → id) and pick up to
// maxSkills entries that clear the threshold (forced always included).
// Shared by the sync and embedding-blended paths so ranking is identical.
function _finalizeSelection(scoped, maxSkills, threshold) {
  const scopeRank = { workspace: 0, user: 1, builtin: 2, marketplace: 3 };
  scoped.sort((a, b) => {
    if (a.forced !== b.forced) return a.forced ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    const sa = scopeRank[a.scope] ?? 9;
    const sb = scopeRank[b.scope] ?? 9;
    if (sa !== sb) return sa - sb;
    return String(a.id).localeCompare(String(b.id));
  });
  const selected = [];
  for (const entry of scoped) {
    if (selected.length >= maxSkills) break;
    if (entry.forced || entry.score >= threshold) selected.push(entry);
  }
  return { selected, scored: scoped };
}

// ── Semantic blend (WS3) ───────────────────────────────────────────────────
// Optional embedding layer on TOP of bag-of-words. Caches each skill's vector
// keyed by id + version so it re-embeds only when SKILL.md changes. The blend
// is ADDITIVE (bag + 0.4·cosine), not a replacement: semantics can only LIFT a
// skill, never push a proven keyword match below the calibrated threshold —
// so the embeddings-on path can't regress the embeddings-off path. Falls back
// to pure bag-of-words whenever the service is missing/offline.
const _skillVecCache = new Map(); // `${id}:${version}` -> Float32Array | null

function _skillText(skill) {
  const fm = skill?.frontmatter || {};
  return [
    fm.name, fm.description,
    (fm.tags || []).join(' '),
    (fm.aliases || []).join(' '),
    (fm.triggers || []).join(' '),
    (fm.examples || []).join(' '),
  ].filter(Boolean).join('. ').slice(0, 1000);
}

async function selectRelevantSkillsAsync(skills, query, opts = {}) {
  const svc = opts.embeddingService;
  // No service / offline / empty query → byte-identical to the sync path.
  if (!svc || typeof svc.isAvailable !== 'function' || !svc.isAvailable() || !String(query || '').trim()) {
    return selectRelevantSkills(skills, query, opts);
  }
  const { cosine } = require('./embeddings');
  let queryVec = null;
  try { queryVec = await svc.embed(String(query)); } catch (_) {}
  if (!queryVec) return selectRelevantSkills(skills, query, opts);  // embed failed → fall back

  const enabled = (skills || []).filter(s => s && s.enabled !== false);
  const forced = new Set((opts.forcedIds || []).map(String));
  const maxSkills = Math.max(1, Math.min(8, opts.maxSkills || DEFAULT_MAX_SKILLS));
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
  const queryTokens = tokenize(query);
  const semWeight = typeof opts.semanticWeight === 'number' ? opts.semanticWeight : 0.4;

  const scoped = [];
  for (const skill of enabled) {
    const { score: bagScore, breakdown } = scoreSkill(skill, queryTokens, opts);
    const cacheKey = `${skill.id}:${skill.version || skill.frontmatter?.version || '0'}`;
    let vec = _skillVecCache.get(cacheKey);
    if (vec === undefined) {
      try { vec = await svc.embed(_skillText(skill)); } catch (_) { vec = null; }
      _skillVecCache.set(cacheKey, vec || null);
    }
    const sem = vec ? Math.max(0, cosine(queryVec, vec)) : 0;
    const blended = bagScore + semWeight * sem;
    const entry = _scopedEntry(skill, blended, { ...breakdown, semantic: Number(sem.toFixed(4)) }, forced);
    scoped.push(entry);
  }

  return _finalizeSelection(scoped, maxSkills, threshold);
}

// Test helper — drop cached skill vectors (e.g. between unit tests).
function _clearSkillVectorCache() { _skillVecCache.clear(); }

module.exports = {
  tokenize,
  scoreSkill,
  selectRelevantSkills,
  selectRelevantSkillsAsync,
  _clearSkillVectorCache,
  STOPWORDS,
  WEIGHTS,
  DEFAULT_THRESHOLD,
  DEFAULT_MAX_SKILLS,
};
