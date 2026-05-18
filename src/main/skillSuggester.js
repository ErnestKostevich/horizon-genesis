'use strict';
/**
 * Horizon Auto-Skill Suggester
 *
 * Watches the stream of user turns + agent reflections and detects
 * patterns worth turning into a `SKILL.md`. Two signals trigger a
 * suggestion:
 *
 *   1. Repeated query topic — 3+ recent user messages cluster on the
 *      same significant tokens (after stopword filtering). E.g. user
 *      asked "refactor React class to hooks" three times across
 *      separate conversations → suggest a `refactor-react-hooks` skill
 *      pre-filled with the body of the agent's most successful reply.
 *
 *   2. Repeated partial reflections — when reflection epilogue returns
 *      `goal_met === 'partial'` 3+ times on similar queries, suggest a
 *      skill whose body documents the procedure that DID work, so the
 *      next time the agent doesn't half-solve it.
 *
 * Suggestions are non-blocking — emitted as events that the renderer
 * shows as a dismissible banner with "Create skill" / "Dismiss".
 * Nothing is auto-created; user always confirms.
 */

const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','by','do','for','from','has','have',
  'i','in','is','it','its','me','my','of','on','or','that','the','this',
  'to','was','were','what','when','where','which','who','why','with','you','your',
  'и','в','не','на','я','что','он','с','как','это','но','у','к','или','же',
  'мне','мы','вы','ты','для','по','из','за','о','от','до','при',
  'how','can','will','would','should','use','make','create','build',
]);

const TOKEN_RE = /[\p{L}\p{N}]{3,}/gu;
const MIN_PATTERN_OCCURRENCES = 3;
const RECENT_WINDOW = 25;       // look at last N turns for clustering
const MIN_SHARED_TOKENS = 2;    // 2+ significant tokens must overlap

function significantTokens(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').toLowerCase().match(TOKEN_RE) || []) {
    if (STOPWORDS.has(m)) continue;
    let w = m;
    if (w.length > 4) {
      if (w.endsWith('ing')) w = w.slice(0, -3);
      else if (w.endsWith('ed') && w.length > 5) w = w.slice(0, -2);
      else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    }
    if (w.length < 3 || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

class SkillSuggester {
  constructor(opts = {}) {
    this.history = []; // [{ at, query, queryTokens, goalMet, answer }]
    this.cooldown = new Set(); // suggested-skill ids we won't re-suggest this session
    this.emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    this.existingSkillNames = new Set(); // populated by setKnownSkills() to avoid duplicate suggestions
  }

  setKnownSkills(ids) {
    this.existingSkillNames = new Set((ids || []).map(s => String(s).toLowerCase()));
  }

  /** Called after each agent turn. `meta` may include {goalMet, answer,
   *  runId, source}. Returns the emitted suggestion or null. */
  ingestTurn(userQuery, meta = {}) {
    const q = String(userQuery || '').trim();
    if (!q || q.length < 8) return null;
    const tokens = significantTokens(q);
    if (tokens.length < 2) return null;
    const entry = {
      at: Date.now(),
      query: q.slice(0, 400),
      queryTokens: tokens,
      goalMet: meta.goalMet || null,
      answer: String(meta.answer || '').slice(0, 1200),
    };
    this.history.push(entry);
    if (this.history.length > RECENT_WINDOW * 2) this.history = this.history.slice(-RECENT_WINDOW * 2);
    return this._checkPatterns();
  }

  _checkPatterns() {
    const recent = this.history.slice(-RECENT_WINDOW);
    if (recent.length < MIN_PATTERN_OCCURRENCES) return null;
    // Build token → entry-indexes co-occurrence map.
    const tokenIdx = new Map(); // token → Set<i>
    recent.forEach((e, i) => {
      for (const t of e.queryTokens) {
        if (!tokenIdx.has(t)) tokenIdx.set(t, new Set());
        tokenIdx.get(t).add(i);
      }
    });
    // Score token-pairs that co-occur across MIN_PATTERN_OCCURRENCES+ entries.
    const tokenList = [...tokenIdx.keys()];
    let best = null;
    for (let i = 0; i < tokenList.length; i++) {
      for (let j = i + 1; j < tokenList.length; j++) {
        const a = tokenIdx.get(tokenList[i]);
        const b = tokenIdx.get(tokenList[j]);
        if (a.size < MIN_PATTERN_OCCURRENCES || b.size < MIN_PATTERN_OCCURRENCES) continue;
        const shared = [...a].filter(x => b.has(x));
        if (shared.length < MIN_PATTERN_OCCURRENCES) continue;
        // Among shared entries, count partial-reflection ratio — boosts a
        // pattern where the agent often only half-solves it.
        let partial = 0;
        for (const k of shared) if (recent[k].goalMet === 'partial' || recent[k].goalMet === 'no') partial++;
        const score = shared.length + partial * 0.5;
        if (!best || score > best.score) {
          best = {
            score,
            tokens: [tokenList[i], tokenList[j]],
            occurrences: shared.length,
            partials: partial,
            entries: shared.map(k => recent[k]),
          };
        }
      }
    }
    if (!best) return null;
    // De-duplicate: skip if we already proposed this token-pair or there's
    // an existing skill with one of the tokens in its name.
    const sigKey = best.tokens.slice().sort().join('+');
    if (this.cooldown.has(sigKey)) return null;
    for (const t of best.tokens) {
      if (this.existingSkillNames.has(t)) return null;
    }
    this.cooldown.add(sigKey);

    const draft = this._buildDraftSkill(best);
    const suggestion = {
      type: 'skill-suggestion',
      pattern: best.tokens.join(' + '),
      occurrences: best.occurrences,
      partials: best.partials,
      sampleQueries: best.entries.slice(0, 3).map(e => e.query),
      draft,
      suggestedAt: new Date().toISOString(),
    };
    try { this.emit(suggestion); } catch (_) {}
    return suggestion;
  }

  _buildDraftSkill(pattern) {
    const name = pattern.tokens.slice(0, 3).join('-').replace(/[^a-z0-9-]+/g, '-').slice(0, 60) || 'auto-skill';
    const description = `Handle requests about ${pattern.tokens.join(' / ')}. Auto-suggested after observing ${pattern.occurrences} similar queries.`;
    const recentBestAnswer = pattern.entries
      .filter(e => e.goalMet === 'yes' || e.goalMet === 'partial')
      .map(e => e.answer)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] || '';
    const examples = pattern.entries.slice(0, 3).map(e => `- "${e.query.slice(0, 80)}"`).join('\n');
    const body = [
      `# ${name}`,
      '',
      `Auto-drafted skill for recurring ${pattern.tokens.join(' / ')} requests.`,
      '',
      '## When to use',
      examples ? `User queries like:\n${examples}` : '_Tune the trigger phrases above to match your typical request._',
      '',
      '## Procedure',
      '',
      recentBestAnswer
        ? `Based on a previous successful answer:\n\n> ${recentBestAnswer.slice(0, 400).replace(/\n/g, '\n> ')}`
        : '1. Step one.\n2. Step two.\n3. Verify result.',
      '',
      '_Edit this body in the Skill Hub editor before saving — auto-draft is a starting point, not a final answer._',
    ].join('\n');
    const frontmatter = [
      '---',
      `name: ${name}`,
      `description: "${description.replace(/"/g, '\\"')}"`,
      'version: "0.1.0"',
      `tags: [${pattern.tokens.map(t => JSON.stringify(t)).join(', ')}]`,
      `triggers: [${pattern.entries.slice(0, 3).map(e => JSON.stringify(e.query.slice(0, 60).toLowerCase())).join(', ')}]`,
      '---',
      ''
    ].join('\n');
    return {
      id: name,
      content: frontmatter + body,
      name,
      description,
      tokens: pattern.tokens,
    };
  }
}

module.exports = { SkillSuggester, significantTokens };
