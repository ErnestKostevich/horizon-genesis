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

const PROMPT = '› ';

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
    const canRaw = !!(process.stdin.isTTY && typeof process.stdin.setRawMode === 'function');
    if (!canRaw) {
      this._fallbackPlainMode();
      return;
    }
    try {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
    } catch (e) {
      process.stderr.write('\n(tui) raw-mode unavailable (' + e.message + ') — falling back to plain readline.\n');
      this._fallbackPlainMode();
      return;
    }
    process.stdout.write(ANSI.mouseOn);

    this._onKey = (ch, key) => this._handleKey(ch, key);
    this._onData = (buf) => this._handleData(buf);
    process.stdin.on('keypress', this._onKey);
    process.stdin.on('data', this._onData);

    this._installExit();
    setTimeout(() => {
      if (!this._mouseSeen && !this._closed) {
        // No mouse events received — likely a terminal without forwarding.
        // We don't disable anything; just remember for status display.
      }
    }, 2000);

    this._renderInputBar();
  }

  /**
   * Print a line to the transcript. Goes both to stdout and to the
   * in-memory buffer so search + scrollback can find it later.
   * Pass `noAppend: true` for ephemeral status messages.
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
    // Clear current input bar, write content, redraw input bar.
    this._eraseInputBar();
    process.stdout.write(text + '\n');
    this._renderInputBar();
  }

  /** Print without appending to transcript (use for transient progress). */
  status(text) { this.print(text, { noAppend: true }); }

  /** Disable raw mode + restore terminal, then call onExit. */
  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this._eraseInputBar();
      if (process.stdin.isTTY) {
        process.stdout.write(ANSI.mouseOff);
        process.stdout.write(ANSI.cursorShow);
        process.stdin.setRawMode(false);
      }
      process.stdin.off('keypress', this._onKey);
      process.stdin.off('data', this._onData);
      process.stdin.pause();
    } catch (_) {}
    if (this.onExit) this.onExit();
  }

  /** Briefly disable input handling (for sub-prompts via readline.question). */
  pause() {
    if (!process.stdin.isTTY) return;
    process.stdin.off('keypress', this._onKey);
    process.stdin.off('data', this._onData);
    process.stdout.write(ANSI.mouseOff);
    this._eraseInputBar();
  }
  resume() {
    if (!process.stdin.isTTY) return;
    process.stdin.on('keypress', this._onKey);
    process.stdin.on('data', this._onData);
    process.stdout.write(ANSI.mouseOn);
    this._renderInputBar();
  }

  /** Mark composer as "sending" so we ignore Enter until reply comes back. */
  setSending(on) {
    this._sending = !!on;
    if (!on && process.stdin.isTTY && !this._closed) this._renderInputBar();
  }

  // ── key handling ────────────────────────────────────────────────────
  _handleKey(ch, key) {
    if (!key) return;
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

    if (key.name === 'backspace') { this._backspace(); return; }
    if (key.name === 'delete')    { this._delete(); return; }
    if (key.name === 'tab')       { this._autocomplete(); return; }

    if (key.name === 'return' || key.name === 'enter') {
      // Shift+Enter = newline; Enter alone = submit
      if (key.shift || key.alt) { this._insertNewline(); return; }
      this._submit();
      return;
    }

    // Printable character
    if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch >= ' ') {
      this._insertChar(ch);
      return;
    }
    // Some terminals send multi-char paste in one chunk; handle that
    if (ch && ch.length > 1 && !key.ctrl) {
      for (const c of ch) {
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
  _handleData(buf) {
    const s = buf.toString();
    // SGR mouse: \x1b[<button;col;row(M|m)
    const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let m;
    while ((m = re.exec(s))) {
      this._mouseSeen = true;
      const button = parseInt(m[1], 10);
      const col = parseInt(m[2], 10);
      const row = parseInt(m[3], 10);
      const isPress = m[4] === 'M';
      this._onMouse(button, col, row, isPress);
    }
  }

  _onMouse(button, col, row, isPress) {
    // SGR button encoding:
    //   0=left, 1=middle, 2=right, 64=scroll up, 65=scroll down
    //   add 32 for drag/move
    if (!isPress) return;
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
  _autocomplete() {
    if (!this.completer) return;
    const line = this.lines[this.lineIdx];
    const before = line.slice(0, this.col);
    const after  = line.slice(this.col);
    const [hits, prefix] = this.completer(before);
    if (!hits || !hits.length) return;
    if (hits.length === 1) {
      this.lines[this.lineIdx] = hits[0] + after;
      this.col = hits[0].length;
    } else {
      // Print options + redraw composer
      this._eraseInputBar();
      process.stdout.write(fmt.dim('  ' + hits.join('   ') + '\n'));
    }
    this._renderInputBar();
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

  _renderInputBar() {
    if (!process.stdin.isTTY || this._closed) return;
    this._eraseInputBar();

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
      const bar = fmt.dim('  …sending — press Ctrl+C to interrupt');
      process.stdout.write(bar);
      this._lastDrawHeight = 1;
      return;
    }

    // Composer — print each line
    const lineCount = this.lines.length;
    for (let i = 0; i < lineCount; i++) {
      const prefix = i === 0 ? fmt.cyan(PROMPT) : fmt.dim('  ');
      process.stdout.write(prefix + this.lines[i]);
      if (i < lineCount - 1) process.stdout.write('\n');
    }
    this._lastDrawHeight = lineCount;

    // Position cursor on (lineIdx, col)
    if (this.lineIdx < lineCount - 1) {
      // Move cursor up to the active line
      process.stdout.write(ANSI.cursorUp(lineCount - 1 - this.lineIdx));
    }
    process.stdout.write(ANSI.cursorLeft(9999));
    process.stdout.write(ANSI.cursorRight(this.col + (this.lineIdx === 0 ? PROMPT.length : 2)));
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
    process.stdout.write('\n\x1b[97mPlain-mode TUI active\x1b[0m \x1b[90m(raw input unavailable on this terminal — type your message and press Enter; /quit to exit, /help for commands).\x1b[0m\n\n');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '\x1b[36m›\x1b[0m ',
      terminal: false,  // makes readline echo input + handle Ctrl+C cleanly
    });
    rl.prompt();
    rl.on('line', async (l) => {
      try { await this.onLine(l); }
      catch (e) { process.stdout.write('\x1b[31merror:\x1b[0m ' + (e?.message || String(e)) + '\n'); }
      rl.prompt();
    });
    rl.on('close', () => {
      process.stdout.write('\n\x1b[90mGoodbye.\x1b[0m\n');
      this._exit();
    });
  }
}

module.exports = { TuiEngine, ANSI };
