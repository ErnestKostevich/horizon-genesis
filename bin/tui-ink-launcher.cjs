#!/usr/bin/env node
// bin/tui-ink-launcher.cjs
//
// Standalone CJS launcher for the Ink TUI prototype. Lets you run the
// Ink TUI without the readline machinery for a clean visual comparison:
//
//   node bin/tui-ink-launcher.cjs
//
// Mirrors what `bin/horizon.js tui --ink` does internally — boots the
// shared headless runtime and dynamic-imports the ESM Ink entry.

'use strict';

// Mirror the deprecation suppression from bin/horizon.js so we don't
// clutter the splash with punycode warnings.
process.noDeprecation = true;
process.removeAllListeners('warning');

process.on('uncaughtException', (e) => {
  process.stderr.write('\n\x1b[31m[fatal]\x1b[0m ' + (e?.stack || e?.message || String(e)) + '\n');
  process.exit(1);
});
process.on('unhandledRejection', (r) => {
  process.stderr.write('\n\x1b[31m[reject]\x1b[0m ' + (r?.stack || r?.message || String(r)) + '\n');
});

const path = require('path');
const url = require('url');

async function main() {
  const { createHorizonRuntime } = require('../src/main/runtime/headless');
  const runtime = createHorizonRuntime({
    workspaceDir: process.cwd(),
    verbose: process.argv.includes('--verbose'),
  });
  const inkUrl = url.pathToFileURL(
    path.join(__dirname, 'tui-ink', 'index.mjs')
  ).href;
  const inkMod = await import(inkUrl);
  await inkMod.start({ runtime, flags: {} });
}

main().catch((e) => {
  process.stderr.write('\x1b[31m[ink-launcher]\x1b[0m ' + (e?.stack || e?.message || String(e)) + '\n');
  process.exit(1);
});
