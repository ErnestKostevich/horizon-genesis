'use strict';
/**
 * v0.0.3 — WS-A foundation tests.
 *
 * 1. buildAgentContext() — the SINGLE shared builder both surfaces (Electron
 *    ipc/ai.js + CLI headless.js) call, returning the sysInfo.memory block +
 *    dialectic injection. Pinned memories (layer 13) are always present.
 * 2. SQLite schema 1 → 2 migration adds usefulness/useful_count/pinned.
 * 3. usefulness + pinned survive a SQLite-primary cold restart (the bug that
 *    evaporated the WS2 feedback loop on every reboot).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentMemory } = require('../../src/main/agent');
const memoryDbMod = require('../../src/main/memoryDb');
const MemoryDb = memoryDbMod.MemoryDb || memoryDbMod.default || memoryDbMod;

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-ctx-')); }
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
function sqliteAvailable() { try { require('better-sqlite3'); return true; } catch (_) { return false; } }

test('buildAgentContext returns the sysInfo.memory shape offline', async () => {
  const dir = tmpDir();
  try {
    const mem = new AgentMemory(path.join(dir, 'horizon_memory.json'));
    mem.init();
    mem.setFact('user.name', 'Ada');
    mem.remember('User prefers dark mode interfaces', 'pref', 5);
    const ctx = await mem.buildAgentContext('what theme do I like?', { recallLimit: 8 });
    assert.ok(ctx.memory, 'has memory block');
    assert.equal(ctx.memory.facts['user.name'], 'Ada', 'facts present');
    assert.ok(Array.isArray(ctx.memory.relevant), 'relevant is array');
    assert.ok(Array.isArray(ctx.memory.recentConversations), 'recentConversations is array');
    assert.equal(typeof ctx.memory.userProfileBlock, 'string');
    assert.equal(ctx.dialecticInjection, '', 'no dialectic wired → empty string');
  } finally { cleanup(dir); }
});

test('pinned memory is always injected — no keyword match, outside top-K', async () => {
  const dir = tmpDir();
  try {
    const mem = new AgentMemory(path.join(dir, 'horizon_memory.json'));
    mem.init();
    // Pin a memory that shares NO words with the query.
    const pinned = mem.remember('Allergic to penicillin', 'health', 5);
    mem.pinMemory(pinned.key);
    // Add noise memories that DO match, to crowd out the pinned one from top-K.
    for (let i = 0; i < 12; i++) mem.remember(`weather report ${i} about rain and sun and clouds`, 'misc', 5);
    const ctx = await mem.buildAgentContext('tell me the weather', { recallLimit: 8 });
    const row = ctx.memory.relevant.find(m => m.key === pinned.key);
    assert.ok(row, 'pinned memory injected regardless of relevance');
    assert.equal(row._pinned, true, 'flagged as pinned');
    assert.equal(ctx.memory.pinnedCount, 1);
  } finally { cleanup(dir); }
});

test('dialecticInjection surfaces when a dialectic store is wired', async () => {
  const dir = tmpDir();
  try {
    const mem = new AgentMemory(path.join(dir, 'horizon_memory.json'));
    mem.init();
    mem.setDialecticModel({ injection: () => '## User model\n- prefers terse answers' });
    const ctx = await mem.buildAgentContext('hi', { recallLimit: 0 });
    assert.match(ctx.dialecticInjection, /User model/);
    assert.deepEqual(ctx.memory.relevant, [], 'recallLimit 0 → no recall');
  } finally { cleanup(dir); }
});

test('unpin removes a memory from the always-injected set', async () => {
  const dir = tmpDir();
  try {
    const mem = new AgentMemory(path.join(dir, 'horizon_memory.json'));
    mem.init();
    const m = mem.remember('Birthday is March 3rd', 'personal', 5);
    mem.pinMemory(m.key);
    let ctx = await mem.buildAgentContext('unrelated query about servers', { recallLimit: 4 });
    assert.ok(ctx.memory.relevant.some(x => x.key === m.key), 'pinned present');
    mem.unpinMemory(m.key);
    ctx = await mem.buildAgentContext('unrelated query about servers', { recallLimit: 4 });
    assert.ok(!ctx.memory.relevant.some(x => x.key === m.key), 'unpinned no longer forced in');
    assert.equal(ctx.memory.pinnedCount, 0);
  } finally { cleanup(dir); }
});

test('SQLite schema migrates v1 → v2 (usefulness/useful_count/pinned)', { skip: !sqliteAvailable() }, () => {
  const dir = tmpDir();
  try {
    const Sqlite = require('better-sqlite3');
    const dbPath = path.join(dir, 'mem.db');
    // Hand-build a v1-shaped DB: memories table WITHOUT the new columns.
    const raw = new Sqlite(dbPath);
    raw.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
              INSERT INTO meta(key,value) VALUES('schema_version','1');
              CREATE TABLE memories(id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT,
                importance INTEGER DEFAULT 5, created_at INTEGER NOT NULL, last_seen INTEGER,
                seen INTEGER DEFAULT 1, source TEXT, persona_id TEXT);`);
    raw.prepare('INSERT INTO memories(id,content,created_at) VALUES(?,?,?)').run('m:1', 'old memory', Date.now());
    raw.close();

    const db = new MemoryDb(dbPath);
    db.open();
    const cols = db.db.prepare('PRAGMA table_info(memories)').all().map(c => c.name);
    assert.ok(cols.includes('usefulness') && cols.includes('useful_count') && cols.includes('pinned'), 'new columns added');
    assert.equal(db.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '2', 'version bumped');
    // Existing row survived and reads defaults for the new columns.
    const row = db.db.prepare('SELECT usefulness, pinned FROM memories WHERE id=?').get('m:1');
    assert.equal(row.usefulness, 0);
    assert.equal(row.pinned, 0);
    db.close();
    // Idempotent re-open: no duplicate columns, no throw.
    const db2 = new MemoryDb(dbPath); db2.open();
    const cols2 = db2.db.prepare('PRAGMA table_info(memories)').all().map(c => c.name);
    assert.equal(cols2.filter(c => c === 'usefulness').length, 1, 'no duplicate column');
    db2.close();
  } finally { cleanup(dir); }
});

test('usefulness + pinned survive a SQLite-primary cold restart', { skip: !sqliteAvailable() }, () => {
  const dir = tmpDir();
  try {
    const dbPath = path.join(dir, 'mem.db');
    const jsonPath = path.join(dir, 'horizon_memory.json');

    // First boot: SQLite primary. Remember → reward → pin.
    const db1 = new MemoryDb(dbPath); db1.open();
    const mem1 = new AgentMemory(jsonPath); mem1.init(); mem1.setMemoryDb(db1);
    const m = mem1.remember('Deploy uses the Render blueprint', 'ops', 5);
    mem1.markMemoriesUsed([{ key: m.key }], 'The deploy uses the Render blueprint as configured.');
    mem1.pinMemory(m.key);
    db1.close();

    // Second boot (cold): fresh instances over the same db file.
    const db2 = new MemoryDb(dbPath); db2.open();
    const mem2 = new AgentMemory(jsonPath); mem2.init(); mem2.setMemoryDb(db2);
    const rec = mem2._data.memories.find(x => x.key === m.key);
    assert.ok(rec, 'memory rehydrated from SQLite');
    assert.ok(rec.usefulness >= 1, 'usefulness persisted across restart (was lost before v0.0.3)');
    assert.equal(rec.pinned, true, 'pinned persisted across restart');
    db2.close();
  } finally { cleanup(dir); }
});
