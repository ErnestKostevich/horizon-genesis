'use strict';

// IPC handlers — Hermes-style desktop dashboard.
// Channels:
//   dashboard:summary       → {provider, persona, model, memoryCount,
//                              skillCount, channelCount, chatCount,
//                              todayStats:{turns, costUsd, toolsUsed, tasksDone}}
//   dashboard:recentChats   → top N chats (id, title, updatedAt, snippet)
//   dashboard:activeTasks   → kanban queued + running rows (slim)
//   dashboard:activityFeed  → last N tool calls aggregated from agent runs
//
// This is read-only aggregation glue — every underlying source already
// has a richer IPC handler used elsewhere. The dashboard view collapses
// those into single calls so first paint is cheap.

const fs = require('fs');
const path = require('path');

function register(deps) {
  const {
    ipcMain, app,
    settingsStore,
    loadAgentModules,
    getChatStore,
    getKanbanQueue,
    getSkillsManager,
    getConnectionsManager,
    getPersonas,
    selectedModel,
    readAgentRuns,
  } = deps;

  function _safeUserData() {
    try { return app.getPath('userData'); } catch (_) { return null; }
  }

  function _loadCostEntries(limit = 5000) {
    const ud = _safeUserData();
    if (!ud) return [];
    const p = path.join(ud, 'horizon-cost.jsonl');
    if (!fs.existsSync(p)) return [];
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const slice = lines.slice(-limit);
      const out = [];
      for (const l of slice) {
        try { out.push(JSON.parse(l)); } catch (_) {}
      }
      return out;
    } catch (_) { return []; }
  }

  function _todayCostSummary() {
    const entries = _loadCostEntries(5000);
    const dayKey = new Date().toISOString().slice(0, 10);
    let turns = 0;
    let totalTokens = 0;
    let costUsd = 0;
    for (const e of entries) {
      if (typeof e.at !== 'string') continue;
      if (e.at.slice(0, 10) !== dayKey) continue;
      turns++;
      totalTokens += Number(e.total) || 0;
      costUsd += Number(e.costUsd) || 0;
    }
    return { turns, totalTokens, costUsd: Math.round(costUsd * 10000) / 10000 };
  }

  function _todayAgentSummary() {
    let toolsUsed = 0;
    let tasksDone = 0;
    try {
      const runs = readAgentRuns ? readAgentRuns(120) : [];
      const todayPrefix = new Date().toISOString().slice(0, 10);
      for (const r of runs) {
        const start = String(r.startedAt || r.endedAt || '');
        if (!start.startsWith(todayPrefix)) continue;
        if (Array.isArray(r.steps)) {
          for (const s of r.steps) {
            if (s && s.tool) toolsUsed++;
          }
        }
        if (r.status === 'done' || r.status === 'completed' || r.status === 'success') {
          tasksDone++;
        }
      }
    } catch (_) { /* best effort */ }
    return { toolsUsed, tasksDone };
  }

  ipcMain.handle('dashboard:summary', () => {
    loadAgentModules();
    const provider = String(settingsStore.get('provider') || 'gemini');
    const personaId = String(settingsStore.get('persona') || 'jarvis');
    let model = '';
    try { model = selectedModel ? selectedModel(provider) : ''; } catch (_) { model = ''; }

    let personaLabel = personaId;
    try {
      const personas = getPersonas ? getPersonas() : null;
      if (personas && typeof personas.get === 'function') {
        const p = personas.get(personaId);
        if (p && p.name) personaLabel = p.name;
      } else if (personas && typeof personas.list === 'function') {
        const p = personas.list().find(x => x.id === personaId);
        if (p && p.name) personaLabel = p.name;
      }
    } catch (_) { /* persona module may not be ready */ }

    let chatCount = 0;
    try {
      const cs = getChatStore && getChatStore();
      if (cs && typeof cs.list === 'function') chatCount = (cs.list() || []).length;
    } catch (_) {}

    let memoryCount = 0;
    try {
      const ud = _safeUserData();
      if (ud) {
        const dbPath = path.join(ud, 'horizon-memory.db');
        if (fs.existsSync(dbPath)) {
          const { MemoryDb } = require('../memoryDb');
          const db = new MemoryDb(dbPath);
          db.open();
          const stats = db.stats();
          db.close();
          memoryCount = (stats && (stats.memories || stats.totalMemories || stats.total || 0)) || 0;
          if (!memoryCount && stats && typeof stats === 'object') {
            for (const v of Object.values(stats)) {
              if (typeof v === 'number') memoryCount += v;
            }
          }
        }
      }
    } catch (_) { /* memory db may not yet exist */ }

    let skillCount = 0;
    try {
      const sm = getSkillsManager && getSkillsManager();
      if (sm) {
        if (typeof sm.refreshIfStale === 'function') sm.refreshIfStale();
        const list = (typeof sm.list === 'function' ? sm.list() : []) || [];
        skillCount = list.filter(s => !s || s.enabled !== false).length || list.length;
      }
    } catch (_) {}

    let channelCount = 0;
    try {
      const cm = getConnectionsManager && getConnectionsManager();
      if (cm && typeof cm.list === 'function') {
        const conns = cm.list() || [];
        channelCount = conns.filter(c => c && (c.live || c.enabled || c.connected || c.status === 'live')).length;
        if (!channelCount) channelCount = conns.length;
      }
    } catch (_) {}

    const todayCost = _todayCostSummary();
    const todayAgent = _todayAgentSummary();
    const turns = todayCost.turns || todayAgent.tasksDone; // fallback when cost not tracked

    return {
      ok: true,
      provider,
      model,
      persona: personaId,
      personaLabel,
      memoryCount,
      skillCount,
      channelCount,
      chatCount,
      todayStats: {
        turns,
        costUsd: todayCost.costUsd,
        totalTokens: todayCost.totalTokens,
        toolsUsed: todayAgent.toolsUsed,
        tasksDone: todayAgent.tasksDone,
      },
    };
  });

  ipcMain.handle('dashboard:recentChats', (_e, limit = 5) => {
    loadAgentModules();
    const cs = getChatStore && getChatStore();
    if (!cs || typeof cs.list !== 'function') return { ok: true, chats: [] };
    try {
      let chats = cs.list() || [];
      // Sort by updatedAt / createdAt descending — most stores already do
      // this, but normalize to be safe.
      chats = chats.slice().sort((a, b) => {
        const at = a.updatedAt || a.createdAt || 0;
        const bt = b.updatedAt || b.createdAt || 0;
        return new Date(bt).getTime() - new Date(at).getTime();
      });
      const n = Math.max(1, Math.min(20, Number(limit) || 5));
      const top = chats.slice(0, n).map(c => {
        let snippet = '';
        if (typeof c.snippet === 'string') snippet = c.snippet;
        else if (typeof c.preview === 'string') snippet = c.preview;
        else if (typeof c.lastMessage === 'string') snippet = c.lastMessage;
        return {
          id: c.id,
          title: c.title || c.name || 'Untitled chat',
          updatedAt: c.updatedAt || c.createdAt || null,
          snippet: snippet ? snippet.slice(0, 140) : '',
          messageCount: c.messageCount || c.messages?.length || 0,
        };
      });
      return { ok: true, chats: top };
    } catch (e) { return { ok: false, error: e.message, chats: [] }; }
  });

  ipcMain.handle('dashboard:activeTasks', (_e, limit = 6) => {
    const q = getKanbanQueue && getKanbanQueue();
    if (!q) return { ok: true, queued: [], running: [], stats: null };
    try {
      const n = Math.max(1, Math.min(20, Number(limit) || 6));
      const queued  = (typeof q.list === 'function') ? q.list({ status: 'queued',  limit: n }) : [];
      const running = (typeof q.list === 'function') ? q.list({ status: 'running', limit: n }) : [];
      let stats = null;
      try { stats = (typeof q.stats === 'function') ? q.stats() : null; } catch (_) {}
      return { ok: true, queued, running, stats };
    } catch (e) { return { ok: false, error: e.message, queued: [], running: [] }; }
  });

  ipcMain.handle('dashboard:activityFeed', (_e, limit = 10) => {
    try {
      const n = Math.max(1, Math.min(40, Number(limit) || 10));
      const runs = readAgentRuns ? readAgentRuns(60) : [];
      const items = [];
      for (const r of runs) {
        if (!Array.isArray(r.steps)) continue;
        for (let i = r.steps.length - 1; i >= 0; i--) {
          const s = r.steps[i];
          if (!s || !s.tool) continue;
          items.push({
            id: s.id || `${r.id}:${i}`,
            tool: s.tool,
            runId: r.id,
            status: s.status || (s.endedAt ? 'done' : 'running'),
            startedAt: s.startedAt || s.at || r.startedAt || null,
            endedAt: s.endedAt || null,
            durationMs: (s.startedAt && s.endedAt)
              ? Math.max(0, new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime())
              : null,
            summary: (s.summary || s.argsPreview || s.input || s.preview || '').toString().slice(0, 120),
            provider: r.provider || null,
          });
          if (items.length >= n) break;
        }
        if (items.length >= n) break;
      }
      return { ok: true, items };
    } catch (e) { return { ok: false, error: e.message, items: [] }; }
  });
}

module.exports = { register };
