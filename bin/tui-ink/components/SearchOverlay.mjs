// bin/tui-ink/components/SearchOverlay.mjs
//
// Sprint-2.13 — scrollback search overlay. Triggered by Ctrl-R from
// App.mjs. Shows a query input + filtered hit list with the matched
// substring highlighted.
//
//   ╭─ 🔍 Search transcript ─────────────────────────────────────╮
//   │ query: open                                                 │
//   │                                                             │
//   │ 1.  ▌ you · 14:32   please open the readme                 │
//   │ 2.  ⌁ horizon · 14:32   I'll open it now…                  │
//   │ 3.  ✓ open_file  file=README.md (412ms)                     │
//   ╰─────────────────────────────────────────────────────────────╯
//   ↑↓ navigate · Enter jump · Esc cancel · 2/3 matches

import React from 'react';
import { Box, Text } from 'ink';

export default function SearchOverlay({ query, hits, pos }) {
  const total = hits.length;
  const display = hits.slice(Math.max(0, pos - 2), pos + 4).slice(0, 6);

  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'magenta',
      paddingX: 1,
    },
    React.createElement(
      Box,
      null,
      React.createElement(Text, { color: 'magenta', bold: true }, '🔍 Search transcript'),
      React.createElement(Text, { dimColor: true }, total > 0 ? `   ${pos + 1}/${total} matches` : '   no matches'),
    ),
    React.createElement(
      Box,
      { marginTop: 0 },
      React.createElement(Text, { dimColor: true }, 'query: '),
      React.createElement(Text, { color: 'magenta', bold: true }, query || ''),
      React.createElement(Text, { inverse: true }, ' '),
    ),
    ...display.map((hit, i) => {
      const absIdx = Math.max(0, pos - 2) + i;
      const isActive = absIdx === pos;
      return React.createElement(
        Box,
        { key: 'hit-' + absIdx, marginTop: i === 0 ? 1 : 0 },
        React.createElement(
          Text,
          { color: isActive ? 'cyan' : 'gray', bold: isActive },
          (isActive ? '▶ ' : '  ') + String(absIdx + 1).padStart(2) + '. ',
        ),
        _highlightLine(hit.preview, query, isActive),
      );
    }),
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, '  ↑↓ navigate  ·  Enter jump  ·  Esc cancel'),
    ),
  );
}

function _highlightLine(text, query, isActive) {
  if (!query) return React.createElement(Text, { dimColor: !isActive }, text);
  const lower = text.toLowerCase();
  const lq = query.toLowerCase();
  const idx = lower.indexOf(lq);
  if (idx < 0) return React.createElement(Text, { dimColor: !isActive }, text);
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return React.createElement(
    Box,
    null,
    React.createElement(Text, { dimColor: !isActive }, before),
    React.createElement(Text, { color: 'magenta', bold: true, inverse: true }, match),
    React.createElement(Text, { dimColor: !isActive }, after),
  );
}
