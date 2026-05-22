// bin/tui-ink/components/ToolCard.mjs
//
// Tool-call card. Rounded border with a coloured accent depending on
// status (ok/err/skipped), a header line carrying the tool name +
// glyph + duration, and the body shows the args (truncated) and the
// first 4 lines of output.
//
// Inputs match the shape App.mjs uses for /demo-tool:
//   name        — tool name (e.g. "shell.run", "fs.read")
//   status      — 'ok' | 'err' | 'skipped'
//   durationMs  — wall-clock duration the tool took
//   args        — object — pretty-printed and truncated to 60 chars
//   output      — string — first 4 lines shown; rest hidden behind a …

import React from 'react';
import { Box, Text } from 'ink';

const STATUS = {
  ok:      { glyph: '✓', color: 'green' },
  err:     { glyph: '✗', color: 'red' },
  skipped: { glyph: '⊘', color: 'yellow' },
};

export default function ToolCard({ name, status = 'ok', durationMs = 0, args, output }) {
  const meta = STATUS[status] || STATUS.ok;
  const argStr = formatArgs(args);
  const outputLines = String(output || '').split('\n').filter(Boolean);
  const shown = outputLines.slice(0, 4);
  const hiddenCount = Math.max(0, outputLines.length - shown.length);

  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: meta.color, paddingX: 1, marginY: 0 },
    React.createElement(
      Box,
      null,
      React.createElement(Text, { color: meta.color, bold: true }, `${meta.glyph} `),
      React.createElement(Text, { bold: true }, name),
      React.createElement(Text, { dimColor: true }, `  ${formatDuration(durationMs)}`),
    ),
    argStr
      ? React.createElement(Text, { dimColor: true }, `  args ${argStr}`)
      : null,
    ...shown.map((line, i) =>
      React.createElement(Text, { key: i }, '  ' + line),
    ),
    hiddenCount > 0
      ? React.createElement(Text, { dimColor: true }, `  … +${hiddenCount} more lines`)
      : null,
  );
}

function formatArgs(args) {
  if (!args) return '';
  try {
    const s = JSON.stringify(args);
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  } catch (_) {
    return '';
  }
}

function formatDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
