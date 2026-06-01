'use strict';
/**
 * v0.0.3 — entity / relationship graph (layer 11) tests.
 *
 * Lightweight knowledge graph: entities + typed relations stored in SQLite,
 * extracted heuristically from turns, with contradiction-aware confidence decay.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentMemory } = require('../../src/main/agent');
const memoryDbMod = require('../../src/main/memoryDb');
const MemoryDb = memoryDbMod.MemoryDb || memoryDbMod.default || memoryDbMod;

function sqliteAvailable() { try { require('better-sqlite3'); return true; } catch (_) { return false; } }
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-graph-')); }
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

test('upsertEntity + addRelation + relationsFor + graphStats', { skip: !sqliteAvailable() }, () => {
  const dir = tmpDir();
  try {
    const db = new MemoryDb(path.join(dir, 'g.db')); db.open();
    db.upsertEntity('Ernest', 'person');
    db.upsertEntity('Horizon', 'project');
    db.addRelation('Ernest', 'works_on', 'Horizon', { confidence: 0.8 });
    const rels = db.relationsFor('Ernest');
    assert.equal(rels.length, 1);
    assert.equal(rels[0].rel, 'works_on');
    assert.equal(rels[0].dst, 'horizon');
    const stats = db.graphStats();
    assert.equal(stats.entities, 2);
    assert.equal(stats.relations, 1);
    // upsert again bumps mentions, not entity count.
    db.upsertEntity('Ernest', 'person');
    assert.equal(db.graphStats().entities, 2);
    db.close();
  } finally { cleanup(dir); }
});

test('case-insensitive entity lookup', { skip: !sqliteAvailable() }, () => {
  const dir = tmpDir();
  try {
    const db = new MemoryDb(path.join(dir, 'g.db')); db.open();
    db.upsertEntity('Render', 'service');
    assert.ok(db.entitiesByName('render').length >= 1);
    assert.ok(db.entitiesByName('REND').length >= 1);
    db.close();
  } finally { cleanup(dir); }
});

test('contradiction decays the older edge but keeps both', { skip: !sqliteAvailable() }, () => {
  const dir = tmpDir();
  try {
    const db = new MemoryDb(path.join(dir, 'g.db')); db.open();
    db.addRelation('App', 'deploys_to', 'Render', { confidence: 0.9 });
    db.addRelation('App', 'deploys_to', 'Cloudflare', { confidence: 0.9 });
    const rels = db.relationsFor('App');
    const toRender = rels.find(r => r.dst === 'render');
    const toCf = rels.find(r => r.dst === 'cloudflare');
    assert.ok(toRender && toCf, 'both edges kept');
    assert.ok(toRender.confidence < toCf.confidence, 'older edge decayed below the newer one');
    db.close();
  } finally { cleanup(dir); }
});

test('learnFromTurn heuristic populates the graph', { skip: !sqliteAvailable() }, () => {
  const dir = tmpDir();
  try {
    const db = new MemoryDb(path.join(dir, 'g.db')); db.open();
    const mem = new AgentMemory(path.join(dir, 'mem.json')); mem.init(); mem.setMemoryDb(db);
    mem.learnFromTurn('My name is Ernest. My project is Horizon.', 'Got it, Ernest — Horizon it is.', {});
    const stats = db.graphStats();
    assert.ok(stats.entities >= 2, 'entities extracted from the turn');
    const rels = db.relationsFor('Ernest');
    assert.ok(rels.some(r => r.rel === 'works_on' && r.dst === 'horizon'), 'works_on edge derived from profile facts');
    db.close();
  } finally { cleanup(dir); }
});
