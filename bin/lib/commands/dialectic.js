// `horizon dialectic` — view + manage the 9th memory layer (Honcho-style
// diff log of what the agent has learned about you).
//
// Subcommands:
//   horizon dialectic                       — summary (default)
//   horizon dialectic recent [--limit N]    — latest records (newest first)
//   horizon dialectic search "query"        — substring across before/after
//   horizon dialectic clear [--tenant ID]   — wipe everything, or just one tenant
//   horizon dialectic summary               — same as no args

const { fmt } = require('../tty');

async function run({ runtime, args, flags }) {
  const sub = args[0] || 'summary';
  const rest = args.slice(1);
  if (sub === 'summary' || sub === 'stats')   return summary(runtime, flags);
  if (sub === 'recent'  || sub === 'list')    return recent(runtime, rest, flags);
  if (sub === 'search'  || sub === 'find')    return search(runtime, rest, flags);
  if (sub === 'clear'   || sub === 'wipe')    return clear(runtime, flags);

  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write('Try: summary | recent | search "query" | clear [--tenant ID]\n');
  return 2;
}

function _mustHaveModel(runtime) {
  if (!runtime.dialecticModel) {
    process.stderr.write(fmt.err('Dialectic model not initialised — make sure agentMemory loaded successfully.') + '\n');
    return false;
  }
  return true;
}

function summary(runtime, flags) {
  if (!_mustHaveModel(runtime)) return 1;
  const opts = flags.tenant ? { userId: flags.tenant } : (flags.all ? { userId: '*' } : {});
  const s = runtime.dialecticModel.summary(opts);
  if (flags.json) { process.stdout.write(JSON.stringify(s, null, 2) + '\n'); return 0; }
  process.stdout.write(fmt.bold('Dialectic model') + '\n');
  process.stdout.write(`  total          ${s.total}${s.grandTotal !== s.total ? ' (' + s.grandTotal + ' across all tenants)' : ''}\n`);
  process.stdout.write(`  cap            ${s.cap}\n`);
  if (s.byKind && Object.keys(s.byKind).length) {
    process.stdout.write(fmt.dim('  by kind:') + '\n');
    for (const [k, n] of Object.entries(s.byKind)) {
      process.stdout.write(`    ${fmt.cyan(k.padEnd(15))} ${n}\n`);
    }
  }
  if (s.byLevel) {
    process.stdout.write(fmt.dim('  by level:') + '\n');
    process.stdout.write(`    0 (user direct)        ${s.byLevel[0] || 0}\n`);
    process.stdout.write(`    1 (user → agent)       ${s.byLevel[1] || 0}\n`);
    process.stdout.write(`    2 (recursive)          ${s.byLevel[2] || 0}\n`);
  }
  if (s.tenants && s.tenants.length) {
    process.stdout.write(fmt.dim('  tenants:') + ' ' + s.tenants.join(', ') + '\n');
  }
  if (s.lastUpdatedAt) {
    process.stdout.write(fmt.dim('  last updated   ' + new Date(s.lastUpdatedAt).toLocaleString()) + '\n');
  }
  return 0;
}

function recent(runtime, rest, flags) {
  if (!_mustHaveModel(runtime)) return 1;
  const limit = Number(flags.limit || rest[0]) || 20;
  const opts = {};
  if (flags.tenant)        opts.userId = flags.tenant;
  if (flags.all)           opts.userId = '*';
  if (flags.level != null) opts.level  = Number(flags.level);
  const records = runtime.dialecticModel.getRecent(limit, opts);
  if (flags.json) { process.stdout.write(JSON.stringify(records, null, 2) + '\n'); return 0; }
  if (!records.length) {
    process.stdout.write(fmt.dim('No dialectic records yet — the agent emits one when it learns something new about you.\n'));
    return 0;
  }
  for (const r of records) {
    const colour = ({ belief: fmt.cyan, desire: fmt.red, knowledge: fmt.green, 'theory-of-mind': fmt.magenta, correction: fmt.yellow })[r.kind] || fmt.dim;
    process.stdout.write(`${fmt.dim(new Date(r.ts).toLocaleString())} ${colour('[' + r.kind + ']')} ${fmt.dim('L' + (r.level || 0))} ${r.after}\n`);
    if (r.before)   process.stdout.write(fmt.dim('   was: ' + r.before) + '\n');
    if (r.evidence) process.stdout.write(fmt.dim('   "' + r.evidence + '"') + '\n');
  }
  return 0;
}

function search(runtime, rest, flags) {
  if (!_mustHaveModel(runtime)) return 1;
  const query = rest.join(' ').trim();
  if (!query) {
    process.stderr.write(fmt.err('Need a query: horizon dialectic search "..."') + '\n');
    return 2;
  }
  const records = runtime.dialecticModel.search(query, Number(flags.limit) || 30, flags.tenant ? { userId: flags.tenant } : {});
  if (flags.json) { process.stdout.write(JSON.stringify(records, null, 2) + '\n'); return 0; }
  if (!records.length) {
    process.stdout.write(fmt.dim('no matches\n'));
    return 0;
  }
  for (const r of records) {
    const colour = ({ belief: fmt.cyan, desire: fmt.red, knowledge: fmt.green, 'theory-of-mind': fmt.magenta, correction: fmt.yellow })[r.kind] || fmt.dim;
    process.stdout.write(`${colour('[' + r.kind + ']')} ${r.after}\n`);
  }
  return 0;
}

function clear(runtime, flags) {
  if (!_mustHaveModel(runtime)) return 1;
  const opts = flags.tenant ? { userId: flags.tenant } : {};
  const r = runtime.dialecticModel.clear(opts);
  if (flags.json) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return 0; }
  process.stdout.write(fmt.ok(`✓ Removed ${r.removed || 0} dialectic record${r.removed === 1 ? '' : 's'}${flags.tenant ? ` for tenant ${flags.tenant}` : ''}.`) + '\n');
  return 0;
}

module.exports = { run };
