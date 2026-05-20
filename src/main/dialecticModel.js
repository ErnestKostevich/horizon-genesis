'use strict';
/**
 * Horizon Dialectic User Model (PHASE 28.4) — Honcho-inspired layer.
 *
 * Big Five (already in agent.js userProfile) gives us a *static snapshot*
 * of who the user is. This module adds the missing axis: a **diff log of
 * what we've learned about them over time** — closer to Hermes/Nous's
 * "Honcho dialectic user model" pattern.
 *
 * Each turn that produces a non-trivial insight emits one record:
 *
 *   {
 *     id, ts,
 *     kind: 'belief' | 'desire' | 'knowledge' | 'theory-of-mind' | 'correction',
 *     before: '...prior belief or null...',
 *     after:  '...what we now think...',
 *     evidence: '...short quote from the turn that triggered it...',
 *     personaId: '...active persona at the time...',
 *     confidence: 0..1
 *   }
 *
 * Storage: `<userData>/horizon_dialectic.json` (separate file, matches
 * the same JSON-sidecar pattern as embeddings).
 *
 * Default cap: 500 records, ring-buffer style. Each record is small
 * (~250 chars), so 500 ≈ 125 KB on disk — won't bloat context.
 *
 * Reads:
 *   - getRecent(limit)              — latest N records, descending
 *   - byKind('belief', limit)       — filter by type
 *   - search(query, limit)          — substring across before/after
 *   - summary()                     — counts + last-updated
 *
 * Writes:
 *   - record(diff)                  — append + persist
 *   - clear()                       — wipe (Inspector "Forget all" button)
 *
 * The actual diff extraction (calling an LLM to emit JSON of what
 * changed) lives in agent.js learnFromTurn; this module is just the
 * structured store + readers.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CAP = 500;
const VALID_KINDS = new Set(['belief', 'desire', 'knowledge', 'theory-of-mind', 'correction']);

/**
 * Multi-level theory-of-mind levels (PHASE 28.5).
 *
 *   0 — first-order: what the USER knows / wants / believes
 *   1 — second-order: what the user thinks the AGENT knows about them
 *   2 — third-order: what the user thinks the AGENT thinks the user wants
 *
 * Levels 1 + 2 only get populated when the user explicitly references
 * the agent's understanding (e.g. "you keep assuming I prefer X but I
 * don't"). Most entries are level 0.
 */
const VALID_LEVELS = new Set([0, 1, 2]);

class DialecticModel {
  constructor(filePath, opts = {}) {
    if (!filePath) throw new Error('DialecticModel requires a filePath');
    this.filePath = filePath;
    this.cap = Math.max(50, Math.min(5000, opts.cap || DEFAULT_CAP));
    this.records = [];
    this.ready = false;
  }

  init() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.records)) this.records = parsed.records;
      }
      this.ready = true;
    } catch (e) {
      console.warn('[dialectic] init failed:', e.message);
      this.records = [];
      this.ready = true;
    }
    return this;
  }

  _save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, records: this.records }, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.warn('[dialectic] save failed:', e.message);
    }
  }

  /**
   * Append a single diff record. `diff` shape:
   *   { kind, before, after, evidence?, personaId?, confidence? }
   * `before` / `after` are short strings. Anything > 600 chars gets
   * truncated to keep this file small.
   */
  record(diff) {
    if (!this.ready) return null;
    if (!diff || typeof diff !== 'object') return null;
    const kind = String(diff.kind || '').toLowerCase();
    if (!VALID_KINDS.has(kind)) return null;
    const after = String(diff.after || '').slice(0, 600).trim();
    if (!after) return null;
    // PHASE 28.5 — Multi-level ToM. Default level 0 (first-order: what
    // the user knows/wants). Levels 1-2 only fire when the agent saw
    // an explicit signal about its own state.
    const level = VALID_LEVELS.has(Number(diff.level)) ? Number(diff.level) : 0;
    const entry = {
      id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      kind,
      level,
      before: diff.before ? String(diff.before).slice(0, 600).trim() : null,
      after,
      evidence: diff.evidence ? String(diff.evidence).slice(0, 400).trim() : null,
      personaId: diff.personaId ? String(diff.personaId) : null,
      // PHASE 28.5 — Multi-tenant scoping. userId is null for the
      // single-user case (Electron app, one CLI install). When set
      // (e.g. "tg:123456789") all reads/queries filter by it.
      userId: diff.userId ? String(diff.userId).slice(0, 80) : null,
      confidence: typeof diff.confidence === 'number' ? Math.max(0, Math.min(1, diff.confidence)) : 0.7,
    };
    this.records.push(entry);
    // Ring-buffer: drop oldest if over cap.
    if (this.records.length > this.cap) {
      this.records = this.records.slice(-this.cap);
    }
    this._save();
    return entry;
  }

  /** Scope helper — filter records by userId. Pass null to get the
   *  single-user pool (records without a userId). Pass a string to get
   *  just that tenant. Pass '*' to get everything regardless. */
  _scoped(userId) {
    if (userId === '*') return this.records;
    if (userId == null || userId === undefined) {
      return this.records.filter(r => !r.userId);
    }
    return this.records.filter(r => r.userId === userId);
  }

  /** Latest N records, newest first. `opts.userId` filters by tenant.
   *  `opts.level` filters by ToM level (0/1/2). */
  getRecent(limit = 50, opts = {}) {
    const cap = Math.max(1, Math.min(this.cap, limit));
    let pool = this._scoped(opts.userId);
    if (typeof opts.level === 'number') pool = pool.filter(r => (r.level || 0) === opts.level);
    return [...pool].reverse().slice(0, cap);
  }

  byKind(kind, limit = 50, opts = {}) {
    const k = String(kind || '').toLowerCase();
    if (!VALID_KINDS.has(k)) return [];
    let pool = this._scoped(opts.userId);
    if (typeof opts.level === 'number') pool = pool.filter(r => (r.level || 0) === opts.level);
    return pool.filter(r => r.kind === k).slice(-limit).reverse();
  }

  /** Substring search across before/after/evidence — for Inspector. */
  search(query, limit = 50, opts = {}) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return this.getRecent(limit, opts);
    let pool = this._scoped(opts.userId);
    if (typeof opts.level === 'number') pool = pool.filter(r => (r.level || 0) === opts.level);
    return pool
      .filter(r =>
        (r.before || '').toLowerCase().includes(q) ||
        (r.after  || '').toLowerCase().includes(q) ||
        (r.evidence || '').toLowerCase().includes(q))
      .slice(-limit)
      .reverse();
  }

  summary(opts = {}) {
    const pool = this._scoped(opts.userId);
    const byKind = {};
    const byLevel = { 0: 0, 1: 0, 2: 0 };
    for (const r of pool) {
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      const lvl = r.level || 0;
      byLevel[lvl] = (byLevel[lvl] || 0) + 1;
    }
    const latest = pool[pool.length - 1];
    // List of unique userIds present in the store (for multi-tenant UI).
    const tenants = new Set();
    for (const r of this.records) if (r.userId) tenants.add(r.userId);
    return {
      total: pool.length,
      grandTotal: this.records.length,
      cap: this.cap,
      byKind,
      byLevel,
      tenants: [...tenants],
      lastUpdatedAt: latest ? latest.ts : null,
      lastEntry: latest || null,
    };
  }

  /**
   * Inject the dialectic layer into a system prompt. Levels are
   * surfaced separately so the model knows which axis each diff is on:
   *
   *   Level 0 — direct beliefs about the user
   *   Level 1 — user's expectations OF the agent
   *   Level 2 — recursive: user's beliefs about agent's understanding
   *
   * Falsy return ('') when empty so callers can `.concat()` without
   * checks. `opts.userId` scopes to one tenant.
   */
  injection(k = 6, opts = {}) {
    let pool = this._scoped(opts.userId);
    const high = pool.filter(r => (r.confidence || 0) >= 0.5).slice(-k * 2);
    if (!high.length) return '';
    const lvl = (n) => high.filter(r => (r.level || 0) === n).slice(-k);
    const lines0 = lvl(0).map(r => `• [${r.kind}] ${r.after}${r.before ? ` (was: ${r.before})` : ''}`);
    const lines1 = lvl(1).map(r => `• [${r.kind}] ${r.after}`);
    const lines2 = lvl(2).map(r => `• [${r.kind}] ${r.after}`);
    const parts = [];
    if (lines0.length) parts.push('Level 0 — what we know about the user:\n' + lines0.join('\n'));
    if (lines1.length) parts.push('Level 1 — what the user expects of us:\n' + lines1.join('\n'));
    if (lines2.length) parts.push('Level 2 — recursive (their model of our model):\n' + lines2.join('\n'));
    if (!parts.length) return '';
    return '\n\nUser model (dialectic — what we have learned):\n' + parts.join('\n\n');
  }

  /**
   * Clear records. With no args wipes everything. With { userId } only
   * clears that tenant. Useful for "right to be forgotten" requests.
   */
  clear(opts = {}) {
    if (opts && opts.userId) {
      const before = this.records.length;
      this.records = this.records.filter(r => r.userId !== opts.userId);
      this._save();
      return { ok: true, removed: before - this.records.length };
    }
    const removed = this.records.length;
    this.records = [];
    this._save();
    return { ok: true, removed };
  }
}

module.exports = { DialecticModel, VALID_KINDS, VALID_LEVELS };
