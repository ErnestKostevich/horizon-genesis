#!/usr/bin/env node
// Horizon CLI — single entry point for all subcommands.
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

const SPEC = {
  aliases: { h: 'help', v: 'version', j: 'json', q: 'quiet', m: 'model', p: 'persona' },
  booleans: ['help', 'version', 'json', 'human', 'quiet', 'stream', 'verbose',
             'auto-approve', 'never-approve', 'reflect', 'semantic',
             'list', 'enable-tg', 'enable-discord'],
  negatables: ['reflect', 'semantic'],
};

function printHelp() {
  const help = `${fmt.bold('Horizon AI CLI')}

${fmt.bold('Usage')}
  horizon                          launch the TUI
  horizon "task"                   shorthand for 'horizon agent "task"'
  horizon <command> [args...]

${fmt.bold('Commands')}
  ${fmt.cyan('setup')}                Interactive first-time wizard (provider, key, persona, lang)
  ${fmt.cyan('agent')}   "task"      Full agent loop with tool use + reflection
  ${fmt.cyan('chat')}    "msg"       Single-turn chat reply (streaming + markdown by default)
  ${fmt.cyan('cost')}                 Show token + dollar spend (--days N --json --provider X)
  ${fmt.cyan('skill')}   subcommand  list | show <id> | new <id> | run <id> "task" | enable | disable
  ${fmt.cyan('mem')}     subcommand  search "q" | dump | profile | forget | stats
  ${fmt.cyan('model')}   [provider]  Read or set active provider/model. --list to see all 25 options.
  ${fmt.cyan('persona')} [id]        Read or set active persona. --list to see options.
  ${fmt.cyan('connect')} subcommand  list | test <id> | telegram|discord|slack|notion|linear --token X
  ${fmt.cyan('doctor')}  [--fix]     Health check + auto-fix (like hermes doctor)
  ${fmt.cyan('profile')} subcommand  list | use <name> | create <name> | show | delete | rename | path
  ${fmt.cyan('completion')} <shell>  Emit bash/zsh/fish/pwsh tab-completion script
  ${fmt.cyan('update')}  [--check]   Self-update from GitHub Releases (binary or source)
  ${fmt.cyan('serve')}                Start the headless HTTP API server (PWA / cron / mobile)
  ${fmt.cyan('tui')}                  Launch the interactive shell
  ${fmt.cyan('version')}              Print version + key health summary

${fmt.bold('Common flags')}
  --json / --human / --quiet     output format
  --provider X | auto            override AI provider (claude|openai|gemini|...|auto)
  --model X                      override model for this call
  --persona X                    override active persona for this call
  --workspace path               override .horizon/ lookup root
  --max-steps N                  cap agent loop steps (default 8)
  --no-reflect                   disable reflection epilogue
  --auto-approve                 auto-approve every tool call (cron mode)
  --never-approve                reject every tool call (read-only)
  --verbose                      log boot diagnostics to stderr

${fmt.bold('Examples')}
  horizon "найди все TODO в проекте и сгруппируй"
  horizon chat "what's the capital of Lithuania?"
  horizon skill list --scope user
  horizon mem search "yerba mate" --limit 5
  horizon mem dump --type facts > facts.jsonl
  horizon model claude --model claude-sonnet-4-6
  horizon persona alfred
  horizon connect telegram --token <bot-token>
  horizon serve --port 18789 --token mysecret

  Reads keys/settings from the same files as the Electron app
  (${require('../src/main/runtime/store-shim').defaultUserDataDir()}).
`;
  process.stdout.write(help);
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

  // No args → launch TUI
  if (!cmd) {
    const tuiPath = path.join(__dirname, 'horizon-tui.js');
    require(tuiPath).main({ flags });
    return 0;
  }

  // Known subcommands first; otherwise treat the whole positional list as
  // a shorthand `horizon agent "..."` task.
  const KNOWN = ['agent', 'chat', 'skill', 'mem', 'connect', 'model',
                 'persona', 'version', 'serve', 'tui', 'help',
                 'setup', 'cost', 'doctor', 'profile', 'completion', 'update'];

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
    const handler = require(`./lib/commands/${cmd}`);
    return handler.run({ runtime, args: positional.slice(1), flags });
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
