// `horizon mem <subcommand>` — memory ops.
//
// Subcommands:
//   horizon mem search "query"             — keyword + semantic recall
//   horizon mem dump [--type X]            — export as NDJSON to stdout
//   horizon mem profile                    — print User Profile (Big Five etc.)
//   horizon mem forget --memory <id>       — delete one memory
//   horizon mem forget --fact <key>        — delete one fact
//   horizon mem stats                      — summary counts + embedding state

const { fmt } = require('../tty');

async function run({ runtime, args, flags }) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'search') return search(runtime, rest, flags);
  if (sub === 'dump')    return dump(runtime, flags);
  if (sub === 'profile') return profile(runtime, flags);
  if (sub === 'forget')  return forget(runtime, flags);
  if (sub === 'stats' || !sub) return stats(runtime, flags);

  process.stderr.write(fmt.err(`Unknown mem subcommand: ${sub}`) + '\n');
  process.stderr.write('Try: search | dump | profile | forget | stats\n');
  return 2;
}

async function search(runtime, rest, flags) {
  const query = rest.join(' ').trim();
  if (!query) {
    process.stderr.write(fmt.err('Need a query: horizon mem search "..."') + '\n');
    return 2;
  }
  const limit = Number(flags.limit || 10);
  let results;
  if (flags.semantic !== false) {
    results = await runtime.agentMemory.semanticRecall(query, limit, {});
  } else {
    results = runtime.agentMemory.recall(query, limit);
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    return 0;
  }
  if (!results.length) {
    process.stdout.write(fmt.dim('no matches\n'));
    return 0;
  }
  for (const m of results) {
    const score = typeof m.score === 'number' ? fmt.dim(`(${m.score.toFixed(2)}) `) : '';
    const ts = m.timestamp ? fmt.dim(new Date(m.timestamp).toLocaleString() + ' · ') : '';
    process.stdout.write(`${score}${ts}${m.content || m.text || JSON.stringify(m)}\n`);
  }
  return 0;
}

function dump(runtime, flags) {
  const type = flags.type || 'all';
  const data = runtime.agentMemory._data || {};
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

  if (type === 'facts' || type === 'all') {
    for (const [key, val] of Object.entries(data.facts || {})) {
      emit({ kind: 'fact', key, ...val });
    }
  }
  if (type === 'memories' || type === 'all') {
    for (const m of (data.memories || [])) emit({ kind: 'memory', ...m });
  }
  if (type === 'conversations' || type === 'all') {
    for (const c of (data.conversations || [])) emit({ kind: 'conversation', ...c });
  }
  return 0;
}

function profile(runtime, flags) {
  const p = runtime.agentMemory.getUserProfile();
  if (flags.json) {
    process.stdout.write(JSON.stringify(p, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(fmt.bold('User profile') + '\n');
  process.stdout.write(JSON.stringify(p, null, 2) + '\n');
  return 0;
}

function forget(runtime, flags) {
  if (flags.memory) {
    const ok = runtime.agentMemory.forgetMemory(flags.memory);
    if (ok) process.stdout.write(fmt.ok('forgot memory ' + flags.memory) + '\n');
    else process.stderr.write(fmt.err('no such memory id') + '\n');
    return ok ? 0 : 1;
  }
  if (flags.fact) {
    const ok = runtime.agentMemory.forgetMemory(flags.fact);
    if (ok) process.stdout.write(fmt.ok('forgot fact ' + flags.fact) + '\n');
    else process.stderr.write(fmt.err('no such fact key') + '\n');
    return ok ? 0 : 1;
  }
  process.stderr.write(fmt.err('Need --memory <id> or --fact <key>') + '\n');
  return 2;
}

function stats(runtime, flags) {
  const d = runtime.agentMemory._data || {};
  const emb = runtime.embeddingService?.status() || { available: false };
  const out = {
    memories: d.memories?.length || 0,
    facts: Object.keys(d.facts || {}).length,
    conversations: d.conversations?.length || 0,
    embeddings: emb,
    profile: !!d.userProfile,
  };
  if (flags.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(fmt.bold('Memory stats') + '\n');
  process.stdout.write(`  memories       ${out.memories}\n`);
  process.stdout.write(`  facts          ${out.facts}\n`);
  process.stdout.write(`  conversations  ${out.conversations}\n`);
  if (emb.available) {
    process.stdout.write(`  embeddings     ${fmt.green('ready')} ${fmt.dim('(' + emb.provider + ', ' + emb.indexed + ' indexed)')}\n`);
  } else {
    process.stdout.write('  embeddings     ' + fmt.dim('no key (keyword + FTS only)') + '\n');
  }
  return 0;
}

module.exports = { run };
