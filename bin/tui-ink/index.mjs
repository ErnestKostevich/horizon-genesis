// bin/tui-ink/index.mjs
//
// Entry point for the Ink-based TUI prototype. Ink 7 is ESM-only and React
// 19 is CJS — to keep the rest of horizon-genesis as CommonJS we expose a
// `start()` function loaded via dynamic import() from the CJS launcher in
// bin/horizon.js.
//
// The skeleton is deliberately minimal:
//   - <App /> renders <Banner /> + scrollback (Static) + <StatusBar /> +
//     <Composer />
//   - Slash commands are stubbed (/help /quit /clear /reset). The full
//     surface still lives in bin/horizon-tui.js — this prototype only
//     proves Ink can replicate the visual shell.
//   - Streaming + tool cards have placeholder hooks (useStream) so the
//     architecture for a real port is visible.
//
// We deliberately avoid JSX so no Babel/esbuild step is required — every
// component uses React.createElement directly. That makes the prototype
// runnable from source with zero build pipeline.

import React from 'react';
import { render, Box, Text, Static, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';

import App from './App.mjs';

// Bridge: the CJS launcher passes the headless runtime in through a
// shared option bag. We mount <App /> with the runtime as a prop.
export async function start({ runtime, flags = {} } = {}) {
  if (!runtime) {
    throw new Error('tui-ink: runtime is required (createHorizonRuntime)');
  }

  // Render and resolve when the user quits. Ink's `waitUntilExit()` is
  // the canonical way to keep the host process alive until the React
  // tree unmounts via useApp().exit().
  const { waitUntilExit } = render(
    React.createElement(App, { runtime, flags }),
    {
      // Patch console so log statements during the prototype don't
      // shatter the layout (Ink redraws the whole frame on each tick).
      patchConsole: true,
      // exitOnCtrlC=true is the Ink default — we still wire our own
      // useInput handler for graceful slash-command parity.
      exitOnCtrlC: true,
    },
  );

  await waitUntilExit();
}

// Re-export primitives so the per-component files can stay close to the
// React.createElement style without each importing ink separately. Keeping
// imports centralised also lets a future build pipeline swap Ink versions
// without touching every component.
export { React, Box, Text, Static, useApp, useInput, TextInput, Spinner };
