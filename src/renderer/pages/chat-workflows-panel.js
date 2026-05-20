// PR-V Phase 3.9 — Workflows Panel UI.
// Extracted from chat.html inline <script> (was lines 5253-6009).
//
// Visual no-code workflow surface — distinct from chat-workflows.js
// which holds the underlying CRUD + builder. This module is the
// PANEL: tabs (overview/runs/draft), run-graph render, list rows,
// draft step editor, quick-create entry, and the icon registries
// (STEP_ICONS, LUCIDE_ICON_MAP) used by both this panel and the
// workflow rows elsewhere.
//
// State: wfCurrentTab, wfActiveRun, wfDraftSteps
// Constants: STEP_ICONS, LUCIDE_ICON_MAP
// Open/close: openWorkflows, closeWorkflows, wfTab
// Helpers: _wfStepLabel, _wfStepKind, _wfFmtTime, _wfFmtRel,
//          _wfTriggerKind, pluginIcon, workflowIcon
// Renderers: renderWfOverview, renderWfGraph, renderWfRow,
//            renderWfBody, renderWfDraftSteps
// Actions: wfQuickCreate, runWorkflowById, handleWorkflowRunEffects,
//          deleteWorkflowById, shareWorkflow
//
// Loaded as external script AFTER main inline + chat-workflows.js
// (workflow CRUD) so window.* globals it reads are defined.

// ═══════════════════════════════════════════════════════════════
// WORKFLOWS PANEL
// ═══════════════════════════════════════════════════════════════
var wfCurrentTab = 'overview';

function openWorkflows() {
  setActiveSurface('workflows', { keepPanels:['wf-panel'] });
  document.getElementById('wf-panel').classList.add('show');
  wfTab('overview');
}
function closeWorkflows() {
  document.getElementById('wf-panel').classList.remove('show');
  if (isSurfaceActive('workflows')) closeActiveSurface();
}
function wfTab(tab) {
  wfCurrentTab = tab;
  ['overview','list','create','scheduled'].forEach(t => {
    document.getElementById(`wf-tab-${t}`)?.classList.toggle('on', t === tab);
  });
  renderWfBody();
}

// ── Workflow live-run state ─────────────────────────────────────────────
// Keeps a snapshot of the most-recently-running workflow so the Overview
// tab can paint the active node + done/pending nodes in the graph view.
// Updated by IPC events `workflow:running:start|step|end`. When idle,
// falls back to the most recent finished run (via lastRun on stored wfs).
var wfActiveRun = null;
function _wfStepLabel(action) {
  const map = {
    open_url: 'Open URL', open_site: 'Open Site', open_app: 'Open App',
    close_url: 'Close URL', close_app: 'Close App',
    type_text: 'Type Text', press_key: 'Press Key',
    run_code: 'Run Code', shell: 'Shell', wait: 'Wait',
    notify: 'Notify', speak: 'Speak', send_message: 'Send Message',
    screenshot: 'Screenshot', clipboard_read: 'Read Clipboard',
    clipboard_write: 'Write Clipboard', plugin: 'Plugin'
  };
  return map[action] || (action || 'Step').replace(/_/g, ' ');
}
function _wfStepKind(action) {
  if (action === 'send_message' || action === 'speak') return 'LLM';
  if (action === 'wait') return 'WAIT';
  if (action === 'notify') return 'NOTIFY';
  if (action === 'open_url' || action === 'open_app' || action === 'open_site') return 'TRIGGER';
  return 'ACTION';
}
function _wfFmtTime(ms) {
  if (!ms) return '—';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
}
function _wfFmtRel(iso) {
  if (!iso) return 'never';
  const dt = Date.now() - new Date(iso).getTime();
  if (dt < 60000) return 'just now';
  if (dt < 3600000) return Math.floor(dt / 60000) + 'm ago';
  if (dt < 86400000) return Math.floor(dt / 3600000) + 'h ago';
  return Math.floor(dt / 86400000) + 'd ago';
}
function _wfTriggerKind(t) {
  if (!t || t === 'manual') return { label: 'Manual', cls: '' };
  if (t === 'startup') return { label: 'Startup', cls: 'startup' };
  if (t.startsWith('cron:')) return { label: 'Cron · ' + t.slice(5), cls: 'cron' };
  if (t.startsWith('schedule:')) return { label: 'Daily · ' + t.slice(9), cls: 'cron' };
  if (t.startsWith('interval:')) return { label: 'Every ' + t.slice(9) + 'm', cls: 'interval' };
  if (t.startsWith('wake:')) return { label: 'Wake · ' + t.slice(5), cls: 'interval' };
  return { label: t, cls: '' };
}

var STEP_ICONS = {
  open_url:'\u{1F310}', open_site:'\u{1F4BB}', type_text:'\u{2328}\u{FE0F}', press_key:'\u{2328}\u{FE0F}',
  run_code:'\u{1F4BB}', wait:'\u{23F1}\u{FE0F}', notify:'\u{1F4C4}', speak:'\u{1F5E3}\u{FE0F}',
  send_message:'\u{1F4AC}', close_url:'\u{274C}', screenshot:'\u{1F4F8}'
};

// Map lucide-react icon names (used by the marketplace backend) to real emoji glyphs,
// so plugin cards in the desktop app don't show raw words like "Music" as their avatar.
var LUCIDE_ICON_MAP = {
  Music:'\u{1F3B5}', Music2:'\u{1F3B5}', Music3:'\u{1F3B5}', Music4:'\u{1F3B5}', Headphones:'\u{1F3A7}', Radio:'\u{1F4FB}', Mic:'\u{1F399}\u{FE0F}', Mic2:'\u{1F399}\u{FE0F}', Volume:'\u{1F50A}', Volume2:'\u{1F50A}',
  Puzzle:'\u{1F9E9}', Plug:'\u{1F50C}', PlugZap:'\u{26A1}', Zap:'\u{26A1}', Bolt:'\u{26A1}', Star:'\u{2B50}', Sparkles:'\u{2728}', Gem:'\u{1F48E}', Crown:'\u{1F451}',
  Globe:'\u{1F310}', Globe2:'\u{1F310}', Chrome:'\u{1F310}', Compass:'\u{1F9ED}', Map:'\u{1F5FA}\u{FE0F}', MapPin:'\u{1F4CD}', Navigation:'\u{1F9ED}',
  Mail:'\u{2709}\u{FE0F}', MessageCircle:'\u{1F4AC}', MessageSquare:'\u{1F4AC}', Send:'\u{1F4E4}', Inbox:'\u{1F4E5}', AtSign:'\u{1F4E7}', Phone:'\u{1F4DE}',
  Calendar:'\u{1F4C5}', CalendarDays:'\u{1F4C5}', Clock:'\u{23F0}', Timer:'\u{23F1}\u{FE0F}', Hourglass:'\u{23F3}', AlarmClock:'\u{23F0}',
  Image:'\u{1F5BC}\u{FE0F}', Camera:'\u{1F4F7}', Video:'\u{1F4F9}', Film:'\u{1F3AC}', Clapperboard:'\u{1F3AC}', Play:'\u{25B6}\u{FE0F}', Pause:'\u{23F8}\u{FE0F}', Square:'\u{23F9}\u{FE0F}', SkipForward:'\u{23ED}\u{FE0F}', SkipBack:'\u{23EE}\u{FE0F}',
  File:'\u{1F4C4}', FileText:'\u{1F4C4}', Files:'\u{1F4C1}', Folder:'\u{1F4C1}', FolderOpen:'\u{1F4C2}', Archive:'\u{1F5C4}\u{FE0F}', Save:'\u{1F4BE}', HardDrive:'\u{1F4BE}',
  Download:'\u{2B07}\u{FE0F}', Upload:'\u{2B06}\u{FE0F}', Cloud:'\u{2601}\u{FE0F}', CloudDownload:'\u{2601}\u{FE0F}', CloudUpload:'\u{2601}\u{FE0F}',
  Search:'\u{1F50D}', SearchCheck:'\u{1F50D}', ZoomIn:'\u{1F50E}', Eye:'\u{1F441}\u{FE0F}', EyeOff:'\u{1F648}',
  Shield:'\u{1F6E1}\u{FE0F}', ShieldCheck:'\u{1F6E1}\u{FE0F}', Lock:'\u{1F512}', Unlock:'\u{1F513}', Key:'\u{1F511}', KeyRound:'\u{1F511}', Fingerprint:'\u{1FAC6}',
  Settings:'\u{2699}\u{FE0F}', Settings2:'\u{2699}\u{FE0F}', Sliders:'\u{1F39A}\u{FE0F}', Wrench:'\u{1F527}', Hammer:'\u{1F528}', Cog:'\u{2699}\u{FE0F}', Tool:'\u{1F6E0}\u{FE0F}',
  User:'\u{1F464}', Users:'\u{1F465}', UserCircle:'\u{1F464}', UserCheck:'\u{2705}', UserPlus:'\u{2795}',
  Home:'\u{1F3E0}', Building:'\u{1F3E2}', Store:'\u{1F3EC}', ShoppingCart:'\u{1F6D2}', ShoppingBag:'\u{1F6CD}\u{FE0F}', CreditCard:'\u{1F4B3}', Wallet:'\u{1F45B}', DollarSign:'\u{1F4B5}', Coins:'\u{1FA99}', Banknote:'\u{1F4B5}',
  Heart:'\u{2764}\u{FE0F}', ThumbsUp:'\u{1F44D}', ThumbsDown:'\u{1F44E}', Flame:'\u{1F525}', Trophy:'\u{1F3C6}', Award:'\u{1F3C5}', Medal:'\u{1F396}\u{FE0F}',
  Cpu:'\u{1F5A5}\u{FE0F}', Monitor:'\u{1F5A5}\u{FE0F}', Laptop:'\u{1F4BB}', Smartphone:'\u{1F4F1}', Tablet:'\u{1F4F1}', Keyboard:'\u{2328}\u{FE0F}', Mouse:'\u{1F5B1}\u{FE0F}', Printer:'\u{1F5A8}\u{FE0F}', Server:'\u{1F5A7}', Database:'\u{1F5C4}\u{FE0F}', Wifi:'\u{1F4F6}', Bluetooth:'\u{1F535}',
  Terminal:'\u{1F4BB}', Code:'\u{1F4BB}', Code2:'\u{1F4BB}', Braces:'{}', Bug:'\u{1F41B}',
  BrainCircuit:'\u{1F9E0}', Brain:'\u{1F9E0}', Bot:'\u{1F916}',
  Sun:'\u{2600}\u{FE0F}', Moon:'\u{1F319}', CloudRain:'\u{1F327}\u{FE0F}', CloudSnow:'\u{1F328}\u{FE0F}', CloudLightning:'\u{26C8}\u{FE0F}', Wind:'\u{1F4A8}', Umbrella:'\u{2602}\u{FE0F}', Thermometer:'\u{1F321}\u{FE0F}',
  Flag:'\u{1F6A9}', Bookmark:'\u{1F516}', Tag:'\u{1F3F7}\u{FE0F}', Tags:'\u{1F3F7}\u{FE0F}', Hash:'#\u{FE0F}\u{20E3}',
  Package:'\u{1F4E6}', Box:'\u{1F4E6}', Truck:'\u{1F69A}', Plane:'\u{2708}\u{FE0F}', Car:'\u{1F697}', Bike:'\u{1F6B4}',
  Edit:'\u{270F}\u{FE0F}', Edit2:'\u{270F}\u{FE0F}', Pencil:'\u{270F}\u{FE0F}', PenTool:'\u{2712}\u{FE0F}', Feather:'\u{1FAB6}', Scissors:'\u{2702}\u{FE0F}', Eraser:'\u{1F9FD}', Paperclip:'\u{1F4CE}',
  List:'\u{1F4CB}', ClipboardList:'\u{1F4CB}', Grid:'\u{25A6}', LayoutGrid:'\u{25A6}', Menu:'\u{2630}',
  AlertTriangle:'\u{26A0}\u{FE0F}', AlertCircle:'\u{26A0}\u{FE0F}', Info:'\u{2139}\u{FE0F}', HelpCircle:'\u{2753}', CheckCircle:'\u{2705}', XCircle:'\u{274C}', Check:'\u{2705}', X:'\u{2716}\u{FE0F}',
  TrendingUp:'\u{1F4C8}', TrendingDown:'\u{1F4C9}', BarChart:'\u{1F4CA}', PieChart:'\u{1F4CA}', LineChart:'\u{1F4C8}', Activity:'\u{1F493}',
  Utensils:'\u{1F374}', Coffee:'\u{2615}', Pizza:'\u{1F355}', Cake:'\u{1F370}', Apple:'\u{1F34E}',
  Gamepad:'\u{1F3AE}', Gamepad2:'\u{1F3AE}', Dice1:'\u{1F3B2}', Puzzle2:'\u{1F9E9}',
  Book:'\u{1F4D6}', BookOpen:'\u{1F4D6}', Library:'\u{1F4DA}', GraduationCap:'\u{1F393}', PenLine:'\u{1F58A}',
  Github:'\u{1F419}', Twitter:'\u{1F426}', Facebook:'\u{1F4D8}', Instagram:'\u{1F4F7}', Youtube:'\u{1F4FA}', Linkedin:'\u{1F4BC}', Slack:'\u{1F4AC}', Discord:'\u{1F4AC}',
  Lightbulb:'\u{1F4A1}', Rocket:'\u{1F680}', Atom:'\u{269B}\u{FE0F}', Leaf:'\u{1F33F}', Sprout:'\u{1F331}', Flower:'\u{1F338}', Heart2:'\u{2764}\u{FE0F}',
};

function pluginIcon(rawIcon) {
  // Returns HTML string for a plugin/workflow icon bubble.
  // Accepts: emoji/unicode char, lucide icon name, or empty.
  const v = (rawIcon ?? '').toString().trim();
  if (!v) return '🧩';
  // If it's already an emoji (contains non-ASCII) or a single symbol, use as-is.
  // Multi-byte or surrogate-pair chars will fail length <= 4 check in ASCII.
  if (/[^\x00-\x7F]/.test(v) && v.length <= 6) return v;
  // Named lucide icon -> emoji map.
  if (LUCIDE_ICON_MAP[v]) return LUCIDE_ICON_MAP[v];
  // Try case-insensitive match.
  const lower = v.toLowerCase();
  const hit = Object.keys(LUCIDE_ICON_MAP).find(k => k.toLowerCase() === lower);
  if (hit) return LUCIDE_ICON_MAP[hit];
  // Fallback: first letter uppercased on puzzle background (rendered separately)
  if (/^[a-zA-Z]+$/.test(v)) return v.charAt(0).toUpperCase();
  return '🧩';
}

function workflowIcon(wf) {
  if (wf?.icon) return pluginIcon(wf.icon);
  // Derive from first step action
  const step0 = wf?.steps?.[0]?.action;
  if (step0 && STEP_ICONS[step0]) return STEP_ICONS[step0];
  return '⚡';
}

// Build the premium Overview tab — KPI cards strip, currently-running
// graph (or last-run preview if idle), and the all-workflows table with
// success-rate bars + run buttons. Pulled out of renderWfBody so the
// live-event handlers below can refresh JUST this tab without rerunning
// expensive list/scheduled paths when the active run mutates.
async function renderWfOverview(body) {
  // Gather both legacy local workflows and engine-tracked ones.
  const allWfs = [...workflows];
  let activeRuns = [];
  try {
    const engineWfs = await H.workflowList();
    for (const ew of engineWfs) {
      if (!allWfs.find(w => w.id === ew.id)) allWfs.push(ew);
    }
  } catch (_) { /* engine optional */ }
  try {
    activeRuns = await H.workflowActiveRuns();
  } catch (_) { /* not running */ }

  // KPI: total / success rate / avg duration / running count.
  const totalRuns = allWfs.reduce((a, w) => a + (w.runCount || 0), 0);
  const totalSuccess = allWfs.reduce((a, w) => a + (w.successCount || (w.runCount || 0)), 0);
  const successRate = totalRuns ? Math.round((totalSuccess / totalRuns) * 100) : 100;
  const avgDur = (() => {
    const wfsWithRuns = allWfs.filter(w => (w.runCount || 0) > 0 && (w.avgDuration || 0) > 0);
    if (!wfsWithRuns.length) return 0;
    return Math.round(wfsWithRuns.reduce((a, w) => a + (w.avgDuration || 0), 0) / wfsWithRuns.length);
  })();
  const lastRunIso = allWfs
    .map(w => w.lastRun)
    .filter(Boolean)
    .sort()
    .pop();
  const runningCount = activeRuns.length;

  // Pick run/wf to show in graph: prefer active, fall back to most-recent.
  let graphRun = activeRuns[0] || wfActiveRun || null;
  let graphWf = null;
  if (graphRun) {
    graphWf = allWfs.find(w => w.id === graphRun.workflowId);
  } else if (lastRunIso) {
    const lastWf = allWfs
      .filter(w => w.lastRun)
      .sort((a, b) => (a.lastRun > b.lastRun ? -1 : 1))[0];
    graphWf = lastWf;
    if (lastWf) {
      graphRun = {
        runId: 'last_' + lastWf.id,
        workflowId: lastWf.id,
        name: lastWf.name,
        startedAt: new Date(lastWf.lastRun).getTime(),
        currentStep: -1,
        totalSteps: (lastWf.steps || []).length,
        steps: (lastWf.steps || []).map(s => ({
          action: s.action || s.type || 'step',
          status: lastWf.lastRunOk === false ? 'pending' : 'done',
          startedAt: null, endedAt: null, error: null
        }))
      };
    }
  }

  const isLive = activeRuns.length > 0;
  const graphStarted = graphRun && graphRun.startedAt
    ? Math.floor((Date.now() - graphRun.startedAt) / 1000)
    : null;

  body.innerHTML = `
    <div class="wfp-shell">
      <!-- KPI strip -->
      <div class="wfp-kpis">
        <div class="wfp-kpi">
          <div class="wfp-kpi-label">Active runs</div>
          <div class="wfp-kpi-value">${runningCount}<span class="wfp-kpi-unit">${runningCount === 1 ? 'workflow' : 'workflows'}</span></div>
          <div class="wfp-kpi-trend ${runningCount > 0 ? 'up' : 'flat'}">${runningCount > 0 ? '● live' : '— idle'}</div>
        </div>
        <div class="wfp-kpi">
          <div class="wfp-kpi-label">Success rate</div>
          <div class="wfp-kpi-value">${successRate}<span class="wfp-kpi-unit">%</span></div>
          <div class="wfp-kpi-trend ${successRate >= 90 ? 'up' : successRate >= 60 ? 'flat' : 'down'}">${totalRuns} ${totalRuns === 1 ? 'run' : 'runs'} total</div>
        </div>
        <div class="wfp-kpi">
          <div class="wfp-kpi-label">Avg duration</div>
          <div class="wfp-kpi-value">${avgDur ? _wfFmtTime(avgDur).split(/(\d+)/).slice(1).join('') ? _wfFmtTime(avgDur) : '—' : '—'}</div>
          <div class="wfp-kpi-trend flat">across stored runs</div>
        </div>
        <div class="wfp-kpi">
          <div class="wfp-kpi-label">Last run</div>
          <div class="wfp-kpi-value" style="font-size:18px">${_wfFmtRel(lastRunIso)}</div>
          <div class="wfp-kpi-trend flat">${allWfs.length} ${allWfs.length === 1 ? 'workflow' : 'workflows'} stored</div>
        </div>
      </div>

      <!-- Live-run graph -->
      <div class="wfp-live ${isLive ? '' : 'idle'}" id="wfp-live">
        <div class="wfp-live-h">
          <div class="wfp-live-title">
            <span class="wfp-live-eyebrow">${isLive ? 'Currently running' : 'Last run'}</span>
            ${graphWf ? '<span>' + (graphWf.name || 'Workflow') + '</span>' : '<span style="color:var(--t3)">No runs yet</span>'}
          </div>
          <div class="wfp-live-meta">
            ${graphRun ? `<span>step ${Math.max(0, graphRun.currentStep + 1)}/${graphRun.totalSteps || 1}</span>` : ''}
            ${graphStarted !== null && isLive ? `<span>· ${graphStarted}s elapsed</span>` : ''}
          </div>
        </div>
        <div class="wfp-graph">
          ${graphRun ? renderWfGraph(graphRun) : '<div style="color:var(--t3); font:12px var(--font); padding:30px 0; text-align:center; width:100%">Run a workflow to see its graph here.</div>'}
        </div>
      </div>

      <!-- All-workflows table -->
      <div class="wfp-table">
        <div class="wfp-table-h">
          <h3 style="display:flex;align-items:center;gap:6px"><svg class="licon"><use href="#i-zap"/></svg> All workflows</h3>
          <span class="wfp-count">${allWfs.length} TOTAL</span>
        </div>
        ${allWfs.length === 0
          ? '<div style="padding:40px 20px; text-align:center; color:var(--t3); font:12px var(--font)">No workflows yet — head to <a onclick="wfTab(\'create\')" style="color:var(--acc); cursor:pointer">Create</a> to build your first one.</div>'
          : allWfs.map(wf => renderWfRow(wf)).join('')
        }
      </div>
    </div>
  `;
}

function renderWfGraph(run) {
  const steps = run.steps || [];
  if (!steps.length) return '<div style="color:var(--t3); padding:20px">Workflow has no steps.</div>';
  return steps.map((s, i) => {
    const cls = s.status === 'running' ? 'running'
              : s.status === 'done'    ? 'done'
              : s.status === 'failed'  ? 'failed'
              : '';
    const node = `<div class="wfp-node ${cls}">
      <div class="wfp-node-icon">${STEP_ICONS[s.action] || '▶️'}</div>
      <div class="wfp-node-label">${_wfStepLabel(s.action)}</div>
      <div class="wfp-node-sub">${_wfStepKind(s.action)}</div>
    </div>`;
    if (i === steps.length - 1) return node;
    const nextStatus = (steps[i + 1] || {}).status;
    let edgeCls = '';
    if (s.status === 'done' && (nextStatus === 'pending' || nextStatus === 'running')) edgeCls = 'active';
    else if (s.status === 'done') edgeCls = 'done';
    return node + `<div class="wfp-edge ${edgeCls}"></div>`;
  }).join('');
}

function renderWfRow(wf) {
  const runs = wf.runCount || 0;
  const successCt = wf.successCount != null ? wf.successCount : runs;
  const rate = runs ? Math.round((successCt / runs) * 100) : (runs === 0 ? null : 100);
  const rateCls = rate == null ? 'flat' : (rate >= 90 ? 'ok' : rate >= 60 ? 'warn' : 'fail');
  const trig = _wfTriggerKind(wf.trigger);
  const wfId = (wf.id || '').replace(/'/g, "\\'");
  return `
    <div class="wfp-table-row">
      <div class="wfp-table-name">
        <div class="wfp-ricon">${workflowIcon(wf)}</div>
        <div style="min-width:0">
          <div class="wfp-rname">${(wf.name || 'Untitled').replace(/[<>]/g,'')}</div>
          <div class="wfp-rdesc">${(wf.description || (wf.steps?.length || 0) + ' steps').replace(/[<>]/g,'')}</div>
        </div>
      </div>
      <span class="wfp-trigger-pill ${trig.cls}">${trig.label}</span>
      <div class="wfp-rate">
        ${rate == null
          ? '<div class="wfp-rate-meta"><span style="color:var(--t3)">no runs yet</span></div>'
          : `<div class="wfp-rate-bar"><div class="wfp-rate-fill ${rateCls === 'fail' ? 'fail' : rateCls === 'warn' ? 'warn' : ''}" style="width:${rate}%"></div></div>
             <div class="wfp-rate-meta"><span>${rate}% success</span><span>${runs} ${runs === 1 ? 'run' : 'runs'}</span></div>`
        }
      </div>
      <div class="wfp-last">
        ${wf.lastRun
          ? `<span>${_wfFmtRel(wf.lastRun)}</span>${wf.avgDuration ? `<br/><span class="wfp-last-mute">${_wfFmtTime(wf.avgDuration)} avg</span>` : ''}`
          : '<span class="wfp-last-mute">never</span>'
        }
      </div>
      <div class="wfp-row-actions">
        <button class="wfp-btn run" onclick="runWorkflowById('${wfId}')" title="Run now"><svg class="licon" style="vertical-align:-2px"><use href="#i-play"/></svg> Run</button>
        <button class="wfp-btn del" onclick="deleteWorkflowById('${wfId}')" title="Delete" aria-label="Delete"><svg class="licon" style="vertical-align:-2px"><use href="#i-x"/></svg></button>
      </div>
    </div>
  `;
}

// Subscribe to live-run events once. The handlers update wfActiveRun and
// re-render JUST the Overview tab if the user is looking at it.
(function _bindWfLiveEvents() {
  if (typeof H === 'undefined') return;
  if (typeof H.onWorkflowRunningStart === 'function') {
    H.onWorkflowRunningStart((p) => {
      wfActiveRun = p;
      if (wfCurrentTab === 'overview' && document.getElementById('wf-panel')?.classList.contains('show')) {
        renderWfBody().catch(() => {});
      }
    });
  }
  if (typeof H.onWorkflowRunningStep === 'function') {
    H.onWorkflowRunningStep((p) => {
      if (wfActiveRun && wfActiveRun.runId === p.runId && wfActiveRun.steps?.[p.stepIndex]) {
        wfActiveRun.steps[p.stepIndex].status = p.status;
        wfActiveRun.currentStep = p.stepIndex;
        // Cheap targeted refresh of the graph node — no full body rerender.
        if (wfCurrentTab === 'overview' && document.getElementById('wf-panel')?.classList.contains('show')) {
          const live = document.getElementById('wfp-live');
          if (live) {
            const graph = live.querySelector('.wfp-graph');
            if (graph) graph.innerHTML = renderWfGraph(wfActiveRun);
          }
        }
      }
    });
  }
  if (typeof H.onWorkflowRunningEnd === 'function') {
    H.onWorkflowRunningEnd((p) => {
      // Mark last run done; trigger one full refresh so KPIs update.
      wfActiveRun = null;
      if (wfCurrentTab === 'overview' && document.getElementById('wf-panel')?.classList.contains('show')) {
        renderWfBody().catch(() => {});
      }
    });
  }
})();

async function renderWfBody() {
  const body = document.getElementById('wf-body');
  if (wfCurrentTab === 'overview') {
    await renderWfOverview(body);
    return;
  }
  if (wfCurrentTab === 'list') {
    // Use both local and engine workflows
    const allWfs = [...workflows];
    try {
      const engineWfs = await H.workflowList();
      for (const ew of engineWfs) {
        if (!allWfs.find(w => w.id === ew.id)) allWfs.push(ew);
      }
    } catch(_) {}
    if (!allWfs.length) {
      body.innerHTML = `
        <div class="empty-state">
          <div class="es-icon"><svg class="licon lg"><use href="#i-zap"/></svg></div>
          <h3>${lang === 'ru' ? 'Нет workflow' : 'No workflows yet'}</h3>
          <p>${lang === 'ru' ? 'Создай свой первый workflow или опиши его чату — AI создаст его автоматически.' : 'Create your first workflow or describe it in chat — AI will build it automatically.'}</p>
          <div class="wf-examples">
            <div class="wf-example" onclick="wfQuickCreate('Open YouTube and close it after 10 seconds')">YouTube open/close</div>
            <div class="wf-example" onclick="wfQuickCreate('Take a screenshot and save it')">Screenshot</div>
            <div class="wf-example" onclick="wfQuickCreate('Open Google and search for the weather')">Google search</div>
            <div class="wf-example" onclick="wfQuickCreate('Send me a daily morning notification at 9 AM')">Morning reminder</div>
          </div>
          <button class="sc-btn primary" style="margin-top:16px" onclick="wfTab('create')">Create Workflow</button>
        </div>
      `;
      return;
    }
    body.innerHTML = `<div class="wf-list">${allWfs.map(wf => `
      <div class="wf-card">
        <div class="wf-head">
          <div class="wf-icon">${workflowIcon(wf)}</div>
          <div class="wf-info">
            <div class="wf-name">${wf.name}</div>
            <div class="wf-desc">${wf.description || (wf.steps?.length || 0) + ' steps'}</div>
          </div>
        </div>
        <div class="wf-steps">${(wf.steps||[]).slice(0,5).map(s => `<div class="wf-step"><span class="wf-step-icon">${STEP_ICONS[s.action]||'▶️'}</span>${s.action}</div>`).join('')}${(wf.steps||[]).length > 5 ? `<div class="wf-step">+${wf.steps.length-5} more</div>` : ''}</div>
        <div class="wf-footer">
          <div class="wf-trigger">Trigger: <span class="wf-trigger-badge">${wf.trigger || 'manual'}</span></div>
          <div class="wf-actions">
            <button class="wf-btn run" onclick="runWorkflowById('${wf.id}')"><svg class="licon" style="vertical-align:-2px"><use href="#i-play"/></svg> Run</button>
            <button class="wf-btn" onclick="shareWorkflow('${wf.id}')">Share</button>
            <button class="wf-btn del" onclick="deleteWorkflowById('${wf.id}')">Delete</button>
          </div>
        </div>
      </div>
    `).join('')}</div>`;
  } else if (wfCurrentTab === 'create') {
    body.innerHTML = `
      <div class="wf-create">
        <h3 style="display:flex;align-items:center;gap:6px"><svg class="licon"><use href="#i-sparkles"/></svg> Create Workflow with AI</h3>
        <div class="wf-field">
          <label>Describe what you want to automate</label>
          <textarea class="wf-textarea" id="wf-desc-input" placeholder="e.g. Open YouTube, wait 5 seconds, then close it"></textarea>
        </div>
        <button class="wf-ai-btn" id="wf-generate-btn" onclick="createWfFromAI()"><svg class="licon" style="vertical-align:-2px"><use href="#i-bot"/></svg> Generate with AI</button>
        <div style="font-size:10px;color:var(--t3);margin-bottom:14px">Or create manually:</div>
        <div class="wf-field"><label>Workflow Name</label><input class="wf-input" id="wf-name-input" placeholder="My Workflow"/></div>
        <div class="wf-field">
          <label>Trigger</label>
          <select class="wf-input" id="wf-trigger-input">
            <option value="manual">Manual (run on demand)</option>
            <option value="schedule">Scheduled (daily time)</option>
            <option value="startup">On startup</option>
          </select>
        </div>
        <div class="wf-field" id="wf-cron-field" style="display:none">
          <label>Daily time (HH:MM)</label>
          <input class="wf-input" id="wf-cron-input" placeholder="09:00"/>
        </div>
        <div class="wf-field">
          <label>No-code steps</label>
          <div style="display:grid;grid-template-columns:170px 1fr 1fr auto;gap:8px;align-items:center">
            <select class="wf-input" id="wf-step-action" onchange="updateWfStepBuilderHints()">
              <option value="open_url">Open URL</option>
              <option value="open_app">Open app</option>
              <option value="close_app">Close app</option>
              <option value="notify">Notify</option>
              <option value="speak">Speak</option>
              <option value="send_message">Send chat message</option>
              <option value="screenshot">Screenshot</option>
              <option value="wait">Wait</option>
              <option value="type_text">Type text</option>
              <option value="press_key">Press key</option>
              <option value="shell">Shell command</option>
              <option value="run_code">Run code</option>
            </select>
            <input class="wf-input" id="wf-step-param-a" placeholder="url / app / text / command"/>
            <input class="wf-input" id="wf-step-param-b" placeholder="optional"/>
            <button class="wf-btn run" onclick="addWfStepFromBuilder()" type="button">Add</button>
          </div>
          <div id="wf-step-builder-list" style="margin-top:8px;display:flex;flex-direction:column;gap:6px"></div>
        </div>
        <div class="wf-field">
          <label>Advanced JSON (auto-filled from no-code steps)</label>
          <textarea class="wf-textarea" id="wf-steps-input" style="min-height:120px" placeholder='[{"action":"open_url","args":{"url":"https://youtube.com"}},{"action":"wait","args":{"ms":5000}},{"action":"notify","args":{"message":"Done!"}}]'></textarea>
        </div>
        <button class="wf-ai-btn" onclick="createWfManual()">Create Workflow</button>
        <div class="wf-examples">
          <div class="wf-example" onclick="fillWfExample('youtube')">YouTube open/close</div>
          <div class="wf-example" onclick="fillWfExample('screenshot')">Screenshot + notify</div>
          <div class="wf-example" onclick="fillWfExample('morning')">Morning routine</div>
          <div class="wf-example" onclick="fillWfExample('search')">Google search</div>
        </div>
      </div>
    `;
    document.getElementById('wf-trigger-input').addEventListener('change', function() {
      document.getElementById('wf-cron-field').style.display = this.value === 'schedule' ? 'block' : 'none';
    });
    wfDraftSteps = [];
    updateWfStepBuilderHints();
    renderWfDraftSteps();
  } else if (wfCurrentTab === 'scheduled') {
    body.innerHTML = `
      <div style="margin-bottom:16px">
        <div style="font-size:13px;font-weight:700;color:var(--tx);margin-bottom:6px">⏰ Scheduled Workflows</div>
        <div style="font-size:11px;color:var(--t3)">Scheduled and interval workflows run automatically in the background.</div>
      </div>
      <div id="scheduled-list">Loading...</div>
    `;
    try {
      const all = [...workflows];
      try { const ew = await H.workflowList(); for (const w of ew) if (!all.find(x => x.id === w.id)) all.push(w); } catch(_) {}
      const scheduled = all.filter(w => w.trigger && w.trigger !== 'manual');
      const el = document.getElementById('scheduled-list');
      if (!scheduled.length) {
        el.innerHTML = `<div class="empty-state"><div class="es-icon">⏰</div><h3>No scheduled workflows</h3><p>Create a workflow with a daily time or interval trigger to run it automatically.</p></div>`;
      } else {
        el.innerHTML = scheduled.map(w => `
          <div class="wf-card">
            <div class="wf-head">
              <div class="wf-icon">${workflowIcon(w)}</div>
              <div class="wf-info">
                <div class="wf-name">${w.name}</div>
                <div class="wf-desc">Trigger: ${w.trigger}</div>
              </div>
            </div>
            <div class="wf-footer">
              <div class="wf-trigger"><span class="wf-trigger-badge">${w.trigger}</span></div>
              <div class="wf-actions">
                <button class="wf-btn run" onclick="runWorkflowById('${w.id}')">Run Now</button>
                <button class="wf-btn del" onclick="deleteWorkflowById('${w.id}')">Delete</button>
              </div>
            </div>
          </div>
        `).join('');
      }
    } catch(e) { document.getElementById('scheduled-list').innerHTML = `<div style="color:var(--red)">${e.message}</div>`; }
  }
}

var wfDraftSteps = [];

function updateWfStepBuilderHints() {
  const action = document.getElementById('wf-step-action')?.value || 'open_url';
  const a = document.getElementById('wf-step-param-a');
  const b = document.getElementById('wf-step-param-b');
  if (!a || !b) return;
  const hints = {
    open_url: ['https://example.com', ''],
    open_app: ['chrome / code / Spotify', ''],
    close_app: ['chrome / msedge / Spotify', ''],
    notify: ['Message', 'Title (optional)'],
    speak: ['Text to speak', ''],
    send_message: ['Message to send to Horizon', ''],
    screenshot: ['Optional note', ''],
    wait: ['Seconds or ms', ''],
    type_text: ['Text to type', ''],
    press_key: ['ENTER / ^s / {TAB}', ''],
    shell: ['Command', ''],
    run_code: ['Code or command', 'language: node/shell']
  };
  a.placeholder = hints[action]?.[0] || 'value';
  b.placeholder = hints[action]?.[1] || 'optional';
}

function stepFromBuilderInput() {
  const action = document.getElementById('wf-step-action')?.value || 'open_url';
  const a = document.getElementById('wf-step-param-a')?.value.trim() || '';
  const b = document.getElementById('wf-step-param-b')?.value.trim() || '';
  const args = {};
  if (action === 'open_url') args.url = a;
  else if (action === 'open_app' || action === 'close_app') args.app = a;
  else if (action === 'notify') { args.message = a; if (b) args.title = b; }
  else if (action === 'speak' || action === 'send_message' || action === 'type_text') args.text = a;
  else if (action === 'screenshot') { if (a) args.note = a; }
  else if (action === 'wait') args.ms = /^\d+$/.test(a) && Number(a) < 1000 ? Number(a) * 1000 : Number(a || 1000);
  else if (action === 'press_key') args.key = a;
  else if (action === 'shell') args.command = a;
  else if (action === 'run_code') { args.code = a; if (b) args.language = b.replace(/^language:\s*/i, ''); }
  return { action, args };
}

function syncWfStepsTextarea() {
  const ta = document.getElementById('wf-steps-input');
  if (ta) ta.value = JSON.stringify(wfDraftSteps, null, 2);
}

function renderWfDraftSteps() {
  const el = document.getElementById('wf-step-builder-list');
  if (!el) return;
  if (!wfDraftSteps.length) {
    el.innerHTML = '<div style="font-size:10px;color:var(--t3)">No steps yet. Pick an action and press Add.</div>';
    syncWfStepsTextarea();
    return;
  }
  el.innerHTML = wfDraftSteps.map((s, i) => `
    <div class="wf-step" style="justify-content:space-between">
      <span>${i + 1}. ${escHtml(s.action)} <span style="color:var(--t3)">${escHtml(JSON.stringify(s.args || {})).slice(0, 120)}</span></span>
      <button class="wf-btn del" onclick="removeWfDraftStep(${i})" type="button">x</button>
    </div>
  `).join('');
  syncWfStepsTextarea();
}

function addWfStepFromBuilder() {
  const step = stepFromBuilderInput();
  const value = Object.values(step.args || {}).find(v => String(v || '').trim());
  if (!value && !['wait'].includes(step.action)) {
    H.notify?.('Workflows', 'Fill the main field for this step.');
    return;
  }
  wfDraftSteps.push(step);
  const a = document.getElementById('wf-step-param-a');
  const b = document.getElementById('wf-step-param-b');
  if (a) a.value = '';
  if (b) b.value = '';
  renderWfDraftSteps();
}

function removeWfDraftStep(i) {
  wfDraftSteps.splice(i, 1);
  renderWfDraftSteps();
}

async function createWfFromAI() {
  const desc = document.getElementById('wf-desc-input').value.trim();
  if (!desc) { H.notify('Workflows', 'Please describe the workflow'); return; }
  const descEl = document.getElementById('wf-desc-input');
  const btn = document.getElementById('wf-generate-btn');
  descEl.disabled = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }
  const wf = await createWorkflowFromText(desc);
  if (wf) {
    wfTab('list');
  } else {
    descEl.disabled = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="licon" style="vertical-align:-2px"><use href="#i-bot"/></svg> Generate with AI'; }
  }
}

async function createWfManual() {
  const name = document.getElementById('wf-name-input').value.trim() || 'My Workflow';
  const trigger = document.getElementById('wf-trigger-input').value;
  const cron = document.getElementById('wf-cron-input')?.value.trim() || '';
  const stepsRaw = document.getElementById('wf-steps-input').value.trim();
  let steps = [];
  try { steps = JSON.parse(stepsRaw || '[]'); } catch(e) { H.notify('Workflows', 'Invalid JSON in steps'); return; }
  const finalTrigger = trigger === 'schedule' ? normaliseWorkflowTrigger(cron || 'manual') : normaliseWorkflowTrigger(trigger);
  try {
    const r = await H.workflowCreate(name, finalTrigger, steps, '');
    if (!r || r.ok === false) throw new Error(r?.error || 'Workflow engine create failed');
    await loadWorkflows();
  } catch(e) {
    console.warn('workflowCreate failed, falling back to local store:', e?.message || e);
    createWorkflow(name, steps, finalTrigger);
  }
  addMsg('bot', lang === 'ru' ? `⚡ Workflow **${name}** создан!` : `⚡ Workflow **${name}** created!`);
  wfTab('list');
}

var WF_EXAMPLES = {
  youtube: { name: 'YouTube Open & Close', trigger: 'manual', steps: [{action:'open_url',args:{url:'https://youtube.com'}},{action:'wait',args:{ms:10000}},{action:'notify',args:{message:'Closing YouTube now'}},{action:'run_code',args:{code:'require("child_process").exec("taskkill /F /IM chrome.exe")',language:'node'}}] },
  screenshot: { name: 'Screenshot & Notify', trigger: 'manual', steps: [{action:'notify',args:{message:'Taking screenshot...'}},{action:'screenshot',args:{}},{action:'notify',args:{message:'Screenshot saved!'}}] },
  morning: { name: 'Morning Routine', trigger: 'schedule:09:00', steps: [{action:'notify',args:{message:'Good morning! Time to start your day.'}},{action:'speak',args:{text:'Good morning! Here is your daily briefing.'}},{action:'send_message',args:{text:'Give me a morning briefing with weather and tasks'}}] },
  search: { name: 'Google Search', trigger: 'manual', steps: [{action:'open_url',args:{url:'https://google.com'}},{action:'wait',args:{ms:1000}},{action:'notify',args:{message:'Google opened!'}}] }
};

function fillWfExample(key) {
  const ex = WF_EXAMPLES[key];
  if (!ex) return;
  document.getElementById('wf-name-input').value = ex.name;
  document.getElementById('wf-trigger-input').value = ex.trigger.startsWith('cron:') ? 'schedule' : ex.trigger;
  if (ex.trigger.startsWith('schedule:') || ex.trigger.startsWith('cron:')) {
    document.getElementById('wf-trigger-input').value = 'schedule';
    document.getElementById('wf-cron-field').style.display = 'block';
    document.getElementById('wf-cron-input').value = normaliseWorkflowTrigger(ex.trigger).replace('schedule:','');
  }
  document.getElementById('wf-steps-input').value = JSON.stringify(ex.steps, null, 2);
  wfDraftSteps = [...ex.steps];
  renderWfDraftSteps();
}

async function wfQuickCreate(desc) {
  closeWorkflows();
  await createWorkflowFromText(desc);
  openWorkflows();
}

async function runWorkflowById(id) {
  const panelOpen = document.getElementById('wf-panel')?.classList.contains('show');
  try {
    if (panelOpen) {
      H.notify?.('Workflows', 'Running workflow...');
      wfCurrentTab = 'overview';
      await renderWfBody();
    } else {
      closeWorkflows();
    }
    const r = await H.workflowRun?.(id);
    if (!r || r.ok === false) {
      addMsg('bot', `Workflow error: ${(r && r.error) || 'could not run workflow'}`);
      if (panelOpen) await renderWfBody();
      return;
    }
    await handleWorkflowRunEffects(r);
    const label = r.workflowName || id;
    const stepSummary = Array.isArray(r.results)
      ? '\n' + r.results.map((x, idx) => `${idx + 1}. ${x.step || 'step'} - ${x.ok === false ? 'failed' : 'ok'}`).join('\n')
      : '';
    addMsg('bot', `Workflow **${label}** complete in ${Math.round((r.duration || 0) / 1000)}s.${stepSummary}`);
    await loadWorkflows();
    if (panelOpen) await renderWfBody();
  } catch (e) {
    addMsg('bot', `Workflow error: ${e?.message || e || 'workflow engine failed'}`);
    if (panelOpen) await renderWfBody();
  }
}

async function handleWorkflowRunEffects(runResult) {
  const results = Array.isArray(runResult?.results) ? runResult.results : [];
  // Accept only paths that match the engine's own filename convention
  // (`workflow-<digits>.png`). This prevents a malicious or mis-coded
  // step from getting an arbitrary file path rendered or surfaced as
  // a message — addCard / addMsg get only sanitized values.
  const SAFE_PATH = /^[\w\-/\\:.]+workflow-\d+\.png$/i;
  const sanitizePath = (p) => {
    const s = String(p || '');
    if (!s) return '';
    if (s.length > 400) return '';
    return SAFE_PATH.test(s) ? s : '';
  };
  for (const item of results) {
    const res = item?.result || {};
    const out = String(res.out || '');
    if (out.startsWith('message:')) {
      const text = out.slice('message:'.length).trim();
      if (text) addMsg('bot', text);
      continue;
    }
    if (out.startsWith('speak:')) {
      const text = out.slice('speak:'.length).trim();
      if (text) {
        addMsg('bot', text);
        try { if (ttsOn) speak(text.slice(0, 400)); } catch (_) {}
      }
      continue;
    }
    if (res.base64) {
      // base64 is rendered inline — path is just a label hint, sanitize it
      // so a malicious step can't poison the card's stored URL.
      addCard('Workflow screenshot', sanitizePath(res.path), res.base64);
      continue;
    }
    const safe = sanitizePath(res.path);
    if (safe) {
      addMsg('bot', `Screenshot saved: \`${safe}\``);
    } else if (res.path) {
      // Engine returned a path that doesn't match our convention — log
      // but don't render. Helps catch step regressions without exposing
      // unverified paths to the user.
      console.warn('[workflow] ignoring unrecognised screenshot path:', String(res.path).slice(0, 200));
    }
  }
}

async function deleteWorkflowById(id) {
  deleteWorkflow(id);
  try { await H.workflowDelete(id); } catch(_) {}
  renderWfBody();
}

async function shareWorkflow(id) {
  const wf = workflows.find(w => w.id === id);
  if (!wf) return;
  const data = btoa(JSON.stringify(wf));
  const url = `horizon://workflow/${data}`;
  await H.copy(url);
  H.notify('Workflows', 'Share URL copied to clipboard!');
}


