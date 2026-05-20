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
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w?.name === 'DeprecationWarning') return;
  // Other warnings still surface, just not the deprecation noise.
  process.stderr.write(`(warning) ${w.message}\n`);
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
const { helpTable, bannerCompact } = require(path.join(__dirname, 'lib', 'banner'));

const SPEC = {
  aliases: { h: 'help', v: 'version', j: 'json', q: 'quiet', m: 'model', p: 'persona' },
  booleans: ['help', 'version', 'json', 'human', 'quiet', 'stream', 'verbose',
             'auto-approve', 'never-approve', 'reflect', 'semantic',
             'list', 'enable-tg', 'enable-discord'],
  negatables: ['reflect', 'semantic'],
};

function printHelp() {
  // Phase 20.3 — column-aligned help table. Each section is a list of
  // [command, args, description] rows; helpTable() pads command + args
  // columns so the description text lines up across every row.
  const c = (s) => fmt.cyan(s);

  const head = [
    bannerCompact(),
    '',
    fmt.bold('Usage'),
    '  horizon                          launch the TUI',
    '  horizon "task"                   shorthand for \'horizon agent "task"\'',
    '  horizon <command> [args...]',
  ].join('\n');

  const tables = {
    'Commands': [
      [c('setup'),      '',           'Interactive first-time wizard (provider, key, persona, lang)'],
      [c('agent'),      '"task"',     'Full agent loop with tool use + reflection'],
      [c('chat'),       '"msg"',      'Single-turn chat (streaming + markdown by default)'],
      [c('cost'),       '',           'Token + dollar spend (--days N --json --provider X)'],
      [c('skill'),      'subcommand', 'list | show <id> | new <id> | run <id> "task" | enable | disable'],
      [c('mem'),        'subcommand', 'search | dump | profile | forget | stats | migrate | sqlite-status | review'],
      [c('dialectic'),  'subcommand', 'Honcho 9th-layer diff log: summary | recent | search | clear'],
      [c('canvas'),     'subcommand', 'Live Canvas surface: show | append | prepend | replace | clear'],
      [c('model'),      '[provider]', 'Read/set provider. --list shows all 25 options'],
      [c('persona'),    '[id]',       'Read/set active persona. --list shows options'],
      [c('connect'),    'subcommand', 'list | test <id> | telegram|discord|slack|notion|linear|whatsapp|signal|imessage|email --token X'],
      [c('doctor'),     '[--fix]',    'Health check + auto-fix'],
      [c('profile'),    'subcommand', 'list | use | create | show | delete | rename | path'],
      [c('completion'), '<shell>',    'Emit bash/zsh/fish/pwsh tab-completion script'],
      [c('update'),     '[--check]',  'Self-update from GitHub Releases'],
      [c('cron'),       'subcommand', 'Scheduled tasks: list | create "<expr>" "<task>" | run | pause | daemon'],
      [c('sessions'),   'subcommand', 'Multi-chat history: list | new | show | export | delete | rename'],
      [c('checkpoints'),'subcommand', 'Memory savepoints: save | list | restore | remove'],
      [c('backup'),     'subcommand', 'Full userData snapshots: snapshot | list | restore | prune'],
      [c('status'),     '[--deep]',   'Compact runtime status (+ latency probes)'],
      [c('insights'),   '[--days N]', 'Usage analytics: models, hours, personas, success rate'],
      [c('logs'),       '[type]',     'Typed log views: cost | agent | errors | cron | all'],
      [c('hooks'),      'subcommand', 'Life-cycle hooks: list | add <event> "<cmd>" | test | remove'],
      [c('agents'),     'subcommand', 'List/stop concurrent runs (needs horizon serve up)'],
    ],
    'AI helpers': [
      [c('ask'),        '"..."',      'Quick one-liner question (terse, plain output)'],
      [c('explain'),    '<file|->',   'Explain code or text in plain language'],
      [c('summarize'),  '<file|->',   'Bullet-point summary'],
      [c('translate'),  '<file|->',   'Translate (--to <lang>, default Russian)'],
      [c('review'),     '<file>',     'Code review (bugs, security, maintainability)'],
      [c('refactor'),   '<file>',     'Suggest refactoring (read-only output)'],
      [c('test'),       '<file>',     'Generate unit-test scaffold'],
      [c('diff'),       '<file|->',   'Explain a unified diff'],
      [c('search'),     '"query"',    'Semantic search across memory'],
      [c('brief'),      '',           'Morning briefing from memory + cron + cost'],
    ],
    'Management': [
      [c('mcp'),        'subcommand', 'MCP servers: list | add | remove | enable | disable | tools'],
      [c('plugins'),    'subcommand', 'Installed plugins: list | show | enable | disable'],
      [c('rules'),      'subcommand', '.horizon/rules.md: show | edit | add "rule" | clear'],
      [c('ws'),         'subcommand', '.horizon/: show | init | path | memory show|edit'],
    ],
    'Utilities': [
      [c('notes'),      'subcommand', 'Quick notes: list | add "..." | show | rm'],
      [c('todo'),       'subcommand', 'TODO with completion: list | add | done | rm | clear-done'],
      [c('timer'),      '<minutes>',  'Pomodoro timer with progress bar + bell'],
      [c('stats'),      '',           'Global usage stats (memory + skills + cost)'],
      [c('clip'),       '[show|len]', 'Read clipboard, analyse with AI by default'],
      [c('env'),        'subcommand', 'Per-install env vars: list | set K=V | unset K'],
      [c('open'),       '<url|path>', 'OS-native opener'],
    ],
    'Dev helpers': [
      [c('git'),        'subcommand', 'AI git: commit | review [target] | log [query] | blame <file>'],
      [c('shell'),      '"what to do"', 'Get a shell command suggestion (--run to execute)'],
      [c('web'),        '"query"',    'Web search via Tavily / Perplexity'],
      [c('image'),      '"prompt"',   'Generate image (DALL-E / Imagen) → --out file.png'],
      [c('screen'),     'subcommand', 'capture | describe (vision-AI describes screen)'],
      [c('explain-error'),'<log|->',  'Explain a stack trace or error log'],
      [c('serve'),      '',           'Start the headless HTTP API server (PWA / cron / mobile)'],
      [c('tui'),        '',           'Launch the interactive shell'],
      [c('version'),    '',           'Print version + key health summary'],
    ],
    'Common flags': [
      ['--json / --human / --quiet', '', 'Output format'],
      ['--provider X | auto',        '', 'Override AI provider (claude|openai|gemini|...|auto)'],
      ['--model X',                  '', 'Override model for this call'],
      ['--persona X',                '', 'Override active persona for this call'],
      ['--workspace path',           '', 'Override .horizon/ lookup root'],
      ['--max-steps N',              '', 'Cap agent loop steps (default 8)'],
      ['--no-reflect',               '', 'Disable reflection epilogue'],
      ['--auto-approve',             '', 'Auto-approve every tool call (cron mode)'],
      ['--never-approve',            '', 'Reject every tool call (read-only)'],
      ['--verbose',                  '', 'Log boot diagnostics to stderr'],
    ],
  };

  const examples = [
    '',
    fmt.bold('Examples'),
    '  horizon ' + fmt.dim('"найди все TODO в проекте и сгруппируй"'),
    '  horizon chat ' + fmt.dim('"what\'s the capital of Lithuania?"'),
    '  horizon skill list ' + fmt.dim('--scope user'),
    '  horizon mem search ' + fmt.dim('"yerba mate" --limit 5'),
    '  horizon mem dump ' + fmt.dim('--type facts > facts.jsonl'),
    '  horizon model ' + fmt.dim('claude --model claude-sonnet-4-6'),
    '  horizon persona ' + fmt.dim('alfred'),
    '  horizon connect ' + fmt.dim('telegram --token <bot-token>'),
    '  horizon serve ' + fmt.dim('--port 18789 --token mysecret'),
    '',
    fmt.dim('  Reads keys/settings from the same files as the Electron app'),
    fmt.dim('  (' + require('../src/main/runtime/store-shim').defaultUserDataDir() + ').'),
    '',
  ].join('\n');

  process.stdout.write(head + '\n' + helpTable(tables) + examples);
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

  if (flags.help) { printHelp(); return 0; }
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
                 // Phase 10 additions
                 'cron', 'sessions', 'backup', 'status', 'insights',
                 'logs', 'checkpoints', 'hooks', 'agents',
                 // Phase 12 management
                 'mcp', 'plugins', 'rules', 'ws', 'workspace',
                 // Phase 28.5 — Honcho dialectic + Live Canvas surfaces
                 'dialectic', 'canvas'];

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

  if (cmd === 'help') { printHelp(); return 0; }
  if (cmd === 'tui') {
    const tuiPath = path.join(__dirname, 'horizon-tui.js');
    require(tuiPath).main({ flags });
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
