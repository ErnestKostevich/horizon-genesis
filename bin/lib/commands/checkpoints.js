// `horizon checkpoints` — save/list/restore agent memory snapshots.
//
// Different from `horizon backup` (which snapshots the whole userData):
// a checkpoint is just a stamped copy of horizon_memory.json so you can
// rewind to "before that agent run wiped my preferences".

const fs = require('fs');
const path = require('path');
const { fmt, promptYesNo } = require('../tty');

function checkpointsDir(userDataDir) {
  const d = path.join(userDataDir, 'checkpoints');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

async function run({ runtime, args, flags }) {
  const sub = args[0] || 'list';
  const rest = args.slice(1);
  if (sub === 'save' || sub === 'create')  return save(runtime, flags);
  if (sub === 'list')                       return list(runtime, flags);
  if (sub === 'restore')                    return restore(runtime, rest, flags);
  if (sub === 'remove' || sub === 'rm')     return remove(runtime, rest, flags);

  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write('Try: save | list | restore <id> | remove <id>\n');
  return 2;
}

function save(runtime, flags) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = 'ckpt-' + ts + (flags.name ? '-' + flags.name : '');
  const src = path.join(runtime.userDataDir, 'horizon_memory.json');
  if (!fs.existsSync(src)) {
    process.stderr.write(fmt.err('no memory file to checkpoint') + '\n');
    return 1;
  }
  const dst = path.join(checkpointsDir(runtime.userDataDir), id + '.json');
  fs.copyFileSync(src, dst);
  process.stdout.write(fmt.ok('saved ' + fmt.cyan(id)) + '\n');
  return 0;
}

function list(runtime, flags) {
  const d = checkpointsDir(runtime.userDataDir);
  const files = fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')) : [];
  if (flags.json) {
    process.stdout.write(JSON.stringify(files.map(f => ({ id: f.replace(/\.json$/, ''), size: fs.statSync(path.join(d, f)).size })), null, 2) + '\n');
    return 0;
  }
  if (!files.length) {
    process.stdout.write(fmt.dim('\n  no checkpoints · save one before risky agent runs\n\n'));
    return 0;
  }
  process.stdout.write('\n' + fmt.bold('Checkpoints') + '\n\n');
  for (const f of files.sort().reverse()) {
    const st = fs.statSync(path.join(d, f));
    process.stdout.write(`  ${fmt.cyan(f.replace(/\.json$/, ''))} ${fmt.dim('· ' + Math.round(st.size/1024) + 'KB')}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

async function restore(runtime, rest, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('id required') + '\n'); return 2; }
  const src = path.join(checkpointsDir(runtime.userDataDir), id + '.json');
  if (!fs.existsSync(src)) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  if (!flags.yes) {
    const ok = await promptYesNo(fmt.cyan('  restore overwrites current memory — proceed? y/N:'));
    if (!ok) return 0;
  }
  fs.copyFileSync(src, path.join(runtime.userDataDir, 'horizon_memory.json'));
  process.stdout.write(fmt.ok('restored from ' + id) + '\n');
  process.stdout.write(fmt.dim('  restart any running horizon to pick up changes\n'));
  return 0;
}

function remove(runtime, rest, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('id required') + '\n'); return 2; }
  const src = path.join(checkpointsDir(runtime.userDataDir), id + '.json');
  if (!fs.existsSync(src)) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  fs.unlinkSync(src);
  process.stdout.write(fmt.ok('removed ' + id) + '\n');
  return 0;
}

module.exports = { run };
