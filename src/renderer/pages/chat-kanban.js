// Sprint 7C — Kanban panel for Settings → Agents.
//
// Renders the live durable-queue board the CLI's `horizon agents board`
// command shows, but as flex columns inside the chat UI. Polls every 2s
// via H.kanbanBoard() and listens for IPC push events on `kanban:event`
// so cards update the moment a worker emits a heartbeat / completion.
//
// State globals (var so cross-script visible):
//   kbBoardCache         — last board snapshot
//   kbPollTimer          — interval id for the 2s refresh
//   kbEventUnsub         — IPC listener teardown
//   kbActiveTask         — currently-expanded task id (for show panel)
//
// Public entry points (called from chat.html onclick or settings nav):
//   openKanban()         — show the panel + start polling
//   closeKanban()        — hide + stop polling
//   kbCancel(id)         — cancel a task
//   kbShow(id)           — expand task detail
//   kbPurge(days)        — wipe terminal-state rows
//
// Falls back gracefully when H.kanbanBoard isn't available (older
// preload, queue disabled).

var kbBoardCache = null;
var kbPollTimer = null;
var kbEventUnsub = null;
var kbActiveTask = null;

function kbEscHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function kbFmtAge(ms) {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60_000)     return Math.round(d / 1000) + 's ago';
  if (d < 3_600_000)  return Math.round(d / 60_000) + 'm ago';
  if (d < 86_400_000) return Math.round(d / 3_600_000) + 'h ago';
  return Math.round(d / 86_400_000) + 'd ago';
}

function kbFmtRunning(t) {
  if (!t || !t.startedAt) return '';
  return 'running ' + Math.round((Date.now() - t.startedAt) / 1000) + 's';
}

function kbTruncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function openKanban() {
  if (typeof setActiveSurface === 'function') {
    try { setActiveSurface('kanban', { keepPanels: ['kb-panel'] }); } catch (_) {}
  }
  let panel = document.getElementById('kb-panel');
  if (!panel) panel = kbEnsurePanel();
  panel.classList.add('show');
  await kbRefresh();
  if (!kbPollTimer) kbPollTimer = setInterval(kbRefresh, 2000);
  if (!kbEventUnsub && typeof H !== 'undefined' && typeof H.onKanbanEvent === 'function') {
    // Push-driven updates supplement the 2s poll — a finishing task
    // shows up immediately on the board without waiting for the tick.
    kbEventUnsub = H.onKanbanEvent(() => { kbRefresh(); });
  }
}

function closeKanban() {
  const panel = document.getElementById('kb-panel');
  if (panel) panel.classList.remove('show');
  if (kbPollTimer) { clearInterval(kbPollTimer); kbPollTimer = null; }
  if (kbEventUnsub) { try { kbEventUnsub(); } catch (_) {} kbEventUnsub = null; }
  if (typeof isSurfaceActive === 'function' && isSurfaceActive('kanban')) {
    try { closeActiveSurface(); } catch (_) {}
  }
}

function kbEnsurePanel() {
  // Defensive: if chat.html doesn't ship #kb-panel yet (older build),
  // inject one on demand so the IPC path still works without an HTML
  // change. Styled with inline CSS to avoid pulling another stylesheet.
  const panel = document.createElement('div');
  panel.id = 'kb-panel';
  panel.className = 'panel';
  panel.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(8,10,16,.9);z-index:9999;overflow:auto;padding:24px;';
  panel.innerHTML = `
    <div style="max-width:1200px;margin:0 auto;color:#e6e9f2;font-family:system-ui,sans-serif">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <h2 style="margin:0;font-size:20px">Horizon Kanban</h2>
        <span id="kb-stats-line" style="opacity:.7;font-size:13px"></span>
        <span style="flex:1"></span>
        <button onclick="kbPurge(7)" style="background:#1b1f2c;color:#fff;border:1px solid #2a3046;border-radius:6px;padding:6px 12px;cursor:pointer">Purge &gt; 7d</button>
        <button onclick="closeKanban()" style="background:transparent;color:#aaa;border:none;font-size:24px;cursor:pointer;padding:0 8px">×</button>
      </div>
      <div id="kb-cols" style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px"></div>
      <div id="kb-detail" style="margin-top:16px;display:none;padding:16px;background:#0e1119;border:1px solid #2a3046;border-radius:8px"></div>
    </div>
  `;
  document.body.appendChild(panel);
  // toggle .show → display block
  const style = document.createElement('style');
  style.textContent = '#kb-panel.show { display:block !important; }';
  document.head.appendChild(style);
  return panel;
}

async function kbRefresh() {
  if (typeof H === 'undefined' || typeof H.kanbanBoard !== 'function') {
    const cols = document.getElementById('kb-cols');
    if (cols) cols.innerHTML = '<div style="grid-column:1/-1;padding:24px;text-align:center;opacity:.7">Kanban queue unavailable on this build.</div>';
    return;
  }
  let r;
  try { r = await H.kanbanBoard({ limit: 12 }); }
  catch (e) { r = { ok: false, err: e.message }; }
  if (!r || !r.ok) {
    const cols = document.getElementById('kb-cols');
    if (cols) cols.innerHTML = `<div style="grid-column:1/-1;padding:24px;text-align:center;opacity:.7">${kbEscHtml(r?.err || 'queue unavailable')}</div>`;
    return;
  }
  kbBoardCache = r;
  kbRender();
}

function kbRender() {
  if (!kbBoardCache) return;
  const { stats, queued, running, done, failed } = kbBoardCache;
  const statsLine = document.getElementById('kb-stats-line');
  if (statsLine) {
    statsLine.textContent = `${stats.queued} queued · ${stats.running} running · ${stats.done} done · ${stats.failed} failed · ${stats.abandoned} abandoned`;
  }
  const cols = document.getElementById('kb-cols');
  if (!cols) return;
  cols.innerHTML = [
    kbRenderCol('Queued',    queued,  stats.queued,  '#5b8def'),
    kbRenderCol('Running',   running, stats.running, '#f0b35e'),
    kbRenderCol('Done',      done,    stats.done,    '#5dd078'),
    kbRenderCol('Failed',    failed,  stats.failed + stats.abandoned, '#e07070'),
  ].join('');
}

function kbRenderCol(title, tasks, count, colour) {
  const cards = (tasks || []).map(t => kbRenderCard(t, colour)).join('') ||
    '<div style="opacity:.4;font-size:12px;padding:8px">— empty —</div>';
  return `
    <div style="background:#0e1119;border:1px solid #1f2330;border-radius:8px;padding:10px;min-height:160px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <strong style="color:${colour};font-size:13px;text-transform:uppercase;letter-spacing:.5px">${kbEscHtml(title)}</strong>
        <span style="opacity:.5;font-size:12px">${count}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">${cards}</div>
    </div>
  `;
}

function kbRenderCard(t, colour) {
  const meta = t.status === 'running'
    ? kbFmtRunning(t)
    : t.completedAt ? kbFmtAge(t.completedAt)
    : t.status === 'queued' ? `prio ${t.priority}`
    : '';
  const canCancel = t.status === 'queued' || t.status === 'running';
  const cancelBtn = canCancel
    ? `<button onclick="event.stopPropagation();kbCancel('${kbEscHtml(t.id)}')" style="background:transparent;border:1px solid #3a3a3a;color:#aaa;border-radius:4px;font-size:11px;padding:2px 6px;cursor:pointer;margin-left:4px">cancel</button>`
    : '';
  return `
    <div onclick="kbShow('${kbEscHtml(t.id)}')" style="background:#161a25;border-left:3px solid ${colour};padding:8px 10px;border-radius:4px;cursor:pointer;font-size:13px;line-height:1.4">
      <div style="display:flex;align-items:center;gap:6px">
        <span style="flex:1;color:#dfe3ee">${kbEscHtml(kbTruncate(t.title, 38))}</span>
        ${cancelBtn}
      </div>
      <div style="opacity:.5;font-size:11px;margin-top:2px">${kbEscHtml(meta)}${t.attempts > 0 ? ` · ${t.attempts} retr${t.attempts === 1 ? 'y' : 'ies'}` : ''}</div>
    </div>
  `;
}

async function kbShow(id) {
  kbActiveTask = id;
  const detail = document.getElementById('kb-detail');
  if (!detail) return;
  detail.style.display = 'block';
  detail.innerHTML = '<div style="opacity:.6">loading…</div>';
  let r;
  try { r = await H.kanbanShow(id); }
  catch (e) { r = { ok: false, err: e.message }; }
  if (!r || !r.ok) { detail.innerHTML = `<div style="color:#e07070">${kbEscHtml(r?.err || 'error')}</div>`; return; }
  const t = r.task;
  detail.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <strong style="font-size:15px">${kbEscHtml(t.title)}</strong>
      <span style="opacity:.5;font-size:12px;font-family:monospace">${kbEscHtml(t.id)}</span>
      <span style="flex:1"></span>
      <button onclick="document.getElementById('kb-detail').style.display='none'" style="background:transparent;color:#888;border:none;cursor:pointer">close</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;font-size:13px">
      <div><span style="opacity:.6">status:</span> ${kbEscHtml(t.status)}</div>
      <div><span style="opacity:.6">priority:</span> ${t.priority}</div>
      <div><span style="opacity:.6">attempts:</span> ${t.attempts}</div>
      <div><span style="opacity:.6">created:</span> ${new Date(t.createdAt).toLocaleString()}</div>
      ${t.startedAt   ? `<div><span style="opacity:.6">started:</span> ${new Date(t.startedAt).toLocaleString()}</div>` : ''}
      ${t.completedAt ? `<div><span style="opacity:.6">done:</span> ${new Date(t.completedAt).toLocaleString()}</div>` : ''}
      ${t.workerId    ? `<div><span style="opacity:.6">worker:</span> ${kbEscHtml(t.workerId)}</div>` : ''}
      ${t.parentId    ? `<div><span style="opacity:.6">parent:</span> ${kbEscHtml(t.parentId)}</div>` : ''}
    </div>
    <div style="margin-top:12px">
      <div style="opacity:.6;font-size:12px;margin-bottom:4px">task:</div>
      <pre style="background:#0a0c12;padding:10px;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto;margin:0">${kbEscHtml(t.task)}</pre>
    </div>
    ${t.result ? `
      <div style="margin-top:12px">
        <div style="opacity:.6;font-size:12px;margin-bottom:4px">result:</div>
        <pre style="background:#0a0c12;padding:10px;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto;margin:0">${kbEscHtml(typeof t.result === 'string' ? t.result : JSON.stringify(t.result, null, 2))}</pre>
      </div>` : ''}
    ${t.error ? `
      <div style="margin-top:12px">
        <div style="color:#e07070;font-size:12px;margin-bottom:4px">error:</div>
        <pre style="background:#2a1418;padding:10px;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto;margin:0;color:#f0a0a0">${kbEscHtml(t.error)}</pre>
      </div>` : ''}
  `;
}

async function kbCancel(id) {
  if (typeof H === 'undefined' || typeof H.kanbanCancel !== 'function') return;
  try { await H.kanbanCancel(id); } catch (_) {}
  kbRefresh();
}

async function kbPurge(days) {
  if (typeof H === 'undefined' || typeof H.kanbanPurge !== 'function') return;
  try {
    const r = await H.kanbanPurge({ olderThanDays: Number(days) || 7 });
    if (typeof showToast === 'function' && r && r.ok) {
      showToast(`purged ${r.purged} task(s)`);
    }
  } catch (_) {}
  kbRefresh();
}

// Expose on window so HTML onclick handlers reach them. The Phase-2
// let/const → var rewrite normally handles this automatically, but
// being explicit makes the surface easier to grep for.
if (typeof window !== 'undefined') {
  window.openKanban  = openKanban;
  window.closeKanban = closeKanban;
  window.kbCancel    = kbCancel;
  window.kbShow      = kbShow;
  window.kbPurge     = kbPurge;
  window.kbRefresh   = kbRefresh;
}
