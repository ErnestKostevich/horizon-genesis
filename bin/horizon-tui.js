#!/usr/bin/env node
// Horizon TUI — interactive terminal shell.
//
// Built on the Node stdlib `readline` + ANSI escapes. Not as polished as
// `ink` would be (no React, no spinners-in-place, no syntax-highlighted
// markdown rendering), but: zero extra deps, instant startup, works over
// SSH, and reuses the exact same headless runtime the CLI runs.
//
// Surface (matches the plan):
//   - persistent chat history at the top
//   - composer at the bottom — multiline (Enter sends; Shift+Enter for
//     newline is hard in pure readline, so use \\ at end of line to
//     continue)
//   - slash commands: /help /quit /skills /skill X /persona X /model X
//                     /persona-list /model-list /mem "q" /reset /clear
//   - streaming-style output (agent step rail printed inline)

const path = require('path');
const readline = require('readline');
const { createHorizonRuntime } = require('../src/main/runtime/headless');
const { fmt, isTTY } = require('./lib/tty');

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
  /verbose              toggle boot/step verbosity
`;

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function banner(rt) {
  const provider = rt.settingsStore.get('provider') || 'gemini';
  const persona = rt.settingsStore.get('persona') || 'jarvis';
  const memCount = rt.agentMemory?._data?.memories?.length || 0;
  const skillCount = rt.skillsManager?.list().length || 0;
  process.stdout.write(
    `\n${fmt.bold('Horizon AI')} ${fmt.dim('TUI')}\n` +
    `${fmt.dim(`provider=${provider} · persona=${persona} · memory=${memCount} · skills=${skillCount}`)}\n` +
    `${fmt.dim('type /help for commands · empty Enter to send · /quit to exit')}\n\n`
  );
}

function fmtArgs(a) {
  if (!a) return '';
  try {
    const s = JSON.stringify(a);
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  } catch (_) { return ''; }
}

function makeOnStep() {
  return (event) => {
    switch (event.type) {
      case 'plan':
        if (event.plan?.steps) {
          process.stdout.write('\n' + fmt.bold('plan'));
          event.plan.steps.forEach((s, i) =>
            process.stdout.write(`\n  ${fmt.dim((i+1) + '.')} ${s}`));
          process.stdout.write('\n');
        }
        break;
      case 'executing':
        process.stdout.write(fmt.arrow(`${fmt.cyan(event.tool)} ${fmt.dim(fmtArgs(event.args))}`) + '\n');
        break;
      case 'result':
        if (event.ok) {
          const out = event.result?.out || '';
          if (out) {
            const trimmed = String(out).length > 200 ? String(out).slice(0, 197) + '…' : out;
            process.stdout.write('  ' + fmt.dim(trimmed) + '\n');
          }
        } else {
          process.stdout.write('  ' + fmt.red(event.result?.err || 'error') + '\n');
        }
        break;
      case 'reflection': {
        const tag = event.goalMet === 'yes' ? fmt.green('goal-met')
                  : event.goalMet === 'partial' ? fmt.yellow('partial')
                  : fmt.red('not-met');
        process.stdout.write(fmt.dim('reflection ') + tag + '\n');
        break;
      }
    }
  };
}

async function main({ flags } = {}) {
  const runtime = createHorizonRuntime({
    userDataDir: flags?.['user-data-dir'],
    workspaceDir: flags?.workspace || process.cwd(),
    verbose: !!flags?.verbose,
  });

  if (!isTTY) {
    process.stderr.write(fmt.warn('TUI needs an interactive terminal. Pipe input?') + '\n');
  }

  clearScreen();
  banner(runtime);

  const history = []; // chat history for the AI (role/content)
  let mode = 'chat'; // 'chat' or 'agent' — flips per command

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: fmt.cyan('› '),
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const raw = line.trim();
    if (!raw) { rl.prompt(); return; }

    // Slash commands ─────────────────────────────────────────────────────
    if (raw.startsWith('/')) {
      const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      const head = tokens[0];
      const rest = tokens.slice(1).map(t => t.replace(/^"|"$/g, ''));

      if (head === '/quit' || head === '/exit') {
        process.stdout.write(fmt.dim('bye\n'));
        rl.close();
        return;
      }
      if (head === '/help') { process.stdout.write(SLASH_HELP); rl.prompt(); return; }
      if (head === '/clear') { clearScreen(); banner(runtime); rl.prompt(); return; }
      if (head === '/reset') {
        history.length = 0;
        process.stdout.write(fmt.dim('chat history cleared (memory retained)\n'));
        rl.prompt(); return;
      }
      if (head === '/skills') {
        const list = runtime.skillsManager?.list() || [];
        for (const s of list) {
          process.stdout.write(`  ${fmt.cyan(s.id.padEnd(20))} ${fmt.dim('· ' + (s.description || ''))}\n`);
        }
        rl.prompt(); return;
      }
      if (head === '/skill-show') {
        const id = rest[0];
        if (!id) { process.stdout.write(fmt.err('usage: /skill-show <id>\n')); rl.prompt(); return; }
        const raw = runtime.skillsManager?.readSource(id);
        if (raw) process.stdout.write(raw + '\n');
        else process.stdout.write(fmt.err('not found\n'));
        rl.prompt(); return;
      }
      if (head === '/skill') {
        const id = rest[0];
        if (!id) { process.stdout.write(fmt.err('usage: /skill <id> [task]\n')); rl.prompt(); return; }
        mode = 'agent';
        await runOne(runtime, history, rest.slice(1).join(' ') || `Apply skill ${id} on context.`, { mode: 'agent' });
        rl.prompt(); return;
      }
      if (head === '/agent') {
        const task = rest.join(' ');
        if (!task) { process.stdout.write(fmt.err('usage: /agent <task>\n')); rl.prompt(); return; }
        await runOne(runtime, history, task, { mode: 'agent' });
        rl.prompt(); return;
      }
      if (head === '/chat') {
        const msg = rest.join(' ');
        if (!msg) { process.stdout.write(fmt.err('usage: /chat <message>\n')); rl.prompt(); return; }
        await runOne(runtime, history, msg, { mode: 'chat' });
        rl.prompt(); return;
      }
      if (head === '/persona') {
        const id = rest[0];
        if (!id) {
          process.stdout.write(`${fmt.cyan(runtime.settingsStore.get('persona') || 'jarvis')}\n`);
        } else {
          runtime.settingsStore.set('persona', id);
          process.stdout.write(fmt.ok('persona → ' + fmt.cyan(id)) + '\n');
        }
        rl.prompt(); return;
      }
      if (head === '/persona-list') {
        const list = runtime.personas?.getAllPersonas?.() || [];
        const active = runtime.settingsStore.get('persona') || 'jarvis';
        for (const p of list) {
          const star = p.id === active ? fmt.green('●') : ' ';
          process.stdout.write(`  ${star} ${fmt.cyan(p.id.padEnd(14))} ${fmt.dim(p.tagline || p.description || '')}\n`);
        }
        rl.prompt(); return;
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
        rl.prompt(); return;
      }
      if (head === '/model-list') {
        const { DEFAULT_PROVIDER_MODELS } = require('../src/main/runtime/ai-providers');
        for (const [p, m] of Object.entries(DEFAULT_PROVIDER_MODELS)) {
          const has = ['ollama','lmstudio','localai'].includes(p)
            ? '—' : (runtime.keysStore.get('k_' + p) ? fmt.green('✓') : fmt.dim('·'));
          process.stdout.write(`  ${has}  ${fmt.cyan(p.padEnd(13))} ${fmt.dim(m)}\n`);
        }
        rl.prompt(); return;
      }
      if (head === '/mem') {
        const q = rest.join(' ');
        if (!q) { process.stdout.write(fmt.err('usage: /mem "query"\n')); rl.prompt(); return; }
        const results = await runtime.agentMemory.semanticRecall(q, 5, {});
        if (!results.length) {
          process.stdout.write(fmt.dim('no matches\n'));
        } else {
          for (const m of results) {
            const score = typeof m.score === 'number' ? fmt.dim(`(${m.score.toFixed(2)}) `) : '';
            process.stdout.write(`${score}${m.content || m.text || ''}\n`);
          }
        }
        rl.prompt(); return;
      }
      if (head === '/verbose') {
        // toggle by re-creating? simpler: just print a note.
        process.stdout.write(fmt.dim('verbose toggle: restart with --verbose\n'));
        rl.prompt(); return;
      }
      process.stdout.write(fmt.err('unknown slash command: ' + head) + '\n');
      rl.prompt(); return;
    }

    // Plain message → run in current mode (chat by default).
    await runOne(runtime, history, raw, { mode });
    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}

async function runOne(runtime, history, message, { mode = 'chat' } = {}) {
  if (mode === 'agent') {
    const onStep = makeOnStep();
    const r = await runtime.runAgent(message, {
      onStep,
      history,
      askPermission: async ({ tool, args, reason }) => {
        // Auto-approve for read-only-ish tools, prompt for the rest.
        const dangerous = /^(run_code|run_shell|run_python|write_file|delete_file|move_file|conn_.*_send|conn_.*_post|conn_.*_create|conn_.*_append|conn_.*_comment|mouse_click|keyboard_type|smart_click)$/i.test(tool);
        if (!dangerous) return true;
        // simple synchronous-ish prompt — readline is busy so use raw question
        return new Promise(resolve => {
          process.stdout.write(fmt.warn(`approve ${fmt.bold(tool)} ${fmt.dim(fmtArgs(args))} (${reason || 'agent step'}) y/N: `));
          const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl2.question('', (ans) => {
            rl2.close();
            const yes = /^(y|yes|д|да)/i.test(ans.trim());
            resolve(yes);
          });
        });
      },
    });
    if (r.answer) {
      process.stdout.write('\n' + fmt.bold('Horizon: ') + r.answer.trim() + '\n');
      history.push({ role: 'user', content: message });
      history.push({ role: 'assistant', content: r.answer });
    } else if (r.error) {
      process.stdout.write(fmt.err(r.error) + '\n');
    }
  } else {
    const r = await runtime.runChat(message, { history });
    if (r.reply) {
      process.stdout.write(fmt.bold('Horizon: ') + r.reply.trim() + '\n');
      history.push({ role: 'user', content: message });
      history.push({ role: 'assistant', content: r.reply });
    } else if (r.error) {
      process.stdout.write(fmt.err(r.error) + '\n');
    }
  }
}

module.exports = { main };

if (require.main === module) {
  main({ flags: {} });
}
