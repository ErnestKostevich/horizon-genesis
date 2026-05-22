// bin/tui-ink/components/StatusBar.mjs
//
// Two-row status bar matching the readline TUI's Hermes-style layout:
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │ ● ready  ·  claude:sonnet-4-6  ·  jarvis  ·  ~/Genesis (main)        │
//   │ 0 tokens  ·  ▱▱▱▱▱▱▱▱▱▱  ·  $0.00  ·  00:00  ·  idle                 │
//   └────────────────────────────────────────────────────────────────────┘
//
// Implemented as a bordered <Box> with two horizontal rows. Values are
// pulled live from runtime each render. Real port would tap costTracker
// + agentLoop events to update tokens / progress / timer in real-time.

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const fs = require('node:fs');

export default function StatusBar({
  runtime, provider, model, persona, themeName,
  busy, busyLabel, messageCount,
}) {
  const cwd = runtime?.workspaceDir || process.cwd();
  const cwdShort = shortenCwd(cwd);
  const branch = gitBranch(cwd);

  // Cost + tokens come from the cost tracker if available.
  const cost = formatCost(safeGet(runtime, 'costTracker', 'totalUsd'));
  const tokens = safeGet(runtime, 'costTracker', 'totalTokens') || 0;

  // Context window progress — approximation; real port reads ctxFor(model)
  // from bin/lib/themes.js and divides current convo tokens.
  const pct = Math.min(1, tokens / 200000);
  const bar = renderBar(pct, 10);

  const stateLabel = busy
    ? (busyLabel || 'working…')
    : 'ready';
  const stateDot = busy ? React.createElement(Spinner, { type: 'dots' }) : React.createElement(Text, { color: 'green' }, '●');

  // Row 1: state · provider:model · persona · ~/cwd (branch)
  const row1 = React.createElement(
    Box,
    { paddingX: 1 },
    stateDot,
    React.createElement(Text, null, ' ' + stateLabel),
    sep(),
    React.createElement(Text, { color: 'cyan' }, `${provider}:${model}`),
    sep(),
    React.createElement(Text, null, persona),
    sep(),
    React.createElement(Text, { dimColor: true }, cwdShort + (branch ? `  (${branch})` : '')),
  );

  // Row 2: tokens · progress · cost · timer · msgs
  const row2 = React.createElement(
    Box,
    { paddingX: 1 },
    React.createElement(Text, { dimColor: true }, `${formatTokens(tokens)} tokens`),
    sep(),
    React.createElement(Text, { color: 'magenta' }, bar),
    sep(),
    React.createElement(Text, { dimColor: true }, cost),
    sep(),
    React.createElement(Text, { dimColor: true }, `${messageCount} msgs`),
    sep(),
    React.createElement(Text, { dimColor: true }, `theme:${themeName}`),
  );

  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', marginTop: 1 },
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
  } catch (_) {
    return undefined;
  }
}

function formatTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1000000).toFixed(2) + 'M';
}

function formatCost(usd) {
  const n = Number(usd || 0);
  return '$' + n.toFixed(4);
}

function renderBar(pct, width) {
  const fill = Math.round(pct * width);
  return '▰'.repeat(fill) + '▱'.repeat(width - fill);
}

function shortenCwd(cwd) {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && cwd.startsWith(home)) {
    return '~' + cwd.slice(home.length).replace(/\\/g, '/');
  }
  return cwd.replace(/\\/g, '/');
}

let _branchCache;
function gitBranch(cwd) {
  if (_branchCache !== undefined) return _branchCache;
  try {
    let dir = cwd;
    while (dir && dir !== path.dirname(dir)) {
      const head = path.join(dir, '.git', 'HEAD');
      if (fs.existsSync(head)) {
        const c = fs.readFileSync(head, 'utf8').trim();
        const m = c.match(/^ref:\s+refs\/heads\/(.+)$/);
        _branchCache = m ? m[1] : c.slice(0, 7);
        return _branchCache;
      }
      dir = path.dirname(dir);
    }
  } catch (_) {}
  _branchCache = null;
  return null;
}
