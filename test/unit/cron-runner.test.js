// Unit tests for the 5-field crontab parser shipped with horizon cron.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCronExpr, cronMatches } = require('../../src/main/runtime/cron-runner');

test('parses all-wildcards expression', () => {
  const p = parseCronExpr('* * * * *');
  assert.equal(p.minute, null);
  assert.equal(p.hour, null);
  assert.equal(p.dom, null);
  assert.equal(p.month, null);
  assert.equal(p.dow, null);
});

test('parses a single-value field', () => {
  const p = parseCronExpr('0 9 * * *');
  assert.ok(p.minute.has(0));
  assert.equal(p.minute.size, 1);
  assert.ok(p.hour.has(9));
});

test('parses comma list', () => {
  const p = parseCronExpr('0,15,30,45 * * * *');
  assert.deepEqual([...p.minute].sort((a,b)=>a-b), [0,15,30,45]);
});

test('parses range', () => {
  const p = parseCronExpr('* * * * 1-5');
  assert.deepEqual([...p.dow].sort((a,b)=>a-b), [1,2,3,4,5]);
});

test('parses step', () => {
  const p = parseCronExpr('*/15 * * * *');
  assert.deepEqual([...p.minute].sort((a,b)=>a-b), [0,15,30,45]);
});

test('parses range with step', () => {
  const p = parseCronExpr('0 9-17/2 * * *');
  assert.deepEqual([...p.hour].sort((a,b)=>a-b), [9,11,13,15,17]);
});

test('rejects expression with wrong number of fields', () => {
  assert.throws(() => parseCronExpr('0 * * *'));
  assert.throws(() => parseCronExpr('* * * * * *'));
});

test('rejects out-of-range values', () => {
  assert.throws(() => parseCronExpr('60 * * * *')); // minute max 59
  assert.throws(() => parseCronExpr('* 24 * * *')); // hour max 23
  assert.throws(() => parseCronExpr('* * 32 * *')); // dom max 31
  assert.throws(() => parseCronExpr('* * * 13 *')); // month max 12
  assert.throws(() => parseCronExpr('* * * * 7'));  // dow max 6
});

test('cronMatches: every-minute fires every minute', () => {
  const p = parseCronExpr('* * * * *');
  for (let m = 0; m < 60; m++) {
    const d = new Date(2026, 5, 1, 10, m); // June 1 2026, 10:mm
    assert.equal(cronMatches(p, d), true, `failed at minute ${m}`);
  }
});

test('cronMatches: 9 AM weekdays only', () => {
  const p = parseCronExpr('0 9 * * 1-5');
  // 9:00 Mon = match
  assert.equal(cronMatches(p, new Date(2026, 4, 18, 9, 0)), true); // 2026-05-18 Mon
  // 9:00 Sat = no
  assert.equal(cronMatches(p, new Date(2026, 4, 23, 9, 0)), false);
  // 9:01 Mon = no
  assert.equal(cronMatches(p, new Date(2026, 4, 18, 9, 1)), false);
  // 8:00 Mon = no
  assert.equal(cronMatches(p, new Date(2026, 4, 18, 8, 0)), false);
});

test('cronMatches: every 15 min at top, 15, 30, 45', () => {
  const p = parseCronExpr('*/15 * * * *');
  for (const m of [0, 15, 30, 45]) {
    assert.equal(cronMatches(p, new Date(2026, 5, 1, 10, m)), true);
  }
  for (const m of [1, 14, 16, 29, 31, 44, 46, 59]) {
    assert.equal(cronMatches(p, new Date(2026, 5, 1, 10, m)), false);
  }
});

test('cronMatches: specific date 12 March', () => {
  const p = parseCronExpr('0 0 12 3 *');
  assert.equal(cronMatches(p, new Date(2026, 2, 12, 0, 0)), true); // March is month=2 (0-indexed JS)
  assert.equal(cronMatches(p, new Date(2026, 2, 13, 0, 0)), false);
  assert.equal(cronMatches(p, new Date(2026, 3, 12, 0, 0)), false); // April
});
