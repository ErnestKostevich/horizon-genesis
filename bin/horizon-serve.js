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
//   GET    /api/status            mobile-friendly status snapshot:
//                                 {ok, online, provider, model, persona, lang, memoryCount,
//                                  skillsCount, serverVersion, nodeVersion, platform}.
//   GET    /api/skills            list of skills (full metadata)
//   GET    /api/personas          list of personas
//   GET    /api/providers         list of all configured providers with hasKey flag.
//   GET    /api/memories?limit=N&q=query
//                                 recent or searched memories: {memories:[...]}
//   GET    /api/mem/profile       user profile JSON
//   POST   /api/mem/search        body {query, limit, semantic?} → results
//   POST   /api/mem/forget        body {memory? | fact?} → ok
//   POST   /api/model             body {provider, model?} → ok
//   POST   /api/persona           body {id} → ok
//   POST   /api/settings          body {persona?, provider?, model?, lang?} → ok
//   POST   /api/skill/:id/run     body {task, max_steps?, reflect?} — run the agent loop with one
//                                 skill forced into the system prompt
//   GET    /api/health            ping
//
// Token can also be passed as `?token=X` query param for clients that
// can't set the Authorization header (e.g. EventSource probes from the
// PWA on browsers that don't support custom headers on EventSource).
//
// Auth: bearer token in `Authorization: Bearer <token>` header, where
// `<token>` is either the `--token X` CLI arg or `HORIZON_TOKEN` env var.
// If neither is set the server binds to 127.0.0.1 with a randomly
// generated token and prints it once at startup. Loopback-only without
// a token would still let a local malicious process hit the API, so we
// always require one. Token comparison is constant-time so a remote
// attacker can't time-discover the secret byte by byte.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { fmt } = require('./lib/tty');

// Where the PWA assets live relative to this file. Resolves both in
// repo-clone mode (./mobile) and bundled mode (snapshot via pkg).
const PWA_DIR = path.resolve(__dirname, '..', 'mobile');
const PWA_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

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

  // Phase 15 — Signal long-poll loop. WhatsApp is webhook-driven (see
  // /api/whatsapp/webhook handler).
  let signalLoopStop = null;
  if (flags?.['enable-signal']) {
    signalLoopStop = startSignalLoop(runtime);
    process.stderr.write(fmt.dim('signal runtime: started (5s long-poll)') + '\n');
  }
  // Phase 16 — iMessage inbound via chat.db polling on macOS.
  let imessageLoopStop = null;
  if (flags?.['enable-imessage']) {
    if (process.platform !== 'darwin') {
      process.stderr.write(fmt.err('--enable-imessage requires macOS') + '\n');
    } else {
      imessageLoopStop = startImessageLoop(runtime);
      process.stderr.write(fmt.dim('imessage runtime: started (3s chat.db poll)') + '\n');
    }
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
    if (fs.existsSync(PWA_DIR)) {
      const pwaUrl = `http://${host}:${port}/?url=http%3A%2F%2F${host}%3A${port}&token=${encodeURIComponent(token)}`;
      process.stderr.write(fmt.dim(`mobile PWA: ${pwaUrl}`) + '\n');
      process.stderr.write(fmt.dim('  open on your phone (same network) to install · token auto-prefilled') + '\n');
    }
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

/**
 * Constant-time token comparison. crypto.timingSafeEqual throws when the
 * two buffers differ in length, so we pad first.
 */
function safeTokenEqual(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');
  // Pad both to the longer length so timingSafeEqual accepts them.
  const len = Math.max(aBuf.length, bBuf.length, 1);
  const aPad = Buffer.alloc(len, 0); aBuf.copy(aPad);
  const bPad = Buffer.alloc(len, 0); bBuf.copy(bPad);
  // Still XOR-fold the original length difference so equal-length but
  // wrong tokens stay constant-time relative to longer wrong tokens.
  const eq = crypto.timingSafeEqual(aPad, bPad);
  return eq && aBuf.length === bBuf.length;
}

async function handle(req, res, runtime, expectedToken) {
  // CORS for browser clients on the same machine
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Phase 15 — Twilio WhatsApp webhook uses its own X-Twilio-Signature
  // auth (HMAC-SHA1), so it bypasses the Bearer-token gate. Verified
  // inside handleWhatsAppWebhook itself.
  if (pathname === '/api/whatsapp/webhook') {
    return handleWhatsAppWebhook(req, res, runtime);
  }

  // Auth — bearer token required on /api/*. We accept both
  // `Authorization: Bearer X` (preferred) and `?token=X` query param
  // (fallback for EventSource and the initial QR-pair hop).
  if (pathname.startsWith('/api/')) {
    const auth = req.headers['authorization'] || '';
    const headerToken = auth.replace(/^Bearer\s+/i, '').trim();
    const queryToken = url.searchParams.get('token') || '';
    const supplied = headerToken || queryToken;
    if (!safeTokenEqual(supplied, expectedToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  } else if (req.method === 'GET') {
    // Serve PWA static files. Token is NOT required for the app shell
    // itself — it's a tiny SPA that asks the user for the token at
    // startup. Once they enter it, /api/* calls carry the Bearer.
    const served = await tryServePwa(pathname, res);
    if (served) return;
  }

  try {
    if (pathname === '/api/health')       return json(res, 200, { ok: true, ts: Date.now() });
    if (pathname === '/api/version')      return versionEndpoint(res, runtime);
    if (pathname === '/api/status')       return statusEndpoint(res, runtime);
    if (pathname === '/api/skills')       return skillsEndpoint(res, runtime);
    if (pathname === '/api/personas')     return personasEndpoint(res, runtime);
    if (pathname === '/api/providers')    return providersEndpoint(res, runtime);
    if (pathname === '/api/memories')     return memoriesEndpoint(res, runtime, url);
    if (pathname === '/api/mem/profile')  return profileEndpoint(res, runtime);

    if (req.method === 'POST') {
      const body = await readJson(req);
      if (pathname === '/api/chat')       return chatEndpoint(res, runtime, body);
      if (pathname === '/api/agent')      return agentEndpoint(req, res, runtime, body);
      if (pathname === '/api/mem/search') return memSearch(res, runtime, body);
      if (pathname === '/api/mem/forget') return memForget(res, runtime, body);
      if (pathname === '/api/model')      return modelEndpoint(res, runtime, body);
      if (pathname === '/api/persona')    return personaEndpoint(res, runtime, body);
      if (pathname === '/api/settings')   return settingsEndpoint(res, runtime, body);
      // `/api/skill/:id/run` — dispatch by prefix match
      const skillMatch = pathname.match(/^\/api\/skill\/([^/]+)\/run$/);
      if (skillMatch) return skillRunEndpoint(req, res, runtime, decodeURIComponent(skillMatch[1]), body);
    }

    // /api/* paths must NEVER fall through to the static file server —
    // we always return JSON 404 here so clients get parseable errors.
    json(res, 404, { error: 'not found', path: pathname });
  } catch (e) {
    json(res, 500, { error: e.message || String(e) });
  }
}

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * Serve the PWA shell (mobile/index.html, app.js, app.css, etc).
 * Returns true if the request was handled, false to let the regular
 * /api/* routing take over.
 *
 * Path traversal guard: only paths that resolve INSIDE PWA_DIR are
 * served. Bare `/` → index.html.
 */
async function tryServePwa(pathname, res) {
  if (!fs.existsSync(PWA_DIR)) return false; // PWA bundle missing (dev install?)
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // `pwa/` prefix is supported for backward-compat
  if (rel.startsWith('pwa/')) rel = rel.slice(4);
  const target = path.resolve(PWA_DIR, rel);
  if (!target.startsWith(PWA_DIR)) return false; // path-traversal attempt
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    // For SPA-style routes (deep links) fall back to index.html so the
    // client-side router can pick them up — but only if it looks like
    // a real navigation (not a missing JS / CSS).
    if (pathname.startsWith('/api/')) return false;
    const ext = path.extname(rel);
    if (ext && ext !== '.html') return false;
    const indexFile = path.join(PWA_DIR, 'index.html');
    if (!fs.existsSync(indexFile)) return false;
    return serveFile(indexFile, res);
  }
  return serveFile(target, res);
}

function serveFile(file, res) {
  return new Promise((resolve) => {
    const ext = path.extname(file).toLowerCase();
    const mime = PWA_MIME[ext] || 'application/octet-stream';
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('read error');
        return resolve(true);
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      res.end(buf);
      resolve(true);
    });
  });
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

/**
 * Mobile-friendly snapshot. Shape stays small + flat so the PWA header
 * can read it without reaching into nested objects. `online: true`
 * doubles as a heartbeat — the PWA polls this for the green/red dot.
 */
function statusEndpoint(res, runtime) {
  const pkg = require('../package.json');
  const provider = runtime.settingsStore.get('provider') || 'gemini';
  let model = runtime.settingsStore.get('model.' + provider) || '';
  if (!model) {
    try {
      const { DEFAULT_PROVIDER_MODELS } = require('../src/main/runtime/ai-providers');
      model = DEFAULT_PROVIDER_MODELS[provider] || '';
    } catch (_) {}
  }
  json(res, 200, {
    ok: true,
    online: true,
    provider,
    model,
    persona: runtime.settingsStore.get('persona') || 'jarvis',
    lang: runtime.settingsStore.get('lang') || 'en',
    memoryCount: runtime.agentMemory?._data?.memories?.length || 0,
    factCount: Object.keys(runtime.agentMemory?._data?.facts || {}).length,
    skillsCount: runtime.skillsManager?.list().length || 0,
    serverVersion: pkg.version,
    nodeVersion: process.version,
    platform: process.platform,
    ts: Date.now(),
  });
}

function skillsEndpoint(res, runtime) {
  json(res, 200, runtime.skillsManager?.list() || []);
}

function personasEndpoint(res, runtime) {
  json(res, 200, runtime.personas?.getAllPersonas?.() || []);
}

/**
 * List the providers Horizon knows about, plus whether the user already
 * has a key configured for each. The PWA uses this to render the
 * provider dropdown so a phone install doesn't have to ship its own
 * hard-coded provider list (which goes stale every time we add a new
 * one).
 */
function providersEndpoint(res, runtime) {
  let providers = [];
  try {
    const { DEFAULT_PROVIDER_MODELS } = require('../src/main/runtime/ai-providers');
    const activeProvider = runtime.settingsStore.get('provider') || 'gemini';
    const localSet = new Set(['ollama', 'lmstudio', 'localai']);
    providers = Object.keys(DEFAULT_PROVIDER_MODELS).map(id => {
      const isLocal = localSet.has(id);
      // `hasKey`: either a stored key, OR a local provider with a URL set
      let hasKey = false;
      if (isLocal) {
        const urlKey = id === 'ollama' ? 'ollamaUrl'
                     : id === 'lmstudio' ? 'lmStudioUrl' : 'localAiUrl';
        hasKey = !!runtime.settingsStore.get(urlKey);
      } else {
        hasKey = !!runtime.keysStore.get('k_' + id);
      }
      const userModel = runtime.settingsStore.get('model.' + id);
      return {
        id,
        model: userModel || DEFAULT_PROVIDER_MODELS[id],
        defaultModel: DEFAULT_PROVIDER_MODELS[id],
        hasKey,
        local: isLocal,
        active: id === activeProvider,
      };
    });
    // Add 'auto' as a virtual choice that resolves at call time.
    providers.unshift({
      id: 'auto', model: '', defaultModel: '',
      hasKey: true, local: false, active: 'auto' === activeProvider,
    });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
  json(res, 200, providers);
}

/**
 * Recent memories OR search results, depending on whether `q=` is set.
 * Returns `{memories, total}`. The PWA's drawer reads this for the
 * "Memories: N" counter and the search panel.
 */
function memoriesEndpoint(res, runtime, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 200);
  const mem = runtime.agentMemory;
  if (!mem) return json(res, 503, { error: 'memory unavailable' });
  try {
    const total = mem._data?.memories?.length || 0;
    const memories = q ? mem.recall(q, limit) : mem.getRecent(limit);
    json(res, 200, {
      memories: memories.map(m => ({
        id: m.id, content: m.text || m.content || '', ts: m.created || m.ts || 0,
        importance: m.importance || 0, tags: m.tags || [],
      })),
      total,
    });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
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

/**
 * One-shot settings update — combines /api/persona + /api/model so the
 * PWA can save a whole Settings panel with one POST. All fields are
 * optional; missing ones are left alone.
 */
function settingsEndpoint(res, runtime, body) {
  const updated = {};
  if (body.persona)  { runtime.settingsStore.set('persona', String(body.persona));       updated.persona = body.persona; }
  if (body.provider) { runtime.settingsStore.set('provider', String(body.provider));     updated.provider = body.provider; }
  if (body.model && body.provider) {
    runtime.settingsStore.set('model.' + body.provider, String(body.model));
    updated.model = body.model;
  }
  if (body.lang)     { runtime.settingsStore.set('lang', String(body.lang));             updated.lang = body.lang; }
  json(res, 200, { ok: true, updated });
}

/**
 * Run the agent loop with one specific skill prepended to the system
 * prompt. SSE-capable just like /api/agent. Body: {task, max_steps?,
 * reflect?, history?}. Returns 404 if the skill id doesn't exist.
 */
async function skillRunEndpoint(req, res, runtime, skillId, body) {
  if (!body.task) return json(res, 400, { error: 'task required' });
  const skill = runtime.skillsManager?.get(skillId);
  if (!skill) return json(res, 404, { error: 'skill not found', skillId });
  const wantSse = (req.headers['accept'] || '').includes('text/event-stream');
  // Build a header that forces this skill into the prompt regardless of
  // matching score. Reuses the existing skillsBlock pipeline via the
  // augmented task description.
  const forcedTask = `[Skill: ${skillId}]\n${body.task}`;
  const runOpts = {
    history: body.history,
    maxSteps: body.max_steps || 8,
    reflect: body.reflect !== false,
    askPermission: async () => true,
  };

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
      const result = await runtime.runAgent(forcedTask, {
        ...runOpts,
        onStep: (event) => send('step', event),
      });
      send('end', {
        ok: !!result.ok,
        answer: result.answer,
        steps: result.steps?.length || 0,
        skill: skillId,
        error: result.error || null,
      });
    } catch (e) {
      send('end', { ok: false, error: e.message, skill: skillId });
    }
    res.end();
    return;
  }

  const result = await runtime.runAgent(forcedTask, runOpts);
  json(res, 200, {
    ok: !!result.ok,
    answer: result.answer,
    steps: result.steps?.length || 0,
    skill: skillId,
    error: result.error || null,
  });
}

// ── Phase 15 channel live-runtime helpers ──────────────────────────────

/**
 * Start a 5s long-poll loop that pulls pending Signal messages, feeds
 * each one through the AI agent, and posts the reply back via the same
 * signal bridge. Returns a stop() function.
 *
 * Mirrors the structure of connectionsManager.startTelegramRuntime but
 * lives here in serve.js because the desktop GUI version of the
 * runtime hasn't been wired (Signal is a "headless-only" channel for
 * now — users running it are usually on a server anyway).
 */
function startSignalLoop(runtime) {
  const signal = require('../src/main/channels/signal');
  let cancelled = false;
  const cfg = () => ({
    url:    runtime.settingsStore.get('signal.url'),
    number: runtime.settingsStore.get('signal.number'),
  });
  async function tick() {
    if (cancelled) return;
    try {
      const c = cfg();
      if (!c.url || !c.number) {
        // Not configured yet — back off
        return setTimeout(tick, 30_000);
      }
      const r = await signal.receiveMessages(c, { timeoutMs: 10_000 });
      if (r.ok && r.messages?.length) {
        for (const m of r.messages) {
          // Feed into the AI agent, then reply
          try {
            const reply = await runtime.runChat(m.text, {
              source: 'signal',
              skipLearn: false,
            });
            if (reply.reply) {
              await signal.sendMessage(c, {
                to: m.groupId || m.user.id,
                text: reply.reply.slice(0, 2000),
              });
            }
          } catch (e) {
            process.stderr.write(`signal handler error: ${e.message}\n`);
          }
        }
      }
    } catch (e) {
      process.stderr.write(`signal loop error: ${e.message}\n`);
    }
    if (!cancelled) setTimeout(tick, 5_000);
  }
  setTimeout(tick, 1_000);
  return () => { cancelled = true; };
}

/**
 * Phase 16 — iMessage inbound loop. Polls ~/Library/Messages/chat.db
 * via sqlite3 every 3 seconds for messages with rowid > lastSeenRowid.
 * For each new message: run through the AI agent, reply via osascript.
 *
 * Returns a stop() function. Cancellation is cooperative — the next
 * tick after stop() is called will not fire.
 *
 * Permission gotcha: macOS denies chat.db reads unless the host
 * terminal has Full Disk Access. First call surfaces the error and
 * we back off to 30s polling.
 */
function startImessageLoop(runtime) {
  const imessage = require('../src/main/channels/imessage');
  let cancelled = false;
  let lastRowid = Number(runtime.settingsStore.get('imessage.lastRowid')) || 0;
  let intervalMs = 3_000;

  async function tick() {
    if (cancelled) return;
    try {
      const r = await imessage.receiveMessages({ lastRowid, limit: 20 });
      if (!r.ok) {
        if (intervalMs < 30_000) intervalMs *= 2;
        if (/Full Disk Access/i.test(r.error || '')) {
          process.stderr.write('imessage: ' + r.error + '\n');
        }
      } else {
        intervalMs = 3_000;
        if (r.messages.length) {
          for (const m of r.messages) {
            try {
              const reply = await runtime.runChat(m.text, { source: 'imessage' });
              if (reply.reply) {
                // Reply via the same buddy — group vs 1:1 handled in adapter
                if (m.groupId) {
                  await imessage.sendToChat({ chatId: m.groupId, text: reply.reply.slice(0, 1500) });
                } else {
                  await imessage.sendMessage({ to: m.user.id, text: reply.reply.slice(0, 1500) });
                }
              }
            } catch (e) {
              process.stderr.write(`imessage handler error: ${e.message}\n`);
            }
          }
          lastRowid = r.latestRowid;
          // Persist lastRowid so we don't re-process messages after restart
          try { runtime.settingsStore.set('imessage.lastRowid', lastRowid); } catch (_) {}
        }
      }
    } catch (e) {
      process.stderr.write(`imessage loop error: ${e.message}\n`);
      if (intervalMs < 30_000) intervalMs *= 2;
    }
    if (!cancelled) setTimeout(tick, intervalMs);
  }
  setTimeout(tick, 1_500);
  return () => { cancelled = true; };
}

/**
 * Handle inbound Twilio WhatsApp webhook. Twilio POSTs form-urlencoded
 * data with X-Twilio-Signature header. We verify the signature, parse
 * the form, run the agent, return TwiML so the user sees the reply
 * inside their WhatsApp app.
 *
 * Wired into handle() before the auth gate because Twilio doesn't send
 * a Bearer token — it sends its own signature instead.
 */
async function handleWhatsAppWebhook(req, res, runtime) {
  if (req.method !== 'POST') {
    res.writeHead(405); res.end('method not allowed'); return;
  }
  const whatsapp = require('../src/main/channels/whatsapp');
  const authToken = runtime.keysStore.get('k_twilio_token');
  if (!authToken) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('whatsapp not configured');
    return;
  }
  // Read raw body
  let body = '';
  await new Promise((resolve, reject) => {
    req.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', resolve);
    req.on('error', reject);
  });
  // Parse form
  const params = {};
  for (const pair of body.split('&')) {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' '));
  }
  // Verify signature
  const sig = req.headers['x-twilio-signature'] || '';
  const fullUrl = `https://${req.headers.host}${req.url}`;
  if (sig && !whatsapp.verifyWebhookSignature({ authToken, url: fullUrl, params, signature: sig })) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('bad signature');
    return;
  }
  // Parse event + run agent
  const ev = whatsapp.parseInboundWebhook(params);
  let replyText = '';
  try {
    const r = await runtime.runChat(ev.text || '(empty message)', { source: 'whatsapp' });
    replyText = r.reply || r.error || '';
  } catch (e) {
    replyText = 'Error: ' + e.message;
  }
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(whatsapp.buildTwimlResponse(replyText.slice(0, 1500)));
}

module.exports = { main };

if (require.main === module) {
  const { parseArgv } = require('./lib/argv');
  const flags = parseArgv(process.argv.slice(2), {
    aliases: { p: 'port', t: 'token', h: 'host' },
    booleans: ['verbose', 'enable-tg', 'enable-discord', 'enable-signal',
               'enable-whatsapp', 'enable-imessage'],
  });
  main({ flags }).catch(e => {
    process.stderr.write(fmt.err(e.stack || e.message) + '\n');
    process.exit(1);
  });
}
