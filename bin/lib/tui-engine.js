// TUI v2 engine — raw-mode terminal manager.
//
// Replaces the simple readline-based loop with a keypress + mouse driver
// that supports:
//   - multi-line composer (Shift+Enter inserts newline, Enter sends)
//   - in-chat search overlay (Ctrl+F starts search, n/N navigate, Esc exits)
//   - scrollback through past output (Page Up/Down, Ctrl+B/F)
//   - mouse click → focus input, scroll wheel → transcript scroll
//   - persistent input bar at the bottom across all states
//   - Tab autocomplete via a provided completer function
//   - Ctrl+L clear, Ctrl+C exit, Ctrl+U clear line, Ctrl+A/E line nav
//
// Architecture:
//   - process.stdin in raw mode; readline.emitKeypressEvents parses ANSI
//     for us into {name, ctrl, shift, alt, sequence} events.
//   - We additionally listen for raw 'data' to catch mouse sequences
//     (\x1b[<...M / \x1b[<...m in SGR mode) which keypress doesn't decode.
//   - All output goes through engine.print(line) — this both writes to
//     stdout AND appends to the in-memory transcript buffer used by
//     search + scrollback.
//   - Redraw model: when scrollback offset == 0 (live view), we just
//     append. When scrollback offset > 0 (looking at history), we
//     clear-and-repaint the visible region.
//
// Cross-platform notes:
//   - Mouse mode (?1006) is widely supported on Windows Terminal,
//     macOS Terminal.app, iTerm2, xterm. PowerShell legacy host doesn't
//     forward mouse — engine.hasMouse() reflects whether we got any
//     events in the first 2 seconds, so the click-to-focus hint is only
//     shown when meaningful.
//   - On exit (clean or signal), we restore terminal state: cooked
//     mode, mouse off, cursor visible, alt screen off.

const readline = require('readline');
const { fmt } = require('./tty');
const { ctxFor } = require('./themes');

const ANSI = {
  clearScreen: '\x1b[2J\x1b[H',
  clearLine:   '\x1b[2K',
  cursorHome:  '\x1b[H',
  cursorUp:    n => `\x1b[${n}A`,
  cursorDown:  n => `\x1b[${n}B`,
  cursorRight: n => `\x1b[${n}C`,
  cursorLeft:  n => `\x1b[${n}D`,
  cursorTo:    (col) => `\x1b[${col}G`,
  cursorSave:  '\x1b7',
  cursorRestore: '\x1b8',
  cursorHide:  '\x1b[?25l',
  cursorShow:  '\x1b[?25h',
  mouseOn:     '\x1b[?1000h\x1b[?1006h',
  mouseOff:    '\x1b[?1000l\x1b[?1006l',
  altOn:       '\x1b[?1049h',
  altOff:      '\x1b[?1049l',
};

// SGR mouse:    \x1b[<button;col;row(M|m)   — modern, used by ?1006
// Legacy mouse: \x1b[M<btn><col><row>       — 3 raw bytes after 'M'
// We use these in two places:
//   - _handleData / data prelistener: parse buttons + col/row, dispatch
//   - _handleKey: filter so the chars never leak into the composer
const SGR_MOUSE_RE    = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const LEGACY_MOUSE_RE = /\x1b\[M(.)(.)(.)/g;
// Permissive char-class for the SGR payload — used to swallow fragmented
// remnants that readline may emit as individual keypress events after it
// has consumed the leading "\x1b[<". Digits, semicolons, terminators.
//
// Sprint 2.5 — broadened to also catch full-payload-as-single-string
// (e.g. "0;43;51M", "1;29M") which some terminal/readline combinations
// emit as one keypress when they coalesce. The empty-string case is
// excluded — we don't want this filter to drop ordinary backspace etc.
//
// Sprint 2.6 — also catch tails that include a trailing letter from the
// next chunk (terminal sometimes coalesces "51M" with the next byte that
// would otherwise have been a fresh keypress), and short fragments like
// just "M" or "m" arriving alone.
const SGR_MOUSE_PAYLOAD_RE = /^[0-9;]*[Mm]$|^[0-9;]+$|^[Mm]$/;

/**
 * Feature-detect whether the host terminal forwards mouse events sanely.
 * Mouse mode is fine on:
 *   - any non-Windows TTY (xterm-like terminals)
 *   - Windows Terminal (WT_SESSION set)
 *   - VS Code / iTerm2 / similar that set TERM_PROGRAM
 *   - ConEmu (ConEmuPID set), Cmder, etc.
 * It is NOT enabled on legacy Windows console (cmd.exe / PowerShell host
 * without WT_SESSION), where SGR mouse reporting often round-trips as
 * literal text characters into the input stream — the bug this guards.
 * Set HORIZON_TUI_MOUSE=0 / =1 to force disable / enable.
 */
function _supportsMouse() {
  const env = process.env || {};
  const force = env.HORIZON_TUI_MOUSE;
  if (force === '0' || force === 'false') return false;
  if (force === '1' || force === 'true')  return true;
  if (process.platform !== 'win32') return true;
  if (env.WT_SESSION)   return true;   // Windows Terminal
  if (env.TERM_PROGRAM) return true;   // VS Code, iTerm2, etc.
  if (env.ConEmuPID || env.ConEmuANSI === 'ON') return true;
  // On Windows we are conservative: require an explicit modern-terminal
  // signal. Bare `TERM=xterm-256color` set by some shells (Git Bash,
  // some PowerShell profiles) does NOT mean the host actually forwards
  // SGR mouse reports cleanly — legacy ConPTY echoes them back as text
  // that leaks into the composer. Users who want mouse on those hosts
  // can set HORIZON_TUI_MOUSE=1.
  return false; // legacy ConPTY / cmd.exe / PowerShell host → off
}

const PROMPT = '› ';

// Fix 6 — descriptions for slash-command autocomplete menu
const SLASH_DESCRIPTIONS = {
  '/help':         'show available slash commands',
  '/quit':         'exit the TUI',
  '/exit':         'exit the TUI',
  '/clear':        'clear screen',
  '/reset':        'clear chat history (memory retained)',
  '/skills':       'list installed skills (interactive)',
  '/skill':        'force-include a skill in next turn',
  '/skill-show':   'print a skill\'s SKILL.md',
  '/persona':      'show / switch persona',
  '/persona-list': 'pick a persona (interactive)',
  '/model':        'show / switch provider',
  '/model-list':   'pick a provider (interactive)',
  '/mem':          'semantic memory search',
  '/agent':        'full agent loop (multi-step + tools)',
  '/chat':         'force single-turn chat',
  '/stream':       'toggle streaming on|off',
  '/markdown':     'toggle markdown rendering on|off',
  '/banner':       'reprint the banner header',
  '/verbose':      'restart with --verbose for diagnostics',
  '/find':         'search transcript (same as Ctrl+F)',
  '/mobile':       'pair a phone via QR code',
};

// Sprint 2 — short live-hint descriptions for the dim grey hint line that
// appears UNDER the composer while the user types a slash command (no Tab
// required). Kept short on purpose — single line, no truncation drama.
const SLASH_HINTS = {
  '/help':         'show command list',
  '/quit':         'exit horizon',
  '/clear':        'clear screen',
  '/reset':        'clear chat history (memory keeps everything)',
  '/skills':       'list installed skills',
  '/skill':        'force-include a skill in next turn',
  '/skill-show':   'print SKILL.md for a skill',
  '/persona':      'switch active persona',
  '/persona-list': 'list available personas',
  '/model':        'switch active provider',
  '/model-list':   'list available providers',
  '/mem':          'memory search / recall / forget',
  '/agent':        'run an agent task',
  '/chat':         'send a chat (default mode anyway)',
  '/stream':       'toggle streaming on/off',
  '/markdown':     'toggle markdown render on/off',
  '/banner':       'reprint the banner',
  '/verbose':      'toggle verbose logging',
  '/find':         'in-chat search overlay',
  '/mobile':       'pair a phone via QR code',
  '/theme':        'switch CLI theme',
  '/voice':        'toggle voice input/output',
};
const SLASH_HINT_KEYS = Object.keys(SLASH_HINTS);

class TuiEngine {
  constructor(opts = {}) {
    this.completer = opts.completer || null;
    this.onLine = opts.onLine || (() => {});
    this.onExit = opts.onExit || null;
    this.transcript = []; // every printed line (text only, no ANSI strip — we re-emit raw)
    this.maxTranscript = 5000;

    // Composer state
    this.lines = [''];      // composer lines (multi-line buffer)
    this.lineIdx = 0;       // which composer line cursor is on
    this.col = 0;           // column within that line

    // Mode flags
    this.searchActive = false;
    this.searchQuery = '';
    this.searchMatches = []; // indices into transcript
    this.searchPos = 0;
    this.scrollOffset = 0;   // 0 = live view, >0 = looking N lines back

    // History (recall via Up/Down on the first composer line)
    this.history = [];
    this.historyIdx = -1;

    this._mouseSeen = false;
    this._lastDrawHeight = 0;
    this._closed = false;
    this._sending = false;
    this._verbose = !!opts.verbose;
    this._keepaliveInterval = null;

    // Fix 3 — optional runtime handle for the persistent status line.
    // Set via engine.runtime = rt after construction; we read provider,
    // persona, lang, cost (best-effort) from it on every render.
    this.runtime = opts.runtime || null;
    this._sessionStartMs = Date.now();

    // Sprint 2 — Hermes-style status bar v2. Lightweight in-memory session
    // tracker, accumulated across runChat / runAgent calls via recordUsage.
    // costTracker on the runtime tracks long-term spend (persisted to disk);
    // this is just the THIS-SESSION view for the status bar.
    this.sessionStats = { tokensIn: 0, tokensOut: 0, costUsd: 0, lastModel: '' };

    // Fix 5 — render throttling. engine.print() may be called once per
    // streamed token (200+/sec); we throttle redraws to ~20fps so the
    // input bar doesn't flicker.
    this._pendingFrame = false;
    this._lastFrameAt = 0;
    this._frameTimer = null;

    // Fix 6 — floating autocomplete menu state.
    this._completionHits = null;   // array of slash commands or null
    this._completionIdx = 0;       // currently-highlighted hit
    this._completionPrefix = '';   // the prefix the hits were computed from

    // Sprint 2 — streaming-markdown message state. We track the transcript
    // index where the current assistant message began so we can replace
    // that tail every ~120ms with a freshly markdown-rendered version of
    // the accumulated buffer.
    //
    // Sprint 2.1 — streaming render strategy fixed.
    // The previous implementation called `\x1b[2J\x1b[H` + full repaint
    // on every update tick. `\x1b[2J` clears the viewport but does NOT
    // touch scrollback — every repaint pushed a fresh status line into
    // scrollback, producing a ladder of 30+ duplicate status bars on a
    // single reply. We now use a cursor-up + erase-to-end + delta-emit
    // approach: on each update we move cursor back over the previously
    // rendered streaming region and re-emit. The status bar / composer
    // are NOT repainted between updates; only on finish.
    this._streamStart = -1;       // transcript index where the message began
    this._streamPrefix = '';      // e.g. fmt.bold('Horizon: ')
    this._streamActive = false;
    this._streamLinesOnScreen = 0; // number of physical terminal lines
                                   // currently occupied by the rendered
                                   // streaming message (NOT including the
                                   // input bar). We cursor-up by this many
                                   // before each re-emit.

    // Sprint 2.3 — idle art timer. Fires after `_idleAfterMs` of no user
    // input; prints the "idle" art piece into the transcript and re-arms.
    // Reset by any keypress, mouse event, or after sending.
    this._idleTimer = null;
    this._idleAfterMs = 60_000;       // 60s of inactivity
    this._idleRepeatMs = 90_000;      // (unused after 2.5; kept for back-compat)
    this._idleEnabled = true;
    this._idleShown = false;          // guard: fire only once per idle window

    // Hotfix — SGR/legacy mouse escape sequences must NOT leak into the
    // composer or the AI stream. We parse mouse events from the raw data
    // buffer (so scroll wheel + click still work) and use this state
    // machine to ensure ANY keypress events readline fragments out of
    // those sequences get discarded before reaching _insertChar().
    //
    //   _mouseSwallowUntil: when truthy, swallow incoming keypress chars
    //     until we observe the terminator ('M' or 'm') — used when
    //     readline emits the SGR payload as separate keypress events
    //     after consuming the leading "\x1b[<".
    //   _mouseEnabled:      reflects whether mouseOn was actually sent
    //     this run. close() reads this so we only send mouseOff if we
    //     enabled it.
    this._mouseSwallowUntil = false;
    this._mouseSwallowDeadline = 0;   // ms epoch; 0 = inactive
    this._mouseEnabled = false;
    this._dataBuffer = '';            // persistent byte-level scan buffer
  }

  // ── public API ──────────────────────────────────────────────────────
  start() {
    // v0.0.2 — defensive boot. Two real-world failure modes:
    //   1. Non-TTY stdin (piped input, headless CI, some pkg-bundled
    //      binaries on Windows) → no setRawMode available.
    //   2. setRawMode throws despite isTTY being truthy (broken
    //      terminal driver, ConPTY glitches, Windows pkg quirks).
    // Either way, fall through to plain-readline mode instead of
    // letting the error bubble up and crash the binary with no
    // visible feedback (that was the v0.0.1 Windows splash-then-exit
    // bug). Keypress events + raw input are nice-to-have; line-based
    // readline is the always-available fallback.
    //
    // CRITICAL — event-loop keepalive (added v0.0.3):
    //   On Windows pkg-bundled binaries, stdin in raw mode sometimes
    //   doesn't keep the libuv loop alive even though listeners are
    //   attached. The process saw "no work to do" and exited right
    //   after the banner rendered. We hold the loop open with an
    //   un-unref'd setInterval(noop, 30s) until close() is called.
    this._keepaliveInterval = setInterval(() => {}, 30000);

    let rawApplied = false;
    const canRaw = !!(process.stdin.isTTY && typeof process.stdin.setRawMode === 'function');
    if (!canRaw) {
      if (this._verbose) {
        process.stderr.write('[tui] isTTY=' + !!process.stdin.isTTY
          + ' setRawMode-available=' + (typeof process.stdin.setRawMode === 'function')
          + ' raw-mode: SKIPPED — entering plain mode\n');
      }
      this._fallbackPlainMode();
      return;
    }
    try {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      rawApplied = true;
    } catch (e) {
      process.stderr.write('\n(tui) raw-mode unavailable (' + e.message + ') — falling back to plain readline.\n');
      this._fallbackPlainMode();
      return;
    }
    // Hotfix — only enable mouse mode where the terminal actually
    // forwards events through stdin cleanly. Legacy Windows console hosts
    // echo the SGR escape sequence back as literal characters, polluting
    // the composer with garbage like "0;43;51M0;43;51m". Better to lose
    // scroll-wheel-through-transcript than to corrupt the input stream.
    if (_supportsMouse()) {
      process.stdout.write(ANSI.mouseOn);
      this._mouseEnabled = true;
    } else if (this._verbose) {
      process.stderr.write('[tui] mouse: DISABLED (terminal lacks reliable SGR mouse support)\n');
    }

    this._onKey  = (ch, key) => this._handleKey(ch, key);
    this._onData = (buf) => this._handleData(buf);
    // Prepend the data listener so we observe raw bytes BEFORE readline's
    // internal keypress decoder. _handleData parses mouse sequences out
    // of the buffer and bumps a swallow flag so _handleKey can drop any
    // payload chars readline subsequently emits as fake keypresses.
    process.stdin.prependListener('data', this._onData);
    process.stdin.on('keypress', this._onKey);

    // Belt-and-suspenders: some Windows terminals send a spurious EOF
    // on startup that would otherwise terminate the stream and let the
    // process exit. We swallow EOF — the only legitimate exit paths are
    // /quit, Ctrl+C, or Ctrl+D on an empty composer.
    this._onEnd = () => { /* intentional no-op — wait for explicit exit */ };
    process.stdin.on('end', this._onEnd);

    this._installExit();

    if (this._verbose) {
      process.stderr.write('[tui] raw-mode: ' + (rawApplied ? 'ENABLED' : 'FAILED') + '\n');
      process.stderr.write('[tui] isTTY=' + !!process.stdin.isTTY
        + ' setRawMode-applied=' + rawApplied + '\n');
      process.stderr.write('[tui] keepalive=' + (this._keepaliveInterval ? 'on' : 'off') + '\n');
    }

    setTimeout(() => {
      if (!this._mouseSeen && !this._closed) {
        // No mouse events received — likely a terminal without forwarding.
        // We don't disable anything; just remember for status display.
      }
    }, 2000);

    // Sprint 2.3 — arm idle timer (60s) so we show a tiny "still here" art
    // piece when the user steps away. Reset by any keypress/mouse/send.
    this._resetIdleTimer();

    this._renderInputBar();
  }

  /**
   * Print a line to the transcript. Goes both to stdout and to the
   * in-memory buffer so search + scrollback can find it later.
   * Pass `noAppend: true` for ephemeral status messages.
   *
   * Fix 5 — throttle input-bar redraws to ~20fps. When tokens arrive at
   * 200/sec (typical streaming rate) we'd otherwise redraw the input
   * bar 200 times/sec which causes visible flicker. We coalesce redraws
   * inside a 50ms window with a trailing-edge setTimeout.
   */
  print(text, { noAppend = false } = {}) {
    const lines = String(text).split('\n');
    if (!noAppend) {
      for (const l of lines) {
        this.transcript.push(l);
        if (this.transcript.length > this.maxTranscript) {
          this.transcript.splice(0, this.transcript.length - this.maxTranscript);
        }
      }
    }
    if (this._closed) return;
    if (this.scrollOffset > 0) {
      // User is reading history — don't disturb the visible window.
      // Just append silently; they'll see new lines once they scroll back.
      return;
    }
    // Always clear input bar and write content immediately so output
    // appears live. Only the *redraw* of the input bar is throttled.
    this._eraseInputBar();
    process.stdout.write(text + '\n');

    const now = Date.now();
    if (now - this._lastFrameAt < 50) {
      // Too soon — schedule a trailing redraw.
      this._pendingFrame = true;
      if (!this._frameTimer) {
        this._frameTimer = setTimeout(() => {
          this._frameTimer = null;
          if (this._pendingFrame && !this._closed) {
            this._pendingFrame = false;
            this._renderInputBar();
          }
        }, 50);
      }
      return;
    }
    this._renderInputBar();
  }

  /**
   * Fix 5 — force a redraw bypassing the throttle. Call after stream end
   * so the final frame always reflects the latest state (e.g. when
   * setSending(false) needs to immediately repaint).
   */
  _forceRedraw() {
    if (this._frameTimer) { clearTimeout(this._frameTimer); this._frameTimer = null; }
    this._pendingFrame = false;
    this._renderInputBar();
  }

  /** Print without appending to transcript (use for transient progress). */
  status(text) { this.print(text, { noAppend: true }); }

  /**
   * Sprint 2 — accumulate session usage from a completed chat/agent run.
   * `usage` is the {prompt, completion, total} shape returned by aiClient
   * (provider-normalised). Calls this with cost from runtime.costTracker
   * for the just-recorded line; if absent, we compute via priceOf().
   */
  recordUsage(usage, opts = {}) {
    if (!usage) return;
    const tokensIn  = Number(usage.prompt)     || 0;
    const tokensOut = Number(usage.completion) || 0;
    this.sessionStats.tokensIn  += tokensIn;
    this.sessionStats.tokensOut += tokensOut;
    if (opts.model) this.sessionStats.lastModel = opts.model;
    // Cost — explicit value wins; else best-effort lookup.
    if (typeof opts.costUsd === 'number' && !Number.isNaN(opts.costUsd)) {
      this.sessionStats.costUsd += opts.costUsd;
    } else {
      try {
        const { costUsd } = require('../../src/main/runtime/cost-tracker');
        const c = costUsd(opts.model || this.sessionStats.lastModel, usage);
        if (typeof c === 'number') this.sessionStats.costUsd += c;
      } catch (_) {}
    }
    // Status bar reads these on next render — force one now so the user
    // sees tokens/cost update the moment a reply finishes.
    if (process.stdin.isTTY && !this._closed) this._forceRedraw();
  }

  /** Disable raw mode + restore terminal, then call onExit. */
  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this._eraseInputBar();
      if (process.stdin.isTTY) {
        // Only emit mouseOff if we actually enabled mouse mode. On
        // terminals where we skipped mouseOn, emitting mouseOff would be
        // a no-op but would still write escape bytes to stdout right
        // before exit — best to be tidy.
        if (this._mouseEnabled) process.stdout.write(ANSI.mouseOff);
        process.stdout.write(ANSI.cursorShow);
        try { process.stdin.setRawMode(false); } catch (_) {}
      }
      if (this._onKey)  process.stdin.off('keypress', this._onKey);
      if (this._onData) process.stdin.off('data',     this._onData);
      if (this._onEnd)  process.stdin.off('end',      this._onEnd);
      process.stdin.pause();
    } catch (_) {}
    // Release the libuv keepalive timer so the process can finally exit.
    if (this._keepaliveInterval) {
      clearInterval(this._keepaliveInterval);
      this._keepaliveInterval = null;
    }
    // Clear any pending throttled redraw — it would re-paint after close.
    if (this._frameTimer) { clearTimeout(this._frameTimer); this._frameTimer = null; }
    // Sprint 2.3 — drop the idle timer so it can't fire after exit.
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (this.onExit) this.onExit();
  }

  /**
   * Sprint 2.3 — schedule (or re-schedule) the idle-art tick. Called from
   * key/mouse handlers and after every send so user activity keeps the
   * timer at bay. Disabled when art is suppressed, in non-TTY mode, or
   * while sending.
   */
  _resetIdleTimer() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    // Sprint 2.5 — any reset (keypress, mouse, send) means activity:
    // clear the "already showed art this idle window" flag so the next
    // genuine idle period can fire ONCE.
    this._idleShown = false;
    if (!this._idleEnabled || this._closed || !process.stdin.isTTY) return;
    if (process.env.HORIZON_NO_ART === '1') return;
    if (process.env.HORIZON_FAST === '1')   return;
    const tick = () => {
      this._idleTimer = null;
      if (this._idleShown) return;       // already nudged this window
      if (this._closed) return;
      // Don't drop art into mid-stream output, search overlay, scrollback
      // view, while sending, or while a sub-picker (interactiveMenu) has
      // paused the engine. The picker calls engine.pause() which
      // removes our key/data listeners — `_onKey == null` is the cheap
      // proxy that tells us we're in that state.
      if (this._sending || this.searchActive || this._scrollMode()
          || this._streamActive || !this._onKey) {
        // Hold off: re-check on next activity. Do NOT re-arm a timer —
        // _resetIdleTimer() will be called again the moment input
        // resumes.
        return;
      }
      // Sprint 2.6 — set the "already shown" guard BEFORE printing.
      // print() calls _renderInputBar() which used to be enough of a
      // detour that on some Windows hosts the libuv loop ran another
      // tick of the timer queue (or another stray data event reset the
      // timer mid-flight), and the art rendered twice. Setting the
      // guard FIRST closes that window — even if `tick` re-enters via
      // any mechanism, the early `if (this._idleShown) return` aborts.
      this._idleShown = true;
      try {
        const { renderArt } = require('./banner');
        const out = renderArt('idle');
        if (out) {
          // Print silently — uses normal print path so the art appears in
          // transcript and survives scroll/search.
          this.print('');
          for (const l of out.split('\n')) this.print(l);
        }
      } catch (_) {}
      // Intentionally do NOT schedule another timer here. We fire ONCE
      // per idle window; the next tick is armed when the user types,
      // scrolls, or otherwise interacts (which calls _resetIdleTimer()).
    };
    this._idleTimer = setTimeout(tick, this._idleAfterMs);
  }

  /** Briefly disable input handling (for sub-prompts via readline.question). */
  pause() {
    if (!process.stdin.isTTY) return;
    process.stdin.off('keypress', this._onKey);
    process.stdin.off('data', this._onData);
    if (this._mouseEnabled) process.stdout.write(ANSI.mouseOff);
    this._eraseInputBar();
  }
  resume() {
    if (!process.stdin.isTTY) return;
    // Re-prepend the data listener so it still runs BEFORE readline's
    // internal keypress decoder, preserving the mouse-strip ordering
    // that protects the composer.
    process.stdin.prependListener('data', this._onData);
    process.stdin.on('keypress', this._onKey);
    if (this._mouseEnabled) process.stdout.write(ANSI.mouseOn);
    this._renderInputBar();
  }

  /** Mark composer as "sending" so we ignore Enter until reply comes back. */
  setSending(on) {
    this._sending = !!on;
    // Fix 5 — force-redraw on completion so the final frame reflects state
    // even if a throttled token redraw was pending.
    if (!on && process.stdin.isTTY && !this._closed) this._forceRedraw();
  }

  // ── key handling ────────────────────────────────────────────────────
  _handleKey(ch, key) {
    if (!key) return;

    // Hotfix — drop mouse-sequence noise BEFORE any other handling.
    //
    // readline.emitKeypressEvents() does not understand SGR (?1006) or
    // legacy (?1000) mouse reports, so on some terminals it fragments
    // sequences like "\x1b[<0;43;51M" into multiple keypress events:
    //   - one event for "\x1b[<" with key.sequence holding the prefix
    //   - several events for "0", ";", "4", "3", ... emitted as plain
    //     printable characters that would otherwise be inserted into
    //     the composer.
    // We filter aggressively here. The mouse parser in _handleData has
    // already extracted any useful button/coord info from the raw buffer
    // (it runs first via prependListener), so dropping these events at
    // the keypress layer is safe — we lose nothing.
    if (key.sequence) {
      // SGR mouse — any sequence containing "\x1b[<" is a mouse event,
      // whether or not it has the full payload + terminator. Discard it.
      const isSgr    = key.sequence.indexOf('\x1b[<') >= 0;
      // Legacy mouse — "\x1b[M" followed by exactly 3 payload bytes.
      const isLegacy = /\x1b\[M.{3}/.test(key.sequence);
      if (isSgr || isLegacy) {
        // If the sequence carries the terminator we end the swallow state
        // here; otherwise stay armed for the fragmented payload chars
        // that readline will emit as follow-up keypress events.
        if (isSgr && /[Mm]/.test(key.sequence.slice(key.sequence.indexOf('\x1b[<') + 3))) {
          this._mouseSwallowUntil = false;
        } else if (isSgr) {
          this._mouseSwallowUntil = true;
        }
        // Mark a short "post-mouse" window so any trailing fragment
        // chars readline emits as separate keypress events get caught
        // by the secondary filter below. Sprint 2.6 — bumped from 100ms
        // to 250ms because Windows ConPTY sometimes delivers the payload
        // fragment hundreds of ms after the prefix.
        this._mouseSwallowDeadline = Date.now() + 250;
        return;
      }
    }
    // Sprint 2.5 — secondary filter. If we recently saw a mouse prefix
    // and a plain ASCII fragment of payload chars (digits/semis/M/m)
    // comes through within the post-mouse window, drop it. This catches
    // the case where readline buffers the FULL mouse sequence and then
    // re-emits the payload as a single multi-char `ch` AFTER the prefix
    // already passed.
    if (this._mouseSwallowUntil
        || (this._mouseSwallowDeadline && Date.now() < this._mouseSwallowDeadline)) {
      const c = (ch && typeof ch === 'string') ? ch : (key.sequence || '');
      // Allow Enter/Tab/etc through even mid-swallow; only filter the
      // SGR payload character set (digits, semicolons, lone M/m).
      if (c && SGR_MOUSE_PAYLOAD_RE.test(c)) {
        if (/[Mm]/.test(c)) {
          this._mouseSwallowUntil = false;
          this._mouseSwallowDeadline = 0;
        }
        return;
      }
      // Sprint 2.6 — Also drop short ASCII fragments that *contain* a
      // digit + semicolon (e.g. "0;43" by itself with no terminator yet),
      // which can arrive without the full SGR_MOUSE_PAYLOAD_RE match.
      if (c && /^[0-9;]+$/.test(c) && c.length <= 16) return;
      // Genuinely unexpected character — clear the swallow flag and let
      // this one through. Better one stray char than a stuck filter.
      this._mouseSwallowUntil = false;
      // Don't clear the deadline yet — the time-based window will lapse
      // naturally and gives the next stray fragment a chance to be caught.
    }

    // Sprint 2.3 — any keypress counts as activity; reset idle countdown.
    this._resetIdleTimer();
    // Global exits
    if (key.ctrl && key.name === 'c') { this._exit(); return; }
    if (key.ctrl && key.name === 'd' && this.lines[0] === '' && this.lines.length === 1) { this._exit(); return; }
    if (key.ctrl && key.name === 'l') { process.stdout.write(ANSI.clearScreen); this._renderInputBar(); return; }

    if (this.searchActive) return this._handleSearchKey(ch, key);

    // Scrollback navigation
    if (key.name === 'pageup' || (key.ctrl && key.name === 'b')) {
      this._scrollBy(-10); return;
    }
    if (key.name === 'pagedown' || (key.ctrl && key.name === 'f')) {
      if (key.ctrl && key.name === 'f' && !this._scrollMode()) {
        // Ctrl+F when not scrolling — open search
        this._beginSearch(); return;
      }
      this._scrollBy(10); return;
    }
    if (this._scrollMode()) {
      if (key.name === 'escape' || key.name === 'q') {
        this._exitScrollMode(); return;
      }
      // Up/Down in scroll mode scrolls one line at a time
      if (key.name === 'up')   { this._scrollBy(-1); return; }
      if (key.name === 'down') { this._scrollBy(1);  return; }
      return;
    }

    // History navigation (only when on first line, empty cursor)
    if (key.name === 'up'   && this.lines.length === 1 && this.history.length) {
      this._historyPrev(); return;
    }
    if (key.name === 'down' && this.lines.length === 1 && this.historyIdx >= 0) {
      this._historyNext(); return;
    }

    // Composer line navigation
    if (key.name === 'left')  { this._cursorLeft();  return; }
    if (key.name === 'right') { this._cursorRight(); return; }
    if (key.name === 'up'   && this.lineIdx > 0) { this.lineIdx--; this.col = Math.min(this.col, this.lines[this.lineIdx].length); this._renderInputBar(); return; }
    if (key.name === 'down' && this.lineIdx < this.lines.length - 1) { this.lineIdx++; this.col = Math.min(this.col, this.lines[this.lineIdx].length); this._renderInputBar(); return; }
    if (key.ctrl && key.name === 'a') { this.col = 0; this._renderInputBar(); return; }
    if (key.ctrl && key.name === 'e') { this.col = this.lines[this.lineIdx].length; this._renderInputBar(); return; }
    if (key.ctrl && key.name === 'u') { this.lines[this.lineIdx] = this.lines[this.lineIdx].slice(this.col); this.col = 0; this._renderInputBar(); return; }
    if (key.ctrl && key.name === 'k') { this.lines[this.lineIdx] = this.lines[this.lineIdx].slice(0, this.col); this._renderInputBar(); return; }
    if (key.ctrl && key.name === 'w') { this._deleteWordBack(); return; }

    if (key.name === 'backspace') { this._cancelCompletion(); this._backspace(); return; }
    if (key.name === 'delete')    { this._cancelCompletion(); this._delete(); return; }
    if (key.name === 'tab')       { this._autocomplete(); return; }

    // Fix 6 — Esc closes autocomplete menu if open
    if (key.name === 'escape' && this._completionHits) { this._cancelCompletion(); return; }

    if (key.name === 'return' || key.name === 'enter') {
      // Fix 6 — Enter accepts highlighted autocomplete if menu is open
      if (this._completionHits && this._completionHits.length > 1) {
        this._acceptCompletion();
        return;
      }
      // Shift+Enter = newline; Enter alone = submit
      if (key.shift || key.alt) { this._insertNewline(); return; }
      this._submit();
      return;
    }

    // Printable character
    if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch >= ' ') {
      this._cancelCompletion();
      this._insertChar(ch);
      return;
    }
    // Some terminals send multi-char paste in one chunk; handle that.
    // Hotfix — strip any embedded SGR / legacy mouse sequences before
    // inserting so a paste that arrives concatenated with a mouse event
    // doesn't smuggle escape bytes into the composer.
    if (ch && ch.length > 1 && !key.ctrl) {
      let cleaned = String(ch)
        .replace(SGR_MOUSE_RE, '')
        .replace(LEGACY_MOUSE_RE, '');
      // Reset the global regexes' lastIndex (they're stateful with /g).
      SGR_MOUSE_RE.lastIndex = 0;
      LEGACY_MOUSE_RE.lastIndex = 0;
      // Also drop any remaining ESC-introduced CSI debris.
      cleaned = cleaned.replace(/\x1b\[[<?]?[0-9;]*[A-Za-z~]/g, '');
      for (const c of cleaned) {
        if (c === '\r' || c === '\n') this._insertNewline();
        else if (c >= ' ') this._insertChar(c);
      }
    }
  }

  _handleSearchKey(ch, key) {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { this._endSearch(); return; }
    if (key.name === 'return' || key.name === 'enter') { this._jumpToMatch(this.searchPos); this._endSearch(); return; }
    if (key.name === 'backspace') {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this._refreshSearch(); return;
    }
    if (key.ctrl && (key.name === 'n')) { this._stepMatch(1); return; }
    if (key.ctrl && (key.name === 'p')) { this._stepMatch(-1); return; }
    if (ch && !key.ctrl && ch.length === 1 && ch >= ' ') {
      this.searchQuery += ch;
      this._refreshSearch();
    }
  }

  // ── mouse handling ──────────────────────────────────────────────────
  //
  // Runs as a prependListener on `data`, so we see the raw buffer BEFORE
  // readline's keypress decoder. Two jobs:
  //
  //   1. Parse SGR (?1006) and legacy (?1000) mouse sequences, dispatch
  //      them to _onMouse() for scroll-wheel + click handling.
  //   2. Detect the START of a partial SGR sequence ("\x1b[<" with no
  //      terminator yet in this chunk) and arm _mouseSwallowUntil so
  //      _handleKey drops the digits/semicolons readline will emit as
  //      individual keypress events. This is the core of the leak fix —
  //      without it those payload chars get inserted into the composer.
  _handleData(buf) {
    // Sprint 2.5 — byte-level streaming scanner.
    //
    // The previous regex-on-chunk approach failed on fragmentation:
    // when the terminal sent "\x1b[<0;43;51M" but it arrived as two
    // separate `data` events ("\x1b[<0;43" then "51M"), neither chunk
    // matched the full SGR regex and the payload digits leaked through
    // readline as plain keypress events. _mouseSwallowUntil caught
    // SOME of those but not all — especially when readline buffered
    // the whole fragment and then re-emitted it as a single multi-char
    // ch argument that bypassed the swallow filter.
    //
    // The fix below maintains a persistent `_dataBuffer` across chunks,
    // scans linearly for complete mouse sequences (SGR or legacy),
    // strips them, dispatches the parsed event, and keeps any
    // incomplete trailing sequence in the buffer for the next chunk.
    // Everything else stays in the buffer too — readline gets the
    // same stream of bytes it always did, just guaranteed mouse-free.
    let s;
    if (typeof buf === 'string') s = buf;
    else if (Buffer.isBuffer(buf)) s = buf.toString('binary');  // preserve bytes
    else return;

    if (!this._dataBuffer) this._dataBuffer = '';
    this._dataBuffer += s;

    // Scan from start. Each iteration either:
    //   (a) advances past a non-mouse byte, OR
    //   (b) consumes a complete mouse sequence (dispatches + strips), OR
    //   (c) sees a partial mouse sequence at the tail and stops,
    //       leaving it in _dataBuffer for the next chunk.
    let i = 0;
    let dropped = false;
    while (i < this._dataBuffer.length) {
      const c0 = this._dataBuffer.charCodeAt(i);
      // Fast path: not an ESC, definitely not a mouse sequence — keep
      // scanning. We don't strip these; readline will see them.
      if (c0 !== 0x1b) { i++; continue; }
      // ESC. Need at least "\x1b[" to be a CSI.
      if (i + 1 >= this._dataBuffer.length) break;       // wait for more
      if (this._dataBuffer.charCodeAt(i + 1) !== 0x5b) { // '['
        i++; continue;
      }
      if (i + 2 >= this._dataBuffer.length) break;
      const c2 = this._dataBuffer.charCodeAt(i + 2);
      // SGR mouse: \x1b[<NNN;NNN;NNN(M|m)
      if (c2 === 0x3c) { // '<'
        let j = i + 3;
        while (j < this._dataBuffer.length) {
          const ch = this._dataBuffer.charCodeAt(j);
          if (ch === 0x4d || ch === 0x6d) break;        // M or m
          // SGR payload is digits + semicolons. Anything else means the
          // sequence is malformed; bail and let it leak (better than
          // hanging forever on a junk byte).
          if (!((ch >= 0x30 && ch <= 0x39) || ch === 0x3b)) {
            j = -1; break;
          }
          j++;
        }
        if (j < 0) {
          // Malformed — keep moving past the ESC.
          i++; continue;
        }
        if (j >= this._dataBuffer.length) {
          // Incomplete — preserve and wait for next chunk.
          break;
        }
        // Complete — parse, dispatch, strip.
        const seq = this._dataBuffer.slice(i, j + 1);
        const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(seq);
        if (m) {
          this._mouseSeen = true;
          const button  = parseInt(m[1], 10);
          const col     = parseInt(m[2], 10);
          const row     = parseInt(m[3], 10);
          const isPress = m[4] === 'M';
          this._onMouse(button, col, row, isPress);
        }
        // Splice the sequence out of _dataBuffer in place.
        this._dataBuffer = this._dataBuffer.slice(0, i) + this._dataBuffer.slice(j + 1);
        dropped = true;
        // Don't advance i — the next byte just moved into this slot.
        continue;
      }
      // Legacy mouse: \x1b[M<btn><col><row> — exactly 3 payload bytes.
      if (c2 === 0x4d) { // 'M'
        if (i + 5 >= this._dataBuffer.length) break;     // wait for more
        const btn  = this._dataBuffer.charCodeAt(i + 3) - 32;
        const col  = this._dataBuffer.charCodeAt(i + 4) - 32;
        const row  = this._dataBuffer.charCodeAt(i + 5) - 32;
        const isPress = (btn & 3) !== 3;
        this._mouseSeen = true;
        this._onMouse(btn, col, row, isPress);
        this._dataBuffer = this._dataBuffer.slice(0, i) + this._dataBuffer.slice(i + 6);
        dropped = true;
        continue;
      }
      // Some other CSI — leave it for readline's keypress decoder.
      i++;
    }

    // Safety cap: don't let an unterminated sequence pin memory if a
    // misbehaving terminal floods garbage. 8 KB is comically large for
    // a single CSI; if we see more without a terminator, drop the lot.
    if (this._dataBuffer.length > 8192) {
      this._dataBuffer = this._dataBuffer.slice(-1024);
    }

    // If we stripped anything, we set _mouseSwallowUntil as a belt-and-
    // suspenders measure so any readline-fragmented payload that DID
    // sneak through (some terminals double-buffer the data event AND
    // re-emit through readline) still gets caught by _handleKey.
    if (dropped) {
      this._mouseSwallowUntil = true;
      this._mouseSwallowDeadline = Date.now() + 250;
    }

    // Detect trailing partial SGR — readline may still receive raw
    // bytes after our scan (Node delivers data to all listeners with
    // the original buffer; we only mutate our internal copy). Arm the
    // swallow flag if there's an unterminated "\x1b[<" near the tail.
    const lastOpen = s.lastIndexOf('\x1b[<');
    if (lastOpen >= 0) {
      const tail = s.slice(lastOpen);
      if (!/[Mm]/.test(tail)) {
        this._mouseSwallowUntil = true;
        this._mouseSwallowDeadline = Date.now() + 250;
      }
    }
    // Sprint 2.6 — also check our internal persistent buffer for partial
    // SGR. The byte-level scan may have left an unterminated "\x1b[<…"
    // at the buffer tail (waiting for the rest in the next chunk); arm
    // the swallow flag so any payload fragment that arrives via readline
    // before the next data chunk lands in _handleData gets dropped.
    if (this._dataBuffer && this._dataBuffer.indexOf('\x1b[<') >= 0) {
      this._mouseSwallowUntil = true;
      this._mouseSwallowDeadline = Date.now() + 250;
    }
  }

  _onMouse(button, col, row, isPress) {
    // SGR button encoding:
    //   0=left, 1=middle, 2=right, 64=scroll up, 65=scroll down
    //   add 32 for drag/move
    if (!isPress) return;
    // Sprint 2.3 — mouse counts as activity; reset idle countdown.
    this._resetIdleTimer();
    if (button === 64) { this._scrollBy(-3); return; }
    if (button === 65) { this._scrollBy(3);  return; }
    // Click anywhere → ensure input bar is active (no real focus model in
    // our single-panel UI, but we can reset scroll to 0 to bring user
    // back to live view).
    if (button === 0 && this.scrollOffset > 0) {
      this._exitScrollMode();
    }
  }

  // ── composer ops ────────────────────────────────────────────────────
  _insertChar(ch) {
    const line = this.lines[this.lineIdx];
    this.lines[this.lineIdx] = line.slice(0, this.col) + ch + line.slice(this.col);
    this.col++;
    this._renderInputBar();
  }
  _insertNewline() {
    const line = this.lines[this.lineIdx];
    const left = line.slice(0, this.col);
    const right = line.slice(this.col);
    this.lines[this.lineIdx] = left;
    this.lines.splice(this.lineIdx + 1, 0, right);
    this.lineIdx++;
    this.col = 0;
    this._renderInputBar();
  }
  _backspace() {
    if (this.col > 0) {
      const line = this.lines[this.lineIdx];
      this.lines[this.lineIdx] = line.slice(0, this.col - 1) + line.slice(this.col);
      this.col--;
    } else if (this.lineIdx > 0) {
      const cur = this.lines[this.lineIdx];
      this.col = this.lines[this.lineIdx - 1].length;
      this.lines[this.lineIdx - 1] += cur;
      this.lines.splice(this.lineIdx, 1);
      this.lineIdx--;
    }
    this._renderInputBar();
  }
  _delete() {
    const line = this.lines[this.lineIdx];
    if (this.col < line.length) {
      this.lines[this.lineIdx] = line.slice(0, this.col) + line.slice(this.col + 1);
    } else if (this.lineIdx < this.lines.length - 1) {
      this.lines[this.lineIdx] += this.lines[this.lineIdx + 1];
      this.lines.splice(this.lineIdx + 1, 1);
    }
    this._renderInputBar();
  }
  _deleteWordBack() {
    const line = this.lines[this.lineIdx];
    let i = this.col;
    while (i > 0 && /\s/.test(line[i - 1])) i--;
    while (i > 0 && !/\s/.test(line[i - 1])) i--;
    this.lines[this.lineIdx] = line.slice(0, i) + line.slice(this.col);
    this.col = i;
    this._renderInputBar();
  }
  _cursorLeft() {
    if (this.col > 0) this.col--;
    else if (this.lineIdx > 0) { this.lineIdx--; this.col = this.lines[this.lineIdx].length; }
    this._renderInputBar();
  }
  _cursorRight() {
    const line = this.lines[this.lineIdx];
    if (this.col < line.length) this.col++;
    else if (this.lineIdx < this.lines.length - 1) { this.lineIdx++; this.col = 0; }
    this._renderInputBar();
  }
  /**
   * Fix 6 — floating autocomplete menu.
   * Tab on a new prefix: compute hits, show menu with first highlighted.
   * Tab while menu is open: cycle highlight.
   * Enter while menu is open: accept highlighted.
   * Esc closes the menu (handled in _handleKey).
   * Single-hit case still completes immediately (no menu needed).
   */
  _autocomplete() {
    if (!this.completer) return;
    const line = this.lines[this.lineIdx];
    const before = line.slice(0, this.col);
    const after  = line.slice(this.col);
    // If menu is already open and prefix matches, cycle.
    if (this._completionHits && this._completionHits.length > 1
        && before === this._completionPrefix) {
      this._completionIdx = (this._completionIdx + 1) % this._completionHits.length;
      this._renderInputBar();
      return;
    }
    const [hits] = this.completer(before);
    if (!hits || !hits.length) {
      this._completionHits = null;
      this._renderInputBar();
      return;
    }
    if (hits.length === 1) {
      this.lines[this.lineIdx] = hits[0] + after;
      this.col = hits[0].length;
      this._completionHits = null;
      this._renderInputBar();
      return;
    }
    // Multiple — open the floating menu.
    this._completionHits = hits;
    this._completionIdx = 0;
    this._completionPrefix = before;
    this._renderInputBar();
  }

  _acceptCompletion() {
    if (!this._completionHits || !this._completionHits.length) return false;
    const picked = this._completionHits[this._completionIdx] || this._completionHits[0];
    const line = this.lines[this.lineIdx];
    const after = line.slice(this.col);
    this.lines[this.lineIdx] = picked + after;
    this.col = picked.length;
    this._completionHits = null;
    this._renderInputBar();
    return true;
  }

  _cancelCompletion() {
    if (!this._completionHits) return false;
    this._completionHits = null;
    this._renderInputBar();
    return true;
  }
  _submit() {
    if (this._sending) return;
    const text = this.lines.join('\n').trim();
    if (!text) return;
    this.history.push(text);
    if (this.history.length > 200) this.history.shift();
    this.historyIdx = -1;
    this.lines = [''];
    this.lineIdx = 0;
    this.col = 0;
    this._eraseInputBar();
    this.onLine(text);
    if (!this._closed) this._renderInputBar();
    // Sprint 2.3 — a fresh send restarts the idle countdown.
    this._resetIdleTimer();
  }

  // ── history ─────────────────────────────────────────────────────────
  _historyPrev() {
    if (this.historyIdx === -1) this.historyIdx = this.history.length - 1;
    else if (this.historyIdx > 0) this.historyIdx--;
    const item = this.history[this.historyIdx];
    if (item != null) {
      this.lines = item.split('\n');
      this.lineIdx = 0;
      this.col = this.lines[0].length;
      this._renderInputBar();
    }
  }
  _historyNext() {
    if (this.historyIdx < 0) return;
    this.historyIdx++;
    if (this.historyIdx >= this.history.length) {
      this.historyIdx = -1;
      this.lines = [''];
    } else {
      this.lines = this.history[this.historyIdx].split('\n');
    }
    this.lineIdx = 0;
    this.col = this.lines[0]?.length || 0;
    this._renderInputBar();
  }

  // ── search ──────────────────────────────────────────────────────────
  _beginSearch() {
    this.searchActive = true;
    this.searchQuery = '';
    this.searchMatches = [];
    this.searchPos = 0;
    this._renderInputBar();
  }
  _endSearch() {
    this.searchActive = false;
    this.searchQuery = '';
    this.searchMatches = [];
    this._renderInputBar();
  }
  _refreshSearch() {
    const q = this.searchQuery.toLowerCase();
    if (!q) { this.searchMatches = []; this._renderInputBar(); return; }
    this.searchMatches = [];
    for (let i = 0; i < this.transcript.length; i++) {
      if (this.transcript[i].toLowerCase().includes(q)) {
        this.searchMatches.push(i);
      }
    }
    this.searchPos = Math.max(0, this.searchMatches.length - 1);
    this._renderInputBar();
  }
  _stepMatch(delta) {
    if (!this.searchMatches.length) return;
    this.searchPos = (this.searchPos + delta + this.searchMatches.length) % this.searchMatches.length;
    this._renderInputBar();
  }
  _jumpToMatch(pos) {
    if (!this.searchMatches.length) return;
    const lineIdx = this.searchMatches[pos];
    // Show that match and a few lines of context
    this._eraseInputBar();
    process.stdout.write(fmt.dim('─── match ───') + '\n');
    const start = Math.max(0, lineIdx - 2);
    const end = Math.min(this.transcript.length, lineIdx + 3);
    for (let i = start; i < end; i++) {
      const prefix = i === lineIdx ? fmt.green('→ ') : '  ';
      process.stdout.write(prefix + this.transcript[i] + '\n');
    }
    process.stdout.write(fmt.dim('─────────────') + '\n');
    this._renderInputBar();
  }

  // ── scrollback ──────────────────────────────────────────────────────
  _scrollMode() { return this.scrollOffset > 0; }
  _scrollBy(delta) {
    const oldOffset = this.scrollOffset;
    this.scrollOffset = Math.max(0, Math.min(this.transcript.length, this.scrollOffset + delta));
    if (this.scrollOffset === oldOffset) return;
    if (this.scrollOffset === 0) { this._exitScrollMode(); return; }
    // Entering or staying in scroll mode — paint history window.
    this._paintScrollView();
  }
  _exitScrollMode() {
    this.scrollOffset = 0;
    process.stdout.write(ANSI.clearScreen);
    // Replay the last `windowHeight - 2` lines of transcript so live view returns
    const h = (process.stdout.rows || 24) - 2;
    const start = Math.max(0, this.transcript.length - h);
    for (let i = start; i < this.transcript.length; i++) {
      process.stdout.write(this.transcript[i] + '\n');
    }
    this._renderInputBar();
  }
  _paintScrollView() {
    const h = (process.stdout.rows || 24) - 3;
    const end = this.transcript.length - this.scrollOffset;
    const start = Math.max(0, end - h);
    process.stdout.write(ANSI.clearScreen);
    for (let i = start; i < end; i++) {
      process.stdout.write(this.transcript[i] + '\n');
    }
    const tag = fmt.yellow(`── scrollback · ${this.scrollOffset} lines back · ↑↓ PgUp/PgDn to move · Esc to return ──`);
    process.stdout.write(tag + '\n');
  }

  // ── rendering input bar ─────────────────────────────────────────────
  _eraseInputBar() {
    if (!process.stdin.isTTY || this._closed) return;
    if (this._lastDrawHeight > 0) {
      // Move up to start of input bar and clear N lines
      process.stdout.write(ANSI.cursorLeft(9999));
      for (let i = 0; i < this._lastDrawHeight; i++) {
        process.stdout.write(ANSI.clearLine);
        if (i < this._lastDrawHeight - 1) process.stdout.write(ANSI.cursorUp(1));
      }
    }
    this._lastDrawHeight = 0;
  }

  /**
   * Sprint 2 — Hermes-grade status bar v2.
   *
   * Full (≥100 cols):
   *   ⌁ <prov>:<model> · <persona> · <tokens>/<ctx> · [████░░░] <pct>% · $<cost> · <mm:ss>
   * Medium (70–99 cols):
   *   ⌁ <prov>:<model> · <persona> · <tokens>/<ctx> · [████░░] <pct>% · $<cost>
   * Narrow (<70 cols):
   *   ⌁ <prov>:<model> · <persona> · <pct>%
   *
   * Bar fill colour by % of context used:
   *   <50% green, 50–80% yellow, 80–95% warn/orange, ≥95% red.
   */
  _statusLine() {
    const rt = this.runtime;
    if (!rt || !rt.settingsStore) return '';

    let provider = '—', persona = '—', modelName = '';
    try {
      provider = rt.settingsStore.get('provider') || 'gemini';
      persona = rt.settingsStore.get('persona') || 'jarvis';
      modelName = this.sessionStats.lastModel
        || rt.settingsStore.get('model.' + provider)
        || '';
    } catch (_) {}

    const modelShort = modelName ? String(modelName).split('/').pop().slice(0, 28) : '';
    const modelStr   = modelShort ? (':' + modelShort) : '';

    // Token usage + context window
    const used = this.sessionStats.tokensIn + this.sessionStats.tokensOut;
    const ctxMax = ctxFor(modelName);
    const pct = ctxMax > 0 ? Math.min(100, (used / ctxMax) * 100) : 0;

    // Format tokens compactly: 12.4K / 200K
    const fmtTokens = (n) => {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
      return String(n);
    };
    const tokensStr = `${fmtTokens(used)}/${fmtTokens(ctxMax)}`;

    // Session time mm:ss (≥1h shows h:mm:ss)
    const elapsed = Math.floor((Date.now() - this._sessionStartMs) / 1000);
    let timeStr;
    if (elapsed >= 3600) {
      const hh = Math.floor(elapsed / 3600);
      const mm = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      timeStr = `${hh}:${mm}:${ss}`;
    } else {
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      timeStr = `${mm}:${ss}`;
    }

    // Cost — combine THIS-SESSION accumulator with persisted today's spend.
    // sessionStats wins when non-zero; else fall back to costTracker.summary({days:1}).
    let costUsd = this.sessionStats.costUsd || 0;
    if (!costUsd) {
      try {
        if (rt.costTracker && typeof rt.costTracker.summary === 'function') {
          const s = rt.costTracker.summary({ days: 1 });
          costUsd = (s?.totals?.costUsd) || 0;
        }
      } catch (_) {}
    }
    const costStr = costUsd > 0
      ? '$' + (costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2))
      : '$0.00';

    // Bar render: 10-cell wide for full mode, 6-cell for medium.
    const cols = process.stdout.columns || 80;
    const wantFull   = cols >= 100;
    const wantMedium = cols >= 70 && cols < 100;
    const barCells = wantFull ? 10 : 6;
    const filled = Math.max(0, Math.min(barCells, Math.round((pct / 100) * barCells)));
    const empty = barCells - filled;
    const barRaw = '█'.repeat(filled) + '░'.repeat(empty);

    // Colour by usage
    let barFn;
    if (pct >= 95) barFn = fmt.red;
    else if (pct >= 80) barFn = fmt.yellow;   // warn (orange) — yellow is closest in default palette
    else if (pct >= 50) barFn = fmt.yellow;
    else barFn = fmt.green;
    const barColored = barFn(barRaw);
    const pctStr = pct >= 10 ? Math.round(pct) + '%' : pct.toFixed(1) + '%';

    const SEP = fmt.dim(' · ');
    const head = fmt.cyan('⌁ ') + fmt.bold(provider + modelStr);
    const personaPart = fmt.cyan(persona);

    if (!wantFull && !wantMedium) {
      // Narrow: prov:model · persona · pct%
      return head + SEP + personaPart + SEP + barFn(pctStr);
    }

    const parts = [head, personaPart, fmt.dim(tokensStr), '[' + barColored + '] ' + barFn(pctStr), fmt.green(costStr)];
    if (wantFull) parts.push(fmt.dim(timeStr));
    return parts.join(SEP);
  }

  _renderInputBar() {
    if (!process.stdin.isTTY || this._closed) return;
    this._eraseInputBar();
    this._lastFrameAt = Date.now();

    if (this.searchActive) {
      // Single-line: " 🔍 query · 3/12 matches "
      const total = this.searchMatches.length;
      const pos = total ? (this.searchPos + 1) + '/' + total : '';
      const bar = fmt.cyan('🔍 ') + fmt.bold(this.searchQuery) + fmt.dim('  ' + pos + ' · Enter=jump · Ctrl+N/P=next/prev · Esc=cancel');
      process.stdout.write(bar);
      this._lastDrawHeight = 1;
      return;
    }

    if (this._sending) {
      // Show status line above the sending indicator if runtime is set.
      const status = this._statusLine();
      let height = 0;
      if (status) { process.stdout.write(status + '\n'); height++; }
      const bar = fmt.dim('  …sending — press Ctrl+C to interrupt');
      process.stdout.write(bar);
      this._lastDrawHeight = height + 1;
      return;
    }

    // Fix 6 — floating autocomplete menu above composer
    let menuHeight = 0;
    if (this._completionHits && this._completionHits.length > 1) {
      const hits = this._completionHits.slice(0, 6);
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        const desc = SLASH_DESCRIPTIONS[h] || '';
        const padded = h.padEnd(16);
        let line;
        if (i === this._completionIdx) {
          // Highlighted row — bright text on dim bg
          line = '\x1b[48;5;235m\x1b[97m  ' + padded + '  ' + (desc ? '\x1b[2m' + desc + '\x1b[22m' : '') + '\x1b[0m';
        } else {
          line = '  ' + fmt.cyan(padded) + '  ' + (desc ? fmt.dim(desc) : '');
        }
        process.stdout.write(line + '\n');
        menuHeight++;
      }
      // Footer hint
      process.stdout.write(fmt.dim('  Tab=next · Enter=accept · Esc=cancel') + '\n');
      menuHeight++;
    }

    // Status line (above composer)
    const status = this._statusLine();
    let statusHeight = 0;
    if (status) { process.stdout.write(status + '\n'); statusHeight++; }

    // Sprint 2 — slash live hint above composer (single dim line).
    // Only render when:
    //   - user is single-line, on the first line, starts with `/`
    //   - the floating Tab-menu is NOT already open (would duplicate)
    //   - at least one command matches the prefix
    const hintLine = (!this._completionHits || this._completionHits.length <= 1)
      ? this._renderSlashHint(this.lines[0] || '')
      : '';
    let hintHeight = 0;
    if (hintLine) { process.stdout.write(hintLine + '\n'); hintHeight++; }

    // Composer — print each line. Sprint 2: if the composer is empty and
    // we're on the only line, render a dim placeholder after the prompt.
    // Sprint 2.1 — placeholder now uses a labeled-input look:
    //   ▌ Type a message · /help for commands
    // The accent-coloured "▌" matches the user-echo caption, signalling
    // "this is where you type". The legacy "░░░" dotted style was hard
    // to read and didn't anchor the eye to the prompt.
    const lineCount = this.lines.length;
    const placeholderActive = lineCount === 1 && this.lines[0].length === 0;
    for (let i = 0; i < lineCount; i++) {
      const prefix = i === 0 ? fmt.cyan(PROMPT) : fmt.dim('  ');
      if (i === 0 && placeholderActive) {
        process.stdout.write(prefix + fmt.cyan('▌ ') + fmt.dim('Type a message · /help for commands'));
      } else {
        process.stdout.write(prefix + this.lines[i]);
      }
      if (i < lineCount - 1) process.stdout.write('\n');
    }
    this._lastDrawHeight = menuHeight + statusHeight + hintHeight + lineCount;

    // Position cursor on (lineIdx, col)
    if (this.lineIdx < lineCount - 1) {
      // Move cursor up to the active line
      process.stdout.write(ANSI.cursorUp(lineCount - 1 - this.lineIdx));
    }
    process.stdout.write(ANSI.cursorLeft(9999));
    process.stdout.write(ANSI.cursorRight(this.col + (this.lineIdx === 0 ? PROMPT.length : 2)));
  }

  /**
   * Sprint 2 — compute the live slash-command hint line.
   * Returns a single dim-styled string, or '' to indicate "no hint".
   * Behavior:
   *   - empty input or non-slash → ''
   *   - just '/' alone → show first 3 commands as a teaser
   *   - prefix matches one command → "<cmd>  —  <description>"
   *   - prefix matches multiple → first 3 separated by "  ·  "
   *   - no match → '' (the line vanishes)
   * Truncated at terminal width - 4 to avoid wrapping mess.
   */
  _renderSlashHint(input) {
    if (!input || !input.startsWith('/')) return '';
    // Match by prefix against the canonical slash list.
    const matches = SLASH_HINT_KEYS.filter(k => k.startsWith(input));
    if (!matches.length) return '';
    const width = (process.stdout.columns || 80) - 4;
    let body;
    if (matches.length === 1) {
      const cmd = matches[0];
      body = cmd + '  —  ' + (SLASH_HINTS[cmd] || '');
    } else {
      // First 3 — name only if more than one match (description would be too noisy)
      body = matches.slice(0, 3).join('  ·  ');
      if (matches.length > 3) body += '  · …';
    }
    if (body.length > width) body = body.slice(0, Math.max(0, width - 1)) + '…';
    return fmt.dim(body);
  }

  // ── Sprint 2 — streaming markdown rendering ─────────────────────────
  // Three-phase API:
  //   startStreamingMessage(prefix) → reserve a region just above the
  //     input bar and write the prefix (and optional turn divider). The
  //     region grows in place as updates arrive.
  //   updateStreamingMessage(buf) → re-render markdown for the full buf
  //     and OVERWRITE the previous rendered region in place using a
  //     cursor-up + erase-to-end + emit pattern. The input bar / status
  //     line is NOT redrawn between updates — only restored on finish.
  //   finishStreamingMessage() → flush the final render, append a
  //     blank separator to transcript, and repaint the input bar.
  //
  // CRITICAL fix vs. the original (pre-fix) Sprint 2 implementation:
  //   The old code issued `\x1b[2J\x1b[H` + full repaint on every update
  //   tick. `\x1b[2J` clears the visible viewport but the previous frame
  //   has already scrolled into the terminal's scrollback buffer. With
  //   the status line drawn at the bottom of every frame, 30 token
  //   batches → 30 status lines stacked in scrollback. The fix below
  //   uses an in-place delta update: cursor up over what we last drew,
  //   erase to end of screen, then emit the new rendered text. Nothing
  //   scrolls; nothing duplicates.
  //
  // Implementation notes:
  //   - `_streamLinesOnScreen` is the number of physical rows the
  //     current rendered streaming region occupies in the terminal, NOT
  //     including the input bar. We move the cursor up by this many
  //     rows before re-emitting.
  //   - We approximate "physical rows" as the number of '\n' in the
  //     rendered output + 1 (assumes no terminal-side word-wrap). For
  //     typical chat replies (no long-line content) this is accurate.
  //   - The transcript array stays in sync (truncated + repushed) so
  //     search / scrollback see the most recent rendered state.
  //   - Non-TTY path: just append rendered lines to stdout (no cursor
  //     movement makes sense without a terminal).
  //   - If user is scrolled back, we update the transcript only and
  //     leave the screen alone — they'll see the final state on return.

  startStreamingMessage(prefix = '') {
    this._streamPrefix = prefix || '';
    this._streamActive = true;
    this._streamLinesOnScreen = 0;

    // Sprint 2.1 — turn separator + caption above the streaming reply.
    // Layout we want above the streaming body:
    //   ────                  ← faint divider (turn separator)
    //   ⌁ horizon · 14:32     ← assistant caption with timestamp
    //   <streamed body>       ← updateStreamingMessage() rewrites this
    //   …status bar / composer…
    //
    // We use print() so the lines land in transcript AND get drawn to
    // stdout in one shot. Then we record _streamStart at the position
    // immediately AFTER the caption so updates only rewrite the body —
    // the divider + caption stay fixed for the entire reply.
    const _now = new Date();
    const _ts = String(_now.getHours()).padStart(2, '0') + ':'
              + String(_now.getMinutes()).padStart(2, '0');
    const divider = fmt.dim('  ────');
    const caption = fmt.cyan('⌁ ') + fmt.bold('horizon') + ' ' + fmt.dim('· ' + _ts);
    if (process.stdin.isTTY && !this._closed && this.scrollOffset === 0) {
      this.print(divider);
      this.print(caption);
    } else {
      this.transcript.push(divider);
      this.transcript.push(caption);
    }
    this._streamStart = this.transcript.length;
    // Drop the input bar from the bottom so updates flow right under
    // the caption. The bar will be restored on finish.
    if (process.stdin.isTTY && !this._closed && this.scrollOffset === 0) {
      this._eraseInputBar();
    }
  }

  /**
   * @param {string} rawMarkdown - the full accumulated markdown so far
   * @param {object} opts
   *   - markdown:  if false, skip renderMarkdown() and use raw text
   */
  updateStreamingMessage(rawMarkdown, opts = {}) {
    if (!this._streamActive || this._streamStart < 0) return;
    // Lazy require to avoid a circular dep risk at module load.
    let rendered;
    if (opts.markdown === false) {
      rendered = String(rawMarkdown || '');
    } else {
      try {
        const { renderMarkdown } = require('./markdown');
        rendered = renderMarkdown(String(rawMarkdown || ''));
      } catch (_) {
        rendered = String(rawMarkdown || '');
      }
    }
    const parts = rendered.split('\n');
    const firstLine = this._streamPrefix + (parts[0] || '');
    const restLines = parts.slice(1);
    // Update transcript array (search / scrollback see the latest state).
    // _streamStart points to the first body row — the divider + caption
    // emitted by startStreamingMessage() live BEFORE _streamStart and
    // stay untouched across updates.
    this.transcript.length = this._streamStart;
    this.transcript.push(firstLine);
    for (const l of restLines) this.transcript.push(l);

    // If user is scrolled back or we're closed, transcript-only update.
    if (this._closed || this.scrollOffset > 0) return;
    if (!process.stdin.isTTY) {
      // Non-TTY path — straight append. Old rendered chunks remain in
      // stdout history but that's fine; the consumer sees the latest
      // line on each update.
      process.stdout.write(firstLine + '\n');
      for (const l of restLines) process.stdout.write(l + '\n');
      return;
    }
    // TTY path — delta update. Move cursor up over the previously
    // rendered region, erase to end of screen, then emit the new lines.
    // The status bar / composer are intentionally NOT redrawn here;
    // they'll be restored once on finishStreamingMessage().
    //
    // After the previous update the cursor sits at the END of the last
    // emitted line (we did NOT emit a trailing newline). To return to
    // col 0 of the FIRST emitted line, we cursor up by (linesOnScreen
    // - 1) rows then cursor-left to column 0. On the very first update
    // (_streamLinesOnScreen === 0) there's nothing to rewind over.
    process.stdout.write(ANSI.cursorLeft(9999));
    if (this._streamLinesOnScreen > 1) {
      process.stdout.write(ANSI.cursorUp(this._streamLinesOnScreen - 1));
    }
    // Erase from cursor to end of screen. \x1b[J = clear from cursor
    // down. This removes the previous rendered streaming region and
    // any leftover input bar lines.
    process.stdout.write('\x1b[J');

    // Emit the freshly rendered lines. We append a dim ellipsis tail to
    // signal "more coming" — removed on finishStreamingMessage(). We
    // do NOT emit a trailing newline; the cursor stays on the last
    // content row so the next update can rewind cleanly.
    process.stdout.write(firstLine);
    let physRows = 1;
    for (const l of restLines) {
      process.stdout.write('\n' + l);
      physRows++;
    }
    process.stdout.write(fmt.dim(' …'));
    // Track physical rows for the next cursor-up calculation.
    this._streamLinesOnScreen = physRows;
    // We have NOT redrawn the input bar — it will be restored by
    // finishStreamingMessage(). _lastDrawHeight is now stale; reset it
    // so the next _eraseInputBar() doesn't try to walk over our
    // streaming region.
    this._lastDrawHeight = 0;
  }

  finishStreamingMessage() {
    if (!this._streamActive) return;
    // Append a blank separator line so the next print() doesn't butt up
    // against the rendered message.
    this.transcript.push('');
    if (!this._closed && process.stdin.isTTY && this.scrollOffset === 0) {
      // We're sitting at the end of the last rendered streaming line
      // (with a trailing dim "…"). Strip the indicator by rewinding to
      // column 0 of that row, erasing to end-of-line, then re-emitting
      // the last line cleanly. Then emit a trailing newline + restore
      // the input bar via a single full _renderInputBar() pass.
      //
      // Trick: we know what the last rendered line was — it's the final
      // entry in transcript before the blank separator we just pushed.
      // We splice it out and re-emit. But this is fragile if the line
      // is multi-physical-row from wrapping; simpler approach is to
      // just emit a newline and let the "…" remain as a faint footer
      // marker. We do the simple thing.
      process.stdout.write(ANSI.cursorLeft(9999));
      // Erase end-of-line (the "…" tail).
      process.stdout.write('\x1b[K');
      // Re-emit the final rendered last line WITHOUT the ellipsis to
      // leave a clean final frame.
      const lastIdx = this.transcript.length - 2; // -1 is blank, -2 is last content
      if (lastIdx >= 0 && lastIdx >= this._streamStart) {
        process.stdout.write(this.transcript[lastIdx]);
      }
      process.stdout.write('\n');
      this._renderInputBar();
    }
    this._streamActive = false;
    this._streamStart = -1;
    this._streamPrefix = '';
    this._streamLinesOnScreen = 0;
  }

  // ── exit / fallback ─────────────────────────────────────────────────
  _exit() {
    this.close();
    process.stdout.write('\n');
    process.exit(0);
  }
  _installExit() {
    const cleanup = () => { try { this.close(); } catch (_) {} };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });
    process.on('uncaughtException', (e) => {
      cleanup();
      process.stderr.write('\n' + fmt.red('uncaught: ' + e.message) + '\n');
      process.exit(1);
    });
  }

  _fallbackPlainMode() {
    // v0.0.2 — plain readline path for non-TTY stdin OR when raw mode
    // can't be entered (typical on pkg-bundled binaries running in
    // certain Windows terminal hosts). This mode loses the multi-line
    // composer, mouse, history navigation, and search overlay, but
    // the user gets a working chat loop with the same slash commands.
    //
    // Visible prompt + welcome line so users don't sit at a blank
    // screen wondering what to type — that was the v0.0.1 trap.
    //
    // v0.0.3 — keep the libuv loop alive even if readline silently
    // closes on Windows ConPTY for pkg-bundled binaries. The
    // `_keepaliveInterval` is set in start() before we get here.
    if (!this._keepaliveInterval) {
      this._keepaliveInterval = setInterval(() => {}, 30000);
    }
    if (this._verbose) {
      process.stderr.write('[tui] mode: PLAIN (readline fallback)\n');
      process.stderr.write('[tui] keepalive=' + (this._keepaliveInterval ? 'on' : 'off') + '\n');
    }

    this._installExit();

    process.stdout.write('\n\x1b[97mPlain-mode TUI active\x1b[0m \x1b[90m(raw input unavailable on this terminal — type your message and press Enter; /quit to exit, /help for commands).\x1b[0m\n\n');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '\x1b[36m›\x1b[0m ',
      terminal: false,  // makes readline echo input + handle Ctrl+C cleanly
    });
    this._rl = rl;
    rl.prompt();
    rl.on('line', async (l) => {
      try { await this.onLine(l); }
      catch (e) { process.stdout.write('\x1b[31merror:\x1b[0m ' + (e?.message || String(e)) + '\n'); }
      if (!this._closed) rl.prompt();
    });
    rl.on('close', () => {
      // Some Windows terminals fire 'close' spuriously at startup
      // before any user input. Only treat it as exit if we've actually
      // been running long enough to have processed something, OR if
      // the engine was explicitly closed.
      if (this._closed) return;
      process.stdout.write('\n\x1b[90mGoodbye.\x1b[0m\n');
      this._exit();
    });
  }
}

module.exports = { TuiEngine, ANSI };
