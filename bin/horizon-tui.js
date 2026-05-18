#!/usr/bin/env node
// Horizon TUI — interactive terminal shell with streaming, markdown,
// and a live agent step rail.
//
// Phase 4 polish features:
//   - ASCII banner with gradient at startup
//   - Token-by-token streaming for chat replies (when the provider
//     supports it: claude / openai-compat / gemini)
//   - Markdown rendering in ANSI for finalised replies
//   - Live step rail in agent mode: each step's status updates in place
//     instead of accumulating; gradient spinner while the agent is
//     thinking
//   - Slash command autocomplete via Tab
//   - Persistent chat history (the user/assistant turns are in-memory;
//     long-term memory keeps everything via AgentMemory.learnFromTurn)
//
// Built on Node stdlib `readline` + ANSI. Zero extra deps.

const path = require('path');
const readline = require('readline');
const { createHorizonRuntime } = require('../src/main/runtime/headless');
const { fmt, isTTY } = require('./lib/tty');
const { renderMarkdown } = require('./lib/markdown');
const { bannerBig, bannerCompact, GradientSpinner } = require('./lib/banner');

const SLASH_HELP = `
${fmt.bold('Slash commands')}
  /help                 show this list
  /quit                 exit the TUI
  /clear                clear the screen
  /reset                reset chat history (memory keeps everything)
  /skills               list installed skills
  /skill <id>           force-include a skill in the next turn
  /skill-show <id>      print a skill's SKILL.md
  /persona              show active persona
  /persona <id>         switch persona
  /persona-list         list all personas
  /model                show active provider/model
  /model <provider>     switch provider
  /model-list           list all providers
  /mem "query"          semantic memory search
  /agent <task>         run the full agent loop (multi-step + tools)
  /chat <message>       force single-turn chat (no agent loop)
  /stream on|off        toggle token-by-token streaming
  /markdown on|off      toggle markdown rendering for replies
  /banner               redraw the welcome banner
  /verbose              note about boot-time verbose flag
`;

const SLASH_LIST = ['/help','/quit','/clear','/reset','/skills','/skill','/skill-show',
                    '/persona','/persona-list','/model','/model-list','/mem','/agent',
                    '/chat','/stream','/markdown','/banner','/verbose'];

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function bannerHeader(rt) {
  const provider = rt.settingsStore.get('provider') || 'gemini';
  const persona = rt.settingsStore.get('persona') || 'jarvis';
  const memCount = rt.agentMemory?._data?.memories?.length || 0;
  const skillCount = rt.skillsManager?.list().length || 0;
  const lang = rt.settingsStore.get('lang') || 'en';

  process.stdout.write('\n');
  process.stdout.write(bannerBig() + '\n\n');
  process.stdout.write(
    `  ${fmt.dim('provider')} ${fmt.cyan(provider)}   ` +
    `${fmt.dim('persona')} ${fmt.cyan(persona)}   ` +
    `${fmt.dim('lang')} ${fmt.cyan(lang)}\n` +
    `  ${fmt.dim('memory')} ${fmt.green(memCount + '')}   ` +
    `${fmt.dim('skills')} ${fmt.green(skillCount + '')}   ` +
    `${fmt.dim('workspace')} ${fmt.cyan(path.basename(rt.workspaceDir))}\n\n` +
    `  ${fmt.dim('Type /help for commands · Tab to autocomplete · /quit to exit')}\n\n`
  );
}

function fmtArgs(a) {
  if (!a) return '';
  try {
    const s = JSON.stringify(a);
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  } catch (_) { return ''; }
}

// Live step rail — keeps a single mutable line per active step instead of
// printing N lines. When a step finalises, the line gets committed and
// a new spinner appears for the next step.
class StepRail {
  constructor() {
    this.spinner = null;
    this.activeTool = '';
  }
  startThinking(text = 'thinking…') {
    if (this.spinner) this.spinner.stop();
    this.spinner = new GradientSpinner(text).start();
  }
  showPlan(steps) {
    if (this.spinner) this.spinner.stop();
    process.stdout.write('\n' + fmt.bold('plan') + '\n');
    steps.forEach((s, i) => {
      const txt = typeof s === 'string' ? s : (s.text || JSON.stringify(s));
      process.stdout.write(`  ${fmt.dim((i+1) + '.')} ${txt}\n`);
    });
    process.stdout.write('\n');
    this.spinner = new GradientSpinner('starting…').start();
  }
  executing(tool, args) {
    this.activeTool = tool;
    if (this.spinner) this.spinner.update(`${tool}(${fmtArgs(args)})`);
  }
  result(tool, ok, result) {
    if (this.spinner) this.spinner.stop();
    if (ok) {
      const tag = fmt.green('✓');
      process.stdout.write(`  ${tag} ${fmt.cyan(tool)} ${fmt.dim(fmtArgs(result?.out ? { out: result.out } : result || {}))}\n`);
      const out = String(result?.out || '');
      if (out && out.length < 400) {
        for (const l of out.split('\n').slice(0, 4)) {
          process.stdout.write('    ' + fmt.dim(l) + '\n');
        }
      }
    } else {
      const tag = fmt.red('✗');
      const err = result?.err || result?.error || 'failed';
      process.stdout.write(`  ${tag} ${fmt.cyan(tool)} ${fmt.red(String(err).slice(0, 120))}\n`);
    }
    this.spinner = new GradientSpinner('thinking…').start();
  }
  reflection(goalMet, confidence) {
    if (this.spinner) this.spinner.stop();
    const tag = goalMet === 'yes' ? fmt.green('● goal met')
              : goalMet === 'partial' ? fmt.yellow('● partial')
              : fmt.red('● not met');
    const conf = confidence ? fmt.dim(` confidence=${confidence}`) : '';
    process.stdout.write(`  ${tag}${conf}\n`);
    this.spinner = new GradientSpinner('finishing…').start();
  }
  stop() {
    if (this.spinner) { this.spinner.stop(); this.spinner = null; }
  }
}

async function main({ flags } = {}) {
  const runtime = createHorizonRuntime({
    userDataDir: flags?.['user-data-dir'],
    workspaceDir: flags?.workspace || process.cwd(),
    verbose: !!flags?.verbose,
  });

  if (!isTTY) {
    process.stderr.write(fmt.warn('TUI works best in an interactive terminal') + '\n');
  }

  clearScreen();
  bannerHeader(runtime);

  const state = {
    history: [], // chat history for the AI (role/content)
    mode: 'chat',
    stream: true,    // token-by-token by default
    markdown: true,  // render markdown in finalised replies
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: fmt.cyan('› '),
    completer: (line) => {
      if (!line.startsWith('/')) return [[], line];
      const hits = SLASH_LIST.filter(c => c.startsWith(line));
      return [hits, line];
    },
  });
  rl.prompt();

  rl.on('line', async (line) => {
    const raw = line.trim();
    if (!raw) { rl.prompt(); return; }

    if (raw.startsWith('/')) {
      const handled = await handleSlash(raw, state, runtime, rl);
      if (handled !== 'continue') rl.prompt();
      return;
    }

    await runOne(runtime, state, raw);
    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}

async function handleSlash(raw, state, runtime, rl) {
  const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const head = tokens[0];
  const rest = tokens.slice(1).map(t => t.replace(/^"|"$/g, ''));

  if (head === '/quit' || head === '/exit') {
    process.stdout.write(fmt.dim('bye 👋\n'));
    rl.close();
    return 'continue';
  }
  if (head === '/help') { process.stdout.write(SLASH_HELP); return 'done'; }
  if (head === '/clear') { clearScreen(); bannerHeader(runtime); return 'done'; }
  if (head === '/banner') { bannerHeader(runtime); return 'done'; }
  if (head === '/reset') {
    state.history.length = 0;
    process.stdout.write(fmt.dim('chat history cleared (memory retained)\n'));
    return 'done';
  }
  if (head === '/stream') {
    if (rest[0] === 'on')  state.stream = true;
    if (rest[0] === 'off') state.stream = false;
    process.stdout.write(fmt.dim('streaming: ') + (state.stream ? fmt.green('on') : fmt.red('off')) + '\n');
    return 'done';
  }
  if (head === '/markdown') {
    if (rest[0] === 'on')  state.markdown = true;
    if (rest[0] === 'off') state.markdown = false;
    process.stdout.write(fmt.dim('markdown: ') + (state.markdown ? fmt.green('on') : fmt.red('off')) + '\n');
    return 'done';
  }
  if (head === '/skills') {
    const list = runtime.skillsManager?.list() || [];
    for (const s of list) {
      process.stdout.write(`  ${fmt.cyan(s.id.padEnd(20))} ${fmt.dim('· ' + (s.description || ''))}\n`);
    }
    return 'done';
  }
  if (head === '/skill-show') {
    const id = rest[0];
    if (!id) { process.stdout.write(fmt.err('usage: /skill-show <id>\n')); return 'done'; }
    const src = runtime.skillsManager?.readSource(id);
    if (src) process.stdout.write(state.markdown ? renderMarkdown(src) + '\n' : src + '\n');
    else process.stdout.write(fmt.err('not found\n'));
    return 'done';
  }
  if (head === '/skill') {
    const id = rest[0];
    if (!id) { process.stdout.write(fmt.err('usage: /skill <id> [task]\n')); return 'done'; }
    await runOne(runtime, state, rest.slice(1).join(' ') || `Apply skill ${id}.`, { mode: 'agent' });
    return 'done';
  }
  if (head === '/agent') {
    const task = rest.join(' ');
    if (!task) { process.stdout.write(fmt.err('usage: /agent <task>\n')); return 'done'; }
    await runOne(runtime, state, task, { mode: 'agent' });
    return 'done';
  }
  if (head === '/chat') {
    const msg = rest.join(' ');
    if (!msg) { process.stdout.write(fmt.err('usage: /chat <message>\n')); return 'done'; }
    await runOne(runtime, state, msg, { mode: 'chat' });
    return 'done';
  }
  if (head === '/persona') {
    const id = rest[0];
    if (!id) process.stdout.write(`${fmt.cyan(runtime.settingsStore.get('persona') || 'jarvis')}\n`);
    else {
      runtime.settingsStore.set('persona', id);
      process.stdout.write(fmt.ok('persona → ' + fmt.cyan(id)) + '\n');
    }
    return 'done';
  }
  if (head === '/persona-list') {
    const list = runtime.personas?.getAllPersonas?.() || [];
    const active = runtime.settingsStore.get('persona') || 'jarvis';
    for (const p of list) {
      const star = p.id === active ? fmt.green('●') : ' ';
      process.stdout.write(`  ${star} ${fmt.cyan(p.id.padEnd(14))} ${fmt.dim(p.tagline || p.description || '')}\n`);
    }
    return 'done';
  }
  if (head === '/model') {
    const newProv = rest[0];
    if (!newProv) {
      const current = runtime.settingsStore.get('provider') || 'gemini';
      const m = runtime.settingsStore.get('model.' + current) || '';
      process.stdout.write(`${fmt.cyan(current)} ${fmt.dim('(' + m + ')')}\n`);
    } else {
      runtime.settingsStore.set('provider', newProv);
      process.stdout.write(fmt.ok('provider → ' + fmt.cyan(newProv)) + '\n');
    }
    return 'done';
  }
  if (head === '/model-list') {
    const { DEFAULT_PROVIDER_MODELS } = require('../src/main/runtime/ai-providers');
    for (const [p, m] of Object.entries(DEFAULT_PROVIDER_MODELS)) {
      const has = ['ollama','lmstudio','localai'].includes(p)
        ? '—' : (runtime.keysStore.get('k_' + p) ? fmt.green('✓') : fmt.dim('·'));
      process.stdout.write(`  ${has}  ${fmt.cyan(p.padEnd(13))} ${fmt.dim(m)}\n`);
    }
    return 'done';
  }
  if (head === '/mem') {
    const q = rest.join(' ');
    if (!q) { process.stdout.write(fmt.err('usage: /mem "query"\n')); return 'done'; }
    const results = await runtime.agentMemory.semanticRecall(q, 5, {});
    if (!results.length) process.stdout.write(fmt.dim('no matches\n'));
    else for (const m of results) {
      const score = typeof m.score === 'number' ? fmt.dim(`(${m.score.toFixed(2)}) `) : '';
      process.stdout.write(`${score}${m.content || m.text || ''}\n`);
    }
    return 'done';
  }
  if (head === '/verbose') {
    process.stdout.write(fmt.dim('verbose toggle: restart with --verbose\n'));
    return 'done';
  }
  process.stdout.write(fmt.err('unknown slash command: ' + head) + '\n');
  return 'done';
}

async function runOne(runtime, state, message, opts = {}) {
  const mode = opts.mode || state.mode;
  if (mode === 'agent') {
    await runAgent(runtime, state, message);
  } else {
    await runChat(runtime, state, message);
  }
}

async function runChat(runtime, state, message) {
  // Print the "Horizon: " prefix once, then stream tokens.
  process.stdout.write('\n' + fmt.bold('Horizon: '));
  if (state.stream) {
    const spinner = new GradientSpinner('thinking…').start();
    let firstToken = true;
    const r = await runtime.runChatStream(message, {
      history: state.history,
    }, (chunk) => {
      if (firstToken) { spinner.stop(); firstToken = false; }
      process.stdout.write(chunk);
    });
    if (!firstToken) {
      // tokens did stream — finalise with a newline + optional markdown re-render
      process.stdout.write('\n');
      if (state.markdown && r.reply && /[*_`#>-]/.test(r.reply)) {
        // Re-render with markdown formatting under a "formatted" divider so
        // the raw streamed text and rendered version are both visible.
        process.stdout.write(fmt.dim('─── rendered ───') + '\n');
        process.stdout.write(renderMarkdown(r.reply) + '\n');
      }
    } else {
      spinner.stop();
      if (r.error) {
        process.stdout.write(fmt.err(r.error) + '\n');
        return;
      }
      // streaming returned nothing — likely cohere or some provider that
      // doesn't support stream. Fall back to non-stream.
      const r2 = await runtime.runChat(message, { history: state.history });
      if (r2.reply) {
        process.stdout.write((state.markdown ? renderMarkdown(r2.reply) : r2.reply) + '\n');
      } else if (r2.error) {
        process.stdout.write(fmt.err(r2.error) + '\n');
      }
    }
    if (r.reply) {
      state.history.push({ role: 'user', content: message });
      state.history.push({ role: 'assistant', content: r.reply });
    }
  } else {
    const spinner = new GradientSpinner('thinking…').start();
    const r = await runtime.runChat(message, { history: state.history });
    spinner.stop();
    if (r.reply) {
      process.stdout.write((state.markdown ? renderMarkdown(r.reply) : r.reply) + '\n');
      state.history.push({ role: 'user', content: message });
      state.history.push({ role: 'assistant', content: r.reply });
    } else if (r.error) {
      process.stdout.write(fmt.err(r.error) + '\n');
    }
  }
}

async function runAgent(runtime, state, task) {
  const rail = new StepRail();
  rail.startThinking('planning…');
  const r = await runtime.runAgent(task, {
    history: state.history,
    onStep: (event) => {
      switch (event.type) {
        case 'plan': if (event.plan?.steps) rail.showPlan(event.plan.steps); break;
        case 'thinking': /* keep spinner; could update label */ break;
        case 'executing': rail.executing(event.tool, event.args); break;
        case 'result':    rail.result(event.tool, event.ok, event.result); break;
        case 'reflection': rail.reflection(event.goalMet, event.confidence); break;
      }
    },
    askPermission: async ({ tool, args, reason }) => {
      const dangerous = /^(run_code|run_shell|run_python|write_file|delete_file|move_file|conn_.*_send|conn_.*_post|conn_.*_create|conn_.*_append|conn_.*_comment|mouse_click|keyboard_type|smart_click)$/i.test(tool);
      if (!dangerous) return true;
      rail.stop();
      return new Promise(resolve => {
        process.stdout.write(fmt.warn(`approve ${fmt.bold(tool)} ${fmt.dim(fmtArgs(args))} (${reason || 'agent step'}) y/N: `));
        const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl2.question('', (ans) => {
          rl2.close();
          resolve(/^(y|yes|д|да)/i.test(ans.trim()));
        });
      });
    },
  });
  rail.stop();
  if (r.answer) {
    process.stdout.write('\n' + fmt.bold('Horizon: '));
    process.stdout.write((state.markdown ? renderMarkdown(r.answer) : r.answer) + '\n');
    state.history.push({ role: 'user', content: task });
    state.history.push({ role: 'assistant', content: r.answer });
  } else if (r.error) {
    process.stdout.write(fmt.err(r.error) + '\n');
  }
}

module.exports = { main };

if (require.main === module) {
  main({ flags: {} });
}
