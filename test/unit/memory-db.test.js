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
