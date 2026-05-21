'use strict';
/**
 * Horizon AI — Macro Recorder + Playback (Sprint 7D)
 *
 * Records user-driven mouse/keyboard activity and replays it via the same
 * native helpers the agent uses. The macro file format is a small JSON
 * blob that's portable across machines (modulo screen resolution).
 *
 * File layout:
 *   <userData>/macros/<safe-name>.json
 *
 * Format:
 *   {
 *     "name": "click-save-button",
 *     "version": "1.0",
 *     "createdAt": 1700000000000,
 *     "duration": 4500,
 *     "events": [
 *       { "t": 0,    "type": "mouse_move",  "x": 100, "y": 200 },
 *       { "t": 250,  "type": "mouse_click", "x": 100, "y": 200, "button": "left" },
 *       { "t": 800,  "type": "key",         "key": "Tab" },
 *       { "t": 1100, "type": "type",        "text": "Hello world" },
 *       { "t": 4500, "type": "end" }
 *     ]
 *   }
 *
 * Recording strategy:
 *   - Best-effort. If a global-hook native module is available we use it,
 *     otherwise we fall back to polling cursor position at 50 ms intervals
 *     (mouse-only, no keyboard capture). The polling fallback is recorded
 *     as a sequence of mouse_move events with no click detection — useful
 *     for "demo this cursor trail" workflows but not click recording.
 *   - macOS: marked "playback only, recording is experimental" — we still
 *     try the polling path so it doesn't completely fail.
 *
 * Playback strategy:
 *   - Walks events, sleeps until `event.t * (1/speed)` relative to start,
 *     fires the native action. opts.dryRun=true skips the fire (used by
 *     unit tests and the UI preview).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SCHEMA_VERSION = '1.0';
const ALLOWED_EVENT_TYPES = new Set([
  'mouse_move', 'mouse_click', 'mouse_double_click', 'scroll',
  'key', 'type', 'wait', 'end',
]);

// ─── Path helpers ────────────────────────────────────────────────────────────

function macrosDir(userDataDir) {
  const dir = path.join(userDataDir, 'macros');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function _safeName(name) {
  const s = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) throw new Error('Macro name must contain at least one alphanumeric character');
  if (s.length > 80) throw new Error('Macro name too long (max 80 chars)');
  return s;
}

function macroFile(userDataDir, name) {
  return path.join(macrosDir(userDataDir), _safeName(name) + '.json');
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a macro object. Returns { ok, error } so callers (the tool
 * layer, the CLI, unit tests) all share one source of truth.
 */
function validateMacro(macro) {
  if (!macro || typeof macro !== 'object') return { ok: false, error: 'Macro must be an object' };
  if (typeof macro.name !== 'string' || !macro.name.trim()) return { ok: false, error: 'Macro.name required' };
  if (macro.version && macro.version !== SCHEMA_VERSION) {
    return { ok: false, error: `Unsupported macro schema version: ${macro.version} (expected ${SCHEMA_VERSION})` };
  }
  if (!Array.isArray(macro.events)) return { ok: false, error: 'Macro.events must be an array' };
  if (macro.events.length === 0) return { ok: false, error: 'Macro has no events' };

  for (let i = 0; i < macro.events.length; i++) {
    const e = macro.events[i];
    if (!e || typeof e !== 'object') return { ok: false, error: `event[${i}] must be an object` };
    if (typeof e.t !== 'number' || e.t < 0) return { ok: false, error: `event[${i}].t must be a non-negative number` };
    if (!ALLOWED_EVENT_TYPES.has(e.type)) return { ok: false, error: `event[${i}].type "${e.type}" not allowed` };
    if (e.type === 'mouse_move' || e.type === 'mouse_click' || e.type === 'mouse_double_click') {
      if (typeof e.x !== 'number' || typeof e.y !== 'number') return { ok: false, error: `event[${i}] needs numeric x,y` };
    }
    if (e.type === 'type' && typeof e.text !== 'string') return { ok: false, error: `event[${i}].text must be a string` };
    if (e.type === 'key' && typeof e.key !== 'string') return { ok: false, error: `event[${i}].key must be a string` };
  }
  // Events should be time-ordered. We DON'T reject out-of-order arrays —
  // playback sorts before walking — but flag it so the caller can warn.
  let sortedOk = true;
  for (let i = 1; i < macro.events.length; i++) {
    if (macro.events[i].t < macro.events[i - 1].t) { sortedOk = false; break; }
  }
  return { ok: true, sortedOk };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function saveMacro(userDataDir, macro) {
  const v = validateMacro(macro);
  if (!v.ok) return { ok: false, error: v.error };
  const file = macroFile(userDataDir, macro.name);
  // Ensure sorted by t so playback walks in order.
  const events = macro.events.slice().sort((a, b) => a.t - b.t);
  const duration = macro.duration || events[events.length - 1]?.t || 0;
  const payload = {
    name: macro.name,
    version: SCHEMA_VERSION,
    createdAt: macro.createdAt || Date.now(),
    updatedAt: Date.now(),
    duration,
    events,
    meta: macro.meta || {},
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return { ok: true, path: file, macro: payload };
}

function loadMacro(userDataDir, name) {
  const file = macroFile(userDataDir, name);
  if (!fs.existsSync(file)) return { ok: false, error: `Macro not found: ${name}` };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const macro = JSON.parse(raw);
    const v = validateMacro(macro);
    if (!v.ok) return { ok: false, error: `Corrupt macro: ${v.error}` };
    return { ok: true, macro, path: file };
  } catch (e) {
    return { ok: false, error: `Failed to load macro: ${e.message}` };
  }
}

function listMacros(userDataDir) {
  const dir = macrosDir(userDataDir);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (_) {}
  const out = [];
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({
        name: m.name,
        duration: m.duration || 0,
        events: Array.isArray(m.events) ? m.events.length : 0,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        lastPlayedAt: m.lastPlayedAt,
        path: path.join(dir, f),
      });
    } catch (_) { /* skip corrupt */ }
  }
  return out.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

function deleteMacro(userDataDir, name) {
  const file = macroFile(userDataDir, name);
  if (!fs.existsSync(file)) return { ok: false, error: `Macro not found: ${name}` };
  try {
    fs.unlinkSync(file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Recorder ────────────────────────────────────────────────────────────────

class MacroRecorder {
  /**
   * @param {object} opts
   * @param {string} opts.userDataDir
   * @param {object} [opts.agentTools] — { mouseMove, mouseClick, typeText, pressKey, scroll }
   *   used during playback. Required for play(); not needed to record.
   * @param {function} [opts.getMousePos] — async () => { x, y } | null. If
   *   provided AND no native hook is available, we use it for poll-based
   *   recording.
   * @param {object} [opts.nativeHook] — module exposing on('mousemove'),
   *   on('click'), on('keydown'), start(), stop(). If absent we fall back
   *   to polling. The "uiohook-napi" npm package matches this shape — we
   *   try to require it lazily.
   */
  constructor(opts = {}) {
    this.userDataDir = opts.userDataDir;
    this.agentTools = opts.agentTools || null;
    this.getMousePos = opts.getMousePos || null;
    this._userNativeHook = opts.nativeHook || null;
    this.recording = false;
    this.events = [];
    this.startedAt = 0;
    this.currentName = null;
    this._pollTimer = null;
    this._lastMousePos = null;
    this._hook = null; // resolved at start()
    this._hookMode = null; // 'native' | 'poll' | 'none'
  }

  _resolveHook() {
    if (this._userNativeHook) return { mode: 'native', hook: this._userNativeHook };
    // Try the optional native global-hook module.
    try {
      const u = require('uiohook-napi');
      return { mode: 'native', hook: u.uIOhook || u };
    } catch (_) {}
    if (this.getMousePos) return { mode: 'poll', hook: null };
    return { mode: 'none', hook: null };
  }

  isRecording() { return this.recording; }
  currentMacroName() { return this.currentName; }

  start(name) {
    if (this.recording) return { ok: false, error: 'Already recording' };
    if (!name) return { ok: false, error: 'Macro name required' };
    try { _safeName(name); } catch (e) { return { ok: false, error: e.message }; }

    const resolved = this._resolveHook();
    this._hookMode = resolved.mode;
    this._hook = resolved.hook;

    this.recording = true;
    this.events = [];
    this.startedAt = Date.now();
    this.currentName = name;
    this._lastMousePos = null;

    if (this._hookMode === 'native' && this._hook) {
      try {
        // uiohook-napi event names
        this._onMove = (e) => this._capture({ type: 'mouse_move', x: e.x|0, y: e.y|0 });
        this._onClick = (e) => this._capture({
          type: 'mouse_click',
          x: e.x|0, y: e.y|0,
          button: e.button === 2 ? 'right' : 'left',
        });
        this._onKeyDown = (e) => {
          // uiohook emits raw rawcode/keychar; map common ones
          const key = e.keychar && e.keychar !== 0 ? String.fromCharCode(e.keychar) : `key-${e.keycode || e.rawcode || 0}`;
          this._capture({ type: 'key', key });
        };
        this._hook.on('mousemove', this._onMove);
        this._hook.on('click', this._onClick);
        this._hook.on('keydown', this._onKeyDown);
        if (typeof this._hook.start === 'function') this._hook.start();
      } catch (e) {
        // Native hook errored — degrade to polling.
        this._hookMode = this.getMousePos ? 'poll' : 'none';
      }
    }

    if (this._hookMode === 'poll') {
      this._pollTimer = setInterval(async () => {
        try {
          const pos = await this.getMousePos();
          if (!pos) return;
          if (!this._lastMousePos || pos.x !== this._lastMousePos.x || pos.y !== this._lastMousePos.y) {
            this._capture({ type: 'mouse_move', x: pos.x|0, y: pos.y|0 });
            this._lastMousePos = pos;
          }
        } catch (_) {}
      }, 50);
    }

    return {
      ok: true,
      mode: this._hookMode,
      warning: this._hookMode === 'none'
        ? 'No global hook available — recording disabled. Install uiohook-napi for full capture.'
        : this._hookMode === 'poll'
          ? 'Polling mode — captures mouse moves only, no clicks or keyboard. Install uiohook-napi for full capture.'
          : null,
    };
  }

  _capture(ev) {
    if (!this.recording) return;
    const t = Date.now() - this.startedAt;
    // De-dup rapid identical mouse_move events at the same coords
    const last = this.events[this.events.length - 1];
    if (ev.type === 'mouse_move' && last && last.type === 'mouse_move' && last.x === ev.x && last.y === ev.y) return;
    this.events.push({ t, ...ev });
  }

  /**
   * Manually inject an event — used by IPC handlers when the renderer
   * captures the activity (e.g. via DOM listeners during the recorder
   * countdown). Returns the captured event for echo.
   */
  pushEvent(ev) {
    this._capture(ev);
    return this.events[this.events.length - 1] || null;
  }

  stop() {
    if (!this.recording) return { ok: false, error: 'Not recording' };
    this.recording = false;

    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._hookMode === 'native' && this._hook) {
      try {
        if (this._onMove) this._hook.off && this._hook.off('mousemove', this._onMove);
        if (this._onClick) this._hook.off && this._hook.off('click', this._onClick);
        if (this._onKeyDown) this._hook.off && this._hook.off('keydown', this._onKeyDown);
        if (typeof this._hook.stop === 'function') this._hook.stop();
      } catch (_) {}
    }

    const name = this.currentName;
    const duration = Date.now() - this.startedAt;
    const events = this.events.slice();
    // Always append a terminal "end" event so playback knows when to wrap.
    if (events.length === 0 || events[events.length - 1].type !== 'end') {
      events.push({ t: duration, type: 'end' });
    }

    const macro = {
      name,
      version: SCHEMA_VERSION,
      createdAt: this.startedAt,
      duration,
      events,
      meta: { recordedWith: this._hookMode || 'none' },
    };

    this.events = [];
    this.currentName = null;
    this.startedAt = 0;

    if (this.userDataDir) {
      return saveMacro(this.userDataDir, macro);
    }
    return { ok: true, macro };
  }

  /**
   * Play a macro back. `agentTools` is required — typically the object
   * returned by `require('./agent')`.
   *
   * opts:
   *   - speed:   number (1.0 = real time, 2.0 = 2× faster, 0.5 = half-speed)
   *   - repeat:  number (how many times to play, default 1)
   *   - dryRun:  boolean (just log, don't fire native actions)
   *   - onEvent: (event, index) => void  — UI progress hook
   */
  async play(macro, opts = {}) {
    const v = validateMacro(macro);
    if (!v.ok) return { ok: false, error: v.error };

    const tools = this.agentTools || opts.agentTools;
    const dryRun = !!opts.dryRun;
    if (!dryRun && !tools) return { ok: false, error: 'agentTools required for non-dry-run playback' };

    const speed = opts.speed > 0 ? opts.speed : 1.0;
    const repeat = Math.max(1, opts.repeat | 0 || 1);

    const fired = [];
    for (let r = 0; r < repeat; r++) {
      const t0 = Date.now();
      const sorted = macro.events.slice().sort((a, b) => a.t - b.t);
      for (let i = 0; i < sorted.length; i++) {
        const ev = sorted[i];
        const targetMs = (ev.t / speed);
        const elapsed = Date.now() - t0;
        const wait = targetMs - elapsed;
        if (wait > 0) await new Promise(res => setTimeout(res, wait));

        if (opts.onEvent) { try { opts.onEvent(ev, i, r); } catch (_) {} }

        if (dryRun || ev.type === 'end' || ev.type === 'wait') {
          fired.push({ t: ev.t, type: ev.type, dryRun });
          continue;
        }
        try {
          if (ev.type === 'mouse_move') {
            await tools.mouseMove(ev.x, ev.y);
          } else if (ev.type === 'mouse_click') {
            await tools.mouseClick(ev.x, ev.y, ev.button || 'left', false);
          } else if (ev.type === 'mouse_double_click') {
            await tools.mouseClick(ev.x, ev.y, ev.button || 'left', true);
          } else if (ev.type === 'scroll') {
            await tools.scroll(ev.direction || 'down', ev.amount || 3);
          } else if (ev.type === 'key') {
            await tools.pressKey(ev.key);
          } else if (ev.type === 'type') {
            await tools.typeText(ev.text || '', !!ev.enter);
          }
          fired.push({ t: ev.t, type: ev.type, ok: true });
        } catch (e) {
          fired.push({ t: ev.t, type: ev.type, ok: false, error: e.message });
          if (!opts.continueOnError) {
            return { ok: false, error: e.message, fired };
          }
        }
      }
    }

    // Update lastPlayedAt for the persisted macro (best-effort)
    if (this.userDataDir && macro.name) {
      try {
        const existing = loadMacro(this.userDataDir, macro.name);
        if (existing.ok) {
          existing.macro.lastPlayedAt = Date.now();
          saveMacro(this.userDataDir, existing.macro);
        }
      } catch (_) {}
    }

    return { ok: true, fired, runs: repeat, dryRun };
  }
}

module.exports = {
  MacroRecorder,
  validateMacro,
  saveMacro,
  loadMacro,
  listMacros,
  deleteMacro,
  macrosDir,
  macroFile,
  SCHEMA_VERSION,
  ALLOWED_EVENT_TYPES,
};
