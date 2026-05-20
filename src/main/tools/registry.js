'use strict';
/**
 * Tool Registry — central lookup for all agent-dispatchable tools.
 *
 * Each tool exports:
 *   {
 *     name:        string                — unique tool name
 *     description: string optional        — short LLM-facing description
 *     parameters:  object  optional        — { paramName: 'type/description' }
 *     execute(args, ctx) -> Promise<any> — the actual implementation
 *   }
 *
 * agent.js's dispatchTool used to be a 320-line switch over 34 cases. The
 * registry decouples that: each tool category lives in its own file
 * (web.js, file.js, exec.js, computer.js, memory.js, system.js, self.js,
 * canvas.js, subagent.js, skills.js) and self-registers via require()
 * side-effect. dispatchTool just delegates to registry.get(name).execute(...).
 *
 * Why a function-scoped Map: same module instance is shared across the
 * whole process via Node's require cache, so registrations from any tool
 * file end up in the same table.
 */

const tools = new Map();

function register(toolDef) {
  if (!toolDef || typeof toolDef !== 'object') {
    throw new Error('register() requires a tool definition object');
  }
  if (!toolDef.name || typeof toolDef.name !== 'string') {
    throw new Error('Tool definition requires a string `name`');
  }
  if (typeof toolDef.execute !== 'function') {
    throw new Error(`Tool "${toolDef.name}" requires an execute() function`);
  }
  if (tools.has(toolDef.name)) {
    throw new Error(`Tool "${toolDef.name}" already registered`);
  }
  tools.set(toolDef.name, toolDef);
}

function get(name) {
  return tools.get(name) || null;
}

function has(name) {
  return tools.has(name);
}

function list() {
  return Array.from(tools.values());
}

function names() {
  return Array.from(tools.keys());
}

function allDefinitions() {
  return list().map(t => ({
    name: t.name,
    description: t.description || '',
    parameters: t.parameters || {},
  }));
}

// Mostly for tests — lets a test reset state between runs without
// reloading the require cache.
function _reset() {
  tools.clear();
}

module.exports = { register, get, has, list, names, allDefinitions, _reset };
