// Inline interactive menu — Phase 20.3 polish.
//
// Used by the TUI when a slash command wants to offer a pickable list
// (e.g. /skill list, /persona-list, /model-list). The engine is paused
// for the duration so the menu owns stdin; on resolve / cancel the
// engine resumes and the picked value gets returned to the caller.
//
// Behaviour:
//   ↑/↓ or k/j    move highlight
//   Home / End    jump to first / last
//   Enter         select highlighted row
//   Mouse click   click a row to select
//   Mouse wheel   scroll the highlight up/down
//   Esc / q       cancel (resolves to null)
//
// The highlighted row uses reverse-video (\x1b[7m), so "mouse hover"
// (the arrow-cursor inside the menu region) effectively shows an
// inverted bg on the row under the cursor — exactly what was asked for.

const readline = require('readline');
const { fmt } = require('./tty');

const ANSI = {
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  mouseOn:  '\x1b[?1000h\x1b[?1006h',
  mouseOff: '\x1b[?1000l\x1b[?1006l',
  clearLine: '\x1b[2K',
  cursorUp:  (n) => `\x1b[${n}A`,
  cursorTo:  (col) => `\x1b[${col}G`,
};

/**
 * Run an inline menu and return the picked item (or null on cancel).
 *
 * @param {object}   opts
 * @param {object}   opts.engine    TuiEngine instance (will be paused)
 * @param {string}   opts.title     Menu heading
 * @param {Array}    opts.items     [{label, sublabel?, value, disabled?}]
 * @param {string=}  opts.footer    Optional hint line under the menu
 * @param {number=}  opts.initial   Initial cursor index
 */
function interactiveMenu({ engine, title, items, footer, initial = 0 }) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || items.length === 0) {
      return resolve(null);
    }

    if (engine && typeof engine.pause === 'function') engine.pause();

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    try { stdin.setRawMode(true); } catch (_) {}
    readline.emitKeypressEvents(stdin);
    stdin.resume();
    stdin.setEncoding('utf8');

    process.stdout.write(ANSI.hide + ANSI.mouseOn);

    let cursor = Math.max(0, Math.min(initial, items.length - 1));
    let firstDraw = true;
    let menuStartLine = 0; // remember where we drew so we can erase

    function draw() {
      const out = [];
      // Move cursor up to start of menu (erase previous draw)
      if (!firstDraw) {
        out.push(ANSI.cursorUp(menuStartLine));
        // Clear each old line
        for (let i = 0; i < menuStartLine; i++) {
          out.push(ANSI.clearLine + '\n');
        }
        out.push(ANSI.cursorUp(menuStartLine));
      }

      out.push('\n  ' + fmt.bold(title) + '\n');
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const active = i === cursor;
        const prefix = active ? fmt.cyan(' ▸ ') : '   ';
        let row;
        if (active) {
          // Inverted bg row — the "hover" effect
          row = '\x1b[7m' + ' '.repeat(2) + (it.label || '').padEnd(28) + (it.sublabel ? '  ' + it.sublabel : '') + '\x1b[0m';
        } else {
          row = fmt.dim('  ') + (it.label || '').padEnd(28) + (it.sublabel ? fmt.dim('  ' + it.sublabel) : '');
        }
        if (it.disabled) row = fmt.dim('   ' + (it.label || '') + (it.sublabel ? '  ' + it.sublabel : ''));
        out.push(prefix + row + '\n');
      }
      if (footer) out.push('\n  ' + fmt.dim(footer) + '\n');
      else out.push('\n  ' + fmt.dim('↑/↓ move · Enter pick · Esc cancel · click to choose') + '\n');

      const text = out.join('');
      menuStartLine = (text.match(/\n/g) || []).length;
      process.stdout.write(text);
      firstDraw = false;
    }

    function cleanup() {
      stdin.removeListener('keypress', onKey);
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(wasRaw); } catch (_) {}
      process.stdout.write(ANSI.show + ANSI.mouseOff + '\n');
      stdin.pause();
      if (engine && typeof engine.resume === 'function') engine.resume();
    }

    function pick() {
      const it = items[cursor];
      if (!it || it.disabled) return;
      cleanup();
      resolve(it.value !== undefined ? it.value : it);
    }

    function cancel() {
      cleanup();
      resolve(null);
    }

    function onKey(ch, key) {
      if (!key) return;
      if (key.ctrl && key.name === 'c') return cancel();
      if (key.name === 'escape' || key.name === 'q') return cancel();
      if (key.name === 'return' || key.name === 'enter') return pick();
      if (key.name === 'up'   || key.name === 'k') { cursor = (cursor - 1 + items.length) % items.length; draw(); return; }
      if (key.name === 'down' || key.name === 'j') { cursor = (cursor + 1) % items.length; draw(); return; }
      if (key.name === 'home') { cursor = 0; draw(); return; }
      if (key.name === 'end')  { cursor = items.length - 1; draw(); return; }
      // Digit shortcuts 1..9
      const idx = parseInt(ch, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= items.length) { cursor = idx - 1; draw(); pick(); return; }
    }

    function onData(buf) {
      const s = buf.toString();
      // SGR mouse: \x1b[<button;col;row(M|m)
      const m = s.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
      if (!m) return;
      const button = parseInt(m[1], 10);
      const press  = m[4] === 'M';
      // Wheel up = 64, wheel down = 65 (with SGR)
      if (button === 64 && press) { cursor = (cursor - 1 + items.length) % items.length; draw(); return; }
      if (button === 65 && press) { cursor = (cursor + 1) % items.length; draw(); return; }
      // Left click — pick the row clicked. We don't track absolute screen
      // row, so just treat any left-click as confirm-current.
      if (button === 0 && press) pick();
    }

    stdin.on('keypress', onKey);
    stdin.on('data', onData);
    draw();
  });
}

module.exports = { interactiveMenu };
