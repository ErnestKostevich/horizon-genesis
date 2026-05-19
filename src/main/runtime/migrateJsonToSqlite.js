'use strict';
/**
 * One-shot migration: existing AgentMemory JSON file → SQLite + FTS5.
 *
 * Usage (from main.js or a CLI subcommand):
 *
 *   const { migrateJsonToSqlite } = require('./runtime/migrateJsonToSqlite');
 *   const result = migrateJsonToSqlite({
 *     jsonPath: path.join(userData, 'memory.json'),
 *     dbPath:   path.join(userData, 'memory.sqlite'),
 *   });
 *
 * Idempotent: re-running tops up rows that aren't yet present (the
 * MemoryDb.addMemory upsert path collapses duplicates by stable id).
 * Returns row counts and a backup path so a user can roll back by
 * deleting the .sqlite file and pointing AgentMemory at the JSON again.
 */

const fs = require('fs');
const path = require('path');

function migrateJsonToSqlite({ jsonPath, dbPath, backup = true } = {}) {
  if (!jsonPath || !dbPath) {
    throw new Error('migrateJsonToSqlite requires { jsonPath, dbPath }');
  }
  if (!fs.existsSync(jsonPath)) {
    return { ok: false, error: 'json file not found', jsonPath };
  }

  const { MemoryDb } = require('../memoryDb');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `parse failed: ${e.message}`, jsonPath };
  }

  let backupPath = null;
  if (backup && fs.existsSync(dbPath)) {
    backupPath = `${dbPath}.bak-${Date.now()}`;
    fs.copyFileSync(dbPath, backupPath);
  }

  const db = new MemoryDb(dbPath);
  try {
    db.open();
    const before = db.stats();
    db.importFromJson(data);
    const after = db.stats();
    db.close();
    return {
      ok: true,
      dbPath,
      backupPath,
      before,
      after,
      added: {
        memories:      after.memories      - before.memories,
        facts:         after.facts         - before.facts,
        conversations: after.conversations - before.conversations,
      },
    };
  } catch (e) {
    try { db.close(); } catch (_) {}
    return { ok: false, error: e.message, dbPath };
  }
}

module.exports = { migrateJsonToSqlite };
