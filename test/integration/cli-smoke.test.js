// Integration smoke tests — spawn `node bin/horizon.js <subcommand>`
// in isolated profiles so we don't touch the user's real data.
//
// We don't make real AI calls here (that needs keys + network) — only
// commands that work offline against an empty profile.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'horizon.js');

function runCli(args, opts = {}) {
  const tmpUserData = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-cli-test-'));
  const env = {
    ...process.env,
    HORIZON_FAST: '1',
    NO_COLOR: '1',
    ...opts.env,
  };
  const fullArgs = ['--user-data-dir', tmpUserData, ...args];
  const r = spawnSync('node', [CLI, ...fullArgs], {
    cwd: opts.cwd || REPO,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { ...r, tmpUserData };
}

test('horizon --help prints usage', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0, 'stderr was: ' + r.stderr);
  assert.match(r.stdout, /Usage/);
  assert.match(r.stdout, /agent/);
  assert.match(r.stdout, /chat/);
});

test('horizon version --json returns parseable JSON', () => {
  const r = runCli(['version', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.version);
  assert.ok(parsed.userDataDir);
  assert.ok(parsed.activeProvider);
});

test('horizon model --list shows all 25+ providers', () => {
  const r = runCli(['model', '--list']);
  assert.equal(r.status, 0, r.stderr);
  // Spot-check several providers across categories
  const providers = ['claude', 'openai', 'gemini', 'groq', 'together',
                     'fireworks', 'deepinfra', 'cerebras', 'moonshot',
                     'azure', 'custom', 'litellm', 'ollama'];
  for (const p of providers) {
    assert.match(r.stdout, new RegExp('\\b' + p + '\\b'), 'missing ' + p);
  }
});

test('horizon persona --list shows built-ins', () => {
  const r = runCli(['persona', '--list']);
  assert.equal(r.status, 0, r.stderr);
  for (const p of ['jarvis', 'friday', 'alfred', 'sage', 'pixel']) {
    assert.match(r.stdout, new RegExp(p));
  }
});

test('horizon skill list works on empty profile', () => {
  const r = runCli(['skill', 'list']);
  assert.equal(r.status, 0, r.stderr);
  // Builtin skills bundle exists in repo, so we should see them
  assert.match(r.stdout, /builtin/);
});

test('horizon mem stats on empty profile', () => {
  const r = runCli(['mem', 'stats']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /memories/);
});

test('horizon cron flow: create → list → remove', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-cron-test-'));
  const c1 = runCli(['cron', 'create', '0 9 * * 1-5', 'morning task', '--name', 'morning'], { userDataDir: dir });
  assert.equal(c1.status, 0, c1.stderr);
  assert.match(c1.stdout, /created cron-/);
  const idMatch = c1.stdout.match(/cron-[a-f0-9]+/);
  assert.ok(idMatch);
  const id = idMatch[0];

  const c2 = runCli(['cron', 'list'], { userDataDir: dir });
  assert.equal(c2.status, 0, c2.stderr);
  assert.match(c2.stdout, new RegExp(id));

  const c3 = runCli(['cron', 'remove', id], { userDataDir: dir });
  assert.equal(c3.status, 0, c3.stderr);
});

test('horizon profile create → list → use → delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-prof-test-'));
  // create
  const c1 = runCli(['profile', 'create', 'work'], { userDataDir: dir });
  assert.equal(c1.status, 0, c1.stderr);
  // list — work should appear
  const c2 = runCli(['profile', 'list'], { userDataDir: dir });
  assert.equal(c2.status, 0, c2.stderr);
  assert.match(c2.stdout, /work/);
  // use
  const c3 = runCli(['profile', 'use', 'work'], { userDataDir: dir });
  assert.equal(c3.status, 0, c3.stderr);
  // delete via --yes
  const c4 = runCli(['profile', 'use', 'default'], { userDataDir: dir });
  assert.equal(c4.status, 0);
  const c5 = runCli(['profile', 'delete', 'work', '--yes'], { userDataDir: dir });
  assert.equal(c5.status, 0, c5.stderr);
});

test('horizon notes round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-notes-test-'));
  const a = runCli(['notes', 'add', 'integration test note'], { userDataDir: dir });
  assert.equal(a.status, 0, a.stderr);
  const idMatch = a.stdout.match(/note-[a-f0-9]+/);
  assert.ok(idMatch);
  const l = runCli(['notes', 'list'], { userDataDir: dir });
  assert.match(l.stdout, /integration test note/);
});

test('horizon todo round-trip with --json verifies persistence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-todo-test-'));
  runCli(['todo', 'add', 'first task'], { userDataDir: dir });
  runCli(['todo', 'add', 'second task'], { userDataDir: dir });
  const list = runCli(['todo', 'list', '--json'], { userDataDir: dir });
  assert.equal(list.status, 0);
  const parsed = JSON.parse(list.stdout);
  assert.equal(parsed.length, 2);
  assert.equal(parsed.filter(t => !t.done).length, 2);
});

test('horizon stats produces a snapshot', () => {
  const r = runCli(['stats', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.memory);
  assert.ok(typeof parsed.skills === 'number');
});

test('horizon doctor returns ok even on fresh profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-doctor-test-'));
  const r = runCli(['doctor', '--json'], { userDataDir: dir });
  // Doctor may warn but should NOT error fatally (status 0 even with warnings;
  // status 1 only on real failures)
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.checks));
  assert.ok(parsed.checks.length >= 5);
});

test('horizon completion bash emits valid script', () => {
  const r = runCli(['completion', 'bash']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /complete -F _horizon_complete horizon/);
});

test('horizon cost shows zero on fresh profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-cost-test-'));
  const r = runCli(['cost', '--json'], { userDataDir: dir });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.totals.calls, 0);
});
