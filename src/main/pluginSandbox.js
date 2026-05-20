'use strict';
/**
 * Plugin Sandbox — Sprint 6.
 *
 * Runs untrusted community plugins inside a Node `vm` context with a
 * restricted globals set and a tightly-scoped `require()` shim. Built-in
 * / demo / local / marketplace plugins (the "trusted" tiers) keep the
 * normal `require()` path — they have admin-reviewed code or ship with
 * the app, so the sandbox would only get in the way (clipboard /
 * screenshot need Electron, spotify needs electron-store, etc).
 *
 * Threat model:
 *   - A hostile community plugin (zip dropped via share-url, fetched from
 *     the marketplace before review, or installed from a paste) must NOT
 *     be able to:
 *       · read or write arbitrary files (no `fs`)
 *       · spawn processes or exec shell (no `child_process`)
 *       · open raw sockets (no `net`, no `http`, no `https`, no `tls`,
 *         no `dgram`)
 *       · enumerate the host OS (no `os`)
 *       · reach into the host Node process (no `process` global, no
 *         `require.main`, no `process.binding`)
 *       · monkey-patch host globals (the sandbox is a fresh context;
 *         mutations stay inside it)
 *   - The plugin CAN do exactly what its manifest's `permissions` field
 *     authorises, through `ctx.fetch` / `ctx.storage` / `ctx.logger`
 *     which are constructed by the host with permission checks baked in.
 *   - The plugin CAN import the four trivially-safe stdlib modules used
 *     by ~every plugin we've seen: `path`, `url`, `crypto`, `util`.
 *
 * Backwards compat:
 *   Setting `HORIZON_PLUGIN_NO_SANDBOX=1` bypasses the sandbox entirely
 *   for the current process. This is a development affordance — it lets
 *   a plugin author iterate on a community plugin with full Node access
 *   without having to bump their manifest's tier to `local`. NEVER turn
 *   this on for end users.
 */

const vm = require('vm');

// Allow-list for `require()` inside the sandbox. These four are pure
// data / format / hash utilities — none of them give the plugin access
// to the filesystem, network, or process. Adding anything else here
// (`os`, `crypto.createPrivateKey`-via-`fs`, etc) MUST go through a
// security review.
const ALLOWED_MODULES = new Set(['path', 'url', 'crypto', 'util']);

function isSandboxDisabled() {
  return process.env.HORIZON_PLUGIN_NO_SANDBOX === '1';
}

function makeRestrictedRequire(pluginId) {
  return function restrictedRequire(modName) {
    if (typeof modName !== 'string') {
      throw new TypeError(`Plugin ${pluginId}: require() needs a string`);
    }
    // Block relative imports outright — a plugin's `handler.js` is a
    // single file by contract. Allowing `./` would let a plugin ship
    // an unreviewed second JS file (or read a JSON file via `require`)
    // and escape the single-file audit surface.
    if (modName.startsWith('.') || modName.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(modName)) {
      throw new Error(`Plugin ${pluginId}: require('${modName}') — relative/absolute imports are not allowed in the sandbox`);
    }
    if (!ALLOWED_MODULES.has(modName)) {
      throw new Error(`Plugin ${pluginId}: require('${modName}') is not allowed in the sandbox (allowed: ${[...ALLOWED_MODULES].join(', ')})`);
    }
    // Safe to forward — these are core modules with no host-side
    // privileges beyond their published API.
    return require(modName);
  };
}

/**
 * Build the vm context for a plugin and the matching `ctx` object that
 * the plugin will receive as the third argument to `execute()`.
 *
 * @param {string} pluginId
 * @param {object} manifest
 * @param {object} deps
 * @param {(manifest: object) => object} deps.ctxBuilder
 *   Function that returns `{ settings, fetch, logger, storage }` — built
 *   by the PluginManager so the same fetch/logger/storage plumbing is
 *   used for sandboxed and unsandboxed plugins alike.
 *
 * @returns {{ sandbox: object, ctx: object }}
 */
function createPluginSandbox(pluginId, manifest, deps) {
  if (!deps || typeof deps.ctxBuilder !== 'function') {
    throw new Error('createPluginSandbox: deps.ctxBuilder is required');
  }
  const ctx = deps.ctxBuilder(manifest);

  // Build a console that forwards to the plugin's logger (which already
  // writes to <userData>/plugin-logs/<id>.log and mirrors to stdout).
  // This is what catches the plugin's `console.log` / `console.error`
  // calls so they show up in the right log file instead of polluting
  // host stdout anonymously.
  const sandboxConsole = {
    log:   (...args) => { try { ctx.logger.info(_fmt(args)); } catch (_) {} },
    info:  (...args) => { try { ctx.logger.info(_fmt(args)); } catch (_) {} },
    warn:  (...args) => { try { ctx.logger.warn(_fmt(args)); } catch (_) {} },
    error: (...args) => { try { ctx.logger.error(_fmt(args)); } catch (_) {} },
    debug: (...args) => { try { ctx.logger.info(_fmt(args)); } catch (_) {} },
  };

  // Explicit module/exports — the runner code will `Object.assign` exports
  // back onto module.exports for plugins that use the `module.exports = ...`
  // form vs the `exports.foo = ...` form. We materialise both before the
  // plugin runs so either style works.
  const moduleObj = { exports: {} };

  // Restricted globals. Note we do NOT expose `process`, `global`,
  // `globalThis` (sandbox.globalThis will be the sandbox object itself
  // after createContext, which is the desired behaviour — it confines
  // global mutations to the sandbox).
  const sandbox = {
    console: sandboxConsole,
    // Timers — plugins legitimately use these for poll loops, debounce,
    // and request timeouts. They're scoped to the host event loop but
    // the plugin can't directly observe other timers (no access to
    // process.binding).
    setTimeout, clearTimeout, setInterval, clearInterval,
    setImmediate, clearImmediate,
    // Data + format primitives. None of these reveal host state.
    Promise, Date, Math, JSON, RegExp, Error, TypeError, RangeError,
    Array, Object, String, Number, Boolean, Symbol, Map, Set, WeakMap, WeakSet,
    ArrayBuffer, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array,
    Float32Array, Float64Array, DataView,
    URL, URLSearchParams,
    // Buffer is needed for any plugin that decodes binary data (PNG
    // encoding, base64 round-trips). It does NOT give file/network
    // access on its own.
    Buffer,
    // TextEncoder/Decoder for UTF-8 boundaries — purely data.
    TextEncoder, TextDecoder,
    // Module shim.
    module: moduleObj,
    exports: moduleObj.exports,
    require: makeRestrictedRequire(pluginId),
  };

  // Keep `exports` aliased to `module.exports` even after the plugin
  // reassigns `module.exports = ...`. We accomplish this by reading
  // back module.exports after the run, in the caller — see
  // pluginManager.loadPluginInSandbox.

  return { sandbox, ctx };
}

function _fmt(args) {
  // Match the default node console formatter "best effort" — JSON
  // stringify objects so the plugin's `console.log({a:1})` shows up
  // readable in the log file instead of as `[object Object]`.
  return args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); }
    catch (_) { return String(a); }
  }).join(' ');
}

/**
 * Load `handler.js` source inside a sandboxed vm context.
 *
 * @param {string} pluginId
 * @param {object} manifest
 * @param {string} code         The handler.js source (already read by caller)
 * @param {string} filename     Absolute path to handler.js — used by V8
 *                              for stack traces
 * @param {object} deps         See createPluginSandbox.
 * @param {object} [options]
 * @param {number} [options.timeout=30000]
 *   Max ms the top-level script (the module body, NOT individual
 *   `execute()` calls) is allowed to run. 30 s is generous — module
 *   bodies should be near-instant; a long-running module body almost
 *   always means an infinite loop in a top-level `while (true)`.
 *
 * @returns {{ exports: object, ctx: object }}
 */
function runHandlerInSandbox(pluginId, manifest, code, filename, deps, options = {}) {
  const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 30000;
  const { sandbox, ctx } = createPluginSandbox(pluginId, manifest, deps);
  vm.createContext(sandbox);
  vm.runInContext(String(code || ''), sandbox, {
    filename: filename || `plugin:${pluginId}/handler.js`,
    timeout,
    displayErrors: true,
  });
  // Resolve final exports — supports BOTH `module.exports = {...}` (most
  // common in our plugins) and `exports.foo = ...` (CommonJS-y).
  const handlerExports = sandbox.module && sandbox.module.exports
    ? sandbox.module.exports
    : sandbox.exports;
  return { exports: handlerExports, ctx };
}

module.exports = {
  createPluginSandbox,
  runHandlerInSandbox,
  ALLOWED_MODULES,
  isSandboxDisabled,
};
