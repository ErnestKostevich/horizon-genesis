// `horizon theme [name]` — switch the CLI theme.
//
//   horizon theme              show active + list themes
//   horizon theme <name>       switch to <name>
//   horizon theme --list       list available themes
//
// Themes are defined in bin/lib/themes.js. Active theme is stored in
// settingsStore as 'cliTheme'.

const { fmt, supportsColor, supportsTruecolor, rgb } = require('../tty');
const { listThemes, getTheme } = require('../themes');

// Sprint 2.13 — paint a string in a specific theme's accent colour
// without flipping the global active theme. Used by the transition
// line in `horizon theme <name>` so the "switching..." text reads in
// the OLD palette and the "active" line in the NEW palette.
function _paintIn(themeName, text) {
  if (!supportsColor) return text;
  const t = getTheme(themeName);
  const acc = t && Array.isArray(t.accent) ? t.accent : [124, 109, 242];
  const RESET = '\x1b[0m';
  if (supportsTruecolor) return rgb(acc[0], acc[1], acc[2]) + text + RESET;
  return '\x1b[35m' + text + RESET;
}

function run({ runtime, args, flags }) {
  const themes = listThemes();
  const current = runtime.settingsStore.get('cliTheme') || 'default';

  if (flags.list || args[0] === 'list') {
    if (flags.json) {
      const detailed = themes.map((id) => {
        const t = getTheme(id);
        return { id, active: id === current, banner: t.banner, spinner: t.spinnerFrames[0] || '', description: t.description || '' };
      });
      process.stdout.write(JSON.stringify({ active: current, themes: detailed }) + '\n');
      return 0;
    }
    process.stdout.write(fmt.bold('Themes') + '\n');
    // Column-align: name column is widest theme id, glyph column is widest banner+spinner.
    const nameW = Math.max(...themes.map((id) => id.length));
    const glyphRaw = themes.map((id) => {
      const t = getTheme(id);
      return (t.banner || '') + ' ' + (t.spinnerFrames?.[0] || '');
    });
    const glyphW = Math.max(...glyphRaw.map((s) => s.length));
    themes.forEach((id, i) => {
      const t = getTheme(id);
      const active = id === current ? fmt.green(' ●') : '  ';
      const namePad = id + ' '.repeat(Math.max(0, nameW - id.length));
      const glyph = glyphRaw[i];
      const glyphPad = glyph + ' '.repeat(Math.max(0, glyphW - glyph.length));
      const desc = t.description ? fmt.dim('"' + t.description + '"') : '';
      process.stdout.write(`${active}  ${fmt.cyan(namePad)}  ${fmt.dim(glyphPad)}  ${desc}\n`);
    });
    process.stdout.write('\n' + fmt.dim('  Switch with: horizon theme <name>') + '\n');
    return 0;
  }

  const name = args[0];
  if (!name) {
    if (flags.json) {
      process.stdout.write(JSON.stringify({ active: current, themes }) + '\n');
      return 0;
    }
    process.stdout.write('active theme: ' + fmt.cyan(current) + '\n');
    process.stdout.write(fmt.dim('  available: ' + themes.join(', ')) + '\n');
    process.stdout.write(fmt.dim('  switch with: horizon theme <name>  ·  --list for details') + '\n');
    return 0;
  }

  if (!themes.includes(name)) {
    process.stderr.write(fmt.err(`unknown theme: ${name}`) + '\n');
    process.stderr.write(fmt.dim('  available: ' + themes.join(', ')) + '\n');
    return 2;
  }

  // Sprint 2.13 — small theme-switch transition. Print one line in the
  // OLD theme's accent palette, set the theme, then print the "active"
  // line in the NEW palette. Skipped in --json mode (machine consumers
  // don't want decoration) and in non-TTY pipes (no point colouring).
  const isPiped = !process.stdout.isTTY;
  if (!flags.json && !isPiped && name !== current) {
    process.stdout.write('  ' + _paintIn(current, '⌁') + ' '
                       + fmt.dim('switching to ') + _paintIn(current, name)
                       + fmt.dim(' theme...') + '\n');
  }

  runtime.settingsStore.set('cliTheme', name);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, active: name }) + '\n');
  } else if (!isPiped && name !== current) {
    process.stdout.write('  ' + _paintIn(name, '⌁') + ' '
                       + _paintIn(name, name) + fmt.dim(' active') + '\n');
  } else {
    process.stdout.write(fmt.ok('theme → ' + fmt.cyan(name)) + '\n');
  }
  return 0;
}

module.exports = { run };
