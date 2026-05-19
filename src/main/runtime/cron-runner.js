// Cron runner — persistent scheduled-task scheduler for the CLI/serve.
//
// Stores entries in settingsStore under key `cli.cron`. Each entry:
//   { id, name, expr, task, mode, enabled, lastRunAt, lastResult, createdAt }
//
// `expr` is a classic 5-field crontab string (minute hour day-of-month
// month day-of-week). We parse it ourselves to avoid pulling node-cron
// — keeps the cli binary small and free of native deps.
//
// `mode`: 'chat' (single-turn AI call) or 'agent' (full agent loop with
// --auto-approve). `task` is the prompt.
//
// Ticking: callers (horizon serve --enable-cron, or `horizon cron run`)
// wake the runner once per minute. On each tick we check every enabled
// entry's expression against the current time and fire matches.
//
// This is the same logic the Electron workflowEngine.js uses, factored
// out so the headless runtime can drive it without IPC.

const crypto = require('crypto');

function newId() { return 'cron-' + crypto.randomBytes(6).toString('hex'); }

// ── crontab parser ────────────────────────────────────────────────────
// Supports:
//   - "*"           wildcard
//   - "5"           single value
//   - "5,10,15"     comma list
//   - "5-10"        range
//   - "*/5"         step
//   - "1-5/2"       step within range
// Five fields: m h dom mon dow. We don't support @hourly/@daily — users
// type "0 * * * *" / "0 0 * * *" instead.

function parseField(token, min, max) {
  if (token === '*') return null; // means "match any"
  const out = new Set();
  for (const part of token.split(',')) {
    const step = part.includes('/') ? parseInt(part.split('/')[1], 10) : 1;
    const range = part.split('/')[0];
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-').map(n => parseInt(n, 10));
      lo = a; hi = b;
    } else {
      const v = parseInt(range, 10);
      if (Number.isNaN(v)) throw new Error(`Invalid value: ${part}`);
      lo = v; hi = v;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`Out of range ${lo}-${hi} (allowed ${min}-${max})`);
    }
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out;
}

function parseCronExpr(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('Cron expression must have 5 fields: minute hour day-of-month month day-of-week');
  }
  return {
    minute: parseField(parts[0], 0, 59),
    hour:   parseField(parts[1], 0, 23),
    dom:    parseField(parts[2], 1, 31),
    month:  parseField(parts[3], 1, 12),
    dow:    parseField(parts[4], 0, 6),
  };
}

function cronMatches(parsed, date) {
  const m = date.getMinutes();
  const h = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay(); // 0=Sun

  const ok = (set, v) => set === null || set.has(v);
  return ok(parsed.minute, m)
      && ok(parsed.hour, h)
      && ok(parsed.dom, dom)
      && ok(parsed.month, mon)
      && ok(parsed.dow, dow);
}

// ── CronRunner ─────────────────────────────────────────────────────────
class CronRunner {
  constructor({ settingsStore, runtime }) {
    if (!settingsStore) throw new Error('CronRunner needs settingsStore');
    this.settingsStore = settingsStore;
    this.runtime = runtime;
    this._timer = null;
    this._lastTickMinute = null;
  }

  list() {
    const raw = this.settingsStore.get('cli.cron') || [];
    return Array.isArray(raw) ? raw : [];
  }

  save(entries) {
    this.settingsStore.set('cli.cron', entries);
  }

  get(id) {
    return this.list().find(e => e.id === id) || null;
  }

  create({ name, expr, task, mode = 'agent', enabled = true }) {
    parseCronExpr(expr); // validates
    if (!task || typeof task !== 'string') throw new Error('task is required');
    if (!['chat', 'agent'].includes(mode)) throw new Error('mode must be chat or agent');
    const entry = {
      id: newId(),
      name: name || task.slice(0, 40),
      expr, task, mode, enabled: !!enabled,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      lastResult: null,
    };
    const list = this.list();
    list.push(entry);
    this.save(list);
    return entry;
  }

  update(id, patch) {
    const list = this.list();
    const idx = list.findIndex(e => e.id === id);
    if (idx < 0) return null;
    if (patch.expr) parseCronExpr(patch.expr);
    list[idx] = { ...list[idx], ...patch };
    this.save(list);
    return list[idx];
  }

  remove(id) {
    const list = this.list();
    const filtered = list.filter(e => e.id !== id);
    const removed = list.length !== filtered.length;
    if (removed) this.save(filtered);
    return removed;
  }

  setEnabled(id, enabled) {
    return this.update(id, { enabled: !!enabled });
  }

  /**
   * Run one entry NOW regardless of schedule. Useful for manual triggering
   * via `horizon cron run <id>`.
   */
  async runEntry(id) {
    const entry = this.get(id);
    if (!entry) throw new Error('cron entry not found: ' + id);
    return this._fire(entry, 'manual');
  }

  /**
   * One tick — checks all entries against `now` and fires matches. Should
   * be called approximately once per minute (we guard against double-fire
   * inside the same minute via _lastTickMinute).
   */
  async tick(now = new Date()) {
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (this._lastTickMinute === minuteKey) return { fired: 0, skipped: 'same minute' };
    this._lastTickMinute = minuteKey;

    const fired = [];
    for (const entry of this.list()) {
      if (!entry.enabled) continue;
      let parsed;
      try { parsed = parseCronExpr(entry.expr); }
      catch (_) { continue; }
      if (cronMatches(parsed, now)) {
        try {
          const result = await this._fire(entry, 'scheduled');
          fired.push({ id: entry.id, ok: result?.ok !== false });
        } catch (e) {
          fired.push({ id: entry.id, ok: false, error: e.message });
        }
      }
    }
    return { fired: fired.length, entries: fired };
  }

  async _fire(entry, trigger) {
    if (!this.runtime) throw new Error('CronRunner missing runtime');
    const startedAt = new Date().toISOString();
    let result;
    try {
      if (entry.mode === 'chat') {
        result = await this.runtime.runChat(entry.task, { skipLearn: true });
      } else {
        result = await this.runtime.runAgent(entry.task, {
          maxSteps: 8, reflect: true,
          askPermission: async () => true, // auto-approve in cron
        });
      }
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    this.update(entry.id, {
      lastRunAt: startedAt,
      lastResult: {
        trigger,
        ok: result?.ok !== false && !result?.error,
        answer: (result?.answer || result?.reply || '').slice(0, 500),
        error: result?.error || null,
        steps: result?.steps?.length || 0,
      },
    });
    return result;
  }

  /**
   * Start the per-minute ticker. Returns an `stop` function. Safe to
   * call twice — second call is a no-op.
   */
  start() {
    if (this._timer) return () => this.stop();
    // Align first tick to the next minute boundary so we fire near :00.
    const now = new Date();
    const delayMs = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    const initial = setTimeout(() => {
      this.tick().catch(() => {});
      this._timer = setInterval(() => { this.tick().catch(() => {}); }, 60_000);
    }, delayMs);
    this._timer = { unref() { initial.unref?.(); } };
    return () => this.stop();
  }

  stop() {
    if (this._timer && typeof this._timer === 'object' && 'unref' in this._timer) {
      // Initial timeout — just leave it; it'll only fire once.
    } else if (this._timer) {
      clearInterval(this._timer);
    }
    this._timer = null;
  }
}

module.exports = { CronRunner, parseCronExpr, cronMatches };
