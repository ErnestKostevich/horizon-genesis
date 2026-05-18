#!/usr/bin/env node
// horizon serve — headless HTTP API server.
//
// Why: lets a mobile PWA, cron job, or another machine on the LAN hit the
// same agent runtime the desktop GUI uses. No Electron window required.
//
// Built on Node's stdlib http + a tiny custom router. We deliberately
// avoid pulling express in: it's a 60-package transitive tree, and all we
// need is JSON POST + Server-Sent Events. The implementation here fits in
// under 300 lines.
//
// Endpoints (all under /api):
//   POST   /api/chat              body {message, history?, provider?, model?, persona?} → {reply, model, usage}
//   POST   /api/agent             body {task, history?, max_steps?, reflect?, provider?, model?, persona?}
//                                 If `Accept: text/event-stream` is set the response is an SSE stream
//                                 emitting one step per event + a final `run-end`. Otherwise it
//                                 buffers the run and returns the JSON result.
//   GET    /api/version           same payload as `horizon version --json`
//   GET    /api/skills            list of skills (full metadata)
//   GET    /api/personas          list of personas
//   GET    /api/mem/profile       user profile JSON
//   POST   /api/mem/search        body {query, limit, semantic?} → results
//   POST   /api/mem/forget        body {memory? | fact?} → ok
//   POST   /api/model             body {provider, model?} → ok
//   POST   /api/persona           body {id} → ok
//   GET    /api/health            ping
//
// Auth: bearer token in `Authorization: Bearer <token>` header, where
// `<token>` is either the `--token X` CLI arg or `HORIZON_TOKEN` env var.
// If neither is set the server binds to 127.0.0.1 with a randomly
// generated token and prints it once at startup. Loopback-only without
// a token would still let a local malicious process hit the API, so we
// always require one.

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { fmt } = require('./lib/tty');

async function main({ flags } = {}) {
  const port = Number(flags?.port || process.env.HORIZON_PORT || 18789);
  const host = flags?.host || process.env.HORIZON_HOST || '127.0.0.1';
  const token = flags?.token || process.env.HORIZON_TOKEN || crypto.randomBytes(16).toString('hex');

  const { createHorizonRuntime } = require('../src/main/runtime/headless');
  const runtime = createHorizonRuntime({
    userDataDir: flags?.['user-data-dir'],
    workspaceDir: flags?.workspace || process.cwd(),
    verbose: !!flags?.verbose,
  });

  if (flags?.['enable-tg']) {
    try {
      const r = await runtime.connectionsManager?.startTelegramRuntime();
      process.stderr.write(fmt.dim(`telegram runtime: ${r?.ok ? 'started' : 'failed: ' + (r?.error || '?')}`) + '\n');
    } catch (e) { process.stderr.write(fmt.err('telegram start: ' + e.message) + '\n'); }
  }
  if (flags?.['enable-discord']) {
    try {
      const r = await runtime.connectionsManager?.startDiscordRuntime();
      process.stderr.write(fmt.dim(`discord runtime: ${r?.ok ? 'started' : 'failed: ' + (r?.error || '?')}`) + '\n');
    } catch (e) { process.stderr.write(fmt.err('discord start: ' + e.message) + '\n'); }
  }

  const server = http.createServer((req, res) => handle(req, res, runtime, token));
  server.listen(port, host, () => {
    process.stderr.write(fmt.ok(`Horizon serve  http://${host}:${port}`) + '\n');
    process.stderr.write(fmt.dim(`token: ${token}`) + '\n');
    if (!flags?.token && !process.env.HORIZON_TOKEN) {
      process.stderr.write(
        fmt.warn('(token was auto-generated — pass --token X or set HORIZON_TOKEN for a stable value)') + '\n'
      );
    }
    process.stderr.write(fmt.dim(`workspace: ${runtime.workspaceDir}`) + '\n');
  });

  // Graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      process.stderr.write('\n' + fmt.dim('shutting down…') + '\n');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 3000).unref();
    });
  }
  return 0;
}

async function handle(req, res, runtime, expectedToken) {
  // CORS for browser clients on the same machine
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Auth — bearer token required on /api/*
  if (pathname.startsWith('/api/')) {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== expectedToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  try {
    if (pathname === '/api/health') return json(res, 200, { ok: true, ts: Date.now() });
    if (pathname === '/api/version') return versionEndpoint(res, runtime);
    if (pathname === '/api/skills') return skillsEndpoint(res, runtime);
    if (pathname === '/api/personas') return personasEndpoint(res, runtime);
    if (pathname === '/api/mem/profile') return profileEndpoint(res, runtime);

    if (req.method === 'POST') {
      const body = await readJson(req);
      if (pathname === '/api/chat') return chatEndpoint(res, runtime, body);
      if (pathname === '/api/agent') return agentEndpoint(req, res, runtime, body);
      if (pathname === '/api/mem/search') return memSearch(res, runtime, body);
      if (pathname === '/api/mem/forget') return memForget(res, runtime, body);
      if (pathname === '/api/model') return modelEndpoint(res, runtime, body);
      if (pathname === '/api/persona') return personaEndpoint(res, runtime, body);
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message || String(e) });
  }
}

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', chunk => { buf += chunk; if (buf.length > 10 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function versionEndpoint(res, runtime) {
  const pkg = require('../package.json');
  json(res, 200, {
    version: pkg.version,
    name: pkg.name,
    nodeVersion: process.version,
    platform: process.platform,
    provider: runtime.settingsStore.get('provider'),
    persona: runtime.settingsStore.get('persona'),
    memory: {
      memories: runtime.agentMemory?._data?.memories?.length || 0,
      facts: Object.keys(runtime.agentMemory?._data?.facts || {}).length,
    },
    skills: runtime.skillsManager?.list().length || 0,
    embeddings: runtime.embeddingService?.status() || { available: false },
    executor: runtime.executor?.status() || null,
  });
}

function skillsEndpoint(res, runtime) {
  json(res, 200, runtime.skillsManager?.list() || []);
}

function personasEndpoint(res, runtime) {
  json(res, 200, runtime.personas?.getAllPersonas?.() || []);
}

function profileEndpoint(res, runtime) {
  json(res, 200, runtime.agentMemory.getUserProfile());
}

async function chatEndpoint(res, runtime, body) {
  if (!body.message) return json(res, 400, { error: 'message required' });
  const r = await runtime.runChat(body.message, {
    history: body.history,
    provider: body.provider,
    model: body.model,
    persona: body.persona,
  });
  json(res, r.error ? 502 : 200, r);
}

async function agentEndpoint(req, res, runtime, body) {
  if (!body.task) return json(res, 400, { error: 'task required' });
  const wantSse = (req.headers['accept'] || '').includes('text/event-stream');

  if (wantSse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const result = await runtime.runAgent(body.task, {
        history: body.history,
        maxSteps: body.max_steps || 8,
        reflect: body.reflect !== false,
        provider: body.provider,
        model: body.model,
        persona: body.persona,
        onStep: (event) => send('step', event),
        askPermission: async () => true, // server mode auto-approves;
                                          // production deployments should
                                          // gate by token scope or push
                                          // notification (Phase 6 plan)
      });
      send('end', {
        ok: !!result.ok,
        answer: result.answer,
        steps: result.steps?.length || 0,
        stopped: !!result.stopped,
        error: result.error || null,
      });
    } catch (e) {
      send('end', { ok: false, error: e.message });
    }
    res.end();
    return;
  }

  // Buffered response
  const result = await runtime.runAgent(body.task, {
    history: body.history,
    maxSteps: body.max_steps || 8,
    reflect: body.reflect !== false,
    provider: body.provider,
    model: body.model,
    persona: body.persona,
    askPermission: async () => true,
  });
  json(res, 200, {
    ok: !!result.ok,
    answer: result.answer,
    steps: result.steps?.length || 0,
    stopped: !!result.stopped,
    error: result.error || null,
  });
}

async function memSearch(res, runtime, body) {
  if (!body.query) return json(res, 400, { error: 'query required' });
  const r = body.semantic === false
    ? runtime.agentMemory.recall(body.query, body.limit || 10)
    : await runtime.agentMemory.semanticRecall(body.query, body.limit || 10, {});
  json(res, 200, r);
}

function memForget(res, runtime, body) {
  const id = body.memory || body.fact;
  if (!id) return json(res, 400, { error: 'memory or fact id required' });
  const ok = runtime.agentMemory.forgetMemory(id);
  json(res, ok ? 200 : 404, { ok });
}

function modelEndpoint(res, runtime, body) {
  if (!body.provider) return json(res, 400, { error: 'provider required' });
  runtime.settingsStore.set('provider', body.provider);
  if (body.model) runtime.settingsStore.set('model.' + body.provider, body.model);
  json(res, 200, { ok: true, provider: body.provider, model: body.model });
}

function personaEndpoint(res, runtime, body) {
  if (!body.id) return json(res, 400, { error: 'id required' });
  runtime.settingsStore.set('persona', body.id);
  json(res, 200, { ok: true, persona: body.id });
}

module.exports = { main };

if (require.main === module) {
  const { parseArgv } = require('./lib/argv');
  const flags = parseArgv(process.argv.slice(2), {
    aliases: { p: 'port', t: 'token', h: 'host' },
    booleans: ['verbose', 'enable-tg', 'enable-discord'],
  });
  main({ flags }).catch(e => {
    process.stderr.write(fmt.err(e.stack || e.message) + '\n');
    process.exit(1);
  });
}
