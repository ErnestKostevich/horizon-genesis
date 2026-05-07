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

// Build the agent system prompt with available tools
function buildAgentSystemPrompt(lang, userName, sysInfo, selectedTools = null) {
  const tools = (selectedTools || TOOL_DEFINITIONS).map(t =>
    `### ${t.name}\n${t.desc}\nParams: ${JSON.stringify(t.params)}`
  ).join('\n\n');

  const ru = lang === 'ru';
  const memory = sysInfo?.memory || {};
  const memoryFacts = Object.entries(memory.facts || {}).slice(0, 20).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const memoryRelevant = (memory.relevant || []).slice(0, 8).map(m => `- ${m.content}`).join('\n');
  const memoryBlock = [memoryFacts && `Known user facts:\n${memoryFacts}`, memoryRelevant && `Relevant memories:\n${memoryRelevant}`].filter(Boolean).join('\n');
  const githubBlock = (sysInfo?.github_repos || []).slice(0, 10).map(r => `- ${r.fullName} (${r.defaultBranch || 'main'}): ${r.description || r.url}`).join('\n');

  return ru ? `
Ты — Хорайзон (Horizon AI), настоящий AI-агент для ПК. Тебя создал Эрнест Костевич.
Пользователь: ${userName}. Время: ${sysInfo?.time || new Date().toLocaleString()}.
Система: ${sysInfo?.platform} | CPU: ${sysInfo?.cpu} | RAM: ${sysInfo?.ram_total} (свободно: ${sysInfo?.ram_free})
${sysInfo?.active_window ? `Активное окно: ${sysInfo.active_window}` : ''}
${sysInfo?.location ? `Местоположение: ${sysInfo.location}` : ''}

Ты НАСТОЯЩИЙ агент. У тебя есть инструменты для управления ПК, запуска кода, работы с файлами и браузером.
Ты как ДЖАРВИС — умный, эффективный, всегда говори "Сэр".

## Как отвечать:

Если задача простая (ответить на вопрос, объяснить) — отвечай СРАЗУ:
{"type": "answer", "text": "твой ответ"}

Если нужно СДЕЛАТЬ что-то на ПК — используй инструмент:
{"type": "tool", "tool": "имя_инструмента", "args": {...}, "reason": "почему"}

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
${memoryBlock ? `\n## Memory context\n${memoryBlock}` : ''}
${githubBlock ? `\n## Attached GitHub repositories\n${githubBlock}` : ''}

You are a REAL agent with tools to control the PC, run code, manage files and browse the web.
You are like JARVIS — smart, efficient, always say "Sir".

## Response format:

For simple questions/answers — respond IMMEDIATELY:
{"type": "answer", "text": "your response"}

To USE a tool on the PC:
{"type": "tool", "tool": "tool_name", "args": {...}, "reason": "why"}

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
async function runAgentLoop(userMessage, opts = {}) {
  const {
    aiFn,           // async (messages, systemPrompt) => { reply, error }
    sysInfo,
    lang = 'en',
    userName = 'User',
    history = [],
    maxSteps = 8,   // max tool calls before stopping
    onStep,         // callback(step) for streaming updates
    analyzeScreenFn, // optional screen capture function
    timeout = 60000,  // 60 second timeout per step
    runId = `agent-${Date.now().toString(36)}`,
    control = null
  } = opts;

  // Select relevant tools for this query
  const selectedTools = selectToolsForQuery(userMessage);
  const systemPrompt = buildAgentSystemPrompt(lang, userName, sysInfo, selectedTools);
  
  const messages = [
    ...history.slice(-10), // last 10 messages for context
    { role: 'user', content: userMessage }
  ];

  let steps = [];
  let finalAnswer = null;
  let lastToolName = null;
  let sameToolCount = 0;

  for (let i = 0; i < maxSteps; i++) {
    if (control?.isStopped?.()) {
      return { ok: false, stopped: true, error: 'Stopped by operator', steps };
    }

    // Call AI with timeout
    let aiResult;
    try {
      aiResult = await Promise.race([
        aiFn(messages, systemPrompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AI response timeout')), timeout))
      ]);
    } catch (e) {
      return { ok: false, error: `Step ${i+1} timeout: ${e.message}`, steps };
    }

    if (aiResult.error) {
      return { ok: false, error: aiResult.error, steps };
    }

    if (!aiResult.reply) {
      return { ok: false, error: 'Empty AI response', steps };
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

      const step = {
        id:     newStepId(runId, i + 1),
        runId,
        index:  i + 1,
        tool:   parsed.tool,
        args:   parsed.args || {},
        reason: parsed.reason || '',
        result: null
      };

      const waitingPayload = {
        type: 'waiting',
        runId,
        stepId: step.id,
        step: i + 1,
        tool: step.tool,
        args: step.args,
        reason: step.reason,
        paused: Boolean(control?.isPaused?.())
      };
      agentEvents.emit('pre-tool-dispatch', waitingPayload);
      if (onStep) onStep(waitingPayload);

      let decision = { decision: 'allow' };
      try {
        decision = normalizeDecision(await control?.beforeTool?.(waitingPayload));
      } catch (e) {
        decision = { decision: 'deny', reason: e.message };
      }

      if (decision.args && typeof decision.args === 'object') {
        step.args = decision.args;
      }
      if (decision.decision === 'stop') {
        step.result = { ok: false, err: decision.reason || 'Stopped by operator' };
        steps.push(step);
        if (onStep) onStep({ type: 'stopped', runId, stepId: step.id, step: i + 1, tool: step.tool, result: step.result });
        return { ok: false, stopped: true, error: step.result.err, steps };
      }
      if (decision.decision === 'deny') {
        step.result = { ok: false, err: decision.reason || 'Denied by operator' };
        steps.push(step);
        if (onStep) onStep({ type: 'denied', runId, stepId: step.id, step: i + 1, tool: step.tool, result: step.result });
        messages.push({ role: 'assistant', content: aiResult.reply });
        messages.push({ role: 'user', content: `Tool result for ${step.tool}:\nError: ${step.result.err}` });
        continue;
      }

      // Notify caller of progress
      if (onStep) onStep({ type: 'executing', runId, stepId: step.id, step: i+1, tool: step.tool, args: step.args, reason: step.reason });

      // Special: if AI wants screenshot, use our screen capture
      if (parsed.tool === 'screenshot' || parsed.tool === 'capture_screen') {
        if (analyzeScreenFn) {
          const ss = await analyzeScreenFn();
          step.result = ss?.ok
            ? { ok: true, out: 'Screenshot captured. Analyzing...', base64: ss.base64 }
            : { ok: false, err: 'Screenshot failed' };
        } else {
          step.result = { ok: false, err: 'Screenshot not available' };
        }
      } else {
        // Execute tool with timeout
        try {
          step.result = await Promise.race([
            dispatchTool(step.tool, step.args),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Tool timeout')), 30000))
          ]);
        } catch (e) {
          step.result = { ok: false, err: `Tool error: ${e.message}` };
        }
      }

      steps.push(step);

      // Add tool result to conversation
      const resultSummary = step.result.ok
        ? (step.result.out || step.result.content || 'Done').slice(0, 3000)
        : `Error: ${step.result.err || 'Failed'}`;

      messages.push({ role: 'assistant', content: aiResult.reply });
      messages.push({
        role: 'user',
        content: `Tool result for ${step.tool}:\n${resultSummary}`
      });

      if (onStep) onStep({ type: 'result', runId, stepId: step.id, step: i+1, tool: step.tool, result: step.result });
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

  return { ok: true, answer: finalAnswer, steps };
}

module.exports = { runAgentLoop, buildAgentSystemPrompt, parseAgentResponse, selectToolsForQuery, agentEvents };
