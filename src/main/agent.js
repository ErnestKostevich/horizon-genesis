'use strict';
/**
 * Horizon AI — Agent Tools v2.0
 *
 * Features from isair/jarvis integrated:
 * - Long-term memory with semantic search
 * - Location awareness
 * - Browser automation
 * - Nutrition tracking
 * - Code execution in multiple languages
 * - Full PC control (mouse, keyboard, files)
 */

const { exec, spawn, execFile } = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const crypto = require('crypto');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const SKILL_HELPER_TIMEOUT_MAX = 60_000;
const SKILL_HELPER_TIMEOUT_DEFAULT = 30_000;
const SKILL_HELPER_OUTPUT_MAX = 1024 * 1024; // 1 MB cap on stdout+stderr

// PHASE Docker — when main.js wires an Executor instance, run_code etc.
// route through it (host or docker per settingsStore.executionMode).
// Without an executor the host path is used directly — no regression.
function _getExecutor() {
  try {
    const mainMod = require.cache[require.resolve('./main')];
    return (mainMod && mainMod.exports && mainMod.exports.executor) || null;
  } catch (_) { return null; }
}

async function _routeExec(code, language, timeout) {
  const exec = _getExecutor();
  if (exec && typeof exec.run === 'function') {
    return exec.run(code, language, { timeout });
  }
  return executeCode(code, language, timeout);
}

function _getSkillsManager() {
  // Resolved lazily through main.js's require cache so agent.js stays
  // standalone for tests. Same pattern agentLoop.js uses for settingsStore.
  try {
    const mainMod = require.cache[require.resolve('./main')];
    return (mainMod && mainMod.exports && mainMod.exports.skillsManager) || null;
  } catch (_) { return null; }
}

async function runSkillHelper(skillId, helperRel, helperArgs, timeoutMs) {
  const mgr = _getSkillsManager();
  if (!mgr) return { ok: false, err: 'skills manager not initialised' };
  const resolved = mgr.resolveHelperPath(skillId, helperRel);
  if (!resolved) return { ok: false, err: `helper not found or invalid: ${skillId} / ${helperRel}` };
  const timeout = Math.min(SKILL_HELPER_TIMEOUT_MAX, Math.max(1000, Number(timeoutMs) || SKILL_HELPER_TIMEOUT_DEFAULT));
  const jsonArgs = (() => {
    try { return JSON.stringify(helperArgs || {}); } catch (_) { return '{}'; }
  })();

  return new Promise(resolve => {
    let cmd;
    let cmdArgs;
    if (resolved.ext === '.py') {
      cmd = IS_WIN ? 'python.exe' : 'python';
      cmdArgs = [resolved.absPath];
    } else {
      // .js / .mjs / .cjs — run via Electron's bundled node (process.execPath).
      cmd = process.execPath;
      cmdArgs = [resolved.absPath];
    }
    let child;
    try {
      child = execFile(
        cmd,
        cmdArgs,
        {
          cwd: resolved.skillDir,
          timeout,
          windowsHide: true,
          maxBuffer: SKILL_HELPER_OUTPUT_MAX,
          env: {
            ...process.env,
            HORIZON_SKILL_ID: skillId,
            HORIZON_SKILL_ARGS: jsonArgs,
            HORIZON_SKILL_SCOPE: resolved.scope || '',
            // Prevent helpers from poking electron internals via ELECTRON_RUN_AS_NODE
            ELECTRON_RUN_AS_NODE: '1',
            ELECTRON_NO_ATTACH_CONSOLE: '1',
          },
        },
        (err, stdout, stderr) => {
          const out = (stdout || '').toString().slice(0, 16000);
          const errOut = (stderr || '').toString().slice(0, 4000);
          if (err && err.killed) {
            return resolve({ ok: false, err: `helper timed out after ${timeout}ms`, out, stderr: errOut });
          }
          if (err) {
            return resolve({ ok: false, err: err.message || 'helper failed', code: err.code, out, stderr: errOut });
          }
          resolve({ ok: true, out, stderr: errOut, skill: skillId, helper: helperRel });
        }
      );
    } catch (e) {
      return resolve({ ok: false, err: 'spawn failed: ' + e.message });
    }
    // Feed JSON args to stdin so helpers can read them without parsing argv.
    try {
      if (child && child.stdin) {
        child.stdin.write(jsonArgs);
        child.stdin.end();
      }
    } catch (_) {}
  });
}

// Shell command executor
function sh(cmd, timeout) {
  return new Promise(resolve => {
    exec(cmd, { timeout: timeout||15000, encoding:'utf8', shell: IS_WIN?'cmd.exe':'/bin/bash', maxBuffer: 10*1024*1024 }, (err, stdout, stderr) => {
      resolve({ ok:!err, out:(stdout||'').trim().slice(0,8000), err:(stderr||err?.message||'').trim().slice(0,2000) });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// LONG-TERM MEMORY (inspired by jarvis)
// ═══════════════════════════════════════════════════════════════════════════════

// Default User Profile shape (Big Five + communication style). Stored at
// _data.userProfile. Users edit it manually via Inspector → Learned UI;
// learnFromTurn nudges values when it detects strong signals (e.g.
// "обращайся ко мне формально" → formality='professional').
const DEFAULT_USER_PROFILE = Object.freeze({
  bigFive: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 },
  communicationStyle: { formality: 'casual', verbosity: 'medium', preferredAddress: '', lang: '' },
  expertise: [],   // [{topic, level: 'novice'|'intermediate'|'expert', noticed: ISO}]
  goals: [],       // [{goal, priority: 'low'|'mid'|'high', addedAt: ISO}]
  preferences: {}, // freeform key-value (likes, dislikes, "always"/"never" rules)
  confidence: 0.0, // overall self-assessed confidence — bumped by manual edits
  observedAt: null,
  source: 'default',
});

// Source tags for memory provenance. Every memory/fact/conversation knows
// where it came from so the Learned-tab review UI can filter / colour them.
const MEMORY_SOURCES = Object.freeze({
  CHAT: 'chat',                // user typed in desktop chat
  AGENT_TASK: 'agent_task',    // agent's runAgentLoop steps
  AGENT_RESULT: 'agent_result',// agent reply summary
  TELEGRAM: 'telegram',        // bot conversation
  SLACK: 'slack',
  DISCORD: 'discord',
  TOOL: 'tool',                // remember-tool dispatch
  LEARN: 'learn',              // learnFromTurn extraction
  PROFILE: 'profile',          // user-profile editing
  MANUAL: 'manual',            // direct UI edit
  IMPORT: 'import',             // bulk import / migration
});

// Lazy-loaded FTS index (PHASE 6/8). Pure-JS inverted index, no native
// deps. Built in-memory on AgentMemory.init() from existing memories +
// conversations; kept incremental thereafter.
const { InvertedIndex } = require('./memoryFts');

class AgentMemory {
  constructor(dbPath) {
    this.filePath = dbPath.replace(/\.db$/, '.json');
    this.ready = false;
    this.fts = new InvertedIndex();
    // Active persona id at the time of write — captured in remember()
    // when caller doesn't pass an explicit personaId. Set by main.js
    // via setActivePersona() so AgentMemory doesn't import settingsStore.
    this._activePersonaId = '';
    this._data = {
      memories: [],
      facts: {},
      meals: [],
      conversations: [],
      learning: { stats: {} },
      // ── PHASE 8-TYPE MEMORY ARCHITECTURE — see docs/memory-architecture.md ──
      // 1. facts             — key-value preferences (existing)
      // 2. memories          — timestamped episodic (existing)
      // 3. conversations     — full transcript history (existing)
      // 4. semantic index    — embeddings sidecar (existing, separate file)
      // 5. userProfile       — Honcho-style Big Five + communication style (NEW)
      // 6+. fts / persona-memory / workspace-conventions — planned next sprint
      userProfile: { ...DEFAULT_USER_PROFILE, bigFive: { ...DEFAULT_USER_PROFILE.bigFive }, communicationStyle: { ...DEFAULT_USER_PROFILE.communicationStyle }, expertise: [], goals: [], preferences: {} },
    };
    // Embeddings service is wired post-construct via setEmbeddingService.
    // While null, recall() stays on the keyword scorer — no regression for
    // users who haven't added an OpenAI/Gemini key.
    this.embeddings = null;
    this._embedDebounce = null;
    this._pendingEmbedKeys = new Set();

    // PHASE 28.2 — SQLite + FTS5 backend wired in by main.js after boot.
    // When set, ftsSearch() uses SQLite bm25 and writes mirror through on
    // each remember/forget/setFact for live sync (vs the old boot-only
    // mirror). JSON stays the human-editable source of truth — never
    // overwritten by SQLite, only kept in lockstep.
    this.memoryDb = null;

    // PHASE 28.4 — Dialectic user model (9th memory layer, Honcho-style).
    // Injected by main.js. When set, learnFromTurn calls dialecticExtract
    // after each non-trivial turn to add belief/desire/knowledge/theory-
    // of-mind diffs to the file-backed model.
    this.dialectic = null;
    this.dialecticExtractor = null; // (user, assistant, recentDiffs) → Promise<updates[]>
    this._dialecticTurnCount = 0;
  }

  /** Inject the file-backed dialectic store. main.js boot wires this. */
  setDialecticModel(model) {
    this.dialectic = model || null;
  }

  /** Inject the LLM extractor that returns diff records from a turn.
   *  Signature: async (user, assistant, recentDiffs, { meta }) → array
   *  Each returned item should match DialecticModel.record() shape:
   *  { kind, before?, after, evidence?, confidence? }.
   *  Without this, dialectic stays empty (record() is never called auto). */
  setDialecticExtractor(fn) {
    this.dialecticExtractor = typeof fn === 'function' ? fn : null;
  }

  /** Sprint 7B — Inject the SQLite + FTS5 MemoryDb wrapper. SQLite is
   *  now the PRIMARY store: on wire-up we hydrate _data from SQLite
   *  (overwriting anything init() loaded from a stale JSON file), and
   *  subsequent _save() calls become a no-op (writes go straight to
   *  SQLite from remember/setFact/saveConversation).
   *
   *  Opt back to the old hybrid (JSON primary + SQLite mirror) by
   *  setting HORIZON_MEMORY_BACKEND=json before boot — headless.js
   *  and main.js both skip calling setMemoryDb() in that mode. */
  setMemoryDb(db) {
    this.memoryDb = db || null;
    if (!db || !db.db) return;
    // Hydrate _data from SQLite — SQLite is the source of truth now.
    // The userProfile + meals + learning blocks live only in JSON;
    // we keep whatever init() loaded for those (or the defaults).
    try {
      const memRows = db.db.prepare(`
        SELECT id, content, category, importance, created_at, last_seen, seen, source, persona_id,
               usefulness, useful_count, pinned
          FROM memories ORDER BY created_at ASC
      `).all();
      this._data.memories = memRows.map(r => ({
        id: Date.now(), // legacy field — JSON had numeric ids
        key: r.id,
        content: r.content,
        category: r.category || 'general',
        importance: r.importance || 5,
        created: r.created_at,
        lastSeen: r.last_seen || r.created_at,
        seen: r.seen || 1,
        source: r.source || 'sqlite',
        lastSource: r.source || 'sqlite',
        personaId: r.persona_id || null,
        personas: r.persona_id ? [r.persona_id] : [],
        // v0.0.3 — persist the WS2 feedback loop + pinned flag across restarts
        // (these used to reset to 0/false on every SQLite-primary cold boot).
        usefulness: r.usefulness || 0,
        usefulCount: r.useful_count || 0,
        pinned: !!r.pinned,
      }));

      const factRows = db.db.prepare('SELECT key, value, updated_at, source FROM facts').all();
      this._data.facts = {};
      for (const f of factRows) {
        this._data.facts[f.key] = {
          value: f.value,
          updated: f.updated_at,
          seen: 1,
          source: f.source || 'sqlite',
          lastSource: f.source || 'sqlite',
        };
      }

      const convRows = db.db.prepare(`
        SELECT id, user, assistant, source, persona_id, created_at
          FROM conversations ORDER BY created_at ASC
      `).all();
      this._data.conversations = convRows.map(c => ({
        id: Number(c.id) || c.id,
        user: c.user || '',
        assistant: c.assistant || '',
        source: c.source || 'sqlite',
        personaId: c.persona_id || null,
        time: new Date(c.created_at || Date.now()).toISOString(),
        meta: {},
      }));

      this._ensureShape();
      this._rebuildFts();
    } catch (e) {
      console.warn('[memory] SQLite hydration failed, falling back to JSON _data:', e.message);
    }
  }

  /** Inject the EmbeddingService instance (created in main.js so it shares
   *  fetch + keysStore). Called once at boot after init(). */
  setEmbeddingService(svc) {
    this.embeddings = svc || null;
    if (svc) {
      // Prune indexes for memories that were deleted while we weren't
      // looking — cheap, runs once on wiring.
      try { svc.pruneKeys(this._data.memories.map(m => m.key)); } catch (_) {}
    }
  }

  /** Queue a memory key for async embedding. Coalesces bursts of remember()
   *  calls into a single batch run on the next tick. */
  _queueEmbedding(key) {
    if (!this.embeddings || !key) return;
    this._pendingEmbedKeys.add(key);
    if (this._embedDebounce) return;
    this._embedDebounce = setTimeout(() => {
      this._embedDebounce = null;
      this._flushEmbeddingQueue().catch(e => console.warn('[memory] flush embeddings:', e.message));
    }, 1500);
  }

  async _flushEmbeddingQueue() {
    if (!this.embeddings || !this._pendingEmbedKeys.size) return;
    const keys = [...this._pendingEmbedKeys];
    this._pendingEmbedKeys.clear();
    const items = keys
      .map(k => this._data.memories.find(m => m.key === k))
      .filter(Boolean)
      .map(m => ({ key: m.key, text: m.content }));
    if (!items.length) return;
    try {
      await this.embeddings.backfill(items);
    } catch (e) {
      console.warn('[memory] embed flush failed:', e.message);
    }
  }

  /** Backfill all memories that don't have embeddings yet. Idempotent. */
  async embedAllPending(onProgress) {
    if (!this.embeddings) return { ok: false, error: 'no embeddings service' };
    const items = this._data.memories.map(m => ({ key: m.key, text: m.content }));
    return this.embeddings.backfill(items, { onProgress });
  }

  _ensureShape() {
    this._data.memories = Array.isArray(this._data.memories) ? this._data.memories : [];
    // PHASE 28 — heal memories that were saved before the `key` field
    // existed. Without a key, EmbeddingService.backfill() rejected them
    // in the "bad" bucket and the inspector reported 0/N indexed even
    // though the chat claimed everything was up to date. Regenerate the
    // key from content + category on load — idempotent.
    for (const m of this._data.memories) {
      if (m && !m.key && m.content) {
        m.key = this._memoryKey(this._normalizeText(m.content), m.category || 'general');
      }
      // WS2 — lazy-migrate the usefulness fields onto pre-existing records.
      if (m && typeof m.usefulness !== 'number') m.usefulness = 0;
      if (m && typeof m.usefulCount !== 'number') m.usefulCount = 0;
      // v0.0.3 — pinned core (layer 13): always injected, bypasses recall threshold.
      if (m && typeof m.pinned !== 'boolean') m.pinned = false;
    }
    this._data.facts = this._data.facts && typeof this._data.facts === 'object' ? this._data.facts : {};
    this._data.meals = Array.isArray(this._data.meals) ? this._data.meals : [];
    this._data.conversations = Array.isArray(this._data.conversations) ? this._data.conversations : [];
    this._data.learning = this._data.learning && typeof this._data.learning === 'object' ? this._data.learning : { stats: {} };
    this._data.learning.stats = this._data.learning.stats && typeof this._data.learning.stats === 'object' ? this._data.learning.stats : {};
    // User profile — Big Five + communication style. Hydrate from saved
    // state but fill in missing keys from DEFAULT_USER_PROFILE so the
    // shape is stable for the UI.
    const up = (this._data.userProfile && typeof this._data.userProfile === 'object') ? this._data.userProfile : {};
    this._data.userProfile = {
      bigFive: { ...DEFAULT_USER_PROFILE.bigFive, ...(up.bigFive || {}) },
      communicationStyle: { ...DEFAULT_USER_PROFILE.communicationStyle, ...(up.communicationStyle || {}) },
      expertise: Array.isArray(up.expertise) ? up.expertise : [],
      goals: Array.isArray(up.goals) ? up.goals : [],
      preferences: (up.preferences && typeof up.preferences === 'object') ? up.preferences : {},
      confidence: typeof up.confidence === 'number' ? up.confidence : 0.0,
      observedAt: up.observedAt || null,
      source: up.source || 'default',
    };
  }

  _hash(text) {
    return crypto.createHash('sha1').update(String(text || '').toLowerCase().trim()).digest('hex').slice(0, 12);
  }

  _normalizeText(text, limit = 1200) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  _memoryKey(content, category) {
    return `${category || 'general'}:${this._hash(content)}`;
  }

  init() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this._data = JSON.parse(raw);
        this._ensureShape();
      } else {
        this._ensureShape();
        this._save();
      }
      this.ready = true;
      // PHASE 6/8 — build FTS index from existing memories +
      // conversations. Cheap (~30ms for 2000 entries on a modern laptop)
      // and avoids sidecar IO. Re-built on every app restart.
      this._rebuildFts();
    } catch (e) {
      console.error('Memory init error:', e.message);
      this.ready = true;
    }
    return true;
  }

  setActivePersona(id) {
    this._activePersonaId = String(id || '');
  }

  _rebuildFts() {
    try {
      this.fts = new InvertedIndex();
      for (const m of this._data.memories || []) {
        if (m && m.content) {
          this.fts.add(m.key || ('mem-' + m.id), m.content, {
            type: 'memory', personaId: m.personaId || null, kind: m.category || 'general'
          });
        }
      }
      for (const [k, v] of Object.entries(this._data.facts || {})) {
        const value = (v && typeof v === 'object') ? v.value : v;
        if (value) this.fts.add('fact:' + k, `${k} ${value}`, { type: 'fact', kind: k });
      }
      for (const c of this._data.conversations || []) {
        const txt = `${c.user || ''} ${c.assistant || ''}`.trim();
        if (txt) this.fts.add('conv:' + c.id, txt, { type: 'conversation', kind: c.source || 'chat' });
      }
    } catch (e) {
      console.warn('FTS rebuild failed:', e.message);
    }
  }

  _save() {
    // Sprint 7B — SQLite is the primary store; when its handle is wired,
    // remember/setFact/saveConversation each mirror straight into the DB
    // via the methods below. We skip the JSON write here to avoid two
    // sources of truth drifting. The userProfile + learning.stats blocks
    // live only in JSON though, so when SQLite is primary we still write
    // them to a small JSON sidecar (memory.json kept slim, no memories /
    // facts / conversations duplicated).
    if (this.memoryDb && this.memoryDb.db) {
      try {
        const slim = {
          // Memories, facts, conversations all live in SQLite now —
          // include just the count for crash-debug visibility, not the data.
          _primary: 'sqlite',
          _exportedAt: new Date().toISOString(),
          userProfile: this._data.userProfile,
          learning: this._data.learning,
          meals: this._data.meals || [],
        };
        fs.writeFileSync(this.filePath, JSON.stringify(slim, null, 2));
      } catch (e) {
        console.error('Memory sidecar save error:', e.message);
      }
      return;
    }
    // Legacy JSON-primary path — used when HORIZON_MEMORY_BACKEND=json.
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this._data, null, 2));
    } catch (e) {
      console.error('Memory save error:', e.message);
    }
  }

  // Remember something with category and importance.
  // `source` (PHASE: memory provenance) records WHERE the memory came from
  // — chat / agent_task / telegram / tool / learn / manual — so the
  // review UI can show provenance and let users selectively forget.
  // `personaId` (PHASE 7/8) ties the memory to a specific persona so
  // recall can boost matches when that persona is active.
  remember(content, category, importance, source, personaId) {
    if (!this.ready || !content) return null;
    this._ensureShape();
    const normalized = this._normalizeText(content);
    if (!normalized) return null;
    const key = this._memoryKey(normalized, category || 'general');
    const tag = String(source || MEMORY_SOURCES.TOOL);
    const persona = String(personaId || this._activePersonaId || '');
    const existing = this._data.memories.find(m => m.key === key);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.seen = (existing.seen || 1) + 1;
      existing.importance = Math.max(existing.importance || 5, importance || 5);
      // Track the most recent source we observed this memory from. Useful
      // for the UI ("seen 3 times — last from telegram").
      if (tag) existing.lastSource = tag;
      // Track which personas have re-asserted this memory. Stored as a
      // small set on the record so recall can boost without overwriting
      // the original persona.
      if (persona) {
        existing.personas = Array.isArray(existing.personas) ? existing.personas : (existing.personaId ? [existing.personaId] : []);
        if (!existing.personas.includes(persona)) existing.personas.push(persona);
      }
      this._save();
      return existing;
    }
    const item = {
      id: Date.now(),
      key,
      category: category || 'general',
      content: normalized,
      created: Date.now(),
      lastSeen: Date.now(),
      seen: 1,
      importance: importance || 5,
      source: tag,
      lastSource: tag,
      personaId: persona || null,
      personas: persona ? [persona] : [],
      // WS2 — memory feedback loop. usefulness accrues each time this memory
      // was injected into a turn AND visibly used in the answer; it feeds a
      // small recall-ranking bonus so memories that actually help surface
      // sooner. usefulCount is the raw hit count for the inspector.
      usefulness: 0,
      usefulCount: 0,
      // v0.0.3 — pinned core (layer 13). Toggled via pinMemory()/unpinMemory().
      pinned: false,
    };
    this._data.memories.push(item);
    // Limit to last 2000 memories
    if (this._data.memories.length > 2000) {
      const dropped = this._data.memories.splice(0, this._data.memories.length - 2000);
      // Drop their embeddings + FTS too — sidecar would otherwise hold orphans.
      if (this.embeddings) {
        for (const m of dropped) this.embeddings.removeVector(m.key);
        try { this.embeddings.saveSidecar(); } catch (_) {}
      }
      try { for (const m of dropped) this.fts.remove(m.key); } catch (_) {}
    }
    this._save();
    // Index in FTS (sync, in-memory — cheap) + embedding (async, network).
    try { this.fts.add(item.key, item.content, { type: 'memory', personaId: item.personaId, kind: item.category }); } catch (_) {}
    // PHASE 28.2 — also mirror into SQLite for queryable bm25 + ACID
    // durability. Best-effort: if the DB is locked or the binding is
    // missing we still have the JSON write above.
    if (this.memoryDb && this.memoryDb.db) {
      try {
        this.memoryDb.addMemory({
          id: item.key,
          content: item.content,
          category: item.category,
          importance: item.importance,
          source: item.source,
          personaId: item.personaId,
          createdAt: item.created,
          usefulness: item.usefulness,
          usefulCount: item.usefulCount,
          pinned: item.pinned,
        });
      } catch (e) { console.warn('[memory] SQLite addMemory mirror failed:', e.message); }
    }
    this._queueEmbedding(item.key);
    return item;
  }

  // Set a persistent fact (key-value). `source` records provenance for the
  // review UI; defaults to MANUAL when not specified.
  setFact(key, value, source) {
    if (!this.ready) return false;
    this._ensureShape();
    const safeKey = this._normalizeText(key, 120);
    const safeValue = this._normalizeText(value, 1200);
    if (!safeKey || !safeValue) return false;
    const prev = this._data.facts[safeKey];
    const tag = String(source || MEMORY_SOURCES.MANUAL);
    this._data.facts[safeKey] = {
      value: safeValue,
      updated: Date.now(),
      seen: (prev?.seen || 0) + (prev?.value === safeValue ? 1 : 0),
      // Preserve the ORIGINAL source on subsequent updates; track the most
      // recent in `lastSource`. Helps the user see "you set this manually
      // but Telegram confirmed it twice".
      source: prev?.source || tag,
      lastSource: tag,
    };
    this._save();
    // PHASE 6/8 — keep FTS in sync with facts so a query like "yerba mate"
    // can surface the fact alongside any memories.
    try { this.fts.add('fact:' + safeKey, `${safeKey} ${safeValue}`, { type: 'fact', kind: safeKey }); } catch (_) {}
    // PHASE 28.2 — SQLite mirror.
    if (this.memoryDb && this.memoryDb.db) {
      try { this.memoryDb.setFact(safeKey, safeValue, tag); }
      catch (e) { console.warn('[memory] SQLite setFact mirror failed:', e.message); }
    }
    return true;
  }

  // ── Memory provenance helpers ────────────────────────────────────────
  forgetFact(key) {
    if (!this.ready) return false;
    this._ensureShape();
    const safeKey = this._normalizeText(key, 120);
    if (!safeKey || !(safeKey in this._data.facts)) return false;
    delete this._data.facts[safeKey];
    try { this.fts.remove('fact:' + safeKey); } catch (_) {}
    // PHASE 28.2 — SQLite mirror cleanup.
    if (this.memoryDb && this.memoryDb.db) {
      try { this.memoryDb.db.prepare('DELETE FROM facts WHERE key = ?').run(safeKey); }
      catch (e) { console.warn('[memory] SQLite forgetFact mirror failed:', e.message); }
    }
    this._save();
    return true;
  }

  forgetMemory(idOrKey) {
    if (!this.ready) return false;
    this._ensureShape();
    const target = String(idOrKey || '');
    // Capture the actual memory keys we're dropping so we can also clean
    // FTS + embeddings sidecar (target might be the id, not the key).
    const dropping = this._data.memories.filter(m => String(m.id) === target || m.key === target);
    const before = this._data.memories.length;
    this._data.memories = this._data.memories.filter(m => String(m.id) !== target && m.key !== target);
    const removed = before - this._data.memories.length;
    if (removed > 0) {
      if (this.embeddings) {
        try {
          for (const m of dropping) this.embeddings.removeVector(m.key);
          this.embeddings.saveSidecar();
        } catch (_) {}
      }
      try { for (const m of dropping) this.fts.remove(m.key); } catch (_) {}
      // PHASE 28.2 — SQLite mirror cleanup.
      if (this.memoryDb && this.memoryDb.db) {
        try {
          for (const m of dropping) this.memoryDb.removeMemory(m.key);
        } catch (e) { console.warn('[memory] SQLite forgetMemory mirror failed:', e.message); }
      }
    }
    this._save();
    return removed > 0;
  }

  editMemory(idOrKey, partial) {
    if (!this.ready) return false;
    this._ensureShape();
    const target = String(idOrKey || '');
    const mem = this._data.memories.find(m => String(m.id) === target || m.key === target);
    if (!mem) return false;
    if (typeof partial?.content === 'string') {
      const norm = this._normalizeText(partial.content);
      if (norm) {
        mem.content = norm;
        // Re-key when content changes so dedup logic stays consistent.
        const newKey = this._memoryKey(norm, mem.category || 'general');
        if (newKey !== mem.key && this.embeddings) {
          // Move the embedding vector to the new key + re-embed in the background.
          try { this.embeddings.removeVector(mem.key); } catch (_) {}
          mem.key = newKey;
          this._queueEmbedding(newKey);
        } else if (newKey === mem.key) {
          this._queueEmbedding(newKey); // refresh anyway
        }
      }
    }
    if (typeof partial?.importance === 'number') {
      mem.importance = Math.max(1, Math.min(10, partial.importance));
    }
    if (typeof partial?.category === 'string' && partial.category.trim()) {
      mem.category = partial.category.trim();
    }
    mem.lastSeen = Date.now();
    mem.lastSource = MEMORY_SOURCES.MANUAL;
    this._save();
    return true;
  }

  // ── User Profile (Big Five + communication style + preferences) ──────
  // PHASE 5/8 memory type — "Honcho-style dialectic user model". Stored
  // alongside facts/memories in the same JSON; the UI lets the user
  // directly tune it; learnFromTurn can nudge values when it detects
  // strong signals (e.g. "обращайся ко мне формально").
  getUserProfile() {
    this._ensureShape();
    return JSON.parse(JSON.stringify(this._data.userProfile));
  }

  updateUserProfile(partial = {}, source = MEMORY_SOURCES.MANUAL) {
    if (!this.ready) return null;
    this._ensureShape();
    const up = this._data.userProfile;
    if (partial.bigFive && typeof partial.bigFive === 'object') {
      for (const [k, v] of Object.entries(partial.bigFive)) {
        if (k in up.bigFive && typeof v === 'number') {
          up.bigFive[k] = Math.max(0, Math.min(1, v));
        }
      }
    }
    if (partial.communicationStyle && typeof partial.communicationStyle === 'object') {
      for (const [k, v] of Object.entries(partial.communicationStyle)) {
        if (k in up.communicationStyle) up.communicationStyle[k] = String(v || '').slice(0, 120);
      }
    }
    if (Array.isArray(partial.expertise)) up.expertise = partial.expertise.slice(0, 50);
    if (Array.isArray(partial.goals))     up.goals     = partial.goals.slice(0, 50);
    if (partial.preferences && typeof partial.preferences === 'object') {
      up.preferences = { ...up.preferences, ...partial.preferences };
    }
    if (typeof partial.confidence === 'number') {
      up.confidence = Math.max(0, Math.min(1, partial.confidence));
    } else {
      // Manual edits bump confidence — user has told us something explicit.
      if (source === MEMORY_SOURCES.MANUAL) up.confidence = Math.min(1, up.confidence + 0.05);
    }
    up.observedAt = new Date().toISOString();
    up.source = source;
    this._save();
    return JSON.parse(JSON.stringify(up));
  }

  getFact(key) {
    return this._data.facts[key]?.value || null;
  }

  getAllFacts() {
    return Object.fromEntries(
      Object.entries(this._data.facts).map(([k, v]) => [k, v.value])
    );
  }

  // Keyword scoring kept private so the hybrid recall can reuse it. Returns
  // the same record shape as before (`...m, score, matches`).
  _keywordScore(query) {
    const q = (query || '').toLowerCase();
    const words = q.split(/[^\p{L}\p{N}_-]+/u).filter(w => w.length > 2);
    const now = Date.now();
    return this._data.memories.map(m => {
      const content = String(m.content || '').toLowerCase();
      const matches = words.reduce((acc, w) => acc + (content.includes(w) ? 1 : 0), 0);
      const ageDays = Math.max(0, (now - (m.lastSeen || m.created || now)) / 86400000);
      const recency = Math.max(0, 4 - Math.floor(ageDays / 14));
      const score = (matches * 4) + (m.importance || 5) + recency + Math.min(3, m.seen || 1);
      return { ...m, kwScore: score, matches };
    });
  }

  /**
   * WS2 — memory feedback loop. Given the memories that were injected into a
   * turn and the agent's final answer, detect which memories were actually
   * "used" (their distinctive content tokens resurface in the answer, or the
   * answer references the memory key) and reward them: usefulness += 1,
   * usefulCount += 1, importance nudged up (capped), lastSeen refreshed.
   *
   * Purely additive — until a memory is rewarded its usefulness stays 0 and
   * recall behaves exactly as before. Returns the number of memories bumped.
   *
   * Detection is deliberately conservative (token overlap, no model call) so
   * it works offline and can't run away: a memory is counted as used only if
   * a meaningful share of its words appear in the answer, not on one common
   * word collision.
   */
  markMemoriesUsed(injectedMemories, finalAnswer) {
    if (!Array.isArray(injectedMemories) || !injectedMemories.length) return 0;
    const answer = String(finalAnswer || '').toLowerCase();
    if (answer.length < 2) return 0;
    const answerWords = new Set(answer.split(/[^\p{L}\p{N}_-]+/u).filter(w => w.length > 2));
    let bumped = 0;

    for (const inj of injectedMemories) {
      const key = inj && (inj.key || inj.id);
      if (!key) continue;
      // Resolve to the live record so we mutate the canonical object.
      const rec = this._data.memories.find(m => m.key === key || m.id === inj.id);
      if (!rec) continue;

      const contentWords = [...new Set(
        String(rec.content || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(w => w.length > 2)
      )];
      if (!contentWords.length) continue;
      const overlap = contentWords.reduce((acc, w) => acc + (answerWords.has(w) ? 1 : 0), 0);
      const ratio = overlap / contentWords.length;
      const keyReferenced = answer.includes(String(rec.key || '').toLowerCase()) && String(rec.key || '').length > 4;

      // Used if: a strong share of the memory's words resurface, OR several
      // words do in absolute terms, OR the answer names the key directly.
      const used = (ratio >= 0.4 && overlap >= 2) || overlap >= 3 || keyReferenced;
      if (!used) continue;

      rec.usefulness = (typeof rec.usefulness === 'number' ? rec.usefulness : 0) + 1;
      rec.usefulCount = (typeof rec.usefulCount === 'number' ? rec.usefulCount : 0) + 1;
      rec.importance = Math.min(10, (rec.importance || 5) + 0.5);
      rec.lastSeen = Date.now();
      // v0.0.3 — persist the bump to SQLite. The slim _save() omits memories
      // when SQLite is primary, so without this the feedback loop evaporated
      // on every cold boot. Best-effort mirror keeps usefulness durable.
      if (this.memoryDb && this.memoryDb.db) {
        try {
          this.memoryDb.db.prepare(
            'UPDATE memories SET usefulness=?, useful_count=?, importance=?, last_seen=? WHERE id=?'
          ).run(rec.usefulness, rec.usefulCount, rec.importance, rec.lastSeen, rec.key);
        } catch (_) {}
      }
      bumped++;
    }

    if (bumped) this._save();
    return bumped;
  }

  /**
   * Synchronous keyword recall — kept as the safe fallback path. Used when
   * the EmbeddingService is unavailable, when query length is too short to
   * embed meaningfully, or when the model side calls recall synchronously.
   */
  recall(query, limit) {
    this._ensureShape();
    const q = (query || '').toLowerCase();
    return this._keywordScore(q)
      .filter(m => m.matches > 0 || q.length < 3)
      .map(m => ({ ...m, score: m.kwScore }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.importance !== a.importance) return b.importance - a.importance;
        return b.created - a.created;
      })
      .slice(0, limit || 10);
  }

  /**
   * Hybrid semantic + keyword recall. Embedding contributes ~0.6 of the
   * blended score; keyword retains ~0.4. The split means:
   *  - exact-string queries (e.g. user pastes a memory verbatim) still win
   *    via the keyword path,
   *  - paraphrased / conceptual queries surface their best semantic match.
   * Falls back to plain `recall()` when no embedding service is wired or
   * the query embedding can't be computed.
   *
   * Returns the same record shape as recall() plus {semantic, kw, score}.
   */
  /** Pure FTS search across memories + facts + conversations. Returns
   *  flat results with `{id, score, meta}`. Used by Inspector + advanced
   *  search; semanticRecall blends a small share of this signal into its
   *  ranking.
   *
   *  PHASE 28.2 — when MemoryDb is wired, query SQLite bm25 first
   *  (phrase / prefix / proximity capable) and reshape the rows into
   *  the same {id, score, meta} shape callers expect. Falls back to
   *  the pure-JS InvertedIndex on any error or when MemoryDb wasn't
   *  set up (e.g. better-sqlite3 didn't compile).
   */
  ftsSearch(query, limit = 20) {
    if (this.memoryDb && this.memoryDb.db) {
      try {
        const hits = this.memoryDb.searchAll(query, limit);
        if (hits && hits.length) {
          // bm25 returns negative scores — closer to 0 is better. Convert
          // to a positive 0..1-ish score so blending in semanticRecall
          // stays meaningful.
          const minScore = Math.min(...hits.map(h => h.score || 0));
          const norm = (s) => (minScore < 0 ? (1 - (s / minScore)) : 0);
          return hits.slice(0, limit).map(h => ({
            id: h.id || ('row-' + h.rowid),
            score: Number(norm(h.score || 0).toFixed(4)),
            meta: { type: h._type, kind: h.category || h.key || h.source || null, personaId: h.persona_id || null },
          }));
        }
      } catch (e) {
        console.warn('[memory] SQLite FTS failed, falling back to InvertedIndex:', e.message);
      }
    }
    return this.fts.search(query, limit);
  }

  async semanticRecall(query, limit, opts = {}) {
    this._ensureShape();
    const q = String(query || '').trim();
    const lim = limit || 10;
    if (!this.embeddings || !this.embeddings.isAvailable() || q.length < 3) {
      return this.recall(q, lim);
    }
    let queryVec = null;
    try { queryVec = await this.embeddings.embed(q); }
    catch (e) { /* fall through */ }
    if (!queryVec) return this.recall(q, lim);

    // Weighted blend across three signals:
    //   semantic (cosine, 0..1)  ×  default 0.55
    //   keyword (normalised, 0..1)  ×  default 0.30
    //   FTS (normalised, 0..1)       ×  default 0.15  ← PHASE 6/8
    // Plus PHASE 7/8 persona boost: ×1.2 when the memory's personaId
    // matches the currently-active persona.
    const semWeight = typeof opts.semanticWeight === 'number' ? opts.semanticWeight : 0.55;
    const kwWeight  = typeof opts.kwWeight === 'number' ? opts.kwWeight : 0.30;
    const ftsWeight = typeof opts.ftsWeight === 'number' ? opts.ftsWeight : 0.15;
    // WS2 — usefulness bonus: memories proven helpful in past turns get a
    // small additive lift. Until any memory is rewarded (all usefulness=0)
    // this term is 0 and ranking is identical to before.
    const usefulnessWeight = typeof opts.usefulnessWeight === 'number' ? opts.usefulnessWeight : 0.15;
    const activePersona = String(opts.activePersona || this._activePersonaId || '');
    const personaBoost = typeof opts.personaBoost === 'number' ? opts.personaBoost : 1.2;

    const kw = this._keywordScore(q);
    const kwMax = Math.max(1, ...kw.map(m => m.kwScore || 0));
    const useMax = Math.max(1, ...kw.map(m => m.usefulness || 0));
    // FTS scores keyed by memory key (FTS adds memories with their key
    // directly). Normalise so the blend weight is meaningful.
    const ftsResults = this.ftsSearch(q, 200);
    const ftsByKey = new Map();
    const ftsMax = Math.max(1, ...ftsResults.map(r => r.score));
    for (const r of ftsResults) {
      if (r.meta?.type === 'memory') ftsByKey.set(r.id, r.score / ftsMax);
    }

    const blended = kw.map(m => {
      const vec = this.embeddings.index.get(m.key);
      const sem = vec ? Math.max(0, require('./embeddings').cosine(queryVec, vec)) : 0;
      const kwNorm = (m.kwScore || 0) / kwMax;
      const ftsNorm = ftsByKey.get(m.key) || 0;
      const useNorm = (m.usefulness || 0) / useMax;
      let score = (semWeight * sem) + (kwWeight * kwNorm) + (ftsWeight * ftsNorm) + (usefulnessWeight * useNorm);
      const personaMatch = activePersona && (m.personaId === activePersona || (Array.isArray(m.personas) && m.personas.includes(activePersona)));
      if (personaMatch) score *= personaBoost;
      return {
        ...m,
        semantic: Number(sem.toFixed(4)),
        kw: Number(kwNorm.toFixed(4)),
        fts: Number(ftsNorm.toFixed(4)),
        usefulness: m.usefulness || 0,
        personaMatch: !!personaMatch,
        score: Number(score.toFixed(4)),
      };
    });
    // Require some signal — semantic, keyword, or FTS.
    return blended
      .filter(m => m.semantic >= 0.18 || m.matches > 0 || m.fts >= 0.15)
      .sort((a, b) => (b.score - a.score) || (b.importance - a.importance) || (b.created - a.created))
      .slice(0, lim);
  }

  /**
   * v0.0.3 — single shared builder for the agent system-prompt memory context.
   * BOTH surfaces (Electron ipc/ai.js agentRun + CLI headless.js runAgent) call
   * this, so they can never drift apart again. Returns the `sysInfo.memory` block
   * (exact shape buildAgentSystemPrompt consumes) plus the dialectic injection
   * string. Pure read except setActivePersona; fully offline-safe — semanticRecall
   * falls back to recall(), injection()/userProfileBlock return ''.
   */
  async buildAgentContext(userMessage, opts = {}) {
    this._ensureShape();
    const activePersona = String(opts.activePersona || this._activePersonaId || '');
    if (activePersona) this.setActivePersona(activePersona);
    const recallLimit = typeof opts.recallLimit === 'number' ? opts.recallLimit : 8;
    let relevant = [];
    if (recallLimit > 0) {
      try {
        relevant = (typeof this.semanticRecall === 'function')
          ? await this.semanticRecall(userMessage, recallLimit, { activePersona, ...(opts.weights || {}) })
              .catch(() => this.recall(userMessage, recallLimit))
          : this.recall(userMessage, recallLimit);
      } catch (_) { relevant = this.recall(userMessage, recallLimit); }
    }
    relevant = Array.isArray(relevant) ? relevant : [];
    // Layer 13 — pinned core memories ALWAYS present (bypass recall threshold and
    // top-K), prepended, deduped against recall, capped so the prompt stays lean.
    const pinned = (this._data.memories || [])
      .filter(m => m && m.pinned)
      .sort((a, b) => (b.importance || 0) - (a.importance || 0))
      .slice(0, 10);
    const seen = new Set(relevant.map(m => m.key));
    const merged = [
      ...pinned.filter(m => !seen.has(m.key)).map(m => ({ ...m, _pinned: true })),
      ...relevant,
    ];
    const memory = {
      facts: this.getAllFacts(),
      relevant: merged,
      recentConversations: this.searchConversations(userMessage, typeof opts.convLimit === 'number' ? opts.convLimit : 5),
      userProfileBlock: typeof this.buildUserProfileBlock === 'function' ? this.buildUserProfileBlock() : '',
      pinnedCount: pinned.length,
    };
    // Layer 11 — entity graph: surface relations for entities named in the query.
    try {
      if (this.memoryDb && this.memoryDb.db && typeof this.memoryDb.relationsFor === 'function') {
        const tokens = String(userMessage || '').split(/[^\p{L}\p{N}_-]+/u).filter(w => w.length > 2).slice(0, 12);
        const graph = [];
        const seenEnt = new Set();
        for (const tok of tokens) {
          for (const e of (this.memoryDb.entitiesByName(tok) || []).slice(0, 2)) {
            if (seenEnt.has(e.id)) continue;
            seenEnt.add(e.id);
            for (const r of (this.memoryDb.relationsFor(e.name) || []).slice(0, 3)) {
              graph.push(`${r.src} ${r.rel} ${r.dst}`);
            }
          }
          if (graph.length >= 8) break;
        }
        memory.graph = [...new Set(graph)].slice(0, 8);
      }
    } catch (_) {}
    let dialecticInjection = '';
    try {
      if (this.dialectic && typeof this.dialectic.injection === 'function') {
        dialecticInjection = this.dialectic.injection(typeof opts.dialecticK === 'number' ? opts.dialecticK : 6) || '';
      }
    } catch (_) {}
    return { memory, dialecticInjection };
  }

  /** v0.0.3 — pin/unpin a memory so it is always injected into the agent prompt
   *  (layer 13). Mirrors the flag to SQLite so it survives restarts. */
  _setPinned(idOrKey, pinned) {
    this._ensureShape();
    const rec = this._data.memories.find(
      m => m.key === idOrKey || m.id === idOrKey || String(m.id) === String(idOrKey)
    );
    if (!rec) return { ok: false, error: 'memory not found' };
    rec.pinned = !!pinned;
    this._save();
    if (this.memoryDb && this.memoryDb.db) {
      try { this.memoryDb.db.prepare('UPDATE memories SET pinned=? WHERE id=?').run(rec.pinned ? 1 : 0, rec.key); } catch (_) {}
    }
    return { ok: true, key: rec.key, pinned: rec.pinned };
  }
  pinMemory(idOrKey) { return this._setPinned(idOrKey, true); }
  unpinMemory(idOrKey) { return this._setPinned(idOrKey, false); }

  ftsStats() {
    return this.fts.stats();
  }

  embeddingStatus() {
    if (!this.embeddings) return { available: false, indexed: 0 };
    const st = this.embeddings.status();
    return { ...st, totalMemories: this._data.memories.length };
  }

  getRecent(limit) {
    this._ensureShape();
    return [...this._data.memories].reverse().slice(0, limit || 20);
  }

  /** v0.0.3 — heuristic entity/relationship extraction (layer 11). Pulls proper
   *  nouns + profile facts into the SQLite graph. Bounded + offline-safe; a no-op
   *  in JSON-primary mode (no SQLite). An LLM extractor can replace it later. */
  _extractGraphHeuristic(user, assistant) {
    if (!this.memoryDb || !this.memoryDb.db) return;
    const STOP = new Set(['The','This','That','These','Those','You','Your','Yes','No','Okay','Here','There','What','When','Where','Why','How','And','But','For','With','From','Horizon','I','It','We','They','He','She','If','So','Then','Now','Today']);
    const text = `${user || ''} ${assistant || ''}`;
    const found = [];
    const seen = new Set();
    const re = /\b[A-Z][a-zA-Z][a-zA-Z0-9.+-]{1,30}\b/g;
    let m;
    while ((m = re.exec(text)) !== null && found.length < 6) {
      const w = m[0];
      if (STOP.has(w) || seen.has(w.toLowerCase())) continue;
      seen.add(w.toLowerCase());
      found.push(w);
    }
    for (const e of found) this.memoryDb.upsertEntity(e, null, 'heuristic');
    // Bounded pairwise co-occurrence edges (each entity → its next 2 neighbours).
    for (let i = 0; i < found.length; i++) {
      for (let j = i + 1; j < Math.min(found.length, i + 3); j++) {
        this.memoryDb.addRelation(found[i], 'related_to', found[j], { confidence: 0.4, evidence: 'co-occurrence' });
      }
    }
    // Structured edges from known profile facts.
    const name = typeof this.getFact === 'function' ? this.getFact('user.name') : null;
    const project = typeof this.getFact === 'function' ? this.getFact('project.name') : null;
    if (name) this.memoryDb.upsertEntity(name, 'person', 'fact');
    if (project) this.memoryDb.upsertEntity(project, 'project', 'fact');
    if (name && project) this.memoryDb.addRelation(name, 'works_on', project, { confidence: 0.8, evidence: 'profile' });
  }

  learnFromTurn(userMessage, assistantReply, meta = {}) {
    if (!this.ready) return { ok: false, learned: 0 };
    this._ensureShape();
    const user = this._normalizeText(userMessage, 1600);
    const assistant = this._normalizeText(assistantReply, 1600);
    if (!user) return { ok: false, learned: 0 };

    const learned = [];
    const stamp = new Date().toISOString();
    // Source tag for everything learnFromTurn writes — surfaces in the
    // review UI so users can tell "this fact came from chat learning" vs
    // "this was manually entered" or "this is from a Telegram message".
    const learnSource = String(meta?.source || MEMORY_SOURCES.LEARN);
    const addFact = (key, value) => {
      if (this.setFact(key, value, learnSource)) learned.push({ type: 'fact', key, value });
    };
    const addMemory = (content, category = 'learned_preference', importance = 7) => {
      const m = this.remember(content, category, importance, learnSource);
      if (m) learned.push({ type: 'memory', category, content: m.content });
    };

    const cleanValue = (v, max = 180) => this._normalizeText(v, max).replace(/[.?!,:;]+$/g, '').trim();
    const nameMatch = user.match(/(?:меня зовут|зови меня|обращайся ко мне как|my name is|call me)\s+([^\n.!?,;]{2,48})/i);
    if (nameMatch) addFact('user.name', cleanValue(nameMatch[1], 48));

    const projectMatch = user.match(/(?:мой проект|проект называется|project is|project name is)\s+([^\n.!?,;]{2,80})/i);
    if (projectMatch) addFact('project.name', cleanValue(projectMatch[1], 80));

    const wants = [
      { re: /(?:я хочу|мне нужно|i want|i need)\s+(.{8,220})/i, category: 'user_goal', prefix: 'User wants' },
      { re: /(?:мне нравится|я люблю|i like|i prefer)\s+(.{4,180})/i, category: 'preference_like', prefix: 'User likes/prefers' },
      { re: /(?:мне не нравится|я не люблю|не хочу|i dislike|i do not like|i don't like)\s+(.{4,180})/i, category: 'preference_dislike', prefix: 'User dislikes/avoids' },
      { re: /(?:всегда|always)\s+(.{4,180})/i, category: 'preference_rule', prefix: 'User always wants' },
      { re: /(?:никогда|never)\s+(.{4,180})/i, category: 'preference_rule', prefix: 'User never wants' },
    ];
    for (const item of wants) {
      const match = user.match(item.re);
      if (match) addMemory(`${item.prefix}: ${cleanValue(match[1], 220)}`, item.category, item.category === 'user_goal' ? 8 : 7);
    }

    if (/horizon|хорайзон|горизонт|cursor|кодекс|codex|claude code/i.test(user)) {
      addMemory(`Project/workflow context (${stamp}): ${user}`, 'project_context', 6);
    }

    // ── Auto-update User Profile from this turn ─────────────────────────
    // Detects signals in the user's message and nudges Big Five + style
    // values by small amounts. Signal weights kept SMALL (0.005–0.03 per
    // turn) so a single accidental "пожалуйста" doesn't tilt the whole
    // model — confidence rises over many turns. Manual UI edits hit
    // larger deltas (+0.05) and overwrite the auto path.
    try {
      const profileChanges = this._detectProfileSignals(user);
      if (Object.keys(profileChanges.bigFive || {}).length || Object.keys(profileChanges.communicationStyle || {}).length) {
        this._applyProfileNudges(profileChanges);
        learned.push({ type: 'profile', changes: profileChanges });
      }
    } catch (e) {
      // Profile auto-update is best-effort; don't fail the whole turn.
      console.warn('[profile] auto-update failed:', e?.message);
    }

    this.saveConversation(user, assistant || '', {
      provider: meta.provider,
      model: meta.model,
      persona: meta.persona,
      runId: meta.runId,
      learned: learned.length
    });

    // v0.0.3 — entity / relationship graph (layer 11). Heuristic by default
    // (offline-safe); a no-op in JSON-primary mode.
    try { this._extractGraphHeuristic(user, assistant || ''); } catch (_) {}

    const stats = this._data.learning.stats;
    stats.turns = (stats.turns || 0) + 1;
    stats.learnedItems = (stats.learnedItems || 0) + learned.length;
    stats.lastTurnAt = stamp;
    this._save();

    // PHASE 28.4 — LLM-driven dialectic extraction. Honcho-style:
    // after each non-trivial turn, ask a small LLM to emit JSON diffs
    // describing what we just learned about the user. Async + fire-
    // and-forget so the chat reply isn't delayed; failure is logged
    // and never thrown.
    this._dialecticTurnCount = (this._dialecticTurnCount || 0) + 1;
    const triviallyShort = (user || '').trim().length < 20 || (assistant || '').trim().length < 30;
    // Sampling: run every turn until we have 20 records, then every
    // 2nd turn — keeps token cost bounded for chatty users.
    const haveBootstrap = this.dialectic && this.dialectic.records.length >= 20;
    const skipBySampling = haveBootstrap && (this._dialecticTurnCount % 2 !== 0);
    if (this.dialectic && this.dialecticExtractor && !triviallyShort && !skipBySampling) {
      const recent = this.dialectic.getRecent(5);
      // Fire-and-forget. Caller doesn't await.
      Promise.resolve()
        .then(() => this.dialecticExtractor(user, assistant || '', recent, { meta }))
        .then(updates => {
          if (!Array.isArray(updates) || !updates.length) return;
          for (const u of updates) {
            try { this.dialectic.record({ ...u, personaId: meta?.persona || u.personaId }); }
            catch (e) { console.warn('[dialectic] record failed:', e.message); }
          }
          console.log(`[dialectic] +${updates.length} update${updates.length === 1 ? '' : 's'} from turn`);
        })
        .catch(e => console.warn('[dialectic] extractor failed:', e.message));
    }

    return { ok: true, learned: learned.length, items: learned };
  }

  /**
   * Inspect a user message for behavioural signals. Returns `partial`
   * suitable for `updateUserProfile`. Heuristics are intentionally small
   * (per-turn deltas of 0.005..0.03) so one stray match doesn't move the
   * model dramatically; signal accumulates over dozens of turns.
   */
  _detectProfileSignals(userMessage) {
    const text = String(userMessage || '');
    const lc = text.toLowerCase();
    const bf = {};       // Big Five trait deltas
    const cs = {};       // communicationStyle direct overwrites

    // ── Communication style (direct settings, not nudges) ──────────────
    // Explicit instructions — user TELLS us how they want to be addressed.
    if (/обращайся.*формально|пишите?.*на.*вы\b|please be (more )?formal/i.test(text)) {
      cs.formality = 'professional';
    } else if (/без формальностей|на ты|less formal|informally/i.test(text)) {
      cs.formality = 'casual';
    }
    if (/(коротко|короче|brief|shorter|less verbose|tldr|tl;dr)/i.test(text)) {
      cs.verbosity = 'brief';
    } else if (/(подробнее|развёрнут|verbose|in detail|more detail|explain.*step.by.step)/i.test(text)) {
      cs.verbosity = 'verbose';
    }
    const callMatch = text.match(/(?:зови меня|обращайся ко мне как|call me|address me as)\s+([^\n.!?,;]{2,32})/i);
    if (callMatch) cs.preferredAddress = callMatch[1].trim().replace(/[.?!,:;]+$/g, '');

    // Language: very rough character-class check. >60% Cyrillic = ru.
    const cyrillic = (text.match(/[а-яё]/gi) || []).length;
    const latin = (text.match(/[a-z]/gi) || []).length;
    if (cyrillic + latin > 12) {
      cs.lang = (cyrillic / (cyrillic + latin)) > 0.6 ? 'ru' : 'en';
    }

    // ── Big Five (tiny nudges, accumulate over turns) ──────────────────
    // Openness: openness to new experiences, ideas, creativity.
    if (/(экспериментир|пробу[йе]м.*новое|давай попробуем|let'?s try|experiment|brainstorm|creative|идеи|inspire)/i.test(lc)) {
      bf.openness = 0.015;
    }
    // Conscientiousness: planning, order, methodical work.
    if (/(по плану|сначала проверим|сначала проверь|step.by.step|methodical|план,? потом|first plan|prioriti[sz]e)/i.test(lc)) {
      bf.conscientiousness = 0.02;
    }
    // Strong demand for thoroughness → conscientiousness up
    if (/(всегда тестируй|always test|sanity check|double.check|перепроверь|тщательно)/i.test(lc)) {
      bf.conscientiousness = 0.025;
    }
    // Extraversion: social / collaborative phrasing. Rare in coding chat.
    if (/(давай вместе|let'?s work together|команд[аы]|collaborate|обсудим)/i.test(lc)) {
      bf.extraversion = 0.01;
    }
    // Agreeableness: politeness markers.
    if (/(пожалуйста|please|спасибо|thanks|thank you|appreciate)/i.test(lc)) {
      bf.agreeableness = 0.005;
    }
    // Neuroticism: stress / anxiety markers.
    if (/(стресс|переживаю|беспокоит|worried|anxious|урgent|срочно|deadline|panic)/i.test(lc)) {
      bf.neuroticism = 0.015;
    }
    // Negative neuroticism signal — calm, relaxed language.
    if (/(спокойно|relax|no rush|можно не торопиться|take your time)/i.test(lc)) {
      bf.neuroticism = -0.01;
    }

    return { bigFive: bf, communicationStyle: cs };
  }

  /**
   * Apply small bigFive deltas (additive, clamped 0..1) and style
   * overwrites (last-write-wins). Confidence creeps up by 0.005 per
   * turn that produces any signal, capped at 0.7 — manual UI edits can
   * still push confidence higher.
   */
  _applyProfileNudges(changes) {
    this._ensureShape();
    const up = this._data.userProfile;
    let touched = false;
    if (changes.bigFive) {
      for (const [k, delta] of Object.entries(changes.bigFive)) {
        if (typeof delta !== 'number' || !(k in up.bigFive)) continue;
        const next = Math.max(0, Math.min(1, (up.bigFive[k] || 0.5) + delta));
        if (next !== up.bigFive[k]) {
          up.bigFive[k] = Number(next.toFixed(4));
          touched = true;
        }
      }
    }
    if (changes.communicationStyle) {
      for (const [k, v] of Object.entries(changes.communicationStyle)) {
        if (!(k in up.communicationStyle)) continue;
        const safeV = String(v || '').slice(0, 120);
        if (safeV && safeV !== up.communicationStyle[k]) {
          up.communicationStyle[k] = safeV;
          touched = true;
        }
      }
    }
    if (touched) {
      up.confidence = Math.min(0.7, (up.confidence || 0) + 0.005);
      up.observedAt = new Date().toISOString();
      up.source = MEMORY_SOURCES.LEARN;
      // _save is called by learnFromTurn at the end; no need to double-save.
    }
  }

  /**
   * Render the user profile as a markdown block ready to inject into the
   * agent's system prompt. Returns empty string when confidence is too
   * low to be useful (< 0.2 — we'd be inventing a model without
   * evidence). The block is short on purpose — a few high-signal bullets,
   * not the raw schema.
   */
  buildUserProfileBlock() {
    this._ensureShape();
    const up = this._data.userProfile;
    if (!up || (up.confidence || 0) < 0.2) return '';

    const lines = [];
    const cs = up.communicationStyle || {};
    if (cs.formality && cs.formality !== 'casual') lines.push(`- Address style: ${cs.formality}`);
    if (cs.preferredAddress) lines.push(`- Address the user as "${cs.preferredAddress}"`);
    if (cs.verbosity && cs.verbosity !== 'medium') {
      lines.push(`- Reply length preference: ${cs.verbosity === 'brief' ? 'keep replies short and to the point' : 'detailed, explain step-by-step'}`);
    }

    // Big Five → behavioural hints. Only mention traits that have moved
    // noticeably away from the neutral 0.5 baseline. Each hint is
    // actionable: tells the model what to DO, not just a number.
    const bf = up.bigFive || {};
    const hint = (k, low, high, threshold = 0.15) => {
      const v = bf[k];
      if (typeof v !== 'number') return null;
      if (v >= 0.5 + threshold) return high;
      if (v <= 0.5 - threshold) return low;
      return null;
    };
    const h = [
      hint('openness',
        'User prefers proven approaches over novel ones — stick with the standard library and conventional patterns unless asked otherwise.',
        'User enjoys exploring novel approaches — when relevant, suggest a creative alternative alongside the conventional one.'),
      hint('conscientiousness',
        null,
        'User values methodical work — outline the plan before changing code, include checks/tests, mention edge cases.'),
      hint('agreeableness',
        'User prefers direct technical answers without softening language; skip "let me know if you have questions" closers.',
        null),
      hint('neuroticism',
        null,
        'User signals stress under deadlines — acknowledge urgency, give a short fix path before the deeper explanation.'),
    ].filter(Boolean);
    lines.push(...h);

    if (!lines.length) return '';
    return `\n\n## User profile (confidence ${(up.confidence * 100).toFixed(0)}%)\n${lines.join('\n')}\n`;
  }

  // ═══ CONVERSATION MEMORY ═══
  saveConversation(userMessage, assistantReply, meta = {}) {
    if (!this.ready) return;
    this._ensureShape();
    const safeMeta = meta && typeof meta === 'object' ? meta : {};
    const convId = Date.now();
    const userText = this._normalizeText(userMessage, 1600);
    const assistantText = this._normalizeText(assistantReply, 1600);
    this._data.conversations.push({
      id: convId,
      user: userText,
      assistant: assistantText,
      meta: safeMeta,
      source: safeMeta.source || MEMORY_SOURCES.CHAT,
      time: new Date().toISOString()
    });
    // PHASE 6/8 — FTS index gets each conversation so search can return
    // historical turns alongside facts/memories. Capped via the 500-conv
    // limit below.
    try {
      this.fts.add('conv:' + convId, `${userText} ${assistantText}`, {
        type: 'conversation', kind: safeMeta.source || MEMORY_SOURCES.CHAT,
      });
    } catch (_) {}
    // Keep last 500 conversations
    if (this._data.conversations.length > 500) {
      const dropped = this._data.conversations.splice(0, this._data.conversations.length - 500);
      try { for (const d of dropped) this.fts.remove('conv:' + d.id); } catch (_) {}
    }
    this._save();
  }

  searchConversations(query, limit = 10) {
    this._ensureShape();
    const q = (query || '').toLowerCase();
    const words = q.split(/[^\p{L}\p{N}_-]+/u).filter(w => w.length > 2);
    return this._data.conversations
      .map(c => {
        const body = `${c.user || ''}\n${c.assistant || ''}`.toLowerCase();
        const score = words.reduce((acc, w) => acc + (body.includes(w) ? 1 : 0), 0);
        return { ...c, score };
      })
      .filter(c => c.score > 0 || q.length < 3)
      .sort((a, b) => (b.score - a.score) || (new Date(b.time).getTime() - new Date(a.time).getTime()))
      .slice(0, limit);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CODE EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

async function executeCode(code, language) {
  const id = crypto.randomBytes(4).toString('hex');
  let file, cmd;
  const lang = (language || 'python').toLowerCase();

  if (lang === 'python' || lang === 'py') {
    file = path.join(os.tmpdir(), `hz_${id}.py`);
    fs.writeFileSync(file, code, 'utf8');
    cmd = IS_WIN ? `python "${file}" 2>&1` : `python3 "${file}" 2>&1`;
  } else if (lang === 'powershell' || lang === 'ps' || lang === 'ps1') {
    file = path.join(os.tmpdir(), `hz_${id}.ps1`);
    fs.writeFileSync(file, code, 'utf8');
    cmd = `powershell -ExecutionPolicy Bypass -File "${file}" 2>&1`;
  } else if (lang === 'javascript' || lang === 'js' || lang === 'node') {
    file = path.join(os.tmpdir(), `hz_${id}.js`);
    fs.writeFileSync(file, code, 'utf8');
    cmd = `node "${file}" 2>&1`;
  } else if (lang === 'shell' || lang === 'bash' || lang === 'sh') {
    file = path.join(os.tmpdir(), `hz_${id}.sh`);
    fs.writeFileSync(file, code, 'utf8');
    cmd = `bash "${file}" 2>&1`;
  } else if (lang === 'cmd' || lang === 'batch' || lang === 'bat') {
    file = path.join(os.tmpdir(), `hz_${id}.bat`);
    fs.writeFileSync(file, code, 'utf8');
    cmd = `"${file}" 2>&1`;
  } else {
    return { ok: false, out: '', err: `Unknown language: ${language}. Use: python, powershell, javascript, shell, cmd` };
  }

  const r = await sh(cmd, 30000);
  try { fs.unlinkSync(file); } catch {}
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOUSE CONTROL
// ═══════════════════════════════════════════════════════════════════════════════

async function mouseMove(x, y) {
  if (IS_WIN) {
    const ps = `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y})`;
    return sh(`powershell -Command "${ps}"`);
  }
  if (IS_MAC) return sh(`osascript -e 'tell application "System Events" to set the mouse position to {${x},${y}}'`);
  return sh(`xdotool mousemove ${x} ${y}`);
}

async function mouseClick(x, y, button, dbl) {
  if (IS_WIN) {
    const dn = button === 'right' ? 8 : 2;
    const up = button === 'right' ? 16 : 4;
    const ps = `Add-Type -AssemblyName System.Windows.Forms;Add-Type @"
using System;using System.Runtime.InteropServices;
public class M{[DllImport("user32.dll")]public static extern void mouse_event(int f,int x,int y,int d,int i);}
"@
[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y});
Start-Sleep -Milliseconds 80;[M]::mouse_event(${dn},0,0,0,0);Start-Sleep -Milliseconds 50;[M]::mouse_event(${up},0,0,0,0);${dbl ? `Start-Sleep -Milliseconds 100;[M]::mouse_event(${dn},0,0,0,0);Start-Sleep -Milliseconds 50;[M]::mouse_event(${up},0,0,0,0);` : ''}`.replace(/\n/g, ' ');
    return sh(`powershell -Command "${ps}"`);
  }
  if (IS_MAC) {
    const r = await sh(`which cliclick 2>/dev/null`);
    if (r.ok && r.out.trim()) return sh(`cliclick ${dbl ? 'dc' : 'c'}:${x},${y}`);
    return sh(`osascript -e 'tell application "System Events" to ${dbl ? 'double click' : 'click'} at {${x},${y}}'`);
  }
  return sh(`xdotool mousemove ${x} ${y} ${dbl ? 'click --repeat 2' : 'click'} --button ${button === 'right' ? 3 : 1}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// KEYBOARD CONTROL
// ═══════════════════════════════════════════════════════════════════════════════

async function typeText(text, enter) {
  if (!text) return { ok: true, out: '' };
  if (IS_WIN) {
    const sk = text.replace(/\+/g, '{+}').replace(/\^/g, '{^}').replace(/%/g, '{%}').replace(/~/g, '{~}').replace(/[()[\]{}]/g, c => `{${c}}`);
    const ps = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait("${sk.replace(/"/g, '\\"')}");${enter ? '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}");' : ''}`;
    return sh(`powershell -Command "${ps}"`);
  }
  if (IS_MAC) {
    const s = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return sh(`osascript -e 'tell application "System Events" to keystroke "${s}"${enter ? "; keystroke return" : ""}'`);
  }
  return sh(`xdotool type "${text.replace(/"/g, '\\"')}"${enter ? ' && xdotool key Return' : ''}`);
}

async function pressKey(key) {
  const k = (key || '').toLowerCase().trim();
  if (IS_WIN) {
    const map = {
      'enter': '{ENTER}', 'escape': '{ESC}', 'esc': '{ESC}', 'tab': '{TAB}',
      'backspace': '{BACKSPACE}', 'delete': '{DELETE}', 'up': '{UP}', 'down': '{DOWN}',
      'left': '{LEFT}', 'right': '{RIGHT}', 'home': '{HOME}', 'end': '{END}',
      'pageup': '{PGUP}', 'pagedown': '{PGDN}', 'space': ' ',
      'f1': '{F1}', 'f2': '{F2}', 'f3': '{F3}', 'f4': '{F4}', 'f5': '{F5}',
      'f6': '{F6}', 'f7': '{F7}', 'f8': '{F8}', 'f9': '{F9}', 'f10': '{F10}',
      'f11': '{F11}', 'f12': '{F12}',
      'ctrl+c': '^c', 'ctrl+v': '^v', 'ctrl+x': '^x', 'ctrl+z': '^z',
      'ctrl+a': '^a', 'ctrl+s': '^s', 'ctrl+w': '^w', 'ctrl+t': '^t',
      'ctrl+r': '^r', 'ctrl+f': '^f', 'ctrl+n': '^n', 'ctrl+shift+esc': '^+{ESC}',
      'alt+f4': '%{F4}', 'alt+tab': '%{TAB}', 'win': '^{ESC}'
    };
    const mapped = map[k] || (k.length === 1 ? k : `{${k.toUpperCase()}}`);
    return sh(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${mapped.replace(/'/g, "\\'")}')"`, 5000);
  }
  if (IS_MAC) {
    if (k.includes('+')) {
      const p = k.split('+');
      const key2 = p[p.length - 1];
      const mods = p.slice(0, -1).map(m => m.replace('ctrl', 'command').replace('alt', 'option')).join(' down, ') + ' down';
      return sh(`osascript -e 'tell application "System Events" to keystroke "${key2}" using {${mods}}'`);
    }
    return sh(`osascript -e 'tell application "System Events" to keystroke "${k}"'`);
  }
  return sh(`xdotool key ${k}`);
}

async function scroll(dir, amount) {
  if (IS_WIN) {
    const d = dir === 'down' ? -(amount || 3) * 120 : (amount || 3) * 120;
    return sh(`powershell -Command "Add-Type @'
using System;using System.Runtime.InteropServices;
public class WA{[DllImport(\\"user32.dll\\")]public static extern void mouse_event(int f,int x,int y,int d,int i);}
'@;[WA]::mouse_event(0x0800,0,0,${d},0)"`);
  }
  if (IS_MAC) return sh(`osascript -e 'tell application "System Events" to key code ${dir === 'down' ? 125 : 126}'`);
  return sh(`xdotool click --repeat ${amount || 3} ${dir === 'down' ? 5 : 4}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function readFile(p) {
  try {
    const c = fs.readFileSync(p, 'utf8');
    return { ok: true, content: c.slice(0, 50000), size: c.length };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

async function writeFile(p, c) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c, 'utf8');
    return { ok: true, out: `Written: ${p}` };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

async function listDir(p) {
  try {
    const e = fs.readdirSync(p, { withFileTypes: true });
    return {
      ok: true,
      entries: e.slice(0, 300).map(e => ({
        name: e.name,
        isDir: e.isDirectory(),
        size: e.isFile() ? fs.statSync(path.join(p, e.name)).size : 0
      }))
    };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

async function searchFiles(dir, pat) {
  const cmd = IS_WIN
    ? `dir /s /b "${dir}\\*${pat}*" 2>nul`
    : `find "${dir}" -name "*${pat}*" -type f 2>/dev/null | head -50`;
  const r = await sh(cmd, 10000);
  return { ok: true, results: r.out.split('\n').filter(Boolean).slice(0, 50) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM INFO
// ═══════════════════════════════════════════════════════════════════════════════

async function getDetailedSysInfo() {
  const info = {
    platform: IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux',
    hostname: os.hostname(),
    user: os.userInfo().username,
    home: os.homedir(),
    ram_total: (os.totalmem() / 1e9).toFixed(1) + 'GB',
    ram_free: (os.freemem() / 1e9).toFixed(1) + 'GB',
    cpu: os.cpus()[0]?.model || '?',
    cores: os.cpus().length,
    time: new Date().toLocaleString(),
    cwd: process.cwd()
  };

  // Get active window
  try {
    if (IS_WIN) {
      const r = await sh(`powershell -Command "Get-Process|Where-Object{$_.MainWindowTitle -ne ''}|Select-Object -First 1 -ExpandProperty MainWindowTitle" 2>nul`, 3000);
      if (r.ok && r.out) info.active_window = r.out.trim();
    } else if (IS_MAC) {
      const r = await sh(`osascript -e 'tell app "System Events" to get name of first process whose frontmost is true' 2>/dev/null`, 3000);
      if (r.ok) info.active_window = r.out.trim();
    }
  } catch {}

  return info;
}

async function getRunningApps() {
  const cmd = IS_WIN
    ? `powershell -Command "Get-Process|Where-Object{$_.MainWindowTitle -ne ''}|Select-Object -First 20 Name,Id|Format-Table -AutoSize" 2>nul`
    : IS_MAC
      ? `osascript -e 'tell app "System Events" to get name of every process whose background only is false' 2>/dev/null`
      : `ps aux --sort=-%cpu|head -20`;
  const r = await sh(cmd, 5000);
  return r.ok ? r.out : '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// BROWSER AUTOMATION
// ═══════════════════════════════════════════════════════════════════════════════

async function browserNavigate(url) {
  try {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { ok: true, out: `Opened ${url} in default browser.`, action: 'browser_open', url };
  } catch (e) {
    return { ok: false, err: `Failed to open browser: ${e.message}` };
  }
}

async function browserSearch(query, engine = 'google') {
  const urls = {
    google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    duckduckgo: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
  };
  const url = urls[engine] || urls.google;
  try {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { ok: true, out: `Opened search for: ${query}`, action: 'browser_open', url };
  } catch (e) {
    return { ok: false, err: `Failed to open browser: ${e.message}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

const TOOL_DEFINITIONS = [
  // v0.0.3 — working-memory scratchpad (layer 12): per-task notes that survive reflection rounds.
  { name: 'scratch_write', desc: 'Save a key/value note for THIS task run (working memory). Survives reflection rounds; cleared at task end.', params: { key: 'string', value: 'string' } },
  { name: 'scratch_read', desc: 'Read a scratchpad note for THIS task run by key, or omit key to read all.', params: { key: 'string' } },
  { name: 'scratch_list', desc: 'List the keys stored in THIS task run\'s scratchpad.', params: {} },
  { name: 'run_code', desc: 'Run code on PC. language: python/powershell/javascript/shell/cmd', params: { code: 'string', language: 'string' } },
  { name: 'run_powershell', desc: 'Run PowerShell script on Windows', params: { code: 'string' } },
  { name: 'mouse_click', desc: 'Click mouse at screen coordinates', params: { x: 'number', y: 'number', button: 'left|right', double: 'boolean' } },
  { name: 'mouse_move', desc: 'Move mouse without clicking', params: { x: 'number', y: 'number' } },
  { name: 'type_text', desc: 'Type text into focused window', params: { text: 'string', enter: 'boolean' } },
  { name: 'press_key', desc: 'Press key or shortcut: enter, ctrl+c, ctrl+v, alt+tab, ctrl+s, f5', params: { key: 'string' } },
  { name: 'scroll', desc: 'Scroll mouse wheel up or down', params: { direction: 'up|down', amount: 'number 1-10' } },
  { name: 'browser_open', desc: 'Open URL in default browser', params: { url: 'string' } },
  { name: 'browser_search', desc: 'Search on Google/YouTube/Bing', params: { query: 'string', engine: 'google|youtube|bing' } },
  { name: 'read_file', desc: 'Read file content from disk', params: { path: 'string' } },
  { name: 'write_file', desc: 'Write/create file on disk', params: { path: 'string', content: 'string' } },
  { name: 'list_dir', desc: 'List directory contents', params: { path: 'string' } },
  { name: 'search_files', desc: 'Find files matching pattern', params: { dir: 'string', pattern: 'string' } },
  { name: 'get_system_info', desc: 'Get system info: CPU, RAM, active window', params: {} },
  { name: 'get_running_apps', desc: 'List currently running apps', params: {} },
  { name: 'shell_command', desc: 'Read-only shell cmd: dir/ls/ipconfig/ping/tasklist/systeminfo', params: { cmd: 'string' } },
  // Memory tools
  { name: 'remember', desc: 'Save something to long-term memory', params: { content: 'string', category: 'string', importance: 'number 1-10' } },
  { name: 'recall', desc: 'Search memories for relevant information', params: { query: 'string', limit: 'number' } },
  { name: 'set_fact', desc: 'Store a persistent fact about the user', params: { key: 'string', value: 'string' } },
  { name: 'get_facts', desc: 'Get all stored facts about the user', params: {} },
  // Nutrition tools
  { name: 'log_meal', desc: 'Log a meal with nutrition info', params: { description: 'string', calories: 'number', protein: 'number', carbs: 'number', fat: 'number' } },
  { name: 'get_nutrition', desc: 'Get today\'s nutrition summary', params: {} },
  // MCP tools
  { name: 'get_location', desc: 'Get user location (city, country, lat/lon) via IP', params: {} },
  { name: 'get_weather', desc: 'Get current weather for user location', params: {} },
  { name: 'web_search', desc: 'Search the web (DuckDuckGo)', params: { query: 'string' } },
  // Sprint-3 — `wikipedia` tool removed from agent surface. The mcpManager
  // IPC handlers (mcpWikipedia / mcpWikipediaSummary) still exist for the
  // renderer's command palette, but there was never a dispatcher case in
  // agent.js, so advertising it to the LLM produced phantom-tool
  // hallucinations. Use `web_search` for Wikipedia queries instead.
  { name: 'smart_click', desc: 'Click on a UI element by visual description (uses AI vision)', params: { target: 'string describing what to click' } },
  { name: 'open_site', desc: 'Open a website: google, youtube, gmail, github, etc', params: { name: 'string' } },
  { name: 'skill_run_helper', desc: 'Run a helper script bundled with a loaded skill. Use when a SKILL.md tells you to invoke one of its helpers.', params: { skill: 'string skill id', helper: 'string helper path (e.g. helpers/find-stale.js)', args: 'object passed as JSON on stdin', timeoutMs: 'number (default 30000)' } },
  { name: 'spawn_subagent', desc: 'Delegate a self-contained sub-task to an isolated sub-agent that runs in parallel-friendly mode (its own history, own steps, max 4 turns). Use for research / multi-source lookups / independent fact-finding before composing the final answer. Returns { ok, answer, steps }. Subagents cannot themselves spawn deeper subagents (depth cap = 2).', params: { task: 'string — concrete self-contained goal (e.g. "list 3 GitHub repos matching React testing")', tools: 'string[] optional — restrict the subagent to specific tool names', maxSteps: 'number optional (default 4)', timeoutMs: 'number optional (default 60000)' } },
  // ── Live Canvas (Phase 26 MVP) ─────────────────────────────────────
  // A shared editable surface the user and the agent both work on.
  // Read the current state, write append / prepend / replace updates.
  // Persisted at <userData>/horizon-canvas.json; user can also edit
  // through the /canvas surface in the renderer.
  { name: 'canvas_read',  desc: 'Read the current Live Canvas content. Returns { ok, content, version, updatedAt }. Use this before writing so you can patch around existing content rather than overwriting.', params: {} },
  { name: 'canvas_write', desc: 'Write to the Live Canvas (shared surface with the user). Modes: append (default, adds to end), prepend (top), replace (overwrite). The user sees your write live and can edit on top. Don\'t use replace unless the user asked to start over.', params: { content: 'string — what to write', mode: 'string optional — append | prepend | replace (default append)' } },
  // ── Self-knowledge tools (PHASE 28.5, Hermes-style progressive disclosure) ──
  // Let the agent introspect: what version am I, what tools/skills/personas/
  // channels do I have, what does my own persona prompt say. Useful when
  // user asks "what can you do" or the agent wants to verify a capability
  // before promising one. Cheap — all return cached metadata, no LLM call.
  { name: 'self_describe',            desc: '[Self] Returns a summary of this agent: version, active provider, active persona, memory layers (counts), executor mode, channel adapters that are configured. Use this when the user asks "who are you" or you need to verify your own state.', params: {} },
  { name: 'self_list_capabilities',   desc: '[Self] Returns the lightweight list of every tool, skill, persona, and connected channel currently available. Cheap, ~2-3 KB. Use this as the FIRST step when the user asks "what can you do" — then fetch full details with self_read_skill / self_read_tool only for the ones that matter.', params: {} },
  { name: 'self_read_skill',          desc: '[Self] Read the full SKILL.md for a specific installed skill. Use after self_list_capabilities when you want to actually understand how a skill works before invoking it.', params: { skill: 'string skill id (slug, e.g. "refactor-react")' } },
  { name: 'self_read_persona',        desc: '[Self] Read the full prompt + memories of a persona (the active one, or a specific id). Use to ground yourself in the voice you should be using, or to switch persona mid-task.', params: { id: 'string persona id optional (default = active)' } },
  { name: 'self_improve_skill',       desc: '[Self] Refine a user-scope or workspace-scope skill\'s SKILL.md based on what you just learned. Built-in skills are read-only. Each edit is logged. Use after finishing a task where the skill\'s instructions could be clearer or more accurate. Requires permission approval.', params: { skill: 'string skill id', updatedContent: 'string — full new SKILL.md text (YAML frontmatter + body)', rationale: 'string — one-line note on why this improves the skill' } }
];

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════════

let memoryInstance = null;

function setMemoryInstance(mem) {
  memoryInstance = mem;
}

// Exposed so the tool registry modules (./tools/memory.js, ./tools/self.js)
// can read the latest binding without holding a stale capture from import
// time. Returns null until setMemoryInstance() has been called.
function _getMemoryInstance() {
  return memoryInstance;
}

// ── Tool registry ──────────────────────────────────────────────────────────
// The 34-case switch that used to live here moved into per-category files
// under ./tools/. Each file self-registers via require() side-effect; the
// index module (./tools/index.js) loads them all and exports the registry.
//
// dispatchTool now just looks up the tool and runs it. Behaviour-preserving
// refactor — no execute() bodies changed, defaults preserved, error
// envelopes ({ ok: false, err: ... } vs throw) unchanged.
const toolRegistry = require('./tools');

async function dispatchTool(name, args = {}, ctx = {}) {
  const tool = toolRegistry.get(name);
  if (!tool) return { ok: false, err: `Unknown tool: ${name}` };
  try {
    return await tool.execute(args || {}, ctx || {});
  } catch (e) {
    return { ok: false, err: e?.message || String(e) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHAT STORE — multi-chat persistence (separate JSON sibling of AgentMemory)
// MVP scope: thread CRUD + auto-title from first user message + stable current_chat_id.
// Schema versioned; older clients upgrade by re-saving on first init.
// ═══════════════════════════════════════════════════════════════════════════════

const CHAT_STORE_MAX_CHATS = 200;
const CHAT_STORE_MAX_MESSAGES_PER_CHAT = 1000;
const CHAT_STORE_MAX_LOGS_PER_CHAT = 500;
const CHAT_STORE_TITLE_MAX = 80;
const CHAT_STORE_PREVIEW_MAX = 160;

class ChatStore {
  constructor(dbPath) {
    this.filePath = dbPath.replace(/\.db$/, '.json');
    this.ready = false;
    this._data = { version: 1, current_chat_id: null, chats: [] };
  }

  init() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this._data = {
          version: parsed.version || 1,
          current_chat_id: parsed.current_chat_id || null,
          chats: Array.isArray(parsed.chats) ? parsed.chats : [],
        };
      } else {
        this._save();
      }
      this.ready = true;
    } catch (e) {
      console.error('ChatStore init error:', e.message);
      this.ready = true;
    }
    return true;
  }

  _save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this._data, null, 2));
    } catch (e) {
      console.error('ChatStore save error:', e.message);
    }
  }

  _genId() {
    return 'chat_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  _findIndex(id) {
    return this._data.chats.findIndex(c => c.id === id);
  }

  _stripPreview(s) {
    return String(s || '').replace(/```[\s\S]*?```/g, '').replace(/[#*`>_~]/g, '').replace(/\s+/g, ' ').trim().slice(0, CHAT_STORE_PREVIEW_MAX);
  }

  _cleanLogLine(line) {
    const item = line && typeof line === 'object' ? line : { msg: line };
    return {
      time: String(item.time || '').slice(0, 80),
      type: String(item.type || 'info').slice(0, 32),
      msg: String(item.msg || '').slice(0, 8000),
    };
  }

  _summary(chat) {
    return {
      id: chat.id,
      title: chat.title || '',
      created_at: chat.created_at,
      updated_at: chat.updated_at,
      message_count: (chat.messages || []).length,
      preview: chat.preview || '',
    };
  }

  _trimChats() {
    if (this._data.chats.length > CHAT_STORE_MAX_CHATS) {
      this._data.chats.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
      this._data.chats = this._data.chats.slice(0, CHAT_STORE_MAX_CHATS);
    }
  }

  list() {
    return [...this._data.chats]
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .map(c => this._summary(c));
  }

  get(id) {
    const i = this._findIndex(id);
    if (i < 0) return null;
    return JSON.parse(JSON.stringify(this._data.chats[i]));
  }

  create(opts) {
    if (!this.ready) return null;
    opts = opts || {};
    const now = new Date().toISOString();
    const chat = {
      id: this._genId(),
      title: (opts.title || '').slice(0, CHAT_STORE_TITLE_MAX),
      created_at: now,
      updated_at: now,
      message_count: 0,
      preview: '',
      messages: [],
      logs: [],
    };
    this._data.chats.push(chat);
    if (opts.switch !== false) this._data.current_chat_id = chat.id;
    this._trimChats();
    this._save();
    return JSON.parse(JSON.stringify(chat));
  }

  switchTo(id) {
    const i = this._findIndex(id);
    if (i < 0) return null;
    this._data.current_chat_id = id;
    this._save();
    return JSON.parse(JSON.stringify(this._data.chats[i]));
  }

  rename(id, title) {
    const i = this._findIndex(id);
    if (i < 0) return false;
    this._data.chats[i].title = String(title || '').slice(0, CHAT_STORE_TITLE_MAX);
    this._data.chats[i].updated_at = new Date().toISOString();
    this._save();
    return true;
  }

  remove(id) {
    const i = this._findIndex(id);
    if (i < 0) return { ok: false };
    this._data.chats.splice(i, 1);
    let next_current_id = null;
    if (this._data.current_chat_id === id) {
      if (this._data.chats.length > 0) {
        const sorted = [...this._data.chats].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
        next_current_id = sorted[0].id;
        this._data.current_chat_id = next_current_id;
      } else {
        this._data.current_chat_id = null;
      }
    }
    this._save();
    return { ok: true, next_current_id };
  }

  addMessage(id, role, content, meta) {
    const i = this._findIndex(id);
    if (i < 0) return { ok: false, error: 'chat not found' };
    const chat = this._data.chats[i];
    const now = new Date().toISOString();
    const text = String(content || '');
    const msg = { role: role === 'assistant' ? 'assistant' : 'user', content: text, ts: now, meta: meta || {} };
    chat.messages = chat.messages || [];
    chat.messages.push(msg);
    if (chat.messages.length > CHAT_STORE_MAX_MESSAGES_PER_CHAT) {
      chat.messages = chat.messages.slice(-CHAT_STORE_MAX_MESSAGES_PER_CHAT);
    }
    chat.message_count = chat.messages.length;
    chat.updated_at = now;
    chat.preview = this._stripPreview(text);
    if (msg.role === 'user' && (!chat.title || /^untitled/i.test(chat.title))) {
      chat.title = this._stripPreview(text).slice(0, 50);
    }
    this._save();
    return { ok: true, message_count: chat.message_count, title: chat.title };
  }

  getLogs(id) {
    const i = this._findIndex(id);
    if (i < 0) return { ok: false, logs: [], error: 'chat not found' };
    const chat = this._data.chats[i];
    const logs = Array.isArray(chat.logs) ? chat.logs : [];
    return { ok: true, logs: JSON.parse(JSON.stringify(logs.slice(-CHAT_STORE_MAX_LOGS_PER_CHAT))) };
  }

  setLogs(id, logs) {
    const i = this._findIndex(id);
    if (i < 0) return { ok: false, error: 'chat not found' };
    const clean = Array.isArray(logs)
      ? logs.map(line => this._cleanLogLine(line)).slice(-CHAT_STORE_MAX_LOGS_PER_CHAT)
      : [];
    this._data.chats[i].logs = clean;
    this._save();
    return { ok: true, count: clean.length };
  }

  clearLogs(id) {
    const i = this._findIndex(id);
    if (i < 0) return { ok: false, error: 'chat not found' };
    this._data.chats[i].logs = [];
    this._save();
    return { ok: true };
  }

  getCurrent() {
    if (!this._data.current_chat_id) {
      return this.create({});
    }
    const found = this.get(this._data.current_chat_id);
    if (found) return found;
    if (this._data.chats.length > 0) {
      const sorted = [...this._data.chats].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
      this._data.current_chat_id = sorted[0].id;
      this._save();
      return this.get(this._data.current_chat_id);
    }
    return this.create({});
  }
}

module.exports = {
  AgentMemory,
  ChatStore,
  MEMORY_SOURCES,
  DEFAULT_USER_PROFILE,
  dispatchTool,
  setMemoryInstance,
  _getMemoryInstance,
  executeCode,
  mouseMove,
  mouseClick,
  typeText,
  pressKey,
  scroll,
  readFile,
  writeFile,
  listDir,
  searchFiles,
  getDetailedSysInfo,
  getRunningApps,
  browserNavigate,
  browserSearch,
  runSkillHelper,
  sh,
  TOOL_DEFINITIONS,
  toolRegistry,
};
