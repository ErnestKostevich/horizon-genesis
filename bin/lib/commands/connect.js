// `horizon connect <channel>` — configure a messaging connection.
//
//   horizon connect list                      — show connection status
//   horizon connect test <id>                 — test connectivity for one
//   horizon connect telegram --token <bot>    — save Telegram bot token
//   horizon connect discord --token <bot>     — save Discord bot token
//   horizon connect slack --token <xoxb>      — save Slack bot token
//   horizon connect notion --token <secret>   — save Notion integration token
//   horizon connect linear --token <key>      — save Linear API key

const { fmt } = require('../tty');

const KEY_NAMES = {
  telegram: 'k_telegram_bot',
  discord: 'k_discord_bot',
  slack: 'k_slack',
  notion: 'k_notion',
  linear: 'k_linear',
  github: 'k_github',
};

async function run({ runtime, args, flags }) {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === 'list') return list(runtime, flags);
  if (sub === 'test') return test(runtime, rest, flags);
  if (KEY_NAMES[sub]) return saveToken(runtime, sub, flags);

  process.stderr.write(fmt.err('Unknown channel: ' + sub) + '\n');
  process.stderr.write(fmt.dim('try: list | test | telegram | discord | slack | notion | linear | github\n'));
  return 2;
}

function list(runtime, flags) {
  const conns = runtime.connectionsManager?.list() || [];
  if (flags.json) {
    process.stdout.write(JSON.stringify(conns, null, 2) + '\n');
    return 0;
  }
  if (!conns.length) {
    process.stdout.write(fmt.dim('no connections registered\n'));
    return 0;
  }
  for (const c of conns) {
    const dot = c.connected ? fmt.green('●') : fmt.dim('○');
    const live = c.liveRunning ? fmt.cyan(' [live]') : '';
    const tools = c.toolCount ? fmt.dim(` · ${c.toolCount} tools`) : '';
    const err = c.lastError ? '\n    ' + fmt.red('err: ' + c.lastError) : '';
    process.stdout.write(`  ${dot} ${fmt.bold(c.id.padEnd(10))} ${c.name || ''}${tools}${live}${err}\n`);
  }
  return 0;
}

async function test(runtime, rest, flags) {
  const id = rest[0];
  if (!id) {
    process.stderr.write(fmt.err('Need a connection id') + '\n');
    return 2;
  }
  const r = await runtime.connectionsManager?.testConnection(id);
  if (flags.json) {
    process.stdout.write(JSON.stringify(r) + '\n');
    return r?.ok ? 0 : 1;
  }
  if (r?.ok) process.stdout.write(fmt.ok(`${id} reachable`) + '\n');
  else process.stdout.write(fmt.err(`${id}: ${r?.error || 'failed'}`) + '\n');
  return r?.ok ? 0 : 1;
}

function saveToken(runtime, channel, flags) {
  const token = flags.token;
  if (!token) {
    process.stderr.write(fmt.err('Need --token <value>') + '\n');
    return 2;
  }
  runtime.keysStore.set(KEY_NAMES[channel], token);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, channel }) + '\n');
    return 0;
  }
  process.stdout.write(fmt.ok(`${channel} token saved`) + '\n');
  process.stdout.write(fmt.dim('  start the live runtime via the GUI or `horizon serve --enable-' + channel + '`\n'));
  return 0;
}

module.exports = { run };
