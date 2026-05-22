// bin/tui-ink/components/StatusBar.mjs
//
// Sprint-2.11 — promoted to functional. Two-row bordered status bar
// matching the readline TUI conventions exactly:
//
//   ╭────────────────────────────────────────────────────────────────╮
//   │ ● ready  ⌁ claude:sonnet-4-6  jarvis  ~/Genesis (main)           │
//   │   12K/200K  [█████▎░░░░] 6%  $0.04  · 12s  theme:cyberpunk      │
//   ╰────────────────────────────────────────────────────────────────╯
//
// Eighths-block bar (▏▎▍▌▋▊▉█) so even <1% usage shows a sliver instead
// of empty. Context window pulled from themes.ctxFor(model).

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const fs = require('node:fs');
const { ctxFor } = require('../../lib/themes.js');

export default function StatusBar({
  runtime, provider, model, persona, themeName,
  busy, busyLabel, messageCount,
  tokens, cost,
}) {
  const cwd = runtime?.workspaceDir || process.cwd();
  const cwdShort = shortenCwd(cwd);
  const branch = gitBranch(cwd);

  // Tokens / cost come from accumulator props (App tracks them); if not
  // supplied, fall back to costTracker totals.
  const totalTokens = (typeof tokens === 'number')
    ? tokens
    : (safeGet(runtime, 'costTracker', 'totalTokens') || 0);
  const totalCost = (typeof cost === 'number')
    ? cost
    : (safeGet(runtime, 'costTracker', 'totalUsd') || 0);

  // Context window — bar is "used / max" of THIS model.
  const ctxMax = ctxFor(model) || 200000;
  const pct = Math.max(0, Math.min(100, (totalTokens / ctxMax) * 100));
  const barRendered = renderEighthsBar(pct, 10);
  const barColor = pct >= 95 ? 'red' : pct >= 80 ? 'yellow' : pct >= 50 ? 'yellow' : 'green';
  const pctLabel = pct >= 10 ? Math.round(pct) + '%' : pct.toFixed(1) + '%';

  const stateLabel = busy ? (busyLabel || 'working…') : 'ready';
  const stateColor = busy ? 'cyan' : 'green';
  const stateDot = busy
    ? React.createElement(Spinner, { type: 'dots' })
    : React.createElement(Text, { color: 'green' }, '●');

  // Row 1: state · provider:model · persona · cwd (branch)
  const row1 = React.createElement(
    Box,
    { paddingX: 1 },
    React.createElement(Text, { color: stateColor }, '▎ '),
    stateDot,
    React.createElement(Text, { color: stateColor }, ' ' + stateLabel),
    sep(),
    React.createElement(Text, { color: 'cyan', bold: true }, '⌁ ' + provider + ':' + truncate(model, 24)),
    sep(),
    React.createElement(Text, { color: 'magenta' }, persona),
    sep(),
    React.createElement(Text, { dimColor: true }, cwdShort + (branch ? '  (' + branch + ')' : '')),
  );

  // Row 2: tokens/max · [bar] pct% · $cost · msgs · theme
  const row2 = React.createElement(
    Box,
    { paddingX: 1 },
    React.createElement(Text, { dimColor: true }, '  '),
    React.createElement(Text, { dimColor: true }, formatTokens(totalTokens) + '/' + formatTokens(ctxMax)),
    sep(),
    React.createElement(Text, { color: barColor }, '[' + barRendered + '] ' + pctLabel),
    sep(),
    React.createElement(Text, { color: 'green' }, formatCost(totalCost)),
    sep(),
    React.createElement(Text, { dimColor: true }, messageCount + ' msgs'),
    sep(),
    React.createElement(Text, { dimColor: true }, 'theme:' + themeName),
  );

  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray' },
    row1,
    row2,
  );
}

function sep() {
  return React.createElement(Text, { dimColor: true }, '  ·  ');
}

function safeGet(runtime, name, key) {
  try {
    const v = runtime?.[name];
    if (!v) return undefined;
    if (typeof v[key] === 'function') return v[key]();
    return v[key];
  } catch (_) { return undefined; }
}

function formatTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return (n / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M';
}

function formatCost(usd) {
  const n = Number(usd || 0);
  if (n < 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

// Sprint-2.11 — eighths-block bar matching readline TUI. 8 sub-steps
// per cell so small usage still registers as a visible sliver instead
// of "no bar at all". Total visual width stays the same.
const _BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
function renderEighthsBar(pct, width) {
  const sub = Math.max(0, Math.min(width * 8, Math.round((pct / 100) * width * 8)));
  const fullCells = Math.floor(sub / 8);
  const remainder = sub % 8;
  const empty = width - fullCells - (remainder > 0 ? 1 : 0);
  return '█'.repeat(fullCells)
       + (remainder > 0 ? _BLOCKS[remainder] : '')
       + '░'.repeat(Math.max(0, empty));
}

function truncate(s, n) {
  s = String(s || '');
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function shortenCwd(cwd) {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && cwd.startsWith(home)) {
    return '~' + cwd.slice(home.length).replace(/\\/g, '/');
  }
  return cwd.replace(/\\/g, '/');
}

// Sprint-2.14.2 — cwd-keyed cache with a 10-second TTL. The old
// process-global cache meant `git checkout` or shell `cd` during a TUI
// session would still show the original branch forever. Now each
// distinct cwd gets its own entry, and entries expire after 10s so a
// branch switch shows up on the next status-bar refresh.
const _branchCache = new Map();
function gitBranch(cwd) {
  const now = Date.now();
  const entry = _branchCache.get(cwd);
  if (entry && (now - entry.t) < 10_000) return entry.v;
  let branch = null;
  try {
    let dir = cwd;
    while (dir && dir !== path.dirname(dir)) {
      const head = path.join(dir, '.git', 'HEAD');
      if (fs.existsSync(head)) {
        const c = fs.readFileSync(head, 'utf8').trim();
        const m = c.match(/^ref:\s+refs\/heads\/(.+)$/);
        branch = m ? m[1] : c.slice(0, 7);
        break;
      }
      dir = path.dirname(dir);
    }
  } catch (_) {}
  _branchCache.set(cwd, { v: branch, t: now });
  return branch;
}
