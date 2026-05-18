// `horizon agent "task"` — full agent loop, streams steps to stdout.
//
// Output formats:
//   --json   (default in non-TTY) → one JSON object per line (NDJSON).
//            Last line has type='run-end' with the full result.
//   --human  (default in TTY) → pretty step-by-step with spinner.
//   --quiet  → only the final answer.
//
// Permission flags:
//   --auto-approve   approve every tool call (for unattended cron)
//   --never-approve  reject every tool call (read-only safe mode)
//   default          interactive prompt for shell/file-write tools

const { fmt, Spinner, promptYesNo, isTTY } = require('../tty');

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

  let spinner = null;
  if (human && !quiet) {
    spinner = new Spinner('starting…').start();
  }

  const askPermission = async ({ tool, args, reason }) => {
    if (flags['auto-approve']) return true;
    if (flags['never-approve']) return false;
    // Only prompt for destructive-ish tools. Read-only is auto.
    const dangerous = /^(run_code|run_shell|run_python|write_file|delete_file|move_file|conn_.*_send|conn_.*_post|conn_.*_create|conn_.*_append|conn_.*_comment|mouse_click|mouse_drag|keyboard_type|keyboard_press|click_image|smart_click)$/i.test(tool);
    if (!dangerous) return true;
    if (spinner) spinner.stop();
    process.stderr.write(
      fmt.warn(`approve ${fmt.bold(tool)} ${fmt.dim(fmtArgs(args))}? ${fmt.dim('(' + (reason || 'agent step') + ')')}\n`)
    );
    const ok = await promptYesNo(fmt.cyan('  y/N:'));
    if (human && !quiet) spinner = new Spinner('working…').start();
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
        process.stderr.write(fmt.bold('plan') + ' ' +
          (event.plan?.steps || []).map((s, i) =>
            `\n  ${fmt.dim((i+1) + '.')} ${s}`).join('') + '\n');
        spinner = new Spinner('working…').start();
        break;
      case 'thinking':
        if (spinner) spinner.update('thinking… ' + (event.text ? event.text.slice(0, 60) : ''));
        break;
      case 'executing':
        if (spinner) spinner.update(`${event.tool}(${fmtArgs(event.args)})`);
        break;
      case 'result':
        if (spinner) spinner.stop();
        if (event.ok) {
          process.stderr.write(fmt.arrow(`${fmt.cyan(event.tool)} ${fmt.dim(fmtArgs(event.args))}`) + '\n');
          const out = (event.result?.out || event.result?.results ? JSON.stringify(event.result?.results) : '') || '';
          if (out) {
            const trimmed = out.length > 120 ? out.slice(0, 117) + '…' : out;
            process.stderr.write('  ' + fmt.dim(trimmed) + '\n');
          }
        } else {
          process.stderr.write(fmt.err(`${event.tool} failed: ${event.result?.err || event.result?.error || 'unknown'}`) + '\n');
        }
        spinner = new Spinner('thinking…').start();
        break;
      case 'reflection':
        if (spinner) spinner.stop();
        const tag = event.goalMet === 'yes' ? fmt.green('goal-met')
                  : event.goalMet === 'partial' ? fmt.yellow('partial')
                  : fmt.red('not-met');
        process.stderr.write(
          fmt.dim('reflection ') + tag +
          fmt.dim(` confidence=${event.confidence || '?'}`) + '\n'
        );
        spinner = new Spinner('thinking…').start();
        break;
    }
  };

  const result = await runtime.runAgent(task, {
    onStep,
    askPermission,
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
      process.stderr.write(fmt.err(result.error) + '\n');
      return 1;
    }
    if (result.answer) {
      process.stdout.write('\n' + result.answer.trim() + '\n');
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
