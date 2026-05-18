// ASCII banner + gradient spinner — the visual polish layer for the TUI.
//
// Two flavours of banner:
//   - bannerCompact()  → 4 lines, used for `horizon version` and TUI startup
//   - bannerBig()      → 11 lines, full ASCII art, used for splash on first run
//
// All ANSI codes degrade to empty strings on non-color terminals.

const { fmt, supportsColor } = require('./tty');

// Cyan→magenta→yellow→green gradient for the spinner.
const GRADIENT = ['\x1b[38;5;51m','\x1b[38;5;87m','\x1b[38;5;123m','\x1b[38;5;159m',
                  '\x1b[38;5;195m','\x1b[38;5;225m','\x1b[38;5;213m','\x1b[38;5;177m',
                  '\x1b[38;5;141m','\x1b[38;5;105m','\x1b[38;5;69m','\x1b[38;5;33m'];

const RESET = supportsColor ? '\x1b[0m' : '';

function paintEach(text, colors) {
  if (!supportsColor) return text;
  let out = '';
  let i = 0;
  for (const ch of text) {
    out += colors[i % colors.length] + ch;
    i++;
  }
  return out + RESET;
}

function bannerBig() {
  // Generated ASCII — kept narrow enough for an 80-col terminal.
  const lines = [
    '  ██╗  ██╗ ██████╗ ██████╗ ██╗███████╗ ██████╗ ███╗   ██╗',
    '  ██║  ██║██╔═══██╗██╔══██╗██║╚══███╔╝██╔═══██╗████╗  ██║',
    '  ███████║██║   ██║██████╔╝██║  ███╔╝ ██║   ██║██╔██╗ ██║',
    '  ██╔══██║██║   ██║██╔══██╗██║ ███╔╝  ██║   ██║██║╚██╗██║',
    '  ██║  ██║╚██████╔╝██║  ██║██║███████╗╚██████╔╝██║ ╚████║',
    '  ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝',
  ];
  return lines.map(l => paintEach(l, GRADIENT)).join('\n');
}

function bannerCompact() {
  if (!supportsColor) return 'HORIZON AI';
  return paintEach('▌╎▐  H O R I Z O N  ', GRADIENT);
}

// Spinner — a gradient-flowing braille spinner. Used by TUI/agent command.
class GradientSpinner {
  constructor(text) {
    this.text = text || '';
    this.frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    this.i = 0;
    this.timer = null;
    this.lastLen = 0;
    this.isTTY = !!process.stdout.isTTY;
  }
  start(text) {
    if (text) this.text = text;
    if (!this.isTTY) {
      process.stderr.write(this.text + '...\n');
      return this;
    }
    if (this.timer) return this;
    this.timer = setInterval(() => this._tick(), 70);
    this._tick();
    return this;
  }
  _tick() {
    const f = this.frames[this.i++ % this.frames.length];
    const color = supportsColor ? GRADIENT[this.i % GRADIENT.length] : '';
    const line = `${color}${f}${RESET} ${this.text}`;
    // Erase previous line residue
    process.stderr.write(`\r\x1b[K${line}`);
    this.lastLen = line.length;
  }
  update(text) { this.text = text; }
  stop(finalText) {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.isTTY) process.stderr.write('\r\x1b[K');
    if (finalText) process.stderr.write(finalText + '\n');
  }
  succeed(t) { this.stop(fmt.ok(t || this.text)); }
  fail(t)    { this.stop(fmt.err(t || this.text)); }
}

// Typing animation — slowly emit characters of `text` to stdout.
// Useful for the "welcome" banner reveal but optional.
function typeOut(text, delayMs = 12) {
  return new Promise(resolve => {
    if (!process.stdout.isTTY || process.env.HORIZON_FAST === '1') {
      process.stdout.write(text);
      return resolve();
    }
    let i = 0;
    const step = () => {
      if (i >= text.length) return resolve();
      process.stdout.write(text[i++]);
      setTimeout(step, delayMs);
    };
    step();
  });
}

module.exports = { bannerBig, bannerCompact, GradientSpinner, typeOut };
