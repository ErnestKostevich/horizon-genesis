'use strict';
/**
 * KanbanWorker — long-lived loop that pulls queued tasks off the
 * KanbanQueue and runs them via runtime.runAgent().
 *
 * Lifecycle:
 *   1. poll: claim() the next task
 *   2. if claimed → start heartbeat timer (5s); call runtime.runAgent()
 *   3. on resolve → complete(); clear heartbeat
 *   4. on throw   → fail(); clear heartbeat
 *   5. if heartbeat returns false during a run → task was cancelled or
 *      reclaimed under us; we still let the AI call finish (no way to
 *      interrupt mid-call cleanly) but skip the complete()/fail()
 *   6. if claim() returns null → sleep pollIntervalMs and retry
 *   7. SIGTERM → set stopping flag; finish current task; resolve
 *      startWorker() promise
 *
 * Why one worker per process by default (HORIZON_WORKERS=N to scale):
 * runAgent() spins up an LLM call which can take a while; multiple
 * workers in the same process inflate event-loop pressure. Multiple
 * processes (e.g. `horizon serve` + a separate `node worker.js`) all
 * sharing the same kanban.sqlite is the supported HA path.
 */

const crypto = require('crypto');

const HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_POLL_MS = 2_000;

function newWorkerId(prefix = 'w') {
  return `${prefix}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Start a worker. Returns a handle:
 *   { workerId, stop(), running: bool, currentTaskId: string|null }
 *
 * stop() resolves once the in-flight task finishes (or immediately if
 * idle). The poll loop runs detached — startWorker() returns
 * synchronously after kicking off the first tick.
 *
 * @param {object} opts
 * @param {KanbanQueue} opts.queue
 * @param {object}      opts.runtime          — headless runtime with runAgent()
 * @param {string}      [opts.workerId]
 * @param {number}      [opts.pollIntervalMs=2000]
 * @param {Function}    [opts.onEvent]        — (type, data) — for IPC / logging
 * @param {Function}    [opts.log]            — (...args) → console.error-style
 */
function startWorker(opts = {}) {
  const queue = opts.queue;
  const runtime = opts.runtime;
  if (!queue) throw new Error('startWorker: queue required');
  if (!runtime || typeof runtime.runAgent !== 'function') {
    throw new Error('startWorker: runtime.runAgent required');
  }
  const workerId = opts.workerId || newWorkerId();
  const pollMs = Math.max(250, Number(opts.pollIntervalMs) || DEFAULT_POLL_MS);
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const emit = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  const state = {
    workerId,
    running: true,
    stopping: false,
    currentTaskId: null,
    activeRun: null, // promise of in-flight runAgent
    _stopResolvers: [],
  };

  function maybeResolveStop() {
    if (state.stopping && !state.activeRun) {
      state.running = false;
      const resolvers = state.stopResolvers || state._stopResolvers;
      for (const r of resolvers) { try { r(); } catch (_) {} }
      state._stopResolvers = [];
    }
  }

  async function tick() {
    if (!state.running || state.stopping) { maybeResolveStop(); return; }
    let task = null;
    try { task = queue.claim(workerId); }
    catch (e) { log('[kanban-worker] claim threw:', e.message); }

    if (!task) {
      // Empty queue — sleep and retry.
      setTimeout(tick, pollMs).unref?.();
      return;
    }

    state.currentTaskId = task.id;
    emit('task:start', { workerId, taskId: task.id, task });
    log(`[kanban-worker ${workerId}] start ${task.id} — ${task.title}`);

    // Heartbeat — every HEARTBEAT_INTERVAL_MS, refresh the row. If the
    // row is gone or no longer ours (cancelled / reclaimed), flag it so
    // we skip the complete()/fail() write below.
    let lost = false;
    const beat = setInterval(() => {
      try {
        const ok = queue.heartbeat(task.id, workerId);
        if (!ok) {
          lost = true;
          emit('task:lost', { workerId, taskId: task.id });
          log(`[kanban-worker ${workerId}] lost ownership of ${task.id}`);
          clearInterval(beat);
        }
      } catch (e) {
        log(`[kanban-worker ${workerId}] heartbeat threw:`, e.message);
      }
    }, HEARTBEAT_INTERVAL_MS);
    beat.unref?.();

    // Run the agent. We wire onStep through to emit() so the renderer
    // can stream step events for the currently-active card.
    const runPromise = (async () => {
      try {
        const result = await runtime.runAgent(task.task, {
          maxSteps: task.maxSteps || 8,
          provider: task.provider || undefined,
          model: task.model || undefined,
          persona: task.persona || undefined,
          onStep: (ev) => emit('task:step', { workerId, taskId: task.id, event: ev }),
          // auto-approve all tool calls for queue-driven runs — there's
          // no human in the loop to prompt. Callers wanting gated runs
          // should drive runAgent() directly, not the queue.
          askPermission: async () => true,
        });
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: e };
      }
    })();
    state.activeRun = runPromise;

    let outcome;
    try { outcome = await runPromise; }
    finally {
      clearInterval(beat);
      state.activeRun = null;
      state.currentTaskId = null;
    }

    if (lost) {
      emit('task:abandoned-during-run', { workerId, taskId: task.id });
      // skip writing — another worker (or cancel()) already owns the row
    } else if (outcome.ok) {
      try {
        queue.complete(task.id, workerId, outcome.result);
        emit('task:done', { workerId, taskId: task.id, result: outcome.result });
        log(`[kanban-worker ${workerId}] done ${task.id}`);
      } catch (e) {
        log(`[kanban-worker ${workerId}] complete() threw:`, e.message);
      }
    } else {
      const err = outcome.error;
      const msg = err instanceof Error ? (err.stack || err.message) : String(err);
      try {
        queue.fail(task.id, workerId, msg);
        emit('task:failed', { workerId, taskId: task.id, error: msg });
        log(`[kanban-worker ${workerId}] failed ${task.id}: ${msg.split('\n')[0]}`);
      } catch (e) {
        log(`[kanban-worker ${workerId}] fail() threw:`, e.message);
      }
    }

    if (state.stopping) { maybeResolveStop(); return; }
    // Loop immediately — the next tick will sleep if the queue is empty.
    setImmediate(tick);
  }

  // Kick off the loop.
  setImmediate(tick);

  // SIGTERM/SIGINT — best-effort graceful drain. Only register once per
  // process (multiple workers in the same process share the signal).
  const onSig = () => {
    if (state.stopping) return;
    state.stopping = true;
    log(`[kanban-worker ${workerId}] graceful stop requested`);
    maybeResolveStop();
  };
  // Use 'once' so workers don't pile up listeners; main may already have
  // its own SIGTERM handler.
  if (!opts.noSignalHandler) {
    process.once('SIGTERM', onSig);
    process.once('SIGINT', onSig);
  }

  return {
    workerId,
    get running() { return state.running; },
    get currentTaskId() { return state.currentTaskId; },
    /**
     * Stop the worker. Returns a promise that resolves once the
     * in-flight task finishes (or immediately if idle).
     */
    stop() {
      if (!state.running) return Promise.resolve();
      state.stopping = true;
      return new Promise((resolve) => {
        state._stopResolvers.push(resolve);
        // If we're idle, resolve right away.
        maybeResolveStop();
      });
    },
  };
}

module.exports = {
  startWorker,
  newWorkerId,
  HEARTBEAT_INTERVAL_MS,
  DEFAULT_POLL_MS,
};
