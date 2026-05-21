// Smoke trace — verify the KanbanWorker actually claims, heartbeats,
// and completes tasks via a mock runtime.runAgent().
//
// Not part of the unit suite (it sleeps for real time); run with
//   node test/integration/kanban-smoke.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { KanbanQueue } = require('../../src/main/kanbanQueue');
const { startWorker } = require('../../src/main/kanbanWorker');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-kanban-smoke-'));
  const dbPath = path.join(dir, 'kanban.sqlite');
  const queue = new KanbanQueue(dbPath).open();

  // Mock runtime — every task runs ~200ms then returns a synthetic answer.
  const runtime = {
    runAgent: async (task) => {
      await new Promise(r => setTimeout(r, 200));
      return { ok: true, answer: `done: ${task}`, steps: [] };
    },
  };

  // Enqueue 3 tasks of mixed priority.
  const id1 = queue.enqueue({ title: 'first',  task: 'task one',   priority: 5 });
  const id2 = queue.enqueue({ title: 'second', task: 'task two',   priority: 8 });
  const id3 = queue.enqueue({ title: 'third',  task: 'task three', priority: 3 });
  console.log('enqueued:', { id1, id2, id3 });
  console.log('stats before:', queue.stats());

  const events = [];
  const worker = startWorker({
    queue, runtime,
    log: (...a) => console.log('  [w]', ...a),
    onEvent: (type, data) => events.push({ type, taskId: data.taskId }),
    noSignalHandler: true,
  });

  // Wait for all three to finish (poll every 100ms).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const s = queue.stats();
    if (s.done === 3) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await worker.stop();

  const final = queue.stats();
  console.log('stats after:', final);
  console.log('events:', events.length, 'fired —', events.slice(0, 8));

  // The high-priority task must have been first.
  const all = queue.list({});
  console.log('order completed (latest first):');
  for (const t of all) console.log(`  ${t.id} ${t.status} ${t.title} prio=${t.priority}`);

  // Sanity assertions — exit non-zero if anything's off.
  let exitCode = 0;
  if (final.done !== 3) { console.error('FAIL: expected 3 done, got ' + final.done); exitCode = 1; }
  if (final.queued !== 0) { console.error('FAIL: expected 0 queued, got ' + final.queued); exitCode = 1; }
  if (final.running !== 0) { console.error('FAIL: expected 0 running, got ' + final.running); exitCode = 1; }

  // Crash sim: enqueue → claim manually → don't heartbeat → wait → reclaim.
  console.log('\n--- crash sim ---');
  const idC = queue.enqueue({ title: 'will be abandoned', task: 'crash me' });
  queue.claim('dead-worker');
  // Force heartbeat into the past.
  queue.db.prepare('UPDATE kanban_tasks SET heartbeat_at = ? WHERE id = ?')
    .run(Date.now() - 65_000, idC);
  console.log('before reclaim:', queue.getById(idC).status);
  const r = queue.reclaim();
  console.log('reclaim result:', r);
  const after = queue.getById(idC);
  console.log('after reclaim:', { status: after.status, attempts: after.attempts });
  if (after.status !== 'queued') { console.error('FAIL: expected queued after reclaim'); exitCode = 1; }
  if (after.attempts !== 1) { console.error('FAIL: expected attempts=1 after reclaim'); exitCode = 1; }

  queue.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(exitCode === 0 ? '\nSMOKE OK' : '\nSMOKE FAILED');
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
