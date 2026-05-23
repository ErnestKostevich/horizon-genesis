// `horizon agents` — durable Kanban-board view of all spawned subagent tasks.
//
// Sprint 7C replaced the ephemeral `serve` HTTP endpoint with a persistent
// SQLite queue. Every spawn_subagent enqueues a row; this command surfaces
// the board so the human can see what's running, what's queued, and clean
// up after stale runs.
//
//   horizon agents board                — ASCII board (queued | running | done)
//   horizon agents list [--status X]    — flat list, newest first
//   horizon agents show <id>            — full task detail + result/error
//   horizon agents cancel <id>          — cancel queued or running task
//   horizon agents purge [--older N]    — wipe terminal-state rows older than N days
//   horizon agents stats                — per-status counts
//   horizon agents reclaim              — manually sweep stale running rows
//
// Falls back to the old HTTP API for compatibility when the runtime has
// no kanban queue (HORIZON_KANBAN=off or better-sqlite3 missing).

const { fmt, isTTY } = require('../tty');
const { panel } = require('../banner');

async function run({ runtime, args, flags }) {
  const sub = args[0] || 'board';
  const rest = args.slice(1);
  const queue = runtime && runtime.kanbanQueue;

  // Legacy serve-based fallback ──────────────────────────────────────────
  if (!queue) {
    if (sub === 'list')              return legacyList(flags);
    if (sub === 'stop' || sub === 'kill') return legacyStop(rest, flags);
    process.stderr.write(fmt.err('Kanban queue unavailable on this runtime.') + '\n');
    process.stderr.write(fmt.dim('  Set HORIZON_KANBAN=on and ensure better-sqlite3 is installed.\n'));
    return 1;
  }

  if (sub === 'board')              return board(queue, flags);
  if (sub === 'list' || sub === 'ls') return list(queue, flags);
  if (sub === 'show' || sub === 'info') return show(queue, rest, flags);
  if (sub === 'cancel' || sub === 'stop' || sub === 'kill') return cancel(queue, rest, flags);
  if (sub === 'purge')              return purge(queue, flags);
  if (sub === 'stats')              return stats(queue, flags);
  if (sub === 'reclaim')            return reclaim(queue, flags);

  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write('Try: board | list | show <id> | cancel <id> | purge | stats | reclaim\n');
  return 2;
}

// ── board ──────────────────────────────────────────────────────────────
// ASCII three-column view. Cards stack newest-first per column.

function fmtAge(ms) {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60_000)        return Math.round(d / 1000) + 's ago';
  if (d < 3_600_000)     return Math.round(d / 60_000) + 'm ago';
  if (d < 86_400_000)    return Math.round(d / 3_600_000) + 'h ago';
  return Math.round(d / 86_400_000) + 'd ago';
}

function fmtRunning(t) {
  if (!t.startedAt) return '';
  return 'running ' + Math.round((Date.now() - t.startedAt) / 1000) + 's';
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function pad(s, n) {
  s = String(s || '');
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

function board(queue, flags) {
  const s = queue.stats();
  const queued    = queue.list({ status: 'queued',    limit: 6 });
  const running   = queue.list({ status: 'running',   limit: 6 });
  const done      = queue.list({ status: 'done',      limit: 6 });
  const failed    = queue.list({ status: ['failed','abandoned'], limit: 6 });

  if (flags.json) {
    process.stdout.write(JSON.stringify({ stats: s, queued, running, done, failed }, null, 2) + '\n');
    return 0;
  }

  // Sprint-2.15 — panel-framed three-column kanban. Replaces the
  // hand-rolled box-drawing frame with the shared `panel()` helper so the
  // board picks up the accent colour and rounded corners used elsewhere.
  // The inner column structure stays — panel() just wraps it.
  const colW = 22;
  const colour = isTTY ? fmt : { cyan: x=>x, green: x=>x, red: x=>x, yellow: x=>x, dim: x=>x, bold: x=>x };

  const lines = [];
  // Header row — column titles + counts
  const head =
    pad(colour.bold(`QUEUED (${s.queued})`),  colW + ansiPad(`QUEUED (${s.queued})`)) + colour.dim('│ ') +
    pad(colour.bold(`RUNNING (${s.running})`), colW + ansiPad(`RUNNING (${s.running})`)) + colour.dim('│ ') +
    pad(colour.bold(`DONE (${s.done})`),       colW + ansiPad(`DONE (${s.done})`));
  lines.push(head);
  // Divider row — dim rule per column
  lines.push(colour.dim('─'.repeat(colW-1)) + ' ' + colour.dim('│ ') + colour.dim('─'.repeat(colW-1)) + ' ' + colour.dim('│ ') + colour.dim('─'.repeat(colW-1)));

  const rowCount = Math.max(queued.length, running.length, done.length, 1);
  for (let i = 0; i < rowCount; i++) {
    const q = queued[i];
    const r = running[i];
    const d = done[i];
    // line 1 — title + priority/age glyph
    const ql = q ? colour.cyan('▎ ') + truncate(q.title, colW - 3) : '';
    const rl = r ? colour.yellow('▌ ') + truncate(r.title, colW - 3) : '';
    const dl = d ? colour.green('✓ ')  + truncate(d.title, colW - 3) : '';
    lines.push(
      pad(ql, colW + ansiPad(ql)) + colour.dim('│ ') +
      pad(rl, colW + ansiPad(rl)) + colour.dim('│ ') +
      pad(dl, colW + ansiPad(dl))
    );
    // line 2 — sub-detail
    const ql2 = q ? colour.dim('  prio ' + q.priority) : '';
    const rl2 = r ? colour.dim('  ' + fmtRunning(r)) : '';
    const dl2 = d ? colour.dim('  ' + fmtAge(d.completedAt)) : '';
    lines.push(
      pad(ql2, colW + ansiPad(ql2)) + colour.dim('│ ') +
      pad(rl2, colW + ansiPad(rl2)) + colour.dim('│ ') +
      pad(dl2, colW + ansiPad(dl2))
    );
  }

  process.stdout.write('\n' + panel({
    title: `Horizon Kanban · ${s.total} total`,
    accent: 'cyan',
    width: 78,
    lines,
  }) + '\n');
  if (failed.length) {
    process.stdout.write('\n  ' + colour.red(`! ${failed.length} failed/abandoned task(s) — \`horizon agents list --status failed\``) + '\n');
  }
  process.stdout.write('\n');
  return 0;
}

// Strip ANSI codes for accurate column-width padding (panel rendering
// places visible columns but pad() naïvely counts ANSI bytes too).
function ansiPad(s) {
  const visible = String(s).replace(/\x1b\[[0-9;]*m/g, '');
  return String(s).length - visible.length;
}

// ── list ───────────────────────────────────────────────────────────────
function list(queue, flags) {
  const status = flags.status || undefined;
  const limit  = Number(flags.limit) || 50;
  const tasks  = queue.list({ status, limit });
  if (flags.json) {
    process.stdout.write(JSON.stringify(tasks, null, 2) + '\n');
    return 0;
  }
  if (!tasks.length) {
    process.stdout.write(fmt.dim('\n  no tasks' + (status ? ` (status=${status})` : '') + '\n\n'));
    return 0;
  }
  // Sprint-2.15 — panel-wrapped list. Each task is one panel line so the
  // accent rail visually groups them, matching the board's framing.
  const lines = tasks.map((t) => {
    const colourFn = t.status === 'done' ? fmt.green
                  : t.status === 'failed' ? fmt.red
                  : t.status === 'running' ? fmt.yellow
                  : t.status === 'cancelled' ? fmt.dim
                  : t.status === 'abandoned' ? fmt.red
                  : fmt.cyan;
    const statusBadge = colourFn(`[${t.status}]`.padEnd(12));
    const meta = t.status === 'running'
      ? fmt.dim(' ' + fmtRunning(t))
      : t.completedAt ? fmt.dim(' ' + fmtAge(t.completedAt)) : '';
    return `${fmt.cyan(t.id)} ${statusBadge} ${truncate(t.title, 50)}${meta}`;
  });
  process.stdout.write('\n' + panel({
    title: 'Kanban tasks' + (status ? ' · ' + status : ''),
    accent: 'cyan',
    width: 78,
    lines,
  }) + '\n\n');
  return 0;
}

// ── show ───────────────────────────────────────────────────────────────
function show(queue, rest, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('id required: horizon agents show <id>') + '\n'); return 2; }
  const t = queue.getById(id);
  if (!t) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  if (flags.json) {
    process.stdout.write(JSON.stringify(t, null, 2) + '\n');
    return 0;
  }
  process.stdout.write('\n' + fmt.bold(t.title) + ' ' + fmt.dim('(' + t.id + ')') + '\n\n');
  process.stdout.write(fmt.dim('  status   ') + t.status + '\n');
  process.stdout.write(fmt.dim('  priority ') + t.priority + '\n');
  process.stdout.write(fmt.dim('  attempts ') + t.attempts + '\n');
  if (t.parentId)  process.stdout.write(fmt.dim('  parent   ') + t.parentId + '\n');
  if (t.workerId)  process.stdout.write(fmt.dim('  worker   ') + t.workerId + '\n');
  if (t.provider)  process.stdout.write(fmt.dim('  provider ') + t.provider + (t.model ? '/' + t.model : '') + '\n');
  if (t.persona)   process.stdout.write(fmt.dim('  persona  ') + t.persona + '\n');
  process.stdout.write(fmt.dim('  created  ') + new Date(t.createdAt).toISOString() + '\n');
  if (t.startedAt)   process.stdout.write(fmt.dim('  started  ') + new Date(t.startedAt).toISOString() + '\n');
  if (t.completedAt) process.stdout.write(fmt.dim('  done     ') + new Date(t.completedAt).toISOString() + '\n');
  process.stdout.write('\n' + fmt.dim('  task:') + '\n');
  process.stdout.write('    ' + t.task.split('\n').join('\n    ') + '\n');
  if (t.result) {
    process.stdout.write('\n' + fmt.dim('  result:') + '\n');
    const r = typeof t.result === 'string' ? t.result : JSON.stringify(t.result, null, 2);
    process.stdout.write('    ' + r.split('\n').join('\n    ') + '\n');
  }
  if (t.error) {
    process.stdout.write('\n' + fmt.red('  error:') + '\n');
    process.stdout.write('    ' + t.error.split('\n').join('\n    ') + '\n');
  }
  process.stdout.write('\n');
  return 0;
}

// ── cancel ─────────────────────────────────────────────────────────────
function cancel(queue, rest, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('id required: horizon agents cancel <id>') + '\n'); return 2; }
  const ok = queue.cancel(id);
  if (!ok) {
    process.stderr.write(fmt.err('cannot cancel ' + id + ' — not found or already terminal') + '\n');
    return 1;
  }
  if (flags.json) { process.stdout.write(JSON.stringify({ ok: true, id }) + '\n'); return 0; }
  process.stdout.write(fmt.ok('cancelled ' + id) + '\n');
  return 0;
}

// ── purge ──────────────────────────────────────────────────────────────
function purge(queue, flags) {
  const days = Number(flags.older || flags.days || 7);
  const r = queue.cleanup({ olderThanDays: days });
  if (flags.json) { process.stdout.write(JSON.stringify(r) + '\n'); return 0; }
  process.stdout.write(fmt.ok(`purged ${r.purged} task(s) older than ${days} day${days===1?'':'s'}`) + '\n');
  return 0;
}

// ── stats ──────────────────────────────────────────────────────────────
function stats(queue, flags) {
  const s = queue.stats();
  if (flags.json) { process.stdout.write(JSON.stringify(s, null, 2) + '\n'); return 0; }
  // Sprint-2.15 — panel-framed stats, one row per status with the count
  // dim-padded for clean vertical alignment.
  const colourFor = {
    queued: fmt.cyan,
    running: fmt.yellow,
    done: fmt.green,
    failed: fmt.red,
    abandoned: fmt.red,
    cancelled: fmt.dim,
  };
  const lines = ['queued','running','done','failed','abandoned','cancelled'].map((k) => {
    const cf = colourFor[k] || fmt.dim;
    return fmt.dim(k.padEnd(11)) + ' ' + cf(String(s[k]));
  });
  lines.push(fmt.dim('total      ') + ' ' + fmt.bold(String(s.total)));
  process.stdout.write('\n' + panel({
    title: 'Kanban stats',
    accent: 'cyan',
    width: 48,
    lines,
  }) + '\n\n');
  return 0;
}

// ── reclaim ────────────────────────────────────────────────────────────
function reclaim(queue, flags) {
  const r = queue.reclaim();
  if (flags.json) { process.stdout.write(JSON.stringify(r) + '\n'); return 0; }
  process.stdout.write(fmt.ok(`reclaimed ${r.reclaimed} stale task(s)`) + '\n');
  return 0;
}

// ── legacy serve fallback (only used when kanban is off) ───────────────
async function legacyList(flags) {
  const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
  const baseUrl = flags.url || process.env.HORIZON_URL || 'http://127.0.0.1:18789';
  const token = flags.token || process.env.HORIZON_TOKEN || '';
  const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
  try {
    const r = await fetch(baseUrl + '/api/agents/list', { headers });
    if (r.status === 404) {
      process.stdout.write(fmt.dim('\n  serve runtime doesn\'t expose /api/agents\n\n'));
      return 0;
    }
    if (!r.ok) { process.stderr.write(fmt.err('HTTP ' + r.status) + '\n'); return 1; }
    const data = await r.json();
    if (flags.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return 0; }
    if (!data.runs?.length) {
      process.stdout.write(fmt.dim('\n  no active runs\n\n'));
      return 0;
    }
    for (const r of data.runs) {
      process.stdout.write(`  ${fmt.cyan(r.id)} ${fmt.dim('step ' + r.step + '/' + r.maxSteps)} ${r.task.slice(0, 60)}\n`);
    }
    return 0;
  } catch (e) {
    process.stderr.write(fmt.err('failed to reach ' + baseUrl + ' — is `horizon serve` running?') + '\n');
    return 1;
  }
}

async function legacyStop(rest, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('id required') + '\n'); return 2; }
  const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
  const baseUrl = flags.url || process.env.HORIZON_URL || 'http://127.0.0.1:18789';
  const token = flags.token || process.env.HORIZON_TOKEN || '';
  const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
  try {
    const r = await fetch(baseUrl + '/api/agents/' + encodeURIComponent(id) + '/stop', { method: 'POST', headers });
    if (r.status === 404) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
    if (!r.ok) { process.stderr.write(fmt.err('HTTP ' + r.status) + '\n'); return 1; }
    process.stdout.write(fmt.ok('stop requested for ' + id) + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(fmt.err('failed to reach ' + baseUrl) + '\n');
    return 1;
  }
}

module.exports = { run };
