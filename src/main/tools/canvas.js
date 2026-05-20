'use strict';
/**
 * Live Canvas tools (PHASE 26) — read / write the shared surface that
 * lives in main.js's CanvasManager.
 *
 * canvas_write is the only mutating tool; it keeps the same default mode
 * ('append') and the same rejection of empty content as the original
 * switch case.
 */

const { register } = require('./registry');

function _canvasMgr() {
  try {
    const mainMod = require.cache[require.resolve('../main')];
    return mainMod?.exports?.getCanvasManager?.() || null;
  } catch (_) { return null; }
}

register({
  name: 'canvas_read',
  description: 'Read the current Live Canvas content. Returns { ok, content, version, updatedAt }. Use this before writing so you can patch around existing content rather than overwriting.',
  parameters: {},
  async execute() {
    try {
      const mgr = _canvasMgr();
      if (!mgr) return { ok: false, err: 'canvas not initialised' };
      const snap = mgr.get();
      return { ok: true, content: snap.content, version: snap.version, updatedAt: snap.updatedAt };
    } catch (e) {
      return { ok: false, err: 'canvas_read failed: ' + e.message };
    }
  },
});

register({
  name: 'canvas_write',
  description: 'Write to the Live Canvas (shared surface with the user). Modes: append (default, adds to end), prepend (top), replace (overwrite). The user sees your write live and can edit on top. Don\'t use replace unless the user asked to start over.',
  parameters: {
    content: 'string — what to write',
    mode: 'string optional — append | prepend | replace (default append)',
  },
  async execute(args = {}) {
    try {
      const mgr = _canvasMgr();
      if (!mgr) return { ok: false, err: 'canvas not initialised' };
      const content = String(args.content || '');
      if (!content) return { ok: false, err: 'canvas_write needs non-empty content' };
      const mode = ['append', 'prepend', 'replace'].includes(args.mode) ? args.mode : 'append';
      const snap = mgr.write({ mode, content, source: 'agent' });
      return { ok: true, mode, version: snap.version, bytesWritten: content.length };
    } catch (e) {
      return { ok: false, err: 'canvas_write failed: ' + e.message };
    }
  },
});
