// Live Canvas renderer surface — Phase 26 MVP.
//
// A floating panel users open via /canvas slash command (or
// window.openCanvas()). Contains:
//   - Top bar:    title · version · last edit timestamp · close
//   - Body:       <textarea> bound bidirectionally to canvasManager
//   - Bottom bar: action chips (clear, copy, export .md) + edit-log peek
//
// Behaviour:
//   - On mount, fetches current content via H.canvasGet
//   - User keystrokes → debounced 300ms → H.canvasSet
//   - Main broadcasts canvas:changed when either side writes →
//     renderer applies (skipping our own echo to avoid cursor jumps)
//   - Agent writes flash the panel border briefly so user notices
//
// Wired in chat.html via a single inline script tag that loads this
// file. Idempotent — calling openCanvas() multiple times reuses the
// existing panel.

(function () {
  'use strict';

  // Module-level state — survives multiple openCanvas() calls so the
  // user's scroll position and selection aren't reset on reopen.
  let panelEl = null;
  let textareaEl = null;
  let metaEl = null;
  let logEl = null;
  let unsubscribe = null;
  let saveTimer = null;
  let lastLocalVersion = 0;     // version we last applied/sent
  let suppressBroadcast = false; // skip applying our own echo back
  let flashTimer = null;

  function esc(s) {
    return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function ensurePanel() {
    if (panelEl) return panelEl;

    panelEl = document.createElement('div');
    panelEl.id = 'live-canvas-panel';
    panelEl.className = 'live-canvas-panel';
    panelEl.style.cssText = `
      position: fixed; right: 16px; bottom: 16px;
      width: min(640px, calc(100vw - 32px));
      height: min(540px, calc(100vh - 100px));
      background: linear-gradient(180deg, rgba(8, 11, 18, 0.96), rgba(8, 11, 18, 0.99));
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      box-shadow: 0 24px 48px -16px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(139, 92, 246, 0.08) inset;
      z-index: 2400;
      display: flex; flex-direction: column;
      backdrop-filter: blur(14px);
      transition: border-color 0.25s, box-shadow 0.25s;
    `;

    panelEl.innerHTML = `
      <div class="lc-bar" style="
        display: flex; align-items: center; gap: 10px;
        padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.06);
        font-family: 'JetBrains Mono', monospace; font-size: 10.5px;
        text-transform: uppercase; letter-spacing: 0.18em;
        color: var(--t2, #9aa0a6);
      ">
        <span style="display:flex;align-items:center;gap:6px">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:linear-gradient(135deg,#06b6d4,#8b5cf6);"></span>
          Live canvas
        </span>
        <span class="lc-meta" style="margin-left:auto;color:var(--t3,#7a808a);font-size:9.5px"></span>
        <button class="lc-close" title="Close (Esc)" style="
          background:transparent;border:0;color:var(--t2,#9aa0a6);font-size:18px;line-height:1;
          width:24px;height:24px;display:flex;align-items:center;justify-content:center;
          border-radius:6px;cursor:pointer;
        ">×</button>
      </div>

      <textarea class="lc-text" placeholder="Empty canvas. Either you or the agent can write here." style="
        flex:1; min-height:0; resize:none;
        background: rgba(0,0,0,0.25);
        border: 0; outline: 0;
        padding: 16px 18px;
        color: var(--tx, #f9fafb);
        font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
        font-size: 13px; line-height: 1.55;
        tab-size: 2;
      "></textarea>

      <div class="lc-foot" style="
        display:flex; align-items:center; gap:8px; flex-wrap:wrap;
        padding: 8px 12px;
        border-top: 1px solid rgba(255,255,255,0.06);
      ">
        <button class="lc-clear" title="Wipe the canvas" style="
          background:transparent;border:1px solid rgba(255,255,255,0.10);
          color:var(--t2,#9aa0a6);padding:4px 10px;border-radius:6px;cursor:pointer;
          font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.18em;
        ">clear</button>
        <button class="lc-copy" title="Copy contents to clipboard" style="
          background:transparent;border:1px solid rgba(255,255,255,0.10);
          color:var(--t2,#9aa0a6);padding:4px 10px;border-radius:6px;cursor:pointer;
          font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.18em;
        ">copy</button>
        <button class="lc-export" title="Download as .md" style="
          background:transparent;border:1px solid rgba(255,255,255,0.10);
          color:var(--t2,#9aa0a6);padding:4px 10px;border-radius:6px;cursor:pointer;
          font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.18em;
        ">export .md</button>
        <span class="lc-log" style="
          margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:9px;
          color:var(--t3,#7a808a);max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        "></span>
      </div>
    `;

    document.body.appendChild(panelEl);

    textareaEl = panelEl.querySelector('.lc-text');
    metaEl = panelEl.querySelector('.lc-meta');
    logEl = panelEl.querySelector('.lc-log');

    panelEl.querySelector('.lc-close').addEventListener('click', closeCanvas);
    panelEl.querySelector('.lc-clear').addEventListener('click', async () => {
      if (!window.confirm('Wipe the canvas? Both user and agent edits go.')) return;
      try {
        await window.H?.canvasClear?.();
      } catch (_) {}
    });
    panelEl.querySelector('.lc-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(textareaEl.value);
        flashCopied(panelEl.querySelector('.lc-copy'));
      } catch (_) {}
    });
    panelEl.querySelector('.lc-export').addEventListener('click', () => {
      const blob = new Blob([textareaEl.value], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `horizon-canvas-${Date.now()}.md`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    });

    textareaEl.addEventListener('input', onUserInput);
    panelEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.activeElement !== textareaEl) closeCanvas();
    });

    return panelEl;
  }

  function flashCopied(btn) {
    const orig = btn.textContent;
    btn.textContent = 'copied ✓';
    btn.style.color = '#10b981';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1200);
  }

  function flashAgentWrite() {
    if (!panelEl) return;
    panelEl.style.borderColor = 'rgba(139, 92, 246, 0.65)';
    panelEl.style.boxShadow = '0 24px 48px -16px rgba(0,0,0,0.6), 0 0 0 2px rgba(139, 92, 246, 0.25) inset';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      panelEl.style.borderColor = 'rgba(255, 255, 255, 0.08)';
      panelEl.style.boxShadow = '0 24px 48px -16px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(139, 92, 246, 0.08) inset';
    }, 800);
  }

  function applySnapshot(snap, opts = {}) {
    if (!snap) return;
    if (textareaEl && snap.content !== textareaEl.value) {
      // Preserve caret position when an external write lands while
      // the user is typing.
      const caret = textareaEl.selectionStart;
      const len = textareaEl.value.length;
      const atEnd = caret === len;
      textareaEl.value = snap.content || '';
      if (!atEnd) textareaEl.selectionStart = textareaEl.selectionEnd = Math.min(caret, textareaEl.value.length);
    }
    lastLocalVersion = snap.version || 0;
    if (metaEl) {
      const when = snap.updatedAt ? new Date(snap.updatedAt).toLocaleTimeString() : 'never';
      metaEl.textContent = `v${snap.version} · ${when}`;
    }
    if (logEl && Array.isArray(snap.editLogTail) && snap.editLogTail.length) {
      const last = snap.editLogTail[snap.editLogTail.length - 1];
      logEl.textContent = `${esc(last.source)} · ${esc(last.mode)} · +${last.bytesIn || 0} B`;
    }
    if (opts.fromAgent) flashAgentWrite();
  }

  function onUserInput() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        suppressBroadcast = true;
        const snap = await window.H?.canvasSet?.(textareaEl.value);
        if (snap?.version) lastLocalVersion = snap.version;
      } catch (_) {}
      finally { suppressBroadcast = false; }
    }, 300);
  }

  async function openCanvas() {
    ensurePanel();
    panelEl.style.display = 'flex';
    try {
      const snap = await window.H?.canvasGet?.();
      applySnapshot(snap);
    } catch (_) {}
    if (!unsubscribe && window.H?.onCanvasChanged) {
      unsubscribe = window.H.onCanvasChanged((snap) => {
        if (suppressBroadcast) { lastLocalVersion = snap.version; return; }
        const last = snap?.editLogTail?.[snap.editLogTail.length - 1];
        const fromAgent = last?.source === 'agent';
        applySnapshot(snap, { fromAgent });
      });
    }
    // Focus the text after mount so the user can start typing right away.
    setTimeout(() => { try { textareaEl.focus(); } catch (_) {} }, 60);
  }

  function closeCanvas() {
    if (panelEl) panelEl.style.display = 'none';
  }

  // Expose globals so slash command + IPC + window.* callers can reach it.
  window.openCanvas = openCanvas;
  window.closeCanvas = closeCanvas;
  window.toggleCanvas = () => {
    if (!panelEl || panelEl.style.display === 'none') openCanvas();
    else closeCanvas();
  };
})();
