'use strict';
/**
 * Horizon Plugin Manager — v2.2 (Sprint-3 canonical contract)
 *
 * ── CANONICAL PLUGIN CONTRACT ──────────────────────────────────────────────
 *  Entry file:    `handler.js` (canonical) — `main.js` also accepted (legacy)
 *  Export form:   `module.exports = { async execute(toolName, args, ctx) { ... } }`
 *                  (preferred — used by every Horizon built-in plugin)
 *                 — OR —
 *                  `module.exports = { [toolName]: async (args, ctx) => ... }`
 *                  (per-tool form — also accepted by `executeTool` below)
 *  Permissions:   dotted form (`network.fetch`, `clipboard.read`, `shell.exec`,
 *                 `filesystem.read`, `filesystem.write`, `notifications`,
 *                 `screen.read`, `mouse.control`, `keyboard.control`).
 *                 Legacy `colon:form` is coerced to dotted on load + install.
 *  Context:       `ctx = { settings, fetch, logger, storage }`
 *                   settings — `Readonly<manifest.config>` (user-editable)
 *                   fetch    — node-fetch wrapped with the plugin's
 *                              `network.fetch` permission check (throws
 *                              `PermissionError` if not granted)
 *                   logger   — `{ info(msg, …), warn(msg, …), error(msg, …) }`
 *                              writes to <userData>/plugin-logs/<id>.log
 *                              (1 MiB rotation, last-write-wins)
 *                   storage  — `{ get(k), set(k, v), all(), delete(k) }`
 *                              backed by <userData>/plugin-storage/<id>.json
 *
 * Return shape (recommended):
 *   `{ ok: true,  out: '...', ... }`     for success
 *   `{ ok: false, error: '...' }`        for failure
 *
 * See horizon-plugin-sdk/packages/types/src/index.ts for the TypeScript
 * mirror of this contract.
 * ───────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const electron = require('electron');
const shell = electron.shell || { openExternal: async () => { throw new Error('Electron shell is not available'); } };
const Notification = electron.Notification || class { constructor() {} show() {} };
const { runHandlerInSandbox, isSandboxDisabled } = require('./pluginSandbox');

// Sprint-6 — Community plugins now run inside a vm sandbox (see
// pluginSandbox.js) so the previous "off-by-default with explicit env
// var" gate is no longer needed for safety. Kept as an OPT-IN flag so
// power users / CI can still toggle on the legacy unsandboxed path if
// they're knowingly running locally-authored community plugins. The
// safer default (community plugins enabled with sandbox) is now ON.
const COMMUNITY_PLUGINS_ENABLED = process.env.HORIZON_ENABLE_COMMUNITY_PLUGINS === '1';

// node-fetch is already a runtime dependency (see package.json); fall back
// to the global `fetch` (Node 20+) if node-fetch fails to resolve for any
// reason (e.g. pkg snapshot).
let _nodeFetch;
function _resolveFetch() {
  if (_nodeFetch) return _nodeFetch;
  try { _nodeFetch = require('node-fetch'); }
  catch (_) { _nodeFetch = (...a) => globalThis.fetch(...a); }
  return _nodeFetch;
}

class PermissionError extends Error {
  constructor(permission, target) {
    super(`Permission denied: ${permission}${target ? ' (' + target + ')' : ''}`);
    this.name = 'PermissionError';
    this.permission = permission;
    this.target = target || null;
  }
}

// Sprint-3 — permission string normalisation. SDK canonical form is
// dotted (`network.fetch`, `clipboard.read`). Older built-in manifests
// and a handful of community zips ship the legacy `colon:form`
// (`network:*`, `clipboard:read`, `fs:write:userdata`). We accept both
// at load time, emit a single deprecation warning per plugin, and store
// the dotted form on the manifest so the UI shows a consistent string.
const LEGACY_PERM_MAP = {
  'network:*':                   'network.fetch',
  'network:fetch':               'network.fetch',
  'clipboard:read':              'clipboard.read',
  'clipboard:write':             'clipboard.write',
  'screen:read':                 'screen.read',
  'screen:capture':              'screen.read',
  'shell:exec':                  'shell.exec',
  'shell:execute':               'shell.exec',
  'fs:read':                     'filesystem.read',
  'fs:write':                    'filesystem.write',
  'fs:write:userdata':           'filesystem.write',
  'system:read':                 'shell.exec',
  'storage:tokens':              'filesystem.write',
  'loopback:127.0.0.1':          'network.fetch',
  'notifications':               'notifications',
  'notification':                'notifications',
  'mouse:control':               'mouse.control',
  'keyboard:control':            'keyboard.control',
};
const PERM_WARNED = new Set();
function normalisePermissions(rawList, pluginId) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  let changed = false;
  for (const raw of rawList) {
    if (typeof raw !== 'string') continue;
    if (raw.includes('.')) { out.push(raw); continue; }
    if (raw.includes(':')) {
      const direct = LEGACY_PERM_MAP[raw];
      if (direct) { out.push(direct); changed = true; continue; }
      // Pattern fallback — strip everything after the first colon, then
      // map the scope. Covers `network:api.coingecko.com` →
      // `network.fetch`, etc.
      const scope = raw.split(':')[0];
      const fallback = LEGACY_PERM_MAP[scope + ':*'] || LEGACY_PERM_MAP[scope + ':read'] || null;
      if (fallback) { out.push(fallback); changed = true; continue; }
      // Unknown legacy scope — keep the raw string so we don't silently
      // drop intent, but mark as changed for the deprecation log.
      out.push(raw);
      changed = true;
      continue;
    }
    out.push(raw);
  }
  if (changed && pluginId && !PERM_WARNED.has(pluginId)) {
    PERM_WARNED.add(pluginId);
    console.warn(`[plugin:${pluginId}] DEPRECATED legacy "colon:form" permission strings — switch to dotted form (e.g. "network.fetch"). See horizon-plugin-sdk/docs/manifest.md.`);
  }
  // De-duplicate preserving order.
  return Array.from(new Set(out));
}

class PluginManager {
  constructor(pluginsDir) {
    this.pluginsDir = pluginsDir;
    this.plugins = new Map();
    this.handlers = new Map();
    this.enabled = new Set();

    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
    }

    // Sprint-3 — per-plugin storage + logs live next to the plugins dir
    // (siblings: plugin-storage/, plugin-logs/). Keeps the user's plugin
    // bundles immutable.
    this.storageDir = path.join(path.dirname(pluginsDir), 'plugin-storage');
    this.logsDir    = path.join(path.dirname(pluginsDir), 'plugin-logs');
    try { fs.mkdirSync(this.storageDir, { recursive: true }); } catch (_) {}
    try { fs.mkdirSync(this.logsDir,    { recursive: true }); } catch (_) {}

    // Per-plugin storage cache so frequent get()/set() don't hit disk for
    // every call. The on-disk JSON is the source of truth — cache is
    // discarded if the file is modified externally (mtime check).
    this._storageCache = new Map(); // pluginId → { mtime, data }
  }

  // ─── Sprint-3 ctx helpers (fetch / logger / storage) ────────────────────
  // These are constructed fresh per executeTool() call so per-call state
  // (such as the resolved permission set) is captured in closure.

  _hasPermission(manifest, perm) {
    const perms = manifest && Array.isArray(manifest.permissions) ? manifest.permissions : [];
    return perms.includes(perm);
  }

  _makeCtxFetch(manifest) {
    const fetchImpl = _resolveFetch();
    const pluginId = manifest._id || manifest.id || 'unknown';
    return async (input, init) => {
      if (!this._hasPermission(manifest, 'network.fetch')) {
        throw new PermissionError('network.fetch', String(input || ''));
      }
      try {
        return await fetchImpl(input, init);
      } catch (e) {
        // Tag the error so plugin authors can distinguish "wrong URL" from
        // "no permission".
        const err = new Error(`[plugin:${pluginId}] fetch failed: ${e.message}`);
        err.cause = e;
        throw err;
      }
    };
  }

  _makeCtxLogger(manifest) {
    const pluginId = manifest._id || manifest.id || 'unknown';
    const logPath = path.join(this.logsDir, `${pluginId}.log`);
    const write = (level, msg, ...rest) => {
      const ts = new Date().toISOString();
      const tail = rest.length
        ? ' ' + rest.map(r => {
            try { return typeof r === 'string' ? r : JSON.stringify(r); }
            catch (_) { return String(r); }
          }).join(' ')
        : '';
      const line = `[${ts}] ${level.toUpperCase()} ${msg}${tail}\n`;
      try {
        // Naive 1 MiB rotation: if file > 1 MiB, truncate to last 512 KiB.
        let st;
        try { st = fs.statSync(logPath); } catch (_) { st = null; }
        if (st && st.size > 1024 * 1024) {
          try {
            const fd = fs.openSync(logPath, 'r');
            const half = Buffer.alloc(512 * 1024);
            fs.readSync(fd, half, 0, half.length, st.size - half.length);
            fs.closeSync(fd);
            fs.writeFileSync(logPath, half);
          } catch (_) { try { fs.truncateSync(logPath, 0); } catch (_) {} }
        }
        fs.appendFileSync(logPath, line);
      } catch (_) { /* swallow — logging must never throw */ }
      // Also mirror to the host console so devs see plugin activity in
      // electron's stdout without tailing the file.
      if (level === 'error') console.error(`[plugin:${pluginId}]`, msg, ...rest);
      else if (level === 'warn') console.warn(`[plugin:${pluginId}]`, msg, ...rest);
      else console.log(`[plugin:${pluginId}]`, msg, ...rest);
    };
    return {
      info:  (msg, ...rest) => write('info',  msg, ...rest),
      warn:  (msg, ...rest) => write('warn',  msg, ...rest),
      error: (msg, ...rest) => write('error', msg, ...rest),
    };
  }

  _readStorage(pluginId) {
    const p = path.join(this.storageDir, `${pluginId}.json`);
    let st = null;
    try { st = fs.statSync(p); } catch (_) {}
    const cached = this._storageCache.get(pluginId);
    if (cached && st && cached.mtime === st.mtimeMs) return cached.data;
    if (!st) return {};
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
      this._storageCache.set(pluginId, { mtime: st.mtimeMs, data });
      return data;
    } catch (_) { return {}; }
  }

  _writeStorage(pluginId, data) {
    const p = path.join(this.storageDir, `${pluginId}.json`);
    try {
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
      const st = fs.statSync(p);
      this._storageCache.set(pluginId, { mtime: st.mtimeMs, data });
      return true;
    } catch (_) { return false; }
  }

  _makeCtxStorage(manifest) {
    const pluginId = manifest._id || manifest.id || 'unknown';
    return {
      get: (key) => {
        const data = this._readStorage(pluginId);
        return key == null ? undefined : data[key];
      },
      set: (key, value) => {
        if (typeof key !== 'string' || !key) return false;
        const data = this._readStorage(pluginId);
        data[key] = value;
        return this._writeStorage(pluginId, data);
      },
      delete: (key) => {
        const data = this._readStorage(pluginId);
        if (!(key in data)) return false;
        delete data[key];
        return this._writeStorage(pluginId, data);
      },
      all: () => ({ ...this._readStorage(pluginId) }),
    };
  }

  _buildCtx(manifest) {
    return {
      settings: Object.freeze({ ...(manifest.config || {}) }),
      fetch:    this._makeCtxFetch(manifest),
      logger:   this._makeCtxLogger(manifest),
      storage:  this._makeCtxStorage(manifest),
    };
  }

  // ─── Sprint-6 — sandbox loader ──────────────────────────────────────────
  // Decides whether to run a plugin's handler under vm sandbox vs the
  // direct `require()` path. Sandbox is used for the `community` tier
  // (untrusted, marketplace-published-but-not-reviewed code). All other
  // tiers (built_in, demo, local, marketplace) go through direct require
  // because they either ship with the app or have been signed/reviewed.
  // HORIZON_PLUGIN_NO_SANDBOX=1 forces direct require for ALL tiers —
  // dev affordance only, never for end users.
  _shouldSandbox(manifest) {
    if (isSandboxDisabled()) return false;
    const tier = manifest?.tier || 'community';
    return tier === 'community';
  }

  _loadHandler(pluginId, handlerPath, manifest) {
    if (!this._shouldSandbox(manifest)) {
      // Trusted tier — direct require, identical behaviour to pre-Sprint-6.
      try { delete require.cache[require.resolve(handlerPath)]; } catch (_) {}
      return require(handlerPath);
    }
    // Community tier — sandbox the handler. Errors here are caught by the
    // caller (loadAll / install) and the plugin simply ends up without a
    // registered handler, which surfaces as "Tool not found" at call time.
    const code = fs.readFileSync(handlerPath, 'utf8');
    const { exports: handlerExports } = runHandlerInSandbox(
      pluginId,
      manifest,
      code,
      handlerPath,
      { ctxBuilder: (m) => this._buildCtx(m) },
      { timeout: 30000 },
    );
    return handlerExports;
  }

  loadAll() {
    const loaded = [];
    try {
      for (const dir of fs.readdirSync(this.pluginsDir)) {
        const pluginPath = path.join(this.pluginsDir, dir);
        if (!fs.statSync(pluginPath).isDirectory()) continue;
        const manifestPath = path.join(pluginPath, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          // Back-fill `settings` spec from the bundled source (older installs
          // pre-date the settings UI and have no spec on disk).
          if (!Array.isArray(manifest.settings) || manifest.settings.length === 0) {
            try {
              const bundled = path.join(__dirname, '..', '..', 'builtin-plugins', dir, 'manifest.json');
              if (fs.existsSync(bundled)) {
                const src = JSON.parse(fs.readFileSync(bundled, 'utf8'));
                if (Array.isArray(src.settings) && src.settings.length) {
                  manifest.settings = src.settings;
                  const persist = { ...manifest }; delete persist._dir; delete persist._id;
                  fs.writeFileSync(manifestPath, JSON.stringify(persist, null, 2));
                }
              }
            } catch (_) { /* best effort */ }
          }
          manifest._dir = pluginPath;
          manifest._id = dir;
          // Sprint-3 — coerce legacy colon:form permissions to dotted form
          // and log one deprecation per plugin.
          if (Array.isArray(manifest.permissions)) {
            manifest.permissions = normalisePermissions(manifest.permissions, dir);
          }
          this.plugins.set(dir, manifest);
          const trusted = this.isTrusted(manifest);
          if (manifest.enabled !== false && trusted) this.enabled.add(dir);
          // Sprint-3 — accept handler.js (canonical) OR main.js (SDK <0.1.2 bundles).
          let handlerPath = path.join(pluginPath, 'handler.js');
          if (!fs.existsSync(handlerPath)) {
            const mainPath = path.join(pluginPath, 'main.js');
            if (fs.existsSync(mainPath)) handlerPath = mainPath;
          }
          if (fs.existsSync(handlerPath) && trusted) {
            try {
              // Sprint-6 — community plugins go through the vm sandbox,
              // everything else (built_in / demo / local / marketplace) keeps
              // the direct require() path. See _loadHandler for details.
              this.handlers.set(dir, this._loadHandler(dir, handlerPath, manifest));
            } catch (e) { console.error(`Plugin handler error (${dir}):`, e.message); }
          }
          loaded.push({ id: dir, name: manifest.name, version: manifest.version });
        } catch (e) { console.error(`Plugin manifest error (${dir}):`, e.message); }
      }
    } catch (e) { console.error('Plugin loadAll error:', e.message); }
    return loaded;
  }

  isTrusted(plugin) {
    const tier = plugin?.tier || 'community';
    // Sprint-6 — community plugins are now safe-by-default because they
    // run inside the vm sandbox (see pluginSandbox.js). The
    // HORIZON_ENABLE_COMMUNITY_PLUGINS gate is preserved for the legacy
    // unsandboxed path, and HORIZON_PLUGIN_NO_SANDBOX=1 can also force
    // the unsandboxed path globally (dev affordance only).
    if (tier === 'built_in' || tier === 'demo' || tier === 'local' || tier === 'marketplace') return true;
    if (tier === 'community') {
      // If the sandbox is disabled (dev override), only trust community
      // plugins when the user has explicitly opted in via the legacy env
      // var — i.e. the old behaviour. Otherwise, sandbox-protected
      // community plugins are trusted-by-default.
      if (isSandboxDisabled()) return COMMUNITY_PLUGINS_ENABLED;
      return true;
    }
    return COMMUNITY_PLUGINS_ENABLED;
  }

  install(pluginJson) {
    try {
      const plugin = typeof pluginJson === 'string' ? JSON.parse(pluginJson) : pluginJson;
      if (!plugin.id || !plugin.name) return { ok: false, error: 'Plugin must have id and name' };

      // Anti-impersonation: community plugins cannot claim to be from the Horizon Team
      if (!['built_in', 'demo', 'local'].includes(plugin.tier)) {
        const author = (plugin.author || '').toLowerCase();
        if (author.includes('horizon team') || author.includes('ernest kostevich')) {
          return { ok: false, error: 'Only official plugins can use the Horizon Team / Ernest Kostevich author name.' };
        }
      }
      if (!this.isTrusted(plugin)) {
        // Sprint-6 — with sandbox shipped, community plugins are trusted by
        // default. This branch is now only reachable when the user has
        // explicitly opted-out of the sandbox (HORIZON_PLUGIN_NO_SANDBOX=1)
        // AND has NOT also opted-in to legacy unsandboxed community plugins
        // (HORIZON_ENABLE_COMMUNITY_PLUGINS=1).
        return {
          ok: false,
          error: 'Community plugin execution requires the sandbox. Unset HORIZON_PLUGIN_NO_SANDBOX or set HORIZON_ENABLE_COMMUNITY_PLUGINS=1 to allow unsandboxed installs.',
        };
      }

      const pluginDir = path.join(this.pluginsDir, plugin.id);
      fs.mkdirSync(pluginDir, { recursive: true });
      const manifest = {
        name: plugin.name,
        version: plugin.version || '1.0.0',
        description: plugin.description || '',
        author: plugin.author || 'Community',
        category: plugin.category || 'utility',
        tier: plugin.tier || 'community',
        icon: plugin.icon || '🔌',
        tools: plugin.tools || [],
        settings: plugin.settings || [],
        config: plugin.config || {},
        // Sprint-3 — normalise on install so the persisted manifest uses
        // the canonical dotted form, not whatever the user shipped.
        permissions: normalisePermissions(plugin.permissions || [], plugin.id),
        price: plugin.price || 0,
        rating: plugin.rating || 0,
        downloads: plugin.downloads || 0,
        enabled: true,
      };
      fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      if (plugin.handler) {
        fs.writeFileSync(path.join(pluginDir, 'handler.js'), plugin.handler);
        try {
          const handlerPath = path.join(pluginDir, 'handler.js');
          // Sprint-6 — sandbox-or-direct based on tier. See _loadHandler.
          // Manifest needs _id so the sandbox can build logs/storage paths.
          const manifestWithId = { ...manifest, _id: plugin.id, _dir: pluginDir };
          this.handlers.set(plugin.id, this._loadHandler(plugin.id, handlerPath, manifestWithId));
        } catch (e) { console.error(`Handler load error (${plugin.id}):`, e.message); }
      }
      this.plugins.set(plugin.id, manifest);
      this.enabled.add(plugin.id);
      return { ok: true, id: plugin.id, name: plugin.name };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  uninstall(pluginId) {
    try {
      const pluginDir = path.join(this.pluginsDir, pluginId);
      if (fs.existsSync(pluginDir)) fs.rmSync(pluginDir, { recursive: true, force: true });
      this.plugins.delete(pluginId);
      this.handlers.delete(pluginId);
      this.enabled.delete(pluginId);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  toggleEnable(pluginId) {
    const manifest = this.plugins.get(pluginId);
    if (!manifest) return { ok: false, error: 'Plugin not found' };
    const nowEnabled = !this.enabled.has(pluginId);
    if (nowEnabled) this.enabled.add(pluginId); else this.enabled.delete(pluginId);
    manifest.enabled = nowEnabled;
    try { fs.writeFileSync(path.join(this.pluginsDir, pluginId, 'manifest.json'), JSON.stringify(manifest, null, 2)); } catch {}
    return { ok: true, enabled: nowEnabled };
  }

  list() {
    return Array.from(this.plugins.entries()).map(([id, m]) => ({
      id, name: m.name, version: m.version, description: m.description,
      author: m.author, category: m.category || 'utility', tier: m.tier || 'community',
      icon: m.icon || '🔌', tools: (m.tools || []).length, toolList: m.tools || [],
      settings: m.settings || [], config: m.config || {},
      enabled: this.enabled.has(id), price: m.price || 0, rating: m.rating || 0, downloads: m.downloads || 0,
    }));
  }

  setConfig(pluginId, partialConfig) {
    const m = this.plugins.get(pluginId);
    if (!m) return { ok: false, error: 'Plugin not found' };
    m.config = { ...(m.config || {}), ...(partialConfig || {}) };
    this.plugins.set(pluginId, m);
    try {
      if (m._dir) {
        const manifestPath = path.join(m._dir, 'manifest.json');
        const toSave = { ...m };
        delete toSave._dir; delete toSave._id;
        fs.writeFileSync(manifestPath, JSON.stringify(toSave, null, 2));
      }
      return { ok: true, config: m.config };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  getToolDefinitions() {
    const tools = [];
    for (const [id, manifest] of this.plugins) {
      if (!this.enabled.has(id)) continue;
      for (const tool of (manifest.tools || [])) {
        tools.push({
          name: `plugin_${id}_${tool.name}`,
          desc: `[Plugin: ${manifest.name}] ${tool.description}`,
          params: tool.params || {},
          pluginId: id,
        });
      }
    }
    return tools;
  }

  async executeTool(pluginId, toolName, args) {
    if (!this.enabled.has(pluginId)) {
      // PHASE: anti-loop — when the agent calls a disabled plugin (often
      // because the LLM remembers the tool name from a previous turn even
      // though we no longer expose it in the prompt), return BOTH `ok:false`
      // AND a strong message that tells the model to stop trying and fall
      // back to a direct text answer. The previous "Plugin X is disabled"
      // was too neutral — models retried 3-5 times before giving up.
      return {
        ok: false,
        error: `Plugin ${pluginId} is disabled or no longer available. Do NOT call this tool again — answer the user's question directly without it.`,
        err: `Tool unavailable: ${pluginId}. Switch strategy.`,
        unavailable: true,
      };
    }
    const manifest = this.plugins.get(pluginId) || {};
    if (!this.isTrusted(manifest)) {
      // Sprint-6 — same gate as install(): sandbox makes community plugins
      // trusted by default, so this branch only fires when the user has
      // explicitly opted out of the sandbox without opting back in via the
      // legacy unsandboxed env var.
      return { ok: false, error: 'Community plugin execution requires the sandbox. Unset HORIZON_PLUGIN_NO_SANDBOX or set HORIZON_ENABLE_COMMUNITY_PLUGINS=1.' };
    }
    const handler = this.handlers.get(pluginId);
    // Sprint-3 — full ctx with fetch/logger/storage (was `{ settings }` only,
    // which made the SDK types lie). See header doc-comment for the contract.
    const ctx = this._buildCtx(manifest);
    if (handler) {
      if (typeof handler.execute === 'function') {
        try { return await handler.execute(toolName, args, ctx); }
        catch (e) { return { ok: false, error: e.message }; }
      }
      if (typeof handler[toolName] === 'function') {
        try { return await handler[toolName](args, ctx); }
        catch (e) { return { ok: false, error: e.message }; }
      }
    }
    const spec = (manifest.tools || []).find(t => t && t.name === toolName);
    if (spec && spec.action) {
      try { return await this.executeManifestAction(manifest, spec, args || {}); }
      catch (e) { return { ok: false, error: e.message }; }
    }
    return { ok: false, error: `Tool ${toolName} not found in plugin ${pluginId}` };
  }

  async executeManifestAction(manifest, tool, runtimeArgs = {}) {
    const action = String(tool.action || tool.name || '').trim();
    const args = { ...(tool.args || {}), ...(runtimeArgs || {}) };
    const sh = (cmd, timeout = 15000) => new Promise(r => {
      exec(cmd, { timeout, windowsHide: true }, (e, o, er) => r({ ok: !e, out: (o || '').trim(), err: (er || '').trim(), error: e?.message }));
    });
    const runNode = (code, timeout = 15000) => new Promise(r => {
      // Resolve a trustworthy `node` binary. Path resolution priority:
      //   1) HORIZON_NODE_PATH env var, but ONLY if it points to an
      //      existing absolute path AND the basename looks like node /
      //      node.exe — guards against an attacker-controlled env var
      //      pointing exec at an arbitrary binary.
      //   2) process.execPath (Electron's bundled node) — always safe.
      //   3) Bare 'node' as a last resort (relies on PATH).
      let nodeBin = process.execPath || 'node';
      try {
        const envPath = (process.env.HORIZON_NODE_PATH || '').trim();
        if (envPath) {
          const path = require('path');
          const fs = require('fs');
          const isAbs = path.isAbsolute(envPath);
          const base = path.basename(envPath).toLowerCase();
          const looksNode = base === 'node' || base === 'node.exe';
          if (isAbs && looksNode && fs.existsSync(envPath)) {
            nodeBin = envPath;
          } else if (envPath) {
            console.warn('HORIZON_NODE_PATH ignored — not absolute, not named node, or missing:', envPath);
          }
        }
      } catch (_) { /* fall through to safe default */ }
      execFile(
        nodeBin,
        ['-e', String(code)],
        { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
        (e, o, er) => r({ ok: !e, out: (o || '').trim() || 'done', err: (er || '').trim(), error: e?.message })
      );
    });
    const IS_WIN = process.platform === 'win32';
    const IS_MAC = process.platform === 'darwin';
    const title = args.title || manifest.name || 'Horizon Plugin';
    if (action === 'notify') {
      const body = args.body || args.message || args.text || `${tool.name} completed`;
      try { new Notification({ title, body: String(body) }).show(); } catch (_) {}
      return { ok: true, out: `Notification sent: ${body}` };
    }
    if (action === 'open_url') {
      const url = args.url || args.href || args.target;
      if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'open_url requires http(s) url' };
      await shell.openExternal(String(url));
      return { ok: true, out: `Opened ${url}` };
    }
    if (action === 'open_app') {
      const app = args.app || args.name || args.target;
      if (!app) return { ok: false, error: 'open_app requires app' };
      if (IS_WIN) return sh(`start "" "${String(app).replace(/"/g, '\\"')}"`);
      if (IS_MAC) return sh(`open -a "${String(app).replace(/"/g, '\\"')}"`);
      return sh(`${String(app).replace(/"/g, '\\"')} &`);
    }
    if (action === 'close_app') {
      const app = args.app || args.name || args.target;
      if (!app) return { ok: false, error: 'close_app requires app' };
      if (IS_WIN) return sh(`taskkill /F /IM "${String(app).replace(/\.exe$/i, '')}.exe" 2>nul`);
      if (IS_MAC) return sh(`osascript -e 'tell application "${String(app).replace(/"/g, '\\"')}" to quit'`);
      return sh(`pkill -f "${String(app).replace(/"/g, '\\"')}"`);
    }
    if (action === 'run_code' || action === 'shell') {
      const language = String(args.language || 'shell').toLowerCase();
      const code = args.command || args.code || '';
      if (!code) return { ok: false, error: `${action} requires code/command` };
      if (language === 'javascript' || language === 'js' || language === 'node') {
        return runNode(code, Number(args.timeout || 15000));
      }
      return sh(String(code), Number(args.timeout || 15000));
    }
    if (action === 'speak') return { ok: true, out: `speak:${args.text || args.message || ''}` };
    if (action === 'send_message') return { ok: true, out: `message:${args.text || args.message || ''}` };
    if (action === 'wait') {
      const ms = Number(args.ms || (Number(args.seconds || 1) * 1000));
      await new Promise(r => setTimeout(r, Math.max(0, Math.min(ms || 1000, 600000))));
      return { ok: true, out: `Waited ${ms || 1000}ms` };
    }
    if (action === 'type_text') {
      const text = String(args.text || args.message || '');
      if (!text) return { ok: false, error: 'type_text requires text' };
      if (IS_WIN) {
        const send = text.replace(/'/g, "''").replace(/[+^%~(){}[\]]/g, '{$&}');
        return sh(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait('${send}')"`);
      }
      if (IS_MAC) return sh(`osascript -e 'tell application "System Events" to keystroke "${text.replace(/"/g, '\\"')}"'`);
      return sh(`xdotool type --clearmodifiers --delay 20 '${text.replace(/'/g, "'\\''")}'`);
    }
    if (action === 'press_key') {
      const key = String(args.key || args.keys || '').trim();
      if (!key) return { ok: false, error: 'press_key requires key' };
      if (IS_WIN) return sh(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${key.replace(/'/g, "''")}')"`);
      if (IS_MAC) return sh(`osascript -e 'tell application "System Events" to keystroke "${key.replace(/"/g, '\\"')}"'`);
      return sh(`xdotool key ${key.replace(/[^a-zA-Z0-9_+.-]/g, '')}`);
    }
    return { ok: false, error: `Unsupported manifest action: ${action}` };
  }

  // Note: a second `setConfig(pluginId, config)` definition was removed
  // here in Sprint-3 — it shadowed the earlier method (above) and silently
  // wrote `_dir`/`_id` into the on-disk manifest. The kept implementation
  // is the one near line 417.

  generateShareUrl(pluginId) {
    const manifest = this.plugins.get(pluginId);
    if (!manifest) return null;
    const pluginDir = path.join(this.pluginsDir, pluginId);
    const handlerPath = path.join(pluginDir, 'handler.js');
    const pluginData = {
      id: pluginId, name: manifest.name, version: manifest.version,
      description: manifest.description, author: manifest.author,
      category: manifest.category, tier: manifest.tier || 'community',
      icon: manifest.icon, tools: manifest.tools, permissions: manifest.permissions || [],
      handler: fs.existsSync(handlerPath) ? fs.readFileSync(handlerPath, 'utf8') : '',
    };
    const encoded = Buffer.from(JSON.stringify(pluginData)).toString('base64');
    return `horizon://plugin/install?data=${encoded}`;
  }

  installFromShareUrl(shareUrl) {
    try {
      let data;
      if (shareUrl.startsWith('horizon://plugin/install?data=')) {
        data = shareUrl.replace('horizon://plugin/install?data=', '');
      } else {
        const url = new URL(shareUrl);
        data = url.searchParams.get('data');
      }
      if (!data) return { ok: false, error: 'Invalid share URL' };
      const pluginData = JSON.parse(Buffer.from(data, 'base64').toString());
      // Share URLs are explicitly imported by the local user, so install them
      // as local plugins. Remote marketplace installs use the signed bundle
      // path in main.js and get tier=marketplace.
      if (pluginData.tier !== 'built_in' && pluginData.tier !== 'demo') pluginData.tier = 'local';
      return this.install(pluginData);
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /**
   * Generic loader for any directory under `builtin-plugins/`. Reads the
   * directory's manifest.json + handler.js, materialises them into the
   * user's pluginsDir (so uninstall / settings persistence work the same
   * as for marketplace installs), and registers the handler in
   * this.handlers.
   *
   * Idempotent — running it on an existing install repairs missing files
   * and refreshes the manifest with whatever ships in the latest app
   * release. User-tweaked fields (`enabled`, `price`, `rating`,
   * `downloads`, `config`) are preserved on top.
   *
   * @param {string} pluginId   directory name under builtin-plugins/
   * @param {object} [opts]     overrides for default tier ('built_in') and author
   */
  installBuiltinFromDir(pluginId, opts = {}) {
    try {
      const bundle = path.join(__dirname, '..', '..', 'builtin-plugins', pluginId);
      if (!fs.existsSync(bundle)) {
        return { ok: false, error: `builtin-plugins/${pluginId} not found` };
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
      const handler = fs.readFileSync(path.join(bundle, 'handler.js'), 'utf8');
      const pluginDir = path.join(this.pluginsDir, pluginId);
      const manifestPath = path.join(pluginDir, 'manifest.json');
      const handlerPath = path.join(pluginDir, 'handler.js');
      fs.mkdirSync(pluginDir, { recursive: true });

      let existing = {};
      if (fs.existsSync(manifestPath)) {
        try { existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { existing = {}; }
      }

      const repaired = !!existing.name || this.plugins.has(pluginId);
      const installedManifest = {
        ...existing,
        id: pluginId,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: opts.author || manifest.author || 'Horizon Team',
        category: manifest.category,
        tier: opts.tier || manifest.tier || 'built_in',
        icon: manifest.icon,
        tools: manifest.tools,
        settings: manifest.settings || [],
        // Sprint-3 — bundled built-ins now ship dotted-form perms, but
        // some installs are upgrading from older app versions where the
        // on-disk manifest still has colon-form. Normalise on every
        // install so the persisted manifest converges to dotted form.
        permissions: normalisePermissions(manifest.permissions || [], pluginId),
        price: existing.price || 0,
        rating: existing.rating || 5,
        downloads: existing.downloads || 0,
        enabled: existing.enabled !== false,
        // Preserve any user-edited config (e.g. Spotify client_id).
        config: existing.config || {},
      };

      const toSave = { ...installedManifest };
      delete toSave._dir; delete toSave._id;
      fs.writeFileSync(manifestPath, JSON.stringify(toSave, null, 2));
      fs.writeFileSync(handlerPath, handler);

      installedManifest._dir = pluginDir;
      installedManifest._id = pluginId;
      this.plugins.set(pluginId, installedManifest);
      if (installedManifest.enabled !== false && this.isTrusted(installedManifest)) {
        this.enabled.add(pluginId);
      }
      // Sprint-6 — built-ins keep their direct-require path (tier !==
      // 'community' so _loadHandler skips the sandbox). Going through
      // _loadHandler keeps a single load path so future hardening
      // changes only need to touch one helper.
      this.handlers.set(pluginId, this._loadHandler(pluginId, handlerPath, installedManifest));
      return { ok: true, id: pluginId, repaired };
    } catch (e) {
      console.error(`Builtin install failed for "${pluginId}":`, e.message);
      return { ok: false, error: e.message };
    }
  }

  /**
   * Legacy shim — keeps existing main.js call site working until the
   * caller switches to installAllBuiltins(). Spotify keeps its
   * 'demo' tier (it's the showcase plugin, not a "built-in utility").
   */
  installBundledSpotify() {
    return this.installBuiltinFromDir('spotify-control', {
      tier: 'demo',
      author: 'Ernest Kostevich',
    });
  }

  /**
   * Walk every directory under `builtin-plugins/` and install each via
   * installBuiltinFromDir. Called once at app boot from main.js so the
   * fresh install ships with a working set of utilities (system-monitor
   * / web-fetch / clipboard / screenshot / crypto-pulse) plus the
   * Spotify demo. None of these need credentials or external API keys.
   */
  installAllBuiltins() {
    const root = path.join(__dirname, '..', '..', 'builtin-plugins');
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch (_) { return { ok: false, error: 'builtin-plugins/ not found' }; }
    const installed = [];
    const failed = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      // Spotify keeps tier='demo' — everything else defaults to built_in
      // via the manifest's tier field.
      const opts = id === 'spotify-control'
        ? { tier: 'demo', author: 'Ernest Kostevich' }
        : {};
      const r = this.installBuiltinFromDir(id, opts);
      if (r.ok) installed.push(r.id);
      else failed.push({ id, error: r.error });
    }
    return { ok: true, installed, failed };
  }

  /**
   * Built-in templates = small set of core utilities that ship with Horizon.
   * These are NOT user marketplace content.
   */
  static getBuiltinTemplates() {
    return [
      {
        id: 'system-monitor',
        name: 'System Monitor',
        description: 'CPU, RAM and disk status, top processes.',
        version: '1.2.0',
        author: 'Horizon Team',
        category: 'system',
        tier: 'built_in',
        icon: '📊',
        price: 0,
        rating: 0,
        downloads: 0,
        permissions: ['system:read'],
        tools: [
          { name: 'status',    description: 'CPU / RAM / disk snapshot', params: {} },
          { name: 'top_procs', description: 'Top processes by CPU',      params: {} },
          { name: 'disk_info', description: 'Per-drive disk usage',      params: {} },
        ],
        handler: `'use strict';
const os = require('os');
const { exec } = require('child_process');
const IS_WIN = process.platform === 'win32';
function sh(cmd){ return new Promise(r=>exec(cmd,{timeout:8000},(e,o,er)=>r({ok:!e,out:(o||'').trim(),err:(er||'').trim()}))); }
module.exports = {
  async execute(tool) {
    if (tool === 'status') {
      const cpus = os.cpus();
      const totalMem = (os.totalmem()/1e9).toFixed(1);
      const usedMem  = ((os.totalmem()-os.freemem())/1e9).toFixed(1);
      const memPct   = Math.round((os.totalmem()-os.freemem())/os.totalmem()*100);
      return { ok: true, out:
        'CPU: ' + cpus[0].model.slice(0,40) + ' (' + cpus.length + ' cores)\\n' +
        'RAM: ' + usedMem + 'GB / ' + totalMem + 'GB (' + memPct + '%)\\n' +
        'Platform: ' + os.platform() + ' ' + os.arch() + '\\n' +
        'Uptime: ' + Math.round(os.uptime()/3600) + 'h'
      };
    }
    if (tool === 'top_procs') return sh(IS_WIN ? 'tasklist /FO CSV /NH' : 'ps aux --sort=-%cpu 2>/dev/null | head -11');
    if (tool === 'disk_info') return sh(IS_WIN ? 'powershell -Command "Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize | Out-String"' : 'df -h 2>/dev/null');
    return { ok: false, error: 'Unknown tool: ' + tool };
  }
};`,
      },
      {
        id: 'quick-notes',
        name: 'Quick Notes',
        description: 'Save, list and search local notes as .txt files.',
        version: '1.0.0',
        author: 'Horizon Team',
        category: 'productivity',
        tier: 'built_in',
        icon: '📝',
        price: 0,
        permissions: ['fs:~/.horizon-notes'],
        tools: [
          { name: 'save',   description: 'Save a note', params: { title: 'string', content: 'string' } },
          { name: 'list',   description: 'List notes',  params: {} },
          { name: 'search', description: 'Search text', params: { query: 'string' } },
        ],
        handler: `'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const NOTES = path.join(os.homedir(), '.horizon-notes');
if (!fs.existsSync(NOTES)) fs.mkdirSync(NOTES, { recursive: true });
module.exports = {
  async execute(tool, args = {}) {
    if (tool === 'save') {
      const f = (args.title || 'note').replace(/[^a-zA-Z0-9а-яА-Я\\s]/g,'').trim().replace(/\\s+/g,'-') + '.txt';
      fs.writeFileSync(path.join(NOTES, f), '# ' + (args.title||'') + '\\n' + new Date().toISOString() + '\\n\\n' + (args.content||''), 'utf8');
      return { ok: true, out: 'saved: ' + f };
    }
    if (tool === 'list') {
      const files = fs.readdirSync(NOTES).filter(f=>f.endsWith('.txt'));
      return { ok: true, out: files.join('\\n') || '(empty)' };
    }
    if (tool === 'search') {
      const q = (args.query || '').toLowerCase();
      const hits = [];
      for (const f of fs.readdirSync(NOTES).filter(f=>f.endsWith('.txt'))) {
        const c = fs.readFileSync(path.join(NOTES, f), 'utf8');
        if (f.toLowerCase().includes(q) || c.toLowerCase().includes(q)) hits.push(f + ': ' + c.slice(0,80));
      }
      return { ok: true, out: hits.join('\\n') || 'no matches' };
    }
    return { ok: false, error: 'Unknown tool: ' + tool };
  }
};`,
      },
      {
        id: 'app-launcher',
        name: 'App Launcher',
        description: 'Launch and close desktop apps by name.',
        version: '1.0.0',
        author: 'Horizon Team',
        category: 'system',
        tier: 'built_in',
        icon: '🚀',
        price: 0,
        permissions: ['shell:exec'],
        tools: [
          { name: 'launch', description: 'Launch an app', params: { app: 'string' } },
          { name: 'close',  description: 'Close an app',  params: { app: 'string' } },
        ],
        handler: `'use strict';
const { exec } = require('child_process');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
function sh(cmd){ return new Promise(r=>exec(cmd,{timeout:8000},(e,o,er)=>r({ok:!e,out:(o||'').trim(),err:(er||'').trim()}))); }
module.exports = {
  async execute(tool, args = {}) {
    const app = (args.app || '').trim();
    if (!app) return { ok: false, error: 'app required' };
    if (tool === 'launch') {
      if (IS_WIN) return sh('start "" "' + app + '"');
      if (IS_MAC) return sh('open -a "' + app + '"');
      return sh('xdg-open "' + app + '" 2>/dev/null || ' + app + ' &');
    }
    if (tool === 'close') {
      if (IS_WIN) return sh('taskkill /F /IM "' + app + '.exe" 2>nul');
      if (IS_MAC) return sh('osascript -e \\'tell application "' + app + '" to quit\\'');
      return sh('pkill -f "' + app + '"');
    }
    return { ok: false, error: 'Unknown tool: ' + tool };
  }
};`,
      },
      {
        id: 'timer-alarm',
        name: 'Timer',
        description: 'Set timers with notifications.',
        version: '1.0.0',
        author: 'Horizon Team',
        category: 'productivity',
        tier: 'built_in',
        icon: '⏱️',
        price: 0,
        permissions: [],
        tools: [
          { name: 'set_timer',   description: 'Set a timer for N minutes', params: { minutes: 'number', label: 'string' } },
          { name: 'list_timers', description: 'List active timers',         params: {} },
        ],
        handler: `'use strict';
const timers = new Map(); let id = 1;
module.exports = {
  async execute(tool, args = {}) {
    if (tool === 'set_timer') {
      const m = parseFloat(args.minutes) || 1;
      const tid = 'T' + (id++);
      const end = Date.now() + m * 60000;
      setTimeout(() => timers.delete(tid), m * 60000);
      timers.set(tid, { label: args.label || '', end });
      return { ok: true, out: tid + ' set for ' + m + ' min (ends ' + new Date(end).toLocaleTimeString() + ')' };
    }
    if (tool === 'list_timers') {
      return { ok: true, out: [...timers.entries()].map(([k,v]) => k + ' — ' + v.label).join('\\n') || '(no timers)' };
    }
    return { ok: false, error: 'Unknown tool: ' + tool };
  }
};`,
      },
    ];
  }
}

module.exports = { PluginManager };
