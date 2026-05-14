'use strict';
/**
 * Clipboard — built-in Horizon plugin.
 * Thin wrapper over Electron's `clipboard` module. Synchronous calls
 * are safe here because they touch only the OS clipboard (no I/O wait).
 */
const { clipboard } = require('electron');

module.exports = {
  async execute(tool, args = {}) {
    if (tool === 'read') {
      const text = clipboard.readText() || '';
      return {
        ok: true,
        out: text,
        length: text.length,
      };
    }
    if (tool === 'write') {
      const text = String(args.text ?? '');
      clipboard.writeText(text);
      return {
        ok: true,
        out: `Wrote ${text.length} chars to clipboard`,
        length: text.length,
      };
    }
    if (tool === 'clear') {
      clipboard.clear();
      return { ok: true, out: 'Clipboard cleared' };
    }
    return { ok: false, error: `Unknown tool: ${tool}` };
  },
};
