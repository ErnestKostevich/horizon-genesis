'use strict';
/**
 * Standalone eval scorecard — `npm run eval`.
 *
 * Prints a per-task pass/fail table plus aggregate metrics (pass rate, total
 * tool calls, total reflections, total steps). Use it to snapshot a BASELINE
 * before a loop change, then re-run after to spot regressions at a glance.
 *
 * Exits non-zero if any task fails, so it doubles as a CI gate.
 */

const { runEval, scoreTask } = require('./harness');
const tasks = require('./tasks');

// Minimal ANSI (no dep on the CLI's tty helper — eval must run anywhere).
const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m', c: '\x1b[36m' }
  : { g: '', r: '', d: '', b: '', x: '', c: '' };

(async () => {
  const t0 = Date.now();
  let passed = 0;
  let totalSteps = 0;
  let totalReflections = 0;
  const rows = [];

  for (const task of tasks) {
    let result, score;
    try {
      result = await runEval(task);
      score = scoreTask(task, result);
    } catch (e) {
      score = { passed: false, failures: [`threw: ${e.message}`] };
      result = { steps: [], reflections: [], toolsCalled: [] };
    }
    if (score.passed) passed++;
    totalSteps += result.steps.length;
    totalReflections += result.reflections.length;
    rows.push({ task, result, score });
  }

  process.stdout.write('\n  ' + C.b + 'Horizon Agent — eval scorecard' + C.x + '\n');
  process.stdout.write('  ' + C.d + tasks.length + ' golden tasks · deterministic replay' + C.x + '\n\n');

  for (const { task, result, score } of rows) {
    const mark = score.passed ? C.g + 'PASS' + C.x : C.r + 'FAIL' + C.x;
    const meta = C.d + `${result.steps.length} steps · ${result.toolsCalled.length} tools · ${result.reflections.length} refl` + C.x;
    process.stdout.write(`  ${mark}  ${task.name.padEnd(34)} ${meta}\n`);
    if (!score.passed) {
      for (const f of score.failures) process.stdout.write(`        ${C.r}↳ ${f}${C.x}\n`);
    }
  }

  const rate = Math.round((passed / tasks.length) * 100);
  const rateColor = passed === tasks.length ? C.g : C.r;
  process.stdout.write('\n  ' + C.b + 'Summary' + C.x + '\n');
  process.stdout.write(`  ${rateColor}${passed}/${tasks.length} passed (${rate}%)${C.x}\n`);
  process.stdout.write(`  ${C.d}${totalSteps} total steps · ${totalReflections} total reflections · ${Date.now() - t0}ms${C.x}\n\n`);

  process.exit(passed === tasks.length ? 0 : 1);
})();
