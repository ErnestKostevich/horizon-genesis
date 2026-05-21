// Unit tests for macro file format + persistence (Sprint 7D).
//
// Exercises validateMacro / saveMacro / loadMacro / listMacros / deleteMacro
// against a tmpdir-backed userDataDir. The recorder + playback paths
// (which fire native automation) are NOT tested here — they're OS-specific
// and require human-driven inputs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateMacro, saveMacro, loadMacro, listMacros, deleteMacro,
  macroFile, macrosDir, SCHEMA_VERSION,
  MacroRecorder,
} = require('../../src/main/macroRecorder');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-macro-test-'));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test('validateMacro: accepts a well-formed macro', () => {
  const r = validateMacro({
    name: 'demo',
    version: SCHEMA_VERSION,
    duration: 500,
    events: [
      { t: 0, type: 'mouse_move', x: 10, y: 20 },
      { t: 250, type: 'mouse_click', x: 10, y: 20, button: 'left' },
      { t: 500, type: 'end' },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.sortedOk, true);
});

test('validateMacro: rejects missing name', () => {
  const r = validateMacro({ events: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /name/);
});

test('validateMacro: rejects bad event type', () => {
  const r = validateMacro({
    name: 'bad',
    events: [{ t: 0, type: 'launch_nukes' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /not allowed/);
});

test('validateMacro: rejects mouse_move missing x/y', () => {
  const r = validateMacro({
    name: 'bad',
    events: [{ t: 0, type: 'mouse_move' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /numeric x,y/);
});

test('validateMacro: flags unsorted events but accepts them', () => {
  const r = validateMacro({
    name: 'jumbled',
    events: [
      { t: 100, type: 'mouse_move', x: 0, y: 0 },
      { t: 50,  type: 'mouse_move', x: 1, y: 1 },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.sortedOk, false);
});

test('validateMacro: rejects unsupported schema version', () => {
  const r = validateMacro({ name: 'x', version: '9.9', events: [{ t: 0, type: 'end' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /schema version/);
});

test('saveMacro + loadMacro round-trip', () => {
  const dir = tmpDir();
  try {
    const m = {
      name: 'click-save',
      events: [
        { t: 0, type: 'mouse_move', x: 100, y: 200 },
        { t: 250, type: 'mouse_click', x: 100, y: 200, button: 'left' },
        { t: 800, type: 'key', key: 'Tab' },
        { t: 1100, type: 'type', text: 'Hello world' },
        { t: 4500, type: 'end' },
      ],
    };
    const saved = saveMacro(dir, m);
    assert.equal(saved.ok, true);
    assert.ok(fs.existsSync(saved.path));
    assert.equal(saved.macro.version, SCHEMA_VERSION);
    assert.equal(saved.macro.duration, 4500);

    const loaded = loadMacro(dir, 'click-save');
    assert.equal(loaded.ok, true);
    assert.equal(loaded.macro.name, 'click-save');
    assert.equal(loaded.macro.events.length, 5);
    assert.equal(loaded.macro.events[3].text, 'Hello world');
  } finally { cleanup(dir); }
});

test('saveMacro: sorts unsorted events on disk', () => {
  const dir = tmpDir();
  try {
    const saved = saveMacro(dir, {
      name: 'jumbled',
      events: [
        { t: 100, type: 'mouse_move', x: 1, y: 1 },
        { t: 50,  type: 'mouse_move', x: 0, y: 0 },
        { t: 150, type: 'end' },
      ],
    });
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.macro.events.map(e => e.t), [50, 100, 150]);
  } finally { cleanup(dir); }
});

test('listMacros: returns sorted by updatedAt desc', async () => {
  const dir = tmpDir();
  try {
    saveMacro(dir, { name: 'first', events: [{ t: 0, type: 'end' }] });
    // Slight sleep so updatedAt timestamps differ
    await new Promise(r => setTimeout(r, 5));
    saveMacro(dir, { name: 'second', events: [{ t: 0, type: 'end' }] });
    const items = listMacros(dir);
    assert.equal(items.length, 2);
    assert.equal(items[0].name, 'second');
    assert.equal(items[1].name, 'first');
  } finally { cleanup(dir); }
});

test('deleteMacro: removes file from disk', () => {
  const dir = tmpDir();
  try {
    saveMacro(dir, { name: 'doomed', events: [{ t: 0, type: 'end' }] });
    assert.ok(fs.existsSync(macroFile(dir, 'doomed')));
    const r = deleteMacro(dir, 'doomed');
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(macroFile(dir, 'doomed')), false);
  } finally { cleanup(dir); }
});

test('deleteMacro: errors on unknown macro', () => {
  const dir = tmpDir();
  try {
    const r = deleteMacro(dir, 'never-existed');
    assert.equal(r.ok, false);
    assert.match(r.error, /not found/);
  } finally { cleanup(dir); }
});

test('macroFile: rejects empty / whitespace-only names', () => {
  // Empty / whitespace-only names produce no normalized result and must throw.
  assert.throws(() => macroFile('/tmp', ''));
  assert.throws(() => macroFile('/tmp', '   '));
  assert.throws(() => macroFile('/tmp', '!!!'));
});

test('macroFile: defangs path-traversal attempts', () => {
  // We don't reject ../../../etc/passwd outright — the safe-name regex
  // strips path separators down to a hyphenated alphanumeric string, so
  // the resulting file lives inside macrosDir() and can't escape.
  const dir = tmpDir();
  try {
    const f = macroFile(dir, '../../../etc/passwd');
    // The file basename must NOT contain any path traversal characters.
    const base = path.basename(f);
    assert.equal(base.includes('..'), false);
    assert.equal(base.includes('/'), false);
    assert.equal(base.includes('\\'), false);
    // And the file must resolve UNDER macrosDir(dir).
    const dirResolved = path.resolve(macrosDir(dir));
    const fileResolved = path.resolve(f);
    assert.ok(fileResolved.startsWith(dirResolved), `Expected ${fileResolved} to start with ${dirResolved}`);
  } finally { cleanup(dir); }
});

test('macroFile: normalizes safe names', () => {
  const dir = tmpDir();
  try {
    const f1 = macroFile(dir, 'Open Gmail');
    const f2 = macroFile(dir, 'open-gmail');
    // Both should normalize to the same file name (lowercased, hyphens for spaces)
    assert.equal(path.basename(f1), path.basename(f2));
  } finally { cleanup(dir); }
});

test('MacroRecorder: dry-run playback walks events without firing native actions', async () => {
  const dir = tmpDir();
  try {
    const macro = {
      name: 'fake',
      version: SCHEMA_VERSION,
      events: [
        { t: 0,   type: 'mouse_move', x: 1, y: 1 },
        { t: 10,  type: 'mouse_click', x: 1, y: 1 },
        { t: 20,  type: 'key', key: 'Enter' },
        { t: 30,  type: 'end' },
      ],
    };
    const rec = new MacroRecorder({ userDataDir: dir, agentTools: null });
    const r = await rec.play(macro, { dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.fired.length, 4);
    assert.equal(r.fired[0].type, 'mouse_move');
    assert.equal(r.fired[3].type, 'end');
  } finally { cleanup(dir); }
});

test('MacroRecorder: play(repeat=N) plays N times', async () => {
  const dir = tmpDir();
  try {
    const macro = { name: 'r', version: SCHEMA_VERSION, events: [{ t: 0, type: 'end' }] };
    const rec = new MacroRecorder({ userDataDir: dir, agentTools: null });
    const r = await rec.play(macro, { dryRun: true, repeat: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.runs, 3);
    assert.equal(r.fired.length, 3);
  } finally { cleanup(dir); }
});

test('MacroRecorder: stop() without start() fails cleanly', () => {
  const rec = new MacroRecorder({ userDataDir: tmpDir() });
  const r = rec.stop();
  assert.equal(r.ok, false);
  assert.match(r.error, /Not recording/);
});

test('MacroRecorder: start() with no name fails', () => {
  const rec = new MacroRecorder({ userDataDir: tmpDir() });
  const r = rec.start('');
  assert.equal(r.ok, false);
});

test('MacroRecorder: pushEvent during recording captures events', async () => {
  const dir = tmpDir();
  try {
    const rec = new MacroRecorder({ userDataDir: dir });
    const start = rec.start('manual');
    // Even if no hook is present, start() still returns ok with a warning.
    assert.equal(start.ok, true);
    rec.pushEvent({ type: 'mouse_move', x: 10, y: 20 });
    rec.pushEvent({ type: 'mouse_click', x: 10, y: 20, button: 'left' });
    rec.pushEvent({ type: 'type', text: 'hi' });
    const stopped = rec.stop();
    assert.equal(stopped.ok, true);
    // Events buffered + a trailing 'end' event appended on stop.
    const events = stopped.macro.events;
    assert.ok(events.length >= 3);
    assert.equal(events[0].type, 'mouse_move');
    assert.equal(events[events.length - 1].type, 'end');
  } finally { cleanup(dir); }
});
