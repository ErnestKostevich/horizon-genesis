// bin/tui-ink/components/PlanActGate.mjs
//
// Sprint-2.13 — Plan/Act approval gate. Renders above the composer
// when the agent's askPermission callback fires for a dangerous tool
// (run_code, write_file, mouse_click, etc). User presses Enter / Y to
// approve or Esc / N to reject; the gate's onResolve callback is wired
// to the Promise resolver inside App.mjs.
//
//   ╭─ 🛡 Approve plan? ──────────────────────────────────────────╮
//   │ First tool: run_code                                         │
//   │ Reason: execute python script to list files                 │
//   │                                                              │
//   │ [Enter / Y]  Approve     [Esc / N]  Reject                  │
//   ╰──────────────────────────────────────────────────────────────╯

import React from 'react';
import { Box, Text } from 'ink';

export default function PlanActGate({ tool, args, reason }) {
  let argsStr = '';
  if (args && typeof args === 'object' && Object.keys(args).length) {
    try {
      argsStr = JSON.stringify(args);
      if (argsStr.length > 80) argsStr = argsStr.slice(0, 77) + '…';
    } catch (_) {}
  }

  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'yellow',
      paddingX: 1,
      marginY: 0,
    },
    React.createElement(
      Box,
      null,
      React.createElement(Text, { color: 'yellow', bold: true }, '🛡  Approve plan?'),
      React.createElement(Text, { dimColor: true }, '   waiting for confirmation'),
    ),
    React.createElement(
      Box,
      { marginTop: 0 },
      React.createElement(Text, { dimColor: true }, 'First tool: '),
      React.createElement(Text, { color: 'cyan', bold: true }, tool || 'unknown'),
    ),
    argsStr
      ? React.createElement(
          Box,
          null,
          React.createElement(Text, { dimColor: true }, 'Args:       '),
          React.createElement(Text, null, argsStr),
        )
      : null,
    reason
      ? React.createElement(
          Box,
          null,
          React.createElement(Text, { dimColor: true }, 'Reason:     '),
          React.createElement(Text, null, String(reason).slice(0, 100)),
        )
      : null,
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(Text, { color: 'green', bold: true }, '  [Enter / Y]  '),
      React.createElement(Text, null, 'Approve'),
      React.createElement(Text, { dimColor: true }, '       '),
      React.createElement(Text, { color: 'red', bold: true }, '[Esc / N]  '),
      React.createElement(Text, null, 'Reject'),
    ),
  );
}
