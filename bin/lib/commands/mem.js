// `horizon mem <subcommand>` — memory ops.
//
// Subcommands:
//   horizon mem search "query"             — keyword + semantic recall
//   horizon mem dump [--type X]            — export as NDJSON to stdout
//   horizon mem profile                    — print User Profile (Big Five etc.)
//   horizon mem forget --memory <id>       — delete one memory
//   horizon mem forget --fact <key>        — delete one fact
//   horizon mem stats                      — summary counts + embedding state
//   horizon mem migrate                    — mirror JSON memory to SQLite+FTS5
//   horizon mem sqlite-status              — show row counts in the SQLite mirror
//   horizon mem review                     — agent-curated pass (decay/dedupe/forget)

const { fmt } = require('../tty');

async function run({ runtime, args, flags }) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'search') return search(runtime, rest, flags);
  if (sub === 'dump')    return dump(runtime, flags);
  if (sub === 'profile') return profile(runtime, flags);
  if (sub === 'forget')  return forget(runtime, flags);
  if (sub === 'migrate') return migrate(runtime, flags);
  if (sub === 'sqlite-status') return sqliteStatus(runtime, flags);
  if (sub === 'review')  return review(runtime, flags);
  if (sub === 'stats' || !sub) return stats(runtime, flags);

  process.stderr.write(fmt.err(`Unknown mem subcommand: ${sub}`) + '\n');
  process.stderr.write('Try: search | dump | profile | forget | stats | migrate | sqlite-status | review\n');
  return 2;
}

async function review(runtime, flags) {
  let MemoryReviewer;
  try { ({ MemoryReviewer } = require('../../../src/main/memoryReviewer')); }
  catch (e) {
    process.stderr.write(fmt.err('memoryReviewer module unavailable: ' + e.message) + '\n');
    return 2;
  }
  const rev = new MemoryReviewer(runtime.agentMemory);
  const result = await rev.reviewNow();
  if (flags.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return result.ok ? 0 : 1; }
  if (!result.ok) {
    process.stderr.write(fmt.err('Review failed: ' + (result.error || 'unknown')) + '\n');
    return 1;
  }
  if (result.skipped) {
    process.stdout.write(fmt.dim(`Skipped — ${result.skipped} (memories: ${result.count || 0})\n`));
    return 0;
  }
  process.stdout.write(fmt.bold('Memory review pass') + '\n');
  process.stdout.write(`  reviewed   ${result.reviewed}\n`);
  process.stdout.write(`  decayed    ${result.decayed}\n`);
  process.stdout.write(`  merged     ${result.merged}\n`);
  process.stdout.write(`  forgotten  ${result.forgotten}\n`);
  process.stdout.write(`  survivors  ${result.survivors}\n`);
  return 0;
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

// PHASE 28 — SQLite + FTS5 mirror. The JSON file stays the source of
// truth; the SQLite DB lives alongside it for richer queries.
function _sqlitePaths(runtime) {
  const path = require('path');
  const ud = runtime.userDataDir || runtime.profileDir;
  if (!ud) throw new Error('runtime is missing a userDataDir');
  return {
    jsonPath: runtime.memoryPath || path.join(ud, 'memory.json'),
    dbPath:   path.join(ud, 'memory.sqlite'),
  };
}

function migrate(runtime, flags) {
  let paths;
  try { paths = _sqlitePaths(runtime); }
  catch (e) { process.stderr.write(fmt.err(e.message) + '\n'); return 2; }
  let migrateJsonToSqlite;
  try {
    ({ migrateJsonToSqlite } = require('../../../src/main/runtime/migrateJsonToSqlite'));
  } catch (e) {
    process.stderr.write(fmt.err('migrate module unavailable: ' + e.message) + '\n');
    return 2;
  }
  const result = migrateJsonToSqlite(paths);
  if (flags.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return result.ok ? 0 : 1; }
  if (!result.ok) {
    process.stderr.write(fmt.err('Migration failed: ' + result.error) + '\n');
    if (/better-sqlite3/.test(result.error || '')) {
      process.stderr.write(fmt.dim('Hint: run `npm run rebuild:native` in the app folder.') + '\n');
    }
    return 1;
  }
  const a = result.added || {};
  process.stdout.write(fmt.ok(`✓ Mirrored to ${result.dbPath}`) + '\n');
  process.stdout.write(`  + ${a.memories || 0} memories\n`);
  process.stdout.write(`  + ${a.facts || 0} facts\n`);
  process.stdout.write(`  + ${a.conversations || 0} conversations\n`);
  if (result.backupPath) process.stdout.write(fmt.dim(`  prev DB backed up to ${result.backupPath}\n`));
  return 0;
}

function sqliteStatus(runtime, flags) {
  let paths;
  try { paths = _sqlitePaths(runtime); }
  catch (e) { process.stderr.write(fmt.err(e.message) + '\n'); return 2; }
  const fs = require('fs');
  if (!fs.existsSync(paths.dbPath)) {
    if (flags.json) { process.stdout.write(JSON.stringify({ exists: false, dbPath: paths.dbPath }) + '\n'); return 0; }
    process.stdout.write(fmt.dim('SQLite mirror not created yet. Run `horizon mem migrate` to mirror your memory.\n'));
    process.stdout.write(fmt.dim(`Will write to: ${paths.dbPath}\n`));
    return 0;
  }
  let MemoryDb;
  try { ({ MemoryDb } = require('../../../src/main/memoryDb')); }
  catch (e) { process.stderr.write(fmt.err('memoryDb unavailable: ' + e.message) + '\n'); return 1; }
  try {
    const db = new MemoryDb(paths.dbPath).open();
    const stats = db.stats();
    db.close();
    if (flags.json) { process.stdout.write(JSON.stringify({ exists: true, dbPath: paths.dbPath, stats }) + '\n'); return 0; }
    process.stdout.write(fmt.bold('SQLite mirror') + ` ${fmt.dim('· ' + paths.dbPath)}\n`);
    process.stdout.write(`  memories       ${stats.memories}\n`);
    process.stdout.write(`  facts          ${stats.facts}\n`);
    process.stdout.write(`  conversations  ${stats.conversations}\n`);
    process.stdout.write(fmt.dim(`  schema v${stats.schema}\n`));
    return 0;
  } catch (e) {
    process.stderr.write(fmt.err('Status failed: ' + e.message) + '\n');
    return 1;
  }
}

module.exports = { run };
