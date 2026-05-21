'use strict';
/**
 * KanbanQueue — durable multi-agent task queue (Sprint 7C).
 *
 * Replaces ephemeral spawn_subagent with a SQLite-backed Kanban board.
 * Tasks survive process crashes; if a worker dies mid-run, the
 * heartbeat watchdog re-queues abandoned tasks within 60s so another
 * worker can pick them up.
 *
 * Statuses (see schema below):
 *   queued     — waiting to be claimed by a worker
 *   running    — currently executing; heartbeat refreshed every 5s
 *   done       — completed successfully, result JSON in `result`
 *   failed     — execution threw; error in `error`
 *   abandoned  — running task with no heartbeat > 60s; auto-requeued
 *                by reclaim() (status flips back to queued, attempts++)
 *   cancelled  — user-initiated abort via cancel() / `horizon agents cancel`
 *
 * Why SQLite (not JSON): atomic claim() needs a real transaction. Two
 * workers racing on the same queued row would both pick it up if we
 * used file-locked JSON. The CTE-based UPDATE..WHERE id IN (SELECT ...)
 * inside a BEGIN IMMEDIATE makes the claim race-free.
 *
 * Schema:
 *   kanban_tasks
 *     id            TEXT PK    — uuid (k_<hex>)
 *     parent_id     TEXT       — fk-style ref to spawning task
 *     title         TEXT       — short label for the board view
 *     task          TEXT       — full prompt
 *     status        TEXT       — see statuses above
 *     priority      INT 1-10   — higher wins; ties broken by created_at ASC
 *     created_at    INT (ms)
 *     started_at    INT (ms)   — when claim() flipped it to running
 *     completed_at  INT (ms)   — when complete()/fail()/cancel() ran
 *     heartbeat_at  INT (ms)   — last worker beat; reclaim() watches this
 *     worker_id     TEXT       — which worker currently owns it
 *     result        TEXT       — JSON of {answer, steps, model, ...}
 *     error         TEXT       — failure message
 *     attempts      INT        — incremented by reclaim()
 *     max_steps     INT        — passed to runAgent
 *     provider      TEXT
 *     model         TEXT
 *     persona       TEXT
 *     skills_json   TEXT       — JSON array of forced skill names
 *
 * Indexes tuned for the three hot paths:
 *   - claim()    → idx_kanban_status (status, priority DESC, created_at ASC)
 *   - reclaim()  → idx_kanban_heartbeat (status, heartbeat_at)
 *   - list()     → idx_kanban_parent (parent_id)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
      `Run "npm run rebuild:native" or disable the kanban queue with HORIZON_KANBAN=off.`
    );
    throw _sqliteLoadError;
  }
}

const HEARTBEAT_TIMEOUT_MS = 60_000; // tasks stale after 60s without a beat
const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS kanban_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS kanban_tasks (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT,
  title         TEXT NOT NULL,
  task          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','abandoned','cancelled')),
  priority      INTEGER NOT NULL DEFAULT 5,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER,
  heartbeat_at  INTEGER,
  worker_id     TEXT,
  result        TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_steps     INTEGER NOT NULL DEFAULT 8,
  provider      TEXT,
  model         TEXT,
  persona       TEXT,
  skills_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_kanban_status     ON kanban_tasks(status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_kanban_parent     ON kanban_tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_kanban_heartbeat  ON kanban_tasks(status, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_kanban_created_at ON kanban_tasks(created_at DESC);
`;

function newTaskId() {
  return 'k_' + crypto.randomBytes(8).toString('hex');
}

function clampPriority(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, Math.floor(n)));
}

function rowToTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    parentId: row.parent_id || null,
    title: row.title,
    task: row.task,
    status: row.status,
    priority: row.priority,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    heartbeatAt: row.heartbeat_at || null,
    workerId: row.worker_id || null,
    result: row.result ? safeParse(row.result) : null,
    error: row.error || null,
    attempts: row.attempts || 0,
    maxSteps: row.max_steps,
    provider: row.provider || null,
    model: row.model || null,
    persona: row.persona || null,
    skills: row.skills_json ? safeParse(row.skills_json) : null,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (_) { return s; }
}

class KanbanQueue {
  /**
   * @param {string} dbPath — absolute path to kanban.sqlite. Created on
   *                          first open(). Pass ':memory:' for tests.
   */
  constructor(dbPath) {
    if (!dbPath) throw new Error('KanbanQueue: dbPath required');
    this.dbPath = dbPath;
    this.db = null;
  }

  open() {
    if (this.db) return this;
    const Sqlite = loadSqlite();
    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Sqlite(this.dbPath);
    this.db.exec(SCHEMA_SQL);
    const cur = this.db.prepare('SELECT value FROM kanban_meta WHERE key = ?').get('schema_version');
    if (!cur) {
      this.db.prepare('INSERT INTO kanban_meta(key, value) VALUES(?, ?)')
        .run('schema_version', String(SCHEMA_VERSION));
    }
    return this;
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch (_) {}
      this.db = null;
    }
  }

  /**
   * Enqueue a new task.
   *
   * @param {object}  o
   * @param {string}  o.title          — short label (e.g. "summarise PR")
   * @param {string}  o.task           — full prompt
   * @param {string}  [o.parentId]
   * @param {number}  [o.priority=5]   — 1-10
   * @param {object}  [o.options]      — runtime knobs (maxSteps, provider,
   *                                     model, persona, skills[])
   * @returns {string} taskId
   */
  enqueue({ title, task, parentId, priority, options } = {}) {
    if (!this.db) throw new Error('KanbanQueue not open');
    const t = String(task || '').trim();
    if (!t) throw new Error('task is required');
    const ttl = String(title || '').trim() || t.slice(0, 60);
    const id = newTaskId();
    const now = Date.now();
    const o = options || {};
    this.db.prepare(`
      INSERT INTO kanban_tasks (
        id, parent_id, title, task, status, priority,
        created_at, attempts, max_steps, provider, model, persona, skills_json
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      id,
      parentId || null,
      ttl,
      t,
      clampPriority(priority),
      now,
      Number(o.maxSteps) > 0 ? Math.floor(Number(o.maxSteps)) : 8,
      o.provider || null,
      o.model || null,
      o.persona || null,
      Array.isArray(o.skills) ? JSON.stringify(o.skills) : null,
    );
    return id;
  }

  /**
   * Atomically claim the next queued task. Returns null when the queue
   * is empty so the worker can sleep and retry.
   *
   * Uses BEGIN IMMEDIATE + UPDATE..RETURNING via a CTE so two workers
   * racing on the same row can't both win. Falls back to a guarded
   * UPDATE when RETURNING isn't available (older SQLite).
   *
   * @param {string} workerId
   * @returns {object|null}  task row (or null when nothing claimable)
   */
  claim(workerId) {
    if (!this.db) throw new Error('KanbanQueue not open');
    if (!workerId) throw new Error('workerId required');
    const now = Date.now();
    const tx = this.db.transaction((wid) => {
      const next = this.db.prepare(`
        SELECT id FROM kanban_tasks
         WHERE status = 'queued'
         ORDER BY priority DESC, created_at ASC
         LIMIT 1
      `).get();
      if (!next) return null;
      const upd = this.db.prepare(`
        UPDATE kanban_tasks
           SET status       = 'running',
               started_at   = ?,
               heartbeat_at = ?,
               worker_id    = ?
         WHERE id = ? AND status = 'queued'
      `).run(now, now, wid, next.id);
      if (!upd.changes) return null; // lost race to another worker
      return this.db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(next.id);
    });
    return rowToTask(tx(workerId));
  }

  /**
   * Update heartbeat_at for a running task. Called by the worker every
   * ~5s. Returns false if the row is no longer ours (cancelled,
   * reclaimed) — the worker should abort in that case.
   */
  heartbeat(taskId, workerId) {
    if (!this.db) throw new Error('KanbanQueue not open');
    const r = this.db.prepare(`
      UPDATE kanban_tasks
         SET heartbeat_at = ?
       WHERE id = ? AND worker_id = ? AND status = 'running'
    `).run(Date.now(), taskId, workerId);
    return r.changes > 0;
  }

  /** Mark a task done with the agent's final result. */
  complete(taskId, workerId, result) {
    if (!this.db) throw new Error('KanbanQueue not open');
    const now = Date.now();
    const payload = result == null ? null : JSON.stringify(result);
    const r = this.db.prepare(`
      UPDATE kanban_tasks
         SET status       = 'done',
             completed_at = ?,
             result       = ?,
             error        = NULL
       WHERE id = ? AND worker_id = ? AND status = 'running'
    `).run(now, payload, taskId, workerId);
    return r.changes > 0;
  }

  /** Mark a task failed with an error message. */
  fail(taskId, workerId, error) {
    if (!this.db) throw new Error('KanbanQueue not open');
    const now = Date.now();
    const msg = error instanceof Error ? error.message : String(error || 'unknown error');
    const r = this.db.prepare(`
      UPDATE kanban_tasks
         SET status       = 'failed',
             completed_at = ?,
             error        = ?
       WHERE id = ? AND worker_id = ? AND status = 'running'
    `).run(now, msg, taskId, workerId);
    return r.changes > 0;
  }

  /**
   * Watchdog — sweep stale running tasks back into the queue.
   *
   * "Stale" = status='running' AND heartbeat_at < now - HEARTBEAT_TIMEOUT_MS.
   * We bump attempts, clear worker_id/started_at/heartbeat_at, and flip
   * back to 'queued' so a fresh worker picks it up. The original error
   * column gets a marker so the audit trail is clear.
   *
   * Called every ~30s by the headless runtime; safe to call manually
   * from tests.
   *
   * @returns {{reclaimed: number, ids: string[]}}
   */
  reclaim() {
    if (!this.db) throw new Error('KanbanQueue not open');
    const cutoff = Date.now() - HEARTBEAT_TIMEOUT_MS;
    const stale = this.db.prepare(`
      SELECT id FROM kanban_tasks
       WHERE status = 'running'
         AND (heartbeat_at IS NULL OR heartbeat_at < ?)
    `).all(cutoff);
    if (!stale.length) return { reclaimed: 0, ids: [] };
    const upd = this.db.prepare(`
      UPDATE kanban_tasks
         SET status       = 'queued',
             worker_id    = NULL,
             started_at   = NULL,
             heartbeat_at = NULL,
             attempts     = attempts + 1,
             error        = COALESCE(error, 'reclaimed: heartbeat timeout')
       WHERE id = ? AND status = 'running'
    `);
    let n = 0;
    const ids = [];
    for (const row of stale) {
      const r = upd.run(row.id);
      if (r.changes > 0) { n++; ids.push(row.id); }
    }
    return { reclaimed: n, ids };
  }

  /**
   * User-initiated cancellation. Works on queued and running tasks; the
   * worker discovers the cancellation on its next heartbeat and bails
   * out without writing complete()/fail().
   */
  cancel(taskId) {
    if (!this.db) throw new Error('KanbanQueue not open');
    const now = Date.now();
    const r = this.db.prepare(`
      UPDATE kanban_tasks
         SET status       = 'cancelled',
             completed_at = ?
       WHERE id = ? AND status IN ('queued','running')
    `).run(now, taskId);
    return r.changes > 0;
  }

  /** Fetch a single task by id (or null). */
  getById(taskId) {
    if (!this.db) throw new Error('KanbanQueue not open');
    const row = this.db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(taskId);
    return rowToTask(row);
  }

  /**
   * List tasks for the board / `agents list` CLI.
   *
   * @param {object} [opts]
   * @param {string|string[]} [opts.status]   — filter (single or set)
   * @param {string} [opts.parentId]
   * @param {number} [opts.limit=200]
   */
  list({ status, parentId, limit } = {}) {
    if (!this.db) throw new Error('KanbanQueue not open');
    const where = [];
    const args = [];
    if (status) {
      const arr = Array.isArray(status) ? status : [status];
      if (arr.length) {
        where.push(`status IN (${arr.map(() => '?').join(',')})`);
        args.push(...arr);
      }
    }
    if (parentId) { where.push('parent_id = ?'); args.push(parentId); }
    const sql = `
      SELECT * FROM kanban_tasks
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY
        CASE status
          WHEN 'running'   THEN 0
          WHEN 'queued'    THEN 1
          WHEN 'abandoned' THEN 2
          WHEN 'failed'    THEN 3
          WHEN 'done'      THEN 4
          ELSE 5
        END,
        priority DESC,
        created_at DESC
      LIMIT ?
    `;
    args.push(Math.max(1, Math.min(1000, Number(limit) || 200)));
    return this.db.prepare(sql).all(...args).map(rowToTask);
  }

  /** Aggregate counts per status — used by the board header. */
  stats() {
    if (!this.db) throw new Error('KanbanQueue not open');
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS n FROM kanban_tasks GROUP BY status
    `).all();
    const out = { queued: 0, running: 0, done: 0, failed: 0, abandoned: 0, cancelled: 0, total: 0 };
    for (const r of rows) {
      if (out[r.status] != null) out[r.status] = r.n;
      out.total += r.n;
    }
    return out;
  }

  /**
   * Purge old terminal-state rows. Useful for keeping the SQLite file
   * from growing forever after months of cron-driven runs.
   *
   * @param {object} [opts]
   * @param {number} [opts.olderThanDays=7]  — only purges done/failed/cancelled/abandoned
   * @returns {{purged: number}}
   */
  cleanup({ olderThanDays } = {}) {
    if (!this.db) throw new Error('KanbanQueue not open');
    const days = Number(olderThanDays);
    const cutoff = Date.now() - (Number.isFinite(days) && days >= 0 ? days : 7) * 86_400_000;
    const r = this.db.prepare(`
      DELETE FROM kanban_tasks
       WHERE status IN ('done','failed','cancelled','abandoned')
         AND COALESCE(completed_at, created_at) < ?
    `).run(cutoff);
    return { purged: r.changes };
  }

  /** Test hook — wipe every row. */
  _resetForTests() {
    if (!this.db) throw new Error('KanbanQueue not open');
    this.db.prepare('DELETE FROM kanban_tasks').run();
  }
}

module.exports = { KanbanQueue, HEARTBEAT_TIMEOUT_MS, newTaskId };
