'use strict';
/**
 * v0.0.3 — insights / consolidation layer (10) tests.
 *
 * consolidate() clusters recent episodic memories and synthesizes a single
 * higher-order "insight" per cluster (stored as a category:'insight' memory).
 * Offline-safe: no chat key → skipped 'offline', never throws.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentMemory } = require('../../src/main/agent');
const { consolidate, clusterRecent, parseInsight } = require('../../src/main/memoryConsolidator');

function tmpMem() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-cons-'));
  const mem = new AgentMemory(path.join(dir, 'horizon_memory.json'));
  mem.init();
  return { dir, mem };
}
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

test('clusterRecent groups by category offline and honours minClusterSize', () => {
  const { dir, mem } = tmpMem();
  try {
    mem.remember('User deploys to Render', 'ops', 5);
    mem.remember('User uses Render blueprints', 'ops', 5);
    mem.remember('User checks Render logs daily', 'ops', 5);
    mem.remember('User likes dark mode', 'pref', 5); // singleton — should not cluster
    const clusters = clusterRecent(mem, { minClusterSize: 3 });
    assert.equal(clusters.length, 1, 'only the ops cluster qualifies');
    assert.equal(clusters[0].length, 3);
  } finally { cleanup(dir); }
});

test('consolidate creates an insight from a cluster (stubbed synth)', async () => {
  const { dir, mem } = tmpMem();
  try {
    for (let i = 0; i < 3; i++) mem.remember(`User deploys service ${i} to Render`, 'ops', 5);
    const r = await consolidate(mem, {
      synthFn: () => ({ insight: 'User runs all infrastructure on Render', confidence: 0.9 }),
    }, { minClusterSize: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.created, 1);
    const insight = mem._data.memories.find(m => m.category === 'insight');
    assert.ok(insight, 'insight stored as a memory');
    assert.equal(insight.source, 'consolidation');
  } finally { cleanup(dir); }
});

test('consolidate dedups identical insights on re-run', async () => {
  const { dir, mem } = tmpMem();
  try {
    for (let i = 0; i < 3; i++) mem.remember(`User deploys service ${i} to Render`, 'ops', 5);
    const synthFn = () => ({ insight: 'User runs all infrastructure on Render', confidence: 0.9 });
    const r1 = await consolidate(mem, { synthFn }, { minClusterSize: 3 });
    const r2 = await consolidate(mem, { synthFn }, { minClusterSize: 3 });
    assert.equal(r1.created, 1);
    assert.equal(r2.created, 0, 'identical insight not duplicated');
  } finally { cleanup(dir); }
});

test('empty insight produces nothing', async () => {
  const { dir, mem } = tmpMem();
  try {
    for (let i = 0; i < 3; i++) mem.remember(`User deploys service ${i} to Render`, 'ops', 5);
    const r = await consolidate(mem, { synthFn: () => ({ insight: '', confidence: 0.5 }) }, { minClusterSize: 3 });
    assert.equal(r.created, 0);
    assert.ok(!mem._data.memories.some(m => m.category === 'insight'));
  } finally { cleanup(dir); }
});

test('no chat key → skipped offline, never throws', async () => {
  const { dir, mem } = tmpMem();
  try {
    for (let i = 0; i < 3; i++) mem.remember(`User deploys service ${i} to Render`, 'ops', 5);
    const r = await consolidate(mem, {
      settingsStore: { get: () => 'gemini' },
      keysStore: { get: () => null },
    }, { minClusterSize: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.created, 0);
    assert.equal(r.skipped, 'offline');
  } finally { cleanup(dir); }
});

test('parseInsight tolerates fenced JSON', () => {
  const obj = parseInsight('```json\n{"insight":"x pattern","confidence":0.7}\n```');
  assert.equal(obj.insight, 'x pattern');
  assert.equal(obj.confidence, 0.7);
});
