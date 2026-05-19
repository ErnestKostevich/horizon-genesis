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

// Executor backends — multi-field configs stored in settingsStore, not
// keysStore. Handled separately because each one needs different fields.
const EXECUTOR_BACKENDS = new Set(['ssh', 'modal', 'daytona']);

async function run({ runtime, args, flags }) {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === 'list') return list(runtime, flags);
  if (sub === 'test') return test(runtime, rest, flags);
  if (KEY_NAMES[sub]) return saveToken(runtime, sub, flags);
  if (EXECUTOR_BACKENDS.has(sub)) return saveExecutorBackend(runtime, sub, flags);

  process.stderr.write(fmt.err('Unknown channel: ' + sub) + '\n');
  process.stderr.write(fmt.dim('try: list | test | telegram | discord | slack | notion | linear | github | ssh | modal | daytona\n'));
  return 2;
}

/**
 * Save executor-backend credentials. Each backend has its own fields:
 *
 *   ssh:     --host <user@host> [--port N] [--key <path>] [--workdir <path>]
 *   modal:   --token-id X --token-secret Y [--app-name N]
 *   daytona: --server <url> --key <api-key> --workspace <id>
 *
 * After saving, prints a hint to switch executionMode via:
 *   horizon model --executor <ssh|modal|daytona>
 * (a tiny shortcut we add elsewhere).
 */
function saveExecutorBackend(runtime, backend, flags) {
  const ss = runtime.settingsStore;
  if (backend === 'ssh') {
    if (!flags.host) {
      process.stderr.write(fmt.err('Need --host user@host [--port N] [--key <key-path>] [--workdir <path>]') + '\n');
      return 2;
    }
    ss.set('ssh.host', flags.host);
    if (flags.port)    ss.set('ssh.port',    flags.port);
    if (flags.key)     ss.set('ssh.keyPath', flags.key);
    if (flags.workdir) ss.set('ssh.workdir', flags.workdir);
    process.stdout.write(fmt.ok(`ssh configured → ${flags.host}`) + '\n');
    process.stdout.write(fmt.dim('  enable with: settings → executionMode = ssh') + '\n');
    return 0;
  }
  if (backend === 'modal') {
    if (!flags['token-id'] || !flags['token-secret']) {
      process.stderr.write(fmt.err('Need --token-id X --token-secret Y') + '\n');
      process.stderr.write(fmt.dim('Get credentials: signup at modal.com → run `modal token new` locally') + '\n');
      process.stderr.write(fmt.dim('Then deploy the Horizon runner: see docs/deploy-modal.md') + '\n');
      return 2;
    }
    ss.set('modal.tokenId',     flags['token-id']);
    ss.set('modal.tokenSecret', flags['token-secret']);
    if (flags['app-name'])  ss.set('modal.appName',  flags['app-name']);
    if (flags.endpoint)     ss.set('modal.endpoint', flags.endpoint);
    process.stdout.write(fmt.ok('modal configured') + '\n');
    process.stdout.write(fmt.dim('  enable with: settings → executionMode = modal') + '\n');
    return 0;
  }
  if (backend === 'daytona') {
    if (!flags.server || !flags.key || !flags.workspace) {
      process.stderr.write(fmt.err('Need --server <url> --key <api-key> --workspace <id>') + '\n');
      process.stderr.write(fmt.dim('Get credentials: signup at daytona.io or self-host → create workspace → API key') + '\n');
      return 2;
    }
    ss.set('daytona.serverUrl',   flags.server);
    ss.set('daytona.apiKey',      flags.key);
    ss.set('daytona.workspaceId', flags.workspace);
    process.stdout.write(fmt.ok(`daytona configured → ${flags.workspace}`) + '\n');
    process.stdout.write(fmt.dim('  enable with: settings → executionMode = daytona') + '\n');
    return 0;
  }
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
