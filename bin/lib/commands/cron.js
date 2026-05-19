// `horizon cron` — schedule recurring agent/chat tasks.
//
// Subcommands:
//   horizon cron                        — same as list
//   horizon cron list [--json]
//   horizon cron create "<expr>" "<task>" [--name X] [--mode chat|agent]
//   horizon cron show <id>
//   horizon cron run <id>               — fire now, ignore schedule
//   horizon cron pause <id> | resume <id>
//   horizon cron remove <id>
//   horizon cron tick                   — run one scheduler tick (for cron-from-cron)
//   horizon cron daemon                 — run forever, fires entries on schedule
//
// Entries persist in horizon-settings.json (cli.cron). Re-use via
// horizon serve --enable-cron to keep them firing while the API is up.

const { fmt } = require('../tty');
const { CronRunner, parseCronExpr } = require('../../../src/main/runtime/cron-runner');

async function run({ runtime, args, flags }) {
  const cron = new CronRunner({ settingsStore: runtime.settingsStore, runtime });
  const sub = args[0] || 'list';
  const rest = args.slice(1);

  if (sub === 'list') return list(cron, flags);
  if (sub === 'show') return show(cron, rest, flags);
  if (sub === 'create' || sub === 'add') return create(cron, rest, flags);
  if (sub === 'run') return runOne(cron, rest, flags);
  if (sub === 'pause') return setEnabled(cron, rest, false, flags);
  if (sub === 'resume' || sub === 'unpause') return setEnabled(cron, rest, true, flags);
  if (sub === 'remove' || sub === 'rm' || sub === 'delete') return remove(cron, rest, flags);
  if (sub === 'tick') return tick(cron, flags);
  if (sub === 'daemon') return daemon(cron, flags);

  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write('Try: list | create "<expr>" "<task>" | show <id> | run <id> | pause | resume | remove | tick | daemon\n');
  return 2;
}

function list(cron, flags) {
  const items = cron.list();
  if (flags.json) {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n');
    return 0;
  }
  if (!items.length) {
    process.stdout.write('\n' + fmt.dim('  no scheduled tasks yet') + '\n');
    process.stdout.write('  ' + fmt.dim('try: horizon cron create "0 9 * * 1-5" "summarise overnight commits to main" --mode agent') + '\n\n');
    return 0;
  }
  process.stdout.write('\n' + fmt.bold('Scheduled tasks') + '\n\n');
  for (const e of items) {
    const dot = e.enabled ? fmt.green('●') : fmt.dim('○');
    const mode = e.mode === 'chat' ? fmt.dim('[chat]') : fmt.cyan('[agent]');
    process.stdout.write(`  ${dot} ${fmt.bold(e.id)}  ${fmt.dim(e.expr.padEnd(13))}  ${mode}  ${e.name}\n`);
    if (e.lastRunAt) {
      const ok = e.lastResult?.ok ? fmt.green('✓') : fmt.red('✗');
      process.stdout.write(`      ${fmt.dim('last ' + new Date(e.lastRunAt).toLocaleString() + '  ' + (e.lastResult?.trigger || '') )}  ${ok}\n`);
    }
  }
  process.stdout.write('\n');
  return 0;
}

function show(cron, rest, flags) {
  const e = cron.get(rest[0]);
  if (!e) { process.stderr.write(fmt.err('not found: ' + rest[0]) + '\n'); return 1; }
  if (flags.json) { process.stdout.write(JSON.stringify(e, null, 2) + '\n'); return 0; }
  process.stdout.write(`\n${fmt.bold(e.id)}\n`);
  process.stdout.write(`  name     ${e.name}\n`);
  process.stdout.write(`  expr     ${fmt.cyan(e.expr)}  ${fmt.dim('· ' + describeCron(e.expr))}\n`);
  process.stdout.write(`  mode     ${e.mode}\n`);
  process.stdout.write(`  enabled  ${e.enabled ? fmt.green('yes') : fmt.dim('no')}\n`);
  process.stdout.write(`  task     ${fmt.dim(e.task)}\n`);
  process.stdout.write(`  created  ${fmt.dim(new Date(e.createdAt).toLocaleString())}\n`);
  if (e.lastRunAt) {
    process.stdout.write(`  last     ${fmt.dim(new Date(e.lastRunAt).toLocaleString() + ' (' + (e.lastResult?.trigger || '') + ')')}\n`);
    if (e.lastResult?.answer) process.stdout.write(`  reply    ${fmt.dim(e.lastResult.answer.slice(0, 80))}\n`);
    if (e.lastResult?.error)  process.stdout.write(`  error    ${fmt.red(e.lastResult.error)}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

function create(cron, rest, flags) {
  const expr = rest[0];
  const task = rest.slice(1).join(' ');
  if (!expr || !task) {
    process.stderr.write(fmt.err('Usage: horizon cron create "<expr>" "<task>" [--name X] [--mode chat|agent]') + '\n');
    process.stderr.write(fmt.dim('Example: horizon cron create "0 9 * * 1-5" "summarise overnight commits"') + '\n');
    return 2;
  }
  try { parseCronExpr(expr); }
  catch (e) { process.stderr.write(fmt.err('Bad expression: ' + e.message) + '\n'); return 2; }
  const mode = flags.mode === 'chat' ? 'chat' : 'agent';
  const entry = cron.create({ name: flags.name, expr, task, mode });
  process.stdout.write(fmt.ok('created ' + fmt.cyan(entry.id)) + '\n');
  process.stdout.write(fmt.dim('  ' + entry.expr + '  · ' + describeCron(entry.expr)) + '\n');
  process.stdout.write(fmt.dim('  start the daemon: horizon cron daemon  (or horizon serve --enable-cron)') + '\n');
  return 0;
}

async function runOne(cron, rest, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('Usage: horizon cron run <id>') + '\n'); return 2; }
  process.stdout.write(fmt.dim('running…') + '\n');
  try {
    const r = await cron.runEntry(id);
    if (r?.error) {
      process.stderr.write(fmt.err(r.error) + '\n');
      return 1;
    }
    if (r?.answer)    process.stdout.write(r.answer + '\n');
    else if (r?.reply) process.stdout.write(r.reply + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(fmt.err(e.message) + '\n');
    return 1;
  }
}

function setEnabled(cron, rest, enabled, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('cron entry id required') + '\n'); return 2; }
  const e = cron.setEnabled(id, enabled);
  if (!e) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  process.stdout.write(fmt.ok(`${enabled ? 'resumed' : 'paused'} ${id}`) + '\n');
  return 0;
}

function remove(cron, rest, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('cron entry id required') + '\n'); return 2; }
  const removed = cron.remove(id);
  if (!removed) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  process.stdout.write(fmt.ok('removed ' + id) + '\n');
  return 0;
}

async function tick(cron, flags) {
  const r = await cron.tick();
  if (flags.json) { process.stdout.write(JSON.stringify(r) + '\n'); return 0; }
  process.stdout.write(fmt.ok(`tick · fired ${r.fired} entries${r.skipped ? ' (' + r.skipped + ')' : ''}`) + '\n');
  return 0;
}

async function daemon(cron, flags) {
  process.stdout.write(fmt.ok('cron daemon started · Ctrl+C to stop') + '\n');
  process.stdout.write(fmt.dim('  tick every minute aligned to :00') + '\n\n');
  cron.start();
  // Print fire events as they happen
  const originalFire = cron._fire.bind(cron);
  cron._fire = async (entry, trigger) => {
    process.stdout.write(fmt.cyan('▶ ') + entry.id + fmt.dim(' · ' + entry.expr + ' · ' + (entry.name || entry.task).slice(0, 50)) + '\n');
    const r = await originalFire(entry, trigger);
    const ok = r?.error ? fmt.red('✗') : fmt.green('✓');
    process.stdout.write(`  ${ok} ${fmt.dim((r?.error || r?.answer || r?.reply || '').slice(0, 100))}\n`);
    return r;
  };
  return new Promise(() => {}); // run forever
}

// Cheap human description of a 5-field expression. Doesn't try to cover
// every case — just enough to give the user confidence the parse worked.
function describeCron(expr) {
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) return '';
  const [m, h, dom, mon, dow] = parts;
  if (m === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'every minute';
  if (m === '0' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'every hour at :00';
  if (m === '0' && h === '0' && dom === '*' && mon === '*' && dow === '*') return 'every day at midnight';
  if (m === '0' && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return `every day at ${h}:00`;
  if (m === '0' && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '1-5') return `weekdays at ${h}:00`;
  if (/^\*\/(\d+)$/.test(m) && h === '*') return `every ${m.slice(2)} minutes`;
  return '';
}

module.exports = { run };
