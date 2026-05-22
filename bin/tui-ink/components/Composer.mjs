// bin/tui-ink/components/Composer.mjs
//
// Composer — bordered single-line input box with a prompt arrow and a
// dim placeholder. Ink's `ink-text-input` package handles cursor + edit
// keys (Ctrl+A/E/U, arrow keys) out of the box.
//
// Multi-line (Shift+Enter) support requires a custom input component —
// stubbed here with a single-line input for the prototype. The real
// port would compose ink-text-input under a wrapper that intercepts
// shift-modifier keys.

import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

export default function Composer({ value, onChange, onSubmit, busy }) {
  // Show a dim placeholder when the input is empty.
  const placeholder = busy
    ? 'working — press Esc to interrupt'
    : 'Ask Horizon, or type / for commands';

  return React.createElement(
    Box,
    { borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    React.createElement(Text, { color: 'cyan' }, '› '),
    // ink-text-input renders inline; we wrap it so we can put the prompt
    // arrow + cursor inside the same border.
    React.createElement(TextInput, {
      value,
      onChange,
      onSubmit,
      placeholder,
      // showCursor true (default) — Ink-text-input handles blinking.
      focus: !busy,
    }),
  );
}
