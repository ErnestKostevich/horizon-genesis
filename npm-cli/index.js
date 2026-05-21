// @horizonai/cli — programmatic entrypoint.
//
// Most users invoke `horizon` from a shell. This file exists so library
// consumers can still `require('@horizonai/cli')` and get at the
// headless runtime / agent loop without spawning a child process.
//
// What you get here is a thin re-export surface. Anything that needs the
// actual binary (TUI, splash, argv parser) lives in lib/bin/horizon.js
// and is executed via the bin shim.

'use strict';

const path = require('path');

function safeRequire(rel) {
  try {
    return require(path.join(__dirname, 'lib', rel));
  } catch (_) {
    return null;
  }
}

module.exports = {
  // Headless runtime — load API keys, settings, memory; expose providers.
  createHorizonRuntime: () => {
    const m = safeRequire('src/main/runtime/headless');
    return m && m.createHorizonRuntime;
  },
  // Default platform-specific user data dir (Electron userData layout).
  defaultUserDataDir: () => {
    const m = safeRequire('src/main/runtime/store-shim');
    return m && m.defaultUserDataDir && m.defaultUserDataDir();
  },
  // Version metadata pulled from the published package.json.
  version: require('./package.json').version,
};
