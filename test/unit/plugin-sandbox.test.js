// Unit tests for src/main/pluginSandbox.js — Sprint 6.
//
// Verifies the vm sandbox actually walls off untrusted plugins from the
// host: no fs/child_process/net access, no `process` global, no host
// global mutation. Also covers the happy path — allowed stdlib imports
// (path/url/crypto/util), console-to-logger redirection, module.exports
// resolution, and the timeout knob.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createPluginSandbox,
  runHandlerInSandbox,
  ALLOWED_MODULES,
  isSandboxDisabled,
} = require('../../src/main/pluginSandbox');

// ── Minimal ctxBuilder for tests ───────────────────────────────────────
// The PluginManager's real `_buildCtx` builds permission-checked fetch +
// disk-backed logger/storage. For these tests we only care about (a) the
// logger surface — so we can assert console redirection — and (b) that
// `ctx` is forwarded to the plugin's execute() unchanged.
function makeTestCtxBuilder() {
  const captured = { info: [], warn: [], error: [] };
  const builder = (_manifest) => ({
    settings: Object.freeze({}),
    fetch: async () => { throw new Error('not used'); },
    logger: {
      info:  (msg) => captured.info.push(String(msg)),
      warn:  (msg) => captured.warn.push(String(msg)),
      error: (msg) => captured.error.push(String(msg)),
    },
    storage: { get: () => undefined, set: () => true, delete: () => true, all: () => ({}) },
  });
  return { builder, captured };
}

function runCode(code, opts = {}) {
  const { builder, captured } = makeTestCtxBuilder();
  const manifest = { _id: opts.pluginId || 'test-plugin', name: 'Test', tier: 'community', permissions: [] };
  const result = runHandlerInSandbox(
    manifest._id,
    manifest,
    code,
    `inline:${manifest._id}/handler.js`,
    { ctxBuilder: builder },
    { timeout: opts.timeout || 5000 },
  );
  return { ...result, captured };
}

// ─── Module imports ────────────────────────────────────────────────────

test('plugin can require allowed stdlib modules (path, url, crypto, util)', () => {
  const { exports } = runCode(`
    const path = require('path');
    const url = require('url');
    const crypto = require('crypto');
    const util = require('util');
    module.exports = {
      execute() {
        return {
          ok: true,
          path: path.join('a', 'b'),
          urlOk: !!url.URL,
          hashOk: typeof crypto.createHash('sha256').update('x').digest('hex') === 'string',
          utilOk: typeof util.format === 'function',
        };
      }
    };
  `);
  const r = exports.execute();
  assert.equal(r.ok, true);
  assert.equal(r.path, path.join('a', 'b'));
  assert.equal(r.urlOk, true);
  assert.equal(r.hashOk, true);
  assert.equal(r.utilOk, true);
});

test('ALLOWED_MODULES is the documented set', () => {
  assert.deepEqual([...ALLOWED_MODULES].sort(), ['crypto', 'path', 'url', 'util']);
});

// ─── Module blocks ─────────────────────────────────────────────────────

test('plugin canNOT require fs', () => {
  assert.throws(() => runCode(`require('fs');`), /not allowed in the sandbox/);
});

test('plugin canNOT require child_process', () => {
  assert.throws(() => runCode(`require('child_process');`), /not allowed in the sandbox/);
});

test('plugin canNOT require http / https / net / tls / dgram', () => {
  for (const mod of ['http', 'https', 'net', 'tls', 'dgram']) {
    assert.throws(
      () => runCode(`require('${mod}');`),
      /not allowed in the sandbox/,
      `require('${mod}') should have been blocked`,
    );
  }
});

test('plugin canNOT require os', () => {
  assert.throws(() => runCode(`require('os');`), /not allowed in the sandbox/);
});

test('plugin canNOT require electron', () => {
  assert.throws(() => runCode(`require('electron');`), /not allowed in the sandbox/);
});

test('plugin canNOT require a relative path', () => {
  assert.throws(() => runCode(`require('./secret.js');`), /relative\/absolute imports/);
  assert.throws(() => runCode(`require('../escape');`), /relative\/absolute imports/);
});

test('plugin canNOT require an absolute path', () => {
  const absUnix = '/etc/passwd';
  const absWin = 'C:/Windows/System32/cmd';
  assert.throws(() => runCode(`require('${absUnix}');`), /relative\/absolute imports/);
  assert.throws(() => runCode(`require('${absWin}');`), /relative\/absolute imports/);
});

// ─── Process / globals ─────────────────────────────────────────────────

test('plugin canNOT access process directly', () => {
  // Reading `process` in the sandbox should throw a ReferenceError
  // because we never put it on the sandbox object. Wrapping in a try
  // catch inside the plugin gives us a clean assertion.
  const { exports } = runCode(`
    let reachable = false;
    let errName = null;
    try { void process.pid; reachable = true; }
    catch (e) { errName = e.name; }
    module.exports = { execute: () => ({ reachable, errName }) };
  `);
  const r = exports.execute();
  assert.equal(r.reachable, false);
  assert.equal(r.errName, 'ReferenceError');
});

test('plugin canNOT mutate host globals', () => {
  // The plugin assigns to a global. Because the sandbox has its own
  // `globalThis` (the sandbox object), that assignment lives inside the
  // sandbox and never reaches the host's globalThis.
  const tag = '__horizon_sandbox_leak_' + Date.now();
  runCode(`globalThis['${tag}'] = 'pwn';`);
  assert.equal(global[tag], undefined, 'host global must not be mutated by sandboxed plugin');
});

test('plugin canNOT escape via constructor chain', () => {
  // The classic vm escape — `({}).constructor.constructor('return process')()`.
  // With node:vm `runInContext`, the returned `process` is the sandbox's
  // notion of `process` (i.e. undefined / inaccessible), NOT the host's.
  // Verify the plugin gets undefined rather than the real process.
  const { exports } = runCode(`
    let leaked = null;
    let errName = null;
    try {
      const F = ({}).constructor.constructor;
      leaked = F('return typeof process')();
    } catch (e) { errName = e.name; }
    module.exports = { execute: () => ({ leaked, errName }) };
  `);
  const r = exports.execute();
  // Inside the sandbox, `process` is not defined — typeof should be
  // 'undefined'. If this assertion fails the sandbox is broken (a
  // hostile plugin would have direct access to the host process).
  assert.equal(r.leaked, 'undefined', 'sandbox must NOT expose host `process`');
});

// ─── Console redirection ────────────────────────────────────────────────

test('console.log redirects to ctx.logger.info', () => {
  const { exports, captured } = runCode(`
    console.log('hello from plugin');
    console.warn('a warning');
    console.error('an error');
    module.exports = { execute: () => ({ ok: true }) };
  `);
  exports.execute();
  assert.ok(captured.info.some(m => m.includes('hello from plugin')),
    'console.log should land in logger.info');
  assert.ok(captured.warn.some(m => m.includes('a warning')),
    'console.warn should land in logger.warn');
  assert.ok(captured.error.some(m => m.includes('an error')),
    'console.error should land in logger.error');
});

test('console.log formats objects as JSON', () => {
  const { exports, captured } = runCode(`
    console.log({ user: 'ernest', count: 7 });
    module.exports = { execute: () => null };
  `);
  exports.execute();
  // Should JSON-stringify, not produce '[object Object]'.
  assert.ok(captured.info.some(m => m.includes('"user":"ernest"')),
    'object should be JSON-formatted in the log line');
});

// ─── Handler shape + ctx delivery ──────────────────────────────────────

test('plugin execute() returns the expected shape and receives ctx', () => {
  const { builder, captured } = makeTestCtxBuilder();
  const manifest = { _id: 'test-plugin', tier: 'community', permissions: [] };
  const { exports, ctx } = runHandlerInSandbox(
    manifest._id,
    manifest,
    `
      module.exports = {
        async execute(toolName, args, ctx) {
          ctx.logger.info('called: ' + toolName);
          return { ok: true, out: 'tool=' + toolName + ' arg=' + (args && args.x) };
        }
      };
    `,
    'inline:test-plugin/handler.js',
    { ctxBuilder: builder },
  );
  assert.equal(typeof exports.execute, 'function');
  return exports.execute('greet', { x: 42 }, ctx).then(r => {
    // Cross-realm comparison — `r` was constructed inside the vm sandbox,
    // so its prototype chain differs from the host's `Object`. Compare
    // fields individually instead of using deepStrictEqual.
    assert.equal(r.ok, true);
    assert.equal(r.out, 'tool=greet arg=42');
    assert.ok(captured.info.some(m => m.includes('called: greet')));
  });
});

test('plugin can use per-tool export form (no `execute` wrapper)', () => {
  const { exports } = runCode(`
    module.exports = {
      ping: async (args) => ({ ok: true, out: 'pong:' + (args && args.n) }),
    };
  `);
  return exports.ping({ n: 7 }).then(r => {
    // Cross-realm — see comment above.
    assert.equal(r.ok, true);
    assert.equal(r.out, 'pong:7');
  });
});

// ─── Top-level script timeout ──────────────────────────────────────────

test('top-level infinite loop is aborted by the timeout', () => {
  // 100 ms is plenty short for a unit test but well above scheduling jitter.
  const start = Date.now();
  assert.throws(
    () => runCode(`while (true) { /* spin */ }`, { timeout: 100 }),
    /timed?\s*out|Script execution timed out/i,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `timeout fired in ${elapsed}ms — should be near 100ms, not block`);
});

// ─── Sandbox bypass switch ─────────────────────────────────────────────

test('HORIZON_PLUGIN_NO_SANDBOX=1 disables the sandbox', () => {
  const prev = process.env.HORIZON_PLUGIN_NO_SANDBOX;
  process.env.HORIZON_PLUGIN_NO_SANDBOX = '1';
  try {
    assert.equal(isSandboxDisabled(), true);
  } finally {
    if (prev === undefined) delete process.env.HORIZON_PLUGIN_NO_SANDBOX;
    else process.env.HORIZON_PLUGIN_NO_SANDBOX = prev;
  }
  assert.equal(isSandboxDisabled(), false, 'should be off by default');
});

// ─── End-to-end: malicious community plugin via PluginManager ──────────

test('PluginManager refuses to load a hostile community plugin in the sandbox', () => {
  // This exercises the full path: write a community plugin to disk, ask
  // PluginManager to load it. The plugin's handler tries to `require('fs')`.
  // After loadAll the plugin should be registered (manifest read) but its
  // handler should NOT be (the sandbox throws on the bad require, the
  // catch swallows it). The plugin therefore can't be called, which is
  // the desired security outcome.
  const { PluginManager } = require('../../src/main/pluginManager');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-sb-mal-'));
  const pluginsDir = path.join(tmp, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const pid = 'evil-plugin';
  const dir = path.join(pluginsDir, pid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: pid,
    name: 'Evil Plugin',
    version: '1.0.0',
    author: 'malice',
    tier: 'community',
    permissions: [],
    tools: [{ name: 'read_secrets', description: 'reads /etc/passwd', params: {} }],
  }));
  fs.writeFileSync(path.join(dir, 'handler.js'), `
    const fs = require('fs');
    module.exports = {
      execute() { return { ok: true, out: fs.readFileSync('/etc/passwd', 'utf8') }; }
    };
  `);

  // Silence console.error during loadAll — we expect one error line.
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args.join(' ')); };
  let pm;
  try {
    pm = new PluginManager(pluginsDir);
    pm.loadAll();
  } finally {
    console.error = originalError;
  }

  // The manifest loaded but the handler did not (the sandbox threw).
  assert.ok(pm.plugins.has(pid), 'manifest should still register');
  assert.ok(!pm.handlers.has(pid), 'hostile handler must NOT register');
  assert.ok(
    errors.some(e => /require.*fs.*not allowed/.test(e)),
    `expected sandbox-rejection in console.error output, got: ${JSON.stringify(errors)}`,
  );

  // Cleanup.
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

test('PluginManager loads a well-behaved community plugin via sandbox', () => {
  const { PluginManager } = require('../../src/main/pluginManager');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-sb-ok-'));
  const pluginsDir = path.join(tmp, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const pid = 'nice-plugin';
  const dir = path.join(pluginsDir, pid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: pid,
    name: 'Nice Plugin',
    version: '1.0.0',
    author: 'friendly',
    tier: 'community',
    permissions: [],
    tools: [{ name: 'echo', description: 'echo args', params: {} }],
    config: { greeting: 'hi' },
  }));
  fs.writeFileSync(path.join(dir, 'handler.js'), `
    const crypto = require('crypto');
    module.exports = {
      async execute(tool, args, ctx) {
        if (tool === 'echo') {
          const h = crypto.createHash('sha1').update(String(args && args.msg || '')).digest('hex');
          return { ok: true, out: ctx.settings.greeting + ':' + h.slice(0,8) };
        }
        return { ok: false, error: 'unknown tool' };
      }
    };
  `);

  const pm = new PluginManager(pluginsDir);
  pm.loadAll();
  assert.ok(pm.plugins.has(pid));
  assert.ok(pm.handlers.has(pid));

  return pm.executeTool(pid, 'echo', { msg: 'world' }).then(r => {
    assert.equal(r.ok, true);
    assert.ok(r.out.startsWith('hi:'));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  });
});
