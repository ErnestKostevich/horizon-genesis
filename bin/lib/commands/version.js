// `horizon version` — version, paths, providers + key health.
//
// Prints a compact health summary so the user can see at a glance whether
// the CLI sees the same settings/keys the GUI wrote. The `--json` flag
// returns the same data as a machine-readable object.

const path = require('path');
const fs = require('fs');
const { fmt } = require('../tty');
const { panel } = require('../banner');

function run({ runtime, flags }) {
  const pkg = require(path.join(__dirname, '..', '..', '..', 'package.json'));
  const { keysStore, settingsStore, userDataDir, agentMemory,
          skillsManager, executor, embeddingService } = runtime;

  const providers = [
    'claude','openai','gemini','groq','deepseek','grok','mistral',
    'qwen','perplexity','cohere','openrouter',
  ];
  const keyState = {};
  for (const p of providers) keyState[p] = !!keysStore.get('k_' + p);
  // Local providers don't need a key
  keyState.ollama = true;
  keyState.lmstudio = true;
  keyState.localai = true;

  const summary = {
    version: pkg.version,
    name: pkg.name,
    license: pkg.license,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    userDataDir,
    workspaceDir: runtime.workspaceDir,
    activeProvider: settingsStore.get('provider') || 'gemini',
    activeModel: settingsStore.get(
      'model.' + (settingsStore.get('provider') || 'gemini')
    ) || 'default',
    activePersona: settingsStore.get('persona') || 'jarvis',
    lang: settingsStore.get('lang') || 'en',
    keys: keyState,
    memory: {
      memories: agentMemory?._data?.memories?.length || 0,
      facts: Object.keys(agentMemory?._data?.facts || {}).length,
      conversations: agentMemory?._data?.conversations?.length || 0,
    },
    skills: skillsManager?.list().length || 0,
    embeddings: embeddingService?.status() || { available: false },
    executor: executor?.status() || null,
  };

  if (flags.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return 0;
  }

  // Sprint-2.15 — panel-framed pretty-print. Replaces the scattered bold
  // headers + indented lists with 3 stacked rounded panels (Active /
  // Memory & skills / API keys + Executor) so the output reads as a
  // dashboard rather than a flat dump. Same data, premium framing.
  const log = (s) => process.stdout.write(s + '\n');
  const stripV = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
  // Two-column "key  value" formatter used inside panels. Keys are padded
  // to a fixed width so values line up vertically across rows regardless
  // of label length.
  function kv(key, value, keyW = 10) {
    return fmt.dim(String(key).padEnd(keyW)) + ' ' + value;
  }

  log('');
  log('  ' + fmt.bold('Horizon AI') + ' ' + fmt.dim('v' + pkg.version) + ' ' + fmt.dim('· ' + pkg.license));
  log('  ' + fmt.dim(`Node ${process.version} on ${process.platform}/${process.arch}`));
  log('');

  // Panel 1 — Active runtime + paths
  log(panel({
    title: 'Active',
    accent: 'cyan',
    width: 72,
    lines: [
      kv('provider',  fmt.cyan(summary.activeProvider) + ' ' + fmt.dim('(' + summary.activeModel + ')')),
      kv('persona',   fmt.cyan(summary.activePersona)),
      kv('lang',      fmt.cyan(summary.lang)),
      '',
      kv('userData',  fmt.dim(userDataDir)),
      kv('workspace', fmt.dim(runtime.workspaceDir)),
    ],
  }));
  log('');

  // Panel 2 — Memory & skills (one card, related data). Key width bumped
  // to 13 so "conversations" doesn't overrun and break vertical alignment.
  const embLine = summary.embeddings.available
    ? fmt.green('ready') + ' ' + fmt.dim('· ' + summary.embeddings.provider + ', ' + summary.embeddings.indexed + ' indexed')
    : fmt.dim('off · keyword + FTS fallback');
  log(panel({
    title: 'Memory & skills',
    accent: 'green',
    width: 72,
    lines: [
      kv('memories',      String(summary.memory.memories), 13),
      kv('facts',         String(summary.memory.facts), 13),
      kv('conversations', String(summary.memory.conversations), 13),
      kv('embeddings',    embLine, 13),
      kv('skills',        fmt.cyan(String(summary.skills)) + ' ' + fmt.dim('loaded'), 13),
    ],
  }));
  log('');

  // Panel 3 — Executor + API keys (system-side health)
  const keyLines = [];
  if (summary.executor) {
    const dockerBadge = summary.executor.dockerAvailable ? fmt.green('docker ✓') : fmt.dim('docker ✗');
    keyLines.push(kv('executor', fmt.cyan(summary.executor.mode) + ' ' + dockerBadge));
    keyLines.push('');
  }
  const present = providers.filter(p => keyState[p]);
  const missing = providers.filter(p => !keyState[p]);
  if (present.length) keyLines.push(kv('keys', fmt.green('✓ ') + present.join(', ')));
  if (missing.length) keyLines.push(kv('missing', fmt.dim(missing.join(', '))));
  keyLines.push(kv('local', fmt.dim('ollama, lmstudio, localai (no key)')));
  log(panel({
    title: 'Executor & API keys',
    accent: 'magenta',
    width: 72,
    lines: keyLines,
  }));
  log('');
  return 0;
}

module.exports = { run };
