// `horizon model [provider] [--model X]` — read or set active model/provider.
//
//   horizon model              → print current provider+model
//   horizon model claude       → switch active provider to claude
//   horizon model openai --model gpt-5.4-mini   → set provider + per-provider model
//   horizon model --list       → print all known providers and their default model

const { fmt } = require('../tty');
const { DEFAULT_PROVIDER_MODELS } = require('../../../src/main/runtime/ai-providers');

async function run({ runtime, args, flags }) {
  const { settingsStore, keysStore } = runtime;

  if (flags.list) {
    const list = Object.entries(DEFAULT_PROVIDER_MODELS).map(([p, m]) => {
      const stored = settingsStore.get('model.' + p);
      const has = p === 'ollama' || p === 'lmstudio' || p === 'localai'
                ? '—'
                : (keysStore.get('k_' + p) ? fmt.green('✓') : fmt.dim('·'));
      return { provider: p, defaultModel: m, currentModel: stored || m, keyConfigured: has };
    });
    if (flags.json) {
      process.stdout.write(JSON.stringify(list, null, 2) + '\n');
      return 0;
    }
    process.stdout.write(fmt.bold('provider       default model                current               key\n'));
    for (const it of list) {
      process.stdout.write(
        `  ${it.provider.padEnd(13)} ${it.defaultModel.padEnd(28)} ${fmt.cyan(it.currentModel.padEnd(20))}  ${it.keyConfigured}\n`
      );
    }
    return 0;
  }

  const newProvider = args[0];
  if (!newProvider) {
    const current = settingsStore.get('provider') || 'gemini';
    const currentModel = settingsStore.get('model.' + current) || DEFAULT_PROVIDER_MODELS[current];
    if (flags.json) {
      process.stdout.write(JSON.stringify({ provider: current, model: currentModel }) + '\n');
      return 0;
    }
    process.stdout.write(`${fmt.cyan(current)} ${fmt.dim('(' + currentModel + ')')}\n`);
    return 0;
  }

  if (!DEFAULT_PROVIDER_MODELS[newProvider]) {
    process.stderr.write(fmt.err('Unknown provider: ' + newProvider) + '\n');
    process.stderr.write(fmt.dim('try --list to see options\n'));
    return 2;
  }

  settingsStore.set('provider', newProvider);
  if (flags.model) settingsStore.set('model.' + newProvider, flags.model);

  const finalModel = settingsStore.get('model.' + newProvider) || DEFAULT_PROVIDER_MODELS[newProvider];
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, provider: newProvider, model: finalModel }) + '\n');
    return 0;
  }
  process.stdout.write(fmt.ok(`switched to ${fmt.cyan(newProvider)} ${fmt.dim('(' + finalModel + ')')}`) + '\n');
  return 0;
}

module.exports = { run };
