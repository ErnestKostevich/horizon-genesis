// PR-V Phase 3.16 — Inspector Pane + Step Rail.
// Extracted from chat.html inline <script> (was lines 5106-5398).
//
// Two coupled features bundled because they share agent-step
// listener wiring (H.onAgentStep) and both auto-refresh from the
// same event stream:
//
//   1. Inspector Pane — right-side dock with Context · Tools · Cost
//      · Log tabs. Layout helpers handle floating position so it
//      tracks viewport resizes and surface transitions.
//
//   2. Step Rail — pinned strip above messages showing the agent
//      plan progress (done / now-pulsing / pending steps).
//
// Both register a DOMContentLoaded handler to restore prior state.
//
// State:
//   inspectorActive, inspectorTab, stepRailState
// Inspector fns:
//   layoutInspectorDock, toggleInspectorMode, setInspectorTab,
//   refreshInspector, refreshInspectorConnections,
//   refreshInspectorTools, refreshInspectorCost, refreshInspectorLog,
//   formatTokens, formatCost
// Step Rail fns:
//   setStepRail, clearStepRail, renderStepRail
//
// Loaded as external script AFTER main inline so window.* globals it
// reads (H IPC, esc, sessionTokens, sessionHasEstimatedUsage, etc.)
// are defined.

// ═══════════════════════════════════════════════════════════════
// INSPECTOR PANE — Context · Tools · Cost · Log dock on the right
// ═══════════════════════════════════════════════════════════════
var inspectorActive = false;
var inspectorTab = 'context';

function layoutInspectorDock(){
  const pane = document.getElementById('inspector-pane');
  if (!pane) return;
  const root = document.documentElement;
  const sidebar = document.body.classList.contains('with-sidebar')
    ? (document.querySelector('.chatside')?.getBoundingClientRect().width || 280)
    : 0;
  const bottomOf = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    if (r.height <= 0) return 0;
    return r.bottom;
  };
  const chromeBottom = Math.max(
    bottomOf('.tb'),
    bottomOf('.wake-bar.show'),
    bottomOf('.sb'),
    bottomOf('.modes'),
    bottomOf('.chat-status-bar')
  );
  const inputRect = document.querySelector('.inp-wrap')?.getBoundingClientRect();
  const contentWidth = Math.max(0, window.innerWidth - sidebar);
  const compact = contentWidth < 1010;
  const dockW = compact
    ? Math.max(302, Math.min(358, contentWidth - 28))
    : Math.max(320, Math.min(356, Math.round(contentWidth * 0.255)));
  let top = Math.max(86, Math.ceil(chromeBottom + 12));
  // On wide screens the inspector is a true right dock and should own the
  // whole right edge down to the bottom. If it stops above the composer, the
  // composer correctly reserves inspector-space but leaves a dead square on
  // the lower-right. Compact/mobile keeps the old above-composer behavior.
  let bottom = compact
    ? Math.max(14, Math.ceil(window.innerHeight - (inputRect?.top || (window.innerHeight - 92)) + 12))
    : 16;
  const minDockH = Math.min(430, Math.max(300, window.innerHeight * 0.48));
  if (window.innerHeight - top - bottom < minDockH) {
    bottom = Math.max(14, Math.ceil(window.innerHeight - top - minDockH));
  }
  root.style.setProperty('--inspector-w', `${dockW}px`);
  root.style.setProperty('--inspector-right', compact ? '12px' : '16px');
  root.style.setProperty('--inspector-top', `${top}px`);
  root.style.setProperty('--inspector-bottom', `${bottom}px`);
  root.style.setProperty('--inspector-space', compact ? '0px' : `${dockW + 34}px`);
  document.body.classList.toggle('inspector-compact', compact);
}

function toggleInspectorMode(){
  inspectorActive = !inspectorActive;
  if (inspectorActive) layoutInspectorDock();
  document.body.classList.toggle('inspector-active', inspectorActive);
  document.getElementById('inspector-mode-btn')?.classList.toggle('proc', inspectorActive);
  if (inspectorActive) {
    layoutInspectorDock();
    refreshInspector();
    try { H.set('inspectorActive', true); } catch(_){}
  } else {
    document.body.classList.remove('inspector-compact');
    try { H.set('inspectorActive', false); } catch(_){}
  }
  updateShellChrome();
}

function setInspectorTab(name){
  inspectorTab = name;
  document.querySelectorAll('.insp-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  ['context','tools','cost','log'].forEach(t => {
    const el = document.getElementById('insp-body-' + t);
    if (el) el.style.display = (t === name) ? 'block' : 'none';
  });
  refreshInspector();
}

// Refresh whichever tab is active. Cheap on every call — only updates DOM
// for the visible tab + the always-visible context bits (provider/model
// pill, persona).
function refreshInspector(){
  if (!inspectorActive) return;
  layoutInspectorDock();
  // Context is cheap, always update.
  try {
    const p = prov || provider || 'gemini';
    const m = getSelectedModelForProvider?.(p) || (p === 'gemini' ? geminiModel : '') || 'default';
    document.getElementById('insp-provider').textContent = p;
    document.getElementById('insp-model').textContent = m;
    document.getElementById('insp-mode').textContent = mode || 'chat';
    document.getElementById('insp-persona').textContent = currentPersona || 'Default';
    document.getElementById('insp-workspace').textContent = codeWorkspace || 'No workspace';
    document.getElementById('insp-open-files').textContent = (codeOpenFiles?.length || 0).toString();
    document.getElementById('insp-voice').textContent = voiceProvider || '—';
  } catch(_) {}

  if (inspectorTab === 'tools') refreshInspectorTools();
  if (inspectorTab === 'cost')  refreshInspectorCost();
  if (inspectorTab === 'log')   refreshInspectorLog();
  // Connections row updates lazily
  refreshInspectorConnections();
}

async function refreshInspectorConnections(){
  try {
    const r = await H.mcpServersList?.().catch(()=>({ok:false,servers:[]}));
    const enabled = (r?.servers || []).filter(s => s.enabled !== false).length;
    const total = (r?.servers || []).length;
    const el = document.getElementById('insp-mcp');
    if (el) el.textContent = total ? `${enabled} / ${total} enabled` : '0';
  } catch(_) {}
}

function refreshInspectorTools(){
  // Built-in tools from agent.js TOOL_DEFINITIONS — we don't have a live
  // listing IPC, so describe the static set + any MCP discovered tools.
  const builtin = [
    { name: 'fs.read_file',  scope: codeWorkspace ? 'workspace' : 'no workspace' },
    { name: 'fs.write_file', scope: 'permission required' },
    { name: 'fs.search',     scope: codeWorkspace ? 'workspace' : 'no workspace' },
    { name: 'shell.exec',    scope: 'permission required' },
    { name: 'web.search',    scope: 'tavily key' },
    { name: 'ai.edit',       scope: (prov || provider) + ' model' },
  ];
  const host = document.getElementById('insp-tools-builtin');
  if (host) {
    host.innerHTML = builtin.map(t =>
      `<div class="insp-row"><span class="v" style="text-align:left;color:var(--tx)">${esc(t.name)}</span><span class="k">${esc(t.scope)}</span></div>`
    ).join('');
  }
  // MCP tools list — async
  H.mcpServersList?.().then(r => {
    const servers = r?.servers || [];
    const mcpHost = document.getElementById('insp-tools-mcp');
    if (!mcpHost) return;
    if (!servers.length) {
      mcpHost.innerHTML = '<div class="insp-empty">No MCP servers connected.</div>';
      return;
    }
    mcpHost.innerHTML = servers.map(s => {
      const status = s.enabled === false ? 'disabled' : (s.connected ? 'connected' : 'idle');
      const tools = s.tools?.length || 0;
      return `<div class="insp-row"><span class="v" style="text-align:left;color:var(--tx)">${esc(s.name)}</span><span class="k">${tools} tool${tools===1?'':'s'} · ${status}</span></div>`;
    }).join('');
  }).catch(()=>{});
}

function refreshInspectorCost(){
  // Pull live values from the existing token tracker.
  const headline = document.getElementById('insp-cost-headline');
  const sub = document.getElementById('insp-cost-sub');
  if (headline) headline.textContent = formatCost();
  if (sub) {
    const source = sessionUsageKnown
      ? (sessionHasEstimatedUsage ? 'provider + estimated usage' : 'provider usage')
      : (sessionTokens ? 'estimated usage' : 'estimates start after the first message');
    sub.textContent = `${sessionMsgs} msg${sessionMsgs===1?'':'s'} - ${formatTokens(sessionTokens)} tokens - ${source}`;
  }

  // Token budget visualisation. We don't have per-segment counters; estimate
  // splits as 7% system, 83% history, 8% files, 2% tools (a rough pattern
  // that matches typical chat sessions). Real per-segment tracking is a
  // follow-up. This gets the bar visible and updating as tokens grow.
  const total = sessionTokens || 0;
  const budget = 200000;
  const segs = {
    system:  Math.round(total * 0.07),
    history: Math.round(total * 0.83),
    files:   Math.round(total * 0.08),
    tools:   Math.round(total * 0.02),
  };
  const totalUsed = Math.min(total, budget);
  const bar = document.getElementById('insp-token-bar');
  if (bar) {
    const w = (n) => budget > 0 ? `${(n / budget * 100).toFixed(2)}%` : '0%';
    bar.querySelector('.token-seg.system' ).style.width = w(segs.system);
    bar.querySelector('.token-seg.history').style.width = w(segs.history);
    bar.querySelector('.token-seg.files'  ).style.width = w(segs.files);
    bar.querySelector('.token-seg.tools'  ).style.width = w(segs.tools);
  }
  const meta = document.getElementById('insp-token-meta');
  if (meta) {
    const approx = sessionTokens ? '~' : '';
    meta.innerHTML = `
      <span class="seg system" title="Approximate split until provider exposes per-part usage">System ${approx}${formatTokens(segs.system)}</span>
      <span class="seg history" title="Approximate split until provider exposes per-part usage">History ${approx}${formatTokens(segs.history)}</span>
      <span class="seg files" title="Approximate split until provider exposes per-part usage">Files ${approx}${formatTokens(segs.files)}</span>
      <span class="seg tools" title="Approximate split until provider exposes per-part usage">Tools ${approx}${formatTokens(segs.tools)}</span>`;
  }
  document.getElementById('insp-token-used').textContent = formatTokens(totalUsed);
  document.getElementById('insp-token-budget').textContent = formatTokens(budget);
}

function refreshInspectorLog(){
  const host = document.getElementById('insp-log-list');
  if (!host) return;
  const lines = (operatorLogLines || []).slice(-30).reverse();
  if (!lines.length) {
    host.innerHTML = '<div class="insp-empty">No agent activity yet.</div>';
    return;
  }
  host.innerHTML = lines.map(l =>
    `<div class="insp-log-row ${esc(l.type||'info')}"><span class="ts">${esc(l.time||'')}</span><span class="msg">${esc(l.msg||'')}</span><span class="dur"></span></div>`
  ).join('');
}

function formatTokens(n){
  if (!n) return '0';
  if (n >= 1000) return (n/1000).toFixed(1) + 'k';
  return String(n);
}
function formatCost(){
  // No hardcoded dollars. Show token usage only because each BYOK provider can
  // bill differently and local models may not report provider usage at all.
  return (sessionUsageKnown && sessionTokens > 0) ? (formatTokens(sessionTokens) + ' tok') : 'Usage unavailable';
}

// Honest cost tab: no fabricated budget split. Provider-reported usage only.
refreshInspectorCost = function(){
  const headline = document.getElementById('insp-cost-headline');
  const sub = document.getElementById('insp-cost-sub');
  const hasUsage = !!(sessionUsageKnown && sessionTokens > 0);
  if (headline) headline.textContent = hasUsage ? `${formatTokens(sessionTokens)} tok` : 'Usage unavailable';
  if (sub) {
    sub.textContent = hasUsage
      ? `${sessionMsgs} msg${sessionMsgs===1?'':'s'} - provider-reported usage`
      : `${sessionMsgs} msg${sessionMsgs===1?'':'s'} - provider did not return usage`;
  }
  const bar = document.getElementById('insp-token-bar');
  if (bar) {
    bar.querySelectorAll('.token-seg').forEach(seg => { seg.style.width = '0%'; });
  }
  const meta = document.getElementById('insp-token-meta');
  if (meta) {
    meta.innerHTML = hasUsage
      ? '<span class="seg history" title="Provider total usage">Provider total</span>'
      : '<span class="seg history" title="No provider usage in this chat yet">Usage unavailable</span>';
  }
  const used = document.getElementById('insp-token-used');
  if (used) used.textContent = hasUsage ? formatTokens(sessionTokens) : '0';
  const budget = document.getElementById('insp-token-budget');
  if (budget) budget.textContent = 'provider';
};

window.addEventListener('resize', () => {
  if (inspectorActive) layoutInspectorDock();
});

// ═══════════════════════════════════════════════════════════════
// STEP RAIL — agent plan progress at top of chat
// ═══════════════════════════════════════════════════════════════
var stepRailState = { steps: [], currentIdx: -1 };

function setStepRail(steps, currentIdx){
  stepRailState.steps = Array.isArray(steps) ? steps.slice(0, 7) : [];
  stepRailState.currentIdx = (typeof currentIdx === 'number') ? currentIdx : -1;
  renderStepRail();
}

function clearStepRail(){
  stepRailState = { steps: [], currentIdx: -1 };
  const rail = document.getElementById('step-rail');
  if (rail) {
    rail.classList.remove('show');
    rail.innerHTML = '';
  }
}

function renderStepRail(){
  const rail = document.getElementById('step-rail');
  if (!rail) return;
  const steps = stepRailState.steps;
  if (!steps.length) {
    rail.classList.remove('show');
    return;
  }
  rail.classList.add('show');
  const cur = stepRailState.currentIdx;
  const html = steps.map((s, i) => {
    const status = (i < cur) ? 'done' : (i === cur ? 'now' : '');
    const num = (i < cur) ? '✓' : String(i + 1);
    return `<div class="step ${status}"><span class="num">${num}</span><span>${esc(s)}</span></div>`;
  }).join('<span class="step-arrow">→</span>');
  rail.innerHTML = html;
}

// Auto-update Inspector and Step Rail from agent step events. Hooks into
// the existing operator-side onAgentStep listener via a soft tap so we
// don't fight Operator Mode's own subscriber.
try {
  H.onAgentStep?.((step) => {
    try {
      // Step rail — server sends {type:'plan', steps:[...], currentIdx}
      if (step?.type === 'plan' && Array.isArray(step.steps)) {
        setStepRail(step.steps, step.currentIdx ?? 0);
      }
      if (step?.type === 'plan-step' && typeof step.idx === 'number') {
        setStepRail(stepRailState.steps, step.idx);
      }
      if (step?.type === 'run-end' || step?.type === 'done') {
        // Fade rail after a beat so the user sees the final ✓ state
        setTimeout(clearStepRail, 1500);
      }
      // Inspector log + cost auto-refresh on activity
      if (inspectorActive) {
        if (inspectorTab === 'log')  refreshInspectorLog();
        if (inspectorTab === 'cost') refreshInspectorCost();
      }
    } catch(_) {}
  });
} catch(_) {}

// Restore inspector state on load
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const wasActive = await H.get('inspectorActive').catch(()=>null);
    if (wasActive) toggleInspectorMode();
  } catch(_) {}
});

