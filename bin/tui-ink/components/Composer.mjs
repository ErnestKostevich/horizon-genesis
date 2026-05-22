// bin/tui-ink/components/Composer.mjs
//
// Sprint-2.13 — custom multi-line composer. ink-text-input is
// single-line only, so we replaced it with a hand-rolled input that
// uses Ink's useInput hook. Supports:
//   • Shift+Enter / Alt+Enter inserts a newline
//   • Enter submits the buffered value
//   • Backspace deletes across lines (joins to previous line)
//   • Arrow keys move the cursor — Left/Right within a line, Up/Down
//     between lines (when multiple lines exist)
//   • Home/End to line start/end
//   • Ctrl+U clears the current line
//   • Ctrl+W deletes word backward
//   • Cursor renders as inverted block at the insertion point
//
// State model: { lines: string[], row: number, col: number }
// We render each line on its own Ink row inside the bordered Box.

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

export default function Composer({ value, onChange, onSubmit, busy, disabled }) {
  // Track lines + cursor locally; reflect to parent via onChange so
  // App.mjs can clear the composer after submit (`onChange('')`).
  const [lines, setLines] = useState(() => splitLines(value || ''));
  const [cursor, setCursor] = useState(() => ({ row: 0, col: (value || '').length }));

  // Sync local state when parent forcibly changes the value (e.g.
  // /clear or after submit). Only resync when the string fully diverges
  // — keystroke-by-keystroke updates flow PARENT-ward via onChange.
  useEffect(() => {
    const flat = lines.join('\n');
    if (flat !== value) {
      const newLines = splitLines(value || '');
      setLines(newLines);
      const lastRow = newLines.length - 1;
      setCursor({ row: lastRow, col: newLines[lastRow].length });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const _emit = useCallback((newLines, newCursor) => {
    setLines(newLines);
    setCursor(newCursor);
    const flat = newLines.join('\n');
    onChange && onChange(flat);
  }, [onChange]);

  useInput((inputCh, key) => {
    if (disabled || busy) return;
    if (key.return) {
      // Sprint-2.13 — Shift+Enter or Alt+Enter inserts newline; plain
      // Enter submits the full buffer. `key.shift` is what Ink exposes
      // for the shift modifier on most terminals; on terminals that
      // don't surface shift (Windows Terminal default), Alt+Enter is
      // an equivalent escape hatch.
      if (key.shift || key.meta) {
        const line = lines[cursor.row];
        const before = line.slice(0, cursor.col);
        const after = line.slice(cursor.col);
        const newLines = [
          ...lines.slice(0, cursor.row),
          before,
          after,
          ...lines.slice(cursor.row + 1),
        ];
        _emit(newLines, { row: cursor.row + 1, col: 0 });
        return;
      }
      // Submit — collapse to single string, send to parent, reset.
      const flat = lines.join('\n').trim();
      if (!flat) return;
      onSubmit && onSubmit(flat);
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor.col > 0) {
        const line = lines[cursor.row];
        const newLine = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
        const newLines = [...lines];
        newLines[cursor.row] = newLine;
        _emit(newLines, { row: cursor.row, col: cursor.col - 1 });
      } else if (cursor.row > 0) {
        // Join to previous line.
        const prev = lines[cursor.row - 1];
        const curr = lines[cursor.row];
        const newLines = [...lines];
        newLines[cursor.row - 1] = prev + curr;
        newLines.splice(cursor.row, 1);
        _emit(newLines, { row: cursor.row - 1, col: prev.length });
      }
      return;
    }
    if (key.leftArrow) {
      if (cursor.col > 0) {
        setCursor({ row: cursor.row, col: cursor.col - 1 });
      } else if (cursor.row > 0) {
        setCursor({ row: cursor.row - 1, col: lines[cursor.row - 1].length });
      }
      return;
    }
    if (key.rightArrow) {
      const line = lines[cursor.row];
      if (cursor.col < line.length) {
        setCursor({ row: cursor.row, col: cursor.col + 1 });
      } else if (cursor.row < lines.length - 1) {
        setCursor({ row: cursor.row + 1, col: 0 });
      }
      return;
    }
    if (key.upArrow && cursor.row > 0) {
      const newRow = cursor.row - 1;
      setCursor({ row: newRow, col: Math.min(cursor.col, lines[newRow].length) });
      return;
    }
    if (key.downArrow && cursor.row < lines.length - 1) {
      const newRow = cursor.row + 1;
      setCursor({ row: newRow, col: Math.min(cursor.col, lines[newRow].length) });
      return;
    }
    if (key.ctrl && (inputCh === 'a' || inputCh === 'A')) {
      setCursor({ row: cursor.row, col: 0 });
      return;
    }
    if (key.ctrl && (inputCh === 'e' || inputCh === 'E')) {
      setCursor({ row: cursor.row, col: lines[cursor.row].length });
      return;
    }
    if (key.ctrl && (inputCh === 'u' || inputCh === 'U')) {
      // Clear current line.
      const newLines = [...lines];
      newLines[cursor.row] = '';
      _emit(newLines, { row: cursor.row, col: 0 });
      return;
    }
    if (key.ctrl && (inputCh === 'w' || inputCh === 'W')) {
      // Delete previous word.
      const line = lines[cursor.row];
      const before = line.slice(0, cursor.col);
      const m = before.match(/(\s*\S+\s*)$/);
      const cut = m ? m[0].length : 1;
      const newLine = before.slice(0, before.length - cut) + line.slice(cursor.col);
      const newLines = [...lines];
      newLines[cursor.row] = newLine;
      _emit(newLines, { row: cursor.row, col: cursor.col - cut });
      return;
    }
    // Regular printable character.
    if (inputCh && !key.ctrl && !key.meta) {
      // Some terminals report multi-char inputs (paste) — handle all.
      const printable = inputCh.replace(/[\r]/g, '');  // strip stray CR
      if (!printable) return;
      const line = lines[cursor.row];
      const newLine = line.slice(0, cursor.col) + printable + line.slice(cursor.col);
      const newLines = [...lines];
      newLines[cursor.row] = newLine;
      _emit(newLines, { row: cursor.row, col: cursor.col + printable.length });
    }
  });

  // Render — placeholder when empty, else lines with cursor.
  const isEmpty = lines.length === 1 && lines[0].length === 0;
  const placeholder = busy
    ? 'working — press Esc to interrupt'
    : 'Message Horizon, or type / for commands  ·  Shift+Enter for newline';
  const borderColor = busy ? 'gray' : (isEmpty ? 'gray' : 'cyan');

  return React.createElement(
    Box,
    { borderStyle: 'round', borderColor, paddingX: 1, flexDirection: 'column' },
    ...lines.map((line, i) =>
      React.createElement(
        Box,
        { key: i },
        i === 0
          ? React.createElement(Text, { color: 'cyan', bold: true }, '› ')
          : React.createElement(Text, { dimColor: true }, '  '),
        i === cursor.row
          ? _renderWithCursor(line, cursor.col, isEmpty && i === 0 ? placeholder : null)
          : React.createElement(Text, null, line || ' '),
      ),
    ),
  );
}

// Render a line with the cursor block at `col`. Falls back to a dim
// placeholder when the input is empty.
function _renderWithCursor(line, col, placeholder) {
  if (!line && placeholder) {
    return React.createElement(
      Box,
      null,
      React.createElement(Text, { inverse: true }, ' '),
      React.createElement(Text, { dimColor: true }, placeholder),
    );
  }
  const before = line.slice(0, col);
  const at = line[col] || ' ';
  const after = line.slice(col + 1);
  return React.createElement(
    Box,
    null,
    React.createElement(Text, null, before),
    React.createElement(Text, { inverse: true }, at),
    React.createElement(Text, null, after),
  );
}

function splitLines(s) {
  const arr = String(s || '').split('\n');
  return arr.length === 0 ? [''] : arr;
}
