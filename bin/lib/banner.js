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

/**
 * Sprint 2.12 — Hermes-style framed banner box.
 * Renders a rounded-corner Unicode box around the wordmark + tagline.
 * Width adapts to the inner content; the box always uses light-violet
 * (accent) borders so it pops on any background.
 *
 *   ╭──────────────────────────────────────╮
 *   │ ⌁ horizon · v0.0.1                   │
 *   │   the agent that learns who you are  │
 *   ╰──────────────────────────────────────╯
 */
function bannerFramedBox() {
  const v = _pkgVersion();
  const titleVis = '⌁ horizon · v' + v;
  const subVis   = '  the agent that learns who you are';
  // Inner width = wider of the two strings + 3-char trailing gutter so the
  // right border has visible breathing room.
  const innerW = Math.max(titleVis.length, subVis.length) + 3;
  const horiz  = '─'.repeat(innerW);
  // Padding helper: visible-text padding to fill the inner width minus
  // the leading 1-char gutter.
  const padTo = (visLen) => ' '.repeat(Math.max(0, innerW - 1 - visLen));
  if (!supportsColor) {
    return [
      '╭' + horiz + '╮',
      '│ ' + titleVis + padTo(titleVis.length) + '│',
      '│ ' + subVis   + padTo(subVis.length)   + '│',
      '╰' + horiz + '╯',
    ].join('\n');
  }
  const [r, g, b] = _accentRgb();
  const ACCENT = supportsTruecolor ? rgb(r, g, b) : '\x1b[35m';
  const RESET  = '\x1b[0m';
  const BOLD   = '\x1b[1m\x1b[97m';
  const DIM    = '\x1b[2m';
  const titlePainted = ACCENT + '⌁' + RESET + ' ' + BOLD + 'horizon' + RESET
                     + DIM + ' · v' + v + RESET;
  const subPainted   = DIM + subVis + RESET;
  return [
    ACCENT + '╭' + horiz + '╮' + RESET,
    ACCENT + '│' + RESET + ' ' + titlePainted + padTo(titleVis.length) + ACCENT + '│' + RESET,
    ACCENT + '│' + RESET + ' ' + subPainted   + padTo(subVis.length)   + ACCENT + '│' + RESET,
    ACCENT + '╰' + horiz + '╯' + RESET,
  ].join('\n');
}

/**
 * Sprint 2.12 — Hermes-style collapsible section row.
 * Renders a single startup-banner row with a chevron (▾ when expanded,
 * ▸ when collapsed), a left-aligned section label, and a dim summary.
 * When expanded the optional `body` array is rendered as indented dim
 * sub-lines underneath.
 *
 *   ▾ Tools          37 built-in · 24 channels · 12 MCP
 *   ▸ Skills         8 enabled · /skills to manage
 */
function renderCollapsibleSection(name, summary, expanded, body) {
  const chevron = expanded ? '▾' : '▸';
  const labelW = 14;
  const labelPainted = fmt.bold(fmt.cyan(chevron)) + ' '
                     + fmt.bold(String(name).padEnd(labelW));
  const summaryPainted = fmt.dim(String(summary || ''));
  const head = '  ' + labelPainted + summaryPainted;
  if (!expanded || !body || !body.length) return head;
  const lines = body.map(l => '    ' + fmt.dim(String(l)));
  return [head, ...lines].join('\n');
}

// ────────────────────────────────────────────────────────────────────────
// Hermes-style ASCII art moments — small tasteful illustrations shown at
// earned moments (first launch, setup intro, agent goal-met, doctor clean
// bill of health). Inspired by Hermes' "art at the right moment" feel.
//
// Design rules:
//   - 3-6 lines, max ~40 chars wide (fits narrow terminals)
//   - Box-drawing + geometric Unicode only (no emoji; renders everywhere)
//   - Rendered in the active theme's accent colour
//   - Always opt-out: HORIZON_NO_ART=1, --no-art flag, or --quiet skip
//   - ALWAYS additive — never replaces functional output
// ────────────────────────────────────────────────────────────────────────
const ART = {
  // Bigger welcome — shown on `horizon art welcome` showcase + first launch
  // animated reveal. ~10 lines, max 40 chars wide.
  welcome: [
    '      ╭───────────────────────╮',
    '     ╱                         ╲',
    '    │     ⌁   H O R I Z O N    │',
    '     ╲                         ╱',
    '      ╰───────────────────────╯',
    '             ⌁ ⌁ ⌁ ⌁ ⌁',
    '       the agent that learns',
    '            who you are',
  ],
  setupIntro: [
    '   ◆ ◆ ◆',
    '   ───────',
  ],
  goalMet: [
    '   ╭─ DONE ─╮',
    '   │   ✓    │',
    '   ╰────────╯',
  ],
  doctorHealthy: [
    '   ♥ ♥ ♥',
    '   ─────',
  ],
  helpHeader: [
    '   ⌁ horizon · help',
    '   ─────────────────',
  ],
  subagentSpawn: [
    '   ❖ → ❖ ❖',
  ],
  planAccepted: [
    '   ┃ plan',
  ],
  skillActive: [
    '   ▸',
  ],
  // ── New pieces (Sprint 2.3) ───────────────────────────────────────────
  // "thinking" — small spinner-flavoured fallback when first token is slow.
  thinking: [
    '   ◔ ◐ ◑ ◕ ●',
    '   thinking…',
  ],
  // "error" — friendly fatal-error card.
  error: [
    '   ╭─ ☄ ─╮',
    '   │  ✗  │   something exploded',
    '   ╰─────╯   try: horizon doctor',
  ],
  // "offline" — shown when network is down.
  offline: [
    '   ⌁ × ⌁    horizon needs internet',
    '   ─────    check your connection',
  ],
  // "achievement" — milestone burst (first 10 msgs, first agent task, etc).
  achievement: [
    '     ★ ★ ★',
    '    ╭─────╮',
    '    │  ✦  │',
    '    ╰─────╯',
    '   well done!',
  ],
  // "idle" — shown after 60s of no input.
  idle: [
    '   ⌁',
    '    ╲',
    '     ╲     still here, sir',
    '      ╲    type anytime',
  ],
  // "konami" — Easter egg.
  konami: [
    '   ╭───────────────╮',
    '   │    K O N A    │',
    '   │    M I !      │',
    '   │   ⌁ ⌁ ⌁       │',
    '   ╰───────────────╯',
    '   you found me 😉',
  ],
  // "tea" — Easter egg, /tea or "tea".
  tea: [
    '       )   (',
    '      ( )  ) (',
    '     ___c|___ )',
    '    (_______)',
    '    Earl Grey, hot.',
  ],
  // "coffee" — Easter egg, /coffee or "coffee".
  coffee: [
    '       ( (',
    '        ) )',
    '      ........',
    '      |coffee|]',
    '      \\      /',
    '       \'----\'',
    '    need that fuel',
  ],
  // "mobile" — phone-pairing flourish, shown above the QR by `horizon mobile`.
  mobile: [
    '   ┌─────┐',
    '   │ ┌─┐ │   scan + go',
    '   │ │ │ │',
    '   │ └─┘ │',
    '   └──○──┘',
  ],
  // "morning" / "evening" / "night" — time-of-day tiny markers.
  morning: [
    '   ☀ ─── new day',
    '   ────────────',
  ],
  evening: [
    '   ◐ ─── sundown',
    '   ────────────',
  ],
  night: [
    '   ⌒⌒⌒  ☾',
    '   ─────',
    '   working late',
  ],
};

// Multi-frame art pieces (cycled by animateArt). Each frame is an array of
// lines, matching the single-frame ART shape so frames can be rendered with
// the same code path.
const ART_FRAMES = {
  loading: [
    ['   ◐  loading'],
    ['   ◓  loading'],
    ['   ◑  loading'],
    ['   ◒  loading'],
  ],
  // "ribbon" — plan-accepted unfurl. Four frames widening the bar.
  ribbon: [
    ['   ┃'],
    ['   ┃━'],
    ['   ┃━━'],
    ['   ┃━━━ plan'],
  ],
  // "fractal" — agent-step thinking shape, rotates through 4 marks.
  fractal: [
    ['   ◇ ◆ ◇'],
    ['   ◆ ◇ ◆'],
    ['   ◇ ◆ ◇'],
    ['   ◆ ◇ ◆'],
  ],
  // "spark" — skill activation flourish (3 frames, expanding).
  spark: [
    ['   ▸'],
    ['   ▸ ▸'],
    ['   ▸ ▸ ▸'],
  ],
};

// Pull the active theme's accent RGB without forcing a runtime construction.
// Falls back to the default theme accent (#7c6df2) when nothing is set.
function _accentRgb() {
  try {
    const themes = require('./themes');
    const fs = require('fs');
    const path = require('path');
    const { defaultUserDataDir } = require('../../src/main/runtime/store-shim');
    const baseDir = defaultUserDataDir();
    const candidates = [path.join(baseDir, 'settings.json')];
    try {
      const f = path.join(baseDir, 'active-profile.txt');
      if (fs.existsSync(f)) {
        const name = fs.readFileSync(f, 'utf8').trim();
        if (name && name !== 'default' && /^[a-z0-9][a-z0-9-_]{0,30}$/i.test(name)) {
          candidates.unshift(path.join(baseDir, 'profiles', name, 'settings.json'));
        }
      }
    } catch (_) {}
    for (const file of candidates) {
      try {
        if (fs.existsSync(file)) {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          const name = data.cliTheme;
          if (name) {
            const t = themes.getTheme(name);
            if (t && Array.isArray(t.accent)) return t.accent;
          }
        }
      } catch (_) {}
    }
    const def = themes.getTheme('default');
    if (def && Array.isArray(def.accent)) return def.accent;
  } catch (_) {}
  return [124, 109, 242];
}

// Should we suppress art? Honours global env knobs + caller-supplied flags.
// `flags` is the same shape commands already pass around (argv-parsed).
function artSuppressed(flags) {
  if (process.env.HORIZON_NO_ART === '1') return true;
  if (process.env.HORIZON_FAST === '1')   return true;
  if (flags && (flags['no-art'] || flags.quiet || flags.json)) return true;
  return false;
}

// Render a named art piece. Returns '' when art is suppressed or the
// terminal can't render colour — the caller can unconditionally concatenate
// the result without worrying about layout.
//
//   renderArt('goalMet', { tag: '12s · 3 steps' })
//
// `tag` is a dim right-side label appended to the middle line.
function renderArt(name, opts) {
  opts = opts || {};
  if (artSuppressed(opts.flags)) return '';
  const lines = ART[name];
  if (!lines) return '';
  const [r, g, b] = opts.accent || _accentRgb();
  const COLOR = supportsTruecolor ? rgb(r, g, b) : (supportsColor ? '\x1b[35m' : '');
  const R = supportsColor ? '\x1b[0m' : '';
  const tagAt = Math.floor(lines.length / 2);
  return lines.map((l, i) => {
    const painted = COLOR + l + R;
    if (opts.tag && i === tagAt) return painted + '  ' + fmt.dim(opts.tag);
    return painted;
  }).join('\n');
}

/**
 * Sprint 2.3 — animated ASCII art. Cycles through frames of a multi-frame
 * piece for `durationMs`, painted in the accent colour.
 *
 *   await animateArt('loading', { fps: 5, durationMs: 800 });
 *
 * Honours --no-art / HORIZON_NO_ART / HORIZON_FAST exactly like renderArt.
 * Returns a Promise that resolves when the animation finishes. Erases the
 * last frame on exit so the surrounding output flows cleanly.
 *
 * No-TTY / suppressed cases resolve immediately without printing.
 */
function animateArt(name, opts = {}) {
  return new Promise(resolve => {
    if (artSuppressed(opts.flags) || !process.stdout.isTTY) return resolve();
    const frames = ART_FRAMES[name];
    if (!frames || !frames.length) return resolve();
    const fps = Math.max(1, Math.min(30, opts.fps || 5));
    const durationMs = Math.max(100, Math.min(10_000, opts.durationMs || 800));
    const intervalMs = Math.round(1000 / fps);
    const totalFrames = Math.ceil(durationMs / intervalMs);
    const [r, g, b] = opts.accent || _accentRgb();
    const COLOR = supportsTruecolor ? rgb(r, g, b) : (supportsColor ? '\x1b[35m' : '');
    const R = supportsColor ? '\x1b[0m' : '';
    let i = 0;
    let lastHeight = 0;

    const paint = () => {
      const frame = frames[i % frames.length];
      // Erase previous frame (move up, clear each line) before painting next.
      if (lastHeight > 0) {
        process.stdout.write('\x1b[' + lastHeight + 'A');
        for (let k = 0; k < lastHeight; k++) {
          process.stdout.write('\x1b[2K');
          if (k < lastHeight - 1) process.stdout.write('\x1b[1B');
        }
        process.stdout.write('\r');
        if (lastHeight > 1) process.stdout.write('\x1b[' + (lastHeight - 1) + 'A');
      }
      const text = frame.map(l => COLOR + l + R).join('\n');
      process.stdout.write(text + '\n');
      lastHeight = frame.length;
    };
    paint();
    const timer = setInterval(() => {
      i++;
      if (i >= totalFrames) {
        clearInterval(timer);
        // Final erase so subsequent output starts cleanly.
        if (lastHeight > 0) {
          process.stdout.write('\x1b[' + lastHeight + 'A');
          for (let k = 0; k < lastHeight; k++) {
            process.stdout.write('\x1b[2K');
            if (k < lastHeight - 1) process.stdout.write('\x1b[1B');
          }
          process.stdout.write('\r');
          if (lastHeight > 1) process.stdout.write('\x1b[' + (lastHeight - 1) + 'A');
        }
        return resolve();
      }
      paint();
    }, intervalMs);
  });
}

/**
 * Sprint 2.3 — rotating greetings. Returns a random base greeting for the
 * current hour-of-day; the caller appends a persona suffix.
 *
 *   buildGreetingBase(new Date())
 *      → "Rise and shine" / "Good morning" / "A new day begins" …
 */
const GREETINGS = {
  morning: [
    'Good morning',
    'Rise and shine',
    'A new day begins',
    'Morning, friend',
    'Up with the lark',
  ],
  afternoon: [
    'Good afternoon',
    'How may I assist',
    'Ready when you are',
    'Standing by',
    'At your service',
  ],
  evening: [
    'Good evening',
    'Winding down',
    'Evening, friend',
    'Pleasant evening',
  ],
  night: [
    'Working late',
    'Burning the midnight oil',
    'Still here',
    'Night owl mode',
  ],
};

function _greetingSlot(hour) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'night';
}

function buildGreetingBase(date) {
  const d = date || new Date();
  const slot = _greetingSlot(d.getHours());
  const arr = GREETINGS[slot] || GREETINGS.afternoon;
  // Deterministic-ish: pick by minute-of-day so the same minute gives the
  // same greeting (less jitter inside a single second's worth of redraws),
  // but rotates over a typical session.
  const seed = d.getHours() * 60 + d.getMinutes();
  return arr[seed % arr.length];
}

/**
 * Sprint 2.3 — return the time-of-day art piece name (or null if normal
 * working hours / no relevant art). Used by the banner header to show a
 * tiny time-flavoured marker line.
 */
function timeOfDayArt(date) {
  const d = date || new Date();
  const h = d.getHours();
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 18 && h < 22) return 'evening';
  if (h >= 22 || h < 5)  return 'night';
  return null;
}

// Phase-aware glyph sets. setPhase(phase) swaps the spinner frames while
// keeping the timer/cycle alive. The default ('default') is the classic
// braille loop. If the active theme has its own spinnerFrames the theme
// wins — the user has made a deliberate aesthetic choice.
const PHASE_FRAMES = {
  default:    ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'],
  thinking:   ['◯','◔','◑','◕','●','◕','◑','◔'],
  planning:   ['◢','◣','◤','◥'],
  executing:  ['▱▱▱▱','▰▱▱▱','▰▰▱▱','▰▰▰▱','▰▰▰▰'],
  reflecting: ['☆','★','✦','★'],
  finishing:  ['✓'],
};

// Read the active theme's spinnerFrames (if any) without forcing a runtime.
// Uses the same settings-file probe tty.js uses, so we honour the user's
// chosen theme before any runtime is constructed.
let _themeFramesCache = null;
function _activeThemeFrames() {
  if (_themeFramesCache !== null) return _themeFramesCache;
  try {
    const themes = require('./themes');
    const fs = require('fs');
    const path = require('path');
    const { defaultUserDataDir } = require('../../src/main/runtime/store-shim');
    const baseDir = defaultUserDataDir();
    const candidates = [path.join(baseDir, 'settings.json')];
    try {
      const f = path.join(baseDir, 'active-profile.txt');
      if (fs.existsSync(f)) {
        const name = fs.readFileSync(f, 'utf8').trim();
        if (name && name !== 'default' && /^[a-z0-9][a-z0-9-_]{0,30}$/i.test(name)) {
          candidates.unshift(path.join(baseDir, 'profiles', name, 'settings.json'));
        }
      }
    } catch (_) {}
    for (const file of candidates) {
      try {
        if (fs.existsSync(file)) {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          const name = data.cliTheme;
          if (name) {
            const t = themes.getTheme(name);
            // Only override if the theme explicitly defines spinnerFrames
            // AND it isn't the inherited default braille loop.
            const def = themes.getTheme('default');
            if (t && Array.isArray(t.spinnerFrames) && t.spinnerFrames !== def.spinnerFrames) {
              _themeFramesCache = t.spinnerFrames;
              return _themeFramesCache;
            }
            _themeFramesCache = false;
            return _themeFramesCache;
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  _themeFramesCache = false;
  return _themeFramesCache;
}

// Sprint 2.12 — read the active theme's kawaii face palette (if any).
// Used by GradientSpinner to rotate kawaii faces every ~2.5s, giving the
// kawaii theme a Hermes-style lively feel.
let _kawaiiFacesCache = null;
function _activeKawaiiFaces() {
  if (_kawaiiFacesCache !== null) return _kawaiiFacesCache;
  try {
    const themes = require('./themes');
    const fs = require('fs');
    const path = require('path');
    const { defaultUserDataDir } = require('../../src/main/runtime/store-shim');
    const baseDir = defaultUserDataDir();
    const candidates = [path.join(baseDir, 'settings.json')];
    try {
      const f = path.join(baseDir, 'active-profile.txt');
      if (fs.existsSync(f)) {
        const name = fs.readFileSync(f, 'utf8').trim();
        if (name && name !== 'default' && /^[a-z0-9][a-z0-9-_]{0,30}$/i.test(name)) {
          candidates.unshift(path.join(baseDir, 'profiles', name, 'settings.json'));
        }
      }
    } catch (_) {}
    for (const file of candidates) {
      try {
        if (fs.existsSync(file)) {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          const name = data.cliTheme;
          if (name) {
            const t = themes.getTheme(name);
            if (t && Array.isArray(t.kawaiiFaces) && t.kawaiiFaces.length) {
              _kawaiiFacesCache = t.kawaiiFaces;
              return _kawaiiFacesCache;
            }
            _kawaiiFacesCache = false;
            return _kawaiiFacesCache;
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  _kawaiiFacesCache = false;
  return _kawaiiFacesCache;
}

// Spinner — a gradient-flowing braille spinner. Used by TUI/agent command.
// Now phase-aware: setPhase('thinking'|'planning'|'executing'|'reflecting'|
// 'finishing') swaps the glyph set without resetting the gradient timer.
// The theme's spinnerFrames override the phase frames when set.
//
// Sprint 2.12 — kawaii theme also rotates a face palette every 2.5s so
// the spinner mutates visually even mid-stream (Hermes-style "alive" feel).
class GradientSpinner {
  constructor(text) {
    this.text = text || '';
    this.phase = 'default';
    this.frames = this._framesFor('default');
    this.i = 0;
    this.timer = null;
    this.lastLen = 0;
    this.isTTY = !!process.stdout.isTTY;
    // Kawaii face rotation state.
    this._kawaiiFaces = _activeKawaiiFaces() || null;
    this._kawaiiFaceIdx = 0;
    this._kawaiiLastSwap = Date.now();
  }
  _framesFor(phase) {
    const themeFrames = _activeThemeFrames();
    if (themeFrames) return themeFrames;  // theme override wins
    return PHASE_FRAMES[phase] || PHASE_FRAMES.default;
  }
  setPhase(phase) {
    if (!phase || phase === this.phase) return this;
    this.phase = phase;
    this.frames = this._framesFor(phase);
    this.i = 0;  // reset index so we start at frame 0 of the new set
    // timer keeps ticking — next _tick uses the new frames
    return this;
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
    // Sprint 2.12 — kawaii face rotation. Every 2.5s, rotate to the
    // next face in the theme's kawaiiFaces palette. The spinner still
    // animates frame-by-frame via setInterval; we just sub in the
    // rotating face when it's time.
    let face;
    if (this._kawaiiFaces && this._kawaiiFaces.length) {
      const now = Date.now();
      if (now - this._kawaiiLastSwap >= 2500) {
        this._kawaiiFaceIdx = (this._kawaiiFaceIdx + 1) % this._kawaiiFaces.length;
        this._kawaiiLastSwap = now;
      }
      face = this._kawaiiFaces[this._kawaiiFaceIdx];
      this.i++;  // still advance for the gradient colour rotation
    } else {
      face = this.frames[this.i++ % this.frames.length];
    }
    // Sprint-2.9 — gradient sweep across the full label, not just the
    // spinner glyph. Each character of `this.text` gets a colour from
    // GRADIENT[(i + charIdx) % len] so the rainbow flows left→right with
    // every frame. Falls back to plain face+text when colour is off.
    let line;
    if (supportsColor) {
      const headColor = GRADIENT[this.i % GRADIENT.length];
      const txt = this.text || '';
      let painted = '';
      for (let k = 0; k < txt.length; k++) {
        const ch = txt[k];
        if (ch === ' ' || ch === '\t') {
          painted += ch;
        } else {
          const c = GRADIENT[(this.i + k) % GRADIENT.length];
          painted += `${c}${ch}`;
        }
      }
      line = `${headColor}${face}${RESET} ${painted}${RESET}`;
    } else {
      line = `${face} ${this.text}`;
    }
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

  // Welcome art — bigger framed wordmark rendered in the active accent
  // colour. Fades in line-by-line for cinematic feel. Always opt-out via
  // HORIZON_NO_ART=1 / --no-art / HORIZON_FAST=1.
  const art = renderArt('welcome');
  if (art) {
    process.stdout.write('\n');
    if (fast) {
      process.stdout.write(art + '\n\n');
    } else {
      const artLines = art.split('\n');
      for (const l of artLines) {
        process.stdout.write(l + '\n');
        await new Promise(r => setTimeout(r, 50));
      }
      process.stdout.write('\n');
      // Hold the big art for a beat before the wordmark cascades in.
      await new Promise(r => setTimeout(r, 600));
      // "ready when you are" beneath the art.
      process.stdout.write('  ' + fmt.dim('ready when you are') + '\n\n');
      await new Promise(r => setTimeout(r, 400));
    }
  }

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
    // Sprint-2.9 — heading gets a subtle bottom rule so groups visibly
    // separate from each other instead of just running into the next line.
    out.push(fmt.bold(heading));
    out.push(fmt.dim('  ' + '─'.repeat(Math.min(60, Math.max(8, visibleLen(heading) + 4)))));
    for (const [cmd, args, desc] of rows) {
      const cmdCol  = padVisible(cmd  || '', cmdW);
      const argsCol = padVisible(args || '', argsW);
      out.push(`${indent}${cmdCol}${' '.repeat(cmdGap)}${argsCol}${argsGap ? ' '.repeat(argsGap) : ''}${desc ? fmt.dim(desc) : ''}`);
    }
  }
  return out.join('\n') + '\n';
}

/**
 * Sprint-2.9 — generic rounded panel for command output. Replaces the
 * scattered hand-rolled boxes in agents/doctor/cost/insights with one
 * reusable helper that matches menu.js / modalOverlay / tool-card styling.
 *
 * panel({
 *   title: 'Horizon doctor',
 *   accent: 'cyan',           // any chalk-ish key: cyan|green|red|magenta|yellow
 *   lines: ['  ✓ provider OK', '  ✗ wake word missing'],
 *   width: 60,                // optional, default = terminal min(cols-4, 72)
 * }) => string with newlines
 */
function panel({ title, accent = 'cyan', lines = [], width } = {}) {
  const cols = process.stdout.columns || 80;
  const W = Math.max(20, Math.min(width || 72, cols - 4));
  const accentFn = (fmt[accent] || fmt.cyan);
  const out = [];
  if (title) {
    const titleStr = ' ' + title + ' ';
    const dashes = Math.max(2, W - visibleLen(titleStr) - 2);
    out.push(accentFn('╭─') + accentFn(titleStr) + accentFn('─'.repeat(dashes)));
  } else {
    out.push(accentFn('╭' + '─'.repeat(W - 1)));
  }
  for (const ln of lines) {
    // Each body line gets a rail prefix; the line's own visible width is
    // not enforced (caller controls truncation).
    out.push(accentFn('│ ') + ln);
  }
  out.push(accentFn('╰' + '─'.repeat(W - 1)));
  return out.join('\n');
}

/**
 * Sprint-2.9 — single-line "error card" replacement for fmt.err()
 * when a command catastrophically fails. Mirrors ART.error but takes a
 * runtime message and optional hint. Each block is 3 lines so it scans
 * as a unit, not as scattered red text.
 *
 * errorCard('No API key configured', 'Run: horizon setup');
 */
function errorCard(message, hint) {
  const msgStr = String(message || 'something exploded').trim();
  const hintStr = hint ? String(hint).trim() : '';
  const inner = Math.max(visibleLen(msgStr), visibleLen(hintStr)) + 4;
  const W = Math.min(72, Math.max(inner, 32));
  const lines = [];
  lines.push(fmt.red('  ╭─ ✗ ─') + fmt.red('─'.repeat(Math.max(0, W - 6))));
  lines.push(fmt.red('  │ ') + fmt.bold(msgStr));
  if (hintStr) {
    lines.push(fmt.red('  │ ') + fmt.dim(hintStr));
  }
  lines.push(fmt.red('  ╰' + '─'.repeat(W)));
  return lines.join('\n');
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

module.exports = { bannerBig, bannerCompact, bannerFramedBox, renderCollapsibleSection, GradientSpinner, typeOut, welcomeReveal, personaPickerInteractive, helpTable, panel, errorCard, stripAnsi, visibleLen, renderArt, animateArt, ART, ART_FRAMES, artSuppressed, buildGreetingBase, timeOfDayArt, GREETINGS };
