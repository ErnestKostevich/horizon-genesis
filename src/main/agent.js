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

class AgentMemory {
  constructor(dbPath) {
    this.filePath = dbPath.replace(/\.db$/, '.json');
    this.ready = false;
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
    } catch (e) {
      console.error('Memory init error:', e.message);
      this.ready = true;
    }
    return true;
  }

  _save() {
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
  remember(content, category, importance, source) {
    if (!this.ready || !content) return null;
    this._ensureShape();
    const normalized = this._normalizeText(content);
    if (!normalized) return null;
    const key = this._memoryKey(normalized, category || 'general');
    const tag = String(source || MEMORY_SOURCES.TOOL);
    const existing = this._data.memories.find(m => m.key === key);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.seen = (existing.seen || 1) + 1;
      existing.importance = Math.max(existing.importance || 5, importance || 5);
      // Track the most recent source we observed this memory from. Useful
      // for the UI ("seen 3 times — last from telegram").
      if (tag) existing.lastSource = tag;
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
    };
    this._data.memories.push(item);
    // Limit to last 2000 memories
    if (this._data.memories.length > 2000) {
      const dropped = this._data.memories.splice(0, this._data.memories.length - 2000);
      // Drop their embeddings too — sidecar would otherwise hold orphans.
      if (this.embeddings) {
        for (const m of dropped) this.embeddings.removeVector(m.key);
        try { this.embeddings.saveSidecar(); } catch (_) {}
      }
    }
    this._save();
    // Fire-and-forget: index the new memory in the background.
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
    return true;
  }

  // ── Memory provenance helpers ────────────────────────────────────────
  forgetFact(key) {
    if (!this.ready) return false;
    this._ensureShape();
    const safeKey = this._normalizeText(key, 120);
    if (!safeKey || !(safeKey in this._data.facts)) return false;
    delete this._data.facts[safeKey];
    this._save();
    return true;
  }

  forgetMemory(idOrKey) {
    if (!this.ready) return false;
    this._ensureShape();
    const target = String(idOrKey || '');
    const before = this._data.memories.length;
    this._data.memories = this._data.memories.filter(m => String(m.id) !== target && m.key !== target);
    const removed = before - this._data.memories.length;
    if (removed > 0 && this.embeddings) {
      // Also drop sidecar embeddings for the forgotten memory(s).
      try {
        for (const key of [target]) this.embeddings.removeVector(key);
        this.embeddings.saveSidecar();
      } catch (_) {}
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

    const semWeight = typeof opts.semanticWeight === 'number' ? opts.semanticWeight : 0.6;
    const kwWeight = 1 - semWeight;
    const kw = this._keywordScore(q);
    // Normalise keyword scores to [0,1] for blending. Empirically a kwScore
    // above ~18 is "strong match" (importance up to 10 + matches × 4 + ...).
    const kwMax = Math.max(1, ...kw.map(m => m.kwScore || 0));
    const blended = kw.map(m => {
      const vec = this.embeddings.index.get(m.key);
      const sem = vec ? Math.max(0, require('./embeddings').cosine(queryVec, vec)) : 0;
      const kwNorm = (m.kwScore || 0) / kwMax;
      const score = (semWeight * sem) + (kwWeight * kwNorm);
      return { ...m, semantic: Number(sem.toFixed(4)), kw: Number(kwNorm.toFixed(4)), score: Number(score.toFixed(4)) };
    });
    // Require some signal — either decent semantic overlap (≥0.18, the
    // empirical "vaguely related" floor for small-256 embeddings) or any
    // keyword match. Avoids dumping unrelated memories at low cutoffs.
    return blended
      .filter(m => m.semantic >= 0.18 || m.matches > 0)
      .sort((a, b) => (b.score - a.score) || (b.importance - a.importance) || (b.created - a.created))
      .slice(0, lim);
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

    this.saveConversation(user, assistant || '', {
      provider: meta.provider,
      model: meta.model,
      persona: meta.persona,
      runId: meta.runId,
      learned: learned.length
    });

    const stats = this._data.learning.stats;
    stats.turns = (stats.turns || 0) + 1;
    stats.learnedItems = (stats.learnedItems || 0) + learned.length;
    stats.lastTurnAt = stamp;
    this._save();
    return { ok: true, learned: learned.length, items: learned };
  }

  // ═══ NUTRITION TRACKING (from jarvis) ═══
  logMeal(description, calories, protein, carbs, fat, time = null) {
    if (!this.ready) return false;
    this._data.meals.push({
      id: Date.now(),
      description,
      calories: calories || 0,
      protein: protein || 0,
      carbs: carbs || 0,
      fat: fat || 0,
      time: time || new Date().toISOString()
    });
    // Keep last 1000 meals
    if (this._data.meals.length > 1000) {
      this._data.meals = this._data.meals.slice(-1000);
    }
    this._save();
    return true;
  }

  getMeals(days = 7) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    return this._data.meals.filter(m => new Date(m.time).getTime() > cutoff);
  }

  getTodayNutrition() {
    const today = new Date().toISOString().split('T')[0];
    const todayMeals = this._data.meals.filter(m => m.time.startsWith(today));
    return {
      meals: todayMeals,
      total: {
        calories: todayMeals.reduce((s, m) => s + (m.calories || 0), 0),
        protein: todayMeals.reduce((s, m) => s + (m.protein || 0), 0),
        carbs: todayMeals.reduce((s, m) => s + (m.carbs || 0), 0),
        fat: todayMeals.reduce((s, m) => s + (m.fat || 0), 0)
      }
    };
  }

  // ═══ CONVERSATION MEMORY ═══
  saveConversation(userMessage, assistantReply, meta = {}) {
    if (!this.ready) return;
    this._ensureShape();
    const safeMeta = meta && typeof meta === 'object' ? meta : {};
    this._data.conversations.push({
      id: Date.now(),
      user: this._normalizeText(userMessage, 1600),
      assistant: this._normalizeText(assistantReply, 1600),
      meta: safeMeta,
      source: safeMeta.source || MEMORY_SOURCES.CHAT,
      time: new Date().toISOString()
    });
    // Keep last 500 conversations
    if (this._data.conversations.length > 500) {
      this._data.conversations = this._data.conversations.slice(-500);
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
  { name: 'wikipedia', desc: 'Search Wikipedia', params: { query: 'string' } },
  { name: 'smart_click', desc: 'Click on a UI element by visual description (uses AI vision)', params: { target: 'string describing what to click' } },
  { name: 'open_site', desc: 'Open a website: google, youtube, gmail, github, etc', params: { name: 'string' } },
  { name: 'skill_run_helper', desc: 'Run a helper script bundled with a loaded skill. Use when a SKILL.md tells you to invoke one of its helpers.', params: { skill: 'string skill id', helper: 'string helper path (e.g. helpers/find-stale.js)', args: 'object passed as JSON on stdin', timeoutMs: 'number (default 30000)' } },
  { name: 'spawn_subagent', desc: 'Delegate a self-contained sub-task to an isolated sub-agent that runs in parallel-friendly mode (its own history, own steps, max 4 turns). Use for research / multi-source lookups / independent fact-finding before composing the final answer. Returns { ok, answer, steps }. Subagents cannot themselves spawn deeper subagents (depth cap = 2).', params: { task: 'string — concrete self-contained goal (e.g. "list 3 GitHub repos matching React testing")', tools: 'string[] optional — restrict the subagent to specific tool names', maxSteps: 'number optional (default 4)', timeoutMs: 'number optional (default 60000)' } }
];

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════════

let memoryInstance = null;

function setMemoryInstance(mem) {
  memoryInstance = mem;
}

async function dispatchTool(name, args = {}, ctx = {}) {
  switch (name) {
    case 'run_code':
      return executeCode(args.code, args.language);
    case 'run_powershell':
      return executeCode(args.code, 'powershell');
    case 'run_javascript':
      return executeCode(args.code, 'javascript');
    case 'run_shell':
      return executeCode(args.code, 'shell');
    case 'read_file':
      return readFile(args.path);
    case 'write_file':
      return writeFile(args.path, args.content);
    case 'list_dir':
      return listDir(args.path || os.homedir());
    case 'search_files':
      return searchFiles(args.dir || os.homedir(), args.pattern || '');
    case 'mouse_move':
      return mouseMove(args.x, args.y);
    case 'mouse_click':
      return mouseClick(args.x, args.y, args.button || 'left', args.double || false);
    case 'type_text':
      return typeText(args.text || '', args.enter || false);
    case 'press_key':
      return pressKey(args.key);
    case 'scroll':
      return scroll(args.direction || 'down', args.amount || 3);
    case 'browser_open':
      return browserNavigate(args.url);
    case 'browser_search':
      return browserSearch(args.query, args.engine);
    case 'open_site':
      const sites = {
        'youtube': 'https://youtube.com',
        'google': 'https://google.com',
        'gmail': 'https://mail.google.com',
        'github': 'https://github.com'
      };
      const siteUrl = sites[(args.name || '').toLowerCase()] || `https://${args.name}.com`;
      return browserNavigate(siteUrl);
    case 'get_system_info':
      return getDetailedSysInfo();
    case 'get_running_apps':
      return { ok: true, out: await getRunningApps() };
    case 'shell_command': {
      const safe = /^(dir|ls|echo|date|time|whoami|hostname|ipconfig|ifconfig|pwd|cat\s|type\s|find\s|grep\s|ping\s|df |du |free |netstat|systeminfo|tasklist|ps |ver|uname|where|which)/i;
      if (!safe.test((args.cmd || '').trim())) {
        return { ok: false, out: '', err: 'Only read-only commands allowed. Use run_code for scripts.' };
      }
      return sh(args.cmd, 8000);
    }
    // Memory tools
    case 'remember':
      if (memoryInstance) {
        memoryInstance.remember(args.content, args.category, args.importance, 'tool');
        return { ok: true, out: 'Remembered.' };
      }
      return { ok: false, err: 'Memory not initialized' };
    case 'recall':
      if (memoryInstance) {
        const results = memoryInstance.recall(args.query, args.limit);
        return { ok: true, out: JSON.stringify(results, null, 2), results };
      }
      return { ok: false, err: 'Memory not initialized' };
    case 'set_fact':
      if (memoryInstance) {
        memoryInstance.setFact(args.key, args.value, 'tool');
        return { ok: true, out: `Fact saved: ${args.key}` };
      }
      return { ok: false, err: 'Memory not initialized' };
    case 'get_facts':
      if (memoryInstance) {
        const facts = memoryInstance.getAllFacts();
        return { ok: true, out: JSON.stringify(facts, null, 2), facts };
      }
      return { ok: false, err: 'Memory not initialized' };
    // Nutrition tools
    case 'log_meal':
      if (memoryInstance) {
        memoryInstance.logMeal(args.description, args.calories, args.protein, args.carbs, args.fat);
        return { ok: true, out: `Meal logged: ${args.description}` };
      }
      return { ok: false, err: 'Memory not initialized' };
    case 'get_nutrition':
      if (memoryInstance) {
        const nutrition = memoryInstance.getTodayNutrition();
        return { ok: true, out: JSON.stringify(nutrition, null, 2), nutrition };
      }
      return { ok: false, err: 'Memory not initialized' };
    case 'skill_run_helper':
      return runSkillHelper(args.skill, args.helper, args.args, args.timeoutMs);
    case 'spawn_subagent': {
      // Delegated to main.js so the subagent reuses the parent's aiFn /
      // sysInfo / persona / event-bridge without us re-implementing them
      // here. Lazy require.cache lookup keeps agent.js standalone for
      // tests.
      try {
        const mainMod = require.cache[require.resolve('./main')];
        const spawn = mainMod?.exports?.spawnSubagent;
        if (typeof spawn !== 'function') return { ok: false, err: 'subagent runtime not initialised' };
        return await spawn({
          task: String(args.task || '').trim(),
          parentRunId: ctx.runId || null,
          event: ctx.event || null,
          allowedTools: Array.isArray(args.tools) ? args.tools : null,
          maxSteps: Number(args.maxSteps) || undefined,
          timeoutMs: Number(args.timeoutMs) || undefined,
        });
      } catch (e) {
        return { ok: false, err: 'spawn_subagent failed: ' + e.message };
      }
    }
    default:
      return { ok: false, err: `Unknown tool: ${name}` };
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
  TOOL_DEFINITIONS
};
