// `horizon theme [name]` — switch the CLI theme.
//
//   horizon theme              show active + list themes
//   horizon theme <name>       switch to <name>
//   horizon theme --list       list available themes
//
// Themes are defined in bin/lib/themes.js. Active theme is stored in
// settingsStore as 'cliTheme'.

const { fmt } = require('../tty');
const { listThemes, getTheme } = require('../themes');

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

  runtime.settingsStore.set('cliTheme', name);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, active: name }) + '\n');
  } else {
    process.stdout.write(fmt.ok('theme → ' + fmt.cyan(name)) + '\n');
  }
  return 0;
}

module.exports = { run };
