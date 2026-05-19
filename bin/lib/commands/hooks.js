// `horizon hooks` — life-cycle hook config.
//
// A hook is a shell command run when an event fires:
//   - 'agent.start'     before an agent run begins
//   - 'agent.end'       after it finishes
//   - 'cost.over'       when daily spend crosses a threshold
//   - 'skill.installed' after a skill is installed
//   - 'cron.fired'      after a cron entry fires
//
// Hooks live under settingsStore key `cli.hooks` as
//   [{ id, event, command, enabled }]
//
// The runtime checks for matching hooks at the event boundary and
// spawns them detached so they can't block the agent. Body of the
// hook command can use ${event}, ${id}, ${cost}, etc. as env vars.
//
// Subcommands:
//   horizon hooks list
//   horizon hooks add <event> "<command>"
//   horizon hooks test <id>
//   horizon hooks remove <id>

const crypto = require('crypto');
const { fmt } = require('../tty');
const { spawn } = require('child_process');

const EVENTS = ['agent.start', 'agent.end', 'cost.over', 'skill.installed', 'cron.fired'];

async function run({ runtime, args, flags }) {
  const sub = args[0] || 'list';
  const rest = args.slice(1);
  if (sub === 'list')   return list(runtime, flags);
  if (sub === 'add')    return add(runtime, rest, flags);
  if (sub === 'test')   return test(runtime, rest, flags);
  if (sub === 'remove' || sub === 'rm') return remove(runtime, rest, flags);

  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write(`Try: list | add <event> "<cmd>" | test <id> | remove <id>\nEvents: ${EVENTS.join(', ')}\n`);
  return 2;
}

function getList(runtime) {
  return runtime.settingsStore.get('cli.hooks') || [];
}
function setList(runtime, list) {
  runtime.settingsStore.set('cli.hooks', list);
}

function list(runtime, flags) {
  const items = getList(runtime);
  if (flags.json) { process.stdout.write(JSON.stringify(items, null, 2) + '\n'); return 0; }
  if (!items.length) {
    process.stdout.write(fmt.dim('\n  no hooks · try: horizon hooks add agent.end "echo done"\n\n'));
    return 0;
  }
  process.stdout.write('\n' + fmt.bold('Hooks') + '\n\n');
  for (const h of items) {
    const dot = h.enabled === false ? fmt.dim('○') : fmt.green('●');
    process.stdout.write(`  ${dot} ${fmt.cyan(h.id)} ${fmt.dim('· ' + h.event)} → ${h.command}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

function add(runtime, rest, flags) {
  const event = rest[0];
  const cmd = rest.slice(1).join(' ');
  if (!event || !cmd) { process.stderr.write(fmt.err('Usage: horizon hooks add <event> "<command>"') + '\n'); return 2; }
  if (!EVENTS.includes(event)) {
    process.stderr.write(fmt.err('Unknown event: ' + event) + '\n');
    process.stderr.write(fmt.dim('Allowed: ' + EVENTS.join(', ')) + '\n');
    return 2;
  }
  const entry = { id: 'hook-' + crypto.randomBytes(3).toString('hex'), event, command: cmd, enabled: true };
  const list = getList(runtime);
  list.push(entry);
  setList(runtime, list);
  process.stdout.write(fmt.ok('added ' + fmt.cyan(entry.id) + ' on ' + event) + '\n');
  return 0;
}

function test(runtime, rest, flags) {
  const id = rest[0];
  const item = getList(runtime).find(h => h.id === id);
  if (!item) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  process.stdout.write(fmt.dim('running: ' + item.command) + '\n');
  const child = spawn(item.command, [], { shell: true, stdio: 'inherit' });
  return new Promise(resolve => {
    child.on('exit', (code) => {
      process.stdout.write(code === 0 ? fmt.ok('exit 0') + '\n' : fmt.err('exit ' + code) + '\n');
      resolve(code === 0 ? 0 : 1);
    });
  });
}

function remove(runtime, rest, flags) {
  const id = rest[0];
  const list = getList(runtime);
  const filtered = list.filter(h => h.id !== id);
  if (filtered.length === list.length) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  setList(runtime, filtered);
  process.stdout.write(fmt.ok('removed ' + id) + '\n');
  return 0;
}

module.exports = { run };
