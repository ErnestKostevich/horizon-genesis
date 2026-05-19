// Unit tests for src/main/runtime/cost-tracker.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CostTracker, costUsd, priceOf, PRICES } = require('../../src/main/runtime/cost-tracker');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-test-'));
}

test('priceOf returns table entry for known model', () => {
  const p = priceOf('claude-sonnet-4-6');
  assert.equal(p.in, 3.00);
  assert.equal(p.out, 15.00);
});

test('priceOf returns null for unknown model', () => {
  assert.equal(priceOf('nonexistent-model'), null);
});

test('priceOf strips openrouter prefix and matches base model', () => {
  // PRICES has 'gpt-5.4-mini' but caller passes 'openai/gpt-5.4-mini'
  const p = priceOf('openai/gpt-5.4-mini');
  assert.ok(p, 'should find by stripped prefix');
  assert.equal(p.in, 0.15);
});

test('costUsd computes from prompt/completion tokens correctly', () => {
  const c = costUsd('claude-sonnet-4-6', { prompt: 1_000_000, completion: 1_000_000 });
  // 1M * $3 + 1M * $15 = $18.0
  assert.equal(c, 18);
});

test('costUsd returns null when usage missing', () => {
  assert.equal(costUsd('claude-sonnet-4-6', null), null);
  assert.equal(costUsd('claude-sonnet-4-6', {}), 0); // no tokens = no cost
});

test('CostTracker.record appends one JSONL line', () => {
  const dir = tmpDir();
  const t = new CostTracker(dir);
  t.record({ provider: 'gemini', model: 'gemini-2.5-flash', usage: { prompt: 100, completion: 50, total: 150 }, source: 'test' });
  const raw = fs.readFileSync(path.join(dir, 'horizon-cost.jsonl'), 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.provider, 'gemini');
  assert.equal(parsed.total, 150);
  assert.equal(parsed.source, 'test');
});

test('CostTracker.summary aggregates by provider + model', () => {
  const dir = tmpDir();
  const t = new CostTracker(dir);
  t.record({ provider: 'gemini', model: 'gemini-2.5-flash', usage: { prompt: 100, completion: 50, total: 150 }, source: 'test' });
  t.record({ provider: 'gemini', model: 'gemini-2.5-flash', usage: { prompt: 200, completion: 100, total: 300 }, source: 'test' });
  t.record({ provider: 'claude', model: 'claude-sonnet-4-6', usage: { prompt: 10, completion: 5, total: 15 }, source: 'test' });

  const s = t.summary({ days: 30 });
  assert.equal(s.totals.calls, 3);
  assert.equal(s.totals.tokens, 465);
  assert.equal(s.byProvider.gemini.calls, 2);
  assert.equal(s.byProvider.claude.calls, 1);
  assert.equal(s.byProvider.gemini.tokens, 450);
});

test('CostTracker.load tolerates corrupt lines', () => {
  const dir = tmpDir();
  const t = new CostTracker(dir);
  t.record({ provider: 'gemini', model: 'gemini-2.5-flash', usage: { prompt: 100, completion: 50, total: 150 } });
  // Manually corrupt the file by appending a bad line
  fs.appendFileSync(path.join(dir, 'horizon-cost.jsonl'), 'not-json\n');
  t.record({ provider: 'gemini', model: 'gemini-2.5-flash', usage: { prompt: 200, completion: 100, total: 300 } });
  const entries = t.load();
  assert.equal(entries.length, 2, 'corrupt line should be skipped');
});

test('CostTracker.prune trims old entries', () => {
  const dir = tmpDir();
  const t = new CostTracker(dir);
  // Manually write a mix of old + new entries
  const old = { at: '2020-01-01T00:00:00.000Z', provider: 'old', model: 'gemini-2.5-flash', total: 100 };
  const fresh = { at: new Date().toISOString(), provider: 'new', model: 'gemini-2.5-flash', total: 100 };
  fs.writeFileSync(path.join(dir, 'horizon-cost.jsonl'),
    JSON.stringify(old) + '\n' + JSON.stringify(fresh) + '\n');
  const r = t.prune({ olderThanDays: 30 });
  assert.equal(r.removed, 1);
  assert.equal(r.kept, 1);
  const remaining = t.load();
  assert.equal(remaining[0].provider, 'new');
});
