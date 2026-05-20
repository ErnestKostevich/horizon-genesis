// Fix 8 — CLI themes / skins.
//
// Named themes that the CLI/TUI uses for accent colours, status colours,
// and spinner frames. Active theme is read from settingsStore.get('cliTheme')
// (defaulting to 'default') and is consulted by bin/lib/tty.js's
// fmt helpers.
//
// Each theme exposes:
//   - accent     : [r, g, b]  primary accent (banner glyph, prompt arrow)
//   - success    : [r, g, b]  success/ok colour
//   - warn       : [r, g, b]  warning colour
//   - err        : [r, g, b]  error colour
//   - dim        : [r, g, b]  dim/grey text
//   - spinnerFrames : string[]  spinner animation frames
//   - banner     : string     small glyph used in the wordmark
//   - description: string     one-line blurb for `horizon theme --list`
//
// Note: colours are pure RGB so theme honours supportsTruecolor. Themes
// fall back to standard ANSI escape codes when truecolor isn't available
// (see fmt in tty.js).

const THEMES = {
  default: {
    accent:  [124, 109, 242],   // #7c6df2 — deep blue-violet
    success: [56, 211, 159],
    warn:    [255, 181, 102],
    err:     [255, 117, 117],
    dim:     [128, 128, 128],
    cyan:    [56, 189, 248],
    magenta: [217, 70, 239],
    spinnerFrames: ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'],
    banner: '⌁',
    description: 'Deep blue-violet — between Linear and Vercel.',
  },
  mono: {
    accent:  [200, 200, 200],
    success: [220, 220, 220],
    warn:    [180, 180, 180],
    err:     [255, 255, 255],
    dim:     [110, 110, 110],
    cyan:    [200, 200, 200],
    magenta: [220, 220, 220],
    spinnerFrames: ['|','/','-','\\'],
    banner: '·',
    description: 'Pure monochrome for serious work.',
  },
  light: {
    accent:  [88, 28, 135],     // dark violet on a light bg
    success: [22, 101, 52],
    warn:    [161, 98, 7],
    err:     [153, 27, 27],
    dim:     [82, 82, 82],
    cyan:    [21, 94, 117],
    magenta: [134, 25, 143],
    bg:      'light',
    spinnerFrames: ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'],
    banner: '⌁',
    description: 'Daylight palette for light terminals.',
  },
  kawaii: {
    accent:  [255, 105, 180],   // hot pink
    success: [255, 175, 200],
    warn:    [255, 215, 102],
    err:     [255, 105, 130],
    dim:     [200, 160, 180],
    cyan:    [255, 182, 193],
    magenta: [255, 105, 180],
    spinnerFrames: ['(◕ᴗ◕)', '(◕ᴗ◕✿)', '(✿◕ᴗ◕)', '(◕‿◕✿)'],
    banner: '✿',
    description: 'Pink kaomoji spinners, ASCII cuteness.',
  },
  matrix: {
    accent:  [0, 255, 0],       // #00ff00 — bright green
    success: [0, 255, 0],
    warn:    [255, 220, 0],
    err:     [255, 60, 60],
    dim:     [0, 120, 0],
    cyan:    [120, 255, 120],
    magenta: [180, 255, 180],
    spinnerFrames: ['⣾','⣽','⣻','⢿','⡿','⣟','⣯','⣷'],
    banner: '▮',
    description: 'Matrix-style. Green on black, code-rain spinner.',
  },
  'retro-amber': {
    accent:  [255, 176, 0],     // #ffb000 — amber
    success: [255, 200, 70],
    warn:    [255, 140, 0],
    err:     [255, 100, 60],
    dim:     [140, 90, 0],
    cyan:    [255, 200, 140],
    magenta: [255, 170, 80],
    spinnerFrames: ['◐','◓','◑','◒'],
    banner: '▰',
    description: 'Retro-amber CRT. 80s monochrome warmth.',
  },
  vapor: {
    accent:  [255, 64, 192],    // hot pink
    success: [64, 224, 208],    // cyan turquoise
    warn:    [255, 196, 64],
    err:     [255, 80, 120],
    dim:     [140, 60, 140],
    cyan:    [64, 224, 255],
    magenta: [255, 100, 220],
    spinnerFrames: ['◜','◠','◝','◞','◡','◟'],
    banner: '◈',
    description: 'Synthwave vapor. Hot pink + neon cyan.',
  },
  mocha: {
    accent:  [203, 166, 247],   // #cba6f7 — Catppuccin mauve
    success: [166, 227, 161],   // Catppuccin green
    warn:    [249, 226, 175],   // Catppuccin yellow
    err:     [243, 139, 168],   // Catppuccin red
    dim:     [127, 132, 156],   // Catppuccin overlay-0
    cyan:    [148, 226, 213],   // Catppuccin teal
    magenta: [245, 194, 231],   // Catppuccin pink
    spinnerFrames: ['☕','✦','♥','✦'],
    banner: '❀',
    description: 'Catppuccin Mocha. Warm cream tones.',
  },
};

function listThemes() {
  return Object.keys(THEMES);
}

function getTheme(name) {
  return THEMES[name] || THEMES.default;
}

// Sprint 2 — Hermes-style status bar v2.
// Per-model max context windows. The lookup is prefix-based so 'claude-sonnet'
// matches 'claude-sonnet-4-20250514', 'claude-sonnet-4-6-preview', etc.
// Update when providers ship new context sizes.
const CTX_BY_MODEL = {
  // Anthropic
  'claude-sonnet':       200000,
  'claude-opus':         200000,
  'claude-haiku':        200000,
  'claude-3-5':          200000,
  'claude-3':            200000,
  // OpenAI
  'gpt-5':               400000,
  'gpt-4o':              128000,
  'gpt-4-turbo':         128000,
  'gpt-4':               8192,
  'gpt-3.5':             16385,
  'o1':                  128000,
  'o3':                  200000,
  'o4':                  128000,
  // Google Gemini
  'gemini-3':            1000000,
  'gemini-2.5-pro':      2000000,
  'gemini-2.5-flash':    1000000,
  'gemini-1.5-pro':      2000000,
  'gemini-1.5-flash':    1000000,
  // Mistral
  'mistral-large':       128000,
  'mistral-medium':      32000,
  'mistral-small':       32000,
  'codestral':           32000,
  // Meta Llama
  'llama-3.3':           128000,
  'llama-3.1-70b':       128000,
  'llama-3.1-8b':        128000,
  'llama3.1':            128000,
  'meta-llama/Llama-3':  128000,
  // DeepSeek
  'deepseek-chat':       64000,
  'deepseek-reasoner':   64000,
  // Qwen
  'qwen3':               128000,
  'qwen-plus':           128000,
  'qwen2.5':             128000,
  // Grok
  'grok-4':              256000,
  'grok-code':           256000,
  // Cohere
  'command-a':           128000,
  // Groq-hosted
  'openai/gpt-oss':      128000,
  'moonshotai/kimi':     200000,
  // Moonshot
  'kimi-k2':             200000,
  'moonshot-v1-8k':      8000,
  // Z.AI
  'glm-4':               128000,
  // Perplexity
  'sonar':               127000,
  // Local fallback (Ollama / LM Studio / generic)
  'gemma':               8192,
  'local-model':         32000,
  _default:              32000,
};

function ctxFor(model) {
  if (!model) return CTX_BY_MODEL._default;
  // Strip provider prefix like "openai/gpt-4o" → check both forms.
  for (const key of Object.keys(CTX_BY_MODEL)) {
    if (key === '_default') continue;
    if (model.startsWith(key)) return CTX_BY_MODEL[key];
  }
  // Try after slash
  const tail = model.split('/').pop();
  for (const key of Object.keys(CTX_BY_MODEL)) {
    if (key === '_default') continue;
    if (tail && tail.startsWith(key)) return CTX_BY_MODEL[key];
  }
  return CTX_BY_MODEL._default;
}

module.exports = { THEMES, listThemes, getTheme, CTX_BY_MODEL, ctxFor };
