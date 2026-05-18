// `horizon setup` — interactive onboarding wizard. First-time experience.
//
// The Electron app handles this through the GUI Settings → Connections /
// Personas / Models flow. CLI users got nothing — they had to either run
// the GUI first or hand-edit horizon-keys.json. This command closes that
// gap: ask the user 4 questions, write the answers to the same stores
// the GUI uses, print confirmation.
//
// Questions:
//   1. Pick a provider (with cost annotations — cheap/medium/expensive)
//   2. Paste the API key (skip → local providers Ollama/LM Studio offered)
//   3. Pick a persona (5 built-ins)
//   4. Pick a language (en / ru)
//
// Re-runs are safe — values are overwrites, missing keys stay missing.

const readline = require('readline');
const { fmt } = require('../tty');
const { bannerCompact, GradientSpinner } = require('../banner');

// Provider catalog — order = recommended first. Cost notes are
// approximate as of mid-2026; users override anytime via `horizon model`.
const PROVIDERS = [
  { id: 'gemini',   key: 'k_gemini',   label: 'Google Gemini',      cost: 'free tier (1500 req/day) · best for getting started', url: 'https://aistudio.google.com/apikey', signup: 'Free at aistudio.google.com → "Get API key"' },
  { id: 'groq',     key: 'k_groq',     label: 'Groq',               cost: 'free tier (very fast inference)', url: 'https://console.groq.com/keys', signup: 'Free at console.groq.com → API Keys' },
  { id: 'openrouter', key: 'k_openrouter', label: 'OpenRouter',     cost: 'pay-as-you-go · 100+ models', url: 'https://openrouter.ai/keys', signup: 'openrouter.ai → Keys ($5 credit on signup)' },
  { id: 'claude',   key: 'k_claude',   label: 'Anthropic Claude',   cost: '$3/M input, $15/M output (Sonnet)', url: 'https://console.anthropic.com/settings/keys', signup: 'console.anthropic.com → API Keys' },
  { id: 'openai',   key: 'k_openai',   label: 'OpenAI',             cost: '$1.25/M input, $10/M output (gpt-5.4)', url: 'https://platform.openai.com/api-keys', signup: 'platform.openai.com → API Keys' },
  { id: 'deepseek', key: 'k_deepseek', label: 'DeepSeek',           cost: '$0.14/M input · cheapest non-local', url: 'https://platform.deepseek.com/api_keys', signup: 'platform.deepseek.com → API Keys' },
  { id: 'mistral',  key: 'k_mistral',  label: 'Mistral',            cost: '$2/M input, $6/M output', url: 'https://console.mistral.ai/api-keys/', signup: 'console.mistral.ai → API Keys' },
  { id: 'ollama',   key: null,         label: 'Ollama (local)',     cost: 'free, runs on your machine', url: 'https://ollama.com', signup: 'Install Ollama from ollama.com, run "ollama pull llama3.1"' },
  { id: 'lmstudio', key: null,         label: 'LM Studio (local)',  cost: 'free, runs on your machine', url: 'https://lmstudio.ai', signup: 'Install LM Studio from lmstudio.ai, start a model' },
];

const PERSONAS = [
  { id: 'jarvis', tagline: 'JARVIS-style — formal, witty, says "sir"' },
  { id: 'friday', tagline: 'Friday — casual, energetic, modern slang' },
  { id: 'alfred', tagline: 'Alfred — calm, dignified, like a butler' },
  { id: 'sage',   tagline: 'Sage — academic, precise, methodical' },
  { id: 'pixel',  tagline: 'Pixel — playful, expressive, lots of emoji' },
];

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, ans => resolve(ans.trim())));
}

async function run({ runtime, args, flags }) {
  const { keysStore, settingsStore } = runtime;

  process.stdout.write('\n  ' + bannerCompact() + '\n\n');
  process.stdout.write(fmt.bold('  First-time setup') + ' ' + fmt.dim('— takes 1 minute\n\n'));
  process.stdout.write(fmt.dim('  Skip with --yes to keep current values · re-run safely anytime\n\n'));

  if (flags.yes) {
    process.stdout.write(fmt.ok('--yes given, keeping current settings') + '\n');
    summary(runtime);
    return 0;
  }

  if (!process.stdin.isTTY) {
    process.stderr.write(fmt.err('setup needs an interactive terminal — pipe a command instead?') + '\n');
    return 1;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // ── 1. Provider ────────────────────────────────────────────────────
    process.stdout.write(fmt.bold('  1. Pick an AI provider') + '\n');
    process.stdout.write(fmt.dim('     (you can switch anytime with `horizon model <id>`)') + '\n\n');
    PROVIDERS.forEach((p, i) => {
      const has = p.key && keysStore.get(p.key) ? fmt.green('✓ already set') : '';
      process.stdout.write(
        `     ${fmt.cyan((i + 1) + ')')} ${fmt.bold(p.label.padEnd(20))} ${fmt.dim(p.cost)} ${has}\n`
      );
    });
    process.stdout.write('\n');
    const provChoice = await ask(rl, fmt.cyan('     choice [1]: '));
    const provIdx = (parseInt(provChoice, 10) || 1) - 1;
    const provider = PROVIDERS[Math.max(0, Math.min(PROVIDERS.length - 1, provIdx))];
    process.stdout.write(fmt.ok(`     → ${provider.label}`) + '\n\n');

    settingsStore.set('provider', provider.id);

    // ── 2. API key (if needed) ──────────────────────────────────────────
    if (provider.key) {
      const existing = keysStore.get(provider.key);
      if (existing) {
        const keep = await ask(rl, fmt.cyan(`  2. Use existing ${provider.label} key? (Y/n): `));
        if (!/^[nNнН]/.test(keep)) {
          process.stdout.write(fmt.ok('     → kept existing key') + '\n\n');
        } else {
          await collectKey(rl, keysStore, provider);
        }
      } else {
        process.stdout.write(fmt.bold('  2. API key') + '\n');
        process.stdout.write(fmt.dim(`     ${provider.signup}`) + '\n\n');
        await collectKey(rl, keysStore, provider);
      }
    } else {
      // Local provider
      process.stdout.write(fmt.bold('  2. Local provider config') + '\n');
      process.stdout.write(fmt.dim(`     ${provider.signup}`) + '\n');
      const urlKey = provider.id === 'ollama' ? 'ollamaUrl' : 'lmStudioUrl';
      const modelKey = provider.id === 'ollama' ? 'ollamaModel' : 'lmStudioModel';
      const defUrl = provider.id === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234';
      const defModel = provider.id === 'ollama' ? 'llama3.1' : 'local-model';
      const url = await ask(rl, fmt.cyan(`     URL [${defUrl}]: `));
      settingsStore.set(urlKey, url || defUrl);
      const model = await ask(rl, fmt.cyan(`     Model name [${defModel}]: `));
      settingsStore.set(modelKey, model || defModel);
      process.stdout.write(fmt.ok('     → local provider configured') + '\n\n');
    }

    // ── 3. Persona ────────────────────────────────────────────────────
    process.stdout.write(fmt.bold('  3. Pick a persona') + '\n');
    process.stdout.write(fmt.dim('     (you can switch anytime with `horizon persona <id>`)') + '\n\n');
    PERSONAS.forEach((p, i) => {
      process.stdout.write(`     ${fmt.cyan((i + 1) + ')')} ${fmt.bold(p.id.padEnd(8))} ${fmt.dim(p.tagline)}\n`);
    });
    process.stdout.write('\n');
    const persChoice = await ask(rl, fmt.cyan('     choice [1]: '));
    const persIdx = (parseInt(persChoice, 10) || 1) - 1;
    const persona = PERSONAS[Math.max(0, Math.min(PERSONAS.length - 1, persIdx))];
    settingsStore.set('persona', persona.id);
    process.stdout.write(fmt.ok(`     → ${persona.id}`) + '\n\n');

    // ── 4. Language ────────────────────────────────────────────────────
    process.stdout.write(fmt.bold('  4. Language') + '\n\n');
    process.stdout.write(`     ${fmt.cyan('1)')} English\n`);
    process.stdout.write(`     ${fmt.cyan('2)')} Русский\n\n`);
    const langChoice = await ask(rl, fmt.cyan('     choice [1]: '));
    const lang = langChoice === '2' ? 'ru' : 'en';
    settingsStore.set('lang', lang);
    process.stdout.write(fmt.ok(`     → ${lang === 'ru' ? 'Русский' : 'English'}`) + '\n\n');

    // ── 5. Username (optional) ────────────────────────────────────────
    process.stdout.write(fmt.bold('  5. Your name') + ' ' + fmt.dim('(for personalisation, optional)') + '\n\n');
    const currentName = settingsStore.get('userName') || '';
    const name = await ask(rl, fmt.cyan(`     name [${currentName || 'user'}]: `));
    if (name) settingsStore.set('userName', name);
    process.stdout.write(fmt.ok(`     → ${settingsStore.get('userName') || 'user'}`) + '\n\n');

    rl.close();

    process.stdout.write(fmt.green('  ✓ Setup complete!') + '\n\n');
    summary(runtime);

    process.stdout.write('\n  ' + fmt.bold('Try:') + '\n');
    process.stdout.write(`    ${fmt.cyan('horizon chat "hello"')}            ${fmt.dim('— quick chat')}\n`);
    process.stdout.write(`    ${fmt.cyan('horizon')}                          ${fmt.dim('— interactive TUI')}\n`);
    process.stdout.write(`    ${fmt.cyan('horizon agent "task"')}             ${fmt.dim('— full agent loop')}\n`);
    process.stdout.write(`    ${fmt.cyan('horizon cost')}                     ${fmt.dim('— see spend')}\n`);
    process.stdout.write('\n');
    return 0;
  } catch (e) {
    rl.close();
    process.stderr.write(fmt.err(e.message) + '\n');
    return 1;
  }
}

async function collectKey(rl, keysStore, provider) {
  const key = await ask(rl, fmt.cyan(`     paste key [skip = use later]: `));
  if (key) {
    keysStore.set(provider.key, key.trim());
    process.stdout.write(fmt.ok('     → key saved (encrypted)') + '\n\n');
  } else {
    process.stdout.write(fmt.warn('     → skipped; set later via horizon model <id>') + '\n\n');
  }
}

function summary(runtime) {
  const provider = runtime.settingsStore.get('provider') || 'gemini';
  const persona = runtime.settingsStore.get('persona') || 'jarvis';
  const lang = runtime.settingsStore.get('lang') || 'en';
  const name = runtime.settingsStore.get('userName') || 'user';
  process.stdout.write(fmt.bold('  Current settings') + '\n');
  process.stdout.write(`    provider ${fmt.cyan(provider)}\n`);
  process.stdout.write(`    persona  ${fmt.cyan(persona)}\n`);
  process.stdout.write(`    lang     ${fmt.cyan(lang)}\n`);
  process.stdout.write(`    name     ${fmt.cyan(name)}\n`);
}

module.exports = { run };
