// `horizon persona [id]` — read or set the active persona.
//
//   horizon persona              → print current persona
//   horizon persona jarvis       → set active persona to jarvis
//   horizon persona --list       → list all personas + their tagline

const { fmt } = require('../tty');

async function run({ runtime, args, flags }) {
  const { settingsStore, personas } = runtime;
  if (!personas) {
    process.stderr.write(fmt.err('personas module not loaded') + '\n');
    return 1;
  }

  if (flags.list) {
    const list = personas.getAllPersonas?.() || [];
    if (flags.json) {
      process.stdout.write(JSON.stringify(list, null, 2) + '\n');
      return 0;
    }
    const active = settingsStore.get('persona') || 'jarvis';
    for (const p of list) {
      const star = p.id === active ? fmt.green('●') : ' ';
      process.stdout.write(`  ${star} ${fmt.cyan(p.id.padEnd(14))} ${fmt.dim(p.tagline || p.description || '')}\n`);
    }
    return 0;
  }

  const id = args[0];
  if (!id) {
    const current = settingsStore.get('persona') || 'jarvis';
    if (flags.json) {
      process.stdout.write(JSON.stringify({ persona: current }) + '\n');
      return 0;
    }
    process.stdout.write(fmt.cyan(current) + '\n');
    return 0;
  }

  // Validate against the list
  const all = personas.getAllPersonas?.() || [];
  if (all.length && !all.find(p => p.id === id)) {
    process.stderr.write(fmt.err('Unknown persona: ' + id) + '\n');
    process.stderr.write(fmt.dim('try --list to see options\n'));
    return 2;
  }
  settingsStore.set('persona', id);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, persona: id }) + '\n');
    return 0;
  }
  process.stdout.write(fmt.ok('persona → ' + fmt.cyan(id)) + '\n');
  return 0;
}

module.exports = { run };
