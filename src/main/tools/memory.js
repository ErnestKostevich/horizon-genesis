'use strict';
/**
 * Memory + nutrition tools.
 *
 * These need the AgentMemory instance that agent.js stores in its
 * module-level `memoryInstance` variable. We pull it back through the
 * agent module's __memoryInstance getter (added in this refactor) — that
 * keeps the original "set once via setMemoryInstance" semantics intact.
 */

const { register } = require('./registry');

function _mem() {
  // _getMemoryInstance is a thin accessor agent.js exports so callers
  // outside the module can see the latest binding (the previous code
  // closed over a module-level `let` from inside dispatchTool).
  return require('../agent')._getMemoryInstance();
}

register({
  name: 'remember',
  description: 'Save something to long-term memory',
  parameters: { content: 'string', category: 'string', importance: 'number 1-10' },
  async execute(args = {}) {
    const mem = _mem();
    if (!mem) return { ok: false, err: 'Memory not initialized' };
    mem.remember(args.content, args.category, args.importance, 'tool');
    return { ok: true, out: 'Remembered.' };
  },
});

register({
  name: 'recall',
  description: 'Search memories for relevant information',
  parameters: { query: 'string', limit: 'number' },
  async execute(args = {}) {
    const mem = _mem();
    if (!mem) return { ok: false, err: 'Memory not initialized' };
    const results = mem.recall(args.query, args.limit);
    return { ok: true, out: JSON.stringify(results, null, 2), results };
  },
});

register({
  name: 'set_fact',
  description: 'Store a persistent fact about the user',
  parameters: { key: 'string', value: 'string' },
  async execute(args = {}) {
    const mem = _mem();
    if (!mem) return { ok: false, err: 'Memory not initialized' };
    mem.setFact(args.key, args.value, 'tool');
    return { ok: true, out: `Fact saved: ${args.key}` };
  },
});

register({
  name: 'get_facts',
  description: 'Get all stored facts about the user',
  parameters: {},
  async execute() {
    const mem = _mem();
    if (!mem) return { ok: false, err: 'Memory not initialized' };
    const facts = mem.getAllFacts();
    return { ok: true, out: JSON.stringify(facts, null, 2), facts };
  },
});

register({
  name: 'log_meal',
  description: 'Log a meal with nutrition info',
  parameters: { description: 'string', calories: 'number', protein: 'number', carbs: 'number', fat: 'number' },
  async execute(args = {}) {
    const mem = _mem();
    if (!mem) return { ok: false, err: 'Memory not initialized' };
    mem.logMeal(args.description, args.calories, args.protein, args.carbs, args.fat);
    return { ok: true, out: `Meal logged: ${args.description}` };
  },
});

register({
  name: 'get_nutrition',
  description: 'Get today\'s nutrition summary',
  parameters: {},
  async execute() {
    const mem = _mem();
    if (!mem) return { ok: false, err: 'Memory not initialized' };
    const nutrition = mem.getTodayNutrition();
    return { ok: true, out: JSON.stringify(nutrition, null, 2), nutrition };
  },
});
