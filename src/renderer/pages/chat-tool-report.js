// PR-V Phase 3.20 — Inline Tool Report + Action Card.
// Extracted from chat.html inline <script> (was lines 2683-2786).
//
// Two coupled features that decorate assistant messages with
// interactive UI:
//
//   1. Inline Tool Report (V2/P1): compact pill on the most recent
//      assistant message describing what tool just ran (e.g.
//      "read · 2 files · 0.4s"). Hooked via H.onAgentStep so it
//      attaches as soon as the agent emits a tool-call step.
//
//   2. Action Card (V2): when the assistant'''s reply ends with a
//      JSON envelope describing a suggested action (run code, open
//      URL, send message, run plugin tool), renders Apply / Skip
//      buttons under the message.
//
// Fns:
//   _attachToolReport — main entry, called from agent-step listener
//   renderActionCard — append Apply/Skip buttons to a message bubble
//   _parseActionSuggestion — extract trailing JSON _action envelope
//   _executeActionIntent — dispatch the action to the right H.* IPC
//
// Loaded as external script AFTER main inline so window.* globals it
// reads (H IPC, addMsg, sendMsg, etc.) are defined.

// ═══ INLINE TOOL REPORT (V2 / P1) ═══
// Render a compact inline pill on the most recent assistant message
// describing what tool ran ("read · 2 files · 0.4s"). Hooked via H.onAgentStep.
function _attachToolReport(step){
  try {
    if (!step || !step.tool) return;
    const msgs = document.getElementById('msgs');
    if (!msgs) return;
    const lastBot = msgs.querySelector('.msg.bot:last-of-type .bub');
    if (!lastBot) return;
    let tray = lastBot.querySelector('.tool-report-tray');
    if (!tray) {
      tray = document.createElement('div');
      tray.className = 'tool-report-tray';
      tray.style.cssText = 'margin-top:6px;display:flex;flex-wrap:wrap';
      lastBot.appendChild(tray);
    }
    const pill = document.createElement('span');
    pill.className = 'tool-report-inline';
    const icon = ({read_file:'📖',write_file:'✎',list_dir:'📁',run_code:'⚡',shell:'❯',screenshot:'📷',analyze_screen:'👁',websearch:'🔎',open:'↗'})[step.tool] || '⚙';
    const detail = step.detail || (step.args ? JSON.stringify(step.args).slice(0,40) : '');
    const ms = step.duration_ms != null ? (step.duration_ms < 1000 ? step.duration_ms+'ms' : (step.duration_ms/1000).toFixed(1)+'s') : '';
    pill.innerHTML = '<span class="tri-icon">'+icon+'</span><span>'+_escHtml(step.tool)+'</span>'+(detail?'<span>· '+_escHtml(detail)+'</span>':'')+(ms?'<span class="tri-time">· '+_escHtml(ms)+'</span>':'');
    tray.appendChild(pill);
  } catch(_){}
}
try { H.onAgentStep && H.onAgentStep((step) => _attachToolReport(step)); } catch(_){}

// ═══ ACTION CARD (V2) ═══
// If the assistant reply ends with a "[[ACTION:label|intent|args]]" tag
// (or an explicit JSON suggestion), render an interactive Skip/Apply card.
function renderActionCard(reply, onApply, onSkip){
  try {
    const msgs = document.getElementById('msgs');
    if (!msgs) return null;
    const lastBot = msgs.querySelector('.msg.bot:last-of-type');
    if (!lastBot) return null;
    // Strip control tags from displayed text — caller already did that.
    const card = document.createElement('div');
    card.className = 'action-card';
    const prompt = document.createElement('div');
    prompt.className = 'action-card-prompt';
    prompt.textContent = reply.prompt || (lang==='ru'?'Применить предложение?':'Apply this suggestion?');
    const actions = document.createElement('div');
    actions.className = 'action-card-actions';
    const skipBtn = document.createElement('button');
    skipBtn.className = 'action-card-btn skip';
    skipBtn.textContent = lang==='ru'?'Пропустить':'Skip';
    skipBtn.onclick = () => { card.remove(); onSkip && onSkip(); };
    const applyBtn = document.createElement('button');
    applyBtn.className = 'action-card-btn primary';
    applyBtn.textContent = (reply.label || (lang==='ru'?'Применить':'Apply'));
    applyBtn.onclick = () => { card.remove(); onApply && onApply(reply); };
    actions.appendChild(skipBtn);
    actions.appendChild(applyBtn);
    card.appendChild(prompt);
    card.appendChild(actions);
    lastBot.appendChild(card);
    return card;
  } catch(_) { return null; }
}
// Parser: extract action suggestion from an LLM reply.
// Recognised forms (kept LLM-prompt-light so any provider can emit them):
//   1) Trailing "[[ACTION: <label> | <intent> | <args-json> | <prompt>]]"
//   2) JSON object on the last line: {"_action":{"label":"...","intent":"...","args":{...},"prompt":"..."}}
function _parseActionSuggestion(text){
  if (!text) return null;
  // Form 1
  const m = text.match(/\[\[ACTION:\s*([^|\]]+)\|([^|\]]+)\|([^\]]*?)(?:\|([^\]]+))?\]\]\s*$/);
  if (m) {
    let args = {};
    try { args = JSON.parse(m[3].trim() || '{}'); } catch(_) { args = { raw: m[3] }; }
    return { label: m[1].trim(), intent: m[2].trim(), args, prompt: (m[4]||'').trim() };
  }
  // Form 2
  const lines = text.trim().split(/\n+/);
  const last = lines[lines.length-1] || '';
  if (last.startsWith('{') && last.includes('"_action"')) {
    try {
      const o = JSON.parse(last);
      if (o && o._action) return o._action;
    } catch(_){}
  }
  return null;
}
async function _executeActionIntent(action){
  if (!action || !action.intent) return;
  const intent = String(action.intent);
  const args = action.args || {};
  try {
    if (intent === 'run_code') {
      await H.execCode(args.code || '', args.lang || 'python');
    } else if (intent === 'open_url') {
      await H.pcOpenUrl(args.url || '');
    } else if (intent === 'send_message') {
      const inp = document.getElementById('inp');
      if (inp) { inp.value = args.text || ''; sendMsg(); }
    } else if (intent === 'plugin') {
      await H.pluginExecTool(args.plugin_id, args.tool, args.tool_args || {});
    } else {
      addMsg('bot', `Unknown action intent: ${intent}`);
    }
  } catch(e) { addMsg('bot', `Plugin error: ${e.message}`); }
}


