#!/usr/bin/env node
// scripts/build-npm-cli.js
//
// Builds the @horizonai/cli npm package by copying the CLI source files
// out of horizon-genesis into npm-cli/lib/. Approach B from Sprint 7A:
// keep horizon-genesis as the canonical Electron repo, mirror only what
// the headless CLI needs into a separate publishable directory.
//
// Run this before `cd npm-cli && npm publish`.
//
// Usage:
//   node scripts/build-npm-cli.js             # full copy
//   node scripts/build-npm-cli.js --dry-run   # log what would happen
//   node scripts/build-npm-cli.js --clean     # wipe npm-cli/lib first
//
// Exit codes:
//   0  ok
//   1  missing source file (build aborted)
//   2  invalid args
//
// What this copies:
//   bin/horizon.js, bin/horizon-tui.js, bin/horizon-serve.js
//   bin/lib/** (argv, banner, commands, etc.)
//   src/main/runtime/**
//   src/main/agent.js, agentLoop.js
//   src/main/skillsManager.js, skillsParser.js, skillScanner.js,
//     skillImporter.js, skillsRelevance.js, agentSkillsImporter.js
//   src/main/embeddings.js, personas.js, executor.js
//   src/main/connectionsManager.js, discordGateway.js, slackSocketMode.js
//   src/main/channels/**, channelAdapters/**
//   src/main/workspaceMemory.js, workspaceIndexer.js
//   src/main/memoryFts.js, memoryDb.js, memoryReviewer.js
//   src/main/dialecticModel.js, skillSuggester.js
//   src/main/canvasManager.js, projectConfig.js
//   src/main/mcp/**, mcpServers.js
//   src/main/tools/**
//   src/main/pluginManager.js, pluginSandbox.js, marketplaceApi.js,
//     licenseManager.js
//   src/main/imageGen.js, browserAutomation.js, computerUse.js,
//     screenRecorder.js, googleAuth.js, githubConnector.js, workflowEngine.js
//   src/main/build-info.json
//   builtin-skills/** (the agent expects these at runtime)
//   package.json (for version / dependency metadata reads)
//
// What this skips (Electron-only):
//   src/main/main.js              -- needs BrowserWindow, ipcMain, Tray
//   src/main/preload.js           -- renderer-only
//   src/main/ipc/**               -- ipcMain handlers; CLI uses runtime/ directly
//   src/renderer/**               -- the entire desktop UI
//   builtin-plugins/**            -- bundled separately; the CLI ships
//                                    without them by default

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NPM_CLI_DIR = path.join(ROOT, 'npm-cli');
const LIB_DIR = path.join(NPM_CLI_DIR, 'lib');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const CLEAN = args.includes('--clean');

// What to copy, expressed as { src (relative to ROOT), dst (relative to LIB_DIR) }.
const PATHS = [
  // CLI entrypoints
  { src: 'bin/horizon.js',         dst: 'bin/horizon.js' },
  { src: 'bin/horizon-tui.js',     dst: 'bin/horizon-tui.js' },
  { src: 'bin/horizon-serve.js',   dst: 'bin/horizon-serve.js' },
  { src: 'bin/lib',                dst: 'bin/lib', dir: true },

  // Runtime (shared with Electron)
  { src: 'src/main/runtime',       dst: 'src/main/runtime', dir: true },

  // Core agent loop + tooling
  { src: 'src/main/agent.js',                  dst: 'src/main/agent.js' },
  { src: 'src/main/agentLoop.js',              dst: 'src/main/agentLoop.js' },
  { src: 'src/main/agentSkillsImporter.js',    dst: 'src/main/agentSkillsImporter.js' },

  // Skills
  { src: 'src/main/skillsManager.js',          dst: 'src/main/skillsManager.js' },
  { src: 'src/main/skillsParser.js',           dst: 'src/main/skillsParser.js' },
  { src: 'src/main/skillScanner.js',           dst: 'src/main/skillScanner.js' },
  { src: 'src/main/skillImporter.js',          dst: 'src/main/skillImporter.js' },
  { src: 'src/main/skillsRelevance.js',        dst: 'src/main/skillsRelevance.js' },
  { src: 'src/main/skillSuggester.js',         dst: 'src/main/skillSuggester.js' },

  // Memory layer
  { src: 'src/main/embeddings.js',             dst: 'src/main/embeddings.js' },
  { src: 'src/main/memoryFts.js',              dst: 'src/main/memoryFts.js' },
  { src: 'src/main/memoryDb.js',               dst: 'src/main/memoryDb.js' },
  { src: 'src/main/memoryReviewer.js',         dst: 'src/main/memoryReviewer.js' },
  { src: 'src/main/memoryConsolidator.js',     dst: 'src/main/memoryConsolidator.js' },
  { src: 'src/main/scratchpad.js',             dst: 'src/main/scratchpad.js' },
  { src: 'src/main/dialecticModel.js',         dst: 'src/main/dialecticModel.js' },
  { src: 'src/main/workspaceMemory.js',        dst: 'src/main/workspaceMemory.js' },
  { src: 'src/main/workspaceIndexer.js',       dst: 'src/main/workspaceIndexer.js' },

  // Personas + executor
  { src: 'src/main/personas.js',               dst: 'src/main/personas.js' },
  { src: 'src/main/executor.js',               dst: 'src/main/executor.js' },

  // Connections (channels and adapters)
  { src: 'src/main/connectionsManager.js',     dst: 'src/main/connectionsManager.js' },
  { src: 'src/main/discordGateway.js',         dst: 'src/main/discordGateway.js' },
  { src: 'src/main/slackSocketMode.js',        dst: 'src/main/slackSocketMode.js' },
  { src: 'src/main/channels',                  dst: 'src/main/channels', dir: true },
  { src: 'src/main/channelAdapters',           dst: 'src/main/channelAdapters', dir: true },

  // MCP
  { src: 'src/main/mcp',                       dst: 'src/main/mcp', dir: true },
  { src: 'src/main/mcpServers.js',             dst: 'src/main/mcpServers.js' },

  // Tools
  { src: 'src/main/tools',                     dst: 'src/main/tools', dir: true },

  // Canvas + project config
  { src: 'src/main/canvasManager.js',          dst: 'src/main/canvasManager.js' },
  { src: 'src/main/projectConfig.js',          dst: 'src/main/projectConfig.js' },

  // Plugins (used by CLI for `horizon plugins` even if sandbox isn't booted)
  { src: 'src/main/pluginManager.js',          dst: 'src/main/pluginManager.js' },
  { src: 'src/main/pluginSandbox.js',          dst: 'src/main/pluginSandbox.js' },
  { src: 'src/main/marketplaceApi.js',         dst: 'src/main/marketplaceApi.js' },
  { src: 'src/main/licenseManager.js',         dst: 'src/main/licenseManager.js' },

  // Browser + computer use + image gen (lazy-required; safe to ship)
  { src: 'src/main/browserAutomation.js',      dst: 'src/main/browserAutomation.js' },
  { src: 'src/main/computerUse.js',            dst: 'src/main/computerUse.js' },
  { src: 'src/main/screenRecorder.js',         dst: 'src/main/screenRecorder.js' },
  { src: 'src/main/imageGen.js',               dst: 'src/main/imageGen.js' },

  // External integrations
  { src: 'src/main/googleAuth.js',             dst: 'src/main/googleAuth.js' },
  { src: 'src/main/githubConnector.js',        dst: 'src/main/githubConnector.js' },

  // Workflows
  { src: 'src/main/workflowEngine.js',         dst: 'src/main/workflowEngine.js' },

  // Build info JSON (the version banner reads it)
  { src: 'src/main/build-info.json',           dst: 'src/main/build-info.json' },

  // Builtin skills the agent expects at runtime
  { src: 'builtin-skills',                     dst: 'builtin-skills', dir: true },

  // The headless code reads horizon-genesis package.json for version info.
  // We copy it as `host-package.json` so it doesn't collide with the npm-cli
  // package.json that lives one level up.
  { src: 'package.json',                       dst: 'src/main/host-package.json' },
];

function log(...a) { process.stdout.write(a.join(' ') + '\n'); }
function warn(...a) { process.stderr.write('[warn] ' + a.join(' ') + '\n'); }
function err(...a)  { process.stderr.write('[err]  ' + a.join(' ') + '\n'); }

function copyFileSafe(srcAbs, dstAbs) {
  if (DRY) { log(`  copy ${path.relative(ROOT, srcAbs)} -> ${path.relative(ROOT, dstAbs)}`); return; }
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.copyFileSync(srcAbs, dstAbs);
}

function copyDirSafe(srcAbs, dstAbs) {
  if (!fs.existsSync(srcAbs)) {
    warn(`directory missing, skipping: ${path.relative(ROOT, srcAbs)}`);
    return;
  }
  if (DRY) { log(`  copy dir ${path.relative(ROOT, srcAbs)} -> ${path.relative(ROOT, dstAbs)}`); return; }
  fs.mkdirSync(dstAbs, { recursive: true });
  for (const entry of fs.readdirSync(srcAbs, { withFileTypes: true })) {
    const s = path.join(srcAbs, entry.name);
    const d = path.join(dstAbs, entry.name);
    if (entry.isDirectory()) copyDirSafe(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function removeIfExists(p) {
  if (!fs.existsSync(p)) return;
  if (DRY) { log(`  rm -rf ${path.relative(ROOT, p)}`); return; }
  fs.rmSync(p, { recursive: true, force: true });
}

(function main() {
  log(`build-npm-cli: ${DRY ? '[dry-run] ' : ''}building @horizonai/cli into ${path.relative(ROOT, LIB_DIR)}`);

  if (!fs.existsSync(NPM_CLI_DIR)) {
    err(`npm-cli/ does not exist at ${NPM_CLI_DIR}`);
    process.exit(1);
  }

  if (CLEAN) {
    log('cleaning lib/ first');
    removeIfExists(LIB_DIR);
  }

  fs.mkdirSync(LIB_DIR, { recursive: true });

  let missing = 0;
  for (const entry of PATHS) {
    const src = path.join(ROOT, entry.src);
    const dst = path.join(LIB_DIR, entry.dst);
    if (!fs.existsSync(src)) {
      warn(`source missing: ${entry.src}`);
      missing++;
      continue;
    }
    if (entry.dir) copyDirSafe(src, dst);
    else copyFileSafe(src, dst);
  }

  if (missing > 0) {
    warn(`${missing} source path(s) were missing; package may be incomplete`);
  }
  log(DRY ? 'dry-run complete' : 'build complete');
})();
