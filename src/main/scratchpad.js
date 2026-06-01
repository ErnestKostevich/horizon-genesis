'use strict';
/**
 * v0.0.3 — Working memory / scratchpad (memory layer 12).
 *
 * A short-lived per-run key->value store the agent reads/writes via the
 * scratch_* tools during a single agent run. It survives across the
 * reflection/corrective rounds (same runId) but is ephemeral by default —
 * cleared at task end unless the caller promotes it to long-term memory.
 *
 * Pure in-memory, no network → fully offline-safe. Bounded so a runaway agent
 * can't blow up memory: <=50 keys/run, <=2KB/value, <=32 live runs (oldest evicted).
 */

const MAX_KEYS_PER_RUN = 50;
const MAX_VALUE_BYTES = 2048;
const MAX_RUNS = 32;

const _runs = new Map(); // runId -> { map: Map<key,{value,ts}>, ts }

function _run(runId) {
  const id = String(runId || 'default');
  let r = _runs.get(id);
  if (!r) {
    r = { map: new Map(), ts: Date.now() };
    _runs.set(id, r);
    if (_runs.size > MAX_RUNS) {
      const oldest = [..._runs.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) _runs.delete(oldest[0]);
    }
  }
  return r;
}

function write(runId, key, value) {
  const k = String(key || '').trim().slice(0, 120);
  if (!k) return { ok: false, error: 'key required' };
  let v = value == null ? '' : (typeof value === 'string' ? value : JSON.stringify(value));
  if (Buffer.byteLength(v, 'utf8') > MAX_VALUE_BYTES) v = v.slice(0, MAX_VALUE_BYTES) + '…';
  const r = _run(runId);
  if (!r.map.has(k) && r.map.size >= MAX_KEYS_PER_RUN) {
    return { ok: false, error: `scratchpad full (${MAX_KEYS_PER_RUN} keys)` };
  }
  r.map.set(k, { value: v, ts: Date.now() });
  return { ok: true, key: k, bytes: Buffer.byteLength(v, 'utf8') };
}

function read(runId, key) {
  const r = _runs.get(String(runId || 'default'));
  if (!r) return key ? null : {};
  if (key) { const e = r.map.get(String(key)); return e ? e.value : null; }
  const out = {};
  for (const [k, e] of r.map) out[k] = e.value;
  return out;
}

function list(runId) {
  const r = _runs.get(String(runId || 'default'));
  return r ? [...r.map.keys()] : [];
}

function snapshot(runId) {
  const id = String(runId || 'default');
  const r = _runs.get(id);
  if (!r) return { runId: id, keys: 0, entries: {} };
  const entries = {};
  for (const [k, e] of r.map) entries[k] = e.value;
  return { runId: id, keys: r.map.size, entries };
}

function clear(runId) {
  return _runs.delete(String(runId || 'default'));
}

/** Promote scratchpad entries to long-term memory (opt-in at task end). */
function promote(runId, agentMemory, opts = {}) {
  const r = _runs.get(String(runId || 'default'));
  if (!r || !r.map.size || !agentMemory || typeof agentMemory.remember !== 'function') return 0;
  let n = 0;
  for (const [k, e] of r.map) {
    try {
      agentMemory.remember(`${k}: ${e.value}`, opts.category || 'scratch_promoted', opts.importance || 5, 'scratchpad');
      n++;
    } catch (_) {}
  }
  return n;
}

module.exports = {
  write, read, list, snapshot, clear, promote,
  MAX_KEYS_PER_RUN, MAX_VALUE_BYTES, MAX_RUNS,
};
