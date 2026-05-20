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
  },
};

function listThemes() {
  return Object.keys(THEMES);
}

function getTheme(name) {
  return THEMES[name] || THEMES.default;
}

module.exports = { THEMES, listThemes, getTheme };
