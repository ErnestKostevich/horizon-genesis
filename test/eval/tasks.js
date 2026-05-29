'use strict';
/**
 * Horizon Agent — golden eval tasks (WS0 baseline).
 *
 * Each task is a deterministic replay: scripted model replies + stubbed tool
 * results + assertions. These encode the loop behaviours we never want to
 * regress. They pass against the CURRENT v0.0.1 loop — that's the point: any
 * future change (WS1 corrective loop, etc.) is run against this set first.
 *
 * Task schema:
 *   name        — unique id
 *   message     — the user's request
 *   script      — array of model replies for the main step loop
 *   tools       — { toolName: result | (tool,args)=>result }
 *   reflection  — reflection reply (object) or array (one per reflect call)
 *   maxSteps    — loop budget (default 8)
 *   expect      — assertions (see scoreTask in harness.js)
 */

module.exports = [
  {
    name: 'direct-answer-no-tools',
    message: 'What is 2 + 2?',
    script: [{ type: 'done', text: '2 + 2 = 4.' }],
    reflection: { goal_met: 'yes', summary: 'simple arithmetic', gaps: [], confidence: 0.99 },
    expect: {
      noError: true,
      toolsCalled: [],
      answerIncludes: '4',
      maxSteps: 0,
      minReflections: 1,
      goalMet: 'yes',
    },
  },

  {
    name: 'single-tool-then-answer',
    message: 'Read config.json and tell me how many keys it has.',
    script: [
      { type: 'tool', tool: 'read_file', args: { path: 'config.json' }, reason: 'read the config' },
      { type: 'done', text: 'config.json has 3 keys: a, b, c.' },
    ],
    tools: { read_file: { ok: true, out: '{"a":1,"b":2,"c":3}' } },
    reflection: { goal_met: 'yes', summary: 'read + counted', gaps: [], confidence: 0.9 },
    expect: {
      noError: true,
      toolsCalled: ['read_file'],
      answerIncludes: '3 keys',
      maxSteps: 1,
      noLoop: true,
    },
  },

  {
    name: 'multi-tool-sequence',
    message: 'Read input.txt, then write its upper-cased content to output.txt.',
    script: [
      { type: 'tool', tool: 'read_file', args: { path: 'input.txt' }, reason: 'read source' },
      { type: 'tool', tool: 'write_file', args: { path: 'output.txt', content: 'HELLO' }, reason: 'write upper-cased' },
      { type: 'done', text: 'Wrote HELLO to output.txt.' },
    ],
    tools: {
      read_file: { ok: true, out: 'hello' },
      write_file: { ok: true, out: 'written 5 bytes' },
    },
    reflection: { goal_met: 'yes', summary: 'read then wrote', gaps: [], confidence: 0.88 },
    expect: {
      noError: true,
      toolsCalled: ['read_file', 'write_file'],
      answerIncludes: 'output.txt',
      maxSteps: 2,
      noLoop: true,
    },
  },

  {
    name: 'tool-failure-handled',
    message: 'Read missing.txt and summarize it.',
    script: [
      { type: 'tool', tool: 'read_file', args: { path: 'missing.txt' }, reason: 'try to read' },
      { type: 'done', text: 'I could not read missing.txt — the file does not exist.' },
    ],
    tools: { read_file: { ok: false, err: 'ENOENT: no such file' } },
    reflection: { goal_met: 'partial', summary: 'file missing, reported honestly', gaps: ['file not found'], confidence: 0.7 },
    expect: {
      noError: true,
      toolsInclude: ['read_file'],
      answerIncludes: 'does not exist',
      maxSteps: 1,
    },
  },

  {
    name: 'reflection-fires-headless-style',
    message: 'Give me a one-line summary of REST.',
    script: [{ type: 'done', text: 'REST is an architectural style for stateless client-server APIs over HTTP.' }],
    reflection: { goal_met: 'yes', summary: 'concise + correct', gaps: [], confidence: 0.95 },
    expect: {
      noError: true,
      toolsCalled: [],
      minReflections: 1,
      goalMet: 'yes',
    },
  },

  {
    // WS1 — the loop must ACT on a low-confidence "not met" verdict: feed the
    // gap back, take another shot, and converge. Without the corrective loop
    // this task would end after the first (incomplete) answer.
    name: 'corrective-loop-closes-gap',
    message: 'List the three primary colors.',
    script: [
      { type: 'done', text: 'Red and blue.' },
      { type: 'done', text: 'Red, blue, and yellow — the three primary colors.' },
    ],
    reflections: [
      { goal_met: 'no', summary: 'only listed two', gaps: ['missing the third color'], confidence: 0.3 },
      { goal_met: 'yes', summary: 'all three listed', gaps: [], confidence: 0.95 },
    ],
    expect: {
      noError: true,
      correctiveRounds: 1,
      goalMet: 'yes',
      answerIncludes: 'yellow',
      minReflections: 2,
    },
  },

  {
    name: 'budget-respected-no-overrun',
    message: 'Do a small two-step task.',
    script: [
      { type: 'tool', tool: 'noop', args: {}, reason: 'step one' },
      { type: 'tool', tool: 'noop', args: {}, reason: 'step two' },
      { type: 'done', text: 'Two steps done.' },
    ],
    tools: { noop: { ok: true, out: 'ok' } },
    // maxSteps deliberately tight; the loop must stop at the done reply.
    maxSteps: 4,
    reflection: { goal_met: 'yes', summary: 'two steps', gaps: [], confidence: 0.9 },
    expect: {
      noError: true,
      maxSteps: 2,
      answerIncludes: 'Two steps done',
    },
  },
];
