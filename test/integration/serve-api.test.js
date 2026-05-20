// Integration tests for `horizon serve` HTTP API. We spawn the server,
// hit it with bare http requests, and verify auth + key endpoints.
//
// No real AI calls — those would need keys + network. We test the
// transport shape: 401 on bad token, 200 + correct JSON on good token,
// SSE wiring on /api/agent (without actually waiting for an agent run).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const SERVE = path.join(REPO, 'bin', 'horizon-serve.js');
const TOKEN = 'test-token-' + Date.now();
const PORT = 18900 + Math.floor(Math.random() * 100); // randomise to avoid collisions

let server = null;
let userDataDir = '';

function request(method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port: PORT, path: pathname, method,
      headers: { ...headers },
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForReady(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await request('GET', '/api/health', null, { Authorization: 'Bearer ' + TOKEN });
      if (r.status === 200) return true;
    } catch (_) {}
    await delay(150);
  }
  throw new Error('serve never became ready');
}

test.before(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-serve-test-'));
  server = spawn('node', [SERVE,
    '--port', String(PORT),
    '--token', TOKEN,
    '--user-data-dir', userDataDir,
  ], {
    env: { ...process.env, NO_COLOR: '1', HORIZON_FAST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO,
  });
  server.stdout.on('data', () => {}); // drain
  server.stderr.on('data', () => {}); // drain
  await waitForReady();
});

test.after(() => {
  if (server) {
    try { server.kill('SIGTERM'); } catch (_) {}
  }
});

test('GET /api/health requires bearer token', async () => {
  const r = await request('GET', '/api/health');
  assert.equal(r.status, 401);
});

test('GET /api/health returns 200 with valid token', async () => {
  const r = await request('GET', '/api/health', null, { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.ts);
});

test('GET /api/health with wrong token returns 401', async () => {
  const r = await request('GET', '/api/health', null, { Authorization: 'Bearer wrong-token' });
  assert.equal(r.status, 401);
});

test('GET /api/version returns runtime info', async () => {
  const r = await request('GET', '/api/version', null, { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.ok(parsed.version);
  assert.ok(parsed.nodeVersion);
  assert.equal(parsed.platform, process.platform);
});

test('GET /api/skills returns the builtin skills array', async () => {
  const r = await request('GET', '/api/skills', null, { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 1, 'expected at least one builtin skill');
});

test('GET /api/personas returns 5 built-in personas', async () => {
  const r = await request('GET', '/api/personas', null, { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 5);
  const ids = parsed.map(p => p.id);
  for (const id of ['jarvis', 'friday', 'alfred', 'sage', 'pixel']) {
    assert.ok(ids.includes(id), 'missing persona ' + id);
  }
});

test('GET /api/mem/profile returns user profile JSON', async () => {
  const r = await request('GET', '/api/mem/profile', null, { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.ok(typeof parsed === 'object');
});

test('POST /api/persona switches the active persona', async () => {
  const r = await request('POST', '/api/persona', JSON.stringify({ id: 'friday' }),
    { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.persona, 'friday');
});

test('POST /api/model switches the active provider', async () => {
  const r = await request('POST', '/api/model', JSON.stringify({ provider: 'groq', model: 'llama-3.3-70b-versatile' }),
    { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.ok, true);
});

test('POST /api/mem/search returns array (possibly empty)', async () => {
  const r = await request('POST', '/api/mem/search', JSON.stringify({ query: 'anything', limit: 3 }),
    { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.ok(Array.isArray(parsed));
});

test('POST /api/chat without message returns 400', async () => {
  const r = await request('POST', '/api/chat', JSON.stringify({}),
    { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 400);
});

test('CORS preflight OPTIONS returns 204', async () => {
  const r = await request('OPTIONS', '/api/health');
  assert.equal(r.status, 204);
  assert.ok(r.headers['access-control-allow-origin']);
});

test('GET /api/status returns the PWA snapshot shape', async () => {
  const r = await request('GET', '/api/status', null, { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.online, true);
  assert.ok(parsed.provider);
  assert.ok(parsed.persona);
  assert.ok('memoryCount' in parsed);
  assert.ok('skillsCount' in parsed);
  assert.ok(parsed.serverVersion);
});

test('GET /api/providers lists configured providers with hasKey flag', async () => {
  const r = await request('GET', '/api/providers', null, { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.ok(Array.isArray(parsed));
  // Should include the major providers
  const ids = parsed.map(p => p.id);
  assert.ok(ids.includes('auto'));
  assert.ok(ids.includes('gemini'));
  assert.ok(ids.includes('claude'));
  assert.ok(ids.includes('openai'));
  // Every entry has the shape the PWA expects
  for (const p of parsed) {
    assert.ok('id' in p);
    assert.ok('hasKey' in p);
    assert.ok('model' in p);
  }
});

test('GET /api/memories returns the memories envelope', async () => {
  const r = await request('GET', '/api/memories?limit=5', null, { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.ok(Array.isArray(parsed.memories));
  assert.ok('total' in parsed);
});

test('GET /api/memories with q= still returns the envelope', async () => {
  const r = await request('GET', '/api/memories?q=anything&limit=3', null, { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.ok(Array.isArray(parsed.memories));
});

test('POST /api/settings updates persona + provider in one call', async () => {
  const r = await request('POST', '/api/settings', JSON.stringify({ persona: 'sage', provider: 'gemini' }),
    { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.updated.persona, 'sage');
  assert.equal(parsed.updated.provider, 'gemini');
  // Confirm the change actually landed in the store
  const s = await request('GET', '/api/status', null, { Authorization: 'Bearer ' + TOKEN });
  const sp = JSON.parse(s.body);
  assert.equal(sp.persona, 'sage');
  assert.equal(sp.provider, 'gemini');
});

test('POST /api/skill/:id/run on missing skill returns 404 JSON', async () => {
  const r = await request('POST', '/api/skill/does-not-exist/run', JSON.stringify({ task: 'noop' }),
    { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 404);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.error, 'skill not found');
});

test('GET /api/unknown returns JSON 404, NOT the PWA HTML', async () => {
  // Critical regression guard: the mobile PWA chokes if an /api/* path
  // accidentally falls through to the static-file server (it tries to
  // JSON.parse `<!doctype html...` and shows "Unexpected token '<'").
  const r = await request('GET', '/api/this-does-not-exist', null, { Authorization: 'Bearer ' + TOKEN });
  assert.equal(r.status, 404);
  assert.match(r.headers['content-type'], /application\/json/);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.error, 'not found');
  assert.equal(parsed.path, '/api/this-does-not-exist');
});

test('?token= query param is accepted as an Authorization fallback', async () => {
  // EventSource and some embedded WebViews can't set custom headers, so
  // we accept the token via query string too. Same constant-time check.
  const r = await request('GET', '/api/status?token=' + encodeURIComponent(TOKEN));
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.ok, true);
});

test('?token= with wrong value still returns 401', async () => {
  const r = await request('GET', '/api/status?token=wrong-value');
  assert.equal(r.status, 401);
});

test('GET / serves the PWA HTML (token NOT required for static)', async () => {
  const r = await request('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.body, /<title>Horizon AI/);
});
