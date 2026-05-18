'use strict';
/**
 * Horizon Memory — pure-JS full-text inverted index (PHASE 6/8).
 *
 * Lives next to AgentMemory. Built in-memory on init from existing
 * memories + conversations, then kept incremental. Not persisted — a
 * 2000-memory rebuild takes ~30ms on a modern laptop, cheaper than
 * sidecar IO. Pure JS (no native deps, no SQLite) keeps cross-platform
 * + Electron installer simple.
 *
 * Trade-off vs SQLite FTS5: ours is simpler (token-set match + recency
 * + position scoring) but no proximity / prefix / phrase queries. For
 * Horizon's 2000-entry cap that's more than enough; if scale grows
 * past ~50k entries, swap to better-sqlite3.
 */

const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','by','do','for','from','has','have',
  'i','in','is','it','its','me','my','of','on','or','that','the','this',
  'to','was','were','what','when','where','which','who','why','with','you',
  'your',
  'и','в','не','на','я','что','он','с','как','это','но','у','к','или','же',
  'мне','мы','вы','ты','для','по','из','за','о','от','до','при',
]);

const TOKEN_RE = /[\p{L}\p{N}]{2,}/gu;

function tokenize(text) {
  const out = new Map(); // token → position list
  const matches = String(text || '').toLowerCase().match(TOKEN_RE) || [];
  matches.forEach((raw, i) => {
    if (STOPWORDS.has(raw)) return;
    let w = raw;
    if (w.length > 4) {
      if (w.endsWith('ing')) w = w.slice(0, -3);
      else if (w.endsWith('ed') && w.length > 5) w = w.slice(0, -2);
      else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    }
    if (w.length < 2) return;
    if (!out.has(w)) out.set(w, []);
    out.get(w).push(i);
  });
  return out;
}

class InvertedIndex {
  constructor() {
    this.index = new Map();    // token → Map<docId, {positions:[], tf}>
    this.docs = new Map();     // docId → { text, length, type, kind }
    this.totalDocs = 0;
  }

  /**
   * Add or replace a document.
   * @param {string} id — stable doc id (memory key, conversation id+'-c', etc.)
   * @param {string} text
   * @param {object} [meta] — {type:'memory'|'fact'|'conversation', personaId?}
   */
  add(id, text, meta = {}) {
    const sid = String(id);
    if (this.docs.has(sid)) this.remove(sid);
    const tokens = tokenize(text);
    if (!tokens.size) return;
    for (const [tok, positions] of tokens) {
      if (!this.index.has(tok)) this.index.set(tok, new Map());
      this.index.get(tok).set(sid, { positions, tf: positions.length });
    }
    this.docs.set(sid, {
      text: String(text || '').slice(0, 4000),
      length: tokens.size,
      type: meta.type || 'memory',
      kind: meta.kind || null,
      personaId: meta.personaId || null,
    });
    this.totalDocs = this.docs.size;
  }

  remove(id) {
    const sid = String(id);
    if (!this.docs.has(sid)) return false;
    for (const [, docMap] of this.index) docMap.delete(sid);
    this.docs.delete(sid);
    this.totalDocs = this.docs.size;
    return true;
  }

  /**
   * Search for a query string. Returns ranked [{id, score, meta}].
   * Score = sum of (1 + log(tf)) * (idf-ish damping) over matched tokens,
   * with a small boost for early-position matches. Caps at `limit` items.
   */
  search(query, limit = 20) {
    const qTokens = tokenize(query);
    if (!qTokens.size || !this.totalDocs) return [];
    const scores = new Map(); // docId → score
    for (const [qTok] of qTokens) {
      const docMap = this.index.get(qTok);
      if (!docMap) continue;
      // Plain IDF damping — common tokens contribute less.
      const idf = Math.log(1 + this.totalDocs / docMap.size);
      for (const [docId, { tf, positions }] of docMap) {
        const tfScore = 1 + Math.log(tf);
        // Early-position bonus: matches in the first 10 tokens of the doc
        // get a small +0.2 — assumes early text is more topical.
        const earlyBonus = positions.some(p => p < 10) ? 0.2 : 0;
        scores.set(docId, (scores.get(docId) || 0) + tfScore * idf + earlyBonus);
      }
    }
    if (!scores.size) return [];
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score: Number(score.toFixed(4)), meta: this.docs.get(id) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  size() { return this.docs.size; }

  stats() {
    return {
      docs: this.docs.size,
      tokens: this.index.size,
      byType: [...this.docs.values()].reduce((acc, d) => {
        acc[d.type] = (acc[d.type] || 0) + 1;
        return acc;
      }, {}),
    };
  }
}

module.exports = { InvertedIndex, tokenize };
