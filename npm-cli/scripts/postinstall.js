#!/usr/bin/env node
// @horizonai/cli postinstall — friendly first-touch message.
//
// We deliberately do NOT do any heavy compilation or downloads here. The
// only side effects:
//   1. Make `bin/horizon` executable (npm should already chmod +x bin
//      entries, but some Windows-on-WSL setups skip it).
//   2. Print a one-screen "what now" message so first-time users know to
//      run `horizon setup` instead of staring at a prompt.
//
// Run silently when CI is set so docker builds stay quiet.

'use strict';

const fs = require('fs');
const path = require('path');

function chmodIfPossible(file) {
  try {
    fs.chmodSync(file, 0o755);
  } catch (_) {
    // Read-only fs, npm cache postinstall — ignore.
  }
}

(function main() {
  const binFile = path.join(__dirname, '..', 'bin', 'horizon');
  if (fs.existsSync(binFile)) chmodIfPossible(binFile);

  // Stay quiet inside CI / non-TTY installs.
  if (process.env.CI || process.env.HORIZON_QUIET_INSTALL === '1') return;
  if (!process.stdout.isTTY) return;

  const PURPLE = '\x1b[38;5;141m';
  const DIM = '\x1b[2m';
  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';
  const CYAN = '\x1b[36m';

  const lines = [
    '',
    `${PURPLE}Horizon AI${RESET} ${DIM}-- installed.${RESET}`,
    '',
    `  ${BOLD}Quick start${RESET}`,
    `    ${CYAN}horizon setup${RESET}   ${DIM}-- pick a provider, paste your key (30s)${RESET}`,
    `    ${CYAN}horizon${RESET}         ${DIM}-- launch interactive TUI${RESET}`,
    `    ${CYAN}horizon "task"${RESET}  ${DIM}-- one-shot agent task${RESET}`,
    '',
    `  ${DIM}Docs:    https://horizonaai.dev${RESET}`,
    `  ${DIM}License: BUSL-1.1 -- personal + non-commercial use is free${RESET}`,
    '',
  ];
  try {
    process.stdout.write(lines.join('\n') + '\n');
  } catch (_) {
    /* swallow — never fail postinstall on TTY write errors */
  }
})();
