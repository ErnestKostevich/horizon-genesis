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
    const entry = {
      id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      kind,
      before: diff.before ? String(diff.before).slice(0, 600).trim() : null,
      after,
      evidence: diff.evidence ? String(diff.evidence).slice(0, 400).trim() : null,
      personaId: diff.personaId ? String(diff.personaId) : null,
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

  /** Latest N records, newest first. */
  getRecent(limit = 50) {
    const cap = Math.max(1, Math.min(this.cap, limit));
    return [...this.records].reverse().slice(0, cap);
  }

  byKind(kind, limit = 50) {
    const k = String(kind || '').toLowerCase();
    if (!VALID_KINDS.has(k)) return [];
    return this.records
      .filter(r => r.kind === k)
      .slice(-limit)
      .reverse();
  }

  /** Substring search across before/after/evidence — for Inspector. */
  search(query, limit = 50) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return this.getRecent(limit);
    return this.records
      .filter(r =>
        (r.before || '').toLowerCase().includes(q) ||
        (r.after  || '').toLowerCase().includes(q) ||
        (r.evidence || '').toLowerCase().includes(q))
      .slice(-limit)
      .reverse();
  }

  summary() {
    const byKind = {};
    for (const r of this.records) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    const latest = this.records[this.records.length - 1];
    return {
      total: this.records.length,
      cap: this.cap,
      byKind,
      lastUpdatedAt: latest ? latest.ts : null,
      lastEntry: latest || null,
    };
  }

  /**
   * Inject the dialectic layer into a system prompt. Picks the K most
   * recent high-confidence records and renders them as a bulleted
   * section the LLM can use to reason. Returns '' when empty so callers
   * can `.concat()` without checks.
   */
  injection(k = 6) {
    const top = this.records
      .filter(r => (r.confidence || 0) >= 0.5)
      .slice(-k)
      .reverse();
    if (!top.length) return '';
    const lines = top.map(r => {
      const head = `• [${r.kind}] ${r.after}`;
      const tail = r.before ? ` (was: ${r.before})` : '';
      return head + tail;
    });
    return '\n\nUser model (dialectic — what we have learned):\n' + lines.join('\n');
  }

  clear() {
    this.records = [];
    this._save();
    return { ok: true };
  }
}

module.exports = { DialecticModel, VALID_KINDS };
