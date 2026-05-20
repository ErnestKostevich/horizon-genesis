'use strict';
/**
 * spawn_subagent — delegate a self-contained task to an isolated sub-agent.
 *
 * The actual implementation lives in main.js's spawnSubagent (it owns
 * aiFn / sysInfo / persona / event-bridge wiring); we look it up lazily
 * through the require cache so agent.js stays standalone for tests, the
 * same pattern the original switch used.
 */

const { register } = require('./registry');

register({
  name: 'spawn_subagent',
  description: 'Delegate a self-contained sub-task to an isolated sub-agent that runs in parallel-friendly mode (its own history, own steps, max 4 turns). Use for research / multi-source lookups / independent fact-finding before composing the final answer. Returns { ok, answer, steps }. Subagents cannot themselves spawn deeper subagents (depth cap = 2).',
  parameters: {
    task: 'string — concrete self-contained goal',
    tools: 'string[] optional — restrict the subagent to specific tool names',
    maxSteps: 'number optional (default 4)',
    timeoutMs: 'number optional (default 60000)',
  },
  async execute(args = {}, ctx = {}) {
    try {
      const mainMod = require.cache[require.resolve('../main')];
      const spawn = mainMod?.exports?.spawnSubagent;
      if (typeof spawn !== 'function') return { ok: false, err: 'subagent runtime not initialised' };
      return await spawn({
        task: String(args.task || '').trim(),
        parentRunId: ctx.runId || null,
        event: ctx.event || null,
        allowedTools: Array.isArray(args.tools) ? args.tools : null,
        maxSteps: Number(args.maxSteps) || undefined,
        timeoutMs: Number(args.timeoutMs) || undefined,
      });
    } catch (e) {
      return { ok: false, err: 'spawn_subagent failed: ' + e.message };
    }
  },
});
