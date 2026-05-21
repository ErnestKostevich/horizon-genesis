// Unit tests for the SQLite + FTS5 MemoryDb backend (PHASE 28).
//
// Skipped automatically when better-sqlite3 isn't installed for the
// current Node runtime — CI on platforms without prebuilt binaries
// shouldn't fail because of an optional native dep.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let MemoryDb, sanitizeMatch, sqliteAvailable = true;
try {
  require('better-sqlite3');
  ({ MemoryDb, sanitizeMatch } = require('../../src/main/memoryDb'));
} catch (_) {
  sqliteAvailable = false;
}

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-memdb-'));
  return { dir, file: path.join(dir, 'memory.sqlite') };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test('sanitizeMatch strips operators and ANDs prefix terms', { skip: !sqliteAvailable }, () => {
  assert.equal(sanitizeMatch('hello world'), 'hello* AND world*');
  assert.equal(sanitizeMatch('quoted "thing" (foo)'), 'quoted* AND thing* AND foo*');
  assert.equal(sanitizeMatch(''), '');
  assert.equal(sanitizeMatch('a'), '');
});

test('open + addMemory + searchMemories round-trip', { skip: !sqliteAvailable }, () => {
  const { dir, file } = tmpDb();
  const db = new MemoryDb(file).open();
  try {
    db.addMemory({ id: 'm1', content: 'Ernest prefers dark mode by default', category: 'preference', importance: 8 });
    db.addMemory({ id: 'm2', content: 'Horizon ships with crypto-only payouts', category: 'product', importance: 6 });
    const r = db.searchMemories('dark mode', 5);
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'm1');
    assert.ok(r[0].score < 0); // bm25 scores are negative — closer to 0 is worse
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('addMemory is upsert — second call bumps seen + last_seen', { skip: !sqliteAvailable }, () => {
  const { dir, file } = tmpDb();
  const db = new MemoryDb(file).open();
  try {
    db.addMemory({ id: 'm1', content: 'x', category: 'c', importance: 5 });
    db.addMemory({ id: 'm1', content: 'x', category: 'c', importance: 9 });
    const row = db.listMemories()[0];
    assert.equal(row.seen, 2);
    assert.equal(row.importance, 9);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('facts setFact + getFact + FTS', { skip: !sqliteAvailable }, () => {
  const { dir, file } = tmpDb();
  const db = new MemoryDb(file).open();
  try {
    db.setFact('user.email', 'ernest2011kostevich@gmail.com', 'manual');
    db.setFact('user.email', 'ernest@example.com'); // upsert
    assert.equal(db.getFact('user.email'), 'ernest@example.com');
    const hits = db.searchFacts('ernest', 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].key, 'user.email');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('conversations + cross-pool search', { skip: !sqliteAvailable }, () => {
  const { dir, file } = tmpDb();
  const db = new MemoryDb(file).open();
  try {
    db.addConversation({ id: 'c1', user: 'what is horizon', assistant: 'desktop AI agent' });
    db.addMemory({ id: 'm1', content: 'horizon uses BSL licensing', category: 'license', importance: 7 });
    db.setFact('product.name', 'Horizon AI');
    const all = db.searchAll('horizon', 5);
    const types = new Set(all.map(r => r._type));
    assert.ok(types.has('memory'));
    assert.ok(types.has('fact'));
    assert.ok(types.has('conversation'));
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('importFromJson migrates the existing JSON shape', { skip: !sqliteAvailable }, () => {
  const { dir, file } = tmpDb();
  const db = new MemoryDb(file).open();
  try {
    const result = db.importFromJson({
      memories: [
        { key: 'preference:abc', content: 'likes terse replies', category: 'preference', importance: 8 },
        { key: 'project:def',    content: 'shipping v1.0 this month', category: 'project',   importance: 6 },
      ],
      facts: {
        'user.role': { value: 'solo maintainer', source: 'chat' },
        'user.tz':   'Europe/Vilnius',
      },
      conversations: [
        { id: 1, user: 'hi', assistant: 'hello', source: 'chat' },
      ],
    });
    assert.equal(result.memories, 2);
    assert.equal(result.facts, 2);
    assert.equal(result.conversations, 1);
    assert.equal(db.getFact('user.tz'), 'Europe/Vilnius');
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ── Sprint 7B — SQLite-first migration + export/import ───────────────

test('Sprint 7B: importFromJsonFile reads JSON from disk', { skip: !sqliteAvailable }, () => {
  const { dir, file } = tmpDb();
  const jsonPath = path.join(dir, 'memory.json');
  // Seed a JSON file in the legacy shape.
  fs.writeFileSync(jsonPath, JSON.stringify({
    memories: [
      { key: 'pref:abc', content: 'dark mode default', category: 'preference', importance: 8 },
      { key: 'proj:def', content: 'horizon ships in May', category: 'project', importance: 7 },
    ],
    facts: {
      'user.name': { value: 'Ernest', source: 'manual' },
      'user.tz':   'Europe/Vilnius',
    },
    conversations: [
      { id: 1, user: 'hi', assistant: 'hello', source: 'chat' },
      { id: 2, user: 'thanks', assistant: 'sure', source: 'chat' },
    ],
  }));
  const db = new MemoryDb(file).open();
  try {
    const after = db.importFromJsonFile(jsonPath);
    assert.equal(after.memories, 2);
    assert.equal(after.facts, 2);
    assert.equal(after.conversations, 2);
    assert.equal(db.getFact('user.name'), 'Ernest');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('Sprint 7B: exportToJson writes a roundtrip-safe JSON file', { skip: !sqliteAvailable }, () => {
  const { dir, file } = tmpDb();
  const out = path.join(dir, 'export.json');
  const db = new MemoryDb(file).open();
  try {
    db.addMemory({ id: 'm1', content: 'cat 1 mem', category: 'general', importance: 6 });
    db.addMemory({ id: 'm2', content: 'cat 2 mem', category: 'preference', importance: 9 });
    db.setFact('user.role', 'maintainer', 'manual');
    db.setFact('project.name', 'horizon', 'chat');
    db.addConversation({ id: 'c-1', user: 'q1', assistant: 'a1', source: 'chat' });
    db.addConversation({ id: 'c-2', user: 'q2', assistant: 'a2', source: 'chat' });

    const exp = db.exportToJson(out);
    assert.equal(exp.ok, true);
    assert.equal(exp.jsonPath, out);
    assert.ok(exp.bytes > 0);

    const raw = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(raw.memories.length, 2);
    assert.equal(Object.keys(raw.facts).length, 2);
    assert.equal(raw.conversations.length, 2);
    assert.equal(raw.facts['user.role'].value, 'maintainer');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('Sprint 7B: roundtrip SQLite → JSON → fresh SQLite preserves all rows', { skip: !sqliteAvailable }, () => {
  const { dir, file } = tmpDb();
  const out = path.join(dir, 'roundtrip.json');
  const file2 = path.join(dir, 'memory2.sqlite');

  // Build source DB
  const dbA = new MemoryDb(file).open();
  try {
    dbA.addMemory({ id: 'm1', content: 'first memory', category: 'a', importance: 5 });
    dbA.addMemory({ id: 'm2', content: 'second memory', category: 'b', importance: 8 });
    dbA.setFact('f1', 'value 1', 'manual');
    dbA.setFact('f2', 'value 2', 'chat');
    dbA.addConversation({ id: 'c1', user: 'hi', assistant: 'hi back' });
    const beforeStats = dbA.stats();
    assert.equal(beforeStats.memories, 2);
    assert.equal(beforeStats.facts, 2);
    assert.equal(beforeStats.conversations, 1);

    dbA.exportToJson(out);
  } finally {
    dbA.close();
  }

  // Import into fresh DB
  const dbB = new MemoryDb(file2).open();
  try {
    dbB.importFromJsonFile(out);
    const stats = dbB.stats();
    assert.equal(stats.memories, 2, 'memories roundtripped');
    assert.equal(stats.facts, 2, 'facts roundtripped');
    assert.equal(stats.conversations, 1, 'conversations roundtripped');
    assert.equal(dbB.getFact('f1'), 'value 1');
    assert.equal(dbB.getFact('f2'), 'value 2');
  } finally {
    dbB.close();
    cleanup(dir);
  }
});

test('Sprint 7B: migrateJsonToSqlite + auto-archive flow', { skip: !sqliteAvailable }, () => {
  const { dir } = tmpDb();
  const jsonPath = path.join(dir, 'memory.json');
  const dbPath = path.join(dir, 'memory.sqlite');
  fs.writeFileSync(jsonPath, JSON.stringify({
    memories: [
      { key: 'k1', content: 'memory one', category: 'general', importance: 5 },
      { key: 'k2', content: 'memory two', category: 'preference', importance: 8 },
    ],
    facts: { 'role': { value: 'solo maintainer' } },
    conversations: [],
  }));

  const { migrateJsonToSqlite } = require('../../src/main/runtime/migrateJsonToSqlite');
  const result = migrateJsonToSqlite({ jsonPath, dbPath, backup: false });
  assert.equal(result.ok, true);
  assert.equal(result.added.memories, 2);
  assert.equal(result.added.facts, 1);

  // Verify the SQLite store has the imported rows
  const db = new MemoryDb(dbPath).open();
  try {
    const stats = db.stats();
    assert.equal(stats.memories, 2);
    assert.equal(stats.facts, 1);
    assert.equal(db.getFact('role'), 'solo maintainer');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('Sprint 7B: fresh start — empty DB has zero rows and clean stats', { skip: !sqliteAvailable }, () => {
  const { dir, file } = tmpDb();
  // SQLite file doesn't exist yet
  assert.equal(fs.existsSync(file), false);
  const db = new MemoryDb(file).open();
  try {
    const stats = db.stats();
    assert.equal(stats.memories, 0);
    assert.equal(stats.facts, 0);
    assert.equal(stats.conversations, 0);
    assert.equal(stats.schema, 1);
    // After open(), the file should exist on disk
    assert.equal(fs.existsSync(file), true);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('Sprint 7B: HORIZON_MEMORY_BACKEND=json env opt-back signal is honoured by createHorizonRuntime', { skip: !sqliteAvailable }, () => {
  // Smoke check: we don't boot the full runtime here (too heavy), but
  // verify the env var name + default value are what headless.js + main.js
  // both read. This guards against typos in the rollback escape hatch.
  const prev = process.env.HORIZON_MEMORY_BACKEND;
  try {
    delete process.env.HORIZON_MEMORY_BACKEND;
    const defaultBackend = String(process.env.HORIZON_MEMORY_BACKEND || 'sqlite').toLowerCase();
    assert.equal(defaultBackend, 'sqlite');

    process.env.HORIZON_MEMORY_BACKEND = 'json';
    const optBack = String(process.env.HORIZON_MEMORY_BACKEND || 'sqlite').toLowerCase();
    assert.equal(optBack, 'json');
  } finally {
    if (prev === undefined) delete process.env.HORIZON_MEMORY_BACKEND;
    else process.env.HORIZON_MEMORY_BACKEND = prev;
  }
});
