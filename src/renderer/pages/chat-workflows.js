// PR-V Phase 3.6 — No-Code Workflow Builder + Clipboard Analysis.
// Extracted from chat.html inline <script> (was lines 5154-5398).
//
// Two adjacent features bundled because they share the same// natural-language → AI-generated artifact pattern:
//
//   1. Workflows (visual no-code workflow builder)
//      State: workflows (array)
//      Fns: loadWorkflows, saveWorkflows, createWorkflow,
//           normaliseWorkflowTrigger, buildLocalWorkflowFromText,
//           persistGeneratedWorkflow, deleteWorkflow, runWorkflow,
//           createWorkflowFromText
//
//   2. Clipboard analysis (analyzeClipboard reads system clipboard
//      and dispatches a quick AI explain).
//
// Loaded as external script AFTER main inline so window.* globals it
// reads (H IPC, addMsg, lang, sendMsg, etc.) are defined.

// ═══════════════════════════════════════════════════════════════
// NO-CODE WORKFLOW BUILDER
// ═══════════════════════════════════════════════════════════════
var workflows = [];

async function loadWorkflows() {
  try {
    const engine = await H.workflowList?.();
    if (Array.isArray(engine)) {
      workflows = engine;
      return;
    }
  } catch(_) {}
  try {
    const saved = await H.get('workflows');
    if (saved) workflows = typeof saved === 'string' ? JSON.parse(saved) : saved;
  } catch(_) { workflows = []; }
}

async function saveWorkflows() {
  await saveSetting('workflows', JSON.stringify(workflows), 'Workflows');
}

function createWorkflow(name, steps, trigger = 'manual') {
  const wf = {
    id: Date.now().toString(36),
    name,
    steps, // [{action:'open_url',args:{url:'...'}} , {action:'wait',args:{ms:1000}}, ...]
    trigger, // 'manual' | 'schedule:HH:MM' | 'wake:keyword'
    enabled: true,
    created: new Date().toISOString()
  };
  workflows.push(wf);
  saveWorkflows();
  return wf;
}

function normaliseWorkflowTrigger(trigger) {
  const raw = String(trigger || 'manual').trim();
  if (!raw || raw === 'manual') return 'manual';
  if (raw === 'startup') return 'startup';
  // interval:N — N must be a positive finite minute count.
  if (raw.startsWith('interval:')) {
    const n = Number(raw.slice('interval:'.length));
    if (Number.isFinite(n) && n > 0 && n <= 60 * 24 * 30) {
      return `interval:${Math.floor(n)}`;
    }
    return 'manual';
  }
  // schedule:HH:MM — clamp to 0-23 hours and 0-59 minutes. Previously
  // an AI-generated "schedule:99:99" would pass through and crash at
  // run time when the engine tried to set a Date.
  if (raw.startsWith('schedule:')) {
    const m = raw.slice('schedule:'.length).match(/^(\d{1,2}):(\d{1,2})$/);
    if (m) {
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
        return `schedule:${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      }
    }
    return 'manual';
  }
  // wake:keyword — keyword must be 1-32 chars, no shell metacharacters.
  if (raw.startsWith('wake:')) {
    const kw = raw.slice('wake:'.length).trim();
    if (kw && kw.length <= 32 && /^[\p{L}\p{N}\s_\-]+$/u.test(kw)) return `wake:${kw}`;
    return 'manual';
  }
  if (raw.startsWith('cron:')) {
    const expr = raw.slice(5).trim();
    const parts = expr.split(/\s+/);
    const mm = Number(parts[0]);
    const hh = Number(parts[1]);
    if (Number.isFinite(hh) && Number.isFinite(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      return `schedule:${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
    return 'manual';
  }
  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    const m = raw.match(/^(\d{1,2}):(\d{1,2})$/);
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      return `schedule:${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
    return 'manual';
  }
  // Unknown trigger shape — refuse rather than passing arbitrary string
  // through to the engine where it could be parsed mid-execution.
  return 'manual';
}


function buildLocalWorkflowFromText(description) {
  const text = String(description || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const steps = [];
  const add = (action, args = {}) => steps.push({ action, args });
  const has = (pattern) => pattern.test(text);
  const url = text.match(/https?:\/\/[^\s"')]+/i)?.[0];
  if (url) add('open_url', { url });
  else if (has(/\byoutube\b|\u044e\u0442\u0443\u0431/i)) add('open_url', { url: 'https://youtube.com' });
  else if (has(/\bgoogle\b|\u0433\u0443\u0433\u043b/i)) add('open_url', { url: 'https://google.com' });
  else if (has(/\bgithub\b|\u0433\u0438\u0442\u0445\u0430\u0431|\u0433\u0438\u0442\s*\u0445\u0430\u0431/i)) add('open_url', { url: 'https://github.com' });
  else if (has(/\bgmail\b|\u043f\u043e\u0447\u0442|mail/i)) add('open_url', { url: 'https://mail.google.com' });

  const appMatch = text.match(/(?:open|launch|start|\u043e\u0442\u043a\u0440\u043e\u0439|\u0437\u0430\u043f\u0443\u0441\u0442\u0438)\s+(?:app|application|\u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435)?\s*([a-zA-Z0-9_. -]{2,60})/i);
  if (appMatch && !url && !/\byoutube|google|github|gmail\b/i.test(appMatch[1])) {
    add('open_app', { app: appMatch[1].trim() });
  }
  const closeMatch = text.match(/(?:close|quit|kill|\u0437\u0430\u043a\u0440\u043e\u0439|\u043e\u0441\u0442\u0430\u043d\u043e\u0432\u0438)\s+([a-zA-Z0-9_. -]{2,60})/i);
  if (closeMatch) add('close_app', { app: closeMatch[1].trim() });

  const waitMatch = lower.match(/(?:wait|sleep|\u043f\u043e\u0434\u043e\u0436\u0434\u0438|\u0436\u0434\u0438)\s+(\d+)\s*(sec|secs|second|seconds|s|\u0441\u0435\u043a|\u0441\u0435\u043a\u0443\u043d\u0434|minute|minutes|min|m|\u043c\u0438\u043d)?/i);
  if (waitMatch) {
    const n = Number(waitMatch[1]);
    const unit = waitMatch[2] || 'sec';
    add('wait', { ms: /min|minute|m|\u043c\u0438\u043d/i.test(unit) ? n * 60000 : n * 1000 });
  }
  if (has(/screenshot|screen shot|\u0441\u043a\u0440\u0438\u043d|\u0441\u043a\u0440\u0438\u043d\u0448\u043e\u0442/i)) add('screenshot', {});
  const typeMatch = text.match(/(?:type|write|\u043d\u0430\u043f\u0435\u0447\u0430\u0442\u0430\u0439|\u0432\u0432\u0435\u0434\u0438)\s+["'\u201c]?([^"'\u201d]+)["'\u201d]?/i);
  if (typeMatch) add('type_text', { text: typeMatch[1].trim() });
  const sayMatch = text.match(/(?:say|speak|\u0441\u043a\u0430\u0436\u0438|\u043f\u0440\u043e\u0438\u0437\u043d\u0435\u0441\u0438)\s+["'\u201c]?([^"'\u201d]+)["'\u201d]?/i);
  if (sayMatch) add('speak', { text: sayMatch[1].trim() });
  if (has(/notify|notification|\u0443\u0432\u0435\u0434\u043e\u043c/i)) add('notify', { title: 'Horizon Workflow', body: text.slice(0, 160) });
  if (!steps.length) add('send_message', { text });
  const title = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Generated workflow';
  return { name: title.charAt(0).toUpperCase() + title.slice(1), trigger: 'manual', steps };
}

async function persistGeneratedWorkflow(wfData, sourceDescription, options = {}) {
  if (!wfData || !wfData.name || !Array.isArray(wfData.steps) || wfData.steps.length === 0) {
    addMsg('bot', 'Workflow missing name or executable steps.');
    return null;
  }
  const trigger = normaliseWorkflowTrigger(wfData.trigger || 'manual');
  let wf = null;
  try {
    const er = await H.workflowCreate(wfData.name, trigger, wfData.steps, sourceDescription || '');
    if (er && er.ok === false) throw new Error(er.error || 'Workflow engine create failed');
    wf = er;
    await loadWorkflows();
  } catch (error) {
    console.warn('Engine workflow create threw:', error?.message || error);
    wf = createWorkflow(wfData.name, wfData.steps, trigger);
  }
  const prefix = options.fallback
    ? 'AI was unavailable or returned invalid workflow JSON, so Horizon created this workflow with the local parser.\n'
    : '';
  addMsg('bot', prefix + 'Workflow **' + wf.name + '** created. ' + wf.steps.length + ' steps, trigger: ' + trigger + '.\nRun it from Workflows or say "run workflow ' + wf.name + '".');
  try {
    if (document.getElementById('wf-panel')?.classList.contains('show')) renderWfBody();
  } catch (_) {}
  return wf;
}

function deleteWorkflow(id) {
  workflows = workflows.filter(w => w.id !== id);
  saveWorkflows();
}

async function runWorkflow(id) {
  const r = await H.workflowRun?.(id);
  if (!r || r.ok === false) {
    return { ok: false, error: (r && r.error) || 'Workflow engine failed' };
  }
  return r;
}

// Quick workflow creation from natural language
async function createWorkflowFromText(description) {
  const providerForWorkflow = (typeof prov !== 'undefined' && prov) ? prov : 'gemini';
  const fallbackWorkflow = async (reason) => {
    if (reason) console.warn('Workflow AI generation fallback:', reason);
    const localWorkflow = buildLocalWorkflowFromText(description);
    return persistGeneratedWorkflow(localWorkflow, description, { fallback: true });
  };
  const workflowPrompt = `Create an executable Horizon workflow from this user request:

${description}

Return ONLY valid JSON with this exact shape:
{"name":"Short workflow name","trigger":"manual","steps":[{"action":"open_url","args":{"url":"https://example.com"}}]}

Allowed actions only:
- open_url: args { "url": "https://..." }
- open_app: args { "app": "Application name" }
- close_app: args { "app": "Application name" }
- shell: args { "command": "command" }
- type_text: args { "text": "text to type" }
- press_key: args { "key": "Enter" }
- run_code: args { "code": "console.log('hi')", "language": "node" }
- wait: args { "ms": 1000 }
- notify: args { "title": "Title", "body": "Message" }
- speak: args { "text": "Text to speak" }
- send_message: args { "text": "Message to send to chat AI" }
- screenshot: args {}
- clipboard_read: args {}
- clipboard_write: args { "text": "text" }

Use trigger "manual" unless the user clearly asked for a schedule.`;

  try {
    const completion = await H.ai([{ role: 'user', content: workflowPrompt }], providerForWorkflow, null, aiOptsForProvider(providerForWorkflow));
    if (!completion || completion.error || !completion.reply) {
      return fallbackWorkflow(completion?.error || 'empty AI workflow response');
    }
    const rawReply = String(completion.reply || '')
      .replace(new RegExp('^\\s*\\x60{3}(?:json)?\\s*', 'i'), '')
      .replace(new RegExp('\\s*\\x60{3}\\s*$', 'i'), '')
      .trim();
    const jsonText = rawReply.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonText) return fallbackWorkflow('AI workflow response did not contain JSON');
    let parsedWorkflow;
    try {
      parsedWorkflow = JSON.parse(jsonText);
    } catch (parseError) {
      return fallbackWorkflow(parseError.message || 'AI workflow JSON parse failed');
    }
    const savedWorkflow = await persistGeneratedWorkflow(parsedWorkflow, description);
    if (!savedWorkflow) return fallbackWorkflow('AI workflow had no executable steps');
    return savedWorkflow;
  } catch (error) {
    return fallbackWorkflow(error?.message || error);
  }
}

// ═══════════════════════════════════════════════════════════════
// SMART CLIPBOARD — analyze clipboard content
// ═══════════════════════════════════════════════════════════════
async function analyzeClipboard() {
  try {
    const clip = await H.getClipboard();
    if (!clip || clip.length < 5) return;
    const inp = document.getElementById('inp');
    inp.value = lang === 'ru' 
      ? `Проанализируй это из буфера обмена:\n\n${clip.slice(0, 2000)}`
      : `Analyze this from clipboard:\n\n${clip.slice(0, 2000)}`;
    ar(inp);
    inp.focus();
  } catch(_) {}
}


