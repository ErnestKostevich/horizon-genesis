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
const EXECUTOR_BACKENDS = new Set(['ssh', 'modal', 'daytona', 'singularity']);

// Phase 14 — multi-field channel adapters (separate from KEY_NAMES
// because they need more than just a single token).
const MULTI_FIELD_CHANNELS = new Set(['whatsapp', 'signal', 'imessage', 'email']);

async function run({ runtime, args, flags }) {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === 'list') return list(runtime, flags);
  if (sub === 'test') return test(runtime, rest, flags);
  if (KEY_NAMES[sub]) return saveToken(runtime, sub, flags);
  if (EXECUTOR_BACKENDS.has(sub)) return saveExecutorBackend(runtime, sub, flags);
  if (MULTI_FIELD_CHANNELS.has(sub)) return saveMultiFieldChannel(runtime, sub, flags);

  process.stderr.write(fmt.err('Unknown channel: ' + sub) + '\n');
  process.stderr.write(fmt.dim('try: list | test | telegram | discord | slack | notion | linear | github\n'));
  process.stderr.write(fmt.dim('     | whatsapp | signal | imessage | email\n'));
  process.stderr.write(fmt.dim('     | ssh | modal | daytona | singularity\n'));
  return 2;
}

/**
 * Multi-field channel adapters (whatsapp/signal/imessage). Each has
 * its own field set, kept in settingsStore (not keysStore) because
 * they're URLs / IDs alongside the token.
 */
function saveMultiFieldChannel(runtime, channel, flags) {
  const ss = runtime.settingsStore;
  const ks = runtime.keysStore;

  if (channel === 'whatsapp') {
    if (!flags['twilio-sid'] || !flags['twilio-token'] || !flags.from) {
      process.stderr.write(fmt.err('Usage: horizon connect whatsapp --twilio-sid AC... --twilio-token X --from whatsapp:+14155238886') + '\n');
      process.stderr.write(fmt.dim('Signup: twilio.com → Messaging → Try WhatsApp (free sandbox in 5 min).') + '\n');
      return 2;
    }
    ks.set('k_twilio_sid',   flags['twilio-sid']);
    ks.set('k_twilio_token', flags['twilio-token']);
    ss.set('whatsapp.from',  flags.from.startsWith('whatsapp:') ? flags.from : 'whatsapp:' + flags.from);
    ss.set('whatsapp.enabled', true);
    process.stdout.write(fmt.ok(`whatsapp configured · from ${flags.from}`) + '\n');
    process.stdout.write(fmt.dim('  webhook URL to set in Twilio Console: https://your-horizon-host/api/whatsapp/webhook') + '\n');
    return 0;
  }

  if (channel === 'signal') {
    if (!flags.url || !flags.number) {
      process.stderr.write(fmt.err('Usage: horizon connect signal --url http://localhost:8080 --number +1234567890') + '\n');
      process.stderr.write(fmt.dim('Setup: docker run -d -p 8080:8080 bbernhard/signal-cli-rest-api') + '\n');
      process.stderr.write(fmt.dim('Then: curl -X POST <url>/v1/register/<number>') + '\n');
      return 2;
    }
    ss.set('signal.url',    flags.url);
    ss.set('signal.number', flags.number);
    ss.set('signal.enabled', true);
    process.stdout.write(fmt.ok(`signal configured · ${flags.number} via ${flags.url}`) + '\n');
    return 0;
  }

  if (channel === 'imessage') {
    if (process.platform !== 'darwin') {
      process.stderr.write(fmt.err('iMessage adapter requires macOS — current platform: ' + process.platform) + '\n');
      return 1;
    }
    ss.set('imessage.enabled', true);
    process.stdout.write(fmt.ok('imessage adapter enabled (macOS Messages.app via osascript)') + '\n');
    process.stdout.write(fmt.dim('  Grant Terminal automation access to Messages in System Settings → Privacy.') + '\n');
    return 0;
  }

  if (channel === 'email') {
    // Two halves: IMAP for incoming, SMTP for outgoing. We accept both
    // at once but you can also call this twice to configure them
    // separately.
    const imapHost = flags['imap-host'];
    const smtpHost = flags['smtp-host'];
    if (!imapHost && !smtpHost) {
      process.stderr.write(fmt.err('Need at least --imap-host or --smtp-host') + '\n');
      process.stderr.write(fmt.dim('Usage: horizon connect email --imap-host imap.gmail.com --imap-user you@gmail.com --imap-pass <app-password>') + '\n');
      process.stderr.write(fmt.dim('       --smtp-host smtp.gmail.com --smtp-port 587') + '\n');
      process.stderr.write(fmt.dim('Gmail: create an app password at myaccount.google.com → Security → App passwords') + '\n');
      return 2;
    }
    if (imapHost) {
      ss.set('email.imap.host', imapHost);
      if (flags['imap-port']) ss.set('email.imap.port', Number(flags['imap-port']) || 993);
      if (flags['imap-user']) ss.set('email.imap.user', flags['imap-user']);
      if (flags['imap-pass']) ss.set('email.imap.pass', flags['imap-pass']);
      if (flags['imap-mailbox']) ss.set('email.imap.mailbox', flags['imap-mailbox']);
    }
    if (smtpHost) {
      ss.set('email.smtp.host', smtpHost);
      if (flags['smtp-port']) ss.set('email.smtp.port', Number(flags['smtp-port']) || 587);
      if (flags['smtp-user']) ss.set('email.smtp.user', flags['smtp-user']);
      if (flags['smtp-pass']) ss.set('email.smtp.pass', flags['smtp-pass']);
      if (flags.from) ss.set('email.smtp.from', flags.from);
    }
    ss.set('email.enabled', true);
    process.stdout.write(fmt.ok(`email configured · IMAP ${imapHost || '(skipped)'} · SMTP ${smtpHost || '(skipped)'}`) + '\n');
    process.stdout.write(fmt.dim('  inbound polling starts when you launch `horizon serve --enable-email`') + '\n');
    return 0;
  }
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
  if (backend === 'singularity') {
    if (!flags.image) {
      process.stderr.write(fmt.err('Need --image <uri>') + '\n');
      process.stderr.write(fmt.dim('Examples: --image docker://python:3.12-slim, --image library://sylabs/python, --image ./mycontainer.sif') + '\n');
      process.stderr.write(fmt.dim('Optional: --bind /data:/data,/scratch:/scratch  --binary apptainer') + '\n');
      return 2;
    }
    ss.set('singularity.image', flags.image);
    if (flags.bind)   ss.set('singularity.bind', flags.bind);
    if (flags.binary) ss.set('singularity.binary', flags.binary);
    process.stdout.write(fmt.ok(`singularity configured → ${flags.image}`) + '\n');
    process.stdout.write(fmt.dim('  enable with: settings → executionMode = singularity') + '\n');
    process.stdout.write(fmt.dim('  HPC clusters: make sure `singularity` or `apptainer` is loaded on PATH') + '\n');
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
