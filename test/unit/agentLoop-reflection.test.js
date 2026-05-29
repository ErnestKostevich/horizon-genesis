'use strict';
/**
 * WS1 — reflection corrective-loop tests.
 *
 * Proves the loop now ACTS on its self-check instead of discarding it:
 *  - a low-confidence "not met" verdict triggers a corrective continuation
 *  - corrective rounds are hard-capped by maxCorrectiveRounds
 *  - reflection fires in headless mode (no onStep) — the v0.0.1 bug
 *  - well-answered turns reflect once and exit (back-compat)
 *  - opts.correct:false disables correction entirely
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgentLoop } = require('../../src/main/agentLoop');
const { scriptedAiFn, stubDispatch } = require('../eval/harness');

const baseOpts = () => ({
  dispatchToolFn: stubDispatch({}),
  lang: 'en',
  maxSteps: 8,
  nativeTools: false,
  timeout: 3000,
});

test('corrective round fires when goal not met + low confidence, then stops on yes', async () => {
  const aiFn = scriptedAiFn(
    [
      { type: 'done', text: 'First, partial answer.' },
      { type: 'done', text: 'Second, complete answer.' },
    ],
    [
      { goal_met: 'no', summary: 'missing detail', gaps: ['add the missing detail'], confidence: 0.3 },
      { goal_met: 'yes', summary: 'now complete', gaps: [], confidence: 0.95 },
    ]
  );
  const res = await runAgentLoop('do the thing', { ...baseOpts(), aiFn });
  assert.equal(res.ok, true);
  assert.equal(res.correctiveRounds, 1, 'exactly one corrective round');
  assert.equal(res.reflection.goalMet, 'yes', 'final reflection is yes');
  assert.match(res.answer, /complete answer/, 'returns the corrected answer');
});

test('corrective rounds are capped at maxCorrectiveRounds', async () => {
  // Always "no" — without a cap this would loop forever.
  const aiFn = scriptedAiFn(
    [
      { type: 'done', text: 'try 0' },
      { type: 'done', text: 'try 1' },
      { type: 'done', text: 'try 2' },
      { type: 'done', text: 'try 3' },
    ],
    { goal_met: 'no', summary: 'still missing', gaps: ['x'], confidence: 0.2 }
  );
  const res = await runAgentLoop('hard task', { ...baseOpts(), aiFn, maxCorrectiveRounds: 2 });
  assert.equal(res.ok, true);
  assert.equal(res.correctiveRounds, 2, 'stops at the cap, no infinite loop');
});

test('reflection fires in headless mode (no onStep)', async () => {
  const aiFn = scriptedAiFn(
    [{ type: 'done', text: 'headless answer' }],
    { goal_met: 'yes', summary: 'ok', gaps: [], confidence: 0.9 }
  );
  // No onStep passed — v0.0.1 would skip reflection entirely here.
  const res = await runAgentLoop('summarize X', { ...baseOpts(), aiFn });
  assert.ok(res.reflection, 'reflection ran without an onStep callback');
  assert.equal(res.reflection.goalMet, 'yes');
  assert.equal(res.correctiveRounds, 0);
});

test('well-answered turn reflects once and does not correct (back-compat)', async () => {
  const aiFn = scriptedAiFn(
    [{ type: 'done', text: '2 + 2 = 4' }],
    { goal_met: 'yes', summary: 'correct', gaps: [], confidence: 0.99 }
  );
  const res = await runAgentLoop('what is 2+2', { ...baseOpts(), aiFn });
  assert.equal(res.correctiveRounds, 0);
  assert.equal(res.steps.length, 0);
  assert.equal(aiFn.calls.main, 1, 'only one main call — no extra rounds');
});

test('partial but confident does NOT trigger correction', async () => {
  // goal_met partial but confidence >= 0.6 → trust it, no corrective round.
  const aiFn = scriptedAiFn(
    [{ type: 'done', text: 'partial but solid' }],
    { goal_met: 'partial', summary: 'good enough', gaps: ['minor'], confidence: 0.75 }
  );
  const res = await runAgentLoop('task', { ...baseOpts(), aiFn });
  assert.equal(res.correctiveRounds, 0, 'high confidence suppresses correction');
});

test('opts.correct:false disables correction even on low-confidence no', async () => {
  const aiFn = scriptedAiFn(
    [{ type: 'done', text: 'incomplete' }],
    { goal_met: 'no', summary: 'missing', gaps: ['a'], confidence: 0.1 }
  );
  const res = await runAgentLoop('task', { ...baseOpts(), aiFn, correct: false });
  assert.equal(res.correctiveRounds, 0, 'correction opted out');
  assert.ok(res.reflection, 'but reflection still ran (telemetry preserved)');
  assert.equal(res.reflection.goalMet, 'no');
});

test('corrective rounds respect the shared maxSteps budget', async () => {
  // maxSteps=1: one tool step consumes the whole budget, so no corrective
  // round can run even though reflection says "no".
  const aiFn = scriptedAiFn(
    [
      { type: 'tool', tool: 'noop', args: {}, reason: 'use budget' },
      { type: 'done', text: 'done after one tool' },
    ],
    { goal_met: 'no', summary: 'wanted more', gaps: ['more'], confidence: 0.2 }
  );
  const res = await runAgentLoop('task', {
    ...baseOpts(),
    aiFn,
    maxSteps: 1,
    dispatchToolFn: stubDispatch({ noop: { ok: true, out: 'ok' } }),
  });
  assert.equal(res.steps.length, 1, 'budget not exceeded');
  assert.equal(res.correctiveRounds, 0, 'no corrective round once budget is spent');
});
