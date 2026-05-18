'use strict';
/**
 * Horizon AI — Autonomous Agent Loop v2.0
 *
 * Features:
 * - ReAct pattern: Reason → Act → Observe → Reason...
 * - Smart tool selection based on query
 * - Timeout protection against infinite loops
 * - Streaming step updates
 * - Hot window support for follow-up queries
 */

const { EventEmitter } = require('events');
const { dispatchTool, TOOL_DEFINITIONS } = require('./agent');

const agentEvents = new EventEmitter();
agentEvents.setMaxListeners(100);

function newStepId(runId, index) {
  return `${runId || 'agent'}:step:${index}:${Date.now().toString(36)}`;
}

function normalizeDecision(decision) {
  if (!decision) return { decision: 'allow' };
  if (typeof decision === 'string') return { decision };
  return { decision: decision.decision || 'allow', ...decision };
}

function toolAllowedByPersona(toolName, allowedGroups) {
  if (!Array.isArray(allowedGroups)) return true;
  if (allowedGroups.length === 0) return false;
  const allowed = new Set(allowedGroups.map(String));
  const name = String(toolName || '');
  const groups = {
    'fs.read': [
      'read_file', 'list_dir', 'search_files', 'get_system_info',
      'get_running_apps', 'get_facts', 'recall', 'get_nutrition'
    ],
    'fs.write': ['write_file', 'remember', 'set_fact', 'log_meal'],
    shell: ['run_code', 'run_powershell', 'run_shell', 'shell_command', 'skill_run_helper'],
    'web.fetch': ['browser_open', 'open_site', 'get_location', 'get_weather', 'wikipedia'],
    'web.search': ['browser_search', 'web_search', 'wikipedia'],
    screenshot: ['screenshot', 'capture_screen', 'browser_screenshot'],
    'computer.click': ['mouse_click', 'mouse_move', 'scroll', 'smart_click'],
    'computer.type': ['type_text', 'press_key'],
  };
  for (const [group, tools] of Object.entries(groups)) {
    if (allowed.has(group) && tools.includes(name)) return true;
  }
  if (name.startsWith('plugin_') || name.includes('__')) {
    return allowed.has('plugins') || allowed.has('web.fetch') || allowed.has('fs.write') || allowed.has('shell');
  }
  if (name.startsWith('conn_')) {
    return allowed.has('connections') || allowed.has('web.fetch') || allowed.has('plugins');
  }
  return false;
}

function filterToolsForPersona(tools, allowedGroups) {
  return (tools || []).filter(t => toolAllowedByPersona(t?.name, allowedGroups));
}

function buildVisiblePlan(userMessage, selectedTools = [], lang = 'en') {
  const ru = lang === 'ru';
  const q = String(userMessage || '');
  const toolNames = new Set((selectedTools || []).map(t => String(t?.name || '').toLowerCase()));
  const needsAction = [...toolNames].some(t => !['get_system_info', 'recall', 'get_facts'].includes(t));
  const needsFiles = /file|файл|код|code|repo|workspace|проект|папк/i.test(q) || [...toolNames].some(t => /file|dir|search/.test(t));
  const needsWeb = /web|internet|интернет|сайт|search|найди|http|url/i.test(q) || [...toolNames].some(t => /web|browser|fetch|wikipedia/.test(t));
  const needsComputer = /click|клик|open|открой|запусти|press|type|мыш|окно/i.test(q) || [...toolNames].some(t => /mouse|press|type|open|shell|run/.test(t));

  const steps = [];
  steps.push(ru ? 'Понять цель и ограничения запроса' : 'Understand the goal and constraints');
  steps.push(ru ? 'Поднять релевантную память, персону, skills и правила проекта' : 'Recall relevant memory, persona, skills, and project rules');
  if (needsFiles) steps.push(ru ? 'Проверить нужные файлы или рабочую папку перед изменениями' : 'Inspect the needed files or workspace before edits');
  if (needsWeb) steps.push(ru ? 'Получить свежий внешний контекст только если это нужно' : 'Fetch external context only when needed');
  if (needsComputer) steps.push(ru ? 'Выполнить действия через tools с permission gate для побочных эффектов' : 'Run tools with permission gates for side effects');
  if (!needsAction) steps.push(ru ? 'Сформировать ответ без лишних действий' : 'Answer directly without unnecessary actions');
  steps.push(ru ? 'Проверить результат и явно назвать блокеры' : 'Verify the result and call out blockers');
  steps.push(ru ? 'Сохранить полезные предпочтения в память' : 'Save useful preferences into memory');
  return steps.slice(0, 7).map((text, index) => ({ id: `plan-${index + 1}`, text, status: index === 0 ? 'now' : 'next' }));
}

function deliberationProtocol(ru, nativeTools) {
  const formatHint = nativeTools
    ? (ru
      ? 'Когда API поддерживает native tools, вызывай tools напрямую, без печати JSON.'
      : 'When native tools are available, call tools directly instead of printing JSON.')
    : (ru
      ? 'Для многошаговой задачи можно сначала вернуть {"type":"plan","steps":["..."],"confidence":0.0-1.0}, затем продолжить tool/done JSON.'
      : 'For a multi-step task you may first return {"type":"plan","steps":["..."],"confidence":0.0-1.0}, then continue with tool/done JSON.');
  return ru ? `
## Система размышлений Horizon
- Думай приватно, но пользователю показывай только короткий план, проверки и результаты. Не раскрывай сырой chain-of-thought.
- Работай по циклу: цель -> контекст/память -> план -> действие -> наблюдение -> самопроверка -> память.
- Перед опасными действиями используй permission gate; если действие отклонено, не падай, а предложи безопасную альтернативу.
- Если есть память о предпочтениях пользователя, применяй её без повторных вопросов.
- ${formatHint}
` : `
## Horizon deliberation system
- Reason privately, but show the user only concise plans, checks, and results. Do not reveal raw chain-of-thought.
- Use the loop: goal -> context/memory -> plan -> action -> observation -> self-check -> memory.
- Use the permission gate before side-effect actions; if denied, recover safely and suggest an alternative.
- Apply remembered user preferences without asking again.
- ${formatHint}
`;
}

// Build the agent system prompt with available tools
function buildAgentSystemPrompt(lang, userName, sysInfo, selectedTools = null, options = {}) {
  const tools = (selectedTools || TOOL_DEFINITIONS).map(t =>
    `### ${t.name}\n${t.desc}\nParams: ${JSON.stringify(t.inputSchema || t.params)}`
  ).join('\n\n');

  const ru = lang === 'ru';
  const nativeTools = Boolean(options.nativeTools);
  const memory = sysInfo?.memory || {};
  const memoryFacts = Object.entries(memory.facts || {}).slice(0, 20).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const memoryRelevant = (memory.relevant || []).slice(0, 8).map(m => `- ${m.content}`).join('\n');
  const memoryBlock = [memoryFacts && `Known user facts:\n${memoryFacts}`, memoryRelevant && `Relevant memories:\n${memoryRelevant}`].filter(Boolean).join('\n');
  // User profile block (Big Five + communication style) — pre-rendered by
  // AgentMemory.buildUserProfileBlock based on confidence > 0.2. Injected
  // separately from memoryBlock so the prompt structure stays readable
  // and we can A/B the format without touching memory logic.
  const userProfileBlock = (typeof memory.userProfileBlock === 'string' && memory.userProfileBlock.trim())
    ? memory.userProfileBlock
    : '';
  const githubBlock = (sysInfo?.github_repos || []).slice(0, 10).map(r => `- ${r.fullName} (${r.defaultBranch || 'main'}): ${r.description || r.url}`).join('\n');
  const connectionsBlock = (sysInfo?.connections || []).slice(0, 12).map(c => `- ${c.name || c.id}: ${c.toolCount || 0} tools`).join('\n');

  // Persona block — read the user's selected persona from settingsStore
  // and prepend its system prompt + memories. Without this, the agent
  // hardcoded "You are JARVIS" regardless of which persona the user
  // picked in Settings → Personas, so personas were a UI-only feature
  // that never shaped agent replies. Caller can override via
  // options.personaPrompt for tests.
  let personaBlock = '';
  try {
    if (options.personaPrompt) {
      personaBlock = options.personaPrompt;
    } else {
      const personas = require('./personas');
      // settingsStore lookup is lazy: we call require('electron').app
      // safe-only via the module loaded by main.js. Fall back to no
      // overlay if the settings module isn't reachable from this worker.
      let personaId = options.personaId;
      if (!personaId) {
        try {
          const mainMod = require.cache[require.resolve('./main')];
          // Best-effort: if main.js exposed settingsStore on its module
          // exports we use it; otherwise the renderer pre-supplies the
          // persona id via options.personaId.
          if (mainMod && mainMod.exports && mainMod.exports.settingsStore) {
            personaId = mainMod.exports.settingsStore.get('persona') || 'jarvis';
          }
        } catch (_) {}
      }
      if (personaId && typeof personas.getPersonaPrompt === 'function') {
        const pp = personas.getPersonaPrompt(personaId, lang);
        if (pp) personaBlock = pp;
      }
    }
  } catch (_) { /* persona is optional for the agent loop */ }

  // PR-D3 — project rules block. Pulled from .horizon/rules.md in the
  // active workspace. Injected ONCE per system prompt build (not per
  // turn), so the user's project conventions are present every time
  // the agent thinks. Caller can override via options.projectRulesText.
  let projectRulesBlock = '';
  try {
    if (typeof options.projectRulesText === 'string' && options.projectRulesText.trim()) {
      projectRulesBlock = options.projectRulesText;
    } else {
      const mainMod = require.cache[require.resolve('./main')];
      const getCfg = mainMod && mainMod.exports && mainMod.exports.getProjectConfig;
      const getRoot = mainMod && mainMod.exports && mainMod.exports.currentWorkspaceRoot;
      if (typeof getCfg === 'function' && typeof getRoot === 'function') {
        const root = getRoot();
        if (root) {
          const cfg = getCfg();
          if (cfg && typeof cfg.buildSystemBlock === 'function') {
            projectRulesBlock = cfg.buildSystemBlock(root) || '';
          }
        }
      }
    }
  } catch (_) { /* project rules are optional */ }

  // Skills block — Claude Code-style SKILL.md content selected by relevance
  // (or forced via /skill <name>). Caller (main.js) resolves the block via
  // skillsManager.getSkillsBlock(userMessage) and passes the rendered string
  // in here. Injected after project rules so workspace conventions still take
  // precedence over loaded skills. See skillsManager.js for budget rules.
  let skillsBlock = '';
  if (typeof options.skillsBlock === 'string' && options.skillsBlock.trim()) {
    skillsBlock = `\n\n## Skills loaded for this turn\n\n${options.skillsBlock.trim()}\n`;
  }
  // PHASE 8/8 — Workspace memory (.horizon/memory.json committed to git).
  // Comes pre-rendered from main.js via sysInfo.workspaceMemoryBlock.
  // Injected right after project rules so team conventions ride alongside
  // .horizon/rules.md.
  const workspaceMemoryBlock = (typeof sysInfo?.workspaceMemoryBlock === 'string' && sysInfo.workspaceMemoryBlock.trim())
    ? sysInfo.workspaceMemoryBlock
    : '';

  if (nativeTools) {
    return `
You are Horizon AI, a real desktop AI agent created by Ernest Kostevich.
User: ${userName}. Time: ${sysInfo?.time || new Date().toLocaleString()}.
System: ${sysInfo?.platform} | CPU: ${sysInfo?.cpu} | RAM: ${sysInfo?.ram_total} (free: ${sysInfo?.ram_free})
${sysInfo?.active_window ? `Active window: ${sysInfo.active_window}` : ''}
${sysInfo?.location ? `Location: ${sysInfo.location}` : ''}
${personaBlock ? `\n## Persona / style\n${personaBlock}` : ''}
${projectRulesBlock || ''}${workspaceMemoryBlock || ''}${skillsBlock || ''}${userProfileBlock || ''}
${memoryBlock ? `\n## Memory context\n${memoryBlock}` : ''}
${githubBlock ? `\n## Attached GitHub repositories\n${githubBlock}` : ''}
${connectionsBlock ? `\n## Active connections\n${connectionsBlock}` : ''}
${deliberationProtocol(ru, true)}

You can use the native tools supplied by the API to control the PC, run code, manage files and browse the web.
Use tools when the task needs action. Do not print JSON tool calls when native tools are available.
After tools finish, answer normally and concisely. If a tool fails twice, explain the blocker and suggest the next safe step.
`.trim();
  }

  return ru ? `
Ты — Хорайзон (Horizon AI), настоящий AI-агент для ПК. Тебя создал Эрнест Костевич.
Пользователь: ${userName}. Время: ${sysInfo?.time || new Date().toLocaleString()}.
Система: ${sysInfo?.platform} | CPU: ${sysInfo?.cpu} | RAM: ${sysInfo?.ram_total} (свободно: ${sysInfo?.ram_free})
${sysInfo?.active_window ? `Активное окно: ${sysInfo.active_window}` : ''}
${sysInfo?.location ? `Местоположение: ${sysInfo.location}` : ''}
${personaBlock ? `\n## Персона / стиль\n${personaBlock}\n` : ''}
${projectRulesBlock || ''}${workspaceMemoryBlock || ''}${skillsBlock || ''}${userProfileBlock || ''}
${memoryBlock ? `\n## Контекст памяти\n${memoryBlock}\n` : ''}
${githubBlock ? `\n## Подключенные GitHub-репозитории\n${githubBlock}\n` : ''}
${connectionsBlock ? `\n## Активные подключения\n${connectionsBlock}\n` : ''}
${deliberationProtocol(true, false)}
Ты НАСТОЯЩИЙ агент. У тебя есть инструменты для управления ПК, запуска кода, работы с файлами и браузером.${personaBlock ? '' : '\nТы как ДЖАРВИС — умный, эффективный, всегда говори "Сэр".'}

## Как отвечать:

Если задача простая (ответить на вопрос, объяснить) — отвечай СРАЗУ:
{"type": "answer", "text": "твой ответ"}

Если нужно СДЕЛАТЬ что-то на ПК — используй инструмент:
{"type": "tool", "tool": "имя_инструмента", "args": {...}, "reason": "почему"}

Если задача сложная и нужно показать план перед действиями:
{"type": "plan", "steps": ["шаг 1", "шаг 2", "шаг 3"], "confidence": 0.82}

Когда задача ВЫПОЛНЕНА:
{"type": "done", "text": "что сделано"}

## Доступные инструменты:

${tools}

## Правила:
1. Всегда отвечай ТОЛЬКО валидным JSON — никакого текста снаружи!
2. Для многошаговых задач используй инструменты последовательно
3. run_code — самый мощный: пиши Python/PowerShell для сложных задач
4. Если не знаешь координаты — используй screenshot + анализ
5. НЕ ЗАЦИКЛИВАЙСЯ — если что-то не работает 2 раза, объясни проблему пользователю
6. Будь краток, эффективен, как Джарвис
` : `
You are Horizon AI — a real desktop AI agent created by Ernest Kostevich.
User: ${userName}. Time: ${sysInfo?.time || new Date().toLocaleString()}.
System: ${sysInfo?.platform} | CPU: ${sysInfo?.cpu} | RAM: ${sysInfo?.ram_total} (free: ${sysInfo?.ram_free})
${sysInfo?.active_window ? `Active window: ${sysInfo.active_window}` : ''}
${sysInfo?.location ? `Location: ${sysInfo.location}` : ''}
${personaBlock ? `\n## Persona / style\n${personaBlock}\n` : ''}
${projectRulesBlock || ''}${workspaceMemoryBlock || ''}${skillsBlock || ''}${userProfileBlock || ''}
${memoryBlock ? `\n## Memory context\n${memoryBlock}` : ''}
${githubBlock ? `\n## Attached GitHub repositories\n${githubBlock}` : ''}
${connectionsBlock ? `\n## Active connections\n${connectionsBlock}` : ''}
${deliberationProtocol(false, false)}

You are a REAL agent with tools to control the PC, run code, manage files and browse the web.${personaBlock ? '' : '\nYou are like JARVIS — smart, efficient, always say "Sir".'}

## Response format:

For simple questions/answers — respond IMMEDIATELY:
{"type": "answer", "text": "your response"}

To USE a tool on the PC:
{"type": "tool", "tool": "tool_name", "args": {...}, "reason": "why"}

For a complex task, show a compact plan before actions:
{"type": "plan", "steps": ["step 1", "step 2", "step 3"], "confidence": 0.82}

When task is COMPLETE:
{"type": "done", "text": "what was accomplished"}

## Available tools:

${tools}

## Rules:
1. Always respond with ONLY valid JSON — no text outside!
2. For multi-step tasks, use tools sequentially
3. run_code is the most powerful: write Python/PowerShell for complex automation
4. If you don't know coordinates, use screenshot + analysis
5. DON'T LOOP — if something fails twice, explain the issue to the user
6. Be concise and effective like JARVIS
`;
}

// Smart tool selection based on query keywords
function selectToolsForQuery(query) {
  const q = query.toLowerCase();
  const selected = new Set();
  
  // Always include these
  selected.add('get_system_info');
  
  // File operations
  if (/file|файл|read|write|записать|прочитать|document|документ/i.test(q)) {
    selected.add('read_file');
    selected.add('write_file');
    selected.add('list_dir');
    selected.add('search_files');
  }
  
  // Code execution
  if (/code|код|script|скрипт|python|powershell|javascript|запусти|run|execute|выполни/i.test(q)) {
    selected.add('run_code');
    selected.add('run_powershell');
  }
  
  // Mouse/keyboard
  if (/click|клик|mouse|мышь|cursor|курсор|type|печать|key|клавиш|scroll|скролл|drag|тян/i.test(q)) {
    selected.add('mouse_click');
    selected.add('mouse_move');
    selected.add('type_text');
    selected.add('press_key');
    selected.add('scroll');
  }
  
  // Browser
  if (/browser|браузер|url|сайт|site|web|интернет|open|открой|youtube|ютуб|google|гугл/i.test(q)) {
    selected.add('browser_open');
  }
  
  // System
  if (/process|процесс|app|приложени|running|запущен|system|систем/i.test(q)) {
    selected.add('get_running_apps');
    selected.add('shell_command');
  }
  
  // If nothing specific matched, include common tools
  if (selected.size <= 1) {
    selected.add('run_code');
    selected.add('browser_open');
    selected.add('type_text');
    selected.add('press_key');
    selected.add('list_dir');
    selected.add('shell_command');
    selected.add('get_running_apps');
  }
  
  return TOOL_DEFINITIONS.filter(t => selected.has(t.name));
}

// Parse AI response — extract JSON tool call or answer
function parseAgentResponse(text) {
  const cleaned = text.trim();

  // Try to extract JSON from the response
  // Direct JSON
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.type) return parsed;
  } catch {}

  // JSON in code block
  const codeMatch = cleaned.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeMatch) {
    try { return JSON.parse(codeMatch[1]); } catch {}
  }

  // JSON anywhere in text (more aggressive)
  const jsonMatches = cleaned.match(/\{[^{}]*"type"\s*:\s*"[^"]+[^{}]*\}/g);
  if (jsonMatches) {
    for (const match of jsonMatches) {
      try { return JSON.parse(match); } catch {}
    }
  }
  
  // Try to find JSON with nested objects
  const deepJsonMatch = cleaned.match(/\{[\s\S]*?"type"[\s\S]*?\}(?=\s*$|\s*[^{])/);
  if (deepJsonMatch) {
    try { return JSON.parse(deepJsonMatch[0]); } catch {}
  }

  // Fallback: treat as plain text answer
  return { type: 'answer', text: cleaned };
}

// Main agent loop — runs multiple tool calls until task complete
function summarizeToolResult(result) {
  return result?.ok
    ? (result.out || result.content || 'Done').slice(0, 3000)
    : `Error: ${result?.err || 'Failed'}`;
}

async function executeAgentToolStep(parsed, ctx) {
  const { runId, stepIndex, control, onStep, analyzeScreenFn, steps, dispatchToolFn = dispatchTool } = ctx;
  const step = {
    id:     parsed.stepId || newStepId(runId, stepIndex),
    runId,
    index:  stepIndex,
    tool:   parsed.tool,
    args:   parsed.args || {},
    reason: parsed.reason || '',
    toolCallId: parsed.toolCallId || null,
    result: null
  };

  const waitingPayload = {
    type: 'waiting',
    runId,
    stepId: step.id,
    step: stepIndex,
    tool: step.tool,
    args: step.args,
    reason: step.reason,
    toolCallId: step.toolCallId,
    paused: Boolean(control?.isPaused?.())
  };
  try {
    if (typeof control?.classifyTool === 'function') {
      waitingPayload.permission = control.classifyTool(waitingPayload);
    }
  } catch (e) {
    waitingPayload.permission = {
      required: true,
      allowed: false,
      tool: step.tool,
      operation: 'unknown',
      title: `${step.tool || 'tool'} approval`,
      description: e.message || 'Could not classify tool risk.',
    };
  }
  agentEvents.emit('pre-tool-dispatch', waitingPayload);
  if (onStep) onStep(waitingPayload);

  let decision = { decision: 'allow' };
  try {
    decision = normalizeDecision(await control?.beforeTool?.(waitingPayload));
  } catch (e) {
    decision = { decision: 'deny', reason: e.message };
  }

  if (decision.args && typeof decision.args === 'object') step.args = decision.args;
  if (decision.decision === 'stop') {
    step.result = { ok: false, err: decision.reason || 'Stopped by operator' };
    steps.push(step);
    if (onStep) onStep({ type: 'stopped', runId, stepId: step.id, step: stepIndex, tool: step.tool, reason: decision.reason || '', permission: waitingPayload.permission || null, result: step.result });
    return { stopped: true, step, resultSummary: summarizeToolResult(step.result) };
  }
  if (decision.decision === 'deny') {
    step.result = { ok: false, err: decision.reason || 'Denied by operator' };
    steps.push(step);
    if (onStep) onStep({ type: 'denied', runId, stepId: step.id, step: stepIndex, tool: step.tool, reason: decision.reason || '', permission: waitingPayload.permission || null, result: step.result });
    return { denied: true, step, resultSummary: summarizeToolResult(step.result) };
  }

  if (onStep) onStep({ type: 'executing', runId, stepId: step.id, step: stepIndex, tool: step.tool, args: step.args, reason: step.reason });

  if (step.tool === 'screenshot' || step.tool === 'capture_screen') {
    if (analyzeScreenFn) {
      const ss = await analyzeScreenFn();
      step.result = ss?.ok
        ? { ok: true, out: 'Screenshot captured. Analyzing...', base64: ss.base64 }
        : { ok: false, err: 'Screenshot failed' };
    } else {
      step.result = { ok: false, err: 'Screenshot not available' };
    }
  } else {
    try {
      step.result = await Promise.race([
        dispatchToolFn(step.tool, step.args),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tool timeout')), 30000))
      ]);
    } catch (e) {
      step.result = { ok: false, err: `Tool error: ${e.message}` };
    }
  }

  steps.push(step);
  const resultSummary = summarizeToolResult(step.result);
  if (onStep) onStep({ type: 'result', runId, stepId: step.id, step: stepIndex, tool: step.tool, result: step.result });
  return { step, resultSummary };
}

async function runAgentLoop(userMessage, opts = {}) {
  const {
    aiFn,           // async (messages, systemPrompt, agentMeta) => { reply, toolCalls, error }
    sysInfo,
    lang = 'en',
    userName = 'User',
    history = [],
    maxSteps = 8,   // max tool calls before stopping
    onStep,         // callback(step) for streaming updates
    analyzeScreenFn, // optional screen capture function
    timeout = 60000,  // 60 second timeout per step
    runId = `agent-${Date.now().toString(36)}`,
    control = null,
    nativeTools = false,
    extraTools = [],
    dispatchToolFn = dispatchTool,
    personaId = null,    // overrides settingsStore lookup in buildAgentSystemPrompt
    personaPrompt = null, // pre-resolved persona text (cheaper for hot paths)
    allowedToolGroups = null,
    skillsBlock = '',    // pre-rendered "## Skills loaded for this turn" body (caller resolves via skillsManager.getSkillsBlock)
    skillsSelected = null // optional metadata about which skills loaded — emitted to inspector listeners
  } = opts;

  // Select relevant tools for this query
  const selectedTools = filterToolsForPersona([...selectToolsForQuery(userMessage), ...extraTools], allowedToolGroups)
    .filter((tool, index, arr) => tool?.name && arr.findIndex(t => t?.name === tool.name) === index);
  const systemPrompt = buildAgentSystemPrompt(lang, userName, sysInfo, selectedTools, { nativeTools, personaId, personaPrompt, skillsBlock });

  if (skillsSelected) {
    try { agentEvents.emit('skills:selected', { runId, ...skillsSelected }); } catch (_) {}
  }

  const initialPlan = buildVisiblePlan(userMessage, selectedTools, lang);
  if (onStep && initialPlan.length) {
    const planStep = {
      type: 'plan',
      runId,
      source: 'horizon-deliberation',
      title: lang === 'ru' ? 'План выполнения' : 'Execution plan',
      steps: initialPlan,
      currentIdx: 0
    };
    try { agentEvents.emit('plan', planStep); } catch (_) {}
    await Promise.resolve(onStep(planStep));
  }
  
  const messages = [
    ...history.slice(-10), // last 10 messages for context
    { role: 'user', content: userMessage }
  ];

  let steps = [];
  let finalAnswer = null;
  let lastToolName = null;
  let sameToolCount = 0;
  let modelPlanSeen = false;
  // Track plan-step advancement so the rail moves visibly. We start at 1
  // because step 0 is already highlighted by the initial plan emit above.
  let planIdx = 1;
  const totalPlanSteps = initialPlan.length;
  function advancePlan(reason) {
    if (!onStep || !totalPlanSteps) return;
    const nextIdx = Math.min(planIdx, totalPlanSteps - 1);
    try {
      Promise.resolve(onStep({
        type: 'plan-step',
        runId,
        idx: nextIdx,
        reason,
      })).catch(() => {});
    } catch (_) {}
    planIdx = Math.min(planIdx + 1, totalPlanSteps);
  }

  for (let i = 0; i < maxSteps; i++) {
    if (control?.isStopped?.()) {
      return { ok: false, stopped: true, error: 'Stopped by operator', steps };
    }

    if (onStep) {
      await Promise.resolve(onStep({
        type: 'thinking',
        runId,
        step: i + 1,
        phase: i === 0 ? 'deliberate' : 'observe',
        message: lang === 'ru' ? 'Разбираю цель и выбираю следующий шаг' : 'Deliberating and choosing the next step'
      }));
    }

    // Call AI with timeout
    let aiResult;
    try {
      aiResult = await Promise.race([
        aiFn(messages, systemPrompt, { tools: selectedTools, nativeTools, step: i + 1 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AI response timeout')), timeout))
      ]);
    } catch (e) {
      return { ok: false, error: `Step ${i+1} timeout: ${e.message}`, steps };
    }

    if (aiResult.error) {
      return { ok: false, error: aiResult.error, steps };
    }

    if (!aiResult.reply && !aiResult.toolCalls?.length) {
      return { ok: false, error: 'Empty AI response', steps };
    }

    if (Array.isArray(aiResult.toolCalls) && aiResult.toolCalls.length) {
      messages.push({ role: 'assistant', content: aiResult.reply || '', toolCalls: aiResult.toolCalls });
      for (const call of aiResult.toolCalls) {
        const parsed = {
          type: 'tool',
          tool: call.tool || call.name,
          args: call.args || {},
          reason: call.reason || `native tool call ${call.tool || call.name}`,
          toolCallId: call.id
        };
        if (!parsed.tool) continue;
        if (parsed.tool === lastToolName) sameToolCount++;
        else { lastToolName = parsed.tool; sameToolCount = 1; }
        if (sameToolCount >= 3) {
          finalAnswer = lang === 'ru'
            ? `Застрял на инструменте ${parsed.tool}. Возможно, нужна другая стратегия.`
            : `Stuck on tool ${parsed.tool}. May need a different approach.`;
          break;
        }
        const executed = await executeAgentToolStep(parsed, {
          runId,
          stepIndex: steps.length + 1,
          control,
          onStep,
          analyzeScreenFn,
          steps,
          dispatchToolFn
        });
        messages.push({
          role: 'tool',
          toolCallId: call.id || executed.step.id,
          name: executed.step.tool,
          content: executed.resultSummary
        });
        if (executed.stopped) return { ok: false, stopped: true, error: executed.step.result.err, steps };
      }
      if (finalAnswer) break;
      continue;
    }

    const parsed = parseAgentResponse(aiResult.reply);

    if (parsed.type === 'answer') {
      finalAnswer = parsed.text;
      break;
    }

    if (parsed.type === 'done') {
      finalAnswer = parsed.text;
      break;
    }

    if (parsed.type === 'plan') {
      const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
      const compactSteps = rawSteps.map((s, idx) => ({
        id: `model-plan-${idx + 1}`,
        text: typeof s === 'string' ? s : (s?.text || s?.title || `Step ${idx + 1}`),
        status: idx === 0 ? 'now' : 'next'
      })).filter(s => s.text).slice(0, 7);
      if (compactSteps.length && onStep) {
        await Promise.resolve(onStep({
          type: 'plan',
          runId,
          source: 'model',
          title: lang === 'ru' ? 'Уточненный план' : 'Refined plan',
          steps: compactSteps,
          confidence: parsed.confidence,
          currentIdx: 0
        }));
      }
      messages.push({ role: 'assistant', content: aiResult.reply });
      messages.push({
        role: 'user',
        content: lang === 'ru'
          ? 'План принят. Продолжай выполнение. Если нужны действия, используй tool JSON; если достаточно ответа, верни done JSON.'
          : 'Plan accepted. Continue execution. Use tool JSON for actions; return done JSON if an answer is enough.'
      });
      if (modelPlanSeen) {
        finalAnswer = lang === 'ru'
          ? rawSteps.map((s, idx) => `${idx + 1}. ${typeof s === 'string' ? s : (s?.text || s?.title || '')}`).join('\n')
          : rawSteps.map((s, idx) => `${idx + 1}. ${typeof s === 'string' ? s : (s?.text || s?.title || '')}`).join('\n');
        break;
      }
      modelPlanSeen = true;
      continue;
    }

    if (parsed.type === 'tool') {
      // Anti-loop protection: detect if stuck on same tool
      if (parsed.tool === lastToolName) {
        sameToolCount++;
        if (sameToolCount >= 3) {
          finalAnswer = lang === 'ru'
            ? `Застрял на инструменте ${parsed.tool}. Возможно, нужна другая стратегия.`
            : `Stuck on tool ${parsed.tool}. May need a different approach.`;
          break;
        }
      } else {
        lastToolName = parsed.tool;
        sameToolCount = 1;
      }

      const executed = await executeAgentToolStep({
        ...parsed,
        stepId: newStepId(runId, i + 1)
      }, {
        runId,
        stepIndex: steps.length + 1,
        control,
        onStep,
        analyzeScreenFn,
        steps,
        dispatchToolFn
      });

      messages.push({ role: 'assistant', content: aiResult.reply });
      messages.push({
        role: 'user',
        content: `Tool result for ${executed.step.tool}:\n${executed.resultSummary}`
      });

      if (executed.stopped) return { ok: false, stopped: true, error: executed.step.result.err, steps };

      // Advance the visible plan: each tool execution checks off one plan
      // step. Bounded so we don't overshoot if the agent runs more tools
      // than the static plan anticipated.
      advancePlan(`tool:${executed.step.tool}`);
    } else {
      // Unknown response type - treat as answer
      finalAnswer = aiResult.reply;
      break;
    }
  }

  if (!finalAnswer && steps.length > 0) {
    // AI didn't give explicit final answer — summarize
    const lastResult = steps[steps.length - 1];
    finalAnswer = lastResult.result?.ok
      ? (lastResult.result.out || `Completed ${steps.length} actions`)
      : `Last action failed: ${lastResult.result?.err}`;
  }

  if (!finalAnswer) {
    finalAnswer = lang === 'ru' ? 'Задача выполнена.' : 'Task completed.';
  }

  // ── REFLECTION EPILOGUE ─────────────────────────────────────────────────
  // One short follow-up call: ask the model to self-check whether the user's
  // goal was actually met, list any gaps, and rate confidence. Opt-in via
  // opts.reflect (default true for native tools, false otherwise — keeps
  // simple JSON-mode chats fast). Failures are non-fatal: if the call errors
  // or times out we just skip reflection.
  const reflectEnabled = opts.reflect ?? (nativeTools || maxSteps > 1);
  if (reflectEnabled && finalAnswer && onStep) {
    try {
      const reflectionPrompt = lang === 'ru'
        ? 'Сделай короткую самопроверку (под 100 слов) для предыдущего ответа. Верни ТОЛЬКО валидный JSON: {"goal_met":"yes"|"partial"|"no","summary":"...","gaps":["..."],"confidence":0-1}. Не добавляй текст вне JSON.'
        : 'Run a short self-check (under 100 words) on the previous answer. Return ONLY valid JSON: {"goal_met":"yes"|"partial"|"no","summary":"...","gaps":["..."],"confidence":0-1}. No text outside JSON.';
      const reflectMessages = [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: finalAnswer.slice(0, 4000) },
        { role: 'user', content: reflectionPrompt },
      ];
      const reflectRes = await Promise.race([
        aiFn(reflectMessages, systemPrompt, { tools: [], nativeTools: false, step: 'reflect' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('reflect timeout')), 15000))
      ]).catch(e => ({ error: e.message }));
      if (reflectRes && !reflectRes.error && reflectRes.reply) {
        let parsed = null;
        try { parsed = JSON.parse(reflectRes.reply.trim()); }
        catch (_) {
          const m = reflectRes.reply.match(/\{[\s\S]*?"goal_met"[\s\S]*?\}/);
          if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
        }
        if (parsed && typeof parsed === 'object') {
          const payload = {
            type: 'reflection',
            runId,
            goalMet: String(parsed.goal_met || 'unknown').toLowerCase(),
            summary: String(parsed.summary || '').slice(0, 400),
            gaps: Array.isArray(parsed.gaps) ? parsed.gaps.slice(0, 5).map(g => String(g).slice(0, 160)) : [],
            confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : null,
          };
          try { await Promise.resolve(onStep(payload)); } catch (_) {}
          try { agentEvents.emit('reflection', payload); } catch (_) {}
        }
      }
    } catch (e) {
      // swallow — reflection is best-effort
      console.warn('[agent] reflection failed:', e?.message || e);
    }
  }

  return { ok: true, answer: finalAnswer, steps };
}

module.exports = {
  runAgentLoop,
  buildAgentSystemPrompt,
  parseAgentResponse,
  selectToolsForQuery,
  toolAllowedByPersona,
  filterToolsForPersona,
  agentEvents
};
