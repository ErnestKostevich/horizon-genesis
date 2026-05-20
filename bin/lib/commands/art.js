// `horizon art [name]` — preview the Hermes-style ASCII art pieces.
//
// Useful for screenshots, demos, theme tuning, and reassuring users that
// the decorative moments are opt-out (HORIZON_NO_ART=1 / --no-art).
//
// Usage:
//   horizon art                 list available art pieces with previews
//   horizon art welcome         render just the welcome art
//   horizon art --list          print piece names, no rendering

const { fmt } = require('../tty');
const { ART, renderArt } = require('../banner');

function run({ args, flags }) {
  const names = Object.keys(ART);
  const name = (args[0] || '').trim();

  if (flags.list) {
    for (const n of names) process.stdout.write(n + '\n');
    return 0;
  }

  if (name) {
    if (!names.includes(name)) {
      process.stderr.write(fmt.err(`unknown art piece "${name}"`) + '\n');
      process.stderr.write(fmt.dim('  available: ' + names.join(', ')) + '\n');
      return 2;
    }
    const out = renderArt(name, { tag: flags.tag || '', flags });
    if (!out) {
      process.stdout.write(fmt.dim('(art suppressed — try without HORIZON_NO_ART / --no-art / --quiet)') + '\n');
      return 0;
    }
    process.stdout.write('\n' + out + '\n\n');
    return 0;
  }

  // List mode — render every piece with its name as a header.
  process.stdout.write('\n' + fmt.bold('  Horizon ASCII art gallery') + '\n');
  process.stdout.write(fmt.dim('  Opt out anytime with HORIZON_NO_ART=1 or --no-art') + '\n');
  for (const n of names) {
    process.stdout.write('\n  ' + fmt.cyan(n) + '\n');
    const out = renderArt(n, { tag: '', flags });
    if (out) process.stdout.write(out + '\n');
  }
  process.stdout.write('\n');
  return 0;
}

module.exports = { run };
