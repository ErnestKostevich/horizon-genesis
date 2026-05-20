// Unit tests for MemoryReviewer (PHASE 28.3) — agent-curated periodic
// memory grooming. Decay, dedupe (skipped without embeddings), forget.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentMemory } = require('../../src/main/agent');
const { MemoryReviewer, FORGET_INACTIVE_DAYS, FORGET_IMPORTANCE_FLOOR } = require('../../src/main/memoryReviewer');

function tmpMem() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-rev-'));
  const dbPath = path.join(dir, 'horizon_memory.db');
  const mem = new AgentMemory(dbPath);
  mem.init();
  return { dir, mem };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function seedMemories(mem, n, baseTime) {
  for (let i = 0; i < n; i++) {
    mem.remember(`memory content number ${i}`, 'test', 5);
  }
  // Hand-wind timestamps so the reviewer sees "stale" data without
  // waiting weeks.
  for (let i = 0; i < mem._data.memories.length; i++) {
    mem._data.memories[i].lastSeen = baseTime;
    mem._data.memories[i].created = baseTime;
  }
  mem._save();
}

test('reviewer skips under 50 memories', async () => {
  const { dir, mem } = tmpMem();
  try {
    seedMemories(mem, 10, Date.now());
    const rev = new MemoryReviewer(mem);
    const r = await rev.reviewNow();
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 'too few memories');
  } finally { cleanup(dir); }
});

test('reviewer decays stale memories', async () => {
  const { dir, mem } = tmpMem();
  try {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    seedMemories(mem, 55, eightDaysAgo);
    const before = mem._data.memories[0].importance;
    const rev = new MemoryReviewer(mem);
    const r = await rev.reviewNow();
    assert.equal(r.ok, true);
    assert.ok(r.decayed >= 50, `expected ≥50 decayed, got ${r.decayed}`);
    assert.ok(mem._data.memories[0].importance < before);
  } finally { cleanup(dir); }
});

test('reviewer forgets low-importance long-stale memories', async () => {
  const { dir, mem } = tmpMem();
  try {
    const longAgo = Date.now() - (FORGET_INACTIVE_DAYS + 5) * 24 * 60 * 60 * 1000;
    // Seed 55 memories at importance 1 (already at the forget floor).
    for (let i = 0; i < 55; i++) {
      mem.remember(`forgettable item ${i}`, 'test', FORGET_IMPORTANCE_FLOOR);
    }
    for (const m of mem._data.memories) {
      m.lastSeen = longAgo;
      m.created = longAgo;
      m.importance = FORGET_IMPORTANCE_FLOOR;
    }
    mem._save();
    const before = mem._data.memories.length;
    const rev = new MemoryReviewer(mem);
    const r = await rev.reviewNow();
    assert.equal(r.ok, true);
    assert.ok(r.forgotten > 0, 'should forget at least one');
    assert.equal(mem._data.memories.length, before - r.forgotten);
  } finally { cleanup(dir); }
});

test('reviewer status before first run is null', () => {
  const { dir, mem } = tmpMem();
  try {
    const rev = new MemoryReviewer(mem);
    const s = rev.status();
    assert.equal(s.lastRunAt, null);
    assert.equal(s.running, false);
  } finally { cleanup(dir); }
});

test('reviewer start + stop lifecycle', () => {
  const { dir, mem } = tmpMem();
  try {
    const rev = new MemoryReviewer(mem, { firstRunDelay: 60_000 });
    rev.start();
    assert.equal(rev.status().running, true);
    rev.stop();
    assert.equal(rev.status().running, false);
  } finally { cleanup(dir); }
});
