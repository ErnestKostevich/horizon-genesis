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

// ── PHASE 28.5 — Multi-level theory-of-mind + multi-tenant tests ────────
test('records default to level 0', () => {
  const { dir, m } = tmpModel();
  try {
    const e = m.record({ kind: 'belief', after: 'user likes coffee' });
    assert.equal(e.level, 0);
  } finally { cleanup(dir); }
});

test('level field stored when explicitly set', () => {
  const { dir, m } = tmpModel();
  try {
    m.record({ kind: 'belief',         after: 'user has CS background',       level: 0 });
    m.record({ kind: 'theory-of-mind', after: 'user expects agent to know Git', level: 1 });
    m.record({ kind: 'theory-of-mind', after: 'user thinks agent over-estimates them', level: 2 });
    const s = m.summary();
    assert.equal(s.byLevel[0], 1);
    assert.equal(s.byLevel[1], 1);
    assert.equal(s.byLevel[2], 1);
  } finally { cleanup(dir); }
});

test('level filter on getRecent works', () => {
  const { dir, m } = tmpModel();
  try {
    m.record({ kind: 'belief', after: 'A', level: 0 });
    m.record({ kind: 'belief', after: 'B', level: 1 });
    m.record({ kind: 'belief', after: 'C', level: 0 });
    const lvl0 = m.getRecent(10, { level: 0 });
    assert.equal(lvl0.length, 2);
    assert.ok(lvl0.every(r => (r.level || 0) === 0));
  } finally { cleanup(dir); }
});

test('userId scoping — multi-tenant separation', () => {
  const { dir, m } = tmpModel();
  try {
    m.record({ kind: 'belief', after: 'tenant A fact 1', userId: 'tg:111' });
    m.record({ kind: 'belief', after: 'tenant A fact 2', userId: 'tg:111' });
    m.record({ kind: 'belief', after: 'tenant B fact 1', userId: 'tg:222' });
    m.record({ kind: 'belief', after: 'untagged single-user fact' });
    const a = m.getRecent(10, { userId: 'tg:111' });
    const b = m.getRecent(10, { userId: 'tg:222' });
    const single = m.getRecent(10);
    const all = m.getRecent(10, { userId: '*' });
    assert.equal(a.length, 2);
    assert.equal(b.length, 1);
    assert.equal(single.length, 1, 'untagged scope returns only the untagged record');
    assert.equal(all.length, 4, '"*" returns everything');
  } finally { cleanup(dir); }
});

test('clear({userId}) only wipes that tenant', () => {
  const { dir, m } = tmpModel();
  try {
    m.record({ kind: 'belief', after: 'A', userId: 'tg:111' });
    m.record({ kind: 'belief', after: 'B', userId: 'tg:222' });
    const r = m.clear({ userId: 'tg:111' });
    assert.equal(r.removed, 1);
    const left = m.getRecent(10, { userId: '*' });
    assert.equal(left.length, 1);
    assert.equal(left[0].userId, 'tg:222');
  } finally { cleanup(dir); }
});

test('summary reports tenants list', () => {
  const { dir, m } = tmpModel();
  try {
    m.record({ kind: 'belief', after: 'X', userId: 'tg:111' });
    m.record({ kind: 'belief', after: 'Y', userId: 'tg:222' });
    m.record({ kind: 'belief', after: 'Z', userId: 'email:a@b.c' });
    const s = m.summary({ userId: '*' });
    assert.equal(s.tenants.length, 3);
    assert.ok(s.tenants.includes('tg:111'));
    assert.ok(s.tenants.includes('tg:222'));
    assert.ok(s.tenants.includes('email:a@b.c'));
  } finally { cleanup(dir); }
});

test('injection renders multi-level sections when present', () => {
  const { dir, m } = tmpModel();
  try {
    m.record({ kind: 'belief',         after: 'L0 fact about user', level: 0, confidence: 0.9 });
    m.record({ kind: 'theory-of-mind', after: 'L1 expectation', level: 1, confidence: 0.8 });
    m.record({ kind: 'theory-of-mind', after: 'L2 recursive', level: 2, confidence: 0.85 });
    const txt = m.injection(6);
    assert.ok(txt.includes('Level 0'));
    assert.ok(txt.includes('Level 1'));
    assert.ok(txt.includes('Level 2'));
    assert.ok(txt.includes('L0 fact'));
    assert.ok(txt.includes('L1 expectation'));
    assert.ok(txt.includes('L2 recursive'));
  } finally { cleanup(dir); }
});
