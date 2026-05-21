// Unit tests for the durable KanbanQueue (Sprint 7C).
//
// Skipped automatically when better-sqlite3 isn't installed for the
// current Node runtime — CI on platforms without prebuilt binaries
// shouldn't fail because of an optional native dep.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let KanbanQueue, HEARTBEAT_TIMEOUT_MS, sqliteAvailable = true;
try {
  require('better-sqlite3');
  ({ KanbanQueue, HEARTBEAT_TIMEOUT_MS } = require('../../src/main/kanbanQueue'));
} catch (_) {
  sqliteAvailable = false;
}

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-kanban-'));
  return { dir, file: path.join(dir, 'kanban.sqlite') };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function newQueue() {
  const t = tmpDb();
  const q = new KanbanQueue(t.file).open();
  return { q, dir: t.dir };
}

test('enqueue → claim → complete cycle', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const id = q.enqueue({ title: 'test', task: 'do the thing', priority: 7 });
    assert.ok(id);
    let t = q.getById(id);
    assert.equal(t.status, 'queued');
    assert.equal(t.priority, 7);
    assert.equal(t.attempts, 0);

    const claimed = q.claim('worker-1');
    assert.equal(claimed.id, id);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.workerId, 'worker-1');
    assert.ok(claimed.startedAt);

    const ok = q.complete(id, 'worker-1', { ok: true, answer: '42' });
    assert.equal(ok, true);
    t = q.getById(id);
    assert.equal(t.status, 'done');
    assert.deepEqual(t.result, { ok: true, answer: '42' });
    assert.ok(t.completedAt);
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('claim returns null when queue empty', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    assert.equal(q.claim('worker-1'), null);
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('claim is race-free — two workers, only one wins', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const id = q.enqueue({ title: 'one', task: 'solo' });
    const a = q.claim('worker-A');
    const b = q.claim('worker-B');
    assert.ok(a && a.id === id);
    assert.equal(b, null); // worker B finds nothing
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('priority ordering — higher priority claimed first, then FIFO by created_at', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const lowOld = q.enqueue({ title: 'old low',   task: 'a', priority: 3 });
    const lowNew = q.enqueue({ title: 'new low',   task: 'b', priority: 3 });
    const highOld = q.enqueue({ title: 'old high', task: 'c', priority: 9 });
    const highNew = q.enqueue({ title: 'new high', task: 'd', priority: 9 });

    // Priority 9 first, oldest within priority first.
    const c1 = q.claim('w');
    assert.equal(c1.id, highOld);
    q.complete(highOld, 'w', { ok: true });
    const c2 = q.claim('w');
    assert.equal(c2.id, highNew);
    q.complete(highNew, 'w', { ok: true });
    const c3 = q.claim('w');
    assert.equal(c3.id, lowOld);
    q.complete(lowOld, 'w', { ok: true });
    const c4 = q.claim('w');
    assert.equal(c4.id, lowNew);
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('heartbeat updates row and is rejected after status change', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const id = q.enqueue({ title: 'beat', task: 't' });
    const before = q.claim('w');
    const t1 = q.getById(id).heartbeatAt;
    assert.ok(t1);
    // Wait a tick so the timestamp can advance.
    const wait = Date.now() + 5;
    while (Date.now() < wait) { /* spin */ }
    assert.equal(q.heartbeat(id, 'w'), true);
    const t2 = q.getById(id).heartbeatAt;
    assert.ok(t2 >= t1);

    // Cancelled rows reject heartbeat.
    q.cancel(id);
    assert.equal(q.heartbeat(id, 'w'), false);
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('heartbeat from wrong worker is rejected', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const id = q.enqueue({ title: 't', task: 't' });
    q.claim('w-A');
    assert.equal(q.heartbeat(id, 'w-B'), false);
    assert.equal(q.heartbeat(id, 'w-A'), true);
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('reclaim moves stale running tasks back to queued with attempts++', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const id = q.enqueue({ title: 'stale', task: 't' });
    q.claim('worker-dead');

    // Force the heartbeat to the past so reclaim picks it up.
    const past = Date.now() - HEARTBEAT_TIMEOUT_MS - 1000;
    q.db.prepare('UPDATE kanban_tasks SET heartbeat_at = ? WHERE id = ?').run(past, id);

    const r = q.reclaim();
    assert.equal(r.reclaimed, 1);
    assert.deepEqual(r.ids, [id]);

    const t = q.getById(id);
    assert.equal(t.status, 'queued');
    assert.equal(t.workerId, null);
    assert.equal(t.startedAt, null);
    assert.equal(t.heartbeatAt, null);
    assert.equal(t.attempts, 1);

    // Should be claimable again.
    const claimed = q.claim('worker-fresh');
    assert.equal(claimed.id, id);
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('reclaim leaves healthy running tasks alone', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const id = q.enqueue({ title: 'alive', task: 't' });
    q.claim('w');
    // heartbeat is current — reclaim should skip it
    const r = q.reclaim();
    assert.equal(r.reclaimed, 0);
    assert.equal(q.getById(id).status, 'running');
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('cancel works on queued and running, not on done', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const idQueued = q.enqueue({ title: 'q', task: 't' });
    assert.equal(q.cancel(idQueued), true);
    assert.equal(q.getById(idQueued).status, 'cancelled');

    const idRunning = q.enqueue({ title: 'r', task: 't' });
    q.claim('w');
    assert.equal(q.cancel(idRunning), true);
    assert.equal(q.getById(idRunning).status, 'cancelled');

    const idDone = q.enqueue({ title: 'd', task: 't' });
    q.claim('w');
    q.complete(idDone, 'w', { ok: true });
    // Already terminal — cancel is a no-op.
    assert.equal(q.cancel(idDone), false);
    assert.equal(q.getById(idDone).status, 'done');
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('fail marks failed with error message', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const id = q.enqueue({ title: 't', task: 't' });
    q.claim('w');
    q.fail(id, 'w', new Error('boom'));
    const t = q.getById(id);
    assert.equal(t.status, 'failed');
    assert.equal(t.error, 'boom');
    assert.ok(t.completedAt);
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('parent_id linking lets us list children', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const root = q.enqueue({ title: 'root', task: 'r' });
    const childA = q.enqueue({ title: 'a', task: 't', parentId: root });
    const childB = q.enqueue({ title: 'b', task: 't', parentId: root });
    q.enqueue({ title: 'orphan', task: 't' });

    const kids = q.list({ parentId: root });
    const kidIds = kids.map(k => k.id).sort();
    assert.deepEqual(kidIds, [childA, childB].sort());

    // Sanity — parent itself is not in the parentId=root list.
    assert.ok(!kidIds.includes(root));
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('list filters by status and respects limit', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    for (let i = 0; i < 5; i++) q.enqueue({ title: `t${i}`, task: 't' });
    const c = q.claim('w');
    q.complete(c.id, 'w', { ok: true });

    const queued = q.list({ status: 'queued' });
    assert.equal(queued.length, 4);
    const done = q.list({ status: 'done' });
    assert.equal(done.length, 1);
    const both = q.list({ status: ['queued', 'done'] });
    assert.equal(both.length, 5);
    const limited = q.list({ limit: 2 });
    assert.equal(limited.length, 2);
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('stats counts every status bucket', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const a = q.enqueue({ title: 'a', task: 't' });
    const b = q.enqueue({ title: 'b', task: 't' });
    const c = q.enqueue({ title: 'c', task: 't' });
    const ca = q.claim('w');
    q.complete(ca.id, 'w', { ok: true });
    const cb = q.claim('w');
    q.fail(cb.id, 'w', 'nope');
    q.cancel(c);

    const s = q.stats();
    assert.equal(s.done, 1);
    assert.equal(s.failed, 1);
    assert.equal(s.cancelled, 1);
    assert.equal(s.total, 3);
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('cleanup purges only old terminal rows', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const oldDone = q.enqueue({ title: 'old', task: 't' });
    const c = q.claim('w');
    q.complete(c.id, 'w', { ok: true });
    const newQueued = q.enqueue({ title: 'new', task: 't' });

    // Pretend the done row finished 30 days ago.
    const longAgo = Date.now() - 30 * 86_400_000;
    q.db.prepare('UPDATE kanban_tasks SET completed_at = ? WHERE id = ?').run(longAgo, oldDone);

    const r = q.cleanup({ olderThanDays: 7 });
    assert.equal(r.purged, 1);
    assert.equal(q.getById(oldDone), null);
    assert.ok(q.getById(newQueued)); // queued row untouched
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('priority is clamped to 1-10', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const lo = q.enqueue({ title: 'lo', task: 't', priority: -50 });
    const hi = q.enqueue({ title: 'hi', task: 't', priority: 9999 });
    const def = q.enqueue({ title: 'd', task: 't' }); // default 5
    assert.equal(q.getById(lo).priority, 1);
    assert.equal(q.getById(hi).priority, 10);
    assert.equal(q.getById(def).priority, 5);
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('enqueue rejects empty task', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    assert.throws(() => q.enqueue({ task: '' }));
    assert.throws(() => q.enqueue({ task: '   ' }));
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('options round-trip through enqueue', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    const id = q.enqueue({
      title: 't', task: 'do', priority: 6,
      options: { maxSteps: 12, provider: 'gemini', model: 'gemini-2.5-pro', persona: 'jarvis', skills: ['skill_a', 'skill_b'] },
    });
    const t = q.getById(id);
    assert.equal(t.maxSteps, 12);
    assert.equal(t.provider, 'gemini');
    assert.equal(t.model, 'gemini-2.5-pro');
    assert.equal(t.persona, 'jarvis');
    assert.deepEqual(t.skills, ['skill_a', 'skill_b']);
  } finally {
    q.close();
    cleanup(dir);
  }
});

test('crash simulation: claim → no heartbeat → reclaim → status=queued', { skip: !sqliteAvailable }, () => {
  const { q, dir } = newQueue();
  try {
    // Spec verification step: enqueue a task, mark it running, don't
    // heartbeat, "wait" (by mutating heartbeat_at into the past), and
    // confirm reclaim() flips it back so a fresh worker can pick it up.
    const id = q.enqueue({ title: 'crashed task', task: 'will outlive its parent' });
    q.claim('parent-process');
    assert.equal(q.getById(id).status, 'running');

    // Simulate 65s of silence (>HEARTBEAT_TIMEOUT_MS).
    const dead = Date.now() - 65_000;
    q.db.prepare('UPDATE kanban_tasks SET heartbeat_at = ? WHERE id = ?').run(dead, id);

    const r = q.reclaim();
    assert.equal(r.reclaimed, 1);

    const after = q.getById(id);
    assert.equal(after.status, 'queued');
    assert.equal(after.attempts, 1);
    assert.equal(after.workerId, null);

    // Fresh worker picks it up exactly as expected.
    const reclaimed = q.claim('fresh-worker');
    assert.equal(reclaimed.id, id);
    assert.equal(reclaimed.workerId, 'fresh-worker');
  } finally {
    q.close();
    cleanup(dir);
  }
});
