// bin/tui-ink/components/ChatLine.mjs
//
// Single transcript line. Three flavours:
//   - 'user'      → cyan arrow prefix
//   - 'assistant' → dim "↪" prefix + (optional) markdown rendering
//   - 'system'    → grey "·" prefix
//
// For markdown we lean on the existing CJS renderer in bin/lib/markdown.js
// which returns ANSI-styled text. Ink's <Text> passes ANSI through to the
// terminal verbatim.

import React from 'react';
import { Box, Text } from 'ink';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { renderMarkdown } = require('../../lib/markdown.js');

export default function ChatLine({ type, text }) {
  if (type === 'user') {
    return React.createElement(
      Box,
      null,
      React.createElement(Text, { color: 'cyan', bold: true }, '› '),
      React.createElement(Text, null, text),
    );
  }
  if (type === 'assistant') {
    let rendered;
    try {
      rendered = renderMarkdown(text);
    } catch (_) {
      rendered = text;
    }
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, { dimColor: true }, '↪ assistant'),
      React.createElement(Text, null, rendered),
    );
  }
  // system / fallback
  return React.createElement(
    Box,
    null,
    React.createElement(Text, { color: 'gray' }, '· '),
    React.createElement(Text, { dimColor: true }, text),
  );
}
