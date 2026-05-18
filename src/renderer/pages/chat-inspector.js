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
      const statusColor = s.status === 'done' ? 'var(--green)' : s.status === 'error' ? 'var(--red)' : 'var(--amb,#facc15)';
      const statusLabel = s.status === 'done' ? '✓ done' : s.status === 'error' ? '✗ error' : '◌ running';
      const out = s.status === 'done' && s.answer
        ? `<div style="font-size:10px;color:var(--t2);margin-top:4px;line-height:1.4;border-left:2px solid var(--b2);padding-left:8px">${esc(String(s.answer).slice(0,200))}</div>`
        : s.status === 'error' && s.error
        ? `<div style="font-size:10px;color:var(--red);margin-top:4px;line-height:1.4">${esc(String(s.error).slice(0,200))}</div>`
        : '';
      return `
        <div style="padding:6px 0;border-bottom:1px solid var(--b1)">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
            <span class="v" style="text-align:left;color:var(--tx);font-size:11px">${esc(String(s.task).slice(0,80))}</span>
            <span style="color:${statusColor};font-size:9px;font-weight:700;text-transform:uppercase">${statusLabel}</span>
          </div>
          <div style="font-size:9px;color:var(--t3);margin-top:2px">depth ${s.depth} · ${s.stepsCount || 0} step${s.stepsCount === 1 ? '' : 's'} · <code style="font-size:9px">${esc(s.runId.split('.').pop() || s.runId.slice(-8))}</code></div>
          ${out}
        </div>
      `;
    }).join('');
    return `
      <div class="insp-row" style="display:block;border:1px solid var(--b1);border-radius:8px;padding:8px 10px;margin-bottom:8px">
        <div style="font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">parent <code style="font-size:9px">${esc(String(parentId).slice(-12))}</code> · ${subs.length} subagent${subs.length === 1 ? '' : 's'}</div>
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
              <div class="insp-row" style="justify-content:flex-end;padding-top:4px"><button class="hub-btn" onclick="window._inspReindex?.()" title="Recompute embeddings for any memories that don't have one yet">Reindex now</button></div>
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
          <div class="insp-row" style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
            <span class="v" style="text-align:left;color:var(--tx);font-weight:600;flex-shrink:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(f.key)}">${esc(f.key)}</span>
            <span class="k" style="text-align:right;color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(f.value)}">${esc((f.value || '').toString().slice(0, 120))}${f.seen > 1 ? ` <span style="color:var(--t3)">×${f.seen}</span>` : ''}</span>
          </div>
        `).join('');
      }
    }
    const memHost = document.getElementById('insp-learned-memories');
    if (memHost) {
      if (!snap.memories.length) {
        memHost.innerHTML = '<div class="insp-empty">No memories yet.</div>';
      } else {
        memHost.innerHTML = snap.memories.slice(0, 20).map(m => `
          <div class="insp-row" style="display:block;padding:6px 0;border-bottom:1px solid var(--b1)">
            <div style="font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:.04em">${esc(m.category || 'general')}${m.importance ? ` · imp ${m.importance}` : ''}</div>
            <div style="font-size:11px;color:var(--tx);margin-top:2px;line-height:1.5">${esc((m.content || '').toString().slice(0, 200))}</div>
          </div>
        `).join('');
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
window._inspReindex = async function _inspReindex() {
  try {
    const btn = event?.currentTarget;
    if (btn) { btn.disabled = true; btn.textContent = 'Indexing…'; }
    const r = await H.memEmbedReindex?.();
    if (btn) { btn.disabled = false; btn.textContent = 'Reindex now'; }
    if (r?.ok) {
      H.notify?.('Memory', `Embeddings ready — ${r.indexed} indexed${r.failed ? `, ${r.failed} failed` : ''}`);
      if (inspectorTab === 'learned') refreshInspectorLearned();
    } else {
      H.notify?.('Memory', r?.error || 'Reindex failed');
    }
  } catch (e) { H.notify?.('Memory', e.message); }
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

