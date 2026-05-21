'use strict';
/**
 * Computer-use tools — mouse, keyboard, scroll.
 *
 * Thin wrappers over the host-side automation helpers in agent.js. Defaults
 * (button='left', double=false, enter=false, direction='down', amount=3)
 * are preserved exactly as the original switch-case had them.
 *
 * Sprint 7D adds OCR, multi-display, and macro tools. New tools are
 * deliberately registered AFTER the originals so the require-cache order
 * doesn't affect anything that walks `registry.list()` for backwards
 * compatibility.
 */

const { register } = require('./registry');

function _agent() { return require('../agent'); }
function _ocr() { return require('../ocr'); }
function _md() { return require('../multiDisplay'); }
function _macro() { return require('../macroRecorder'); }

// ─── Per-process singletons ──────────────────────────────────────────────────
// MacroRecorder needs a userDataDir to persist .json files. The agent
// process is responsible for setting it via _setUserDataDir() — see
// src/main/agent.js which calls this from main.js boot.
let _userDataDir = null;
let _recorderSingleton = null;

function _setUserDataDir(dir) { _userDataDir = dir; }
function _recorder() {
  if (_recorderSingleton) return _recorderSingleton;
  const M = _macro();
  _recorderSingleton = new M.MacroRecorder({
    userDataDir: _userDataDir,
    agentTools: _agent(),
  });
  return _recorderSingleton;
}

// Map a (displayId, x, y) → global (x, y). When displayId is omitted we
// pass the raw coordinates through — preserves single-display behaviour.
function _resolveCoords(displayId, x, y) {
  if (displayId == null || displayId === undefined) return { x, y };
  try {
    const md = _md();
    return md.toGlobalCoords(displayId, x, y);
  } catch (_) {
    return { x, y };
  }
}

register({
  name: 'mouse_move',
  description: 'Move mouse without clicking. Pass displayId to target a specific monitor.',
  parameters: { x: 'number', y: 'number', displayId: 'number (optional, monitor id from list_displays)' },
  async execute(args = {}) {
    const { x, y } = _resolveCoords(args.displayId, args.x, args.y);
    return _agent().mouseMove(x, y);
  },
});

register({
  name: 'mouse_click',
  description: 'Click mouse at screen coordinates. Pass displayId to target a specific monitor.',
  parameters: { x: 'number', y: 'number', button: 'left|right', double: 'boolean', displayId: 'number (optional)' },
  async execute(args = {}) {
    const { x, y } = _resolveCoords(args.displayId, args.x, args.y);
    return _agent().mouseClick(x, y, args.button || 'left', args.double || false);
  },
});

register({
  name: 'type_text',
  description: 'Type text into focused window',
  parameters: { text: 'string', enter: 'boolean' },
  async execute(args = {}) {
    return _agent().typeText(args.text || '', args.enter || false);
  },
});

register({
  name: 'press_key',
  description: 'Press key or shortcut: enter, ctrl+c, ctrl+v, alt+tab, ctrl+s, f5',
  parameters: { key: 'string' },
  async execute(args = {}) {
    return _agent().pressKey(args.key);
  },
});

register({
  name: 'scroll',
  description: 'Scroll mouse wheel up or down',
  parameters: { direction: 'up|down', amount: 'number 1-10' },
  async execute(args = {}) {
    return _agent().scroll(args.direction || 'down', args.amount || 3);
  },
});

// ─── Multi-display tools ─────────────────────────────────────────────────────

register({
  name: 'list_displays',
  description: 'List all connected monitors with their bounds, scale, and which is primary.',
  parameters: {},
  async execute() {
    const displays = _md().listDisplays();
    return { ok: true, displays };
  },
});

register({
  name: 'screenshot',
  description: 'Capture a screenshot. Pass displayId for a specific monitor, or omit for primary. Returns {base64, path, display}.',
  parameters: { displayId: 'number (optional, omit for primary)', allDisplays: 'boolean (optional)' },
  async execute(args = {}) {
    const md = _md();
    if (args.allDisplays) {
      const shots = await md.captureAll();
      return { ok: true, shots: shots.map(s => ({ ok: s.ok, base64: s.base64, path: s.path, display: s.display, error: s.error })) };
    }
    const r = await md.captureDisplay(args.displayId ?? null);
    if (!r.ok) return r;
    return { ok: true, base64: r.base64, path: r.path, display: r.display };
  },
});

// ─── OCR tools ───────────────────────────────────────────────────────────────

/**
 * Lazy screenshot helper: prefer the multi-display capture when Electron's
 * screen module is available, otherwise return a clear error. Used by
 * the OCR tools so they never have to re-implement display lookup.
 */
async function _captureForOcr(displayId) {
  const md = _md();
  const shot = await md.captureDisplay(displayId ?? null);
  return shot;
}

register({
  name: 'ocr_screenshot',
  description: 'Run OCR on a screenshot. Returns {text, blocks: [{text,x,y,w,h,confidence}]}. Requires `tesseract.js` optional dep.',
  parameters: { displayId: 'number (optional, default primary)' },
  async execute(args = {}) {
    const ocr = _ocr();
    if (!ocr.isAvailable()) return { ok: false, error: ocr.unavailableMessage(), text: '', blocks: [] };
    const shot = await _captureForOcr(args.displayId ?? null);
    if (!shot.ok) return { ok: false, error: shot.error || 'screenshot failed' };
    return ocr.runOcr(shot.buffer);
  },
});

register({
  name: 'ocr_region',
  description: 'Run OCR on a sub-region of a display. Coordinates are display-relative.',
  parameters: { x: 'number', y: 'number', w: 'number', h: 'number', displayId: 'number (optional)' },
  async execute(args = {}) {
    const ocr = _ocr();
    if (!ocr.isAvailable()) return { ok: false, error: ocr.unavailableMessage(), text: '', blocks: [] };
    const shot = await _captureForOcr(args.displayId ?? null);
    if (!shot.ok) return { ok: false, error: shot.error || 'screenshot failed' };
    return ocr.runOcrRegion(shot.buffer, args.x|0, args.y|0, args.w|0, args.h|0);
  },
});

register({
  name: 'find_text',
  description: 'OCR-find the first occurrence of `query` on screen. Returns {x,y,w,h,text,confidence} or null. Cheaper than smart_click for plain-text targets.',
  parameters: { query: 'string', displayId: 'number (optional)', exact: 'boolean (optional)', caseSensitive: 'boolean (optional)' },
  async execute(args = {}) {
    const ocr = _ocr();
    if (!ocr.isAvailable()) return { ok: false, error: ocr.unavailableMessage(), match: null };
    const shot = await _captureForOcr(args.displayId ?? null);
    if (!shot.ok) return { ok: false, error: shot.error || 'screenshot failed' };
    const r = await ocr.findInImage(shot.buffer, args.query, { exact: !!args.exact, caseSensitive: !!args.caseSensitive });
    if (r.match) {
      // Tag the result with the source display so the agent can compose
      // find_text → mouse_click without losing monitor context.
      r.match.displayId = shot.display?.id ?? null;
    }
    return r;
  },
});

// ─── Macro tools ─────────────────────────────────────────────────────────────

register({
  name: 'macro_record_start',
  description: 'Begin recording a macro of mouse/keyboard activity. Stop with macro_record_stop.',
  parameters: { name: 'string' },
  async execute(args = {}) {
    return _recorder().start(args.name);
  },
});

register({
  name: 'macro_record_stop',
  description: 'Stop recording and save the macro to disk. Returns the saved macro.',
  parameters: {},
  async execute() {
    return _recorder().stop();
  },
});

register({
  name: 'macro_play',
  description: 'Play back a saved macro. opts: {speed=1.0, repeat=1, dryRun=false}.',
  parameters: { name: 'string', speed: 'number (optional)', repeat: 'number (optional)', dryRun: 'boolean (optional)' },
  async execute(args = {}) {
    const M = _macro();
    const r = M.loadMacro(_userDataDir, args.name);
    if (!r.ok) return r;
    return _recorder().play(r.macro, {
      speed: typeof args.speed === 'number' ? args.speed : 1.0,
      repeat: args.repeat || 1,
      dryRun: !!args.dryRun,
    });
  },
});

register({
  name: 'macro_list',
  description: 'List all saved macros: name, event count, duration, last-played timestamp.',
  parameters: {},
  async execute() {
    const M = _macro();
    return { ok: true, macros: M.listMacros(_userDataDir) };
  },
});

register({
  name: 'macro_delete',
  description: 'Delete a saved macro.',
  parameters: { name: 'string' },
  async execute(args = {}) {
    const M = _macro();
    return M.deleteMacro(_userDataDir, args.name);
  },
});

// Exported for main.js boot — pass userData dir so the recorder can
// persist .json files in <userData>/macros/. `_getRecorder` is exposed
// so the IPC layer can push renderer-captured events into the same
// in-memory event buffer that macro_record_stop will flush to disk.
module.exports = { _setUserDataDir, _getRecorder: _recorder };
