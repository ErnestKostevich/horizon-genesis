// ASCII banner + gradient spinner — the visual polish layer for the TUI.
//
// Two flavours of banner:
//   - bannerCompact()  → 4 lines, used for `horizon version` and TUI startup
//   - bannerBig()      → 11 lines, full ASCII art, used for splash on first run
//
// All ANSI codes degrade to empty strings on non-color terminals.

const { fmt, supportsColor, supportsTruecolor, rgb } = require('./tty');

// 256-color fallback gradient (used when terminal doesn't advertise truecolor)
const GRADIENT_256 = ['\x1b[38;5;51m','\x1b[38;5;87m','\x1b[38;5;123m','\x1b[38;5;159m',
                  '\x1b[38;5;195m','\x1b[38;5;225m','\x1b[38;5;213m','\x1b[38;5;177m',
                  '\x1b[38;5;141m','\x1b[38;5;105m','\x1b[38;5;69m','\x1b[38;5;33m'];

// Truecolor anchor stops — interpolated smoothly across N characters.
// Cyan #06b6d4 → indigo #6366f1 → purple #8b5cf6 → pink #ec4899 →
// amber #f59e0b → cyan (loop) — matches our brand colour palette.
const TRUECOLOR_STOPS = [
  [6, 182, 212],   // cyan-500
  [99, 102, 241],  // indigo-500
  [139, 92, 246],  // violet-500
  [236, 72, 153],  // pink-500
  [245, 158, 11],  // amber-500
];

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function gradientColor(t) {
  // t in [0, 1) — pick segment, interpolate between two anchor stops
  const segs = TRUECOLOR_STOPS.length;
  const f = t * segs;
  const i = Math.floor(f) % segs;
  const j = (i + 1) % segs;
  const k = f - Math.floor(f);
  const a = TRUECOLOR_STOPS[i], b = TRUECOLOR_STOPS[j];
  return rgb(lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k));
}

const RESET = supportsColor ? '\x1b[0m' : '';
// Active gradient — truecolor stops if supported, 256-color stops otherwise
const GRADIENT = supportsTruecolor
  ? new Array(48).fill(0).map((_, i) => gradientColor(i / 48))
  : GRADIENT_256;

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

// Fix 1 — single-line wordmark. Replaces the rainbow ASCII block.
// Format: " ⌁ horizon   v0.0.1   ·   bring your own model"
//   - ⌁ glyph painted in accent (deep blue-violet #7c6df2 via truecolor;
//     falls back to magenta when truecolor isn't available)
//   - "horizon" in bold white
//   - version in dim grey
//   - tagline in dim grey
//
// bannerBig() and bannerCompact() now both return the same wordmark —
// the only legitimate use of "big" (welcome reveal) uses it the same way.
function _wordmark() {
  if (!supportsColor) {
    return '  horizon  v' + _pkgVersion() + '  ·  bring your own model';
  }
  const ACCENT = supportsTruecolor ? rgb(124, 109, 242) : '\x1b[35m'; // #7c6df2 / magenta
  const RESET = '\x1b[0m';
  const BOLD_WHITE = '\x1b[1m\x1b[97m';
  const DIM = '\x1b[2m';
  const parts = [
    '  ',
    ACCENT + '⌁' + RESET,
    ' ',
    BOLD_WHITE + 'horizon' + RESET,
    '   ',
    DIM + 'v' + _pkgVersion() + RESET,
    '   ',
    DIM + '·' + RESET,
    '   ',
    DIM + 'bring your own model' + RESET,
  ];
  return parts.join('');
}

let _cachedVersion = null;
function _pkgVersion() {
  if (_cachedVersion) return _cachedVersion;
  try {
    _cachedVersion = require('../../package.json').version || '0.0.0';
  } catch (_) {
    _cachedVersion = '0.0.0';
  }
  return _cachedVersion;
}

function bannerBig()     { return _wordmark(); }
function bannerCompact() { return _wordmark(); }

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

/**
 * Phase 18 — first-launch welcome reveal. Used by the TUI on its
 * first start (when no chats exist yet) to give a memorable splash.
 *
 * Sequence:
 *   1. Fast clear-screen
 *   2. Banner appears line-by-line with 90ms gaps (gradient lines
 *      reveal one at a time so the eye tracks the colour flow)
 *   3. Tagline types out (12ms/char)
 *   4. Three quick-start hints fade in
 *   5. Bell ping (\\x07) — terminal owners often have it muted but
 *      those who don't get a "ready" cue
 *
 * Honours HORIZON_FAST=1 (cron-friendly) — skips animation, prints
 * the banner + tagline in one shot.
 */
async function welcomeReveal({ provider, persona, lang } = {}) {
  if (!process.stdout.isTTY) {
    // Non-TTY (piped) — print the banner once and bail
    process.stdout.write(bannerBig() + '\n\n');
    return;
  }
  const fast = process.env.HORIZON_FAST === '1';
  // Clear screen + hide cursor during reveal
  process.stdout.write('\x1b[2J\x1b[H');
  if (!fast) process.stdout.write('\x1b[?25l');

  // Fix 2 — quick 1-second flash, not 4 seconds. 30ms/line instead of 90.
  const lines = bannerBig().split('\n');
  for (const line of lines) {
    process.stdout.write(line + '\n');
    if (!fast) await new Promise(r => setTimeout(r, 30));
  }
  process.stdout.write('\n');

  const tagline = 'Personal AI agent — bring your own keys · your data stays local';
  if (fast) {
    process.stdout.write('  ' + tagline + '\n');
  } else {
    process.stdout.write('  ');
    await typeOut(tagline, 5);
    process.stdout.write('\n');
  }

  if (!fast) await new Promise(r => setTimeout(r, 80));

  const hints = [
    [fmt.dim('Provider:'), fmt.cyan(provider || 'gemini'), '   ',
     fmt.dim('Persona:'),  fmt.cyan(persona  || 'jarvis'), '   ',
     fmt.dim('Lang:'),     fmt.cyan(lang     || 'en')].join(''),
    '',
    fmt.dim('  /help') + '   show every slash command',
    fmt.dim('  /agent') + ' <task>     full agent loop with tools',
    fmt.dim('  /chat')  + ' <message>  single-turn chat',
    fmt.dim('  /quit')  + '   exit',
    '',
  ];
  for (const h of hints) {
    process.stdout.write('  ' + h + '\n');
    if (!fast && h) await new Promise(r => setTimeout(r, 20));
  }

  if (!fast) {
    process.stdout.write('\x1b[?25h');     // show cursor
    process.stdout.write('\x07');           // gentle bell — most terminals mute this
  }
}

/**
 * Phase 20.3 — column-aligned help-table renderer.
 *
 * Given groups of [command, args, description] tuples, returns a string
 * with each column padded so the description text aligns vertically
 * regardless of how long the command/args part is. ANSI escape codes
 * are accounted for via stripAnsi() so colour codes don't break
 * alignment.
 *
 * Usage:
 *   helpTable({
 *     "Commands": [
 *       ["setup",   "",         "First-time wizard"],
 *       ["agent",   '"task"',   "Full agent loop"],
 *     ],
 *     "Flags": [...],
 *   })
 */
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }
function visibleLen(s) { return stripAnsi(s).length; }
function padVisible(s, width) {
  const pad = Math.max(0, width - visibleLen(s));
  return s + ' '.repeat(pad);
}

function helpTable(groups, opts = {}) {
  const cmdGap   = opts.cmdGap   ?? 2;
  const argsGap  = opts.argsGap  ?? 2;
  const indent   = opts.indent   ?? '  ';
  const out = [];
  for (const [heading, rows] of Object.entries(groups)) {
    if (!rows || rows.length === 0) continue;
    const cmdW  = Math.max(...rows.map((r) => visibleLen(r[0] || '')));
    const argsW = Math.max(...rows.map((r) => visibleLen(r[1] || '')));
    out.push('');
    out.push(fmt.bold(heading));
    for (const [cmd, args, desc] of rows) {
      const cmdCol  = padVisible(cmd  || '', cmdW);
      const argsCol = padVisible(args || '', argsW);
      out.push(`${indent}${cmdCol}${' '.repeat(cmdGap)}${argsCol}${argsGap ? ' '.repeat(argsGap) : ''}${desc ? fmt.dim(desc) : ''}`);
    }
  }
  return out.join('\n') + '\n';
}

/**
 * Phase 20.3 — interactive first-launch persona picker.
 *
 * After the welcome reveal, if the user hasn't picked a persona yet, this
 * runs a tiny TTY menu (J-arvis / F-riday / A-lfred / S-age / P-ixel)
 * and writes the choice back to settingsStore. Single-keypress, non-
 * blocking. Honours HORIZON_FAST=1 (skips picker entirely).
 *
 * Returns the persona id chosen (or the existing value when skipped).
 */
async function personaPickerInteractive(currentPersona) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.HORIZON_FAST === '1') {
    return currentPersona || 'jarvis';
  }
  const personas = [
    { key: '1', id: 'jarvis', label: 'JARVIS',  blurb: 'formal · witty · says "sir"' },
    { key: '2', id: 'friday', label: 'Friday',  blurb: 'casual · energetic · modern slang' },
    { key: '3', id: 'alfred', label: 'Alfred',  blurb: 'calm · dignified · butler-like' },
    { key: '4', id: 'sage',   label: 'Sage',    blurb: 'patient · thoughtful · teacher' },
    { key: '5', id: 'pixel',  label: 'Pixel',   blurb: 'playful · creative · designer' },
  ];

  process.stdout.write('\n  ' + fmt.bold('Pick a persona') + fmt.dim(' (press 1-5, Enter to skip)') + '\n\n');
  for (const p of personas) {
    const active = currentPersona === p.id ? fmt.green(' ●') : '  ';
    process.stdout.write(`  ${fmt.dim('[' + p.key + ']')} ${fmt.cyan(p.label.padEnd(8))} ${fmt.dim('—')} ${p.blurb}${active}\n`);
  }
  process.stdout.write('\n  ' + fmt.dim('> '));

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    try { stdin.setRawMode(true); } catch (_) {}
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (key) => {
      // Esc / Ctrl+C / Enter / q → skip
      if (key === '\x1b' || key === '\x03' || key === '\r' || key === '\n' || key === 'q') {
        cleanup();
        process.stdout.write(fmt.dim('skipped') + '\n');
        return resolve(currentPersona || 'jarvis');
      }
      const match = personas.find((p) => p.key === key);
      if (!match) return; // ignore other keys
      cleanup();
      process.stdout.write(fmt.cyan(match.label) + fmt.dim(' (' + match.id + ')') + '\n\n');
      resolve(match.id);
    };

    function cleanup() {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(wasRaw); } catch (_) {}
      stdin.pause();
    }

    stdin.on('data', onData);
  });
}

module.exports = { bannerBig, bannerCompact, GradientSpinner, typeOut, welcomeReveal, personaPickerInteractive, helpTable, stripAnsi, visibleLen };
