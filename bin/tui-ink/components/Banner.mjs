// bin/tui-ink/components/Banner.mjs
//
// Banner component — wraps the existing `bannerFramedBox` ASCII art and
// renders four collapsible sections (Tools / Skills / System prompt /
// MCP) using Ink's <Box borderStyle="round"> primitives.
//
// The prototype intentionally REUSES the rendered string from
// bin/lib/banner.js when possible. Ink's <Text> happily forwards ANSI
// escape sequences to the terminal, so the wordmark + accent colours
// stay identical to the readline TUI.
//
// Collapsible state lives locally — pressing Tab cycles the highlighted
// section, Enter (when composer is empty) toggles it. Wiring of those
// keys lives in App.mjs and is stubbed for the skeleton.

import React from 'react';
import { Box, Text } from 'ink';

// Hop one directory up to require() the CJS banner module. Dynamic
// import would work too but createRequire is simpler in mjs land.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const banner = require('../../lib/banner.js');
const path = require('node:path');

export default function Banner({ runtime, provider, model, persona }) {
  const skillCount = countSafe(() => runtime?.skillsManager?.list?.());
  const memCount = countSafe(() => runtime?.agentMemory?._data?.memories);
  const mcpCount = countSafe(() => runtime?.mcpRegistry?.list?.());

  // Sprint-2.11 — use the BIG multi-row wordmark (6 rows of block
  // letters with per-row gradient) for premium first-paint. Falls back
  // gracefully to the small framed box if the terminal is too narrow.
  const cols = process.stdout.columns || 80;
  const framed = cols >= 70
    ? banner.bannerBig()
    : banner.bannerFramedBox();
  const greeting = banner.buildGreetingBase(new Date());
  const personaSuffix = personaGreetingSuffix(persona);

  // Sections are dim summary lines; the production port would lift state
  // up so the user can expand/collapse with Tab or mouse.
  const sections = [
    { id: 'tools', label: 'Tools', summary: `built-in · ${skillCount} skills loaded` },
    { id: 'skills', label: 'Skills', summary: `${skillCount} enabled · /skills to manage` },
    { id: 'prompt', label: 'System prompt', summary: `${persona} · workspace ${path.basename(runtime?.workspaceDir || '')}` },
    { id: 'mcp', label: 'MCP servers', summary: mcpCount > 0 ? `${mcpCount} connected` : 'none configured' },
  ];

  return React.createElement(
    Box,
    { flexDirection: 'column', marginBottom: 1 },
    // Framed wordmark — ANSI passes through <Text>.
    React.createElement(Text, null, framed),
    // Spacer.
    React.createElement(Text, null, ''),
    // Sections — flat list with chevrons. Skeleton shows them collapsed.
    ...sections.map((s) =>
      React.createElement(
        Box,
        { key: s.id, paddingLeft: 2 },
        React.createElement(Text, { color: 'cyan' }, '▸ '),
        React.createElement(Text, { bold: true }, s.label.padEnd(14)),
        React.createElement(Text, { dimColor: true }, s.summary),
      ),
    ),
    // Greeting line.
    React.createElement(
      Box,
      { paddingLeft: 2, marginTop: 1 },
      React.createElement(Text, { dimColor: true }, greeting + personaSuffix),
    ),
    // Hint footer.
    React.createElement(
      Box,
      { paddingLeft: 2 },
      React.createElement(Text, { dimColor: true }, '⏎ send  ·  ⇧⏎ newline  ·  /help  ·  Esc interrupt'),
    ),
  );
}

function personaGreetingSuffix(persona) {
  const id = String(persona || '').toLowerCase();
  switch (id) {
    case 'jarvis': return ', sir.';
    case 'alfred': return ', master.';
    case 'friday': return '!';
    case 'sage':   return '. Ready to think.';
    case 'pixel':  return '! ✨';
    default:       return '.';
  }
}

function countSafe(fn) {
  try {
    const v = fn();
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'number') return v;
    return 0;
  } catch (_) {
    return 0;
  }
}
