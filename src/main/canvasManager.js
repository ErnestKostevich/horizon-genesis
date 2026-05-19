// Live Canvas — Phase 26 MVP.
//
// A shared editable surface between the user and the agent. Either side
// can read or write; every change is appended to an edit log so the
// other side can reason about what just happened.
//
// Inspired by OpenClaw's "Live Canvas". Our minimum viable shape:
//   - One document per user-data dir, stored at `<userData>/horizon-canvas.json`
//   - Content is plain text (markdown-ish). Future versions can layer
//     structured blocks (Mermaid diagram, todo list, kanban) on top of
//     the same text store.
//   - Three write modes:
//       append   — text added to the end with a single \n separator
//       prepend  — text added to the top
//       replace  — content entirely overwritten
//   - Version counter incremented on every write; renderer + agent
//     can use it to detect "out-of-band" changes (e.g. user typed
//     while agent was computing).
//   - Edit log capped at the last 200 entries. Each entry stores
//     source (`user`|`agent`), at (ISO timestamp), mode, byteLen.
//
// IPC wiring lives in main.js; agent tools (canvas_read /
// canvas_write) live in agent.js. Keeping this module dependency-free
// of those so unit tests can exercise it in isolation.

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_CONTENT_BYTES = 1024 * 1024;     // 1 MB cap — prevents accidental flood
const MAX_EDIT_LOG       = 200;
const FILENAME = 'horizon-canvas.json';

class CanvasManager {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, FILENAME);
    this._state = null;
    this._listeners = new Set();
    this._loadSync();
  }

  _loadSync() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const j = JSON.parse(raw);
        this._state = {
          content: typeof j.content === 'string' ? j.content : '',
          version: Number.isFinite(j.version) ? j.version : 0,
          updatedAt: j.updatedAt || null,
          editLog: Array.isArray(j.editLog) ? j.editLog.slice(-MAX_EDIT_LOG) : [],
        };
        return;
      }
    } catch (_) { /* fall through to default */ }
    this._state = { content: '', version: 0, updatedAt: null, editLog: [] };
  }

  _saveSync() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // Disk write failure isn't fatal — state still lives in memory and
      // listeners still fire. Surface to the console so the user sees it.
      console.warn('[canvas] save failed:', e.message);
    }
  }

  /** Snapshot suitable for rendering or sending over IPC. */
  get() {
    return {
      content: this._state.content,
      version: this._state.version,
      updatedAt: this._state.updatedAt,
      editLogTail: this._state.editLog.slice(-25),
    };
  }

  /**
   * Apply a write. Source is `user` | `agent`.
   * Returns the new snapshot.
   */
  write({ mode = 'append', content = '', source = 'user' } = {}) {
    if (typeof content !== 'string') content = String(content || '');
    if (!['append', 'prepend', 'replace'].includes(mode)) mode = 'append';

    let next;
    if (mode === 'replace') {
      next = content;
    } else if (mode === 'prepend') {
      next = content + (this._state.content ? '\n' + this._state.content : '');
    } else {
      next = (this._state.content ? this._state.content + '\n' : '') + content;
    }

    // Hard cap to keep the file light. Truncate from the head — newest
    // content stays visible.
    const bytes = Buffer.byteLength(next, 'utf8');
    if (bytes > MAX_CONTENT_BYTES) {
      const overshoot = bytes - MAX_CONTENT_BYTES;
      // Approximate — drop UTF-16 chars equal to overshoot bytes; works
      // for mostly-ASCII content.
      next = next.slice(Math.min(next.length, overshoot + 200));
      next = '… [head truncated to keep canvas under 1 MB]\n' + next;
    }

    const now = new Date().toISOString();
    this._state = {
      content: next,
      version: (this._state.version || 0) + 1,
      updatedAt: now,
      editLog: [
        ...this._state.editLog.slice(-(MAX_EDIT_LOG - 1)),
        { at: now, source, mode, bytesIn: Buffer.byteLength(content, 'utf8'), bytesOut: Buffer.byteLength(next, 'utf8') },
      ],
    };

    this._saveSync();
    this._emit();
    return this.get();
  }

  /** Replace content entirely — used by the renderer's auto-save. */
  setContent(content, source = 'user') {
    return this.write({ mode: 'replace', content, source });
  }

  clear(source = 'user') {
    return this.write({ mode: 'replace', content: '', source });
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    const snap = this.get();
    for (const fn of this._listeners) {
      try { fn(snap); } catch (_) {}
    }
  }
}

module.exports = { CanvasManager };
