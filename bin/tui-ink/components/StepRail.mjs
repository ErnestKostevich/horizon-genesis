// bin/tui-ink/components/StepRail.mjs
//
// Sprint-2.12 — agent-mode step rail. Renders the plan as a horizontal
// row of chips above the transcript while the agent is running.
//
//   ╭─ Plan ──────────────────────────────────────────────────────╮
//   │ ✓ 1 read file  ✓ 2 analyze  ▶ 3 fix bug   · 4 test           │
//   ╰─────────────────────────────────────────────────────────────╯
//
//   Status glyphs:
//     ✓  done    (green)
//     ▶  current (cyan, pulsing via Spinner)
//     ·  pending (dim grey)
//     ✗  failed  (red)
//
// Props:
//   steps        — array of strings OR objects { title, status? }
//   currentIdx   — number — index of the step that's currently running
//   failedSet    — Set<number> — indices that errored

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

// Defensively normalise plan steps — some models return objects rather
// than strings. Matches the readline TUI's _normalizePlanStep behaviour.
function _normalizeStep(s) {
  if (s == null) return '';
  if (typeof s === 'string') return s;
  if (typeof s === 'object') {
    return String(s.title || s.step || s.name || s.text || s.content || '').trim();
  }
  return String(s);
}

export default function StepRail({ steps = [], currentIdx = -1, failedSet, pendingBreathe = 0 }) {
  if (!steps.length) return null;
  const failed = failedSet || new Set();
  const norm = steps.map(_normalizeStep).filter(Boolean).slice(0, 7);

  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'cyan',
      paddingX: 1,
      marginY: 0,
    },
    React.createElement(
      Box,
      null,
      React.createElement(Text, { color: 'cyan', bold: true }, '◈ Plan'),
      React.createElement(Text, { dimColor: true }, '   ' + norm.length + ' step' + (norm.length === 1 ? '' : 's')),
    ),
    React.createElement(
      Box,
      { flexDirection: 'row', flexWrap: 'wrap' },
      ...norm.flatMap((step, i) => {
        const elements = [];
        if (i > 0) elements.push(React.createElement(Text, { key: `arr-${i}`, dimColor: true }, '  →  '));
        elements.push(_renderChip(step, i, currentIdx, failed, pendingBreathe));
        return elements;
      }),
    ),
  );
}

// Sprint-2.15 — pending steps rotate through a 4-frame glyph cycle on
// the parent's breathe tick. Cycle: · ◦ ∘ ◦ — a subtle "exhale" that
// keeps the upcoming rail visually alive without competing with the
// current step's spinner or the done chips' static brightness.
const _PENDING_GLYPHS = ['·', '◦', '∘', '◦'];

function _renderChip(step, i, currentIdx, failedSet, pendingBreathe) {
  const num = i + 1;
  const isDone = i < currentIdx;
  const isCurr = i === currentIdx;
  const isFail = failedSet.has(i);

  let glyph;
  let color;
  if (isFail) { glyph = '✗'; color = 'red'; }
  else if (isDone) { glyph = '✓'; color = 'green'; }
  else if (isCurr) { glyph = '▶'; color = 'cyan'; }
  else {
    // Pending — soft breathing glyph (per-step phase offset so the
    // rail doesn't pulse in unison, which would look mechanical).
    glyph = _PENDING_GLYPHS[(pendingBreathe + i) % _PENDING_GLYPHS.length];
    color = 'gray';
  }

  const text = step.length > 22 ? step.slice(0, 21) + '…' : step;

  // Current step gets a Spinner instead of a static glyph for a subtle
  // running animation. Done/pending/failed stay static glyphs (pending
  // glyph rotates on the parent breathe tick).
  return React.createElement(
    Box,
    { key: `chip-${i}` },
    isCurr
      ? React.createElement(Spinner, { type: 'dots' })
      : React.createElement(Text, { color }, glyph),
    React.createElement(Text, { color, bold: isCurr || isDone }, ' ' + num + ' '),
    React.createElement(Text, { color: isCurr ? 'white' : (isDone ? undefined : 'gray'), dimColor: !isCurr && !isDone }, text),
  );
}
