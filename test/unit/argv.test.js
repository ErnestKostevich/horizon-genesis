// Unit tests for bin/lib/argv.js — the tiny argv parser used by the CLI.
//
// Node's built-in test runner (node:test, Node 18+) is used so we have
// zero test-framework dependencies in package.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgv } = require('../../bin/lib/argv');

const SPEC = {
  aliases: { h: 'help', j: 'json', m: 'model', p: 'persona' },
  booleans: ['help', 'json', 'human', 'quiet', 'stream', 'verbose',
             'auto-approve', 'reflect'],
  negatables: ['reflect', 'semantic'],
};

test('parses bare subcommand + positional', () => {
  const r = parseArgv(['chat', 'hello world'], SPEC);
  assert.deepEqual(r._, ['chat', 'hello world']);
});

test('long flag with value via space', () => {
  const r = parseArgv(['--model', 'gpt-4'], SPEC);
  assert.equal(r.model, 'gpt-4');
});

test('long flag with value via equals', () => {
  const r = parseArgv(['--model=gpt-4'], SPEC);
  assert.equal(r.model, 'gpt-4');
});

test('short flag with alias expansion', () => {
  const r = parseArgv(['-m', 'gpt-4'], SPEC);
  assert.equal(r.model, 'gpt-4');
});

test('boolean flag stands alone', () => {
  const r = parseArgv(['--json'], SPEC);
  assert.equal(r.json, true);
});

test('negatable boolean: --no-reflect', () => {
  const r = parseArgv(['--no-reflect'], SPEC);
  assert.equal(r.reflect, false);
});

test('multiple flags + positional intermixed', () => {
  const r = parseArgv(['agent', '--json', '--model', 'claude-3', 'do the thing'], SPEC);
  assert.equal(r.json, true);
  assert.equal(r.model, 'claude-3');
  assert.deepEqual(r._, ['agent', 'do the thing']);
});

test('-- terminator collects rest as single payload', () => {
  const r = parseArgv(['agent', '--', 'task with', 'multiple', 'words'], SPEC);
  assert.deepEqual(r._, ['agent', 'task with multiple words']);
});

test('unknown long flag still parses (forward-compatible)', () => {
  const r = parseArgv(['--unknown-flag', 'value'], SPEC);
  assert.equal(r['unknown-flag'], 'value');
});

test('boolean does not consume next token', () => {
  const r = parseArgv(['--json', 'positional'], SPEC);
  assert.equal(r.json, true);
  assert.deepEqual(r._, ['positional']);
});

test('aliased boolean -j', () => {
  const r = parseArgv(['-j'], SPEC);
  assert.equal(r.json, true);
});
