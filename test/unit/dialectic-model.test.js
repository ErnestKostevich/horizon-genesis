// Unit tests for DialecticModel (PHASE 28.4) — the 9th memory layer.
// Honcho-inspired diff log of what the agent has learned about the user.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DialecticModel, VALID_KINDS } = require('../../src/main/dialecticModel');

function tmpModel(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-dial-'));
  const file = path.join(dir, 'horizon_dialectic.json');
  const m = new DialecticModel(file, opts).init();
  return { dir, file, m };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test('init creates an empty store on a fresh path', () => {
  const { dir, m } = tmpModel();
  try {
    assert.equal(m.ready, true);
    assert.equal(m.records.length, 0);
    assert.equal(m.summary().total, 0);
  } finally { cleanup(dir); }
});

test('record stores a valid diff and persists to disk', () => {
  const { dir, file, m } = tmpModel();
  try {
    const entry = m.record({
      kind: 'belief',
      before: 'thought user dislikes terse replies',
      after: 'user actually prefers terse replies',
      evidence: 'just told me "stop apologising"',
      personaId: 'jarvis',
      confidence: 0.9,
    });
    assert.ok(entry);
    assert.equal(entry.kind, 'belief');
    assert.equal(entry.confidence, 0.9);
    // Persisted?
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.records.length, 1);
  } finally { cleanup(dir); }
});

test('record rejects invalid kind', () => {
  const { dir, m } = tmpModel();
  try {
    const r = m.record({ kind: 'random-junk', after: 'something' });
    assert.equal(r, null);
    assert.equal(m.records.length, 0);
  } finally { cleanup(dir); }
});

test('record rejects empty after', () => {
  const { dir, m } = tmpModel();
  try {
    const r = m.record({ kind: 'belief', after: '' });
    assert.equal(r, null);
  } finally { cleanup(dir); }
});

test('ring-buffer caps record count', () => {
  const { dir, m } = tmpModel({ cap: 60 });
  try {
    for (let i = 0; i < 100; i++) {
      m.record({ kind: 'knowledge', after: 'fact #' + i });
    }
    assert.equal(m.records.length, 60);
    // Oldest 40 were dropped — first survivor is "fact #40".
    assert.match(m.records[0].after, /fact #40/);
  } finally { cleanup(dir); }
});

test('byKind filters correctly', () => {
  const { dir, m } = tmpModel();
  try {
    m.record({ kind: 'belief',    after: 'B1' });
    m.record({ kind: 'desire',    after: 'D1' });
    m.record({ kind: 'knowledge', after: 'K1' });
    m.record({ kind: 'belief',    after: 'B2' });
    const beliefs = m.byKind('belief', 10);
    assert.equal(beliefs.length, 2);
    assert.ok(beliefs.every(r => r.kind === 'belief'));
  } finally { cleanup(dir); }
});

test('search substring-matches across fields', () => {
  const { dir, m } = tmpModel();
  try {
    m.record({ kind: 'belief', after: 'user enjoys yerba mate' });
    m.record({ kind: 'belief', after: 'user prefers coffee' });
    const hits = m.search('yerba');
    assert.equal(hits.length, 1);
    assert.match(hits[0].after, /yerba mate/);
  } finally { cleanup(dir); }
});

test('summary reports byKind counts + lastUpdatedAt', () => {
  const { dir, m } = tmpModel();
  try {
    m.record({ kind: 'belief',    after: 'A' });
    m.record({ kind: 'belief',    after: 'B' });
    m.record({ kind: 'knowledge', after: 'C' });
    const s = m.summary();
    assert.equal(s.total, 3);
    assert.equal(s.byKind.belief, 2);
    assert.equal(s.byKind.knowledge, 1);
    assert.ok(s.lastUpdatedAt > 0);
  } finally { cleanup(dir); }
});

test('injection renders bullet section for system prompt', () => {
  const { dir, m } = tmpModel();
  try {
    m.record({ kind: 'belief',    after: 'user codes in JS', confidence: 0.9 });
    m.record({ kind: 'knowledge', after: 'workspace uses TypeScript', confidence: 0.8 });
    const text = m.injection(5);
    assert.ok(text.includes('User model (dialectic'));
    assert.ok(text.includes('codes in JS'));
    assert.ok(text.includes('workspace uses TypeScript'));
  } finally { cleanup(dir); }
});

test('clear empties and persists', () => {
  const { dir, file, m } = tmpModel();
  try {
    m.record({ kind: 'belief', after: 'X' });
    m.record({ kind: 'belief', after: 'Y' });
    assert.equal(m.records.length, 2);
    m.clear();
    assert.equal(m.records.length, 0);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.records.length, 0);
  } finally { cleanup(dir); }
});

test('VALID_KINDS has the five expected entries', () => {
  assert.equal(VALID_KINDS.size, 5);
  assert.ok(VALID_KINDS.has('belief'));
  assert.ok(VALID_KINDS.has('desire'));
  assert.ok(VALID_KINDS.has('knowledge'));
  assert.ok(VALID_KINDS.has('theory-of-mind'));
  assert.ok(VALID_KINDS.has('correction'));
});
