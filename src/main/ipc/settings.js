'use strict';

// IPC handlers — keys + settings (encrypted secrets + app preferences).
// Channels: saveKey, getKey, hasKey, deleteKey, set, get.

function register(deps) {
  const {
    ipcMain,
    keysStore, settingsStore,
    assertAllowedKey, assertAllowedSetting,
    BrowserWindow,
    loadAgentModules,
    getAgentMemory,
  } = deps;

  ipcMain.handle('saveKey',   (_, s, k) => {
    assertAllowedKey(s);
    keysStore.set(`k_${s}`, k);
    // PHASE 28.3 — when the user adds their first OpenAI / Gemini key,
    // kick off an embeddings backfill so existing memories become
    // semantically searchable without waiting for the next app reboot.
    // Best-effort + debounced (the key-save IPC fires per character on
    // some inputs, so we wait 1.5s after the latest write).
    if ((s === 'openai' || s === 'gemini') && k && k.length > 10) {
      try {
        clearTimeout(global.__hzEmbedBackfillTimer);
        global.__hzEmbedBackfillTimer = setTimeout(() => {
          try {
            loadAgentModules();
            const agentMemory = getAgentMemory();
            if (!agentMemory || !agentMemory.embeddings) return;
            if (!agentMemory.embeddings.isAvailable()) return;
            if (!agentMemory._data?.memories?.length) return;
            console.log('[embeddings] key saved — kicking off backfill for', agentMemory._data.memories.length, 'memories');
            agentMemory.embedAllPending(progress => {
              try {
                const wins = BrowserWindow.getAllWindows();
                for (const w of wins) {
                  if (w && !w.isDestroyed() && w.webContents) w.webContents.send('memory:embeddingProgress', progress);
                }
              } catch (_) {}
            }).then(r => console.log('[embeddings] post-key-save backfill:', r))
              .catch(e => console.warn('[embeddings] post-key-save backfill failed:', e.message));
          } catch (e) { console.warn('[embeddings] backfill trigger failed:', e.message); }
        }, 1500);
      } catch (_) {}
    }
    return true;
  });
  ipcMain.handle('getKey',    (_, s)    => { assertAllowedKey(s); return keysStore.get(`k_${s}`, null); });
  ipcMain.handle('hasKey',    (_, s)    => { assertAllowedKey(s); return !!keysStore.get(`k_${s}`); });
  ipcMain.handle('deleteKey', (_, s)    => { assertAllowedKey(s); keysStore.delete(`k_${s}`); return true; });
  ipcMain.handle('set',       (_, k, v) => { assertAllowedSetting(k); settingsStore.set(k, v); return true; });
  ipcMain.handle('get',       (_, k)    => { assertAllowedSetting(k); return settingsStore.get(k, null); });
}

module.exports = { register };
