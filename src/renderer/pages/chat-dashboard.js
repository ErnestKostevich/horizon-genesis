// Hermes-style desktop dashboard view.
//
// Renders a calm, information-dense home screen with:
//   • Greeting + provider/model pill + status line
//   • Today card  — turns, cost, tools used, plans done + spark
//   • Recent chats card
//   • Active tasks card (kanban running/queued)
//   • Quick action tiles (new chat, run skill, marketplace, mobile)
//   • Live activity feed (last N tool calls)
//
// Data source: window.H.dashboard.* IPC channels (see preload.js).
// On open we run all four calls in parallel, then poll every 5s for
// the activity feed + active tasks so users see fresh state without a
// hard refresh.
//
// Public entry points (all on window):
//   openDashboard()     — show panel, run setActiveSurface('dashboard')
//   closeDashboard()    — hide panel, restore chat surface
//   dashRefresh()       — manual refresh (called by polling + hooks)
//   renderDashboard(el) — render into a specific container (used by
//                        the empty-state hero on a fresh app launch)

var dashPollTimer = null;
var dashCachedSummary = null;
var dashCachedFeed = null;
var dashOpening = false;

// Category mapping mirrors the TUI palette (web/exec/file/memory/comm).
// New tool names land in "other" until classified explicitly.
function _dashToolCategory(name) {
  const t = String(name || '').toLowerCase();
  if (/(web_search|browser|fetch|http|url|wikipedia)/.test(t)) return 'web';
  if (/(shell|exec|run_code|execute|terminal|bash|powershell)/.test(t)) return 'exec';
  if (/(read_file|write_file|edit|ws_|workspace|fs_|file)/.test(t)) return 'file';
  if (/(mem|remember|recall|fact|dialectic|note)/.test(t)) return 'memory';
  if (/(email|telegram|discord|slack|notify|send)/.test(t)) return 'comm';
  return 'other';
}

function _dashCatGlyph(cat) {
  switch (cat) {
    case 'web':    return '◇'; // diamond
    case 'exec':   return '▸'; // triangle
    case 'file':   return '▤'; // squared
    case 'memory': return '◎'; // bullseye
    case 'comm':   return '◦'; // small circle
    default:       return '·'; // mid dot
  }
}

function _dashEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _dashFmtRel(at) {
  if (!at) return '';
  const ms = Date.now() - new Date(at).getTime();
  if (Number.isNaN(ms)) return '';
  if (ms < 0) return 'just now';
  if (ms < 60_000)    return Math.max(1, Math.round(ms / 1000)) + 's ago';
  if (ms < 3_600_000) return Math.round(ms / 60_000) + 'm ago';
  if (ms < 86_400_000) return Math.round(ms / 3_600_000) + 'h ago';
  return Math.round(ms / 86_400_000) + 'd ago';
}

function _dashFmtDur(ms) {
  if (ms == null || Number.isNaN(ms)) return '';
  if (ms < 1000)   return ms + 'ms';
  if (ms < 60_000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60_000) + 'm';
}

function _dashFmtMoney(usd) {
  const n = Number(usd) || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 1)    return '$' + n.toFixed(3);
  return '$' + n.toFixed(2);
}

function _dashGreetingBase(date) {
  const d = date || new Date();
  const h = d.getHours();
  if (h >= 5 && h < 12)  return 'Good morning';
  if (h >= 12 && h < 18) return 'Good afternoon';
  if (h >= 18 && h < 22) return 'Good evening';
  return 'Working late';
}

function _dashEnsurePanel() {
  let panel = document.getElementById('dashboard-panel');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'dashboard-panel';
  panel.className = 'fpanel';
  panel.innerHTML = '<div class="dash-scroll" id="dashboard-root"><div class="dash-empty">Loading…</div></div>';
  document.body.appendChild(panel);
  return panel;
}

async function openDashboard() {
  if (dashOpening) return;
  dashOpening = true;
  try {
    const panel = _dashEnsurePanel();
    if (typeof setActiveSurface === 'function') {
      try { setActiveSurface('dashboard', { keepPanels: ['dashboard-panel'] }); } catch (_) {}
    }
    panel.classList.add('show');
    await dashRefresh();
    if (!dashPollTimer) {
      // Refresh activity feed + active tasks every 5s. Full summary
      // only every 30s — provider/model/persona rarely change.
      let tick = 0;
      dashPollTimer = setInterval(() => {
        tick++;
        if (tick % 6 === 0) dashRefresh();
        else dashRefreshLive();
      }, 5000);
    }
  } finally {
    dashOpening = false;
  }
}

function closeDashboard() {
  const panel = document.getElementById('dashboard-panel');
  if (panel) panel.classList.remove('show');
  if (dashPollTimer) { clearInterval(dashPollTimer); dashPollTimer = null; }
  if (typeof isSurfaceActive === 'function' && isSurfaceActive('dashboard')) {
    try { closeActiveSurface(); } catch (_) {}
  }
}

async function dashRefresh() {
  if (typeof window === 'undefined' || !window.H || !window.H.dashboard) {
    _dashRenderUnavailable();
    return;
  }
  const root = document.getElementById('dashboard-root');
  if (!root) return;
  try {
    const [summary, chatsR, tasksR, feedR] = await Promise.all([
      window.H.dashboard.summary().catch(() => null),
      window.H.dashboard.recentChats(5).catch(() => ({ ok: false })),
      window.H.dashboard.activeTasks(6).catch(() => ({ ok: false })),
      window.H.dashboard.activityFeed(10).catch(() => ({ ok: false })),
    ]);
    dashCachedSummary = summary;
    dashCachedFeed = feedR;
    renderDashboard(root, {
      summary,
      chats: chatsR && chatsR.ok ? chatsR.chats : [],
      tasks: tasksR && tasksR.ok ? tasksR : { queued: [], running: [] },
      feed:  feedR && feedR.ok ? feedR.items : [],
    });
  } catch (e) {
    root.innerHTML = `<div class="dash-empty">Could not load dashboard (${_dashEscape(e.message)}).</div>`;
  }
}

async function dashRefreshLive() {
  // Lightweight tick: re-fetch active tasks + activity feed only.
  if (typeof window === 'undefined' || !window.H || !window.H.dashboard) return;
  const root = document.getElementById('dashboard-root');
  if (!root) return;
  try {
    const [tasksR, feedR] = await Promise.all([
      window.H.dashboard.activeTasks(6).catch(() => ({ ok: false })),
      window.H.dashboard.activityFeed(10).catch(() => ({ ok: false })),
    ]);
    const activeNode = root.querySelector('[data-dash-slot="active"]');
    if (activeNode) activeNode.innerHTML = _dashRenderActive(tasksR && tasksR.ok ? tasksR : { queued: [], running: [] });
    const feedNode = root.querySelector('[data-dash-slot="feed"]');
    if (feedNode) feedNode.innerHTML = _dashRenderFeed(feedR && feedR.ok ? feedR.items : []);
  } catch (_) { /* poll best-effort */ }
}

function _dashRenderUnavailable() {
  const root = document.getElementById('dashboard-root');
  if (!root) return;
  root.innerHTML = `
    <div class="dash-hero">
      <h2>Dashboard not available</h2>
      <p>The desktop dashboard requires the Horizon AI shell to be running with IPC available.</p>
    </div>
  `;
}

function renderDashboard(root, data) {
  if (!root) return;
  data = data || {};
  const summary = data.summary || {};
  const chats   = Array.isArray(data.chats) ? data.chats : [];
  const tasks   = data.tasks || { queued: [], running: [] };
  const feed    = Array.isArray(data.feed) ? data.feed : [];

  // First-launch empty hero — nothing recorded yet at all.
  const isFreshInstall = !summary.chatCount && !summary.memoryCount
    && !chats.length && !feed.length && !tasks.running.length && !tasks.queued.length;

  if (isFreshInstall) {
    root.innerHTML = _dashRenderGreeting(summary) + _dashRenderHero();
    _dashBindGlobalHandlers(root);
    return;
  }

  root.innerHTML = `
    ${_dashRenderGreeting(summary)}
    <div class="dash-grid">
      <section class="dash-card dash-col-today" data-dash-slot="today">${_dashRenderToday(summary)}</section>
      <section class="dash-card dash-col-recent" data-dash-slot="recent">${_dashRenderRecent(chats)}</section>
      <section class="dash-card dash-col-active" data-dash-slot="active">${_dashRenderActive(tasks)}</section>
      <div class="dash-row-actions">
        <p class="dash-actions-head">Quick actions</p>
        <div class="dash-actions">
          ${_dashRenderActions()}
        </div>
      </div>
      <section class="dash-card dash-row-activity">
        <div class="dash-card-head">
          <p class="dash-card-title">Recent activity</p>
          <span class="dash-card-tag" id="dash-feed-tag">${feed.length ? feed.length + ' events' : ''}</span>
        </div>
        <div data-dash-slot="feed">${_dashRenderFeed(feed)}</div>
      </section>
    </div>
  `;
  _dashBindGlobalHandlers(root);
}

function _dashRenderGreeting(summary) {
  const base = _dashGreetingBase();
  const persona = (summary && summary.personaLabel) || (summary && summary.persona) || '';
  const userName = (typeof window !== 'undefined' && window.userName) || '';
  const titleSuffix = userName ? ', ' + _dashEscape(userName) : (persona ? '' : '');
  const provider = summary && summary.provider ? String(summary.provider) : '';
  const model = summary && summary.model ? String(summary.model) : '';
  const modelText = provider ? (provider + (model ? ' · ' + model : '')) : 'no provider';

  const bits = [];
  if (summary && summary.chatCount != null) bits.push(summary.chatCount + ' chat' + (summary.chatCount === 1 ? '' : 's'));
  if (summary && summary.memoryCount)        bits.push(summary.memoryCount + ' memories');
  if (summary && summary.skillCount)         bits.push(summary.skillCount + ' skills');
  if (summary && summary.channelCount)       bits.push(summary.channelCount + ' channel' + (summary.channelCount === 1 ? '' : 's'));
  const sub = bits.length ? bits.join(' · ') : 'Set up your providers in Settings to get started.';

  return `
    <header class="dash-greet">
      <div class="dash-greet-l">
        <h1 class="dash-greet-title">${_dashEscape(base)}${titleSuffix}.</h1>
        <p class="dash-greet-sub">${_dashEscape(sub)}</p>
      </div>
      <div class="dash-greet-r">
        <button class="dash-model-pill" data-dash-action="model" title="Switch provider or model">
          <span class="dash-pill-tick"></span>
          <span>${_dashEscape(modelText)}</span>
        </button>
      </div>
    </header>
  `;
}

function _dashRenderHero() {
  return `
    <div class="dash-grid">
      <div class="dash-hero">
        <h2>Welcome to Horizon.</h2>
        <p>This is your home screen. Start a chat, run a skill, or browse the marketplace to populate the dashboard. Recent activity and active tasks will appear here automatically.</p>
        <div class="dash-hero-actions">
          <button class="dash-action" data-dash-action="newChat">
            <span class="dash-action-icon"><svg class="licon"><use href="#i-message"/></svg></span>
            <span class="dash-action-body"><span>New chat</span><span class="dash-action-sub">Open a fresh conversation</span></span>
          </button>
          <button class="dash-action" data-dash-action="skills">
            <span class="dash-action-icon"><svg class="licon"><use href="#i-book"/></svg></span>
            <span class="dash-action-body"><span>Browse skills</span><span class="dash-action-sub">Install or run a skill</span></span>
          </button>
          <button class="dash-action" data-dash-action="marketplace">
            <span class="dash-action-icon"><svg class="licon"><use href="#i-store"/></svg></span>
            <span class="dash-action-body"><span>Marketplace</span><span class="dash-action-sub">Plugins + workflows</span></span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function _dashRenderToday(summary) {
  const t = (summary && summary.todayStats) || {};
  const stats = [
    { v: (t.turns || 0).toString(), l: 'turns' },
    { v: _dashFmtMoney(t.costUsd), l: 'spent' },
    { v: (t.toolsUsed || 0).toString(), l: 'tools used' },
    { v: (t.tasksDone || 0).toString(), l: 'plans done' },
  ];
  const tokens = t.totalTokens || 0;
  const tokenTag = tokens ? (tokens >= 1000 ? (Math.round(tokens / 100) / 10).toFixed(1) + 'k tok' : tokens + ' tok') : '';
  // Sparkline derived from the four stats so users see *something* —
  // every bar is normalized to the largest stat. When all stats are 0
  // we draw a flat baseline, which still reads better than empty space.
  const max = Math.max(1, ...stats.map(s => parseFloat(s.v.replace(/[^0-9.]/g, '')) || 0));
  const bars = stats.map((s, i) => {
    const n = parseFloat(s.v.replace(/[^0-9.]/g, '')) || 0;
    const pct = Math.max(8, Math.round((n / max) * 100));
    const peak = (n / max) === 1 && n > 0 ? ' peak' : '';
    return `<span class="dash-spark-bar${peak}" style="height:${pct}%" data-i="${i}"></span>`;
  }).join('');
  return `
    <div class="dash-card-head">
      <p class="dash-card-title">Today</p>
      <span class="dash-card-tag">${_dashEscape(tokenTag)}</span>
    </div>
    <div class="dash-stats">
      ${stats.map(s => `
        <div class="dash-stat"><span class="dash-stat-v">${_dashEscape(s.v)}</span><span class="dash-stat-l">${_dashEscape(s.l)}</span></div>
      `).join('')}
    </div>
    <div class="dash-spark" aria-hidden="true">${bars}</div>
  `;
}

function _dashRenderRecent(chats) {
  if (!chats || !chats.length) {
    return `
      <div class="dash-card-head"><p class="dash-card-title">Recent</p></div>
      <div class="dash-empty">No chats yet. Start one with <strong>New chat</strong>.</div>
    `;
  }
  const rows = chats.slice(0, 5).map(c => `
    <div class="dash-list-row" data-dash-action="openChat" data-chat-id="${_dashEscape(c.id)}" title="${_dashEscape(c.snippet || c.title)}">
      <span class="dash-list-dot"></span>
      <div class="dash-list-body">
        <div class="dash-list-title">${_dashEscape(c.title || 'Untitled chat')}</div>
        <div class="dash-list-meta">${_dashEscape(_dashFmtRel(c.updatedAt))}${c.messageCount ? ' · ' + c.messageCount + ' msg' : ''}</div>
      </div>
    </div>
  `).join('');
  return `
    <div class="dash-card-head">
      <p class="dash-card-title">Recent</p>
      <span class="dash-card-tag">${chats.length} chat${chats.length === 1 ? '' : 's'}</span>
    </div>
    <div class="dash-list">${rows}</div>
  `;
}

function _dashRenderActive(tasks) {
  const queued  = (tasks && tasks.queued)  || [];
  const running = (tasks && tasks.running) || [];
  const all = running.concat(queued).slice(0, 5);
  if (!all.length) {
    return `
      <div class="dash-card-head">
        <p class="dash-card-title">Active</p>
        <span class="dash-card-tag" data-dash-action="openKanban" style="cursor:pointer">Open board</span>
      </div>
      <div class="dash-empty">No active tasks. The dashboard updates when subagents are running.</div>
    `;
  }
  const stats = tasks && tasks.stats;
  const tag = stats ? `${stats.running || 0} running · ${stats.queued || 0} queued` : '';
  const rows = all.map(t => {
    const state = (t.status || 'queued').toLowerCase();
    const time = state === 'running'
      ? (t.startedAt ? Math.round((Date.now() - new Date(t.startedAt).getTime()) / 1000) + 's' : '')
      : (t.createdAt ? _dashFmtRel(t.createdAt) : '');
    return `
      <div class="dash-task" data-dash-action="openKanban" data-task-id="${_dashEscape(t.id)}">
        <span class="dash-task-state ${_dashEscape(state)}">${_dashEscape(state)}</span>
        <span class="dash-task-title">${_dashEscape(t.title || t.task || 'Untitled task')}</span>
        <span class="dash-task-time">${_dashEscape(time)}</span>
      </div>
    `;
  }).join('');
  return `
    <div class="dash-card-head">
      <p class="dash-card-title">Active</p>
      <span class="dash-card-tag">${_dashEscape(tag)}</span>
    </div>
    <div>${rows}</div>
  `;
}

function _dashRenderActions() {
  const tiles = [
    { id: 'newChat',     icon: 'i-message',  title: 'New chat',         sub: 'Fresh conversation' },
    { id: 'skills',      icon: 'i-book',     title: 'Run skill',        sub: 'Open skill picker' },
    { id: 'marketplace', icon: 'i-store',    title: 'Marketplace',      sub: 'Plugins & workflows' },
    { id: 'mobile',      icon: 'i-smartphone', title: 'Connect phone',  sub: 'Pair a mobile device' },
  ];
  return tiles.map(t => `
    <button class="dash-action" data-dash-action="${t.id}">
      <span class="dash-action-icon"><svg class="licon"><use href="#${t.icon}"/></svg></span>
      <span class="dash-action-body"><span>${_dashEscape(t.title)}</span><span class="dash-action-sub">${_dashEscape(t.sub)}</span></span>
    </button>
  `).join('');
}

function _dashRenderFeed(feed) {
  if (!feed || !feed.length) {
    return '<div class="dash-empty">No tool activity yet. Tool calls from agent runs appear here in real time.</div>';
  }
  return '<div class="dash-feed">' + feed.slice(0, 10).map(it => {
    const cat = _dashToolCategory(it.tool);
    const glyph = _dashCatGlyph(cat);
    const dur = it.durationMs != null ? _dashFmtDur(it.durationMs) : (it.status === 'running' ? '…' : '');
    return `
      <div class="dash-feed-row" data-cat="${cat}" data-dash-action="openRun" data-run-id="${_dashEscape(it.runId)}" title="${_dashEscape(it.summary || it.tool)}">
        <span class="dash-feed-glyph">${glyph}</span>
        <span class="dash-feed-tool">${_dashEscape(it.tool || 'tool')}</span>
        <span class="dash-feed-summary">${_dashEscape(it.summary || '')}</span>
        <span class="dash-feed-time">${_dashEscape(dur || _dashFmtRel(it.startedAt))}</span>
      </div>
    `;
  }).join('') + '</div>';
}

function _dashBindGlobalHandlers(root) {
  if (!root) return;
  if (root.__dashBound) return;
  root.__dashBound = true;
  root.addEventListener('click', (ev) => {
    const trigger = ev.target.closest('[data-dash-action]');
    if (!trigger) return;
    const action = trigger.getAttribute('data-dash-action');
    _dashHandleAction(action, trigger);
  });
}

function _dashHandleAction(action, el) {
  switch (action) {
    case 'newChat': {
      try { closeDashboard(); } catch (_) {}
      if (typeof createNewChat === 'function') createNewChat();
      else if (typeof showChatSurface === 'function') showChatSurface();
      break;
    }
    case 'openChat': {
      const id = el.getAttribute('data-chat-id');
      try { closeDashboard(); } catch (_) {}
      if (id && typeof switchToChat === 'function') {
        try { switchToChat(id); }
        catch (_) {
          if (typeof window.H?.chatSwitch === 'function') window.H.chatSwitch(id);
        }
      } else if (typeof showChatSurface === 'function') {
        showChatSurface();
      }
      break;
    }
    case 'skills': {
      try { closeDashboard(); } catch (_) {}
      if (typeof openSkillHub === 'function') openSkillHub();
      break;
    }
    case 'marketplace': {
      try { closeDashboard(); } catch (_) {}
      if (typeof openStore === 'function') openStore();
      break;
    }
    case 'mobile': {
      try { closeDashboard(); } catch (_) {}
      if (typeof openPanel === 'function') {
        try { openPanel(); if (typeof setSettingsTab === 'function') setSettingsTab('mobile'); }
        catch (_) {}
      } else if (typeof setSettingsTab === 'function') {
        try { setSettingsTab('mobile'); } catch (_) {}
      }
      break;
    }
    case 'model': {
      if (typeof openModelPicker === 'function') openModelPicker();
      else if (typeof showProviderBar === 'function') showProviderBar();
      break;
    }
    case 'openKanban': {
      try { closeDashboard(); } catch (_) {}
      if (typeof openKanban === 'function') openKanban();
      break;
    }
    case 'openRun': {
      const runId = el.getAttribute('data-run-id');
      try { closeDashboard(); } catch (_) {}
      if (typeof openInspector === 'function') {
        try { openInspector({ runId }); } catch (_) { openInspector(); }
      } else if (typeof toggleInspectorMode === 'function') {
        toggleInspectorMode();
      }
      break;
    }
    default: /* no-op */ break;
  }
}

// Maybe auto-open the dashboard on first load — only when no chat is
// currently active AND the user hasn't disabled the home screen via
// settingsStore. Hooked from chat.html bootCurrentChat() epilogue.
function maybeAutoOpenDashboard() {
  try {
    if (typeof currentChatId !== 'undefined' && currentChatId) return;
    if (localStorage.getItem('horizonDashboardDisabled') === '1') return;
    // Wait one tick so the chat surface DOM is ready underneath.
    setTimeout(() => {
      try { openDashboard(); } catch (_) {}
    }, 0);
  } catch (_) {}
}

if (typeof window !== 'undefined') {
  window.openDashboard       = openDashboard;
  window.closeDashboard      = closeDashboard;
  window.dashRefresh         = dashRefresh;
  window.renderDashboard     = renderDashboard;
  window.maybeAutoOpenDashboard = maybeAutoOpenDashboard;
}
