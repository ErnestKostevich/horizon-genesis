'use strict';
/**
 * spawn_subagent — delegate a self-contained task to an isolated sub-agent.
 *
 * Sprint 7C — now backed by the durable KanbanQueue:
 *   - spawn_subagent       enqueues a task and returns {taskId, status}.
 *                          If the caller passes `wait:true` (or omits it
 *                          in legacy mode), it transparently waits for
 *                          completion and returns the final result so
 *                          existing prompts keep working.
 *   - subagent_status      poll a task's status / result
 *   - subagent_wait        block until done / timeout
 *
 * The kanban queue handle is fetched from main.js's exports via the
 * same require.cache trick the old subagent used — keeps agent.js
 * standalone for tests, picks up the live queue at runtime.
 *
 * Why default `wait:true`: most existing agent loops were written
 * before the queue existed and treat spawn_subagent as a blocking call.
 * Setting wait:false opts into the new async-friendly mode where the
 * parent gets a taskId immediately and polls.
 */

const { register } = require('./registry');

function getKanbanQueue() {
  // Primary: main.js owns the live queue (Electron + CLI both write it
  // into their own module exports as soon as the queue is opened).
  try {
    const mainMod = require.cache[require.resolve('../main')];
    if (mainMod?.exports?.kanbanQueue) return mainMod.exports.kanbanQueue;
  } catch (_) {}
  // Fallback for tests / non-standard wiring: a test fixture can set
  // global.__HORIZON_KANBAN_QUEUE__ directly and skip the main.js dance.
  try {
    if (typeof globalThis !== 'undefined' && globalThis.__HORIZON_KANBAN_QUEUE__) {
      return globalThis.__HORIZON_KANBAN_QUEUE__;
    }
  } catch (_) {}
  return null;
}

function legacySpawn() {
  try {
    const mainMod = require.cache[require.resolve('../main')];
    return mainMod?.exports?.spawnSubagent || null;
  } catch (_) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms).unref?.());
}

// ── spawn_subagent ────────────────────────────────────────────────────
register({
  name: 'spawn_subagent',
  description: 'Delegate a self-contained sub-task to a durable sub-agent. The task is persisted to the Kanban queue and picked up by a worker process — it survives a parent crash. Default mode is wait:true (blocks until completion, returns {ok, answer, steps}); pass wait:false to return immediately with {taskId, status:"queued"} and poll via subagent_status / subagent_wait. Use for parallel-friendly research / multi-source lookups before composing the final answer.',
  parameters: {
    task:     'string — concrete self-contained goal',
    title:    'string optional — short label shown on the board (default: first 60 chars of task)',
    priority: 'number optional 1-10 (default 5)',
    tools:    'string[] optional — restrict the subagent to specific tool names',
    maxSteps: 'number optional (default 8)',
    timeoutMs: 'number optional (default 120000) — only honoured when wait:true',
    wait:     'boolean optional (default true) — false returns taskId immediately',
  },
  async execute(args = {}, ctx = {}) {
    const task = String(args.task || '').trim();
    if (!task) return { ok: false, err: 'task is required' };

    const queue = getKanbanQueue();

    // No queue available (HORIZON_KANBAN=off / better-sqlite3 missing /
    // Electron didn't init it yet). Fall back to the synchronous
    // spawnSubagent so the agent loop still works.
    if (!queue) {
      const spawn = legacySpawn();
      if (typeof spawn !== 'function') return { ok: false, err: 'subagent runtime not initialised' };
      return await spawn({
        task,
        parentRunId: ctx.runId || null,
        event: ctx.event || null,
        allowedTools: Array.isArray(args.tools) ? args.tools : null,
        maxSteps: Number(args.maxSteps) || undefined,
        timeoutMs: Number(args.timeoutMs) || undefined,
      });
    }

    // Enqueue.
    let taskId;
    try {
      taskId = queue.enqueue({
        title: args.title,
        task,
        parentId: ctx.parentTaskId || ctx.runId || null,
        priority: args.priority,
        options: {
          maxSteps: Number(args.maxSteps) || undefined,
          skills:   Array.isArray(args.tools) ? args.tools : undefined,
        },
      });
    } catch (e) {
      return { ok: false, err: 'enqueue failed: ' + e.message };
    }

    const wait = args.wait !== false;
    if (!wait) return { ok: true, taskId, status: 'queued' };

    // Blocking mode — poll until terminal status or timeout.
    const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 120_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(500);
      const t = queue.getById(taskId);
      if (!t) return { ok: false, taskId, err: 'task vanished' };
      if (t.status === 'done')      return { ok: true,  taskId, ...(t.result || {}) };
      if (t.status === 'failed')    return { ok: false, taskId, err: t.error || 'subagent failed' };
      if (t.status === 'cancelled') return { ok: false, taskId, err: 'cancelled', cancelled: true };
      // 'queued' / 'running' / 'abandoned' (will get re-queued) → keep polling
    }
    return { ok: false, taskId, err: 'timeout', timedOut: true };
  },
});

// ── subagent_status ───────────────────────────────────────────────────
register({
  name: 'subagent_status',
  description: 'Poll a Kanban task previously enqueued by spawn_subagent(wait:false). Returns {ok, status, title, priority, attempts, result?, error?}. Status is one of queued|running|done|failed|abandoned|cancelled.',
  parameters: {
    taskId: 'string — id returned by spawn_subagent',
  },
  async execute(args = {}) {
    const queue = getKanbanQueue();
    if (!queue) return { ok: false, err: 'kanban queue unavailable' };
    const taskId = String(args.taskId || '').trim();
    if (!taskId) return { ok: false, err: 'taskId is required' };
    const t = queue.getById(taskId);
    if (!t) return { ok: false, err: 'not found' };
    return {
      ok: true,
      taskId: t.id,
      status: t.status,
      title: t.title,
      priority: t.priority,
      attempts: t.attempts,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      result: t.result || null,
      error: t.error || null,
    };
  },
});

// ── subagent_wait ─────────────────────────────────────────────────────
register({
  name: 'subagent_wait',
  description: 'Block until a Kanban subagent task reaches a terminal status (done/failed/cancelled) or the timeout fires. Returns the same shape as the wait:true branch of spawn_subagent: {ok, taskId, answer?, steps?, err?, timedOut?}.',
  parameters: {
    taskId:    'string — id returned by spawn_subagent',
    timeoutMs: 'number optional (default 60000)',
  },
  async execute(args = {}) {
    const queue = getKanbanQueue();
    if (!queue) return { ok: false, err: 'kanban queue unavailable' };
    const taskId = String(args.taskId || '').trim();
    if (!taskId) return { ok: false, err: 'taskId is required' };
    const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 60_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const t = queue.getById(taskId);
      if (!t) return { ok: false, taskId, err: 'not found' };
      if (t.status === 'done')      return { ok: true,  taskId, ...(t.result || {}) };
      if (t.status === 'failed')    return { ok: false, taskId, err: t.error || 'subagent failed' };
      if (t.status === 'cancelled') return { ok: false, taskId, err: 'cancelled', cancelled: true };
      await sleep(500);
    }
    return { ok: false, taskId, err: 'timeout', timedOut: true };
  },
});
