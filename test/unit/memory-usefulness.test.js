'use strict';
/**
 * WS2 — memory feedback loop tests.
 *
 * markMemoriesUsed() rewards recalled memories that visibly resurface in the
 * agent's answer, so future recall ranks proven-useful memories higher. Plus
 * the legacy-migration path (records saved before the usefulness field).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentMemory } = require('../../src/main/agent');

function tmpMem() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-use-'));
  const mem = new AgentMemory(path.join(dir, 'horizon_memory.db'));
  mem.init();
  return { dir, mem };
}
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

test('new memories start with usefulness 0', () => {
  const { dir, mem } = tmpMem();
  try {
    const m = mem.remember('The deploy command is render deploy hooks', 'ops', 5);
    assert.equal(m.usefulness, 0);
    assert.equal(m.usefulCount, 0);
  } finally { cleanup(dir); }
});

test('markMemoriesUsed bumps memories whose words resurface in the answer', () => {
  const { dir, mem } = tmpMem();
  try {
    const used = mem.remember('User prefers dark mode interfaces', 'pref', 5);
    const unused = mem.remember('User lives in Berlin timezone', 'pref', 5);
    const before = used.importance;

    const answer = 'I set the interface to dark mode as you prefer.';
    const n = mem.markMemoriesUsed([{ key: used.key }, { key: unused.key }], answer);

    const usedAfter = mem._data.memories.find(m => m.key === used.key);
    const unusedAfter = mem._data.memories.find(m => m.key === unused.key);

    assert.equal(n, 1, 'exactly one memory counted as used');
    assert.equal(usedAfter.usefulness, 1, 'used memory rewarded');
    assert.ok(usedAfter.importance > before, 'importance nudged up');
    assert.equal(unusedAfter.usefulness, 0, 'unrelated memory untouched');
  } finally { cleanup(dir); }
});

test('markMemoriesUsed does not fire on a single common-word collision', () => {
  const { dir, mem } = tmpMem();
  try {
    const m = mem.remember('User prefers dark mode interfaces with high contrast', 'pref', 5);
    // Answer shares only "user" — must not count as used.
    const n = mem.markMemoriesUsed([{ key: m.key }], 'The user asked about the weather today.');
    assert.equal(n, 0);
    assert.equal(mem._data.memories.find(x => x.key === m.key).usefulness, 0);
  } finally { cleanup(dir); }
});

test('markMemoriesUsed handles empty / missing inputs safely', () => {
  const { dir, mem } = tmpMem();
  try {
    assert.equal(mem.markMemoriesUsed([], 'anything'), 0);
    assert.equal(mem.markMemoriesUsed(null, 'anything'), 0);
    assert.equal(mem.markMemoriesUsed([{ key: 'nonexistent' }], 'anything'), 0);
  } finally { cleanup(dir); }
});

test('legacy records without usefulness migrate cleanly on load', () => {
  const { dir, mem } = tmpMem();
  try {
    // Simulate a pre-WS2 record: no usefulness/usefulCount fields.
    mem._data.memories.push({
      id: 1, key: 'legacy:1', category: 'general',
      content: 'legacy memory about quarterly reports',
      created: Date.now(), lastSeen: Date.now(), seen: 1, importance: 6,
    });
    mem._ensureShape();
    const rec = mem._data.memories.find(m => m.key === 'legacy:1');
    assert.equal(rec.usefulness, 0, 'migrated to 0');
    assert.equal(rec.usefulCount, 0);
    // And it can still be rewarded.
    const n = mem.markMemoriesUsed([{ key: 'legacy:1' }], 'Here are the quarterly reports you asked about.');
    assert.equal(n, 1);
    assert.equal(rec.usefulness, 1);
  } finally { cleanup(dir); }
});

test('rewarded memory outranks an equal unrewarded one in keyword recall', () => {
  const { dir, mem } = tmpMem();
  try {
    // Two memories that both match the query equally on keywords.
    const a = mem.remember('Project Apollo uses the staging database', 'proj', 5);
    const b = mem.remember('Project Apollo uses the staging database mirror', 'proj', 5);
    // Reward `a` several times via repeated use.
    for (let i = 0; i < 3; i++) {
      mem.markMemoriesUsed([{ key: a.key }], 'Project Apollo staging database is configured.');
    }
    const ranked = mem.recall('Project Apollo staging database', 10);
    const idxA = ranked.findIndex(m => m.key === a.key);
    const idxB = ranked.findIndex(m => m.key === b.key);
    assert.ok(idxA >= 0 && idxB >= 0, 'both recalled');
    assert.ok(idxA < idxB, 'rewarded memory ranks first (importance lifted)');
  } finally { cleanup(dir); }
});
