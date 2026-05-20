'use strict';

// IPC handlers — workspace + terminal + project config + ws indexer + TTS.
// Channels: wsChooseFolder, wsGetWorkspace, wsList, wsRead, wsWrite,
// wsSearch, projectConfigGet, projectConfigWriteRules, projectConfigWriteHooks,
// wsIndexBuild, wsIndexStatus, wsIndexQuery, wsIndexClear, wsShell,
// terminalCreate, terminalWrite, terminalResize, terminalKill,
// ttsElevenLabs, ttsOpenAI.

function register(deps) {
  const {
    ipcMain, dialog,
    fs, os, path,
    spawn,
    IS_WIN,
    settingsStore, keysStore,
    runShell, withPermission,
    getWin,
    currentWorkspaceRoot, resolveWorkspacePath,
    safeDirEntries, searchWorkspaceFiles,
    getProjectConfig, getWsIndexer,
    terminalSessions, createPtyTerminal, createPipeTerminal,
  } = deps;

  ipcMain.handle('wsChooseFolder', async () => {
    try {
      const r = await dialog.showOpenDialog(getWin(), {
        title: 'Choose Horizon code workspace',
        properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths?.[0]) return { ok:false, canceled:true };
      const root = path.resolve(r.filePaths[0]);
      settingsStore.set('codeWorkspace', root);
      // PR-D2 — kick off symbol indexing in the background. Doesn't
      // block the IPC response; renderer can poll wsIndexStatus to know
      // when @symbol autocomplete becomes useful.
      setImmediate(() => {
        try { getWsIndexer().build(root).catch(() => {}); } catch (_) {}
      });
      return { ok:true, path:root };
    } catch(e) { return { ok:false, err:e.message }; }
  });

  ipcMain.handle('wsGetWorkspace', () => {
    try {
      const root = currentWorkspaceRoot();
      return { ok:true, path:root };
    } catch(e) {
      return { ok:false, err:e.message, path:settingsStore.get('codeWorkspace') || '' };
    }
  });

  ipcMain.handle('wsList', (_, rel = '') => {
    try {
      const { root, target } = resolveWorkspacePath(rel);
      if (!fs.statSync(target).isDirectory()) return { ok:false, err:'Not a directory' };
      return { ok:true, root, rel:String(rel || '').replace(/\\/g, '/'), entries:safeDirEntries(target) };
    } catch(e) { return { ok:false, err:e.message }; }
  });

  ipcMain.handle('wsRead', (_, rel = '') => {
    try {
      const { root, target, rel: safeRel } = resolveWorkspacePath(rel);
      const stat = fs.statSync(target);
      if (!stat.isFile()) return { ok:false, err:'Not a file' };
      if (stat.size > 2 * 1024 * 1024) return { ok:false, err:'File is larger than 2MB' };
      return { ok:true, root, rel:safeRel, content:fs.readFileSync(target, 'utf8'), size:stat.size };
    } catch(e) { return { ok:false, err:e.message }; }
  });

  ipcMain.handle('wsWrite', async (event, rel = '', content = '') => {
    try {
      const { root, target, rel: safeRel } = resolveWorkspacePath(rel);
      return withPermission(
        event.sender,
        'fs.write_file',
        { path: safeRel, bytes: Buffer.byteLength(String(content ?? ''), 'utf8') },
        'Write workspace file',
        () => {
          fs.mkdirSync(path.dirname(target), { recursive:true });
          fs.writeFileSync(target, String(content ?? ''), 'utf8');
          return { ok:true, root, rel:safeRel, bytes:Buffer.byteLength(String(content ?? ''), 'utf8') };
        }
      );
    } catch(e) { return { ok:false, err:e.message }; }
  });

  ipcMain.handle('wsSearch', (_, query = '', rel = '') => {
    try {
      const q = String(query || '').trim();
      if (!q) return { ok:true, results:[] };
      const { root, target } = resolveWorkspacePath(rel);
      const start = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : root;
      return { ok:true, root, query:q, results:searchWorkspaceFiles(root, start, q) };
    } catch(e) { return { ok:false, err:e.message }; }
  });

  ipcMain.handle('projectConfigGet', () => {
    try {
      const root = currentWorkspaceRoot();
      if (!root) return { ok: false, err: 'no workspace open' };
      return { ok: true, ...(getProjectConfig().get(root)) };
    } catch (e) { return { ok: false, err: e.message }; }
  });
  ipcMain.handle('projectConfigWriteRules', (_, content) => {
    try {
      const root = currentWorkspaceRoot();
      if (!root) return { ok: false, error: 'no workspace open' };
      return getProjectConfig().writeRules(root, content);
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('projectConfigWriteHooks', (_, hooks) => {
    try {
      const root = currentWorkspaceRoot();
      if (!root) return { ok: false, error: 'no workspace open' };
      return getProjectConfig().writeHooks(root, hooks || {});
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('wsIndexBuild', async (_, opts = {}) => {
    try {
      const root = currentWorkspaceRoot();
      if (!root) return { ok: false, err: 'no workspace open' };
      return await getWsIndexer().build(root, opts || {});
    } catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('wsIndexStatus', () => {
    try { return getWsIndexer().status(); }
    catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('wsIndexQuery', (_, q = '', opts = {}) => {
    try { return getWsIndexer().query(q, opts || {}); }
    catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('wsIndexClear', () => {
    try { getWsIndexer().clear(); return { ok: true }; }
    catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('wsShell', async (event, cmd) => {
    try {
      const root = currentWorkspaceRoot();
      return await withPermission(
        event.sender,
        'shell_command',
        { command: String(cmd || ''), cwd: root },
        'Run workspace command',
        () => runShell(String(cmd || ''), 30000, { cwd: root })
      );
    } catch(e) { return { ok:false, err:e.message }; }
  });

  ipcMain.handle('terminalCreate', async (event, id, rel = '', cols = 100, rows = 30) => {
    try {
      const { target } = resolveWorkspacePath(rel || '.');
      const cwd = fs.statSync(target).isDirectory() ? target : path.dirname(target);
      const termId = String(id || `term-${Date.now().toString(36)}`);
      if (terminalSessions.has(termId)) {
        try { terminalSessions.get(termId).kill(); } catch (_) {}
        terminalSessions.delete(termId);
      }
      const send = data => {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
        try { event.sender.send('terminalData', { id: termId, data: text.replace(/\n/g, '\r\n') }); } catch (_) {}
      };
      const onExit = (exitCode, signal) => {
        terminalSessions.delete(termId);
        try { event.sender.send('terminalData', { id: termId, data: `\r\n[process exited ${exitCode}${signal ? ` ${signal}` : ''}]\r\n`, exitCode, signal }); } catch (_) {}
      };
      const term = createPtyTerminal({ termId, cwd, cols, rows, send, onExit })
        || createPipeTerminal({ termId, cwd, send, onExit });
      terminalSessions.set(termId, term);
      return {
        ok:true,
        id:termId,
        cwd,
        shell:term.shell,
        backend:term.backend,
        nativePty:term.backend === 'pty',
        nativeError:term.nativeError || '',
      };
    } catch(e) {
      return { ok:false, err:e.message };
    }
  });

  ipcMain.handle('terminalWrite', (_, id, data) => {
    const term = terminalSessions.get(String(id || ''));
    if (!term) return { ok:false, err:'Terminal session not found' };
    term.write(String(data ?? ''));
    return { ok:true };
  });

  ipcMain.handle('terminalResize', (_, id, cols, rows) => {
    const term = terminalSessions.get(String(id || ''));
    if (!term) return { ok:false, err:'Terminal session not found' };
    term.resize(cols, rows);
    return {
      ok:true,
      backend:term.backend,
      note:term.backend === 'pty' ? 'resized native PTY' : 'resize is ignored by the pipe-backed terminal transport',
    };
  });

  ipcMain.handle('terminalKill', (_, id) => {
    const term = terminalSessions.get(String(id || ''));
    if (!term) return { ok:true };
    try { term.kill(); } catch (_) {}
    terminalSessions.delete(String(id || ''));
    return { ok:true };
  });

  // ── ElevenLabs TTS ────────────────────────────────────────────────────────────
  ipcMain.handle('ttsElevenLabs', async (_, text, voiceId) => {
    const fetch = require('node-fetch');
    const key = keysStore.get('k_elevenlabs');
    if (!key) return { error: 'ElevenLabs key not set → Settings' };
    const vid = voiceId || settingsStore.get('elevenLabsVoice') || 'pNInz6obpgDQGcFmaJgB'; // Adam
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
        body: JSON.stringify({ text: text.slice(0, 500), model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); return { error: e?.detail?.message || 'ElevenLabs TTS failed' }; }
      const buf = await r.buffer();
      return { ok: true, base64: buf.toString('base64'), mimeType: 'audio/mpeg' };
    } catch(e) { return { error: e.message }; }
  });

  // ── OpenAI TTS ────────────────────────────────────────────────────────────────
  ipcMain.handle('ttsOpenAI', async (_, text, voice) => {
    const fetch = require('node-fetch');
    const key = keysStore.get('k_openai');
    if (!key) return { error: 'OpenAI key not set → Settings' };
    try {
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model: 'tts-1', input: text.slice(0, 4096), voice: voice || 'onyx' })
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); return { error: e?.error?.message || 'OpenAI TTS failed' }; }
      const buf = await r.buffer();
      return { ok: true, base64: buf.toString('base64'), mimeType: 'audio/mpeg' };
    } catch(e) { return { error: e.message }; }
  });
}

module.exports = { register };
