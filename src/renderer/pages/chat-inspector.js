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
      return `
        <div class="sub-card">
          <div class="sub-card-head">
            <span class="sub-card-task">${esc(String(s.task).slice(0,80))}</span>
            <span class="sub-card-status ${statusClass}">${statusLabel}</span>
          </div>
          <div class="sub-card-meta">depth ${s.depth} · ${s.stepsCount || 0} step${s.stepsCount === 1 ? '' : 's'} · <code>${esc(s.runId.split('.').pop() || s.runId.slice(-8))}</code></div>
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
    if (!snap?.ok) return;
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
      statsHost.innerHTML = `
        <div class="insp-row"><span class="k">Facts</span><span class="v">${snap.stats.totalFacts}</span></div>
        <div class="insp-row"><span class="k">Memories</span><span class="v">${snap.stats.totalMemories}</span></div>
        <div class="insp-row"><span class="k">Conversations</span><span class="v">${snap.stats.conversations}</span></div>
        <div class="insp-row"><span class="k">Auto-learned</span><span class="v">${snap.stats.learnedItems}</span></div>
        ${snap.stats.lastLearnedAt ? `<div class="insp-row"><span class="k">Last learned</span><span class="v">${esc(new Date(snap.stats.lastLearnedAt).toLocaleString())}</span></div>` : ''}
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
              <button class="mem-btn" onclick="_inspEditFact('${esc(f.key)}', this)" title="Edit value">✎</button>
              <button class="mem-btn mem-btn-danger" onclick="_inspForgetFact('${esc(f.key)}', this)" title="Forget this fact">✕</button>
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
        memHost.innerHTML = snap.memories.slice(0, 30).map(m => `
          <div class="mem-row mem-mem" data-id="${esc(String(m.id))}" data-key="${esc(m.key || '')}">
            <div class="mem-row-head">
              <span class="mem-row-cat">${esc(m.category || 'general')}${m.importance ? ` · imp ${m.importance}` : ''}${m.seen > 1 ? ` · seen ${m.seen}` : ''}</span>
              <span class="mem-row-source mem-src-${esc(m.lastSource || m.source || 'unknown')}" title="provenance">${esc(m.lastSource || m.source || '?')}</span>
            </div>
            <div class="mem-row-body">${esc((m.content || '').toString().slice(0, 300))}</div>
            <div class="mem-row-actions">
              <button class="mem-btn" onclick="_inspEditMemory('${esc(String(m.id))}', this)" title="Edit content">✎</button>
              <button class="mem-btn mem-btn-danger" onclick="_inspForgetMemory('${esc(String(m.id))}', this)" title="Forget this memory">✕</button>
            </div>
          </div>
        `).join('');
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
              <input class="mem-bf-input" type="text" value="${esc(cs.preferredAddress || '')}" placeholder="e.g. Сэр / boss / first name" oninput="_inspUpdateStyle('preferredAddress', this.value)"/>
            </div>
          </div>
        `;
      }
    }
  } catch (e) { /* tab is best-effort */ }
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
      <div class="insp-h">Loaded this turn</div>
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
    if (r.indexed > 0) {
      addMsg?.('bot', `✓ Reindexed **${r.indexed}** memor${r.indexed === 1 ? 'y' : 'ies'}${r.failed ? ` (${r.failed} failed: ${esc(String(r.error || 'unknown')).slice(0, 200)})` : ''}.`);
    } else if (r.failed > 0) {
      // Surface the actual error in the chat — user can see what went wrong.
      addMsg?.('bot', `❌ Reindex failed: ${esc(String(r.error || 'no error message'))}\n\nFix hints:\n• Gemini key may not have embedding-API access — try another key or add an OpenAI key (text-embedding-3-small is cheap).\n• Check console for the raw HTTP error.`);
    } else if (r.skipped > 0) {
      addMsg?.('bot', `✓ All ${r.skipped} memories already indexed — nothing to do.`);
    } else if (r.error) {
      addMsg?.('bot', `❌ ${esc(String(r.error))}`);
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
        lastSkillsSelected = step.payload;
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
        const existing = subagentRegistry.get(step.runId);
        if (existing) {
          existing.status = step.status || (step.error ? 'error' : 'done');
          existing.stepsCount = step.stepsCount || existing.stepsCount;
          existing.answer = step.answer;
          existing.error = step.error;
          existing.endedAt = step.endedAt;
        }
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

