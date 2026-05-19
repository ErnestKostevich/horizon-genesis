'use strict';
/**
 * Horizon Memory DB — SQLite + FTS5 hybrid backend (PHASE 28).
 *
 * Sits alongside the JSON file + in-memory InvertedIndex (memoryFts.js)
 * and the embeddings sidecar. Use it when:
 *   - the memory file is approaching the 2000-entry cap and FTS rebuilds
 *     on every boot start to add up;
 *   - you want phrase / prefix / proximity queries that the pure-JS
 *     InvertedIndex can't do;
 *   - a workspace shares its memory across tools that all speak SQL.
 *
 * The shape mirrors the JSON file so a migration is cheap (see
 * src/main/runtime/migrateJsonToSqlite.js). Embeddings stay in the
 * existing JSON sidecar — large float32[] arrays are awful in SQL and
 * sqlite-vec is still a moving target on Electron.
 *
 *   memories                facts                  conversations
 *   ---------               -----                  -------------
 *   id (text PK)            key (text PK)          id (text PK)
 *   content (text)          value (text)           user (text)
 *   category (text)         updated_at (int)       assistant (text)
 *   importance (int)        source (text)          source (text)
 *   created_at (int)                               persona_id (text)
 *   last_seen (int)                                created_at (int)
 *   seen (int)
 *   source (text)
 *   persona_id (text)
 *
 *   memories_fts (fts5)     facts_fts (fts5)       conversations_fts (fts5)
 *   ────────────────        ───────────────        ──────────────────────
 *   content                 key, value             user, assistant
 *
 * better-sqlite3 is loaded with require-or-skip — if the user is on an
 * Electron build where the native binding didn't rebuild, the class
 * throws a clear error from open() and the caller falls back to the
 * JSON path.
 */

const fs = require('fs');
const path = require('path');

let _sqlite = null;
let _sqliteLoadError = null;
function loadSqlite() {
  if (_sqlite) return _sqlite;
  if (_sqliteLoadError) throw _sqliteLoadError;
  try {
    _sqlite = require('better-sqlite3');
    return _sqlite;
  } catch (e) {
    _sqliteLoadError = new Error(
      `better-sqlite3 unavailable (${e.message}). ` +
      `Run "npm run rebuild:native" or fall back to the JSON memory backend.`
    );
    throw _sqliteLoadError;
  }
}

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  category    TEXT,
  importance  INTEGER DEFAULT 5,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  seen        INTEGER DEFAULT 1,
  source      TEXT,
  persona_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_category   ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_persona    ON memories(persona_id);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);

CREATE TABLE IF NOT EXISTS facts (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  source     TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  user        TEXT,
  assistant   TEXT,
  source      TEXT,
  persona_id  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_created_at ON conversations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_persona    ON conversations(persona_id);

-- FTS5 virtual tables. Using "content=" external-content mode so the
-- FTS rows stay in lockstep with the base tables and we don't double
-- the storage. tokenize=porter unicode61 handles English + Cyrillic.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 1'
);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  key, value,
  content='facts',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 1'
);

CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
  user, assistant,
  content='conversations',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 1'
);

-- Sync triggers — keep FTS rows aligned with base table changes.
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, key, value) VALUES('delete', old.rowid, old.key, old.value);
END;
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, key, value) VALUES('delete', old.rowid, old.key, old.value);
  INSERT INTO facts_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
END;

CREATE TRIGGER IF NOT EXISTS conv_ai AFTER INSERT ON conversations BEGIN
  INSERT INTO conversations_fts(rowid, user, assistant) VALUES (new.rowid, new.user, new.assistant);
END;
CREATE TRIGGER IF NOT EXISTS conv_ad AFTER DELETE ON conversations BEGIN
  INSERT INTO conversations_fts(conversations_fts, rowid, user, assistant) VALUES('delete', old.rowid, old.user, old.assistant);
END;
CREATE TRIGGER IF NOT EXISTS conv_au AFTER UPDATE ON conversations BEGIN
  INSERT INTO conversations_fts(conversations_fts, rowid, user, assistant) VALUES('delete', old.rowid, old.user, old.assistant);
  INSERT INTO conversations_fts(rowid, user, assistant) VALUES (new.rowid, new.user, new.assistant);
END;
`;

class MemoryDb {
  constructor(dbPath) {
    if (!dbPath) throw new Error('dbPath required');
    this.dbPath = dbPath;
    this.db = null;
  }

  open() {
    if (this.db) return this;
    const Sqlite = loadSqlite();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Sqlite(this.dbPath);
    this.db.exec(SCHEMA_SQL);
    const cur = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    if (!cur) {
      this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('schema_version', String(SCHEMA_VERSION));
    }
    return this;
  }

  close() {
    if (this.db) { try { this.db.close(); } catch (_) {} this.db = null; }
  }

  // ── memories ────────────────────────────────────────────────────────
  addMemory({ id, content, category, importance, source, personaId, createdAt }) {
    if (!id || !content) return null;
    const now = Date.now();
    const row = this.db.prepare('SELECT seen FROM memories WHERE id = ?').get(id);
    if (row) {
      this.db.prepare(`
        UPDATE memories
           SET content = ?, importance = MAX(importance, ?),
               last_seen = ?, seen = seen + 1,
               source = COALESCE(?, source),
               persona_id = COALESCE(?, persona_id)
         WHERE id = ?
      `).run(content, importance || 5, now, source || null, personaId || null, id);
      return { id, updated: true };
    }
    this.db.prepare(`
      INSERT INTO memories(id, content, category, importance, created_at, last_seen, seen, source, persona_id)
      VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, content, category || 'general', importance || 5, createdAt || now, now, source || null, personaId || null);
    return { id, inserted: true };
  }

  removeMemory(id) {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  getMemoriesByCategory(category, limit = 50) {
    return this.db.prepare(`
      SELECT * FROM memories
       WHERE category = ?
       ORDER BY importance DESC, last_seen DESC, created_at DESC
       LIMIT ?
    `).all(category, limit);
  }

  listMemories({ limit = 200, offset = 0 } = {}) {
    return this.db.prepare(`
      SELECT * FROM memories
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  // ── facts ───────────────────────────────────────────────────────────
  setFact(key, value, source) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO facts(key, value, updated_at, source) VALUES(?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                       updated_at = excluded.updated_at,
                                       source = COALESCE(excluded.source, facts.source)
    `).run(key, String(value), now, source || null);
  }

  getFact(key) {
    const r = this.db.prepare('SELECT * FROM facts WHERE key = ?').get(key);
    return r ? r.value : null;
  }

  allFacts() {
    return this.db.prepare('SELECT * FROM facts ORDER BY updated_at DESC').all();
  }

  // ── conversations ───────────────────────────────────────────────────
  addConversation({ id, user, assistant, source, personaId, createdAt }) {
    const now = createdAt || Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO conversations(id, user, assistant, source, persona_id, created_at)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(id, user || '', assistant || '', source || null, personaId || null, now);
    return { id, createdAt: now };
  }

  recentConversations(limit = 50) {
    return this.db.prepare(`
      SELECT * FROM conversations ORDER BY created_at DESC LIMIT ?
    `).all(limit);
  }

  // ── FTS5 search ─────────────────────────────────────────────────────
  /**
   * Full-text search across memories. Returns ranked results using the
   * FTS5 bm25 scorer. `query` should already be a valid FTS5 match
   * expression — for safety call sanitizeMatch() on free-form user
   * input first.
   */
  searchMemories(query, limit = 20) {
    const safe = sanitizeMatch(query);
    if (!safe) return [];
    return this.db.prepare(`
      SELECT m.*, bm25(memories_fts) AS score
        FROM memories_fts
        JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ?
       ORDER BY score
       LIMIT ?
    `).all(safe, limit);
  }

  searchFacts(query, limit = 20) {
    const safe = sanitizeMatch(query);
    if (!safe) return [];
    return this.db.prepare(`
      SELECT f.*, bm25(facts_fts) AS score
        FROM facts_fts
        JOIN facts f ON f.rowid = facts_fts.rowid
       WHERE facts_fts MATCH ?
       ORDER BY score
       LIMIT ?
    `).all(safe, limit);
  }

  searchConversations(query, limit = 20) {
    const safe = sanitizeMatch(query);
    if (!safe) return [];
    return this.db.prepare(`
      SELECT c.*, bm25(conversations_fts) AS score
        FROM conversations_fts
        JOIN conversations c ON c.rowid = conversations_fts.rowid
       WHERE conversations_fts MATCH ?
       ORDER BY score
       LIMIT ?
    `).all(safe, limit);
  }

  /**
   * Cross-table search — used by agent.semanticRecall as the lexical
   * leg of a hybrid query. Returns the top N rows from each pool with
   * a `_type` tag so the caller can rank/dedupe.
   */
  searchAll(query, limit = 20) {
    return [
      ...this.searchMemories(query, limit).map(r => ({ ...r, _type: 'memory' })),
      ...this.searchFacts(query, limit).map(r => ({ ...r, _type: 'fact' })),
      ...this.searchConversations(query, limit).map(r => ({ ...r, _type: 'conversation' })),
    ].sort((a, b) => (a.score || 0) - (b.score || 0));
  }

  // ── housekeeping ────────────────────────────────────────────────────
  stats() {
    const mem = this.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
    const facts = this.db.prepare('SELECT COUNT(*) AS n FROM facts').get().n;
    const conv = this.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
    return { memories: mem, facts, conversations: conv, schema: SCHEMA_VERSION };
  }

  /** Bulk import from a JSON-shaped object — used by the migration helper. */
  importFromJson(data) {
    const tx = this.db.transaction((d) => {
      for (const m of (d.memories || [])) {
        const id = m.key || m.id;
        if (!id || !m.content) continue;
        this.addMemory({
          id,
          content: m.content,
          category: m.category,
          importance: m.importance,
          source: m.source || m.lastSource,
          personaId: m.personaId,
          createdAt: m.firstSeen || m.lastSeen || Date.now(),
        });
      }
      for (const [k, v] of Object.entries(d.facts || {})) {
        const value = (v && typeof v === 'object') ? v.value : v;
        if (value == null) continue;
        this.setFact(k, value, (v && typeof v === 'object') ? v.source : null);
      }
      for (const c of (d.conversations || [])) {
        if (!c.id) continue;
        this.addConversation({
          id: String(c.id),
          user: c.user,
          assistant: c.assistant,
          source: c.source,
          personaId: c.personaId,
          createdAt: c.ts || c.createdAt,
        });
      }
    });
    tx(data);
    return this.stats();
  }
}

/**
 * Make a free-form user query safe for an FTS5 MATCH clause.
 * Strips quotes, parens, and `*`/`^`/`:` operators that could break
 * the parser, then joins remaining tokens with AND. Returns empty
 * string for queries that have no usable tokens — caller should treat
 * that as "no results".
 */
function sanitizeMatch(query) {
  if (!query) return '';
  const tokens = String(query)
    .replace(/["()*^:]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t && t.length >= 2);
  if (!tokens.length) return '';
  // Prefix-match each term so partial words still hit ("horiz" → "horizon").
  return tokens.map(t => `${t}*`).join(' AND ');
}

module.exports = { MemoryDb, sanitizeMatch, SCHEMA_VERSION };
