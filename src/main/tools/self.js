'use strict';
/**
 * Self-introspection tools (PHASE 28.5 — Hermes-style progressive
 * disclosure). Cheap metadata about the running agent: version, persona,
 * tools, skills, channels.
 *
 * No LLM round-trips — all answers come from in-process state through the
 * main.js require-cache lookup, same pattern the original switch used.
 */

const { register } = require('./registry');

function _agent() { return require('../agent'); }
function _mainExports() {
  try { return require.cache[require.resolve('../main')]?.exports || null; }
  catch (_) { return null; }
}
function _personas() {
  try { return require('../personas'); } catch (_) { return null; }
}

register({
  name: 'self_describe',
  description: '[Self] Returns a summary of this agent: version, active provider, active persona, memory layers (counts), executor mode, channel adapters that are configured.',
  parameters: {},
  async execute() {
    try {
      const main = _mainExports();
      const mem = _agent()._getMemoryInstance() || main?.agentMemory || null;
      const personasMod = _personas();
      const settingsStore = main?.settingsStore || null;
      const dialecticTotal = mem?.dialectic?.records?.length || 0;
      const stats = {
        memories: mem?._data?.memories?.length || 0,
        facts: Object.keys(mem?._data?.facts || {}).length,
        conversations: mem?._data?.conversations?.length || 0,
        dialectic: dialecticTotal,
      };
      let pkg = {};
      try { pkg = require('../../../package.json'); } catch (_) {}
      const personaId = settingsStore?.get?.('persona') || 'jarvis';
      const personaName = personasMod?.getPersona?.(personaId)?.name || personaId;
      const provider = settingsStore?.get?.('provider') || 'gemini';
      const exec = settingsStore?.get?.('executionMode') || 'host';
      const channels = ['telegram_bot', 'discord', 'slack', 'whatsapp', 'signal', 'imessage', 'email']
        .filter(id => {
          const live = settingsStore?.get?.(`connection.${id}.live`) === true
            || settingsStore?.get?.(`${id}.enabled`) === true;
          return live;
        });
      return {
        ok: true,
        name: 'Horizon AI',
        version: pkg.version || 'unknown',
        provider,
        activePersona: { id: personaId, name: personaName },
        executor: exec,
        memory: {
          backend: 'JSON + SQLite + FTS5 + embeddings + entity-graph',
          layers: (_agent().MEMORY_LAYERS || []).length || 13,
          layerNames: _agent().MEMORY_LAYERS || [],
          ...stats,
        },
        channelsLive: channels,
        author: pkg.author?.name || 'Ernest Kostevich',
        license: pkg.license || 'BUSL-1.1',
      };
    } catch (e) {
      return { ok: false, err: 'self_describe failed: ' + e.message };
    }
  },
});

register({
  name: 'self_list_capabilities',
  description: '[Self] Returns the lightweight list of every tool, skill, persona, and connected channel currently available. Cheap, ~2-3 KB.',
  parameters: {},
  async execute() {
    try {
      const main = _mainExports();
      const personasMod = _personas();
      const skillsMgr = main?.skillsManager || null;
      const toolDefs = _agent().TOOL_DEFINITIONS || [];
      const tools = toolDefs.map(t => ({ name: t.name, desc: (t.desc || '').slice(0, 140) }));
      let skills = [];
      if (skillsMgr && typeof skillsMgr.list === 'function') {
        try {
          const all = skillsMgr.list() || [];
          skills = all.slice(0, 60).map(s => ({
            id: s.id,
            name: s.name,
            desc: (s.description || '').slice(0, 140),
            scope: s.scope,
          }));
        } catch (_) {}
      }
      const personas = (personasMod?.getAllPersonas?.() || []).map(p => ({
        id: p.id, name: p.name, builtin: p.builtin,
      }));
      return {
        ok: true,
        tools,
        skills,
        personas,
        channels: ['telegram_bot', 'discord', 'slack', 'whatsapp', 'signal', 'imessage', 'email', 'notion', 'linear'],
        executors: ['host', 'docker', 'ssh', 'modal', 'daytona', 'singularity'],
        note: 'For full details on any skill, call self_read_skill. For full persona prompt, call self_read_persona.',
      };
    } catch (e) {
      return { ok: false, err: 'self_list_capabilities failed: ' + e.message };
    }
  },
});

register({
  name: 'self_read_skill',
  description: '[Self] Read the full SKILL.md for a specific installed skill. Use after self_list_capabilities when you want to actually understand how a skill works before invoking it.',
  parameters: { skill: 'string skill id (slug, e.g. "refactor-react")' },
  async execute(args = {}) {
    try {
      const main = _mainExports();
      const skillsMgr = main?.skillsManager || null;
      if (!skillsMgr) return { ok: false, err: 'skills manager not loaded' };
      const id = String(args.skill || '').trim();
      if (!id) return { ok: false, err: 'self_read_skill needs { skill: <id> }' };
      const skill = (skillsMgr.list() || []).find(s => s.id === id || s.name === id);
      if (!skill) return { ok: false, err: `unknown skill: ${id}` };
      const fs = require('fs');
      const path = require('path');
      const md = skill.path ? path.join(skill.path, 'SKILL.md') : null;
      let content = '';
      if (md && fs.existsSync(md)) content = fs.readFileSync(md, 'utf8');
      return {
        ok: true,
        id: skill.id,
        name: skill.name,
        scope: skill.scope,
        description: skill.description || '',
        path: skill.path || null,
        content: content.slice(0, 12000),
      };
    } catch (e) {
      return { ok: false, err: 'self_read_skill failed: ' + e.message };
    }
  },
});

register({
  name: 'self_read_persona',
  description: '[Self] Read the full prompt + memories of a persona (the active one, or a specific id). Use to ground yourself in the voice you should be using, or to switch persona mid-task.',
  parameters: { id: 'string persona id optional (default = active)' },
  async execute(args = {}) {
    try {
      const main = _mainExports();
      const personasMod = _personas();
      if (!personasMod) return { ok: false, err: 'personas module unavailable' };
      const settingsStore = main?.settingsStore || null;
      const id = String(args.id || '').trim() || (settingsStore?.get?.('persona') || 'jarvis');
      const persona = personasMod.getPersonaFull?.(id);
      if (!persona) return { ok: false, err: `unknown persona: ${id}` };
      return {
        ok: true,
        id: persona.id,
        name: persona.name,
        icon: persona.icon || null,
        builtin: !!persona.builtin,
        allowedTools: persona.allowedTools || null,
        prompt: persona.prompt || {},
        memories: (persona.memories || []).slice(0, 40),
        memoriesCount: (persona.memories || []).length,
        wakeResponses: persona.wakeResponses || {},
      };
    } catch (e) {
      return { ok: false, err: 'self_read_persona failed: ' + e.message };
    }
  },
});
