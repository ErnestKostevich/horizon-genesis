#!/usr/bin/env node
// Horizon CLI — single entry point for all subcommands.
//
// v0.0.2 first-run UX: suppress noisy Node deprecations (punycode etc.)
// so the splash isn't cluttered, and auto-detect zero-keys state so
// `horizon` with no args drops the user straight into the setup wizard
// instead of an empty TUI prompt they don't understand.

// Suppress Node's punycode deprecation warning + any other DEP* notices.
// These show up because some transitive npm dependency still uses the
// removed `punycode` module. We can't fix it from our side and it
// rattles the user on every launch.
//
// Three-layer suppression because Node emits warnings BEFORE the user
// script even loads in some pkg-bundled scenarios, and listener-based
// suppression alone misses those early-boot deprecation prints:
//   1. Global V8 flag — covers everything after this line
//   2. emitWarning() override — intercepts at the API level
//   3. Listener cleanup — for warnings that slip past (1) and (2)
process.noDeprecation = true;
const _origEmitWarning = process.emitWarning;
process.emitWarning = function patchedEmitWarning(warning, type, code) {
  // Drop ALL deprecation/punycode warnings unconditionally — these are
  // upstream issues we can't fix and clutter every launch on Node 22+.
  if (type === 'DeprecationWarning' || code === 'DEP0040') return;
  if (typeof warning === 'object' && warning?.name === 'DeprecationWarning') return;
  return _origEmitWarning.call(this, warning, type, code);
};
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w?.name === 'DeprecationWarning') return;
  // Other warnings still surface, just not the deprecation noise.
  process.stderr.write(`(warning) ${w.message}\n`);
});

// CRITICAL — top-level crash visibility. Without these, an uncaught
// exception during dispatch() makes the binary vanish back to the
// shell prompt with no visible error, exactly the failure mode the
// Windows pkg-bundled splash-then-exit bug presented.
process.on('uncaughtException', (e) => {
  process.stderr.write('\n\x1b[31m[fatal]\x1b[0m ' + (e?.stack || e?.message || String(e)) + '\n');
  process.exit(1);
});
process.on('unhandledRejection', (r) => {
  process.stderr.write('\n\x1b[31m[reject]\x1b[0m ' + (r?.stack || r?.message || String(r)) + '\n');
});
//
// Usage:
//   horizon                        — launch TUI
//   horizon "task"                 — shorthand for `horizon agent "task"`
//   horizon agent "task"           — full agent loop
//   horizon chat "msg"             — single-turn chat
//   horizon skill list | show | new | run | enable | disable
//   horizon mem search | dump | profile | forget | stats
//   horizon model [provider] [--model X] [--list]
//   horizon persona [id] [--list]
//   horizon connect list | test <id> | <channel> --token X
//   horizon serve [--port N] [--token X]
//   horizon tui                    — launch interactive TUI
//   horizon version                — version + key health
//
// Common flags:
//   --json / --human / --quiet     — output format
//   --provider X / --model X       — override AI provider/model for this call
//   --persona X                    — override active persona for this call
//   --workspace path               — override .horizon/ lookup root
//   --max-steps N                  — cap agent loop steps (default 8)
//   --reflect / --no-reflect       — toggle reflection epilogue
//   --auto-approve                 — auto-approve every tool call
//   --never-approve                — reject every tool call (read-only)
//   --verbose                      — log boot diagnostics to stderr

const path = require('path');
const { parseArgv } = require(path.join(__dirname, 'lib', 'argv'));
const { fmt } = require(path.join(__dirname, 'lib', 'tty'));
const { helpTable, bannerCompact, panel, visibleLen, stripAnsi } = require(path.join(__dirname, 'lib', 'banner'));

const SPEC = {
  aliases: { h: 'help', v: 'version', j: 'json', q: 'quiet', m: 'model', p: 'persona' },
  booleans: ['help', 'version', 'json', 'human', 'quiet', 'stream', 'verbose',
             'auto-approve', 'never-approve', 'reflect', 'semantic',
             'list', 'enable-tg', 'enable-discord', 'reveal', 'all',
             'no-setup', 'no-art',
             // Experiment — opt into the Ink-based TUI prototype at
             // bin/tui-ink/. Falls back to readline TUI if Ink can't load.
             'ink'],
  negatables: ['reflect', 'semantic'],
};

// Sprint-2.10 — per-command help cards. Keyed by command name, each
// entry expands into a framed panel with description, usage line,
// common flags, examples, and related commands. Falls through to the
// generic printHelp() when the user asks for a command we don't have
// a detailed card for.
const _CMD_HELP = {
  agent: {
    desc: 'Run a multi-step agent loop with tools. Each tool call asks permission unless --auto-approve is set. The agent plans, executes, reflects, and iterates up to --max-steps.',
    usage: 'horizon agent "task description" [flags]',
    flags: [
      ['--auto-approve',  'approve every tool call (cron-friendly)'],
      ['--never-approve', 'read-only: reject all tool calls'],
      ['--max-steps N',   'cap the agent loop at N iterations'],
      ['--no-reflect',    'skip the reflection epilogue'],
      ['--provider X',    'override active provider'],
    ],
    examples: [
      'horizon agent "find all TODOs in src/ and group them"',
      'horizon agent --auto-approve "deploy staging"',
      'horizon agent --max-steps 4 "summarise this week\'s commits"',
    ],
    related: ['chat', 'skill', 'sessions', 'cost', 'agents'],
  },
  chat: {
    desc: 'Single-turn chat with the active provider. Tokens stream live; markdown is rendered on completion (code blocks, lists, links).',
    usage: 'horizon chat "your message" [flags]',
    flags: [
      ['--no-stream',     'wait for full reply, then print'],
      ['--plain',         'disable markdown rendering'],
      ['--json',          'machine-readable single-line output'],
      ['--quiet',         'only the reply, no metadata'],
    ],
    examples: [
      'horizon chat "what is rate limiting?"',
      'horizon chat --provider claude "explain async/await"',
      'echo "summarise this" | horizon chat',
    ],
    related: ['ask', 'agent', 'model'],
  },
  skill: {
    desc: 'Manage skills (.horizon/skills/*.md): list, view, create, run, enable/disable. Skills are markdown files with frontmatter that the agent loads contextually.',
    usage: 'horizon skill <list|show|new|run|enable|disable|improve> [args]',
    flags: [
      ['--all',           'include disabled skills in list'],
      ['--json',          'machine-readable output'],
    ],
    examples: [
      'horizon skill list',
      'horizon skill new code-review',
      'horizon skill run summarise-pr',
      'horizon skill improve code-review',
    ],
    related: ['mem', 'rules', 'ws'],
  },
  setup: {
    desc: 'First-time wizard. Walks through provider selection, API key entry, persona pick, language, and writes settings to userData. Re-run any time to reconfigure.',
    usage: 'horizon setup [--provider X]',
    flags: [
      ['--provider X',    'pre-select provider (skip the picker step)'],
      ['--quiet',         'minimal output'],
    ],
    examples: [
      'horizon setup',
      'horizon setup --provider claude',
    ],
    related: ['doctor', 'model', 'connect'],
  },
  doctor: {
    desc: 'Health check across every subsystem. Reports green/yellow/red for userData dir, key stores, provider config, memory file, embeddings, workspace, executor, cost log. With --fix, repairs what it can without asking.',
    usage: 'horizon doctor [--fix] [--json]',
    flags: [
      ['--fix',           'auto-repair warnings (mkdir, rewrite, etc)'],
      ['--json',          'machine-readable check list'],
    ],
    examples: [
      'horizon doctor',
      'horizon doctor --fix',
    ],
    related: ['status', 'version', 'setup'],
  },
  model: {
    desc: 'Read or set the active provider and per-provider model. With --list, prints a panel of every known provider with its default + current model + key status.',
    usage: 'horizon model [provider] [--model X] [--list] [--fallback X]',
    flags: [
      ['--list',          'all providers in a panel'],
      ['--model X',       'pin a specific model for this provider'],
      ['--fallback X',    'set fallback provider (or "none")'],
    ],
    examples: [
      'horizon model',
      'horizon model claude --model claude-sonnet-4-6',
      'horizon model --fallback claude',
    ],
    related: ['persona', 'doctor'],
  },
  persona: {
    desc: 'Read or set the active persona. Personas tune the system prompt style (JARVIS, Friday, Alfred, custom). With --list, prints every available persona.',
    usage: 'horizon persona [id] [--list]',
    flags: [
      ['--list',          'every persona with description'],
    ],
    examples: [
      'horizon persona',
      'horizon persona jarvis',
      'horizon persona --list',
    ],
    related: ['model', 'rules'],
  },
  serve: {
    desc: 'Launch the headless HTTP API server. Used by the PWA, cron daemon, and mobile companion. Exposes /v1/chat, /v1/agent, /v1/run + WebSocket for events.',
    usage: 'horizon serve [--port N] [--token X] [--enable-*]',
    flags: [
      ['--port N',                  'listen port (default 18789)'],
      ['--token X',                 'require Authorization: Bearer X'],
      ['--enable-telegram',         'start the Telegram runtime'],
      ['--enable-discord',          'start the Discord runtime'],
      ['--enable-slack',            'start the Slack runtime'],
      ['--enable-whatsapp',         'start the WhatsApp runtime (Twilio)'],
      ['--enable-signal',           'start the Signal runtime'],
      ['--enable-email',            'start the Email runtime (IMAP+SMTP)'],
    ],
    examples: [
      'horizon serve',
      'horizon serve --port 18789 --token mysecret',
      'horizon serve --enable-telegram --enable-email',
    ],
    related: ['mobile', 'connect', 'cron'],
  },
  connect: {
    desc: 'Manage messaging-channel connections. Stores tokens in the keystore; runtime is started by `horizon serve`.',
    usage: 'horizon connect <list|test|telegram|discord|slack|...> [args]',
    flags: [
      ['--token X',       'channel-specific auth token'],
      ['--list',          'every configured connector'],
    ],
    examples: [
      'horizon connect list',
      'horizon connect telegram --token 1234567890:abcdef',
      'horizon connect test discord',
    ],
    related: ['serve', 'mcp'],
  },
  mcp: {
    desc: 'Manage MCP (Model Context Protocol) servers. Each server runs as a subprocess; its tools are auto-discovered and become available to the agent.',
    usage: 'horizon mcp <list|add|remove|tools|test> [args]',
    flags: [
      ['--json',          'machine-readable server list'],
    ],
    examples: [
      'horizon mcp list',
      'horizon mcp add my-server --cmd "node /path/to/server.js"',
      'horizon mcp tools',
    ],
    related: ['plugins', 'connect'],
  },
  theme: {
    desc: 'Switch the CLI/TUI visual theme. Affects accent colours, spinner frames, and the welcome wordmark gradient. 13 themes available.',
    usage: 'horizon theme [name] [--list]',
    flags: [
      ['--list',          'all themes with previews'],
    ],
    examples: [
      'horizon theme',
      'horizon theme cyberpunk',
      'horizon theme --list',
    ],
    related: ['persona'],
  },
  cron: {
    desc: 'Schedule recurring agent tasks. Each cron entry runs `horizon agent "task"` on a cron expression. Daemon mode keeps a background scheduler alive.',
    usage: 'horizon cron <list|create|run|pause|resume|daemon> [args]',
    flags: [
      ['--at "5 * * * *"', 'cron expression for create'],
      ['--no-reflect',    'skip reflection in scheduled runs'],
    ],
    examples: [
      'horizon cron list',
      'horizon cron create "daily-brief" --at "0 9 * * *" "morning briefing"',
      'horizon cron daemon',
    ],
    related: ['agent', 'serve'],
  },
};

function printCommandHelp(name) {
  const card = _CMD_HELP[name];
  if (!card) return false;  // caller falls back to printHelp()
  const icon = _GROUP_ICONS[
    name === 'agent' || name === 'chat' || name === 'ask' || name === 'tui' ? 'Chat & Agent' :
    name === 'skill' || name === 'mem' || name === 'sessions' || name === 'persona' || name === 'model' ? 'Skills & Memory' :
    name === 'connect' || name === 'mcp' || name === 'serve' ? 'Connectors' :
    'System'
  ] || '•';
  const accent = 'cyan';
  // Wrap long desc to width.
  const cols = Math.min(86, (process.stdout.columns || 86) - 2);
  const wrapW = cols - 4;
  const wrapped = [];
  const words = card.desc.split(/\s+/);
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > wrapW) { wrapped.push(cur.trim()); cur = w; }
    else cur += ' ' + w;
  }
  if (cur.trim()) wrapped.push(cur.trim());

  const flagW = Math.max(8, ...card.flags.map(f => f[0].length));
  const lines = [];
  for (const w of wrapped) lines.push(' ' + fmt.dim(w));
  lines.push('');
  lines.push(' ' + fmt.bold('Usage'));
  lines.push('  ' + fmt.cyan(card.usage));
  if (card.flags.length) {
    lines.push('');
    lines.push(' ' + fmt.bold('Flags'));
    for (const [f, d] of card.flags) {
      lines.push('  ' + fmt.cyan(f.padEnd(flagW)) + '  ' + fmt.dim(d));
    }
  }
  if (card.examples.length) {
    lines.push('');
    lines.push(' ' + fmt.bold('Examples'));
    for (const e of card.examples) lines.push('  ' + fmt.dim('$ ') + e);
  }
  if (card.related && card.related.length) {
    lines.push('');
    lines.push(' ' + fmt.bold('Related') + '   ' + card.related.map(r => fmt.cyan(r)).join(fmt.dim(' · ')));
  }

  process.stdout.write('\n');
  process.stdout.write(panel({
    title: icon + '  horizon ' + name,
    accent,
    lines,
    width: cols,
  }) + '\n\n');
  return true;
}

// Sprint-2.10 — premium help layout. Each group becomes a rounded
// panel with an icon glyph in its title; commands inside are rendered
// with a fixed-width name column and dim description column. Replaces
// the old flat helpTable() which felt like a dump.
const _GROUP_ICONS = {
  'Chat & Agent':     '◈',
  'Skills & Memory':  '✦',
  'Connectors':       '⌬',
  'System':           '⚙',
  'AI helpers':       '✶',
  'Management':       '▤',
  'Utilities':        '◆',
  'Dev helpers':      '▣',
  'Common flags':     '◇',
};
const _GROUP_ACCENTS = {
  'Chat & Agent':     'cyan',
  'Skills & Memory':  'magenta',
  'Connectors':       'green',
  'System':           'yellow',
  'AI helpers':       'cyan',
  'Management':       'magenta',
  'Utilities':        'cyan',
  'Dev helpers':      'green',
  'Common flags':     'yellow',
};

function _renderHelpGroup(title, rows) {
  // Each row is [cmd, args, desc] — render as "cmd args  · desc" with
  // padded columns. Strip ANSI for width calc.
  const cmdW  = Math.max(8, ...rows.map(r => visibleLen(r[0] || '')));
  const argsW = Math.max(0, ...rows.map(r => visibleLen(r[1] || '')));
  const lines = rows.map(([cmd, args, desc]) => {
    const cmdPad  = ' '.repeat(Math.max(0, cmdW - visibleLen(cmd || '')));
    const argsPad = ' '.repeat(Math.max(0, argsW - visibleLen(args || '')));
    const argsCol = args ? fmt.dim(args) + argsPad : ' '.repeat(argsW);
    return ' ' + (cmd || '') + cmdPad + '  ' + argsCol + '  ' + fmt.dim(desc || '');
  });
  const icon = _GROUP_ICONS[title] || '·';
  const accent = _GROUP_ACCENTS[title] || 'cyan';
  return panel({
    title: icon + '  ' + title,
    accent,
    lines,
    width: Math.min(86, (process.stdout.columns || 86) - 2),
  });
}

function printHelp(opts = {}) {
  // Fix 7 — compact 25-line help by default. Two-column layout, four
  // groups, brief phrases. `--all` shows everything (the previous full
  // surface). Rarely-used commands live behind `horizon help --all`.
  const c = (s) => fmt.cyan(s);
  const showAll = !!opts.all;

  const head = [
    bannerCompact(),
    '',
    fmt.bold('Usage') + '   ' + fmt.dim('horizon [command] [args] [flags]'),
  ].join('\n');

  // Default: four groups, ~25 lines total
  const coreTables = {
    'Chat & Agent': [
      [c('agent'),   '"task"',    'multi-step agent loop with tools'],
      [c('chat'),    '"msg"',     'single-turn chat (streaming)'],
      [c('ask'),     '"..."',     'quick one-liner question'],
      [c('tui'),     '',          'launch interactive shell'],
    ],
    'Skills & Memory': [
      [c('skill'),   'sub',       'list / show / new / run / enable / disable'],
      [c('mem'),     'sub',       'search / dump / profile / stats / review'],
      [c('sessions'),'sub',       'multi-chat history: list / new / show'],
      [c('persona'), '[id]',      'read or set persona (--list)'],
      [c('model'),   '[prov]',    'read or set provider (--list)'],
    ],
    'Connectors': [
      [c('connect'), 'sub',       'list / test / telegram|discord|slack|notion|...'],
      [c('mcp'),     'sub',       'MCP servers: list / add / remove / tools'],
      [c('plugins'), 'sub',       'installed plugins: list / show / enable'],
      [c('serve'),   '',          'headless HTTP API server (PWA / cron / mobile)'],
    ],
    'System': [
      [c('setup'),   '',          'first-time wizard'],
      [c('doctor'),  '[--fix]',   'health check + auto-fix'],
      [c('cost'),    '',          'token + dollar spend'],
      [c('status'),  '',          'compact runtime status'],
      [c('mobile'),  '',          'pair a phone (QR + local server)'],
      [c('theme'),   '[name]',    'switch CLI theme (--list)'],
      [c('version'), '',          'version + key health'],
      [c('help'),    '[--all]',   'show this help (--all = full list)'],
    ],
  };

  const allExtras = {
    'AI helpers': [
      [c('explain'),    '<file|->', 'explain code/text'],
      [c('summarize'),  '<file|->', 'bullet-point summary'],
      [c('translate'),  '<file|->', '--to <lang>, default ru'],
      [c('review'),     '<file>',   'code review (bugs, security)'],
      [c('refactor'),   '<file>',   'refactoring suggestions'],
      [c('test'),       '<file>',   'unit-test scaffold'],
      [c('diff'),       '<file|->', 'explain a unified diff'],
      [c('search'),     '"query"',  'semantic memory search'],
      [c('brief'),      '',         'morning briefing'],
    ],
    'Management': [
      [c('rules'),      'sub',      '.horizon/rules.md: show / edit / add'],
      [c('ws'),         'sub',      '.horizon/: show / init / path / memory'],
      [c('profile'),    'sub',      'list / use / create / show / delete'],
      [c('hooks'),      'sub',      'list / add / test / remove'],
      [c('cron'),       'sub',      'list / create / run / pause / daemon'],
      [c('checkpoints'),'sub',      'save / list / restore / remove'],
      [c('backup'),     'sub',      'snapshot / list / restore / prune'],
      [c('dialectic'),  'sub',      'Honcho diff log: summary / recent / search'],
      [c('canvas'),     'sub',      'Live Canvas surface: show / append / replace'],
      [c('agents'),     'sub',      'list / stop concurrent runs'],
      [c('insights'),   '[--days]', 'usage analytics'],
      [c('logs'),       '[type]',   'typed log views'],
      [c('completion'), '<shell>',  'bash/zsh/fish/pwsh tab-completion'],
      [c('update'),     '[--check]','self-update from GitHub Releases'],
    ],
    'Utilities': [
      [c('notes'),      'sub',      'list / add / show / rm'],
      [c('todo'),       'sub',      'list / add / done / rm / clear-done'],
      [c('timer'),      '<min>',    'pomodoro timer + bell'],
      [c('stats'),      '',         'global usage stats'],
      [c('clip'),       '[show]',   'read clipboard, analyse with AI'],
      [c('env'),        'sub',      'list / set K=V / unset K'],
      [c('open'),       '<url|p>',  'OS-native opener'],
    ],
    'Dev helpers': [
      [c('git'),        'sub',      'AI git: commit / review / log / blame'],
      [c('shell'),      '"goal"',   'shell command suggestion (--run)'],
      [c('web'),        '"q"',      'web search (Tavily / Perplexity)'],
      [c('image'),      '"prompt"', 'generate image (DALL-E / Imagen)'],
      [c('screen'),     'sub',      'capture / describe'],
      [c('explain-error'),'<log>',  'explain a stack trace'],
    ],
    'Common flags': [
      ['--json|--human|--quiet','',   'output format'],
      ['--provider X|auto',     '',   'override provider'],
      ['--model X',             '',   'override model'],
      ['--persona X',           '',   'override persona'],
      ['--no-reflect',          '',   'skip reflection epilogue'],
      ['--auto-approve',        '',   'cron-friendly: approve everything'],
      ['--never-approve',       '',   'read-only: reject everything'],
      ['--verbose',             '',   'log boot diagnostics'],
    ],
  };

  const tables = showAll ? { ...coreTables, ...allExtras } : coreTables;

  let tail;
  if (showAll) {
    tail = [
      '',
      fmt.bold('Examples'),
      '  horizon ' + fmt.dim('"find all TODOs and group them"'),
      '  horizon chat ' + fmt.dim('"what is the capital of Lithuania?"'),
      '  horizon model ' + fmt.dim('claude --model claude-sonnet-4-6'),
      '  horizon connect ' + fmt.dim('telegram --token <bot-token>'),
      '  horizon serve ' + fmt.dim('--port 18789 --token mysecret'),
      '',
      fmt.dim('  Reads keys/settings from the Electron app userData dir'),
      fmt.dim('  (' + require('../src/main/runtime/store-shim').defaultUserDataDir() + ').'),
      '',
    ].join('\n');
  } else {
    tail = '\n' + fmt.dim('  Run ') + fmt.cyan('horizon help --all') + fmt.dim('  for the full command surface (AI helpers, utilities, dev tools).') + '\n';
  }

  // Sprint-2.10 — render each group as a premium framed panel instead
  // of dumping a flat helpTable. The panels stack vertically; on narrow
  // terminals each scales down via Math.min(86, cols - 2).
  let body = '';
  for (const [title, rows] of Object.entries(tables)) {
    if (!rows || !rows.length) continue;
    body += '\n' + _renderHelpGroup(title, rows) + '\n';
  }
  process.stdout.write(head + '\n' + body + tail);
}

function resolveProfileUserDataDir(baseUserDataDir, explicitProfile) {
  // Precedence: --profile flag > HORIZON_PROFILE env > active-profile.txt
  // > "default" (uses baseUserDataDir as-is).
  const fs = require('fs');
  const path = require('path');
  let name = explicitProfile || process.env.HORIZON_PROFILE;
  if (!name) {
    try {
      const f = path.join(baseUserDataDir, 'active-profile.txt');
      if (fs.existsSync(f)) {
        name = fs.readFileSync(f, 'utf8').trim();
      }
    } catch (_) {}
  }
  if (!name || name === 'default') return baseUserDataDir;
  // Validate to avoid path traversal
  if (!/^[a-z0-9][a-z0-9-_]{0,30}$/i.test(name)) return baseUserDataDir;
  return path.join(baseUserDataDir, 'profiles', name);
}

/**
 * v0.0.2 — first-run detection. Returns true if at least one AI
 * provider key (or a local provider URL) is configured on the loaded
 * runtime's keysStore / settingsStore. Used by the no-args path to
 * decide whether to drop into the TUI or run setup first.
 *
 * Order matches the setup wizard's recommended list — cheap and free
 * options first. We don't validate the key is correct (that's
 * `horizon doctor`'s job), just that SOMETHING is configured.
 */
function _anyProviderKeyConfigured(runtime) {
  const k = runtime?.keysStore;
  const s = runtime?.settingsStore;
  if (!k && !s) return false;
  const KEYED = ['gemini','groq','cerebras','openai','claude','deepseek',
                 'deepinfra','fireworks','together','sambanova','nebius',
                 'openrouter','mistral','qwen','moonshot','zai','perplexity',
                 'cohere','grok','azure','custom'];
  if (k) {
    for (const id of KEYED) {
      try {
        const v = k.get(`k_${id}`);
        if (v && String(v).trim()) return true;
      } catch (_) {}
    }
  }
  // Local provider URLs count as "configured" — user can run Ollama
  // without any API key whatsoever.
  if (s) {
    try {
      const ollama = s.get('ollamaUrl') || s.get('ollama.url');
      const lmstudio = s.get('lmStudioUrl') || s.get('lmstudio.url');
      const localai = s.get('localAiUrl') || s.get('localai.url');
      if (ollama || lmstudio || localai) return true;
    } catch (_) {}
  }
  return false;
}

async function loadRuntime(flags) {
  const { createHorizonRuntime } = require('../src/main/runtime/headless');
  const { defaultUserDataDir } = require('../src/main/runtime/store-shim');
  const baseDir = flags['user-data-dir'] || defaultUserDataDir();
  const effectiveDir = resolveProfileUserDataDir(baseDir, flags.profile);
  return createHorizonRuntime({
    userDataDir: effectiveDir,
    workspaceDir: flags.workspace || process.cwd(),
    verbose: !!flags.verbose,
  });
}

async function dispatch(argv) {
  const flags = parseArgv(argv, SPEC);
  const positional = flags._;

  if (flags.help) { printHelp({ all: !!flags.all }); return 0; }
  if (flags.version && !positional.length) {
    // bare --version flag (not the `version` subcommand)
    const runtime = await loadRuntime(flags);
    const cmd = require('./lib/commands/version');
    return cmd.run({ runtime, args: [], flags });
  }

  const cmd = positional[0];

  // No args → first-run check, then TUI.
  //
  // v0.0.2 — if the user has zero API keys configured, we DON'T drop
  // them into an empty TUI with a `>` prompt and no way to send a
  // message (which was the v0.0.1 trap). Instead we auto-run the
  // setup wizard. After it finishes, we hand off to the TUI like
  // normal. Skip the detection with --no-setup or HORIZON_SKIP_SETUP=1
  // (useful for headless CI / docker images that pre-mount keys).
  if (!cmd) {
    // Skip auto-setup when:
    //   • user explicitly opts out (--no-setup or HORIZON_SKIP_SETUP=1)
    //   • stdin isn't a TTY (piped input — wizard would block on readline)
    const skipSetup = flags?.['no-setup']
                   || process.env.HORIZON_SKIP_SETUP === '1'
                   || !process.stdin.isTTY;
    if (!skipSetup) {
      const runtime = await loadRuntime(flags);
      if (!_anyProviderKeyConfigured(runtime)) {
        // Friendly nudge so the user understands what's about to happen.
        const c = require('./lib/banner');
        process.stdout.write('\n' + c.bannerCompact() + '\n');
        process.stdout.write('  \x1b[90mNo API key found.\x1b[0m  \x1b[97mLet\'s set you up — 30 seconds.\x1b[0m\n');
        process.stdout.write('  \x1b[90mSkip with Ctrl+C; rerun anytime via \x1b[36mhorizon setup\x1b[90m.\x1b[0m\n\n');
        const setupCmd = require('./lib/commands/setup');
        const rc = await setupCmd.run({ runtime, args: [], flags });
        if (rc !== 0) return rc;
      }
    }
    const tuiPath = path.join(__dirname, 'horizon-tui.js');
    await require(tuiPath).main({ flags });
    return 0;
  }

  // Known subcommands first; otherwise treat the whole positional list as
  // a shorthand `horizon agent "..."` task.
  const KNOWN = ['agent', 'chat', 'skill', 'mem', 'connect', 'model',
                 'persona', 'version', 'serve', 'tui', 'help',
                 'setup', 'cost', 'doctor', 'profile', 'completion', 'update',
                 'art',
                 // Phase 10 additions
                 'cron', 'sessions', 'backup', 'status', 'insights',
                 'logs', 'checkpoints', 'hooks', 'agents',
                 // Phase 12 management
                 'mcp', 'plugins', 'rules', 'ws', 'workspace',
                 // Phase 28.5 — Honcho dialectic + Live Canvas surfaces
                 'dialectic', 'canvas',
                 // Fix 8 — CLI themes
                 'theme',
                 // Phone pairing — QR + local server, one command
                 'mobile',
                 // Sprint 7D — computer use deepening (OCR + macros + find)
                 'macro', 'ocr', 'find'];

  // Phase 12 — AI-helper + utility verbs bundled in two shared files.
  // Dispatch routes them to the right module + passes the subcommand
  // name as _subcommand so the module can pick the right handler.
  const AI_HELPERS = ['ask', 'explain', 'summarize', 'summarise',
                      'translate', 'review', 'refactor', 'test', 'diff',
                      'search', 'brief'];
  const UTILITIES = ['notes', 'timer', 'stats', 'clip', 'env', 'open'];
  // Phase 13 — dev-flavoured verbs (git/shell/web/image/screen/todo/explain-error)
  const DEV_HELPERS = ['git', 'shell', 'web', 'image', 'screen',
                       'todo', 'explain-error'];

  if (cmd === 'help') {
    // Sprint-2.10 — `horizon help <cmd>` shows a detailed per-command
    // panel for the top ~12 commands. Falls back to the general help
    // panel when no name is given or the command isn't in the card map.
    const target = positional[1];
    if (target && printCommandHelp(target)) return 0;
    if (target) {
      process.stdout.write(fmt.dim('  No detailed help for "' + target + '". Showing general help.') + '\n\n');
    }
    printHelp({ all: !!flags.all });
    return 0;
  }
  if (cmd === 'tui') {
    const tuiPath = path.join(__dirname, 'horizon-tui.js');
    // CRITICAL — must await. Without await, dispatch returns 0
    // immediately, the .then(process.exit) below fires, and the
    // process dies right after the TUI banner renders. This was the
    // `horizon tui` flavour of the splash-then-exit bug.
    await require(tuiPath).main({ flags });
    return 0;
  }
  if (cmd === 'serve') {
    const servePath = path.join(__dirname, 'horizon-serve.js');
    return require(servePath).main({ flags });
  }

  const runtime = await loadRuntime(flags);

  if (KNOWN.includes(cmd)) {
    // Some Phase 12 commands map to different files than their name:
    //   ws / workspace → workspace.js
    //   summarise → summarize handler in ai-helpers
    let file = cmd;
    if (cmd === 'ws') file = 'workspace';
    const handler = require(`./lib/commands/${file}`);
    return handler.run({ runtime, args: positional.slice(1), flags });
  }

  // Phase 12 — AI helpers shared file
  if (AI_HELPERS.includes(cmd)) {
    const handler = require('./lib/commands/ai-helpers');
    const sub = cmd === 'summarise' ? 'summarize' : cmd;
    return handler.run({ runtime, args: positional.slice(1), flags, _subcommand: sub });
  }
  // Phase 12 — utility shared file
  if (UTILITIES.includes(cmd)) {
    const handler = require('./lib/commands/utility');
    return handler.run({ runtime, args: positional.slice(1), flags, _subcommand: cmd });
  }
  // Phase 13 — dev helpers shared file
  if (DEV_HELPERS.includes(cmd)) {
    const handler = require('./lib/commands/dev-helpers');
    return handler.run({ runtime, args: positional.slice(1), flags, _subcommand: cmd });
  }

  // Shorthand: horizon "task" → horizon agent "task"
  const agentHandler = require('./lib/commands/agent');
  return agentHandler.run({ runtime, args: positional, flags });
}

dispatch(process.argv.slice(2))
  .then(code => process.exit(code || 0))
  .catch(err => {
    process.stderr.write(fmt.err(err.stack || err.message || String(err)) + '\n');
    process.exit(1);
  });
