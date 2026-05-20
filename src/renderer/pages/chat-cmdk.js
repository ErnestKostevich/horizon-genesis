// PR-V Phase 3.4 — Command Palette (Ctrl+K) module.
// Extracted from chat.html inline <script> (was lines 5139-5386).
// Behaviour identical. Loaded as external script AFTER main inline
// + extracted dependencies so window.* globals it reads (lang, prov,
// MODEL_PICKER_REGISTRY, openModelPicker, openPersonaPicker,
// openModePicker, openPanel, addMsg, etc.) are defined.
//
// Contains:
//   - COMMANDS static array (built-in actions)
//   - cmdActiveIdx (active item index)
//   - openCmdPalette / closeCmdPalette
//   - _paletteDynamicItems (PR-LAYOUT-V3 slimmed: 3 "Switch X…"
//     entries that delegate to the dedicated pickers instead of
//     dumping every provider × every model as flat rows)
//   - filterCommands (fuzzy filter + group rendering)
//   - highlightCmd, scrollActiveCmdIntoView, cmdKeyDown (kbd nav)
//   - runCommand (action dispatch)
//   - Global Ctrl+K / Ctrl+Shift+M (Model) / Ctrl+Shift+P (Persona)
//     keyboard shortcuts (document.addEventListener at file load).

// ═══════════════════════════════════════════════════════════════
// COMMAND PALETTE (Ctrl+K) — instant access to all features
// ═══════════════════════════════════════════════════════════════
// Sprint-2 fix — was emoji-per-command. Now each item carries a
// lucide-symbol id (resolved against the <symbol> library at the top
// of chat.html). _renderCmdIcon(c) renders the matching <svg>.
function _cmdIconHtml(item) {
  if (item && item.iconId) {
    return '<svg class="licon"><use href="#' + item.iconId + '"/></svg>';
  }
  return '';
}
var COMMANDS = [
  { iconId:'i-bot',         text:'Agent Mode',         hint:'autonomous',        action:()=>setMode('agent') },
  { iconId:'i-message',     text:'Chat Mode',          hint:'conversation',      action:()=>setMode('chat') },
  { iconId:'i-eye',         text:'Vision Mode',        hint:'screen analysis',   action:()=>setMode('vision') },
  { iconId:'i-code',        text:'Code Mode',          hint:'programming',       action:()=>setMode('code') },
  { iconId:'i-target',      text:'Focus Mode',         hint:'deep work',         action:()=>setMode('focus') },
  { iconId:'i-clipboard',   text:'Plan Mode',          hint:'task planning',     action:()=>setMode('plan') },
  { iconId:'i-trophy',      text:'Coach Mode',         hint:'motivation',        action:()=>setMode('coach') },
  { iconId:'i-pen',         text:'Write Mode',         hint:'content',           action:()=>setMode('write') },
  { iconId:'i-mail',        text:'Email Mode',         hint:'compose',           action:()=>setMode('email') },
  { iconId:'i-search',      text:'Search Mode',        hint:'web search',        action:()=>setMode('search') },
  { iconId:'i-globe',       text:'Translate',          hint:'languages',         action:()=>setMode('translate') },
  { iconId:'i-drama',       text:'Roleplay',           hint:'creative',          action:()=>setMode('roleplay') },
  { iconId:'i-eye',         text:'Take Screenshot',    hint:'capture screen',    action:async()=>{const r=await H.pcScreenshot();if(r.ok)addCard(lang==='ru'?'Скриншот':'Screenshot','',r.base64);} },
  { iconId:'i-settings',    text:'System Info',        hint:'PC status',         action:async()=>{const r=await H.getDetailedSysInfo();addMsg('bot','```json\n'+JSON.stringify(r,null,2)+'\n```');} },
  { iconId:'i-layout',      text:'Running Apps',       hint:'processes',         action:async()=>{const r=await H.getRunningApps();addCard('Apps',r.out||'');} },
  { iconId:'i-clipboard',   text:'Clipboard Content',  hint:'paste',             action:async()=>{const r=await H.getClipboard();addCard('Clipboard',r||'(empty)');} },
  { iconId:'i-brain',       text:'Memory — Recent',    hint:'recall',            action:async()=>{const r=await H.memGetRecent(10);addMsg('bot','**Recent Memories:**\n'+r.map(m=>'- '+m.content).join('\n'));} },
  { iconId:'i-file-text',   text:'Memory — Facts',     hint:'stored facts',      action:async()=>{const r=await H.memGetFacts();addMsg('bot','**Facts:**\n```json\n'+JSON.stringify(r,null,2)+'\n```');} },
  { iconId:'i-trending-up', text:'Nutrition Today',    hint:'food tracking',     action:async()=>{const r=await H.nutritionToday();addMsg('bot','**Today\'s Nutrition:**\nCalories: '+r.total.calories+'\nProtein: '+r.total.protein+'g\nCarbs: '+r.total.carbs+'g\nFat: '+r.total.fat+'g\nMeals: '+r.meals.length);} },
  { iconId:'i-clock',       text:'Focus Timer (25 min)', hint:'pomodoro',        action:()=>startFocusTimer(25) },
  { iconId:'i-clock',       text:'Focus Timer (10 min)', hint:'short',           action:()=>startFocusTimer(10) },
  { iconId:'i-sunrise',     text:'Toggle Wake Word',   hint:'voice activate',    action:()=>toggleWake() },
  { iconId:'i-eye',         text:'Toggle Ambient Mode', hint:'screen watch',     action:()=>toggleAmbient() },
  { iconId:'i-bell',        text:'Toggle Notifications', hint:'briefing',        action:()=>toggleNotifications() },
  { iconId:'i-sun',         text:'Daily Briefing Now', hint:'weather+calendar',  action:()=>requestBriefing() },
  { iconId:'i-zap',         text:'Create Workflow',    hint:'no-code automation',action:()=>{closeCmdPalette();const inp=document.getElementById('inp');inp.value=lang==='ru'?'Создай workflow: ':'Create workflow: ';inp.focus();} },
  { iconId:'i-workflow',    text:'List Workflows',     hint:'show all',          action:()=>{addMsg('bot',workflows.length?(lang==='ru'?'**Workflows:**\n':'**Workflows:**\n')+workflows.map(w=>`- **${w.name}** (${w.steps.length} steps) [ID: ${w.id}]`).join('\n'):(lang==='ru'?'Нет workflows. Создай командой.':'No workflows. Create one.'));} },
  { iconId:'i-clipboard',   text:'Analyze Clipboard',  hint:'smart paste',       action:()=>analyzeClipboard() },
  { iconId:'i-trash',       text:'Clear Chat',         hint:'reset',             action:()=>clearHist() },
  { iconId:'i-settings',    text:'Settings',           hint:'configure',         action:()=>openPanel() },
  { iconId:'i-book',        text:'Skill Hub',          hint:'browse/edit SKILL.md bundles', action:()=>{ try { closeCmdPalette(); window.openSkillHub?.(); } catch(_){} } },
];
var cmdActiveIdx = 0;

function openCmdPalette() {
  const el = document.getElementById('cmd-palette');
  el.classList.add('show');
  const inp = document.getElementById('cmd-input');
  inp.value = '';
  inp.focus();
  cmdActiveIdx = 0;
  filterCommands('');
}

function closeCmdPalette() {
  document.getElementById('cmd-palette').classList.remove('show');
}

// PR-U2 — dynamic palette items (built per-open so model lists /
// chat list / personas always reflect current state). Grouped under
// section headers when no query is active; flat ranked list when the
// user types. Each item is { group, icon, text, hint, action }.
function _paletteDynamicItems() {
  const dyn = [];
  // PR-LAYOUT-V3 — was: dump EVERY provider × EVERY model combo as a
  // flat list (~100+ rows, OpenRouter alone has 200+ models). This made
  // the palette unusable for anything else because the model rows
  // dominated the result list, and the popover stretched to the bottom
  // of the screen with no way to switch model intelligently. Now: ONE
  // "Switch model…" entry that defers to the dedicated model picker
  // (full search, grouped by provider, the right UI for 200+ items).
  // Same approach for personas — the persona picker handles selection.
  dyn.push({
    group: 'Switch',
    iconId: 'i-brain',
    text: 'Switch model…',
    hint: 'open the model picker (one switcher for every provider)',
    action: () => { try { closeCmdPalette(); openModelPicker({ stopPropagation: ()=>{}, currentTarget: document.getElementById('composer-model-chip') }); } catch(_){} }
  });
  dyn.push({
    group: 'Switch',
    iconId: 'i-drama',
    text: 'Switch persona…',
    hint: 'open the persona picker',
    action: () => { try { closeCmdPalette(); openPersonaPicker({ stopPropagation: ()=>{}, currentTarget: document.getElementById('composer-persona-chip') }); } catch(_){} }
  });
  dyn.push({
    group: 'Switch',
    iconId: 'i-zap',
    text: 'Switch mode…',
    hint: 'open the mode picker (Chat / Code / Agent / Vision / 8 niche)',
    action: () => { try { closeCmdPalette(); openModePicker({ stopPropagation: ()=>{}, currentTarget: document.getElementById('composer-mode-chip') }); } catch(_){} }
  });
  // ── Chat list (last 8) ──
  try {
    if (Array.isArray(window.chatList)) {
      for (const c of window.chatList.slice(0, 8)) {
        const title = c?.title || 'New chat';
        dyn.push({
          group: 'Switch chat',
          iconId: 'i-message',
          text: title.slice(0, 60),
          hint: c?.id ? `chat-${c.id.slice(0, 8)}` : '',
          action: () => { try { switchChat?.(c.id); } catch(_){} }
        });
      }
    }
  } catch(_){}
  // ── Settings tabs ──
  for (const [tab, lbl] of [
    ['account','Account'], ['profile','Profile'], ['models','Models'],
    ['providers','Providers'], ['connections','Connections'], ['voice','Voice & Wake'],
    ['features','Features'], ['personas','Personas'], ['plugins','Plugins'], ['data','Data & Health']
  ]) {
    dyn.push({
      group: 'Open settings',
      iconId: 'i-settings',
      text: `Settings · ${lbl}`,
      hint: `open ${tab} tab`,
      action: () => { try { openPanel(tab); } catch(_){} }
    });
  }
  return dyn;
}

function filterCommands(query) {
  const q = query.toLowerCase().trim();
  const allItems = COMMANDS.map(c => ({ ...c, group: c.group || 'Action' }))
    .concat(_paletteDynamicItems());

  let filtered;
  if (q) {
    // Ranked: prefix > substring in text > substring in hint
    const scored = allItems.map(c => {
      const tlc = c.text.toLowerCase();
      const hlc = (c.hint || '').toLowerCase();
      const glc = (c.group || '').toLowerCase();
      let score = 0;
      if (tlc.startsWith(q)) score = 1000;
      else if (tlc.includes(q)) score = 500 - tlc.indexOf(q);
      else if (hlc.includes(q)) score = 200;
      else if (glc.includes(q)) score = 100;
      return { c, score };
    }).filter(x => x.score > 0);
    scored.sort((a, b) => b.score - a.score);
    filtered = scored.slice(0, 60).map(x => x.c);
  } else {
    // No query → group by section, cap each to 6 entries.
    const groups = new Map();
    for (const c of allItems) {
      const g = c.group || 'Action';
      if (!groups.has(g)) groups.set(g, []);
      const arr = groups.get(g);
      if (arr.length < 6) arr.push(c);
    }
    // Order: Mode → Switch model → Switch persona → Switch chat → Action → Open settings
    const groupOrder = ['Mode', 'Switch model', 'Switch persona', 'Switch chat', 'Action', 'Open settings'];
    filtered = [];
    for (const g of groupOrder) {
      if (groups.has(g)) {
        filtered.push({ __header: g });
        for (const it of groups.get(g)) filtered.push(it);
      }
    }
    // Anything left in unknown groups appended.
    for (const [g, arr] of groups.entries()) {
      if (!groupOrder.includes(g)) {
        filtered.push({ __header: g });
        for (const it of arr) filtered.push(it);
      }
    }
  }

  // Build runnable index — only non-header items get an index.
  const runnable = filtered.filter(x => !x.__header);
  cmdActiveIdx = 0;
  const container = document.getElementById('cmd-results');
  let runIdx = -1;
  container.innerHTML = filtered.map(c => {
    if (c.__header) {
      return `<div class="cmd-group-header">${esc(c.__header)}</div>`;
    }
    runIdx++;
    const i = runIdx;
    // Cache the item on a data-index for runCommand().
    return `<div class="cmd-item${i===0?' active':''}" data-runidx="${i}" onclick="runDynamicCommand(${i})" onmouseenter="cmdActiveIdx=${i};highlightCmd()">
      <span class="cmd-item-icon">${_cmdIconHtml(c)}</span>
      <span class="cmd-item-text">${esc(c.text)}</span>
      <span class="cmd-item-hint">${esc(c.hint || '')}</span>
    </div>`;
  }).join('');
  // Stash the runnable list so runDynamicCommand can resolve it.
  window._cmdRunnable = runnable;
}

window.runDynamicCommand = function (idx) {
  closeCmdPalette();
  const list = window._cmdRunnable || [];
  list[idx]?.action?.();
};

function highlightCmd() {
  document.querySelectorAll('.cmd-item').forEach((el, i) => {
    el.classList.toggle('active', i === cmdActiveIdx);
  });
}

function cmdKeyDown(e) {
  // PR-U2 — items now skip group headers; use the runnable list cache
  // to keep arrow nav in sync.
  const items = document.querySelectorAll('.cmd-item');
  if (e.key === 'Escape') { closeCmdPalette(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdActiveIdx = Math.min(cmdActiveIdx + 1, items.length - 1); highlightCmd(); scrollActiveCmdIntoView(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); cmdActiveIdx = Math.max(cmdActiveIdx - 1, 0); highlightCmd(); scrollActiveCmdIntoView(); }
  if (e.key === 'Enter') {
    e.preventDefault();
    const active = items[cmdActiveIdx];
    if (active) active.click();
  }
}
function scrollActiveCmdIntoView() {
  const active = document.querySelectorAll('.cmd-item')[cmdActiveIdx];
  active?.scrollIntoView({ block: 'nearest' });
}

function runCommand(idx) {
  closeCmdPalette();
  COMMANDS[idx]?.action();
}

// Global keyboard shortcut
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    openCmdPalette();
  }
  // PR-U2 — chord shortcuts that pre-fill the palette with a section.
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
    e.preventDefault();
    openCmdPalette();
    setTimeout(() => {
      const inp = document.getElementById('cmd-input');
      if (inp) { inp.value = 'switch model'; filterCommands(inp.value); }
    }, 0);
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
    e.preventDefault();
    openCmdPalette();
    setTimeout(() => {
      const inp = document.getElementById('cmd-input');
      if (inp) { inp.value = 'switch persona'; filterCommands(inp.value); }
    }, 0);
  }
  if (e.key === 'Escape') closeCmdPalette();
});

