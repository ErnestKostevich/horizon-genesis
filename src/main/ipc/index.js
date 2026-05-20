'use strict';

// Aggregator — register every ipc/* module from a single call site in main.js.
// Sprint 6 of the ultrareview roadmap: each category file owns its handler
// block, this file just wires them together.

const system     = require('./system');
const settings   = require('./settings');
const computerUse = require('./computerUse');
const workspace  = require('./workspace');
const ai         = require('./ai');
const memory     = require('./memory');
const channels   = require('./channels');
const mcp        = require('./mcp');
const skills     = require('./skills');
const workflows  = require('./workflows');

function registerAll(deps) {
  // Order mirrors the original file so the Pro-guard wrapping and any
  // future channel-name collision detection logs see handlers register
  // in a predictable sequence.
  system.register(deps);
  settings.register(deps);
  computerUse.register(deps);
  workspace.register(deps);
  ai.register(deps);
  memory.register(deps);
  channels.register(deps);
  mcp.register(deps);
  skills.register(deps);
  workflows.register(deps);
}

module.exports = { registerAll };
