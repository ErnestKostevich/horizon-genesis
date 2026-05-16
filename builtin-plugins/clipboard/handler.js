'use strict';
/**
 * Clipboard — built-in Horizon plugin.
 * Thin wrapper over Electron's `clipboard` module. Synchronous calls
 * are safe here because they touch only the OS clipboard (no I/O wait).
 */
const { clipboard } = require('electron');

// Phase 2 fix — cap clipboard output so a chat message holding a giant
// pasted blob (megabytes of CSV / a stack trace dump / a base64 image)
// doesn't blow the agent's context window. 64 KB is enough for any
// human-readable workflow and prevents the agent from being silently
// truncated by the provider mid-prompt.
const MAX_READ_BYTES = 64 * 1024;

module.exports = {
  async execute(tool, args = {}) {
    if (tool === 'read') {
      const full = clipboard.readText() || '';
      const bytes = Buffer.byteLength(full, 'utf8');
      const truncated = bytes > MAX_READ_BYTES;
      // Truncate by bytes, not chars, to avoid splitting a multi-byte
      // UTF-8 sequence at the boundary (which would corrupt the output).
      const text = truncated
        ? Buffer.from(full, 'utf8').slice(0, MAX_READ_BYTES).toString('utf8')
        : full;
      return {
        ok: true,
        out: truncated
          ? text + `\n\n[truncated — clipboard had ${bytes} bytes, returned first ${MAX_READ_BYTES}]`
          : text,
        length: text.length,
        truncated,
        original_bytes: bytes,
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
