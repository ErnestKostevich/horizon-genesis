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
  // Sprint-2.11 — placeholder text matches the readline TUI exactly so a
  // user switching between --ink and the default doesn't see different
  // hints. Border colour follows focus state — cyan when typing, dim
  // grey when busy/interrupted (matches the composer top-rule colour in
  // the readline TUI which goes from dim → cyan on first character).
  const placeholder = busy
    ? 'working — press Esc to interrupt'
    : 'Message Horizon, or type / for commands';
  const borderColor = busy
    ? 'gray'
    : (value && value.length > 0 ? 'cyan' : 'gray');

  return React.createElement(
    Box,
    { borderStyle: 'round', borderColor, paddingX: 1 },
    React.createElement(Text, { color: 'cyan', bold: true }, '› '),
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
