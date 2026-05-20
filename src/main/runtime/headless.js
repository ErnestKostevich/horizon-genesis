// Headless runtime — the same agent stack the Electron app boots, minus
// anything that needs a BrowserWindow / ipcMain / Tray / dialog. The CLI,
// the TUI, and `horizon serve` all build off `createHorizonRuntime` so
// they share one wiring spec.
//
// What's loaded (matches the subset of main.js loadAgentModules that
// makes sense without a renderer):
//   - keysStore + settingsStore via the store-shim (reads the exact same
//     JSON files the Electron app writes)
//   - AgentMemory + EmbeddingService + FTS index (full 8-type memory)
//   - WorkspaceMemory (the .horizon/memory.json auto-loader)
//   - SkillsManager scanning workspace / user / builtin scopes
//   - Personas
//   - Executor (host or docker)
//   - ConnectionsManager (Slack/Notion/Linear/Telegram/Discord tools —
//     bot runtimes off by default in CLI; they're only spun up if the
//     CLI explicitly enables them, e.g. `horizon serve --enable-tg`)
//   - createAiClient → handed to runAgentLoop as `aiFn`
//   - dispatchTool wrapper that routes to agent.dispatchTool with the
//     same ctx shape main.js builds (executor, browserManager, etc).
//
// What's NOT loaded:
//   - MCPManager + MCPRegistry — these touch IPC handlers for discovery.
//     A future iteration can wire a CLI variant.
//   - BrowserManager — playwright bring-up is heavy; CLI users tend to
//     not need it. Off by default; opt-in by `--with-browser`.
//   - PluginManager — same reason, opt-in via `--with-plugins`.
//   - WorkflowEngine — same, opt-in.
//   - ScreenRecorder / GitHub connector — niche, off.
//   - SkillSuggester — emits to BrowserWindow, no-op in CLI.

const path = require('path');
const fs = require('fs');

const { initStores, defaultUserDataDir } = require('./store-shim');
const { createAiClient } = require('./ai-providers');
const { CostTracker } = require('./cost-tracker');

// Provider preference order for `--provider auto`. Picks the first one
// that has a key configured (or is a local provider). Order = "cheap +
// reliable first". Local providers come first; then platforms with free
// tiers; then cheap paid; then premium.
const AUTO_ORDER = [
  // Free / local
  'ollama', 'lmstudio', 'localai',
  // Free-tier capable
  'gemini', 'groq', 'cerebras',
  // Cheap paid
  'deepinfra', 'deepseek', 'fireworks', 'together', 'sambanova', 'nebius',
  'moonshot', 'mistral', 'zai',
  // Aggregators
  'openrouter',
  // Premium
  'claude', 'openai',
];

function safeRequire(modulePath) {
  try { return require(modulePath); } catch (e) { return { __error: e.message }; }
}

/**
 * Build the headless runtime.
 *
 * @param {object} [opts]
 * @param {string} [opts.userDataDir] — override electron-store location
 * @param {string} [opts.workspaceDir] — process.cwd() by default; .horizon/
 *                                       is read from here
 * @param {boolean} [opts.withBrowser=false]
 * @param {boolean} [opts.withPlugins=false]
 * @param {boolean} [opts.withWorkflows=false]
 * @param {boolean} [opts.withConnections=true] — enables Slack/Notion/Linear
 *                                                tool dispatch (read API
 *                                                tokens from keysStore).
 *                                                Bot runtimes (Telegram/Discord
 *                                                Gateway) stay OFF; spin them
 *                                                up explicitly via
 *                                                `connectionsManager.startTelegramRuntime()` etc.
 * @param {boolean} [opts.verbose=false] — log boot diagnostics to stderr
 *
 * @returns {object} runtime  — see properties below
 */
function createHorizonRuntime(opts = {}) {
  const userDataDir = opts.userDataDir || defaultUserDataDir();
  const workspaceDir = opts.workspaceDir || process.cwd();
  const verbose = !!opts.verbose;

  // Make sure userDataDir exists — first-time CLI usage on a clean
  // machine should create it instead of crashing later when AgentMemory
  // tries to write its db file.
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (_) {}

  const log = (...a) => { if (verbose) console.error('[horizon]', ...a); };

  // ── Stores ────────────────────────────────────────────────────────────
  const { keysStore, settingsStore } = initStores({ userDataDir });
  log('stores ready @', userDataDir);

  // Expose them on the agent.js module cache the same way main.js does
  // — agentLoop reaches into main's exports for settingsStore. We mimic
  // that by setting the property on the agent module's exports.
  const agentModule = require('../agent');
  // Some sibling modules pull settingsStore via require.cache['./main']
  // — that won't be present in CLI, but agent.js itself reads it from a
  // mediator object we attach.
  try {
    // best-effort: attach store handles to the running main module ref
    // if it happens to be loaded (it won't be in pure CLI).
    const mainCache = require.cache[require.resolve('../main')];
    if (mainCache?.exports) {
      mainCache.exports.settingsStore = settingsStore;
      mainCache.exports.keysStore = keysStore;
    }
  } catch (_) { /* main.js not loaded — expected in CLI */ }

  // ── Memory ────────────────────────────────────────────────────────────
  const { AgentMemory, dispatchTool, TOOL_DEFINITIONS, setMemoryInstance } = agentModule;
  const memDbPath = path.join(userDataDir, 'horizon_memory.db');
  const agentMemory = new AgentMemory(memDbPath);
  agentMemory.init();
  setMemoryInstance(agentMemory);
  log('memory:', agentMemory._data?.memories?.length || 0, 'memories');

  // Embeddings — same setup as main.js, but no progress broadcast.
  let embeddingService = null;
  try {
    const { EmbeddingService } = require('../embeddings');
    embeddingService = new EmbeddingService({
      keysStore, settingsStore,
      memoryPath: memDbPath.replace(/\.db$/, '.json'),
    });
    agentMemory.setEmbeddingService(embeddingService);
    log('embeddings:', embeddingService.status().available ? 'ready' : 'no key');
  } catch (e) {
    log('embeddings unavailable:', e.message);
  }

  // PHASE 28.2 — SQLite + FTS5 backend (the second half of the hybrid).
  // CLI and headless `horizon serve` now mirror the JSON file into a
  // queryable SQLite database on first run, then keep it live-synced via
  // AgentMemory.setMemoryDb(). Without this, CLI users only got the
  // JSON + in-memory FTS half and the inspector's "Hybrid" claim wasn't
  // honest from the shell.
  try {
    const fs = require('fs');
    const jsonPath = memDbPath.replace(/\.db$/, '.json');
    const sqlitePath = path.join(userDataDir, 'memory.sqlite');
    let shouldMirror = false;
    if (fs.existsSync(jsonPath)) {
      if (!fs.existsSync(sqlitePath)) shouldMirror = true;
      else {
        const j = fs.statSync(jsonPath).mtimeMs;
        const s = fs.statSync(sqlitePath).mtimeMs;
        if (j > s + 1000) shouldMirror = true;
      }
    }
    if (shouldMirror) {
      const { migrateJsonToSqlite } = require('./migrateJsonToSqlite');
      const r = migrateJsonToSqlite({ jsonPath, dbPath: sqlitePath, backup: false });
      if (r.ok) log(`memory.sqlite refreshed (+${r.added?.memories || 0} mem, +${r.added?.facts || 0} facts, +${r.added?.conversations || 0} conv)`);
      else log('SQLite mirror skipped:', r.error);
    }
    if (fs.existsSync(sqlitePath)) {
      const { MemoryDb } = require('../memoryDb');
      const liveDb = new MemoryDb(sqlitePath).open();
      agentMemory.setMemoryDb(liveDb);
      log('memoryDb: live SQLite + FTS5 wired');
    }
  } catch (e) {
    log('SQLite hybrid unavailable:', e.message);
  }

  // PHASE 28.4 — DialecticModel (9th memory layer, Honcho-style). The
  // CLI gets the same store as Electron; extractor uses whatever AI
  // provider the user already configured. Sampling caps token cost so
  // a `horizon agent "long task"` doesn't 2× its bill.
  let dialecticModel = null;
  try {
    const { DialecticModel } = require('../dialecticModel');
    const path = require('path');
    const dialecticPath = path.join(userDataDir, 'horizon_dialectic.json');
    dialecticModel = new DialecticModel(dialecticPath).init();
    if (typeof agentMemory.setDialecticModel === 'function') {
      agentMemory.setDialecticModel(dialecticModel);
    } else {
      agentMemory.dialectic = dialecticModel;
    }
    // CLI extractor: skip when AGENT_NO_DIALECTIC=1 (test runs, batch
    // scripts that don't want a 2nd LLM call per turn).
    if (!process.env.AGENT_NO_DIALECTIC && typeof agentMemory.setDialecticExtractor === 'function') {
      agentMemory.setDialecticExtractor(async (user, assistant, recent) => {
        // Defer to the same helper the Electron path uses. We require it
        // lazily so the CLI doesn't depend on Electron's main.js.
        try {
          const extract = require('./dialecticExtractor');
          return await extract({ user, assistant, recent, settingsStore, keysStore });
        } catch (e) {
          log('dialectic extractor unavailable:', e.message);
          return [];
        }
      });
    }
    log(`dialectic loaded (${dialecticModel.records.length} records${process.env.AGENT_NO_DIALECTIC ? ', extractor off' : ', extractor on'})`);
  } catch (e) {
    log('dialectic unavailable:', e.message);
  }

  // PHASE 28.3 — Memory reviewer (Hermes-style periodic curation).
  // CLI starts it the same way Electron does. For short-lived `horizon
  // chat` invocations it won't fire (1h first-run delay), but `horizon
  // serve` running 24/7 benefits.
  let memoryReviewer = null;
  try {
    const { MemoryReviewer } = require('../memoryReviewer');
    memoryReviewer = new MemoryReviewer(agentMemory);
    memoryReviewer.start();
    log('memory reviewer scheduled (first pass in ~1h, then every 12h)');
  } catch (e) {
    log('memory reviewer unavailable:', e.message);
  }

  // ── Workspace memory ──────────────────────────────────────────────────
  let workspaceMemory = null;
  try {
    const { WorkspaceMemory } = require('../workspaceMemory');
    workspaceMemory = new WorkspaceMemory();
    log('workspace memory module loaded');
  } catch (e) { log('workspace memory failed:', e.message); }

  // ── Personas ──────────────────────────────────────────────────────────
  let personas = null;
  try {
    personas = require('../personas');
    if (typeof personas.setOverlayStore === 'function') personas.setOverlayStore(settingsStore);
    log('personas loaded');
  } catch (e) { log('personas failed:', e.message); }

  // ── Executor ──────────────────────────────────────────────────────────
  let executor = null;
  try {
    const { Executor } = require('../executor');
    executor = new Executor({ settingsStore, workspaceProvider: () => workspaceDir });
    log('executor:', executor.status().mode);
  } catch (e) { log('executor failed:', e.message); }

  // ── Skills ────────────────────────────────────────────────────────────
  let skillsManager = null;
  try {
    const { SkillsManager } = require('../skillsManager');
    skillsManager = new SkillsManager({
      userDir: path.join(userDataDir, 'skills'),
      builtinDir: path.join(__dirname, '..', '..', '..', 'builtin-skills'),
      workspaceProvider: () => workspaceDir,
      settingsStore,
    });
    skillsManager.loadAll();
    try { skillsManager.installAllBuiltins(); } catch (_) {}
    log('skills:', skillsManager.list().length);
  } catch (e) { log('skills manager failed:', e.message); }

  // ── Connections ───────────────────────────────────────────────────────
  let connectionsManager = null;
  if (opts.withConnections !== false) {
    try {
      const { ConnectionsManager } = require('../connectionsManager');
      connectionsManager = new ConnectionsManager(keysStore, settingsStore);
      // Wire a reply function so Telegram/Discord runtimes — if the user
      // opts into them — can complete via the same AI client.
      connectionsManager.setReplyFn(async ({ messages, system }) => {
        const provider = settingsStore.get('provider') || 'gemini';
        const res = await aiClient.complete(messages || [], { provider, system: system || '' });
        return { ...res, provider, text: res?.reply || res?.error || '' };
      });
      // No event bridge needed for CLI — events are surfaced via
      // runtime.onConnectionEvent if the consumer wants them.
      log('connections manager loaded');
    } catch (e) { log('connections manager failed:', e.message); }
  }

  // ── AI client ─────────────────────────────────────────────────────────
  const aiClient = createAiClient({ keysStore, settingsStore });

  // ── Cost tracker ─────────────────────────────────────────────────────
  const costTracker = new CostTracker(userDataDir);

  /**
   * Pick a provider when caller passed `auto`. Walks AUTO_ORDER and
   * returns the first one that's actually usable on this install
   * (key set, or local provider).
   */
  function resolveAutoProvider() {
    for (const id of AUTO_ORDER) {
      if (['ollama', 'lmstudio', 'localai'].includes(id)) {
        // Local providers — assume usable; we'll fail fast at call time
        // if the daemon isn't running. Only return local if user has
        // explicitly configured a URL — otherwise prefer hosted Gemini
        // which "just works" with a key.
        const urlKey = id === 'ollama' ? 'ollamaUrl'
                     : id === 'lmstudio' ? 'lmStudioUrl' : 'localAiUrl';
        if (settingsStore.get(urlKey)) return id;
        continue;
      }
      if (keysStore.get('k_' + id)) return id;
    }
    return settingsStore.get('provider') || 'gemini';
  }

  // Wrap aiClient.complete + completeStream to record usage automatically.
  const _origComplete = aiClient.complete;
  aiClient.complete = async (messages, opts = {}) => {
    if (opts.provider === 'auto') opts = { ...opts, provider: resolveAutoProvider() };
    const r = await _origComplete(messages, opts);
    if (r && r.usage) {
      try {
        costTracker.record({
          provider: opts.provider || settingsStore.get('provider') || 'gemini',
          model: r.model,
          usage: r.usage,
          source: opts.source || 'cli',
        });
      } catch (_) {}
    }
    return r;
  };
  const _origStream = aiClient.completeStream;
  aiClient.completeStream = async (messages, opts = {}, onToken) => {
    if (opts.provider === 'auto') opts = { ...opts, provider: resolveAutoProvider() };
    const r = await _origStream(messages, opts, onToken);
    if (r && r.usage) {
      try {
        costTracker.record({
          provider: opts.provider || settingsStore.get('provider') || 'gemini',
          model: r.model,
          usage: r.usage,
          source: opts.source || 'cli-stream',
        });
      } catch (_) {}
    }
    return r;
  };

  // ── Agent loop ────────────────────────────────────────────────────────
  const agentLoopModule = safeRequire('../agentLoop');
  if (agentLoopModule.__error) log('agentLoop failed:', agentLoopModule.__error);

  /**
   * Compose the same system prompt main.js's runAiCompletion would build:
   * identity + persona + caller-supplied system.
   */
  function buildSystemPrompt({ lang, persona, system } = {}) {
    const userName = settingsStore.get('userName') || 'user';
    const langCode = lang || settingsStore.get('lang') || 'en';
    const identity = langCode === 'ru'
      ? `Ты — Хорайзон (Horizon AI), персональный AI-агент. Создан Эрнестом Костевичем. Пользователь: ${userName}. Время: ${new Date().toLocaleString()}.`
      : `You are Horizon AI — a personal desktop agent. Created by Ernest Kostevich. User: ${userName}. Time: ${new Date().toLocaleString()}.`;
    const parts = [identity];
    try {
      if (personas) {
        const personaId = persona || settingsStore.get('persona') || 'jarvis';
        const pp = personas.getPersonaPrompt(personaId, langCode);
        if (pp) parts.push(pp);
      }
    } catch (_) { /* persona injection optional */ }
    if (system) parts.push(system);
    return parts.join('\n\n');
  }

  /**
   * Run the full agent loop. Mirrors the IPC `agentRun` handler in main.js
   * but with CLI-friendly callbacks instead of `webContents.send`.
   *
   * @param {string} task
   * @param {object} opts
   * @param {Function} [opts.onStep]  — called with each step event
   * @param {Function} [opts.askPermission]  — async ({tool,args,reason}) → bool
   * @param {number} [opts.maxSteps=8]
   * @param {number} [opts.timeout=900000]
   * @param {boolean} [opts.reflect=true]
   * @param {string} [opts.provider] — override provider for this run
   * @param {string} [opts.model]
   * @param {string} [opts.persona]
   * @param {Array} [opts.history=[]]
   */
  async function runAgent(task, opts = {}) {
    if (!agentLoopModule.runAgentLoop) {
      throw new Error('agentLoop unavailable: ' + (agentLoopModule.__error || 'unknown'));
    }
    const provider = opts.provider || settingsStore.get('provider') || 'gemini';
    const lang = opts.lang || settingsStore.get('lang') || 'en';

    // Build per-call wrappers ───────────────────────────────────────────
    const aiFn = aiClient.asAgentAiFn({ provider, model: opts.model });

    // Skills block — pick relevant skills for the task and inject as the
    // big "Skills available right now" markdown chunk.
    let skillsBlock = '';
    try {
      if (skillsManager) {
        const r = skillsManager.getSkillsBlock(task, { lang });
        skillsBlock = r?.block || '';
      }
    } catch (_) {}

    // Workspace memory block — pulled from .horizon/memory.json
    let workspaceBlock = '';
    try {
      if (workspaceMemory) workspaceBlock = workspaceMemory.buildSystemBlock(workspaceDir);
    } catch (_) {}

    // Persona prompt for the loop's system builder
    let personaPrompt = '';
    try {
      if (personas) {
        const personaId = opts.persona || settingsStore.get('persona') || 'jarvis';
        personaPrompt = personas.getPersonaPrompt(personaId, lang) || '';
      }
    } catch (_) {}

    // dispatchTool — same context shape main.js builds, minus the IPC
    // sender (permission gate uses opts.askPermission instead).
    const dispatchToolFn = async (name, args) => {
      const ctx = {
        sender: null, // no Electron sender; permission resolved by askPermission
        executor,
        browserManager: null,
        agentMemory,
        skillsManager,
        connectionsManager,
        settingsStore,
        keysStore,
        workspaceDir,
        // Permission gate: if the caller registered one, call it; otherwise
        // auto-approve (the agent loop's `control.beforeTool` is the
        // primary gating layer in CLI).
        async withPermission(tool, _args, reason, fn) {
          if (typeof opts.askPermission === 'function') {
            const ok = await opts.askPermission({ tool, args: _args, reason });
            if (!ok) return { ok: false, denied: true, error: 'Denied by user' };
          }
          return fn();
        },
      };
      try {
        return await dispatchTool(name, args || {}, ctx);
      } catch (e) {
        return { ok: false, err: e.message || String(e) };
      }
    };

    // Step rail — forward to caller and append to agentMemory if asked.
    const history = Array.isArray(opts.history) ? opts.history : [];

    const result = await agentLoopModule.runAgentLoop(task, {
      aiFn,
      sysInfo: { provider, model: opts.model, workspaceDir },
      lang,
      userName: settingsStore.get('userName') || 'user',
      history,
      maxSteps: opts.maxSteps || 8,
      timeout: opts.timeout || 900000,
      onStep: opts.onStep || (() => {}),
      personaPrompt,
      skillsBlock: [workspaceBlock, skillsBlock].filter(Boolean).join('\n\n'),
      nativeTools: false,
      dispatchToolFn,
      reflect: opts.reflect !== false,
      control: {
        beforeTool: async ({ tool, args, reason }) => {
          if (typeof opts.askPermission === 'function') {
            const ok = await opts.askPermission({ tool, args, reason });
            return ok ? { ok: true } : { ok: false, error: 'Denied' };
          }
          return { ok: true };
        },
        isStopped: () => false,
        isPaused: () => false,
      },
    });

    // Best-effort: feed the turn back into AgentMemory so learn-from-turn
    // builds the User Profile + extracts facts. Skip on errors.
    try {
      agentMemory.learnFromTurn(task, result?.answer || '', {
        source: 'cli', provider, model: opts.model || aiClient.selectModel(provider),
        persona: opts.persona || settingsStore.get('persona'),
      });
    } catch (_) {}

    return result;
  }

  // Plain chat — single AI call, no agent loop. Used by `horizon chat`.
  async function runChat(message, opts = {}) {
    const provider = opts.provider || settingsStore.get('provider') || 'gemini';
    const lang = opts.lang || settingsStore.get('lang') || 'en';
    const system = buildSystemPrompt({
      lang,
      persona: opts.persona,
      system: opts.system,
    });
    const history = Array.isArray(opts.history) ? opts.history : [];
    const messages = [...history, { role: 'user', content: message }];
    const r = await aiClient.complete(messages, {
      provider, model: opts.model, system,
    });
    if (r.ok !== false && r.reply && !opts.skipLearn) {
      try {
        agentMemory.learnFromTurn(message, r.reply, {
          source: 'cli-chat', provider, model: r.model, persona: opts.persona,
        });
      } catch (_) {}
    }
    return r;
  }

  // Streaming variant — emits onToken(chunk) as the AI produces each token,
  // resolves to the same final {reply, model, usage, error?} shape.
  async function runChatStream(message, opts = {}, onToken = () => {}) {
    const provider = opts.provider || settingsStore.get('provider') || 'gemini';
    const lang = opts.lang || settingsStore.get('lang') || 'en';
    const system = buildSystemPrompt({
      lang,
      persona: opts.persona,
      system: opts.system,
    });
    const history = Array.isArray(opts.history) ? opts.history : [];
    const messages = [...history, { role: 'user', content: message }];
    const r = await aiClient.completeStream(messages, {
      provider, model: opts.model, system,
    }, onToken);
    if (r.reply && !opts.skipLearn) {
      try {
        agentMemory.learnFromTurn(message, r.reply, {
          source: 'cli-chat-stream', provider, model: r.model, persona: opts.persona,
        });
      } catch (_) {}
    }
    return r;
  }

  return {
    // Stores
    keysStore, settingsStore, userDataDir, workspaceDir,
    // Modules
    agentMemory, embeddingService, workspaceMemory,
    personas, executor, skillsManager, connectionsManager,
    aiClient, costTracker,
    resolveAutoProvider,
    // High-level entry points
    runAgent, runChat, runChatStream,
    buildSystemPrompt,
    // Raw access for advanced consumers (TUI, serve)
    dispatchTool: async (name, args) => {
      const ctx = {
        sender: null, executor, browserManager: null, agentMemory,
        skillsManager, connectionsManager, settingsStore, keysStore,
        workspaceDir,
        async withPermission(_t, _a, _r, fn) { return fn(); },
      };
      return dispatchTool(name, args || {}, ctx);
    },
    TOOL_DEFINITIONS,
  };
}

module.exports = {
  createHorizonRuntime,
  defaultUserDataDir,
};
