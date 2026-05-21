// Sprint 7D — Macros tab in Settings.
//
// Renders saved macros from the main process (H.macroList) and provides a
// "Record new macro" overlay that uses a renderer-side DOM listener to
// capture clicks + keystrokes. Captured events are pushed back into the
// main-process MacroRecorder singleton via H.macroPushEvent, so the saved
// JSON file ends up in <userData>/macros/<name>.json — the same place the
// `horizon macro record` CLI writes to.
//
// Also wires the OCR status pill: shows "Available" / "Install
// tesseract.js" depending on whether the optional dep is present.

(function bootMacrosTab() {
  if (typeof window === 'undefined') return;

  function $(sel) { return document.querySelector(sel); }

  // ─── Public — called from chat.html ────────────────────────────────────────

  async function macrosRefresh() {
    const list = $('#macros-list');
    const status = $('#macros-status');
    if (!list || !status) return;
    try {
      const r = await window.H.macroList();
      const macros = (r && r.macros) || [];
      status.textContent = macros.length ? `${macros.length} saved macro${macros.length === 1 ? '' : 's'}.` : 'No saved macros yet.';
      list.innerHTML = '';
      for (const m of macros) {
        const row = document.createElement('div');
        row.className = 'trow';
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.02);margin-bottom:6px';
        const last = m.lastPlayedAt ? new Date(m.lastPlayedAt).toLocaleString() : '—';
        row.innerHTML = `
          <div style="flex:1;min-width:0">
            <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHTML(m.name)}</div>
            <small style="color:var(--t3)">${m.events} events · ${Math.round(m.duration/100)/10}s · last: ${escapeHTML(last)}</small>
          </div>
          <button class="psv" data-act="play" data-name="${escapeAttr(m.name)}">Play</button>
          <button class="psv" data-act="show" data-name="${escapeAttr(m.name)}">Show</button>
          <button class="psv" data-act="delete" data-name="${escapeAttr(m.name)}" style="color:#f88">Delete</button>
        `;
        list.appendChild(row);
      }
      list.querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          const name = btn.getAttribute('data-name');
          const act = btn.getAttribute('data-act');
          if (act === 'play') macroPlay(name);
          else if (act === 'show') macroShow(name);
          else if (act === 'delete') macroDelete(name);
        });
      });
    } catch (e) {
      status.textContent = 'Failed to load: ' + (e?.message || e);
    }
  }

  async function refreshOcrStatus() {
    const el = $('#ocr-status');
    if (!el) return;
    try {
      const r = await window.H.ocrAvailable();
      if (r && r.available) {
        el.textContent = 'OCR ready (tesseract.js installed).';
        el.style.color = 'var(--ok, #4ade80)';
      } else {
        el.textContent = (r && r.message) || 'OCR not installed — install tesseract.js to enable.';
        el.style.color = 'var(--warn, #f0b454)';
      }
    } catch (e) {
      el.textContent = 'Could not query OCR status: ' + e.message;
    }
  }

  // ─── Recorder overlay ─────────────────────────────────────────────────────

  async function macroStartRecorder() {
    const name = prompt('Macro name (lowercase, no spaces):');
    if (!name) return;
    const start = await window.H.macroRecordStart(name);
    if (!start || !start.ok) {
      alert('Could not start recording: ' + (start?.error || 'unknown error'));
      return;
    }

    // Build an overlay that captures DOM events. We can't intercept
    // OS-level events outside our window without uiohook-napi, but the
    // overlay sits on top of the entire app and forwards every click /
    // keypress to the main-process recorder via H.macroPushEvent.
    const wrap = document.createElement('div');
    wrap.id = 'macro-overlay';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-family:inherit';
    wrap.innerHTML = `
      <div style="background:rgba(20,20,26,.95);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:24px 32px;min-width:340px;text-align:center;box-shadow:0 18px 60px rgba(0,0,0,.6)">
        <div style="font-size:14px;color:#f88;font-weight:600;letter-spacing:.04em;text-transform:uppercase">● Recording</div>
        <div id="macro-overlay-name" style="font-size:18px;margin-top:6px"></div>
        <div id="macro-overlay-count" style="font-size:13px;color:var(--t3);margin-top:4px">0 events captured</div>
        <div style="margin-top:18px;display:flex;gap:8px;justify-content:center">
          <button id="macro-stop-btn" class="psv" style="background:#c0392b;color:#fff;border-color:#c0392b">Stop &amp; Save</button>
          <button id="macro-cancel-btn" class="psv">Cancel</button>
        </div>
        <div style="font-size:11px;color:var(--t3);margin-top:14px">Click anywhere inside Horizon to capture; OS-wide capture needs uiohook-napi.</div>
      </div>
    `;
    document.body.appendChild(wrap);
    wrap.querySelector('#macro-overlay-name').textContent = name;

    let count = 0;
    let startedAt = Date.now();
    const bump = () => {
      count++;
      const el = wrap.querySelector('#macro-overlay-count');
      if (el) el.textContent = `${count} event${count === 1 ? '' : 's'} captured · ${Math.round((Date.now() - startedAt)/100)/10}s`;
    };

    // DOM listeners (renderer-window only — best-effort within our app)
    const onMove = (e) => {
      // Throttle: only every ~80ms to keep file size sane.
      const now = Date.now();
      if (onMove._last && now - onMove._last < 80) return;
      onMove._last = now;
      window.H.macroPushEvent({ type: 'mouse_move', x: e.screenX, y: e.screenY });
      bump();
    };
    const onClick = (e) => {
      window.H.macroPushEvent({ type: 'mouse_click', x: e.screenX, y: e.screenY, button: e.button === 2 ? 'right' : 'left' });
      bump();
    };
    const onKey = (e) => {
      const k = e.key.length === 1 ? e.key : e.key.toLowerCase();
      window.H.macroPushEvent({ type: 'key', key: k });
      bump();
    };

    // Attach to window so events fire even outside the overlay
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);

    const cleanup = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    };

    wrap.querySelector('#macro-stop-btn').addEventListener('click', async () => {
      cleanup();
      const stop = await window.H.macroRecordStop();
      if (!stop || !stop.ok) {
        alert('Could not stop recording: ' + (stop?.error || 'unknown error'));
        return;
      }
      macrosRefresh();
      if (window.toast?.success) window.toast.success('Macro saved', stop.macro?.name || name);
    });
    wrap.querySelector('#macro-cancel-btn').addEventListener('click', async () => {
      cleanup();
      try { await window.H.macroRecordStop(); } catch (_) {}
      try {
        const r = await window.H.macroList();
        if (r?.macros?.some(m => m.name === name)) await window.H.macroDelete(name);
      } catch (_) {}
      macrosRefresh();
    });
  }

  async function macroPlay(name) {
    if (!confirm(`Replay "${name}"? Make sure the right window is focused.`)) return;
    const r = await window.H.macroPlay(name, { speed: 1.0, repeat: 1, dryRun: false });
    if (!r || !r.ok) {
      alert('Playback failed: ' + (r?.error || 'unknown'));
      return;
    }
    if (window.toast?.success) window.toast.success('Macro complete', `${r.fired?.length || 0} events`);
    macrosRefresh();
  }

  async function macroShow(name) {
    const r = await window.H.macroLoad(name);
    if (!r || !r.ok) { alert('Could not load macro: ' + (r?.error || 'unknown')); return; }
    const m = r.macro;
    const lines = m.events.map(ev => {
      let s = `+${ev.t}ms  ${ev.type}`;
      if (ev.x != null) s += ` (${ev.x},${ev.y})`;
      if (ev.text) s += ` "${ev.text.slice(0,40)}"`;
      if (ev.key) s += ` ${ev.key}`;
      return s;
    });
    alert(`${m.name} (v${m.version})\n${m.events.length} events / ${Math.round(m.duration/100)/10}s\n\n` + lines.slice(0, 30).join('\n') + (lines.length > 30 ? `\n...(+${lines.length - 30} more)` : ''));
  }

  async function macroDelete(name) {
    if (!confirm(`Delete macro "${name}"?`)) return;
    const r = await window.H.macroDelete(name);
    if (!r || !r.ok) { alert('Could not delete: ' + (r?.error || 'unknown')); return; }
    macrosRefresh();
  }

  function escapeHTML(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function escapeAttr(s) {
    return escapeHTML(s).replace(/"/g, '&quot;');
  }

  // Expose globals for the onclick handlers in chat.html
  window.macrosRefresh    = macrosRefresh;
  window.macroStartRecorder = macroStartRecorder;
  window.macroPlay        = macroPlay;
  window.macroShow        = macroShow;
  window.macroDelete      = macroDelete;
  window.refreshOcrStatus = refreshOcrStatus;

  // Auto-load when the Macros tab is opened
  const origTab = window.setSettingsTab;
  if (typeof origTab === 'function') {
    window.setSettingsTab = function patchedSetSettingsTab(name) {
      const out = origTab.apply(this, arguments);
      if (name === 'macros') { macrosRefresh(); refreshOcrStatus(); }
      return out;
    };
  }
})();
