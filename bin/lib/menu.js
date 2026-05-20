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

// Sprint 2.6 — mouse-event guard. Same problem the main TUI engine has:
// SGR mouse reports (\x1b[<…M) can fragment across data events on Windows
// ConPTY. When that happens readline emits the payload bytes ("0;43;51M")
// as plain keypress events, which previously got interpreted as digit
// shortcuts inside the picker → AUTO-COMMITTED the wrong row before the
// user could press Enter. We strip mouse debris in both the data path
// AND the keypress path with a short post-mouse swallow window.
const SGR_PAYLOAD_RE = /^[0-9;]*[Mm]$|^[0-9;]+$|^[Mm]$/;

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
      // Sprint 2.6 — make Enter LOUD. The previous footer ("Enter pick")
      // was easy to misread; users assumed any letter would commit. After
      // a mouse-leak incident that auto-committed the wrong provider, we
      // spell it out explicitly: only Enter switches.
      if (footer) out.push('\n  ' + fmt.dim(footer) + '\n');
      else out.push('\n  ' + fmt.dim('↑/↓ move · ') + fmt.bold('Enter to switch') + fmt.dim(' · Esc cancel') + '\n');

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
      // Sprint 2.6 — force a clean redraw of the host TUI so the picker
      // closing doesn't leave a stale region behind ("window hang").
      // engine.resume() already calls _renderInputBar internally; the
      // _eraseInputBar+repaint guarantees the new frame is fresh.
      try {
        if (engine && typeof engine._forceRedraw === 'function') {
          engine._forceRedraw();
        }
      } catch (_) {}
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

    // Sprint 2.6 — mouse-leak swallow window (mirrors tui-engine logic).
    let swallowUntil = 0;

    function onKey(ch, key) {
      if (!key) return;

      // Sprint 2.6 — drop mouse-sequence noise BEFORE any other handling.
      // SGR fragments ("\x1b[<", payload digits, lone M/m) must never be
      // interpreted as commit-causing keystrokes.
      if (key.sequence) {
        const isSgr    = key.sequence.indexOf('\x1b[<') >= 0;
        const isLegacy = /\x1b\[M.{3}/.test(key.sequence);
        if (isSgr || isLegacy) {
          // If terminator not in sequence, keep swallowing for a window.
          if (isSgr && /[Mm]/.test(key.sequence.slice(key.sequence.indexOf('\x1b[<') + 3))) {
            swallowUntil = Date.now() + 250;
          } else {
            swallowUntil = Date.now() + 250;
          }
          return;
        }
      }
      if (swallowUntil && Date.now() < swallowUntil) {
        const c = (ch && typeof ch === 'string') ? ch : (key.sequence || '');
        if (c && SGR_PAYLOAD_RE.test(c)) {
          if (/[Mm]/.test(c)) swallowUntil = 0;
          return;
        }
        if (c && /^[0-9;]+$/.test(c) && c.length <= 16) return;
      }

      if (key.ctrl && key.name === 'c') return cancel();
      if (key.name === 'escape' || key.name === 'q') return cancel();
      // Sprint 2.6 — ONLY Enter commits. Any other key (including digits,
      // letters, M/m) only moves the highlight. Previously digit shortcuts
      // auto-committed (cursor = idx-1; pick()) which combined with the
      // mouse leak to silently switch providers without user confirmation.
      if (key.name === 'return' || key.name === 'enter') return pick();
      if (key.name === 'up'   || key.name === 'k') { cursor = (cursor - 1 + items.length) % items.length; draw(); return; }
      if (key.name === 'down' || key.name === 'j') { cursor = (cursor + 1) % items.length; draw(); return; }
      if (key.name === 'home') { cursor = 0; draw(); return; }
      if (key.name === 'end')  { cursor = items.length - 1; draw(); return; }
      // Digit 1..9 only MOVES the highlight (no auto-pick).
      const idx = parseInt(ch, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= items.length) { cursor = idx - 1; draw(); return; }
    }

    function onData(buf) {
      const s = buf.toString();
      // SGR mouse: \x1b[<button;col;row(M|m)
      // Sprint 2.6 — was anchored ^…$ which only matched perfectly-aligned
      // single-event chunks. Loosen to find ANY SGR mouse sequence in the
      // buffer; this also implies fragmented payloads can't be mis-read
      // as menu commits because onKey now swallows their debris.
      const m = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
      // Arm the swallow window any time we see a mouse byte sequence.
      if (s.indexOf('\x1b[<') >= 0 || /\x1b\[M.{3}/.test(s)) {
        swallowUntil = Date.now() + 250;
      }
      if (!m) return;
      const button = parseInt(m[1], 10);
      const press  = m[4] === 'M';
      // Wheel up = 64, wheel down = 65 (with SGR)
      if (button === 64 && press) { cursor = (cursor - 1 + items.length) % items.length; draw(); return; }
      if (button === 65 && press) { cursor = (cursor + 1) % items.length; draw(); return; }
      // Sprint 2.6 — left-click no longer auto-commits. Without precise
      // row tracking, any click would commit whatever was last hovered,
      // which combined with drag events caused silent wrong switches.
      // Click is now a no-op; user must press Enter to confirm.
    }

    stdin.on('keypress', onKey);
    stdin.on('data', onData);
    draw();
  });
}

module.exports = { interactiveMenu };
