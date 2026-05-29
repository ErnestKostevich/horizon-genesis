'use strict';
/**
 * node --test wrapper for the eval harness. Each golden task becomes one
 * test case; scoreTask failures become assertion messages. Runs in the
 * normal `npm test` suite so regressions block before release.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { runEval, scoreTask } = require('./harness');
const tasks = require('./tasks');

for (const task of tasks) {
  test(`eval: ${task.name}`, async () => {
    const result = await runEval(task);
    const score = scoreTask(task, result);
    assert.ok(
      score.passed,
      `Task "${task.name}" failed:\n  - ${score.failures.join('\n  - ')}`
    );
  });
}
