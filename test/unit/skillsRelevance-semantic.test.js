'use strict';
/**
 * WS3 — semantic skill matching tests.
 *
 * selectRelevantSkillsAsync blends an embedding cosine on top of bag-of-words.
 * Critical guarantees:
 *  - without an embedding service it is byte-identical to the sync path
 *    (offline / no-key users see zero change)
 *  - with embeddings, a paraphrase that shares few keywords still surfaces
 *  - the additive blend never drops a proven keyword match below threshold
 *  - skill vectors are cached (embedded once per id+version)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  selectRelevantSkills,
  selectRelevantSkillsAsync,
  _clearSkillVectorCache,
} = require('../../src/main/skillsRelevance');

function skill(id, fm, extra = {}) {
  return { id, scope: 'user', enabled: true, version: '1.0.0', frontmatter: fm, ...extra };
}

const SKILLS = [
  skill('refactor-react', {
    name: 'Refactor React',
    description: 'Convert class components to functional components with hooks',
    tags: ['react', 'refactor'], aliases: [], triggers: [], examples: [],
  }),
  skill('sql-review', {
    name: 'SQL Review',
    description: 'Review SQL queries for performance and correctness',
    tags: ['sql', 'database'], aliases: [], triggers: [], examples: [],
  }),
];

test('no embedding service → identical to sync selectRelevantSkills', async () => {
  const q = 'review my sql query';
  const sync = selectRelevantSkills(SKILLS, q, {});
  const asyncRes = await selectRelevantSkillsAsync(SKILLS, q, {}); // no embeddingService
  assert.deepEqual(
    asyncRes.selected.map(s => s.id),
    sync.selected.map(s => s.id),
    'selection identical'
  );
  assert.deepEqual(
    asyncRes.scored.map(s => [s.id, s.score]),
    sync.scored.map(s => [s.id, s.score]),
    'scores byte-identical'
  );
});

test('unavailable embedding service falls back to bag-of-words', async () => {
  const svc = { isAvailable: () => false, embed: async () => { throw new Error('should not be called'); } };
  const res = await selectRelevantSkillsAsync(SKILLS, 'sql performance', { embeddingService: svc });
  assert.equal(res.selected[0].id, 'sql-review');
});

test('embed failure falls back gracefully (no throw)', async () => {
  const svc = { isAvailable: () => true, embed: async () => { throw new Error('network down'); } };
  const res = await selectRelevantSkillsAsync(SKILLS, 'sql performance', { embeddingService: svc });
  assert.equal(res.selected[0].id, 'sql-review', 'still ranks via bag-of-words');
});

test('semantic blend lifts a paraphrase that shares few keywords', async () => {
  _clearSkillVectorCache();
  // Fake embedder: query about "hooks migration" is near the refactor-react
  // skill text, far from sql-review. Bag-of-words alone would miss it
  // (query shares no words with the description), but cosine rescues it.
  const VEC = {
    query: [1, 0, 0],
    'refactor-react': [0.95, 0.1, 0], // close to query
    'sql-review': [0, 0, 1],          // orthogonal
  };
  const svc = {
    isAvailable: () => true,
    embed: async (text) => {
      if (/migrate|legacy|class lifecycle/i.test(text)) return VEC.query;
      if (/functional components with hooks/i.test(text)) return VEC['refactor-react'];
      if (/SQL queries/i.test(text)) return VEC['sql-review'];
      return [0, 0, 0];
    },
  };
  // Query shares NO content words with either description.
  const res = await selectRelevantSkillsAsync(SKILLS, 'migrate legacy class lifecycle', {
    embeddingService: svc,
    threshold: 0.05,
  });
  assert.equal(res.selected[0].id, 'refactor-react', 'semantic match surfaces first');
  const r = res.scored.find(s => s.id === 'refactor-react');
  assert.ok(r.breakdown.semantic > 0.8, 'semantic score recorded in breakdown');
});

test('skill vectors are cached — embedded once per id+version', async () => {
  _clearSkillVectorCache();
  let embedCalls = 0;
  const svc = {
    isAvailable: () => true,
    embed: async () => { embedCalls++; return [1, 0, 0]; },
  };
  await selectRelevantSkillsAsync(SKILLS, 'first query', { embeddingService: svc });
  const afterFirst = embedCalls;
  await selectRelevantSkillsAsync(SKILLS, 'second query', { embeddingService: svc });
  // Second call re-embeds only the query (1), not the 2 skills (cached).
  assert.equal(embedCalls - afterFirst, 1, 'skills cached; only the new query embedded');
});
