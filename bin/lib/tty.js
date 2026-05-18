// Terminal helpers — ANSI colors, spinner, prompt. Pure stdlib, no deps.

const isTTY = !!process.stdout.isTTY;
const supportsColor = isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';

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

module.exports = { fmt, Spinner, isTTY, supportsColor, promptYesNo };
