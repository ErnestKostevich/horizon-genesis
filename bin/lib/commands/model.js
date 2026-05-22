// `horizon model [provider] [--model X]` — read or set active model/provider.
//
//   horizon model              → print current provider+model
//   horizon model claude       → switch active provider to claude
//   horizon model openai --model gpt-5.4-mini   → set provider + per-provider model
//   horizon model --list       → print all known providers and their default model

const { fmt } = require('../tty');
const { panel, visibleLen } = require('../banner');
const { DEFAULT_PROVIDER_MODELS } = require('../../../src/main/runtime/ai-providers');

async function run({ runtime, args, flags }) {
  const { settingsStore, keysStore } = runtime;

  // Fix 9 — set a fallback provider used when the primary fails after
  // retries: `horizon model --fallback claude` or
  // `horizon model --fallback none` to clear.
  if (flags.fallback !== undefined) {
    if (flags.fallback === 'none' || flags.fallback === false || flags.fallback === '') {
      settingsStore.set('fallbackProvider', '');
      if (flags.json) {
        process.stdout.write(JSON.stringify({ ok: true, fallback: null }) + '\n');
      } else {
        process.stdout.write(fmt.ok('fallback cleared') + '\n');
      }
      return 0;
    }
    const fb = String(flags.fallback);
    if (!DEFAULT_PROVIDER_MODELS[fb]) {
      process.stderr.write(fmt.err('unknown provider: ' + fb) + '\n');
      process.stderr.write(fmt.dim('  try --list to see options\n'));
      return 2;
    }
    settingsStore.set('fallbackProvider', fb);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: true, fallback: fb }) + '\n');
    } else {
      process.stdout.write(fmt.ok('fallback → ' + fmt.cyan(fb)) + '\n');
    }
    return 0;
  }

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
    // Sprint-2.9 — wrap the listing in a panel with column header rule
    // so it scans as one table card instead of bare padded text.
    const provW = Math.max(8, ...list.map(it => visibleLen(it.provider)));
    const defW  = Math.max(13, ...list.map(it => visibleLen(it.defaultModel)));
    const curW  = Math.max(7, ...list.map(it => visibleLen(it.currentModel)));
    const activeProvider = settingsStore.get('provider') || 'gemini';
    const header = fmt.bold(
      'provider'.padEnd(provW) + '  ' +
      'default'.padEnd(defW) + '  ' +
      'current'.padEnd(curW) + '  ' +
      'key'
    );
    const rule = fmt.dim(
      '─'.repeat(provW) + '  ' +
      '─'.repeat(defW) + '  ' +
      '─'.repeat(curW) + '  ' +
      '───'
    );
    const rows = list.map(it => {
      const dot = it.provider === activeProvider ? fmt.cyan('●') : ' ';
      const provCol = (dot + ' ' + it.provider).padEnd(provW + 2);
      const defCol  = it.defaultModel.padEnd(defW);
      const curCol  = fmt.cyan(it.currentModel.padEnd(curW));
      return provCol + defCol + '  ' + curCol + '  ' + it.keyConfigured;
    });
    process.stdout.write('\n' + panel({
      title: 'Providers',
      accent: 'cyan',
      lines: [header, rule, ...rows],
      width: Math.min(100, (process.stdout.columns || 80) - 4),
    }) + '\n');
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
