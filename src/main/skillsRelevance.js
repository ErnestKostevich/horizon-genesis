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
function scoreSkill(skill, queryTokens) {
  const fm = skill?.frontmatter || {};
  const descT = tokenize(fm.description || '');
  const nameT = tokenize(fm.name || '');
  const tagT = tokenize((fm.tags || []).join(' '));

  const dScore = overlap(queryTokens, descT) * WEIGHTS.description;
  const nScore = overlap(queryTokens, nameT) * WEIGHTS.name;
  const tScore = overlap(queryTokens, tagT) * WEIGHTS.tags;
  const total = dScore + nScore + tScore;

  return {
    score: Number(total.toFixed(4)),
    breakdown: {
      description: Number(dScore.toFixed(4)),
      name: Number(nScore.toFixed(4)),
      tags: Number(tScore.toFixed(4)),
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
    const { score, breakdown } = scoreSkill(skill, queryTokens);
    return {
      id: skill.id,
      scope: skill.scope || 'user',
      score,
      breakdown,
      forced: forced.has(skill.id) || forced.has(skill.frontmatter?.name),
      skill,
    };
  });

  // Sort: forced first (forced always in), then by score desc, then by scope
  // priority (workspace > user > builtin > marketplace), then alphabetical.
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
    if (entry.forced || entry.score >= threshold) {
      selected.push(entry);
    }
  }

  return { selected, scored: scoped };
}

module.exports = {
  tokenize,
  scoreSkill,
  selectRelevantSkills,
  STOPWORDS,
  WEIGHTS,
  DEFAULT_THRESHOLD,
  DEFAULT_MAX_SKILLS,
};
