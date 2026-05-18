// Tiny argv parser — replaces yargs/commander for the CLI.
// We only need the patterns the plan calls for, so the surface stays
// small enough to read in one screen.
//
// Supports:
//   - positional args:    horizon agent "task here"
//   - boolean flags:      --reflect / --no-reflect / --stream
//   - value flags:        --model X / --model=X / -m X
//   - aliases:            -h → --help, -j → --json
//   - everything after `--` becomes a single positional payload
//
// Returns { _: [positional...], <flag>: value, ... }.

function parseArgv(argv, spec = {}) {
  const result = { _: [] };
  const aliases = spec.aliases || {};
  const booleans = new Set(spec.booleans || []);
  const negatables = new Set(spec.negatables || []);
  const i = { idx: 0 };

  const expand = (name) => aliases[name] || name;

  while (i.idx < argv.length) {
    const tok = argv[i.idx];
    if (tok === '--') {
      // Treat the rest as one positional payload (keeps quoted multi-arg
      // tasks intact even if the user forgets to quote)
      const rest = argv.slice(i.idx + 1).join(' ');
      if (rest) result._.push(rest);
      i.idx = argv.length;
      continue;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      let name, val;
      if (eq >= 0) {
        name = tok.slice(2, eq);
        val = tok.slice(eq + 1);
      } else {
        name = tok.slice(2);
        val = undefined;
      }
      // --no-foo → set foo=false if foo is a known negatable boolean
      if (name.startsWith('no-') && negatables.has(name.slice(3))) {
        result[expand(name.slice(3))] = false;
        i.idx += 1;
        continue;
      }
      if (booleans.has(name)) {
        result[expand(name)] = val === undefined ? true : val !== 'false';
      } else if (val !== undefined) {
        result[expand(name)] = val;
      } else {
        const next = argv[i.idx + 1];
        if (next !== undefined && !next.startsWith('-')) {
          result[expand(name)] = next;
          i.idx += 1;
        } else {
          result[expand(name)] = true;
        }
      }
      i.idx += 1;
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1) {
      // -m X or -mX
      const name = tok.slice(1, 2);
      const inline = tok.slice(2);
      const expanded = expand(name);
      if (booleans.has(name) || booleans.has(expanded)) {
        result[expanded] = true;
        if (inline) {
          // collapsed boolean group like -jh → -j -h
          for (const c of inline) {
            const cExp = expand(c);
            if (booleans.has(c) || booleans.has(cExp)) result[cExp] = true;
          }
        }
        i.idx += 1;
        continue;
      }
      if (inline) {
        result[expanded] = inline;
      } else {
        const next = argv[i.idx + 1];
        if (next !== undefined && !next.startsWith('-')) {
          result[expanded] = next;
          i.idx += 1;
        } else {
          result[expanded] = true;
        }
      }
      i.idx += 1;
      continue;
    }
    result._.push(tok);
    i.idx += 1;
  }
  return result;
}

module.exports = { parseArgv };
