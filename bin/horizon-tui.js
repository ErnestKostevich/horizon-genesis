#!/usr/bin/env node
// Horizon TUI v2 — keypress-based interactive shell.
//
// What's new vs v1 (readline-based):
//   - Multi-line composer (Shift+Enter inserts newline, Enter sends)
//   - In-chat search overlay (Ctrl+F, type query, Enter to jump,
//     Ctrl+N/P navigate, Esc cancel)
//   - Scrollback through past output (Page Up/Down, Ctrl+B/F, mouse
//     scroll wheel) — Esc returns to live view
//   - Mouse click anywhere in the scrollback view brings you back to live
//   - Ctrl+L clears screen, Ctrl+U clear line, Ctrl+W delete word back,
//     Ctrl+A/E start/end of line
//
// Same slash command surface as v1: /help /quit /clear /reset /skills
// /skill /skill-show /persona /persona-list /model /model-list /mem
// /agent /chat /stream on|off /markdown on|off /banner /verbose

const path = require('path');
const { createHorizonRuntime } = require('../src/main/runtime/headless');
const { fmt, isTTY } = require('./lib/tty');
const { renderMarkdown } = require('./lib/markdown');
const { bannerBig, GradientSpinner, welcomeReveal, personaPickerInteractive } = require('./lib/banner');
const { TuiEngine } = require('./lib/tui-engine');
const { interactiveMenu } = require('./lib/menu');

const SLASH_LIST = ['/help','/quit','/clear','/reset','/skills','/skill','/skill-show',
                    '/persona','/persona-list','/model','/model-list','/mem','/agent',
                    '/chat','/stream','/markdown','/banner','/verbose','/find'];

function buildHelp() {
  return [
    '',
    fmt.bold('Slash commands'),
    '  /help                 show this list',
    '  /quit                 exit',
    '  /clear                clear screen',
    '  /reset                clear chat history (memory keeps everything)',
    '  /skills               list installed skills',
    '  /skill <id>           force-include a skill in the next turn',
    '  /skill-show <id>      print a skill\'s SKILL.md',
    '  /persona              show / switch persona (no arg or <id>)',
    '  /persona-list         list all personas',
    '  /model                show / switch provider (no arg or <id>)',
    '  /model-list           list all providers',
    '  /mem "query"          semantic memory search',
    '  /agent <task>         run the full agent loop (multi-step + tools)',
    '  /chat <message>       force single-turn chat',
    '  /stream on|off        toggle streaming',
    '  /markdown on|off      toggle markdown rendering',
    '  /find <query>         same as Ctrl+F',
    '',
    fmt.bold('Keyboard shortcuts'),
    '  Enter                 send message',
    '  Shift+Enter           newline (multi-line composer)',
    '  Up / Down             history navigation (when on first line)',
    '  ← / →                 move cursor within composer',
    '  Ctrl+A / Ctrl+E       jump start / end of line',
    '  Ctrl+U / Ctrl+K       cut to start / end of line',
    '  Ctrl+W                delete word backward',
    '  Ctrl+L                clear screen',
    '  Ctrl+F                search transcript',
    '  Page Up / Page Down   scroll through past output',
    '  Esc                   exit scrollback / search',
    '  Mouse wheel           scroll transcript (where supported)',
    '  Ctrl+C / Ctrl+D       exit',
    '',
  ].join('\n');
}

function bannerHeader(rt) {
  const provider = rt.settingsStore.get('provider') || 'gemini';
  const persona = rt.settingsStore.get('persona') || 'jarvis';
  const memCount = rt.agentMemory?._data?.memories?.length || 0;
  const skillCount = rt.skillsManager?.list().length || 0;
  const lang = rt.settingsStore.get('lang') || 'en';

  const lines = [
    '',
    bannerBig(),
    '',
    `  ${fmt.dim('provider')} ${fmt.cyan(provider)}   ${fmt.dim('persona')} ${fmt.cyan(persona)}   ${fmt.dim('lang')} ${fmt.cyan(lang)}`,
    `  ${fmt.dim('memory')} ${fmt.green(memCount + '')}   ${fmt.dim('skills')} ${fmt.green(skillCount + '')}   ${fmt.dim('workspace')} ${fmt.cyan(path.basename(rt.workspaceDir))}`,
    '',
    fmt.dim('  Type /help · Tab to complete · Shift+Enter newline · Ctrl+F search · /quit to exit'),
    '',
  ];
  return lines.join('\n');
}

function fmtArgs(a) {
  if (!a) return '';
  try { const s = JSON.stringify(a); return s.length > 60 ? s.slice(0, 57) + '…' : s; }
  catch (_) { return ''; }
}

// Live step rail (re-uses the engine's print so it appears in transcript)
class StepRail {
  constructor(engine) { this.engine = engine; this.spinner = null; this.lastTool = ''; }
  startThinking(text = 'thinking…') {
    if (this.spinner) this.spinner.stop();
    this.spinner = new GradientSpinner(text).start();
  }
  showPlan(steps) {
    if (this.spinner) this.spinner.stop();
    this.engine.print('');
    this.engine.print(fmt.bold('plan'));
    steps.forEach((s, i) => {
      const txt = typeof s === 'string' ? s : (s.text || JSON.stringify(s));
      this.engine.print(`  ${fmt.dim((i + 1) + '.')} ${txt}`);
    });
    this.engine.print('');
    this.spinner = new GradientSpinner('starting…').start();
  }
  executing(tool, args) {
    this.lastTool = tool;
    if (this.spinner) this.spinner.update(`${tool}(${fmtArgs(args)})`);
  }
  result(tool, ok, result) {
    if (this.spinner) this.spinner.stop();
    if (ok) {
      this.engine.print(`  ${fmt.green('✓')} ${fmt.cyan(tool)} ${fmt.dim(fmtArgs(result?.out ? { out: result.out } : result || {}))}`);
      const out = String(result?.out || '');
      if (out && out.length < 400) {
        for (const l of out.split('\n').slice(0, 4)) this.engine.print('    ' + fmt.dim(l));
      }
    } else {
      const err = result?.err || result?.error || 'failed';
      this.engine.print(`  ${fmt.red('✗')} ${fmt.cyan(tool)} ${fmt.red(String(err).slice(0, 120))}`);
    }
    this.spinner = new GradientSpinner('thinking…').start();
  }
  reflection(goalMet, confidence) {
    if (this.spinner) this.spinner.stop();
    const tag = goalMet === 'yes' ? fmt.green('● goal met')
              : goalMet === 'partial' ? fmt.yellow('● partial')
              : fmt.red('● not met');
    const conf = confidence ? fmt.dim(` confidence=${confidence}`) : '';
    this.engine.print(`  ${tag}${conf}`);
    this.spinner = new GradientSpinner('finishing…').start();
  }
  stop() { if (this.spinner) { this.spinner.stop(); this.spinner = null; } }
}

async function main({ flags } = {}) {
  const runtime = createHorizonRuntime({
    userDataDir: flags?.['user-data-dir'],
    workspaceDir: flags?.workspace || process.cwd(),
    verbose: !!flags?.verbose,
  });

  if (!isTTY) process.stderr.write(fmt.warn('TUI works best in an interactive terminal') + '\n');

  // Phase 18 — first-launch reveal: if there's no conversation history
  // yet (first time the TUI ever boots), play the animated welcome.
  // Subsequent launches print the compact banner header immediately.
  const FIRST_LAUNCH_FLAG = 'tui.welcomedAt';
  const isFirstLaunch = !runtime.settingsStore.get(FIRST_LAUNCH_FLAG)
                     && !(runtime.agentMemory?._data?.conversations?.length);
  if (isFirstLaunch && isTTY) {
    await welcomeReveal({
      provider: runtime.settingsStore.get('provider'),
      persona: runtime.settingsStore.get('persona'),
      lang: runtime.settingsStore.get('lang'),
    });
    // Phase 20.3 — interactive persona picker after the reveal. Lets a
    // first-time user pick from 5 personas with a single keypress.
    try {
      const current = runtime.settingsStore.get('persona') || 'jarvis';
      const picked = await personaPickerInteractive(current);
      if (picked && picked !== current) runtime.settingsStore.set('persona', picked);
    } catch (_) {}
    try { runtime.settingsStore.set(FIRST_LAUNCH_FLAG, new Date().toISOString()); } catch (_) {}
  }

  // Print initial banner — write directly so it's part of the transcript too.
  const banner = bannerHeader(runtime);
  process.stdout.write((isFirstLaunch ? '' : '\x1b[2J\x1b[H') + banner);

  const state = {
    history: [],
    mode: 'chat',
    stream: true,
    markdown: true,
  };

  const engine = new TuiEngine({
    completer: (line) => {
      if (!line.startsWith('/')) return [[], line];
      const hits = SLASH_LIST.filter(c => c.startsWith(line));
      return [hits, line];
    },
    onLine: async (raw) => {
      const line = raw.trim();
      if (!line) return;
      // Echo user line into transcript
      engine.print(fmt.cyan('› ') + line);
      try {
        if (line.startsWith('/')) await handleSlash(line, state, runtime, engine);
        else await runOne(runtime, state, engine, line);
      } catch (e) {
        engine.print(fmt.red('error: ' + e.message));
      }
    },
  });

  // Seed transcript with the banner so search/scroll see it
  banner.split('\n').forEach(l => engine.transcript.push(l));

  engine.start();
}

async function handleSlash(raw, state, runtime, engine) {
  const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const head = tokens[0];
  const rest = tokens.slice(1).map(t => t.replace(/^"|"$/g, ''));

  if (head === '/quit' || head === '/exit') { engine.close(); process.exit(0); return; }
  if (head === '/help') { engine.print(buildHelp()); return; }
  if (head === '/clear') {
    process.stdout.write('\x1b[2J\x1b[H');
    engine.transcript = [];
    return;
  }
  if (head === '/banner') {
    engine.print(bannerHeader(runtime));
    return;
  }
  if (head === '/reset') {
    state.history.length = 0;
    engine.print(fmt.dim('chat history cleared (memory retained)'));
    return;
  }
  if (head === '/find') {
    const q = rest.join(' ');
    if (!q) { engine.print(fmt.dim('usage: /find <query>  (or press Ctrl+F)')); return; }
    engine.searchQuery = q;
    engine._refreshSearch();
    engine._jumpToMatch(0);
    return;
  }
  if (head === '/stream') {
    if (rest[0] === 'on')  state.stream = true;
    if (rest[0] === 'off') state.stream = false;
    engine.print(fmt.dim('streaming: ') + (state.stream ? fmt.green('on') : fmt.red('off')));
    return;
  }
  if (head === '/markdown') {
    if (rest[0] === 'on')  state.markdown = true;
    if (rest[0] === 'off') state.markdown = false;
    engine.print(fmt.dim('markdown: ') + (state.markdown ? fmt.green('on') : fmt.red('off')));
    return;
  }
  if (head === '/skills') {
    // Phase 20.3 — interactive picker. Highlighted row uses reverse-video
    // bg ("hover" effect), arrow keys / mouse wheel move the cursor,
    // Enter shows the picked skill, Esc cancels.
    const list = runtime.skillsManager?.list() || [];
    if (!list.length) { engine.print(fmt.dim('no skills installed')); return; }
    const picked = await interactiveMenu({
      engine,
      title: `Skills (${list.length})`,
      items: list.map((s) => ({
        label: s.id,
        sublabel: fmt.dim(s.description || s.scope || ''),
        value: s,
      })),
      footer: '↑/↓ move · Enter show SKILL.md · Esc cancel',
    });
    if (!picked) { engine.print(fmt.dim('cancelled')); return; }
    const src = runtime.skillsManager?.readSource(picked.id);
    if (!src) { engine.print(fmt.err('not found')); return; }
    engine.print(fmt.cyan(`── ${picked.id} ──`));
    engine.print(state.markdown ? renderMarkdown(src) : src);
    return;
  }
  if (head === '/skill-show') {
    const id = rest[0];
    if (!id) { engine.print(fmt.err('usage: /skill-show <id>')); return; }
    const src = runtime.skillsManager?.readSource(id);
    if (!src) { engine.print(fmt.err('not found')); return; }
    engine.print(state.markdown ? renderMarkdown(src) : src);
    return;
  }
  if (head === '/skill') {
    const id = rest[0];
    if (!id) { engine.print(fmt.err('usage: /skill <id> [task]')); return; }
    await runOne(runtime, state, engine, rest.slice(1).join(' ') || `Apply skill ${id}.`, 'agent');
    return;
  }
  if (head === '/agent') {
    const task = rest.join(' ');
    if (!task) { engine.print(fmt.err('usage: /agent <task>')); return; }
    await runOne(runtime, state, engine, task, 'agent');
    return;
  }
  if (head === '/chat') {
    const msg = rest.join(' ');
    if (!msg) { engine.print(fmt.err('usage: /chat <message>')); return; }
    await runOne(runtime, state, engine, msg, 'chat');
    return;
  }
  if (head === '/persona') {
    const id = rest[0];
    if (!id) engine.print(`${fmt.cyan(runtime.settingsStore.get('persona') || 'jarvis')}`);
    else {
      runtime.settingsStore.set('persona', id);
      engine.print(fmt.ok('persona → ' + fmt.cyan(id)));
    }
    return;
  }
  if (head === '/persona-list') {
    const list = runtime.personas?.getAllPersonas?.() || [];
    const active = runtime.settingsStore.get('persona') || 'jarvis';
    if (!list.length) { engine.print(fmt.dim('no personas')); return; }
    const picked = await interactiveMenu({
      engine,
      title: 'Pick a persona',
      initial: Math.max(0, list.findIndex((p) => p.id === active)),
      items: list.map((p) => ({
        label: p.id + (p.id === active ? '  (active)' : ''),
        sublabel: fmt.dim(p.tagline || p.description || ''),
        value: p,
      })),
      footer: '↑/↓ move · Enter activate · Esc cancel',
    });
    if (!picked) { engine.print(fmt.dim('cancelled')); return; }
    runtime.settingsStore.set('persona', picked.id);
    engine.print(fmt.ok('persona → ' + fmt.cyan(picked.id)));
    return;
  }
  if (head === '/model') {
    const newProv = rest[0];
    if (!newProv) {
      const current = runtime.settingsStore.get('provider') || 'gemini';
      const m = runtime.settingsStore.get('model.' + current) || '';
      engine.print(`${fmt.cyan(current)} ${fmt.dim('(' + m + ')')}`);
    } else {
      runtime.settingsStore.set('provider', newProv);
      engine.print(fmt.ok('provider → ' + fmt.cyan(newProv)));
    }
    return;
  }
  if (head === '/model-list') {
    const { DEFAULT_PROVIDER_MODELS } = require('../src/main/runtime/ai-providers');
    const active = runtime.settingsStore.get('provider') || 'gemini';
    const entries = Object.entries(DEFAULT_PROVIDER_MODELS);
    const items = entries.map(([p, m]) => {
      const isLocal = ['ollama','lmstudio','localai'].includes(p);
      const has = isLocal ? '—' : (runtime.keysStore.get('k_' + p) ? '✓' : '·');
      return {
        label: `${has}  ${p}${p === active ? '  (active)' : ''}`,
        sublabel: fmt.dim(m),
        value: { id: p, model: m },
      };
    });
    const picked = await interactiveMenu({
      engine,
      title: `Providers (${entries.length})`,
      initial: Math.max(0, entries.findIndex(([p]) => p === active)),
      items,
      footer: '↑/↓ move · Enter switch · Esc cancel · ✓ = key set',
    });
    if (!picked) { engine.print(fmt.dim('cancelled')); return; }
    runtime.settingsStore.set('provider', picked.id);
    engine.print(fmt.ok('provider → ' + fmt.cyan(picked.id) + fmt.dim(' (' + picked.model + ')')));
    return;
  }
  if (head === '/mem') {
    const q = rest.join(' ');
    if (!q) { engine.print(fmt.err('usage: /mem "query"')); return; }
    const results = await runtime.agentMemory.semanticRecall(q, 5, {});
    if (!results.length) engine.print(fmt.dim('no matches'));
    else for (const m of results) {
      const score = typeof m.score === 'number' ? fmt.dim(`(${m.score.toFixed(2)}) `) : '';
      engine.print(`${score}${m.content || m.text || ''}`);
    }
    return;
  }
  if (head === '/verbose') {
    engine.print(fmt.dim('verbose toggle: restart with --verbose'));
    return;
  }
  engine.print(fmt.err('unknown slash command: ' + head));
}

async function runOne(runtime, state, engine, message, modeOverride) {
  const mode = modeOverride || state.mode;
  if (mode === 'agent') await runAgent(runtime, state, engine, message);
  else                  await runChat(runtime, state, engine, message);
}

async function runChat(runtime, state, engine, message) {
  engine.setSending(true);
  engine.print('');
  let firstToken = true;
  let buf = '';

  try {
    if (state.stream) {
      const r = await runtime.runChatStream(message, { history: state.history }, (chunk) => {
        if (firstToken) {
          engine.print(fmt.bold('Horizon: ') + chunk);
          firstToken = false;
          buf = chunk;
        } else {
          buf += chunk;
          engine.print(chunk, { noAppend: true });
        }
      });
      // Ensure transcript has the final assembled reply
      if (!firstToken) {
        engine.transcript.push(fmt.bold('Horizon: ') + (r.reply || ''));
      }
      if (r.error) engine.print(fmt.err(r.error));
      else if (firstToken && r.reply) {
        engine.print(fmt.bold('Horizon: ') + (state.markdown ? renderMarkdown(r.reply) : r.reply));
      } else if (state.markdown && r.reply && /[*_`#>-]/.test(r.reply)) {
        engine.print(fmt.dim('─── rendered ───'));
        engine.print(renderMarkdown(r.reply));
      }
      if (r.reply) {
        state.history.push({ role: 'user', content: message });
        state.history.push({ role: 'assistant', content: r.reply });
      }
    } else {
      const r = await runtime.runChat(message, { history: state.history });
      if (r.reply) {
        engine.print(fmt.bold('Horizon: ') + (state.markdown ? renderMarkdown(r.reply) : r.reply));
        state.history.push({ role: 'user', content: message });
        state.history.push({ role: 'assistant', content: r.reply });
      } else if (r.error) {
        engine.print(fmt.err(r.error));
      }
    }
  } finally {
    engine.setSending(false);
  }
}

async function runAgent(runtime, state, engine, task) {
  const rail = new StepRail(engine);
  engine.setSending(true);
  rail.startThinking('planning…');
  try {
    const r = await runtime.runAgent(task, {
      history: state.history,
      onStep: (event) => {
        switch (event.type) {
          case 'plan': if (event.plan?.steps) rail.showPlan(event.plan.steps); break;
          case 'executing': rail.executing(event.tool, event.args); break;
          case 'result':    rail.result(event.tool, event.ok, event.result); break;
          case 'reflection': rail.reflection(event.goalMet, event.confidence); break;
        }
      },
      askPermission: async ({ tool, args, reason }) => {
        const dangerous = /^(run_code|run_shell|run_python|write_file|delete_file|move_file|conn_.*_send|conn_.*_post|conn_.*_create|mouse_click|keyboard_type|smart_click)$/i.test(tool);
        if (!dangerous) return true;
        // Inline confirm via a simple prompt — pause engine, read line, resume
        rail.stop();
        engine.pause();
        process.stdout.write(fmt.warn(`approve ${fmt.bold(tool)} ${fmt.dim(fmtArgs(args))} (${reason || 'agent step'}) y/N: `));
        const ans = await new Promise(resolve => {
          process.stdin.once('data', d => resolve(d.toString().trim()));
          process.stdin.resume();
        });
        engine.resume();
        rail.startThinking('thinking…');
        return /^(y|yes|д|да)/i.test(ans);
      },
    });
    rail.stop();
    if (r.answer) {
      engine.print('');
      engine.print(fmt.bold('Horizon: ') + (state.markdown ? renderMarkdown(r.answer) : r.answer));
      state.history.push({ role: 'user', content: task });
      state.history.push({ role: 'assistant', content: r.answer });
    } else if (r.error) {
      engine.print(fmt.err(r.error));
    }
  } finally {
    engine.setSending(false);
  }
}

module.exports = { main };

if (require.main === module) {
  main({ flags: {} });
}
