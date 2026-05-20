// Terminal helpers — ANSI colors, spinner, prompt. Pure stdlib, no deps.

const isTTY = !!process.stdout.isTTY;
const supportsColor = isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
// Phase 17 — detect 24-bit truecolor support. Most modern terminals
// (Windows Terminal, iTerm2, macOS Terminal.app, GNOME Terminal,
// Konsole, alacritty, kitty, wezterm) advertise COLORTERM=truecolor
// or 24bit. Falls back to 256-color paint when not detected.
const supportsTruecolor = supportsColor && (
  process.env.COLORTERM === 'truecolor' ||
  process.env.COLORTERM === '24bit' ||
  /^xterm-(kitty|ghostty)/.test(process.env.TERM || '') ||
  process.env.WT_SESSION !== undefined // Windows Terminal
);

function rgb(r, g, b) {
  if (!supportsTruecolor) return '';
  return `\x1b[38;2;${r};${g};${b}m`;
}
function bgRgb(r, g, b) {
  if (!supportsTruecolor) return '';
  return `\x1b[48;2;${r};${g};${b}m`;
}

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  italic: '\x1b[3m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  grey:   '\x1b[90m',
};

function paint(color, txt) {
  if (!supportsColor) return txt;
  const c = C[color];
  if (!c) return txt;
  return c + txt + C.reset;
}

const fmt = {
  dim: t => paint('dim', t),
  bold: t => paint('bold', t),
  red: t => paint('red', t),
  green: t => paint('green', t),
  yellow: t => paint('yellow', t),
  blue: t => paint('blue', t),
  cyan: t => paint('cyan', t),
  magenta: t => paint('magenta', t),
  grey: t => paint('grey', t),
  ok: t => paint('green', '✓ ') + t,
  err: t => paint('red', '✗ ') + t,
  warn: t => paint('yellow', '⚠ ') + t,
  info: t => paint('cyan', 'ℹ ') + t,
  arrow: t => paint('cyan', '→ ') + t,
};

class Spinner {
  constructor(text) {
    this.text = text || '';
    this.frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    this.i = 0;
    this.timer = null;
  }
  start(text) {
    if (text) this.text = text;
    if (!isTTY) {
      // In non-TTY (pipe) mode just print a one-line "..." once.
      process.stderr.write(this.text + '...\n');
      return this;
    }
    if (this.timer) return this;
    this.timer = setInterval(() => {
      const frame = this.frames[this.i++ % this.frames.length];
      process.stderr.write(`\r${fmt.cyan(frame)} ${this.text}   \x1b[K`);
    }, 80);
    return this;
  }
  update(text) {
    this.text = text;
  }
  stop(finalText) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (isTTY) {
      process.stderr.write('\r\x1b[K');
    }
    if (finalText) process.stderr.write(finalText + '\n');
  }
  succeed(text) { this.stop(fmt.ok(text || this.text)); }
  fail(text)    { this.stop(fmt.err(text || this.text)); }
}

function promptYesNo(question) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) return resolve(false);
    process.stderr.write(question + ' ');
    const onData = (chunk) => {
      const s = String(chunk).trim().toLowerCase();
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve(s === 'y' || s === 'yes' || s === 'д' || s === 'да');
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

// v0.0.2 — translate raw provider/runtime errors into something the
// user can act on. The default error stream returns strings like
// "HTTP 429" or "fetch failed" which leave end users staring blankly
// at the terminal. This helper maps the common cases to a short
// English line + a hint about what to try next.
//
// Returns the original string for anything we don't recognise — we
// never want to swallow the actual error.
function friendlyError(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'unknown error';

  // Match HTTP status — accepts "HTTP 429", "status 429", or just "429".
  const m = s.match(/(?:HTTP|status)\s*(\d{3})|\b(\d{3})\b/i);
  const code = m ? parseInt(m[1] || m[2], 10) : null;

  if (code === 429) {
    return 'Rate limit hit — your provider is throttling requests.\n  Tip: wait 30–60 seconds, or switch provider with `horizon model <id>`.';
  }
  if (code === 401 || code === 403) {
    return 'API key rejected — the provider says your key is missing, wrong, or expired.\n  Tip: run `horizon setup` to re-enter, or `horizon doctor` to check what is configured.';
  }
  if (code === 402) {
    return 'Payment required — your provider account has no credit.\n  Tip: top up at the provider dashboard, or switch with `horizon model <id>`.';
  }
  if (code === 404) {
    return 'Model not found — the configured model name does not exist for this provider.\n  Tip: run `horizon model` to see available models.';
  }
  if (code === 408 || /timeout/i.test(s)) {
    return 'Request timed out — the provider took too long to respond.\n  Tip: try again, or switch to a faster provider (groq/cerebras).';
  }
  if (code && code >= 500) {
    return `Provider returned ${code} — their side is having trouble right now.\n  Tip: wait a minute and retry, or switch with \`horizon model <id>\`.`;
  }

  // Network-level failures (no HTTP code).
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(s)) {
    return 'DNS lookup failed — check your internet connection or firewall.';
  }
  if (/ECONNREFUSED/i.test(s)) {
    return 'Connection refused — if you set a local provider URL (Ollama/LM Studio/LocalAI), make sure that server is running.';
  }
  if (/ECONNRESET|EPIPE|socket hang up/i.test(s)) {
    return 'Connection dropped mid-request — usually transient. Retry once.';
  }
  if (/fetch failed/i.test(s)) {
    return 'Network request failed — check connectivity and provider status.';
  }
  if (/key not set|not configured/i.test(s)) {
    return s + '\n  Tip: run `horizon setup` to add it.';
  }

  return s;
}

module.exports = { fmt, Spinner, isTTY, supportsColor, supportsTruecolor, rgb, bgRgb, promptYesNo, friendlyError };
