'use strict';
/**
 * v0.0.3 — Working-memory scratchpad tools (memory layer 12). The agent uses
 * these to stash intermediate results during a single run; they survive the
 * reflection/corrective rounds and are cleared (or promoted) at task end.
 *
 * Keyed by ctx.runId — both surfaces pass it (Electron via {runId,event},
 * CLI via the dispatch ctx). Pure in-memory → offline-safe.
 */

const { register } = require('./registry');
const scratch = require('../scratchpad');

register({
  name: 'scratch_write',
  description: '[Working memory] Save a key/value note for THIS task run. Survives across reflection rounds; cleared at task end. Use for intermediate results, a running plan, or tallies you need later in the same task.',
  parameters: { key: 'string short label', value: 'string value to remember for this run' },
  async execute(args = {}, ctx = {}) {
    return scratch.write(ctx.runId, args.key, args.value);
  },
});

register({
  name: 'scratch_read',
  description: '[Working memory] Read a scratchpad note from THIS task run by key, or omit key to get all notes for the run as an object.',
  parameters: { key: 'string optional — omit to read all notes' },
  async execute(args = {}, ctx = {}) {
    return { ok: true, value: scratch.read(ctx.runId, args.key) };
  },
});

register({
  name: 'scratch_list',
  description: '[Working memory] List the keys currently stored in THIS task run\'s scratchpad.',
  parameters: {},
  async execute(args = {}, ctx = {}) {
    return { ok: true, keys: scratch.list(ctx.runId) };
  },
});
