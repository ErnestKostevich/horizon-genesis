// `horizon version` — version, paths, providers + key health.
//
// Prints a compact health summary so the user can see at a glance whether
// the CLI sees the same settings/keys the GUI wrote. The `--json` flag
// returns the same data as a machine-readable object.

const path = require('path');
const fs = require('fs');
const { fmt } = require('../tty');

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

  // Human pretty-print
  const log = (...a) => console.log(...a);
  log(fmt.bold('Horizon AI'), fmt.dim('v' + pkg.version), fmt.dim('· ' + pkg.license));
  log(fmt.dim(`Node ${process.version} on ${process.platform}/${process.arch}`));
  log('');
  log(fmt.bold('Paths'));
  log('  userData ', fmt.dim(userDataDir));
  log('  workspace', fmt.dim(runtime.workspaceDir));
  log('');
  log(fmt.bold('Active'));
  log('  provider', fmt.cyan(summary.activeProvider),
      fmt.dim('(' + summary.activeModel + ')'));
  log('  persona ', fmt.cyan(summary.activePersona));
  log('  lang    ', fmt.cyan(summary.lang));
  log('');
  log(fmt.bold('Memory'));
  log(`  ${summary.memory.memories} memories  ·  ${summary.memory.facts} facts  ·  ${summary.memory.conversations} conversations`);
  if (summary.embeddings.available) {
    log(`  ${fmt.green('embeddings ready')}  ${fmt.dim(summary.embeddings.provider + ', ' + summary.embeddings.indexed + ' indexed')}`);
  } else {
    log('  ' + fmt.dim('embeddings: no key (keyword + FTS fallback)'));
  }
  log('');
  log(fmt.bold('Skills'), fmt.dim(`(${summary.skills} loaded)`));
  log('');
  if (summary.executor) {
    log(fmt.bold('Executor'),
        fmt.cyan(summary.executor.mode),
        summary.executor.dockerAvailable ? fmt.green('docker ✓') : fmt.dim('docker ✗'));
    log('');
  }
  log(fmt.bold('API keys'));
  const present = providers.filter(p => keyState[p]);
  const missing = providers.filter(p => !keyState[p]);
  if (present.length) log('  ' + fmt.green('configured: ') + present.join(', '));
  if (missing.length) log('  ' + fmt.dim('missing:    ' + missing.join(', ')));
  log('  ' + fmt.dim('local:      ollama, lmstudio, localai (no key needed)'));
  return 0;
}

module.exports = { run };
