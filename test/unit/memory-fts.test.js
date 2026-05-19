// Unit tests for the pure-JS InvertedIndex used by the FTS layer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { InvertedIndex } = require('../../src/main/memoryFts');

test('add + search returns the matching doc', () => {
  const idx = new InvertedIndex();
  idx.add('doc1', 'the quick brown fox jumps over the lazy dog');
  const r = idx.search('fox', 5);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'doc1');
});

test('multi-term query ranks docs by relevance', () => {
  const idx = new InvertedIndex();
  idx.add('a', 'the cat sat on the mat');
  idx.add('b', 'the dog chased the cat in the yard');
  idx.add('c', 'the lazy dog slept all day');
  const r = idx.search('cat dog', 5);
  // b has both, so it should rank first
  assert.equal(r[0].id, 'b');
});

test('returns empty array for unknown term', () => {
  const idx = new InvertedIndex();
  idx.add('doc1', 'hello world');
  assert.deepEqual(idx.search('xyzzy', 5), []);
});

test('remove drops a doc from the index', () => {
  const idx = new InvertedIndex();
  idx.add('doc1', 'horizon ai agent');
  idx.add('doc2', 'horizon something else');
  assert.equal(idx.search('horizon', 5).length, 2);
  idx.remove('doc1');
  assert.equal(idx.search('horizon', 5).length, 1);
});

test('size + stats track adds', () => {
  const idx = new InvertedIndex();
  idx.add('a', 'one two three');
  idx.add('b', 'four five six');
  assert.equal(idx.size(), 2);
  const s = idx.stats();
  assert.equal(s.docs, 2);
  assert.ok(s.tokens >= 6);
});

test('respects limit parameter', () => {
  const idx = new InvertedIndex();
  for (let i = 0; i < 20; i++) idx.add('doc' + i, 'common term here');
  assert.equal(idx.search('common', 5).length, 5);
});

test('case-insensitive search', () => {
  const idx = new InvertedIndex();
  idx.add('doc1', 'Horizon AI');
  assert.equal(idx.search('horizon', 5).length, 1);
  assert.equal(idx.search('HORIZON', 5).length, 1);
});
