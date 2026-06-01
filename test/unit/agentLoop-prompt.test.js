'use strict';
/**
 * v0.0.3 — locks the no-drift contract: the buildAgentContext output (facts,
 * recalled + pinned memories, entity graph, dialectic) actually reaches the
 * agent system prompt via buildAgentSystemPrompt. If a future refactor drops one
 * of these blocks on either surface, this test fails.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAgentSystemPrompt } = require('../../src/main/agentLoop');

test('EN prompt injects facts, pinned + recalled memories, graph and dialectic', () => {
  const sysInfo = {
    platform: 'test',
    memory: {
      facts: { 'user.name': 'Ada' },
      relevant: [
        { content: 'User pinned: allergic to penicillin', _pinned: true },
        { content: 'User deploys to Render' },
      ],
      recentConversations: [],
      userProfileBlock: '',
      graph: ['ada works_on horizon'],
    },
  };
  const prompt = buildAgentSystemPrompt('en', 'Ada', sysInfo, [], {
    dialecticInjection: '## User model\n- prefers terse answers',
  });
  assert.match(prompt, /user\.name: Ada/, 'fact injected');
  assert.match(prompt, /allergic to penicillin/, 'pinned memory injected');
  assert.match(prompt, /deploys to Render/, 'recalled memory injected');
  assert.match(prompt, /ada works_on horizon/, 'entity graph injected');
  assert.match(prompt, /User model/, 'dialectic injected into AGENT prompt (was plain-chat only)');
});

test('empty memory/dialectic produce no stray blocks', () => {
  const prompt = buildAgentSystemPrompt('en', 'User', { platform: 'x', memory: {} }, [], {});
  assert.doesNotMatch(prompt, /Related entities/, 'no empty graph block');
  assert.doesNotMatch(prompt, /Known user facts/, 'no empty facts block');
});

test('RU prompt variant also injects memory + dialectic', () => {
  const sysInfo = {
    platform: 'x',
    memory: { facts: { city: 'Berlin' }, relevant: [], recentConversations: [], userProfileBlock: '', graph: [] },
  };
  const prompt = buildAgentSystemPrompt('ru', 'Эрнест', sysInfo, [], { dialecticInjection: '## Модель пользователя' });
  assert.match(prompt, /city: Berlin/);
  assert.match(prompt, /Модель пользователя/);
});
