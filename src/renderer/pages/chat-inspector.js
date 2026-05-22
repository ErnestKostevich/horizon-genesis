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
  ['context','tools','skills','subagents','learned','cost','log'].forEach(t => {
    const el = document.getElementById('insp-body-' + t);
    if (el) el.style.display = (t === name) ? 'block' : 'none';
  });
  refreshInspector();
}

// Last 'skills-selected' step we saw from main process. Populated by the
// onAgentStep tap at the bottom of this file. The Skills inspector tab
// reads this on every refresh, so even if the user opens Inspector after
// the turn ran they still see what loaded.
var lastSkillsSelected = null;

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

  if (inspectorTab === 'tools')     refreshInspectorTools();
  if (inspectorTab === 'skills')    refreshInspectorSkills();
  if (inspectorTab === 'subagents') refreshInspectorSubagents();
  if (inspectorTab === 'learned')   refreshInspectorLearned();
  if (inspectorTab === 'cost')      refreshInspectorCost();
  if (inspectorTab === 'log')       refreshInspectorLog();
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
  //
  // Phase 25 fix — budget was hardcoded 200000. Now reads model context
  // window from settings (`token.budget` override or `model.contextWindow`
  // from the active provider's model card). Falls back to 200k for safety
  // when nothing is configured.
  const total = sessionTokens || 0;
  let budget = 200000;
  try {
    const override = Number(window.localStorage?.getItem?.('horizon.tokenBudget'));
    if (Number.isFinite(override) && override > 0) budget = override;
    else if (window._activeModelContext && window._activeModelContext > 0) budget = window._activeModelContext;
  } catch (_) {}
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
//
// PHASE 28 — the previous version zeroed every bar segment so the user
// saw "238 tok used" next to a completely empty bar. The bar now fills
// with a single "Provider total" segment at 100% when usage exists, and
// goes grey/empty only when there's genuinely nothing to show.
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
    // Reset every segment first.
    bar.querySelectorAll('.token-seg').forEach(seg => { seg.style.width = '0%'; });
    // Then fill the "history" segment (the visual default segment that's
    // already styled in chat-base.css) to 100% when we have real usage.
    // Falls back to a 4% grey sliver so the bar isn't completely invisible.
    const histSeg = bar.querySelector('.token-seg.history')
      || bar.querySelector('.token-seg');
    if (histSeg) {
      histSeg.style.width = hasUsage ? '100%' : '4%';
      histSeg.style.opacity = hasUsage ? '1' : '0.35';
    }
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

// Sprint-2.9.1 — normalize plan steps to strings. Some models (Codestral,
// Mistral coders) return steps as objects like {title:'…', reason:'…'}
// or {step:'…', tool:'…'} instead of plain strings. Without normalization
// the step rail rendered "[object Object] → [object Object] → …" across
// the top of the chat. Accepts: string | {title|step|name|text|content}.
function _normalizePlanStep(s) {
  if (s == null) return '';
  if (typeof s === 'string') return s;
  if (typeof s === 'object') {
    return String(s.title || s.step || s.name || s.text || s.content || s.description || s.label || JSON.stringify(s).slice(0, 60));
  }
  return String(s);
}

function setStepRail(steps, currentIdx){
  const raw = Array.isArray(steps) ? steps.slice(0, 7) : [];
  stepRailState.steps = raw.map(_normalizePlanStep).filter(Boolean);
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
// Latest reflection event from agentLoop. Captured by the onAgentStep tap
// below and rendered into the Learned tab. Persists across tab switches so
// users can flip away and back without losing the data.
var lastReflection = null;

// Subagent registry — keyed by child runId. Updated live from
// subagent-spawned / subagent-step / subagent-end agent-step events.
// Capped to last 60 entries to avoid bloat from long sessions.
var subagentRegistry = new Map();
var SUBAGENT_REGISTRY_CAP = 60;
function _pruneSubagentRegistry() {
  if (subagentRegistry.size <= SUBAGENT_REGISTRY_CAP) return;
  const drop = subagentRegistry.size - SUBAGENT_REGISTRY_CAP;
  const it = subagentRegistry.keys();
  for (let i = 0; i < drop; i++) { const k = it.next().value; subagentRegistry.delete(k); }
}

function refreshInspectorSubagents() {
  const host = document.getElementById('insp-subagent-tree');
  if (!host) return;
  if (!subagentRegistry.size) {
    host.classList.add('insp-empty');
    host.innerHTML = 'No subagents spawned yet. The agent calls <code>spawn_subagent</code> for parallel-friendly research / multi-source lookups (max depth 2, max 4 concurrent).';
    return;
  }
  host.classList.remove('insp-empty');
  // Group by parentRunId, newest parent first.
  const byParent = new Map();
  for (const [, sub] of subagentRegistry) {
    if (!byParent.has(sub.parentRunId)) byParent.set(sub.parentRunId, []);
    byParent.get(sub.parentRunId).push(sub);
  }
  const parents = Array.from(byParent.entries()).reverse();
  const html = parents.map(([parentId, subs]) => {
    const rows = subs.slice().reverse().map(s => {
      const statusClass = s.status === 'done' ? 'sub-status-done'
        : s.status === 'error' ? 'sub-status-error'
        : 'sub-status-running';
      const statusLabel = s.status === 'done' ? '✓ done'
        : s.status === 'error' ? '✗ error'
        : '◌ running';
      const out = s.status === 'done' && s.answer
        ? `<div class="sub-card-out">${esc(String(s.answer).slice(0,200))}</div>`
        : s.status === 'error' && s.error
        ? `<div class="sub-card-err">${esc(String(s.error).slice(0,200))}</div>`
        : '';
      // Sprint-2.9 — elapsed time for the sub-run. Audit found
      // s.startedAt / s.endedAt were captured but never rendered.
      // For done/error runs we show total duration. For running runs
      // we show elapsed since spawn and add an Abort button (calls
      // agentControl(runId, 'stop'); main-process side currently
      // hardcodes isStopped:()=>false for subagents so this is the
      // UI affordance — backend lift queued as a follow-up).
      let elapsedHtml = '';
      let abortHtml = '';
      if (s.startedAt) {
        const end = s.endedAt || Date.now();
        const ms = end - s.startedAt;
        const sec = Math.floor(ms / 1000);
        const lbl = sec < 60 ? sec + 's' : Math.floor(sec/60) + 'm ' + (sec % 60) + 's';
        elapsedHtml = ` · <span class="sub-card-elapsed">⏱ ${lbl}</span>`;
      }
      if (s.status === 'running' || (!s.status && !s.endedAt)) {
        abortHtml = `<button class="sub-card-abort" data-run-id="${esc(s.runId)}" onclick="subagentAbort(this.dataset.runId)" title="Stop this subagent">stop</button>`;
      }
      return `
        <div class="sub-card${s.status === 'running' ? ' sub-card-running' : ''}">
          <div class="sub-card-head">
            <span class="sub-card-task">${esc(String(s.task).slice(0,80))}</span>
            <span class="sub-card-status ${statusClass}">${statusLabel}</span>
            ${abortHtml}
          </div>
          <div class="sub-card-meta">depth ${s.depth} · ${s.stepsCount || 0} step${s.stepsCount === 1 ? '' : 's'}${elapsedHtml} · <code>${esc(s.runId.split('.').pop() || s.runId.slice(-8))}</code></div>
          ${out}
        </div>
      `;
    }).join('');
    return `
      <div class="sub-parent-group">
        <div class="sub-parent-head">parent <code>${esc(String(parentId).slice(-12))}</code> · ${subs.length} subagent${subs.length === 1 ? '' : 's'}</div>
        ${rows}
      </div>
    `;
  }).join('');
  host.innerHTML = html;
}

// Sprint-2.9 — handler invoked by Inspector subagent abort buttons. The
// backend hardcode at main.js:1320 used to make this a no-op; that's now
// lifted and the controller's isStopped() checks an entry in
// global._subagentAbortRegistry keyed by childRunId.
window.subagentAbort = async function (childRunId) {
  if (!childRunId) return;
  try {
    const r = await window.H?.subagentAbort?.(childRunId);
    if (r && r.ok === false) {
      console.warn('subagentAbort failed:', r.error);
    }
  } catch (e) {
    console.warn('subagentAbort threw:', e);
  }
  // Force a refresh so the user sees status change.
  try { refreshInspectorSubagents(); } catch (_) {}
};

// Phase 26 — per-section error renderer. Each pane in the Learned
// tab now runs in parallel via Promise.allSettled, and every pane
// has its own try/catch that surfaces a red "unavailable" message
// instead of leaving the placeholder visible. Previously a single
// slow IPC could leave one section permanently stuck on "Loading…"
// while siblings populated, which looked broken.
async function _inspLearnedSection(id, label, renderFn) {
  const el = document.getElementById(id);
  if (!el) return;
  // Sprint 4 — Task 4: paint a small skeleton until the renderFn resolves,
  // so the inspector right pane no longer flashes blank cells. Skip when
  // the section already has rendered content (avoid flicker on re-refresh).
  try {
    const hasContent = el.children.length > 0
      && !el.querySelector('.insp-empty')
      && !el.querySelector('.hz-skel-rows');
    if (!hasContent && typeof hzSkelRows === 'function') {
      el.innerHTML = hzSkelRows(3, { height: 12, gap: 6 });
    }
  } catch (_) {}
  try {
    const html = await renderFn();
    if (typeof html === 'string') el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<div class="insp-empty" style="color:var(--red,#ef4444);padding:8px 0">⚠ ${esc(label)} unavailable: ${esc(e?.message || String(e))}</div>`;
  }
}

async function refreshInspectorLearned(){
  // Reflection block — always render even if memSnapshot fails (offline-safe).
  const refl = document.getElementById('insp-reflection');
  if (refl) {
    if (lastReflection) {
      const r = lastReflection;
      const verdictColor = r.goalMet === 'yes' ? 'var(--green)' : r.goalMet === 'partial' ? 'var(--amb,#facc15)' : 'var(--red)';
      const conf = typeof r.confidence === 'number' ? ` · confidence ${(r.confidence * 100).toFixed(0)}%` : '';
      refl.innerHTML = `
        <div style="font-size:11px"><span style="color:${verdictColor};font-weight:700;text-transform:uppercase">${esc(r.goalMet || 'unknown')}</span>${conf}</div>
        <div style="font-size:11px;color:var(--t2);margin-top:6px;line-height:1.5">${esc(r.summary || '')}</div>
        ${(r.gaps || []).length ? `<ul style="font-size:10px;color:var(--t3);margin:6px 0 0 16px;line-height:1.6">${r.gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
      `;
    }
  }

  // Pull snapshot from main (facts + memories + learning stats in one shot).
  try {
    const snap = await H.memSnapshot?.({ factLimit: 40, memLimit: 30 });
    // Phase 25 fix — previously this returned silently when IPC failed
    // and the "Loading…" placeholder stayed forever. Now surface the
    // failure to every section that depends on snap so users know
    // something's wrong instead of staring at a frozen spinner.
    if (!snap?.ok) {
      const err = snap?.error || 'memory snapshot unavailable';
      const failHtml = `<div class="insp-empty" style="color:var(--red,#ef4444);padding:8px 0">⚠ ${esc(err)}</div>`;
      for (const id of ['insp-learned-stats','insp-learned-facts','insp-learned-mems','insp-learned-profile','insp-learned-workspace','insp-learned-reflection']) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = failHtml;
      }
      return;
    }
    const statsHost = document.getElementById('insp-learned-stats');
    if (statsHost) {
      let embedRow = '';
      try {
        const e = await H.memEmbedStatus?.();
        if (e?.ok) {
          if (e.available) {
            const pct = e.totalMemories ? Math.round((e.indexed / e.totalMemories) * 100) : 100;
            const status = e.indexed >= e.totalMemories
              ? `<span style="color:var(--green)">${e.indexed}/${e.totalMemories} indexed</span>`
              : `<span style="color:var(--amb,#facc15)">${e.indexed}/${e.totalMemories} (${pct}%)</span>`;
            const errLine = e.lastError ? `<div class="insp-row" style="display:block;font-size:9px;color:var(--red);padding-left:6px">⚠ ${esc(e.lastError)}</div>` : '';
            embedRow = `
              <div class="insp-row"><span class="k">Semantic index</span><span class="v">${status} · ${esc(e.provider || '?')} · ${e.dim}d</span></div>
              ${errLine}
              <div class="insp-row" style="justify-content:flex-end;padding-top:4px"><button class="hub-btn" onclick="window._inspReindex?.(this)" title="Recompute embeddings for any memories that don't have one yet">Reindex now</button></div>
            `;
          } else {
            embedRow = `<div class="insp-row" style="display:block;font-size:10px;color:var(--t3);line-height:1.5">Semantic recall is off — add an OpenAI or Gemini key in Settings → AI Providers and the memory index will populate automatically.</div>`;
          }
        }
      } catch (_) {}
      // PHASE 6/8 — FTS stats (in-memory inverted index over memories +
      // facts + conversations).
      let ftsRow = '';
      try {
        const fts = await H.memFtsStats?.();
        if (fts?.ok && fts.stats) {
          const t = fts.stats.byType || {};
          ftsRow = `<div class="insp-row"><span class="k">FTS index</span><span class="v">${fts.stats.docs} docs · ${fts.stats.tokens} tokens · m${t.memory||0} f${t.fact||0} c${t.conversation||0}</span></div>`;
        }
      } catch (_) {}
      statsHost.innerHTML = `
        <div class="insp-row"><span class="k">Facts</span><span class="v">${snap.stats.totalFacts}</span></div>
        <div class="insp-row"><span class="k">Memories</span><span class="v">${snap.stats.totalMemories}</span></div>
        <div class="insp-row"><span class="k">Conversations</span><span class="v">${snap.stats.conversations}</span></div>
        <div class="insp-row"><span class="k">Auto-learned</span><span class="v">${snap.stats.learnedItems}</span></div>
        ${snap.stats.lastLearnedAt ? `<div class="insp-row"><span class="k">Last learned</span><span class="v">${esc(new Date(snap.stats.lastLearnedAt).toLocaleString())}</span></div>` : ''}
        ${ftsRow}
        ${embedRow}
      `;
    }
    const factsHost = document.getElementById('insp-learned-facts');
    if (factsHost) {
      if (!snap.facts.length) {
        factsHost.innerHTML = '<div class="insp-empty">No facts yet — Horizon learns from your conversations.</div>';
      } else {
        factsHost.innerHTML = snap.facts.map(f => `
          <div class="mem-row mem-fact" data-key="${esc(f.key)}">
            <div class="mem-row-head">
              <span class="mem-row-key" title="${esc(f.key)}">${esc(f.key)}</span>
              <span class="mem-row-source mem-src-${esc(f.lastSource || f.source || 'unknown')}" title="provenance">${esc(f.lastSource || f.source || '?')}</span>
            </div>
            <div class="mem-row-val" title="${esc(f.value)}">${esc((f.value || '').toString().slice(0, 200))}${f.seen > 1 ? ` <span class="mem-row-seen">×${f.seen}</span>` : ''}</div>
            <div class="mem-row-actions">
              <button class="mem-btn" onclick="_inspEditFact('${esc(f.key)}', this)" title="Edit value" aria-label="Edit value"><svg class="licon"><use href="#i-edit"/></svg></button>
              <button class="mem-btn mem-btn-danger" onclick="_inspForgetFact('${esc(f.key)}', this)" title="Forget this fact" aria-label="Forget this fact"><svg class="licon"><use href="#i-x"/></svg></button>
            </div>
          </div>
        `).join('');
      }
    }
    const memHost = document.getElementById('insp-learned-memories');
    if (memHost) {
      if (!snap.memories.length) {
        memHost.innerHTML = '<div class="insp-empty">No memories yet.</div>';
      } else {
        memHost.innerHTML = snap.memories.slice(0, 30).map(m => {
          // PHASE 7/8 — persona badges show which persona(s) re-asserted
          // the memory. Active persona match boosts recall ×1.2.
          const personas = Array.isArray(m.personas) ? m.personas : (m.personaId ? [m.personaId] : []);
          const personaBadges = personas.length
            ? personas.slice(0, 3).map(p => `<span class="mem-persona" title="persona context">${esc(p)}</span>`).join('')
            : '';
          return `
          <div class="mem-row mem-mem" data-id="${esc(String(m.id))}" data-key="${esc(m.key || '')}">
            <div class="mem-row-head">
              <span class="mem-row-cat">${esc(m.category || 'general')}${m.importance ? ` · imp ${m.importance}` : ''}${m.seen > 1 ? ` · seen ${m.seen}` : ''}</span>
              <span class="mem-row-source mem-src-${esc(m.lastSource || m.source || 'unknown')}" title="provenance">${esc(m.lastSource || m.source || '?')}</span>
            </div>
            <div class="mem-row-body">${esc((m.content || '').toString().slice(0, 300))}</div>
            ${personaBadges ? `<div class="mem-personas">${personaBadges}</div>` : ''}
            <div class="mem-row-actions">
              <button class="mem-btn" onclick="_inspEditMemory('${esc(String(m.id))}', this)" title="Edit content" aria-label="Edit content"><svg class="licon"><use href="#i-edit"/></svg></button>
              <button class="mem-btn mem-btn-danger" onclick="_inspForgetMemory('${esc(String(m.id))}', this)" title="Forget this memory" aria-label="Forget this memory"><svg class="licon"><use href="#i-x"/></svg></button>
            </div>
          </div>
          `;
        }).join('');
      }
    }
    // User Profile (Big Five + communication style) — PHASE 5/8 memory type.
    const profileHost = document.getElementById('insp-learned-profile');
    if (profileHost) {
      const p = snap.userProfile;
      if (!p) {
        profileHost.innerHTML = '<div class="insp-empty">User profile not initialised.</div>';
      } else {
        const bf = p.bigFive || {};
        const cs = p.communicationStyle || {};
        const bigFiveRow = (label, key) => `
          <div class="mem-bf-row">
            <span class="mem-bf-label">${label}</span>
            <input class="mem-bf-slider" type="range" min="0" max="100" step="1" value="${Math.round((bf[key] || 0) * 100)}" oninput="_inspUpdateBigFive('${key}', this.value, this)"/>
            <span class="mem-bf-val" data-bf="${key}">${Math.round((bf[key] || 0) * 100)}</span>
          </div>
        `;
        profileHost.innerHTML = `
          <div style="font-size:10px;color:var(--t3);margin-bottom:6px">Confidence ${(p.confidence * 100).toFixed(0)}%${p.observedAt ? ` · last updated ${esc(new Date(p.observedAt).toLocaleString())}` : ''}</div>
          <div class="mem-bf-group">
            <div class="mem-bf-h">Big Five (psychological dimensions)</div>
            ${bigFiveRow('Openness', 'openness')}
            ${bigFiveRow('Conscientiousness', 'conscientiousness')}
            ${bigFiveRow('Extraversion', 'extraversion')}
            ${bigFiveRow('Agreeableness', 'agreeableness')}
            ${bigFiveRow('Neuroticism', 'neuroticism')}
          </div>
          <div class="mem-bf-group">
            <div class="mem-bf-h">Communication style</div>
            <div class="mem-bf-row">
              <span class="mem-bf-label">Formality</span>
              <select class="mem-bf-select" onchange="_inspUpdateStyle('formality', this.value)">
                <option value="casual"${cs.formality === 'casual' ? ' selected' : ''}>Casual</option>
                <option value="mixed"${cs.formality === 'mixed' ? ' selected' : ''}>Mixed</option>
                <option value="professional"${cs.formality === 'professional' ? ' selected' : ''}>Professional</option>
              </select>
            </div>
            <div class="mem-bf-row">
              <span class="mem-bf-label">Verbosity</span>
              <select class="mem-bf-select" onchange="_inspUpdateStyle('verbosity', this.value)">
                <option value="brief"${cs.verbosity === 'brief' ? ' selected' : ''}>Brief</option>
                <option value="medium"${cs.verbosity === 'medium' ? ' selected' : ''}>Medium</option>
                <option value="verbose"${cs.verbosity === 'verbose' ? ' selected' : ''}>Verbose</option>
              </select>
            </div>
            <div class="mem-bf-row">
              <span class="mem-bf-label">Address</span>
              <input class="mem-bf-input" type="text" value="${esc(cs.preferredAddress || '')}" placeholder="e.g. sir / boss / first name" oninput="_inspUpdateStyle('preferredAddress', this.value)"/>
            </div>
          </div>
        `;
      }
    }
  } catch (e) { /* tab is best-effort */ }

  // PHASE 8/8 — Workspace memory (committable .horizon/memory.json).
  // Read-only view; users edit the JSON in their editor of choice (or
  // via the upcoming workspaceMemoryWrite IPC from an editor plugin).
  //
  // Phase 26 — wrapped via _inspLearnedSection so a hanging IPC or
  // thrown error surfaces a red "unavailable" message in this pane
  // alone, instead of leaving the placeholder forever while the other
  // panes (above) populate normally.
  await _inspLearnedSection('insp-learned-workspace', 'Workspace memory', async () => {
    const ws = await H.workspaceMemoryGet?.();
    if (!ws?.ok) {
      return `<div class="insp-empty">${esc(ws?.error || 'No workspace open.')}</div>`;
    }
    if (!ws.exists) {
      return `
        <div class="insp-empty">
          <p>No <code>.horizon/memory.json</code> in <code>${esc((ws.root || '').slice(-40))}</code>.</p>
          <p style="font-size:10px;margin-top:6px">Create it to share conventions / glossary / decisions across your team. Commit it to git — every Horizon instance opening the repo loads it automatically.</p>
        </div>`;
    }
    const conv = ws.conventions || [];
    const gloss = ws.glossary || {};
    const dec = ws.decisions || [];
    const donot = ws.do_not || [];
    const partsLines = [];
    if (ws.workspace?.name) partsLines.push(`<div class="insp-row"><span class="k">Workspace</span><span class="v">${esc(ws.workspace.name)}${ws.workspace.owner ? ` · ${esc(ws.workspace.owner)}` : ''}</span></div>`);
    partsLines.push(`<div class="insp-row"><span class="k">Conventions</span><span class="v">${conv.length}</span></div>`);
    partsLines.push(`<div class="insp-row"><span class="k">Glossary</span><span class="v">${Object.keys(gloss).length}</span></div>`);
    partsLines.push(`<div class="insp-row"><span class="k">Decisions</span><span class="v">${dec.length}</span></div>`);
    partsLines.push(`<div class="insp-row"><span class="k">Do NOT</span><span class="v">${donot.length}</span></div>`);
    if ((ws.errors || []).length) partsLines.push(`<div class="insp-row" style="display:block;font-size:9px;color:var(--red);padding:4px 6px">${(ws.errors || []).map(esc).join('<br>')}</div>`);
    return partsLines.join('') + `<div style="font-size:9px;color:var(--t3);margin-top:8px">Edit <code>.horizon/memory.json</code> in your editor — auto-reloads on mtime change. Injected into every agent turn's system prompt.</div>`;
  });
}

function refreshInspectorSkills(){
  const host = document.getElementById('insp-body-skills');
  if (!host) return;
  const sel = lastSkillsSelected;
  if (!sel || (!sel.selected?.length && !sel.scored?.length)) {
    host.innerHTML = `
      <div class="insp-section">
        <div class="insp-h">Skills loaded for the last turn</div>
        <div class="insp-empty">No skills resolved yet. Send a message — skills whose <code>description</code> matches your query will appear here with their relevance score.</div>
      </div>`;
    return;
  }
  // Phase 25 — staleness indicator. lastSkillsSelected persists across
  // turns deliberately (so opening the tab after the turn still shows
  // what happened). But that confused users: a turn with no skill
  // matches would still show the PREVIOUS turn's results without any
  // visual cue. Now we attach an `_at` timestamp when we capture the
  // event and render a relative-time pill if it's > 0 turns old.
  const at = sel._at ? Date.parse(sel._at) : 0;
  const ageMs = at ? (Date.now() - at) : 0;
  const ageSec = Math.round(ageMs / 1000);
  const turnDelta = (typeof window._currentTurnNo === 'number' && typeof sel._turnNo === 'number')
    ? Math.max(0, window._currentTurnNo - sel._turnNo)
    : null;
  const isStale = turnDelta != null ? turnDelta > 0 : ageSec > 60;
  const staleTag = isStale
    ? `<span class="insp-stale" title="From a previous turn. The current turn matched no skills." style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:6px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);color:var(--amb,#f59e0b);font-size:9px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase">stale${turnDelta != null ? ` · ${turnDelta} turn${turnDelta===1?'':'s'} ago` : (ageSec ? ` · ${ageSec}s ago` : '')}</span>`
    : '';
  const fmt = (e) => `
    <div class="insp-row" style="display:flex;justify-content:space-between;gap:8px">
      <span class="v" style="text-align:left;color:var(--tx);font-weight:600">${esc(e.id)}</span>
      <span class="k">${e.forced ? '<span style="color:var(--acc)">forced</span> · ' : ''}${e.scope || 'user'} · score <strong>${e.score}</strong>${e.truncated ? ' · <span style="color:var(--amb,#facc15)">truncated</span>' : ''}</span>
    </div>
    <div class="insp-row" style="display:block;font-size:9px;color:var(--t3);padding-left:4px">desc ${e.breakdown?.description ?? 0} · name ${e.breakdown?.name ?? 0} · tags ${e.breakdown?.tags ?? 0}${typeof e.bytes === 'number' ? ' · ' + e.bytes + ' B injected' : ''}</div>`;
  const loaded = (sel.selected || []).map(fmt).join('') || '<div class="insp-empty">Nothing above threshold this turn.</div>';
  const otherCandidates = (sel.scored || []).filter(s => !(sel.selected || []).some(x => x.id === s.id) && (s.score || 0) > 0);
  const candidates = otherCandidates.length
    ? otherCandidates.map(fmt).join('')
    : '<div class="insp-empty">No other partial matches.</div>';
  host.innerHTML = `
    <div class="insp-section">
      <div class="insp-h">Loaded this turn ${staleTag}</div>
      ${loaded}
    </div>
    <div class="insp-section">
      <div class="insp-h">Other candidates (below threshold)</div>
      ${candidates}
    </div>
  `;
}

// Manual reindex hook + live progress updates from the embeddings backfill.
// Wiring lives here (not in chat.html) so all the inspector-state ownership
// stays in one file.
// ── Edit / forget handlers for Learned tab ──────────────────────────────
// Each updates AgentMemory through IPC, then re-renders the tab. Keep
// inline so the buttons can call them as `onclick=...`. Fail-soft: any
// error is shown in chat instead of breaking the inspector.
window._inspEditFact = async function _inspEditFact(key) {
  if (!key) return;
  try {
    const current = await H.memSnapshot?.({ factLimit: 200 });
    const existing = (current?.facts || []).find(f => f.key === key);
    const next = await customPrompt?.(`Edit fact "${key}":`, existing?.value || '');
    if (next == null) return;
    const r = await H.memEditFact?.(key, next);
    if (r?.ok && inspectorTab === 'learned') refreshInspectorLearned();
    else if (!r?.ok) H.notify?.('Memory', r?.error || 'Could not edit fact');
  } catch (e) { H.notify?.('Memory', e.message); }
};

window._inspForgetFact = async function _inspForgetFact(key) {
  if (!key) return;
  const ok = await customConfirm?.(`Forget fact "${key}"? This cannot be undone.`, 'Forget');
  if (!ok) return;
  try {
    const r = await H.memForgetFact?.(key);
    if (r?.ok && inspectorTab === 'learned') refreshInspectorLearned();
    else if (!r?.ok) H.notify?.('Memory', r?.error || 'Could not forget fact');
  } catch (e) { H.notify?.('Memory', e.message); }
};

window._inspEditMemory = async function _inspEditMemory(idOrKey) {
  if (!idOrKey) return;
  try {
    const current = await H.memSnapshot?.({ memLimit: 200 });
    const mem = (current?.memories || []).find(m => String(m.id) === idOrKey || m.key === idOrKey);
    const next = await customPrompt?.(`Edit memory:`, mem?.content || '');
    if (next == null) return;
    const r = await H.memEditMemory?.(idOrKey, { content: next });
    if (r?.ok && inspectorTab === 'learned') refreshInspectorLearned();
    else if (!r?.ok) H.notify?.('Memory', r?.error || 'Could not edit memory');
  } catch (e) { H.notify?.('Memory', e.message); }
};

window._inspForgetMemory = async function _inspForgetMemory(idOrKey) {
  if (!idOrKey) return;
  const ok = await customConfirm?.('Forget this memory? Sidecar embedding is also dropped.', 'Forget');
  if (!ok) return;
  try {
    const r = await H.memForgetMemory?.(idOrKey);
    if (r?.ok && inspectorTab === 'learned') refreshInspectorLearned();
    else if (!r?.ok) H.notify?.('Memory', r?.error || 'Could not forget memory');
  } catch (e) { H.notify?.('Memory', e.message); }
};

window._inspUpdateBigFive = async function _inspUpdateBigFive(trait, value, sliderEl) {
  try {
    const v = Math.max(0, Math.min(1, (Number(value) || 0) / 100));
    // Echo the new percent into the label next to the slider for instant
    // visual feedback before the IPC roundtrip.
    if (sliderEl) {
      const lbl = sliderEl.parentElement?.querySelector(`[data-bf="${trait}"]`);
      if (lbl) lbl.textContent = Math.round(v * 100);
    }
    await H.memUpdateUserProfile?.({ bigFive: { [trait]: v } });
  } catch (e) { console.warn('[profile] bigfive update failed:', e); }
};

window._inspUpdateStyle = async function _inspUpdateStyle(key, value) {
  try { await H.memUpdateUserProfile?.({ communicationStyle: { [key]: value } }); }
  catch (e) { console.warn('[profile] style update failed:', e); }
};

window._inspReindex = async function _inspReindex(btn) {
  // Visible feedback BEFORE the IPC fires so user sees the click registered
  // even if the backend hangs or fails. Old version relied on the global
  // `event` object which is unreliable in modern Chromium — that's why
  // "nothing happens" was the user's perception.
  if (btn && btn instanceof HTMLElement) {
    btn.disabled = true;
    btn.dataset._origText = btn.dataset._origText || btn.textContent;
    btn.textContent = 'Indexing…';
  }
  try {
    addMsg?.('bot', '🧠 Reindexing memories — this can take 5-30s depending on memory count and provider.');
    const r = await H.memEmbedReindex?.();
    if (!r) {
      addMsg?.('bot', '⚠️ Reindex returned no response — embeddings IPC may not be loaded yet.');
      return;
    }
    if (inspectorTab === 'learned') refreshInspectorLearned();
    // PHASE 28 — order: error first (so "no embedding key" doesn't get
    // mis-rendered as "all indexed"), then real work, then status.
    // The backfill response now splits skipped into `alreadyIndexed`
    // (cached) and `bad` (no key / no text) so we can be specific.
    if (r.error && r.indexed === 0 && r.failed === 0) {
      addMsg?.('bot', `❌ ${esc(String(r.error))}`);
    } else if (r.indexed > 0) {
      const extras = [];
      if (r.alreadyIndexed) extras.push(`${r.alreadyIndexed} already cached`);
      if (r.bad) extras.push(`${r.bad} skipped (missing key/text)`);
      if (r.failed) extras.push(`${r.failed} failed: ${esc(String(r.error || 'unknown')).slice(0, 200)}`);
      const tail = extras.length ? ` (${extras.join('; ')})` : '';
      addMsg?.('bot', `✓ Reindexed **${r.indexed}** memor${r.indexed === 1 ? 'y' : 'ies'}${tail}.`);
    } else if (r.failed > 0) {
      addMsg?.('bot', `❌ Reindex failed: ${esc(String(r.error || 'no error message'))}\n\nFix hints:\n• Gemini key may not have embedding-API access — try another key or add an OpenAI key (text-embedding-3-small is cheap).\n• Check console for the raw HTTP error.`);
    } else if (r.alreadyIndexed > 0 && r.bad === 0) {
      addMsg?.('bot', `✓ All ${r.alreadyIndexed} memories already indexed — nothing to do.`);
    } else if (r.bad > 0) {
      // Old shape — memories missing key/text. _ensureShape now heals
      // these on next boot, so this message is a one-time hint.
      addMsg?.('bot', `⚠️ ${r.bad} memor${r.bad === 1 ? 'y' : 'ies'} skipped (missing key/text). Restart the app — _ensureShape will heal old records, then click Reindex again.`);
    } else {
      addMsg?.('bot', '⚠️ Reindex returned no results.');
    }
  } catch (e) {
    addMsg?.('bot', `❌ Reindex exception: ${esc(e.message)}`);
    console.error('[reindex] exception:', e);
  } finally {
    if (btn && btn instanceof HTMLElement) {
      btn.disabled = false;
      btn.textContent = btn.dataset._origText || 'Reindex now';
    }
  }
};

// PHASE 28.4 — Dialectic model viewer (9th memory layer, Honcho-style).
// Big Five panel above is the static snapshot; this list shows the
// time-ordered diff log of what the agent has learned about the user.
function _renderDialecticList(records) {
  const list = document.getElementById('insp-dialectic-list');
  if (!list) return;
  if (!records || !records.length) {
    list.innerHTML = '<div class="insp-empty">No dialectic records yet — the agent emits one when it learns something new about you.</div>';
    return;
  }
  const colour = (kind) => ({
    belief:           'var(--cyan, #06b6d4)',
    desire:           'var(--rose, #f43f5e)',
    knowledge:        'var(--green, #10b981)',
    'theory-of-mind': 'var(--violet, #8b5cf6)',
    correction:       'var(--amber, #f59e0b)',
  })[kind] || 'var(--t2)';
  list.innerHTML = records.map(r => `
    <div style="padding:6px 8px;border-left:2px solid ${colour(r.kind)};margin-bottom:6px;background:rgba(255,255,255,0.02)">
      <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:0.06em">
        <span style="color:${colour(r.kind)}">${esc(r.kind)}</span>
        <span>${esc(new Date(r.ts).toLocaleString())} · conf ${(r.confidence || 0.7).toFixed(2)}</span>
      </div>
      <div style="margin-top:4px;color:var(--tx)">${esc(r.after || '')}</div>
      ${r.before ? `<div style="margin-top:2px;color:var(--t3);font-size:10px">was: ${esc(r.before)}</div>` : ''}
      ${r.evidence ? `<div style="margin-top:2px;color:var(--t3);font-size:10px;font-style:italic">"${esc(r.evidence)}"</div>` : ''}
    </div>
  `).join('');
}

window._inspDialecticRefresh = async function(btn) {
  const summaryEl = document.getElementById('insp-dialectic-summary');
  try {
    const [sum, list] = await Promise.all([
      H.dialecticSummary?.(),
      H.dialecticRecent?.({ limit: 20 }),
    ]);
    if (summaryEl) {
      if (!sum?.ok) {
        summaryEl.textContent = sum?.error || 'Dialectic model unavailable.';
      } else {
        const byKind = sum.byKind || {};
        const kindBits = Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(' · ') || 'no records yet';
        const updated = sum.lastUpdatedAt ? `last update ${new Date(sum.lastUpdatedAt).toLocaleString()}` : 'never updated';
        summaryEl.textContent = `${sum.total} records (cap ${sum.cap}) — ${kindBits}. ${updated}.`;
      }
    }
    _renderDialecticList(list?.records || []);
  } catch (e) {
    if (summaryEl) summaryEl.textContent = 'Refresh failed: ' + (e.message || String(e));
  }
};

// PHASE 28.5 — wire the dead `H.dialecticSearch` IPC to the new search
// input above. Debounced 200ms so typing doesn't hammer the main proc.
let _dialecticSearchTimer = null;
window._inspDialecticSearch = function(query) {
  clearTimeout(_dialecticSearchTimer);
  _dialecticSearchTimer = setTimeout(async () => {
    try {
      const q = String(query || '').trim();
      const r = q
        ? await H.dialecticSearch?.({ query: q, limit: 30 })
        : await H.dialecticRecent?.({ limit: 20 });
      _renderDialecticList(r?.records || []);
    } catch (e) {
      console.warn('[dialectic] search failed:', e.message);
    }
  }, 200);
};

window._inspDialecticClear = async function(btn) {
  try {
    const confirmed = await (typeof customConfirm === 'function'
      ? customConfirm('Wipe all dialectic records? Big Five profile stays untouched.')
      : Promise.resolve(window.confirm('Wipe all dialectic records?')));
    if (!confirmed) return;
    const r = await H.dialecticClear?.();
    if (!r?.ok) { addMsg?.('bot', `❌ Clear failed: ${esc(r?.error || 'unknown')}`); return; }
    addMsg?.('bot', '🧹 Dialectic records wiped. Big Five profile is untouched.');
    await window._inspDialecticRefresh?.();
  } catch (e) {
    addMsg?.('bot', `❌ Clear exception: ${esc(e.message)}`);
  }
};

// Auto-refresh the dialectic list whenever the Learned tab opens.
const _origRefreshLearned = typeof refreshInspectorLearned === 'function' ? refreshInspectorLearned : null;
if (_origRefreshLearned) {
  refreshInspectorLearned = function(...args) {
    const out = _origRefreshLearned.apply(this, args);
    try { window._inspDialecticRefresh?.(); } catch (_) {}
    return out;
  };
}

// PHASE 28.3 — Agent-curated memory reviewer buttons (Hermes-style
// periodic nudges). Same flow as the SQLite mirror buttons below:
// status reads from main, "Review now" triggers a pass immediately.
window._inspMemoryReviewerStatus = async function(btn) {
  try {
    const r = await H.memoryReviewerStatus?.();
    if (!r) { addMsg?.('bot', '⚠️ memoryReviewerStatus IPC unavailable.'); return; }
    if (!r.ok) { addMsg?.('bot', `❌ Reviewer: ${esc(r.error || 'not initialized')}`); return; }
    const stats = r.lastRunStats;
    const statsEl = document.getElementById('insp-reviewer-stats');
    if (statsEl) {
      if (stats) {
        statsEl.innerHTML = `Last pass: <strong>${stats.reviewed || 0}</strong> reviewed · ${stats.decayed || 0} decayed · ${stats.merged || 0} merged · ${stats.forgotten || 0} forgotten · ${new Date(r.lastRunAt || Date.now()).toLocaleString()}`;
      } else {
        statsEl.textContent = r.running ? 'Reviewer is running, no pass complete yet.' : 'Reviewer not running.';
      }
    }
    if (!stats) addMsg?.('bot', '📊 Reviewer is scheduled but hasn\'t completed a pass yet. Click Review now to force one.');
    else addMsg?.('bot', `📊 Last review pass — ${stats.reviewed || 0} reviewed, ${stats.decayed || 0} decayed, ${stats.merged || 0} merged, ${stats.forgotten || 0} forgotten.`);
  } catch (e) {
    addMsg?.('bot', `❌ Reviewer status exception: ${esc(e.message)}`);
  }
};

window._inspMemoryReviewerRunNow = async function(btn) {
  if (btn instanceof HTMLElement) {
    btn.disabled = true;
    btn.dataset._origText = btn.dataset._origText || btn.textContent;
    btn.textContent = 'Reviewing…';
  }
  try {
    addMsg?.('bot', '🧹 Running memory review pass — decay / merge near-duplicates / forget stale low-importance entries.');
    const r = await H.memoryReviewerRunNow?.();
    if (!r) { addMsg?.('bot', '⚠️ Reviewer IPC unavailable.'); return; }
    if (!r.ok) { addMsg?.('bot', `❌ Review failed: ${esc(r.error || 'unknown error')}`); return; }
    if (r.skipped) {
      addMsg?.('bot', `ℹ️ Skipped — ${r.skipped} (memories: ${r.count || 0}). Reviewer waits for at least 50 memories before running.`);
    } else {
      addMsg?.('bot', `✓ Reviewed **${r.reviewed}** memories — ${r.decayed} decayed, ${r.merged} merged, ${r.forgotten} forgotten, ${r.survivors} kept.`);
    }
    // Refresh inspector to show the updated stats.
    if (inspectorTab === 'learned') refreshInspectorLearned();
  } catch (e) {
    addMsg?.('bot', `❌ Review exception: ${esc(e.message)}`);
    console.error('[memoryReviewer] exception:', e);
  } finally {
    if (btn instanceof HTMLElement) {
      btn.disabled = false;
      btn.textContent = btn.dataset._origText || 'Review now';
    }
  }
};

// Sprint 7B — SQLite is the primary memory store. JSON becomes an
// export format only. The migration that copies legacy memory.json
// into memory.sqlite happens automatically on boot; these buttons let
// users snapshot/restore between the two.
window._inspMemoryDbStatus = async function(btn) {
  try {
    const r = await H.memoryDbStatus?.();
    if (!r) { addMsg?.('bot', '⚠️ memoryDbStatus IPC unavailable.'); return; }
    if (!r.ok) { addMsg?.('bot', `❌ Status: ${esc(r.error || 'unknown error')}`); return; }
    if (!r.exists) {
      addMsg?.('bot', `📦 SQLite store not created yet — will be created at first write to\n\`${esc(r.dbPath)}\``);
      return;
    }
    const s = r.stats || {};
    addMsg?.('bot', `📦 **SQLite (primary)** at \`${esc(r.dbPath)}\` — **${s.memories || 0}** memories, **${s.facts || 0}** facts, **${s.conversations || 0}** conversations (schema v${s.schema || 1}).`);
  } catch (e) {
    addMsg?.('bot', `❌ Status exception: ${esc(e.message)}`);
  }
};

window._inspMemoryMigrate = async function(btn) {
  // Kept for legacy callers — re-runs the JSON→SQLite migration helper.
  if (btn instanceof HTMLElement) {
    btn.disabled = true;
    btn.dataset._origText = btn.dataset._origText || btn.textContent;
    btn.textContent = 'Migrating…';
  }
  try {
    addMsg?.('bot', '📦 Re-running JSON → SQLite migration (idempotent — dupes skipped).');
    const r = await H.memoryDbMigrate?.();
    if (!r) { addMsg?.('bot', '⚠️ Migration IPC unavailable.'); return; }
    if (!r.ok) {
      addMsg?.('bot', `❌ Migration failed: ${esc(r.error || 'unknown error')}\n\nIf the error mentions \`better-sqlite3\`, run \`npm run rebuild:native\` in the app folder or wait for the next packaged build.`);
      return;
    }
    const a = r.added || {};
    addMsg?.('bot', `✓ Mirrored to \`${esc(r.dbPath)}\` — added **${a.memories || 0}** memories, **${a.facts || 0}** facts, **${a.conversations || 0}** conversations.${r.backupPath ? `\n\nPrevious DB backed up to \`${esc(r.backupPath)}\`.` : ''}`);
  } catch (e) {
    addMsg?.('bot', `❌ Migration exception: ${esc(e.message)}`);
    console.error('[memoryDbMigrate] exception:', e);
  } finally {
    if (btn instanceof HTMLElement) {
      btn.disabled = false;
      btn.textContent = btn.dataset._origText || 'Rebuild mirror';
    }
  }
};

// Sprint 7B — Export SQLite → JSON snapshot. The IPC pops a save
// dialog so the user picks where to write the file.
window._inspMemoryExportJson = async function(btn) {
  if (btn instanceof HTMLElement) {
    btn.disabled = true;
    btn.dataset._origText = btn.dataset._origText || btn.textContent;
    btn.textContent = 'Exporting…';
  }
  try {
    const r = await H.memoryDbExportJson?.();
    if (!r) { addMsg?.('bot', '⚠️ memoryDbExportJson IPC unavailable.'); return; }
    if (r.canceled) { return; /* user cancelled — silent */ }
    if (!r.ok) { addMsg?.('bot', `❌ Export failed: ${esc(r.error || 'unknown error')}`); return; }
    const s = r.stats || {};
    addMsg?.('bot', `✓ Exported memory snapshot to \`${esc(r.jsonPath)}\` — ${s.memories || 0} memories, ${s.facts || 0} facts, ${s.conversations || 0} conversations · ${((r.bytes || 0) / 1024).toFixed(1)} KB.`);
  } catch (e) {
    addMsg?.('bot', `❌ Export exception: ${esc(e.message)}`);
    console.error('[memoryDbExportJson] exception:', e);
  } finally {
    if (btn instanceof HTMLElement) {
      btn.disabled = false;
      btn.textContent = btn.dataset._origText || 'Export memory to JSON file';
    }
  }
};

// Sprint 7B — Import a JSON memory dump back into SQLite. Idempotent —
// duplicates (same memory key / fact key / conversation id) are skipped.
window._inspMemoryImportJson = async function(btn) {
  if (btn instanceof HTMLElement) {
    btn.disabled = true;
    btn.dataset._origText = btn.dataset._origText || btn.textContent;
    btn.textContent = 'Importing…';
  }
  try {
    const r = await H.memoryDbImportJson?.();
    if (!r) { addMsg?.('bot', '⚠️ memoryDbImportJson IPC unavailable.'); return; }
    if (r.canceled) { return; /* user cancelled — silent */ }
    if (!r.ok) { addMsg?.('bot', `❌ Import failed: ${esc(r.error || 'unknown error')}`); return; }
    const a = r.added || {};
    addMsg?.('bot', `✓ Imported from \`${esc(r.source)}\` — added **${a.memories}** memories, **${a.facts}** facts, **${a.conversations}** conversations.`);
  } catch (e) {
    addMsg?.('bot', `❌ Import exception: ${esc(e.message)}`);
    console.error('[memoryDbImportJson] exception:', e);
  } finally {
    if (btn instanceof HTMLElement) {
      btn.disabled = false;
      btn.textContent = btn.dataset._origText || 'Import JSON memory dump';
    }
  }
};

try {
  H.onMemoryEmbeddingProgress?.((p) => {
    // Only refresh if the Learned tab is visible; otherwise the next
    // tab-open will pull fresh state via memEmbedStatus.
    if (inspectorActive && inspectorTab === 'learned') refreshInspectorLearned();
  });
} catch (_) {}
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
      // Capture skills-selected for the inspector's Skills tab. Stored on a
      // module-level var so opening the tab after the turn still shows the
      // latest match — same UX pattern as plan-step → stepRailState.
      if (step?.type === 'skills-selected' && step.payload) {
        // Phase 25 — stamp the payload with capture time + turn number so
        // refreshInspectorSkills can surface "stale" if the user is on
        // a later turn that didn't match any skills.
        lastSkillsSelected = {
          ...step.payload,
          _at: new Date().toISOString(),
          _turnNo: typeof window._currentTurnNo === 'number' ? window._currentTurnNo : null,
        };
        if (inspectorActive && inspectorTab === 'skills') refreshInspectorSkills();
      }
      // Reflection — agentLoop emits after each finished run with goal_met,
      // summary, gaps, confidence. Store + re-render the Learned tab.
      if (step?.type === 'reflection') {
        lastReflection = step;
        if (inspectorActive && inspectorTab === 'learned') refreshInspectorLearned();
      }
      // Subagent lifecycle events from spawnSubagent in main.js.
      if (step?.type === 'subagent-spawned' && step.runId) {
        subagentRegistry.set(step.runId, {
          runId: step.runId,
          parentRunId: step.parentRunId || 'root',
          depth: step.depth || 1,
          task: step.task || '',
          startedAt: step.startedAt,
          status: 'running',
          stepsCount: 0,
        });
        _pruneSubagentRegistry();
        if (inspectorActive && inspectorTab === 'subagents') refreshInspectorSubagents();
      }
      if (step?.type === 'subagent-end' && step.runId) {
        let existing = subagentRegistry.get(step.runId);
        // Phase 25 fix — if `subagent-end` arrives before `subagent-spawned`
        // (event order isn't guaranteed under high load), the old code
        // dropped the end event silently and the row never terminated.
        // Now we synthesize a minimal record so the row appears with a
        // terminated state instead of disappearing forever.
        if (!existing) {
          existing = {
            runId: step.runId,
            parentRunId: step.parentRunId || null,
            depth: step.depth || 1,
            task: step.task || '(no task captured)',
            startedAt: step.startedAt || step.endedAt,
            stepsCount: 0,
          };
          subagentRegistry.set(step.runId, existing);
        }
        existing.status = step.status || (step.error ? 'error' : 'done');
        existing.stepsCount = step.stepsCount || existing.stepsCount;
        existing.answer = step.answer;
        existing.error = step.error;
        existing.endedAt = step.endedAt;
        _pruneSubagentRegistry();
        if (inspectorActive && inspectorTab === 'subagents') refreshInspectorSubagents();
      }
      // Increment stepsCount when subagent tools fire (any step tagged isSubagent).
      if (step?.isSubagent && step.runId && (step.type === 'result' || step.type === 'executing')) {
        const existing = subagentRegistry.get(step.runId);
        if (existing && step.type === 'result') existing.stepsCount = (existing.stepsCount || 0) + 1;
        if (inspectorActive && inspectorTab === 'subagents') refreshInspectorSubagents();
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

// Sprint 2.8 — sandbox-proof inline onclick exposure.
if (typeof window !== 'undefined') {
  ['toggleInspectorMode','setInspectorTab'].forEach(function (n) {
    try {
      var fn = eval('typeof ' + n + " === 'function' ? " + n + ' : null');
      if (fn) window[n] = fn;
    } catch (_) {}
  });
}

