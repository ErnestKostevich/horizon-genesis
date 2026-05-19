// `horizon sessions` — multi-chat history in the CLI.
//
// Sessions are file-backed under <userData>/sessions/<id>.jsonl. Each
// line is one turn { at, role, content, model, usage }. We DON'T reuse
// the Electron app's chatStore — it lives in horizon_chats.json with a
// schema tuned for the renderer's needs. A flatter JSONL layout is more
// natural for the CLI (tail, grep, jq friendly).
//
// Subcommands:
//   horizon sessions                — list
//   horizon sessions new [--name X] — start a new session, prints id
//   horizon sessions show <id>      — print contents
//   horizon sessions export <id>    — dump as NDJSON to stdout
//   horizon sessions delete <id>
//   horizon sessions rename <id> <new-name>
//   horizon sessions stats          — counts + tokens per session
//
// `horizon chat` and `horizon` (TUI) get a --session <id> flag to
// append into a named session instead of in-memory.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fmt, promptYesNo } = require('../tty');

function sessionsDir(userDataDir) {
  const d = path.join(userDataDir, 'sessions');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

function listAll(userDataDir) {
  const d = sessionsDir(userDataDir);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const full = path.join(d, f);
      const stat = fs.statSync(full);
      const id = f.replace(/\.jsonl$/, '');
      let firstLine = '';
      try {
        const r = fs.readFileSync(full, 'utf8');
        firstLine = r.split('\n', 1)[0];
      } catch (_) {}
      let meta = {};
      try { meta = JSON.parse(firstLine); } catch (_) {}
      return {
        id,
        name: meta.name || id,
        createdAt: meta.createdAt || stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function run({ runtime, args, flags }) {
  const sub = args[0] || 'list';
  const rest = args.slice(1);
  const userDataDir = runtime.userDataDir;

  if (sub === 'list') return list(userDataDir, flags);
  if (sub === 'new')  return newSession(userDataDir, flags);
  if (sub === 'show') return show(userDataDir, rest, flags);
  if (sub === 'export') return exportNdjson(userDataDir, rest);
  if (sub === 'delete' || sub === 'rm') return del(userDataDir, rest, flags);
  if (sub === 'rename') return rename(userDataDir, rest);
  if (sub === 'stats') return stats(userDataDir, flags);

  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write('Try: list | new | show <id> | export <id> | delete <id> | rename <id> <name> | stats\n');
  return 2;
}

function list(userDataDir, flags) {
  const items = listAll(userDataDir);
  if (flags.json) { process.stdout.write(JSON.stringify(items, null, 2) + '\n'); return 0; }
  if (!items.length) {
    process.stdout.write(fmt.dim('\n  no sessions yet · create one with horizon sessions new\n\n'));
    return 0;
  }
  process.stdout.write('\n' + fmt.bold('Sessions') + '\n\n');
  for (const it of items) {
    process.stdout.write(`  ${fmt.cyan(it.id.padEnd(20))} ${fmt.bold(it.name.padEnd(28))} ${fmt.dim(it.updatedAt.slice(0, 16) + '  ' + (it.sizeBytes < 1024 ? it.sizeBytes + 'B' : Math.round(it.sizeBytes/1024) + 'KB'))}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

function newSession(userDataDir, flags) {
  const id = 'sess-' + crypto.randomBytes(4).toString('hex');
  const name = flags.name || ('session ' + new Date().toLocaleString());
  const file = path.join(sessionsDir(userDataDir), id + '.jsonl');
  const meta = { at: new Date().toISOString(), kind: 'meta', name, createdAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(meta) + '\n', 'utf8');
  if (flags.json) { process.stdout.write(JSON.stringify({ id, name, file }) + '\n'); return 0; }
  process.stdout.write(fmt.ok('created ' + fmt.cyan(id)) + '\n');
  process.stdout.write(fmt.dim('  pass --session ' + id + ' to horizon chat to append to it') + '\n');
  return 0;
}

function show(userDataDir, rest, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('id required') + '\n'); return 2; }
  const file = path.join(sessionsDir(userDataDir), id + '.jsonl');
  if (!fs.existsSync(file)) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch (_) { continue; }
    if (e.kind === 'meta') continue;
    if (flags.json) { process.stdout.write(l + '\n'); continue; }
    const tag = e.role === 'user' ? fmt.cyan('user') : fmt.green('horizon');
    const when = e.at ? fmt.dim('[' + e.at.slice(11, 16) + ']') : '';
    process.stdout.write(`${tag} ${when}\n${e.content || ''}\n\n`);
  }
  return 0;
}

function exportNdjson(userDataDir, rest) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('id required') + '\n'); return 2; }
  const file = path.join(sessionsDir(userDataDir), id + '.jsonl');
  if (!fs.existsSync(file)) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  return 0;
}

async function del(userDataDir, rest, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('id required') + '\n'); return 2; }
  const file = path.join(sessionsDir(userDataDir), id + '.jsonl');
  if (!fs.existsSync(file)) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  if (!flags.yes) {
    const ok = await promptYesNo(fmt.cyan(`  delete session ${id}? y/N:`));
    if (!ok) { process.stdout.write(fmt.dim('cancelled\n')); return 0; }
  }
  fs.unlinkSync(file);
  process.stdout.write(fmt.ok('deleted ' + id) + '\n');
  return 0;
}

function rename(userDataDir, rest) {
  const id = rest[0];
  const newName = rest.slice(1).join(' ');
  if (!id || !newName) { process.stderr.write(fmt.err('Usage: horizon sessions rename <id> <new-name>') + '\n'); return 2; }
  const file = path.join(sessionsDir(userDataDir), id + '.jsonl');
  if (!fs.existsSync(file)) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return 1;
  let meta;
  try { meta = JSON.parse(lines[0]); } catch (_) { return 1; }
  if (meta.kind !== 'meta') {
    // Insert meta at top
    meta = { at: new Date().toISOString(), kind: 'meta', name: newName, createdAt: new Date().toISOString() };
    lines.unshift(JSON.stringify(meta));
  } else {
    meta.name = newName;
    lines[0] = JSON.stringify(meta);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  process.stdout.write(fmt.ok('renamed → ' + newName) + '\n');
  return 0;
}

function stats(userDataDir, flags) {
  const items = listAll(userDataDir);
  let totalTurns = 0;
  let totalTokens = 0;
  for (const it of items) {
    const file = path.join(sessionsDir(userDataDir), it.id + '.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    it.turns = 0; it.tokens = 0;
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (e.kind === 'meta') continue;
        it.turns++; totalTurns++;
        if (e.usage?.total) { it.tokens += e.usage.total; totalTokens += e.usage.total; }
      } catch (_) {}
    }
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({ total: items.length, totalTurns, totalTokens, sessions: items }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write('\n' + fmt.bold('Sessions stats') + '\n\n');
  process.stdout.write(`  ${fmt.cyan(items.length + '')} sessions, ${fmt.cyan(totalTurns + '')} turns, ${fmt.green(totalTokens.toLocaleString() + ' tokens')}\n\n`);
  for (const it of items.slice(0, 10)) {
    process.stdout.write(`  ${fmt.cyan(it.id.padEnd(20))} ${fmt.dim(String(it.turns).padStart(3) + ' turns · ' + it.tokens.toLocaleString().padStart(8) + ' tokens')}  ${it.name}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

module.exports = { run, sessionsDir, listAll };
