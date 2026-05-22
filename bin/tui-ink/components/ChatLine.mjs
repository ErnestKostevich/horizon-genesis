// bin/tui-ink/components/ChatLine.mjs
//
// Single transcript line. Sprint-2.11 — caption-style prefixes that
// match the readline TUI exactly so the two surfaces feel identical.
//
//   user      → "▌ you · HH:MM"  + indented "▏ <text>" lines
//   assistant → "⌁ horizon · HH:MM" + markdown-rendered body
//   system    → "· <text>" (dim)
//   tool      → handled by ToolCard, not here

import React from 'react';
import { Box, Text } from 'ink';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { renderMarkdown } = require('../../lib/markdown.js');

function _hhmm() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':'
       + String(d.getMinutes()).padStart(2, '0');
}

export default function ChatLine({ type, text, ts }) {
  const stamp = ts || _hhmm();

  if (type === 'user') {
    const lines = String(text || '').split('\n');
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(
        Box,
        null,
        React.createElement(Text, { color: 'cyan' }, '▌ '),
        React.createElement(Text, { bold: true }, 'you'),
        React.createElement(Text, { dimColor: true }, ' · ' + stamp),
      ),
      ...lines.map((line, i) =>
        React.createElement(
          Box,
          { key: i },
          React.createElement(Text, { color: 'cyan' }, '▏ '),
          React.createElement(Text, null, line),
        ),
      ),
    );
  }

  if (type === 'assistant') {
    let rendered;
    try { rendered = renderMarkdown(text); }
    catch (_) { rendered = text; }
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, { dimColor: true }, '  ────'),
      React.createElement(
        Box,
        null,
        React.createElement(Text, { color: 'cyan' }, '⌁ '),
        React.createElement(Text, { bold: true }, 'horizon'),
        React.createElement(Text, { dimColor: true }, ' · ' + stamp),
      ),
      React.createElement(Text, null, rendered),
    );
  }

  // system / fallback — multi-line capable.
  const lines = String(text || '').split('\n');
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    ...lines.map((line, i) =>
      React.createElement(
        Box,
        { key: i },
        React.createElement(Text, { color: 'gray' }, '· '),
        React.createElement(Text, { dimColor: true }, line),
      ),
    ),
  );
}
