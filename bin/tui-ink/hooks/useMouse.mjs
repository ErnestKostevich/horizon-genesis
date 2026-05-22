// bin/tui-ink/hooks/useMouse.mjs
//
// Sprint-2.13 — minimal mouse support for the Ink TUI. Ink itself has
// no mouse hooks (the maintainer politely declines mouse PRs for
// portability reasons), so we patch stdin directly:
//
//   1. On mount: enable SGR-1006 + button-event mouse modes via
//      ANSI escapes  \x1b[?1000h  \x1b[?1006h  (works on Windows
//      Terminal, iTerm2, kitty, alacritty, wezterm, ghostty, modern
//      gnome-terminal/konsole).
//   2. Patch stdin's `data` event to scan incoming buffers for SGR
//      mouse sequences  \x1b[<button;col;rowM  (press)
//                       \x1b[<button;col;rowm  (release).
//      Forward parsed events to the supplied onMouse callback.
//   3. On unmount: disable mouse modes so the user's shell doesn't get
//      polluted after Ink exits.
//
// We DON'T try to compute "which component was clicked" — that would
// need a measured layout tree which Ink doesn't expose. Instead we
// return raw {button, col, row, kind: 'press'|'release'|'scroll-up'|
// 'scroll-down'} and the caller decides. App.mjs uses scroll-up/down
// to navigate transcript focus and presses get ignored unless we add
// click targets later.
//
// The hook is graceful: if stdin isn't a TTY or doesn't support raw
// mode, it just returns without enabling anything (so the TUI degrades
// to keyboard-only without crashing).

import { useEffect } from 'react';

const ENABLE  = '\x1b[?1000h\x1b[?1006h';
const DISABLE = '\x1b[?1006l\x1b[?1000l';
const SGR_RE  = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// Sprint-2.14.2 — register a process-level exit hook on first call.
// Ink's normal unmount cleanup runs only when the React tree unmounts
// gracefully. If the user hits Ctrl-C, the process crashes, or
// useApp().exit() is bypassed, the terminal stays in SGR-1006 mouse
// mode and the user's shell sees mouse escapes leaking into stdin
// after we exit. This hook flips mouse mode off no matter how we die.
let _exitHookInstalled = false;
function _installExitHook() {
  if (_exitHookInstalled) return;
  _exitHookInstalled = true;
  const off = () => { try { process.stdout.write(DISABLE); } catch (_) {} };
  process.on('exit', off);
  process.on('SIGINT', () => { off(); process.exit(130); });
  process.on('SIGTERM', () => { off(); process.exit(143); });
}

export default function useMouse(onMouse) {
  useEffect(() => {
    if (!process.stdin.isTTY || typeof onMouse !== 'function') return;
    try {
      process.stdout.write(ENABLE);
      _installExitHook();
    } catch (_) {
      return;
    }
    const onData = (chunk) => {
      const str = chunk.toString();
      // Quick reject — most input frames don't contain mouse sequences.
      if (!str.includes('\x1b[<')) return;
      SGR_RE.lastIndex = 0;
      let m;
      while ((m = SGR_RE.exec(str)) !== null) {
        const button = parseInt(m[1], 10);
        const col = parseInt(m[2], 10);
        const row = parseInt(m[3], 10);
        const isPress = m[4] === 'M';
        let kind;
        // Bits 6+: scroll. Button code 64 = scroll up, 65 = scroll down.
        if (button === 64) kind = 'scroll-up';
        else if (button === 65) kind = 'scroll-down';
        else if (isPress) kind = 'press';
        else kind = 'release';
        try { onMouse({ kind, button, col, row }); } catch (_) {}
      }
    };
    process.stdin.on('data', onData);
    return () => {
      try { process.stdin.off('data', onData); } catch (_) {}
      try { process.stdout.write(DISABLE); } catch (_) {}
    };
  }, [onMouse]);
}
