'use strict';

// IPC handlers — memory / facts / FTS / dialectic / canvas / nutrition /
// conversation memory / workspace memory.
// Channels: memRemember, memRecall, memSetFact, memGetFact, memGetFacts,
// canvas:get, canvas:set, canvas:write, canvas:clear, memGetRecent,
// memEmbedStatus, memEmbedReindex, dialecticSummary, dialecticRecent,
// dialecticSearch, dialecticRecord, dialecticClear, memoryReviewerStatus,
// memoryReviewerRunNow, memoryDbStatus, memoryDbMigrate, memSnapshot,
// memForgetFact, memForgetMemory, memEditFact, memEditMemory,
// memGetUserProfile, memUpdateUserProfile, memFtsSearch, memFtsStats,
// workspaceMemoryGet, executorStatus, workspaceMemoryWrite, nutritionLog,
// nutritionGet, nutritionToday, memSaveConversation, memSearchConversations.

function register(deps) {
  const {
    ipcMain, app,
    BrowserWindow,
    dialog,
    path,
    loadAgentModules,
    getAgentMemory, getDialecticModel, getMemoryReviewer, getCanvasManager,
    getExecutor,
    currentWorkspaceRoot, getWorkspaceMemory,
  } = deps;

  ipcMain.handle('memRemember', (_, content, category, importance) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return false;
    agentMemory.remember(content, category || 'general', importance || 5);
    return true;
  });

  ipcMain.handle('memRecall', (_, query, limit) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return [];
    return agentMemory.recall(query, limit || 10);
  });

  ipcMain.handle('memSetFact', (_, key, value) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return false;
    agentMemory.setFact(key, value);
    return true;
  });

  ipcMain.handle('memGetFact', (_, key) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return null;
    return agentMemory.getFact(key);
  });

  ipcMain.handle('memGetFacts', () => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return {};
    return agentMemory.getAllFacts();
  });

  // ── Live Canvas (Phase 26 MVP) ─────────────────────────────────────────
  ipcMain.handle('canvas:get', () => {
    const canvasManager = getCanvasManager();
    if (!canvasManager) return { content: '', version: 0, updatedAt: null, editLogTail: [] };
    return canvasManager.get();
  });
  ipcMain.handle('canvas:set', (_, content) => {
    const canvasManager = getCanvasManager();
    if (!canvasManager) return { ok: false, error: 'Canvas not initialised' };
    const snap = canvasManager.setContent(typeof content === 'string' ? content : '', 'user');
    return { ok: true, ...snap };
  });
  ipcMain.handle('canvas:write', (_, payload = {}) => {
    const canvasManager = getCanvasManager();
    if (!canvasManager) return { ok: false, error: 'Canvas not initialised' };
    const snap = canvasManager.write({
      mode: payload.mode || 'append',
      content: String(payload.content || ''),
      source: 'user',
    });
    return { ok: true, ...snap };
  });
  ipcMain.handle('canvas:clear', () => {
    const canvasManager = getCanvasManager();
    if (!canvasManager) return { ok: false };
    return { ok: true, ...canvasManager.clear('user') };
  });

  ipcMain.handle('memGetRecent', (_, limit) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return [];
    return agentMemory.getRecent(limit || 20);
  });

  ipcMain.handle('memEmbedStatus', () => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
    try { return { ok: true, ...agentMemory.embeddingStatus() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('memEmbedReindex', async () => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
    try {
      const r = await agentMemory.embedAllPending(progress => {
        try {
          const wins = BrowserWindow.getAllWindows();
          for (const w of wins) {
            if (w && !w.isDestroyed() && w.webContents) w.webContents.send('memory:embeddingProgress', progress);
          }
        } catch (_) {}
      });
      return { ok: true, ...r };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  function _memSqlitePaths() {
    const ud = (typeof app !== 'undefined' && app.getPath) ? app.getPath('userData') : null;
    if (!ud) return null;
    return {
      jsonPath: path.join(ud, 'memory.json'),
      dbPath: path.join(ud, 'memory.sqlite'),
    };
  }

  ipcMain.handle('dialecticSummary', () => {
    const dialecticModel = getDialecticModel();
    if (!dialecticModel) return { ok: false, error: 'dialectic model not initialized' };
    try { return { ok: true, ...dialecticModel.summary() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('dialecticRecent', (_, opts) => {
    const dialecticModel = getDialecticModel();
    if (!dialecticModel) return { ok: false, error: 'dialectic model not initialized', records: [] };
    try {
      const limit = Math.max(1, Math.min(500, Number(opts?.limit) || 50));
      return { ok: true, records: dialecticModel.getRecent(limit) };
    } catch (e) { return { ok: false, error: e.message, records: [] }; }
  });
  ipcMain.handle('dialecticSearch', (_, payload) => {
    const dialecticModel = getDialecticModel();
    if (!dialecticModel) return { ok: false, error: 'dialectic model not initialized', records: [] };
    try {
      const limit = Math.max(1, Math.min(500, Number(payload?.limit) || 50));
      const q = String(payload?.query || '').slice(0, 200);
      return { ok: true, records: dialecticModel.search(q, limit) };
    } catch (e) { return { ok: false, error: e.message, records: [] }; }
  });
  ipcMain.handle('dialecticRecord', (_, diff) => {
    const dialecticModel = getDialecticModel();
    if (!dialecticModel) return { ok: false, error: 'dialectic model not initialized' };
    try {
      const entry = dialecticModel.record(diff || {});
      return entry ? { ok: true, entry } : { ok: false, error: 'invalid diff payload' };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('dialecticClear', () => {
    const dialecticModel = getDialecticModel();
    if (!dialecticModel) return { ok: false, error: 'dialectic model not initialized' };
    try { return { ok: true, ...dialecticModel.clear() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('memoryReviewerStatus', () => {
    const memoryReviewer = getMemoryReviewer();
    if (!memoryReviewer) return { ok: false, error: 'reviewer not initialized' };
    return { ok: true, ...memoryReviewer.status() };
  });
  ipcMain.handle('memoryReviewerRunNow', async () => {
    const memoryReviewer = getMemoryReviewer();
    if (!memoryReviewer) return { ok: false, error: 'reviewer not initialized' };
    try {
      const r = await memoryReviewer.reviewNow();
      return r;
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // v0.0.3 — insights / consolidation layer (10): synthesize higher-order
  // "insight" memories from clusters of recent episodes. Offline-safe.
  ipcMain.handle('memConsolidateNow', async () => {
    const memoryReviewer = getMemoryReviewer();
    if (!memoryReviewer || typeof memoryReviewer.consolidateNow !== 'function') {
      return { ok: false, error: 'consolidation not available' };
    }
    try { return await memoryReviewer.consolidateNow(); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('memoryDbStatus', () => {
    const paths = _memSqlitePaths();
    if (!paths) return { ok: false, error: 'userData path unavailable' };
    try {
      const { MemoryDb } = require('../memoryDb');
      const db = new MemoryDb(paths.dbPath);
      const fs = require('fs');
      if (!fs.existsSync(paths.dbPath)) {
        return { ok: true, exists: false, dbPath: paths.dbPath };
      }
      db.open();
      const stats = db.stats();
      db.close();
      return { ok: true, exists: true, dbPath: paths.dbPath, stats };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('memoryDbMigrate', () => {
    const paths = _memSqlitePaths();
    if (!paths) return { ok: false, error: 'userData path unavailable' };
    try {
      const { migrateJsonToSqlite } = require('../runtime/migrateJsonToSqlite');
      return migrateJsonToSqlite(paths);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Sprint 7B — Export SQLite → JSON snapshot. When the renderer doesn't
  // pre-pick a path, we pop a Save dialog so the user picks where to save.
  ipcMain.handle('memoryDbExportJson', async (event, targetPath) => {
    const paths = _memSqlitePaths();
    if (!paths) return { ok: false, error: 'userData path unavailable' };
    try {
      const fs = require('fs');
      if (!fs.existsSync(paths.dbPath)) {
        return { ok: false, error: 'No SQLite DB yet — nothing to export.' };
      }
      let outPath = targetPath ? String(targetPath) : '';
      if (!outPath && dialog) {
        const win = BrowserWindow.fromWebContents(event.sender);
        const defaultName = `memory.export.${new Date().toISOString().slice(0, 10)}.json`;
        const r = await dialog.showSaveDialog(win, {
          title: 'Export memory to JSON file',
          defaultPath: defaultName,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (r.canceled || !r.filePath) return { ok: false, canceled: true };
        outPath = r.filePath;
      }
      if (!outPath) {
        // Fallback default (e.g. dialog unavailable in some test contexts)
        outPath = path.join(path.dirname(paths.dbPath), `memory.export.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      }
      const { MemoryDb } = require('../memoryDb');
      const db = new MemoryDb(paths.dbPath).open();
      const r = db.exportToJson(outPath);
      db.close();
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Sprint 7B — Import JSON snapshot → SQLite. When the renderer doesn't
  // pre-pick a path, we pop an Open dialog. Idempotent (dedupes by
  // stable keys/ids).
  ipcMain.handle('memoryDbImportJson', async (event, sourcePath) => {
    const paths = _memSqlitePaths();
    if (!paths) return { ok: false, error: 'userData path unavailable' };
    try {
      const fs = require('fs');
      let inPath = sourcePath ? String(sourcePath) : '';
      if (!inPath && dialog) {
        const win = BrowserWindow.fromWebContents(event.sender);
        const r = await dialog.showOpenDialog(win, {
          title: 'Import JSON memory dump',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All', extensions: ['*'] }],
        });
        if (r.canceled || !r.filePaths?.[0]) return { ok: false, canceled: true };
        inPath = r.filePaths[0];
      }
      if (!inPath) return { ok: false, error: 'source path required' };
      if (!fs.existsSync(inPath)) {
        return { ok: false, error: `File not found: ${inPath}` };
      }
      const { MemoryDb } = require('../memoryDb');
      const db = new MemoryDb(paths.dbPath).open();
      const before = db.stats();
      db.importFromJsonFile(inPath);
      const after = db.stats();
      db.close();
      const added = {
        memories: after.memories - before.memories,
        facts: after.facts - before.facts,
        conversations: after.conversations - before.conversations,
      };
      // Re-hydrate the in-memory cache so the UI sees new rows immediately.
      try {
        const agentMemory = getAgentMemory();
        if (agentMemory && typeof agentMemory.setMemoryDb === 'function') {
          const live = new MemoryDb(paths.dbPath).open();
          agentMemory.setMemoryDb(live);
        }
      } catch (_) { /* best-effort */ }
      return { ok: true, before, after, added, source: inPath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('memSnapshot', (_, opts) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
    const factLimit = Math.max(1, Math.min(200, Number(opts?.factLimit) || 50));
    const memLimit = Math.max(1, Math.min(200, Number(opts?.memLimit) || 30));
    try {
      const factsRaw = agentMemory._data?.facts || {};
      const factEntries = Object.entries(factsRaw)
        .map(([key, v]) => ({
          key,
          value: typeof v === 'object' && v !== null ? (v.value ?? '') : String(v ?? ''),
          seen: typeof v === 'object' && v !== null ? (v.seen || 0) : 0,
          updated: typeof v === 'object' && v !== null ? v.updated : null,
          source: typeof v === 'object' && v !== null ? (v.source || 'unknown') : 'unknown',
          lastSource: typeof v === 'object' && v !== null ? (v.lastSource || v.source || 'unknown') : 'unknown',
        }))
        .sort((a, b) => (b.updated || 0) - (a.updated || 0))
        .slice(0, factLimit);
      const recent = typeof agentMemory.getRecent === 'function' ? agentMemory.getRecent(memLimit) : [];
      const stats = agentMemory._data?.learning?.stats || {};
      const userProfile = typeof agentMemory.getUserProfile === 'function' ? agentMemory.getUserProfile() : null;
      return {
        ok: true,
        facts: factEntries,
        memories: recent,
        userProfile,
        stats: {
          totalFacts: Object.keys(factsRaw).length,
          totalMemories: agentMemory._data?.memories?.length || 0,
          learnedItems: stats.learnedItems || 0,
          lastLearnedAt: stats.lastLearnedAt || null,
          conversations: agentMemory._data?.conversations?.length || 0,
          // v0.0.3 — surface stats that were written but never read back, plus
          // the pinned count + profile confidence, so the Inspector is honest.
          turns: stats.turns || 0,
          lastTurnAt: stats.lastTurnAt || null,
          pinned: (agentMemory._data?.memories || []).filter(m => m && m.pinned).length,
          profileConfidence: (userProfile && typeof userProfile.confidence === 'number') ? userProfile.confidence : 0,
        },
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('memForgetFact', (_, key) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
    return { ok: agentMemory.forgetFact(String(key || '')) };
  });

  ipcMain.handle('memForgetMemory', (_, idOrKey) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
    return { ok: agentMemory.forgetMemory(String(idOrKey || '')) };
  });

  // v0.0.3 — pinned core memory layer (13): pin/unpin so a memory is always
  // injected into the agent prompt (bypasses recall threshold/top-K).
  ipcMain.handle('memPinMemory', (_, idOrKey) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
    if (typeof agentMemory.pinMemory !== 'function') return { ok: false, error: 'pin not supported' };
    return agentMemory.pinMemory(String(idOrKey || ''));
  });

  ipcMain.handle('memUnpinMemory', (_, idOrKey) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
    if (typeof agentMemory.unpinMemory !== 'function') return { ok: false, error: 'unpin not supported' };
    return agentMemory.unpinMemory(String(idOrKey || ''));
  });

  ipcMain.handle('memEditFact', (_, key, value) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
    return { ok: agentMemory.setFact(String(key || ''), String(value || ''), 'manual') };
  });

  ipcMain.handle('memEditMemory', (_, idOrKey, partial) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
    return { ok: agentMemory.editMemory(String(idOrKey || ''), partial || {}) };
  });

  ipcMain.handle('memGetUserProfile', () => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
    return { ok: true, profile: agentMemory.getUserProfile() };
  });

  ipcMain.handle('memUpdateUserProfile', (_, partial) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return { ok: false, error: 'agent memory not loaded' };
    return { ok: true, profile: agentMemory.updateUserProfile(partial || {}, 'manual') };
  });

  ipcMain.handle('memFtsSearch', (_, query, limit) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory || typeof agentMemory.ftsSearch !== 'function') return { ok: false, error: 'fts unavailable' };
    return { ok: true, results: agentMemory.ftsSearch(String(query || ''), Math.max(1, Math.min(200, Number(limit) || 30))), stats: agentMemory.ftsStats?.() || {} };
  });

  ipcMain.handle('memFtsStats', () => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory || typeof agentMemory.ftsStats !== 'function') return { ok: false, error: 'fts unavailable' };
    return { ok: true, stats: agentMemory.ftsStats() };
  });

  ipcMain.handle('workspaceMemoryGet', () => {
    try {
      const root = currentWorkspaceRoot();
      if (!root) return { ok: false, error: 'no workspace open' };
      return { ok: true, root, ...(getWorkspaceMemory().get(root)) };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('executorStatus', () => {
    loadAgentModules();
    const executor = getExecutor();
    if (!executor) return { ok: false, error: 'executor not loaded' };
    return { ok: true, ...executor.status() };
  });

  ipcMain.handle('workspaceMemoryWrite', (_, partial) => {
    try {
      const root = currentWorkspaceRoot();
      if (!root) return { ok: false, error: 'no workspace open' };
      return getWorkspaceMemory().write(root, partial || {});
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ── NUTRITION TRACKING ─────────────────────────────────────────
  ipcMain.handle('nutritionLog', (_, description, calories, protein, carbs, fat) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return false;
    return agentMemory.logMeal(description, calories, protein, carbs, fat);
  });

  ipcMain.handle('nutritionGet', (_, days) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return { meals: [], total: {} };
    return agentMemory.getMeals(days || 7);
  });

  ipcMain.handle('nutritionToday', () => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return { meals: [], total: { calories: 0, protein: 0, carbs: 0, fat: 0 } };
    return agentMemory.getTodayNutrition();
  });

  // ── CONVERSATION MEMORY ─────────────────────────────────────────────────────
  ipcMain.handle('memSaveConversation', (_, userMessage, assistantReply) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return false;
    agentMemory.saveConversation(userMessage, assistantReply);
    return true;
  });

  ipcMain.handle('memSearchConversations', (_, query, limit) => {
    loadAgentModules();
    const agentMemory = getAgentMemory();
    if (!agentMemory) return [];
    return agentMemory.searchConversations(query, limit || 10);
  });
}

module.exports = { register };
