// `horizon backup` — snapshot or restore the user-data folder.
//
//   horizon backup            — snapshot the whole userData dir
//   horizon backup list       — list available snapshots
//   horizon backup restore <id>  — restore named snapshot
//   horizon backup prune --keep N  — keep only the most recent N

const fs = require('fs');
const path = require('path');
const { fmt, promptYesNo } = require('../tty');

const FILES_TO_BACKUP = [
  'horizon-settings.json',
  'horizon-keys.json',
  'horizon_memory.json',
  'horizon_embeddings.json',
  'horizon-cost.jsonl',
  'horizon_chats.json',
  'active-profile.txt',
];

function backupRoot(userDataDir) {
  const r = path.join(userDataDir, 'backups');
  try { fs.mkdirSync(r, { recursive: true }); } catch (_) {}
  return r;
}

function listSnapshots(userDataDir) {
  const r = backupRoot(userDataDir);
  if (!fs.existsSync(r)) return [];
  return fs.readdirSync(r)
    .filter(f => f.startsWith('snap-'))
    .map(f => {
      const full = path.join(r, f);
      const stat = fs.statSync(full);
      return { id: f, dir: full, createdAt: stat.mtime.toISOString(), sizeBytes: dirSize(full) };
    })
    .sort((a, b) => b.id.localeCompare(a.id));
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (st.isFile()) total += st.size;
      else if (st.isDirectory()) total += dirSize(full);
    }
  } catch (_) {}
  return total;
}

async function run({ runtime, args, flags }) {
  const sub = args[0] || 'snapshot';
  if (sub === 'list') return list(runtime, flags);
  if (sub === 'prune') return prune(runtime, flags);
  if (sub === 'restore') return restore(runtime, args.slice(1), flags);
  if (sub === 'snapshot' || sub === 'create') return snapshot(runtime, flags);

  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write('Try: snapshot | list | restore <id> | prune --keep N\n');
  return 2;
}

function snapshot(runtime, flags) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = 'snap-' + ts;
  const dest = path.join(backupRoot(runtime.userDataDir), id);
  fs.mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const f of FILES_TO_BACKUP) {
    const src = path.join(runtime.userDataDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dest, f));
      copied.push(f);
    }
  }
  // Also copy skills/ and plugins/ recursively
  for (const sub of ['skills', 'plugins']) {
    const src = path.join(runtime.userDataDir, sub);
    if (fs.existsSync(src)) {
      const dst = path.join(dest, sub);
      copyDirSync(src, dst);
      copied.push(sub + '/');
    }
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({ id, dest, copied }) + '\n');
    return 0;
  }
  process.stdout.write(fmt.ok(`snapshot ${fmt.cyan(id)}`) + '\n');
  process.stdout.write(fmt.dim('  ' + dest) + '\n');
  process.stdout.write(fmt.dim('  ' + copied.length + ' files copied') + '\n');
  return 0;
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const a = path.join(src, f);
    const b = path.join(dst, f);
    const st = fs.statSync(a);
    if (st.isDirectory()) copyDirSync(a, b);
    else if (st.isFile()) fs.copyFileSync(a, b);
  }
}

function list(runtime, flags) {
  const snaps = listSnapshots(runtime.userDataDir);
  if (flags.json) { process.stdout.write(JSON.stringify(snaps, null, 2) + '\n'); return 0; }
  if (!snaps.length) {
    process.stdout.write(fmt.dim('\n  no snapshots yet · create one with horizon backup\n\n'));
    return 0;
  }
  process.stdout.write('\n' + fmt.bold('Snapshots') + '\n\n');
  for (const s of snaps) {
    const mb = Math.round(s.sizeBytes / 1024 / 1024 * 10) / 10;
    process.stdout.write(`  ${fmt.cyan(s.id.padEnd(34))} ${fmt.dim(s.createdAt.slice(0, 19) + '  ' + mb + ' MB')}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

async function restore(runtime, rest, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('snapshot id required') + '\n'); return 2; }
  const dir = path.join(backupRoot(runtime.userDataDir), id);
  if (!fs.existsSync(dir)) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  if (!flags.yes) {
    process.stderr.write(fmt.warn('This overwrites the current settings/keys/memory with the snapshot.') + '\n');
    const ok = await promptYesNo(fmt.cyan('  proceed? y/N:'));
    if (!ok) { process.stdout.write(fmt.dim('cancelled\n')); return 0; }
  }
  for (const f of FILES_TO_BACKUP) {
    const src = path.join(dir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(runtime.userDataDir, f));
    }
  }
  for (const sub of ['skills', 'plugins']) {
    const src = path.join(dir, sub);
    if (fs.existsSync(src)) {
      const dst = path.join(runtime.userDataDir, sub);
      copyDirSync(src, dst);
    }
  }
  process.stdout.write(fmt.ok('restored ' + id) + '\n');
  process.stdout.write(fmt.dim('  restart any running horizon process to pick up changes\n'));
  return 0;
}

function prune(runtime, flags) {
  const keep = Number(flags.keep || 5);
  const snaps = listSnapshots(runtime.userDataDir);
  const toRemove = snaps.slice(keep);
  for (const s of toRemove) {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
  process.stdout.write(fmt.ok(`pruned ${toRemove.length}, kept ${Math.min(keep, snaps.length)}`) + '\n');
  return 0;
}

module.exports = { run };
