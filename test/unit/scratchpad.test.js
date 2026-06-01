'use strict';
/**
 * v0.0.3 — working-memory scratchpad (layer 12) tests.
 *
 * Per-run isolated key/value store the agent uses via scratch_* tools; cleared
 * (or promoted) at task end. Pure in-memory → offline-safe.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = require('../../src/main/scratchpad');
const { AgentMemory } = require('../../src/main/agent');

test('write/read/list/clear are per-run isolated', () => {
  const a = 'run-a-' + Date.now();
  const b = 'run-b-' + Date.now();
  scratch.write(a, 'plan', 'step 1, step 2');
  scratch.write(a, 'count', 3); // non-string is serialized
  scratch.write(b, 'plan', 'other run');
  assert.equal(scratch.read(a, 'plan'), 'step 1, step 2');
  assert.equal(scratch.read(a, 'count'), '3');
  assert.equal(scratch.read(b, 'plan'), 'other run');
  assert.deepEqual(scratch.list(a).sort(), ['count', 'plan']);
  assert.equal(scratch.list(b).length, 1);
  scratch.clear(a);
  assert.equal(scratch.list(a).length, 0);
  assert.equal(scratch.read(b, 'plan'), 'other run', 'clearing run a did not touch run b');
  scratch.clear(b);
});

test('read with no key returns all entries; missing key returns null', () => {
  const r = 'run-all-' + Date.now();
  scratch.write(r, 'x', '1');
  scratch.write(r, 'y', '2');
  assert.deepEqual(scratch.read(r), { x: '1', y: '2' });
  assert.equal(scratch.read(r, 'nope'), null);
  scratch.clear(r);
});

test('value byte cap is enforced', () => {
  const r = 'run-cap-' + Date.now();
  const big = 'z'.repeat(scratch.MAX_VALUE_BYTES + 500);
  assert.equal(scratch.write(r, 'big', big).ok, true);
  assert.ok(scratch.read(r, 'big').length <= scratch.MAX_VALUE_BYTES + 1);
  scratch.clear(r);
});

test('key cap is enforced', () => {
  const r = 'run-keys-' + Date.now();
  for (let i = 0; i < scratch.MAX_KEYS_PER_RUN; i++) scratch.write(r, 'k' + i, 'v');
  assert.equal(scratch.write(r, 'one-too-many', 'v').ok, false);
  scratch.clear(r);
});

test('promote writes scratch entries to long-term memory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-scratch-'));
  try {
    const mem = new AgentMemory(path.join(dir, 'horizon_memory.json'));
    mem.init();
    const r = 'run-promote-' + Date.now();
    scratch.write(r, 'finding', 'The bug is in the parser');
    assert.equal(scratch.promote(r, mem), 1);
    assert.ok(mem._data.memories.some(m => /parser/i.test(m.content) && m.source === 'scratchpad'));
    scratch.clear(r);
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
});

test('scratch tools self-register and key off ctx.runId', async () => {
  const registry = require('../../src/main/tools/registry');
  require('../../src/main/tools/scratch'); // self-registers into the shared registry
  assert.ok(registry.has('scratch_write'), 'scratch_write registered');
  assert.ok(registry.has('scratch_read'), 'scratch_read registered');
  assert.ok(registry.has('scratch_list'), 'scratch_list registered');
  const runId = 'run-tool-' + Date.now();
  await registry.get('scratch_write').execute({ key: 'a', value: 'hello' }, { runId });
  const out = await registry.get('scratch_read').execute({ key: 'a' }, { runId });
  assert.equal(out.value, 'hello');
  const listed = await registry.get('scratch_list').execute({}, { runId });
  assert.deepEqual(listed.keys, ['a']);
  scratch.clear(runId);
});
