// `horizon agent "task"` — full agent loop, streams steps to stdout.
//
// Output formats:
//   --json   (default in non-TTY) → one JSON object per line (NDJSON).
//            Last line has type='run-end' with the full result.
//   --human  (default in TTY) → live step rail with gradient spinner.
//   --quiet  → only the final answer.
//
// Live step rail features:
//   - GradientSpinner during thinking/executing phases
//   - Plan printed as a tree on first plan event
//   - Each tool result committed as a fixed line (✓ or ✗)
//   - Reflection epilogue colour-coded (green/yellow/red)
//   - Markdown rendering for the final answer
//
// Permission flags:
//   --auto-approve   approve every tool call (for unattended cron)
//   --never-approve  reject every tool call (read-only safe mode)
//   default          interactive prompt for shell/file-write tools

const { fmt, promptYesNo, isTTY, friendlyError } = require('../tty');
const { renderMarkdown } = require('../markdown');
const { GradientSpinner } = require('../banner');

function fmtArgs(a) {
  if (!a) return '';
  try {
    const s = JSON.stringify(a);
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  } catch (_) { return '<unprintable>'; }
}

async function run({ runtime, args, flags }) {
  const task = args.join(' ').trim();
  if (!task) {
    process.stderr.write(fmt.err('Need a task: horizon agent "what to do"') + '\n');
    return 2;
  }

  const human = flags.human || (!flags.json && isTTY);
  const quiet = !!flags.quiet;
  const wantMarkdown = human && !quiet && !flags.plain;

  let spinner = null;
  if (human && !quiet) {
    spinner = new GradientSpinner('starting…').start();
  }

  const askPermission = async ({ tool, args, reason }) => {
    if (flags['auto-approve']) return true;
    if (flags['never-approve']) return false;
    const dangerous = /^(run_code|run_shell|run_python|write_file|delete_file|move_file|conn_.*_send|conn_.*_post|conn_.*_create|conn_.*_append|conn_.*_comment|mouse_click|mouse_drag|keyboard_type|keyboard_press|click_image|smart_click)$/i.test(tool);
    if (!dangerous) return true;
    if (spinner) spinner.stop();
    process.stderr.write(
      fmt.warn(`approve ${fmt.bold(tool)} ${fmt.dim(fmtArgs(args))}? ${fmt.dim('(' + (reason || 'agent step') + ')')}\n`)
    );
    const ok = await promptYesNo(fmt.cyan('  y/N:'));
    if (human && !quiet) spinner = new GradientSpinner('working…').start();
    return ok;
  };

  const onStep = (event) => {
    if (flags.json) {
      try { process.stdout.write(JSON.stringify(event) + '\n'); } catch (_) {}
      return;
    }
    if (!human || quiet) return;
    switch (event.type) {
      case 'plan':
        if (spinner) spinner.stop();
        if (event.plan?.steps?.length) {
          process.stderr.write('\n' + fmt.bold('plan') + '\n');
          event.plan.steps.forEach((s, i) => {
            const txt = typeof s === 'string' ? s : (s.text || JSON.stringify(s));
            process.stderr.write(`  ${fmt.dim((i + 1) + '.')} ${txt}\n`);
          });
          process.stderr.write('\n');
        }
        spinner = new GradientSpinner('working…').start();
        break;
      case 'thinking':
        if (spinner) spinner.update(event.message || 'thinking…');
        break;
      case 'executing':
        if (spinner) spinner.update(`${event.tool}(${fmtArgs(event.args)})`);
        break;
      case 'result':
        if (spinner) spinner.stop();
        if (event.ok) {
          const tag = fmt.green('✓');
          process.stderr.write(`  ${tag} ${fmt.cyan(event.tool)} ${fmt.dim(fmtArgs(event.args))}\n`);
          const out = String(event.result?.out || '');
          if (out && out.length < 400) {
            for (const l of out.split('\n').slice(0, 4)) {
              process.stderr.write('    ' + fmt.dim(l) + '\n');
            }
          }
        } else {
          const err = event.result?.err || event.result?.error || 'unknown';
          process.stderr.write(`  ${fmt.red('✗')} ${fmt.cyan(event.tool)} ${fmt.red(String(err).slice(0, 120))}\n`);
        }
        spinner = new GradientSpinner('thinking…').start();
        break;
      case 'reflection':
        if (spinner) spinner.stop();
        const tag = event.goalMet === 'yes' ? fmt.green('● goal met')
                  : event.goalMet === 'partial' ? fmt.yellow('● partial')
                  : fmt.red('● not met');
        const conf = event.confidence ? fmt.dim(` confidence=${event.confidence}`) : '';
        process.stderr.write(`  ${tag}${conf}\n`);
        spinner = new GradientSpinner('finishing…').start();
        break;
    }
  };

  // Fix 9 — show failover notice to user (e.g. "Retrying with claude...")
  const onNotice = (msg) => {
    if (flags.quiet || flags.json) return;
    if (spinner) spinner.stop();
    process.stderr.write(fmt.dim('  ' + msg) + '\n');
    if (human && !quiet) spinner = new GradientSpinner('working…').start();
  };

  const result = await runtime.runAgent(task, {
    onStep,
    askPermission,
    onNotice,
    maxSteps: flags['max-steps'] ? Number(flags['max-steps']) : 8,
    reflect: flags.reflect !== false,
    provider: flags.provider,
    model: flags.model,
    persona: flags.persona,
  });

  if (spinner) spinner.stop();

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      type: 'run-end',
      ok: !!result.ok,
      answer: result.answer || '',
      steps: result.steps?.length || 0,
      stopped: !!result.stopped,
      error: result.error || null,
    }) + '\n');
  } else {
    if (result.error) {
      process.stderr.write(fmt.err(friendlyError(result.error)) + '\n');
      return 1;
    }
    if (result.answer) {
      process.stdout.write('\n' + (wantMarkdown ? renderMarkdown(result.answer) : result.answer.trim()) + '\n');
    }
    if (human && !quiet) {
      process.stderr.write(
        '\n' + fmt.dim(`done · ${result.steps?.length || 0} steps · ${result.ok ? 'goal met' : 'partial'}`) + '\n'
      );
    }
  }
  return result.ok ? 0 : 1;
}

module.exports = { run };
