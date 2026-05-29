'use strict';
/**
 * Horizon Agent — eval / regression harness  (WS0)
 *
 * Replays golden tasks through the REAL runAgentLoop with a deterministic
 * stubbed aiFn + dispatchToolFn, then scores the run against assertions.
 * No network, no real model, no real tools — so it's fast, hermetic, and
 * safe to run in CI.
 *
 * Why this exists: the agent gathers quality signals (reflection verdicts,
 * which tools it called, step budget) but nothing measured whether a change
 * to the loop helps or silently regresses simple turns. This harness is the
 * baseline that de-risks the WS1 corrective-loop work.
 *
 * Public API:
 *   scriptedAiFn(script, reflections?) -> aiFn
 *   stubDispatch(toolResults)          -> dispatchToolFn
 *   runEval(task)                      -> { ok, answer, steps, toolsCalled, reflections, events, error }
 *   scoreTask(task, result)            -> { passed, failures: [...] }
 */

const { runAgentLoop } = require('../../src/main/agentLoop');

// ── Deterministic aiFn ─────────────────────────────────────────────────────
// `script` drives the MAIN step loop: each entry is the reply for one step.
// An entry may be a raw string or an object — objects are JSON-stringified so
// parseAgentResponse() sees them as {type:'tool'|'done'|'answer'|'plan', ...}.
//
// `reflections` drives the separate reflection epilogue. runAgentLoop tags
// the reflection call with meta.step === 'reflect'; we pop reflection replies
// off their own queue so a corrective round (WS1) can return "no" then "yes".
function scriptedAiFn(script, reflections) {
  const main = Array.isArray(script) ? script.slice() : [];
  const refl = Array.isArray(reflections) ? reflections.slice()
             : reflections ? [reflections] : [];
  let mainIdx = 0;
  let reflIdx = 0;
  const calls = { main: 0, reflect: 0 };

  const fn = async (_messages, _systemPrompt, meta) => {
    if (meta && meta.step === 'reflect') {
      calls.reflect++;
      const r = refl.length
        ? refl[Math.min(reflIdx++, refl.length - 1)]
        : { goal_met: 'yes', summary: 'ok', gaps: [], confidence: 0.9 };
      return { reply: typeof r === 'string' ? r : JSON.stringify(r) };
    }
    calls.main++;
    if (mainIdx >= main.length) {
      // Ran out of scripted replies — return a terminal answer so the loop
      // can't hang. A task that hits this usually has a budget bug.
      return { reply: JSON.stringify({ type: 'done', text: 'Script exhausted.' }) };
    }
    const item = main[mainIdx++];
    return { reply: typeof item === 'string' ? item : JSON.stringify(item) };
  };
  fn.calls = calls;
  return fn;
}

// ── Deterministic tool dispatch ────────────────────────────────────────────
// `toolResults` maps tool name -> result object ({ ok, out } / { ok:false, err })
// or a function (tool, args) -> result. Unknown tools return a soft failure
// (matches how a real missing tool behaves without throwing).
function stubDispatch(toolResults = {}) {
  return async (tool, args) => {
    const entry = toolResults[tool];
    if (typeof entry === 'function') return entry(tool, args);
    if (entry) return entry;
    return { ok: false, err: `No stub for tool "${tool}"` };
  };
}

// ── Run one task through the real loop ─────────────────────────────────────
async function runEval(task) {
  const events = [];
  const reflections = [];
  // An onStep recorder. Reflection only fires when onStep is present (current
  // behaviour); recording it also lets us assert on plan / tool events later.
  const onStep = (payload) => {
    events.push(payload);
    if (payload && payload.type === 'reflection') reflections.push(payload);
  };

  const aiFn = scriptedAiFn(task.script, task.reflection ?? task.reflections);
  const dispatchToolFn = stubDispatch(task.tools || {});

  const result = await runAgentLoop(task.message, {
    aiFn,
    dispatchToolFn,
    onStep,
    lang: task.lang || 'en',
    maxSteps: task.maxSteps ?? 8,
    nativeTools: false,
    timeout: 5000,
    runId: `eval-${task.name}`,
    ...(task.opts || {}),
  });

  return {
    ok: result.ok,
    answer: result.answer || null,
    steps: result.steps || [],
    toolsCalled: (result.steps || []).map((s) => s.tool),
    reflections,
    correctiveRounds: result.correctiveRounds || 0,
    events,
    aiCalls: aiFn.calls,
    error: result.error || null,
    raw: result,
  };
}

// ── Score a run against the task's `expect` block ──────────────────────────
function scoreTask(task, result) {
  const e = task.expect || {};
  const failures = [];

  if (e.noError && (result.error || result.ok === false)) {
    failures.push(`expected no error, got: ${result.error || 'ok=false'}`);
  }
  if (e.error && !result.error) {
    failures.push(`expected an error, but run succeeded`);
  }
  if (Array.isArray(e.toolsCalled)) {
    const got = result.toolsCalled.join(',');
    const want = e.toolsCalled.join(',');
    if (got !== want) failures.push(`tools: expected [${want}], got [${got}]`);
  }
  if (Array.isArray(e.toolsInclude)) {
    for (const t of e.toolsInclude) {
      if (!result.toolsCalled.includes(t)) failures.push(`expected tool "${t}" to be called`);
    }
  }
  if (typeof e.answerIncludes === 'string') {
    if (!String(result.answer || '').includes(e.answerIncludes)) {
      failures.push(`answer should include "${e.answerIncludes}", got: ${String(result.answer || '').slice(0, 120)}`);
    }
  }
  if (typeof e.maxSteps === 'number') {
    if (result.steps.length > e.maxSteps) {
      failures.push(`step budget: expected <= ${e.maxSteps}, got ${result.steps.length}`);
    }
  }
  if (typeof e.minReflections === 'number') {
    if (result.reflections.length < e.minReflections) {
      failures.push(`reflections: expected >= ${e.minReflections}, got ${result.reflections.length}`);
    }
  }
  if (typeof e.goalMet === 'string') {
    const last = result.reflections[result.reflections.length - 1];
    if (!last || last.goalMet !== e.goalMet) {
      failures.push(`final reflection goalMet: expected "${e.goalMet}", got "${last ? last.goalMet : 'none'}"`);
    }
  }
  if (typeof e.correctiveRounds === 'number') {
    if (result.correctiveRounds !== e.correctiveRounds) {
      failures.push(`correctiveRounds: expected ${e.correctiveRounds}, got ${result.correctiveRounds}`);
    }
  }
  // No-loop guard: a tool repeated 3+ times in a row is the loop's own
  // bail-out signal — a healthy golden task should never trip it.
  if (e.noLoop) {
    let prev = null, run = 0, tripped = false;
    for (const t of result.toolsCalled) {
      if (t === prev) { run++; if (run >= 3) tripped = true; } else { prev = t; run = 1; }
    }
    if (tripped) failures.push('loop guard tripped (same tool 3x in a row)');
  }

  return { passed: failures.length === 0, failures };
}

module.exports = { scriptedAiFn, stubDispatch, runEval, scoreTask };
