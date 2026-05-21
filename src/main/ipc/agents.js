'use strict';

// IPC handlers — Sprint 7C Kanban queue.
// Channels: kanbanList, kanbanShow, kanbanCancel, kanbanEnqueue,
//           kanbanStats, kanbanBoard, kanbanPurge, kanbanReclaim.
//
// The renderer's Settings → Agents tab calls these to render the live
// board. Every handler degrades gracefully when the queue is missing
// (HORIZON_KANBAN=off or better-sqlite3 missing on this build).

function register(deps) {
  const { ipcMain, getKanbanQueue } = deps;

  function queue() {
    if (typeof getKanbanQueue !== 'function') return null;
    try { return getKanbanQueue(); } catch (_) { return null; }
  }

  ipcMain.handle('kanbanList', (_e, opts) => {
    const q = queue();
    if (!q) return { ok: false, err: 'kanban queue unavailable' };
    try {
      const o = opts || {};
      return { ok: true, tasks: q.list({ status: o.status, parentId: o.parentId, limit: o.limit }) };
    } catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('kanbanShow', (_e, id) => {
    const q = queue();
    if (!q) return { ok: false, err: 'kanban queue unavailable' };
    try {
      const t = q.getById(String(id || ''));
      if (!t) return { ok: false, err: 'not found' };
      return { ok: true, task: t };
    } catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('kanbanCancel', (_e, id) => {
    const q = queue();
    if (!q) return { ok: false, err: 'kanban queue unavailable' };
    try { return { ok: q.cancel(String(id || '')) }; }
    catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('kanbanEnqueue', (_e, opts) => {
    const q = queue();
    if (!q) return { ok: false, err: 'kanban queue unavailable' };
    try {
      const o = opts || {};
      const id = q.enqueue({
        title:    o.title,
        task:     o.task,
        parentId: o.parentId,
        priority: o.priority,
        options:  o.options,
      });
      return { ok: true, id };
    } catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('kanbanStats', () => {
    const q = queue();
    if (!q) return { ok: false, err: 'kanban queue unavailable' };
    try { return { ok: true, stats: q.stats() }; }
    catch (e) { return { ok: false, err: e.message }; }
  });

  // Convenience: board = stats + top-N per status. Lets the renderer
  // refresh everything in one IPC round-trip instead of three.
  ipcMain.handle('kanbanBoard', (_e, opts) => {
    const q = queue();
    if (!q) return { ok: false, err: 'kanban queue unavailable' };
    try {
      const limit = Number(opts && opts.limit) || 10;
      return {
        ok:      true,
        stats:   q.stats(),
        queued:  q.list({ status: 'queued',  limit }),
        running: q.list({ status: 'running', limit }),
        done:    q.list({ status: 'done',    limit }),
        failed:  q.list({ status: ['failed', 'abandoned'], limit }),
      };
    } catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('kanbanPurge', (_e, opts) => {
    const q = queue();
    if (!q) return { ok: false, err: 'kanban queue unavailable' };
    try {
      const days = Number((opts && opts.olderThanDays) ?? 7);
      return { ok: true, ...q.cleanup({ olderThanDays: days }) };
    } catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('kanbanReclaim', () => {
    const q = queue();
    if (!q) return { ok: false, err: 'kanban queue unavailable' };
    try { return { ok: true, ...q.reclaim() }; }
    catch (e) { return { ok: false, err: e.message }; }
  });
}

module.exports = { register };
