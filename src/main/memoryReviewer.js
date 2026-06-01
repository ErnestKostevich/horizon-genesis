'use strict';
/**
 * Horizon Memory Reviewer (PHASE 28.3) — periodic agent-curated nudges.
 *
 * Inspired by Hermes' "agent-curated memory with periodic nudges":
 * the agent re-evaluates its own memory file every N hours to keep
 * the index from rotting. Three jobs:
 *
 *   1. DECAY     — drop importance on memories that haven't been
 *                  surfaced in N days. Stuff that doesn't come up
 *                  ages out gracefully instead of clogging recall.
 *   2. DEDUPE    — when two memories have near-identical embeddings
 *                  (cosine ≥ 0.94), merge them by keeping the higher-
 *                  importance one and bumping its `seen` counter.
 *   3. FORGET    — drop memories whose importance has decayed below
 *                  the floor (default 2) AND haven't been touched in
 *                  60+ days. The JSON file stays the source of truth
 *                  so users can edit it back if they disagree.
 *
 * Runs on a configurable cadence — default every 12 hours, with a
 * one-hour delay after boot so it doesn't fight first-run backfill.
 * Each pass is logged + visible in the Inspector → Storage tab.
 *
 * Skip when:
 *   - memory store has <50 entries (nothing to review)
 *   - embeddings service isn't ready (DEDUPE needs vectors)
 *
 * The reviewer doesn't touch SQLite directly — AgentMemory.forgetMemory
 * already mirrors the delete down to SQLite via setMemoryDb path.
 */

const REVIEW_INTERVAL_MS = 12 * 60 * 60 * 1000;  // 12 hours
const FIRST_RUN_DELAY_MS = 60 * 60 * 1000;       // 1 hour after boot
const MIN_MEMORIES_TO_REVIEW = 50;

// Decay: memory not surfaced in this many days loses 1 importance point.
const DECAY_AFTER_DAYS = 7;
// Forget: memory whose importance ≤ this AND not touched in N days dies.
const FORGET_IMPORTANCE_FLOOR = 2;
const FORGET_INACTIVE_DAYS = 60;
// Dedupe: cosine threshold above which two memories are considered
// "the same thing said twice".
const DEDUPE_COSINE_THRESHOLD = 0.94;

class MemoryReviewer {
  constructor(agentMemory, opts = {}) {
    this.mem = agentMemory;
    this.intervalMs = opts.intervalMs || REVIEW_INTERVAL_MS;
    this.firstRunDelay = opts.firstRunDelay || FIRST_RUN_DELAY_MS;
    this.timer = null;
    this.lastRunAt = null;
    this.lastRunStats = null;
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    // v0.0.3 — deps for the consolidation/insights job (layer 10). The provider
    // call needs settings+keys; OFF in the periodic pass unless explicitly on.
    this.settingsStore = opts.settingsStore || null;
    this.keysStore = opts.keysStore || null;
    this.consolidateOnReview = opts.consolidateOnReview === true;
    this.lastConsolidateAt = null;
    this.lastConsolidateStats = null;
  }

  /** Start the periodic loop. First pass runs after firstRunDelay. */
  start() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this._runOnce();
      this.timer = setInterval(() => this._runOnce(), this.intervalMs);
    }, this.firstRunDelay);
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); clearInterval(this.timer); this.timer = null; }
  }

  /** One pass — exposed for tests + manual "Review now" button. */
  async reviewNow() {
    return this._runOnce();
  }

  /** v0.0.3 — run a consolidation/insights pass (layer 10): cluster recent
   *  episodes and synthesize higher-order "insight" memories. Offline-safe
   *  (returns { created: 0, skipped: 'offline' } with no chat key). */
  async consolidateNow(opts = {}) {
    try {
      const { consolidate } = require('./memoryConsolidator');
      const r = await consolidate(this.mem, {
        settingsStore: this.settingsStore,
        keysStore: this.keysStore,
        synthFn: opts.synthFn,
      }, opts);
      this.lastConsolidateAt = Date.now();
      this.lastConsolidateStats = r;
      try { this.onChange({ consolidate: r, created: r.created || 0, ranAt: this.lastConsolidateAt }); } catch (_) {}
      return r;
    } catch (e) {
      return { ok: false, error: e.message, created: 0 };
    }
  }

  _runOnce() {
    if (!this.mem || !this.mem.ready) {
      return { ok: false, error: 'agent memory not ready' };
    }
    const memories = this.mem._data?.memories || [];
    if (memories.length < MIN_MEMORIES_TO_REVIEW) {
      const stats = { skipped: 'too few memories', count: memories.length };
      this.lastRunStats = stats;
      this.lastRunAt = Date.now();
      return { ok: true, ...stats };
    }
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let decayed = 0;
    let forgotten = 0;
    let merged = 0;

    // ── 1. DECAY ────────────────────────────────────────────────────
    for (const m of memories) {
      const lastSeen = m.lastSeen || m.created || 0;
      const daysSince = (now - lastSeen) / dayMs;
      if (daysSince > DECAY_AFTER_DAYS && (m.importance || 5) > 1) {
        m.importance = Math.max(1, (m.importance || 5) - 1);
        m._lastDecayedAt = now;
        decayed++;
      }
    }

    // ── 2. DEDUPE (only if embeddings ready) ────────────────────────
    if (this.mem.embeddings && this.mem.embeddings.isAvailable()) {
      const { cosine } = require('./embeddings');
      // Snapshot the index so the loop doesn't fight live writes.
      const items = memories
        .map(m => ({ m, vec: this.mem.embeddings.index.get(m.key) }))
        .filter(x => x.vec);
      const seen = new Set();
      for (let i = 0; i < items.length; i++) {
        if (seen.has(i)) continue;
        for (let j = i + 1; j < items.length; j++) {
          if (seen.has(j)) continue;
          const c = cosine(items[i].vec, items[j].vec);
          if (c >= DEDUPE_COSINE_THRESHOLD) {
            // Keep the higher-importance one; transfer seen+lastSeen.
            const a = items[i].m, b = items[j].m;
            const keep = (a.importance || 0) >= (b.importance || 0) ? a : b;
            const drop = keep === a ? b : a;
            keep.seen = (keep.seen || 1) + (drop.seen || 1);
            keep.lastSeen = Math.max(keep.lastSeen || 0, drop.lastSeen || 0);
            // Merge persona tags.
            const pset = new Set([
              ...(Array.isArray(keep.personas) ? keep.personas : (keep.personaId ? [keep.personaId] : [])),
              ...(Array.isArray(drop.personas) ? drop.personas : (drop.personaId ? [drop.personaId] : [])),
            ].filter(Boolean));
            keep.personas = [...pset];
            try { this.mem.forgetMemory(drop.key || String(drop.id)); }
            catch (_) {}
            seen.add(j);
            merged++;
          }
        }
      }
    }

    // ── 3. FORGET ───────────────────────────────────────────────────
    const survivors = [];
    for (const m of memories) {
      const lastSeen = m.lastSeen || m.created || 0;
      const daysSince = (now - lastSeen) / dayMs;
      if ((m.importance || 0) <= FORGET_IMPORTANCE_FLOOR && daysSince > FORGET_INACTIVE_DAYS) {
        forgotten++;
        continue;
      }
      survivors.push(m);
    }
    if (forgotten > 0) {
      // Bulk replace + save once at the end.
      this.mem._data.memories = survivors;
      this.mem._save();
      // Re-sync FTS too — surviving memories only.
      try { this.mem._rebuildFts(); } catch (_) {}
    } else {
      // No purge, but DECAY edits need a save.
      if (decayed > 0) { try { this.mem._save(); } catch (_) {} }
    }

    const stats = {
      reviewed: memories.length,
      decayed,
      merged,
      forgotten,
      survivors: survivors.length,
      ranAt: now,
    };
    this.lastRunStats = stats;
    this.lastRunAt = now;
    try { this.onChange(stats); } catch (_) {}
    console.log(`[memory-reviewer] pass: ${decayed} decayed, ${merged} merged, ${forgotten} forgotten (of ${memories.length})`);
    // v0.0.3 — optional 4th job: consolidation/insights. OFF by default to avoid
    // surprise token spend; fire-and-forget so the sync pass stays fast.
    if (this.consolidateOnReview) { this.consolidateNow().catch(() => {}); }
    return { ok: true, ...stats };
  }

  status() {
    return {
      running: !!this.timer,
      intervalMs: this.intervalMs,
      lastRunAt: this.lastRunAt,
      lastRunStats: this.lastRunStats,
      lastConsolidateAt: this.lastConsolidateAt,
      lastConsolidateStats: this.lastConsolidateStats,
    };
  }
}

module.exports = {
  MemoryReviewer,
  DECAY_AFTER_DAYS,
  FORGET_INACTIVE_DAYS,
  FORGET_IMPORTANCE_FLOOR,
  DEDUPE_COSINE_THRESHOLD,
};
