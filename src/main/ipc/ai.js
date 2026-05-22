'use strict';

// IPC handlers — AI completion + streaming + image gen + web search + abort.
// Channels: aiStream, aiImage, aiImageModels, ai, search, aiAbort,
// agentControl, agentStep, permissionAllowlistList, permissionAllowlistRevoke,
// agentRuns, agentRunDetails, agentRun, agentTool, mcpServersList,
// mcpServerUpsert, mcpServerRemove, mcpServerEnable, mcpServerTest,
// mcpToolsRefresh.

function register(deps) {
  const {
    ipcMain,
    desktopCapturer,
    crypto,
    keysStore, settingsStore,
    selectedModel, applyReasoningProfile,
    localOpenAIEndpoint,
    runAiCompletion,
    resolveSkillsForMessages, appendSkillsToSystemPrompt,
    readSseStream, extractStreamPayload,
    activeStreams, streamRunId, broadcast,
    getDialecticModel,
    withPermission,
    loadAgentModules,
    getAgentLoop, getAgentTools, getAgentMemory, getMcpRegistry, getMcpManager,
    getPluginManager, getConnectionsManager, getPersonas, getSkillsManager,
    getGoogleAuth, getGithubConnector, getComputerUse, getBrowserManager,
    getSkillSuggester,
    activeAgentRuns, pendingAgentSteps,
    subagentDepthByRunId,
    planActPending, planActApprovedRuns,
    findActiveRun, getPermissionAllowlist, revokePermissionAllowlist,
    readAgentRuns, compactAgentRun, scrubRunValue, appendAgentRun,
    AgentRunController,
    broadcastAgentStep,
    currentWorkspaceRoot, getWorkspaceMemory,
    ensureGoogleWorkspaceTools, googleConnectionToolsForAgent, githubConnectionToolsForAgent,
    dispatchGoogleConnectionTool, dispatchGithubConnectionTool,
    nativeToolPack, toAnthropicMessages, toAnthropicTools, toOpenAIChatMessages,
    toOpenAITools, parseAnthropicToolCalls, parseOpenAIToolCalls, mapNativeToolCalls,
    firstTextFromAnthropic,
  } = deps;

  // ── AI Providers ──────────────────────────────────────────────────────────────
  ipcMain.handle('aiStream', async (event, messages, provider, system, opts = {}) => {
    const fetch = require('node-fetch');
    const runId = opts.streamId || streamRunId();
    const abort = new AbortController();
    const p = provider || settingsStore.get('provider') || 'gemini';
    const skillsResolved = resolveSkillsForMessages(messages, opts);
    let baseSystem = String(system || '').trim() || 'You are Horizon AI. Use Markdown.';
    try {
      const dialecticModel = getDialecticModel();
      if (dialecticModel && typeof dialecticModel.injection === 'function') {
        const dial = dialecticModel.injection(6);
        if (dial) baseSystem = baseSystem + dial;
      }
    } catch (_) {}
    const sysMsg = appendSkillsToSystemPrompt(baseSystem, skillsResolved);
    let reply = '';
    let reasoning = '';
    let usage = null;
    let model = '';
    const emit = (type, payload = {}) => {
      try { event.sender.send('aiStreamChunk', { runId, type, provider: p, ...payload }); } catch (_) {}
      try {
        if (type === 'delta' && payload.delta) broadcast('ai:chunk', { runId, delta: payload.delta });
        if (type === 'reasoning' && payload.delta) broadcast('ai:chunk', { runId, delta: payload.delta, reasoning: true });
        if (type === 'done') broadcast('ai:done', {
          runId,
          ok: true,
          fullText: payload.reply || reply,
          reply: payload.reply || reply,
          model: payload.model || model,
          usage: payload.usage || usage,
          reasoning: payload.reasoning || reasoning,
          skillsSelected: payload.skillsSelected || skillsResolved,
        });
        if (type === 'error') broadcast('ai:done', {
          runId,
          ok: false,
          error: payload.error || 'Stream failed',
          fullText: reply,
          reply,
          model,
          usage,
          reasoning,
        });
      } catch (_) {}
    };
    const fail = (error) => {
      emit('error', { error });
      return { ok: false, error, runId, model };
    };
    activeStreams.set(runId, abort);
    const openaiCompatible = {
      openai:     { url: 'https://api.openai.com/v1/chat/completions',                    model: selectedModel('openai', opts),     key: keysStore.get('k_openai') },
      groq:       { url: 'https://api.groq.com/openai/v1/chat/completions',               model: selectedModel('groq', opts),       key: keysStore.get('k_groq') },
      grok:       { url: 'https://api.x.ai/v1/chat/completions',                          model: selectedModel('grok', opts),       key: keysStore.get('k_grok') },
      deepseek:   { url: 'https://api.deepseek.com/chat/completions',                      model: selectedModel('deepseek', opts),   key: keysStore.get('k_deepseek') },
      mistral:    { url: 'https://api.mistral.ai/v1/chat/completions',                     model: selectedModel('mistral', opts),    key: keysStore.get('k_mistral') },
      qwen:       { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: selectedModel('qwen', opts), key: keysStore.get('k_qwen') },
      perplexity: { url: 'https://api.perplexity.ai/chat/completions',                     model: selectedModel('perplexity', opts), key: keysStore.get('k_perplexity') },
      openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions',                  model: selectedModel('openrouter', opts), key: keysStore.get('k_openrouter') },
    };

    try {
      let url, headers, body;
      const localEp = localOpenAIEndpoint(p);

      if (p === 'gemini') {
        const k = keysStore.get('k_gemini');
        if (!k) return fail('Gemini key not set');
        model = selectedModel('gemini', opts);
        const rawContents = (messages || []).map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content || '...' }],
        }));
        const contents = [];
        for (const msg of rawContents) {
          if (!contents.length) {
            if (msg.role === 'user') contents.push(msg);
          } else if (contents[contents.length - 1].role !== msg.role) {
            contents.push(msg);
          } else {
            contents[contents.length - 1].parts[0].text += '\n' + msg.parts[0].text;
          }
        }
        if (!contents.length) {
          const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
          contents.push({ role: 'user', parts: [{ text: lastMsg?.content || '...' }] });
        }
        if (contents[contents.length - 1].role !== 'user') contents.push({ role: 'user', parts: [{ text: 'continue' }] });
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
        headers = { 'Content-Type': 'application/json', 'x-goog-api-key': k };
        body = applyReasoningProfile('gemini', model, {
          system_instruction: { parts: [{ text: sysMsg }] },
          contents,
          generationConfig: { maxOutputTokens: 4096, temperature: 0.7 },
        });
      } else if (p === 'cohere') {
        const k = keysStore.get('k_cohere');
        if (!k) return fail('Cohere key not set');
        model = selectedModel('cohere', opts);
        url = 'https://api.cohere.com/v2/chat';
        headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` };
        body = { model, messages: [{ role: 'system', content: sysMsg }, ...(messages || [])], max_tokens: 4096, stream: true };
      } else if (localEp || openaiCompatible[p]) {
        const ep = localEp || openaiCompatible[p];
        model = selectedModel(p, opts);
        if (!localEp && !ep.key) return fail(`${p} key not set`);
        url = ep.url;
        headers = { 'Content-Type': 'application/json' };
        if (!localEp || ep.key) headers.Authorization = `Bearer ${ep.key}`;
        if (p === 'openrouter') {
          headers['HTTP-Referer'] = 'https://horizonaai.dev';
          headers['X-Title'] = 'Horizon Genesis';
        }
        body = applyReasoningProfile(p, model, {
          model,
          max_tokens: 4096,
          stream: true,
          messages: [{ role: 'system', content: sysMsg }, ...(messages || [])],
        });
        if (p === 'perplexity') body.stream_mode = 'concise';
      } else {
        return fail(`Streaming is not configured for ${p}`);
      }

      emit('start', { model });
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: abort.signal });
      if (!response.ok || !response.body) {
        const d = await response.json().catch(async () => ({ error: await response.text().catch(() => '') }));
        const msg = d.error?.message || d.message || d.error || `${p} stream failed (${response.status})`;
        return fail(msg);
      }

      await readSseStream(response, async ({ event: eventName, data }) => {
        if (abort.signal.aborted) throw new Error('aborted');
        const chunk = extractStreamPayload(p, eventName, data);
        if (chunk.error) {
          emit('error', { error: chunk.error });
          throw new Error(chunk.error);
        }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.reasoning) {
          reasoning += chunk.reasoning;
          emit('reasoning', { delta: chunk.reasoning });
        }
        if (chunk.text) {
          reply += chunk.text;
          emit('delta', { delta: chunk.text });
        }
        if (chunk.done) emit('done-part', { usage });
      });
      emit('done', { reply, model, usage, reasoning, skillsSelected: skillsResolved });
      return { ok: true, reply, model, usage, reasoning, runId, skillsSelected: skillsResolved };
    } catch (e) {
      const msg = abort.signal.aborted ? 'aborted' : (e?.message || String(e));
      emit('error', { error: msg });
      return { ok: false, error: msg, runId };
    } finally {
      activeStreams.delete(runId);
    }
  });

  // Phase 4.1 — image generation IPC.
  ipcMain.handle('aiImage', async (_, opts) => {
    try {
      const { generateImage } = require('../imageGen');
      return await generateImage(opts || {}, (svc) => keysStore.get(`k_${svc}`, null));
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('aiImageModels', async () => {
    try {
      const { listImageModels, DEFAULTS } = require('../imageGen');
      return { ok: true, models: listImageModels(), defaults: DEFAULTS };
    } catch (e) {
      return { ok: false, error: e?.message || String(e), models: {} };
    }
  });

  ipcMain.handle('ai', runAiCompletion);

  // ── Web Search ────────────────────────────────────────────────────────────────
  ipcMain.handle('search', async (_, query) => {
    const fetch = require('node-fetch');
    const key   = keysStore.get('k_tavily');
    if (!key) return { error: 'Tavily key not set', results: [] };
    try {
      const r = await fetch('https://api.tavily.com/search', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ api_key:key, query, max_results:5, include_answer:true })
      });
      const d = await r.json();
      return { answer: d.answer, results: d.results?.slice(0, 5) || [] };
    } catch(e) { return { error: e.message, results: [] }; }
  });

  ipcMain.handle('aiAbort', (_, runId) => {
    const ctl = activeStreams.get(runId);
    if (!ctl) return { ok: false, error: 'no active stream for runId' };
    try { ctl.abort(); } catch (_) {}
    activeStreams.delete(runId);
    return { ok: true };
  });

  // ── MCP server registry IPCs ─────────────────────────────────────────────
  ipcMain.handle('mcpServersList', async () => {
    loadAgentModules();
    const mcpRegistry = getMcpRegistry();
    if (!mcpRegistry) return { ok: false, error: 'MCP registry not loaded', servers: [] };
    return { ok: true, servers: await mcpRegistry.listServers() };
  });

  ipcMain.handle('mcpServerUpsert', async (_, config) => {
    loadAgentModules();
    const mcpRegistry = getMcpRegistry();
    if (!mcpRegistry) return { ok: false, error: 'MCP registry not loaded' };
    try { return { ok: true, server: await mcpRegistry.upsertServer(config) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('mcpServerRemove', async (_, id) => {
    loadAgentModules();
    const mcpRegistry = getMcpRegistry();
    if (!mcpRegistry) return { ok: false, error: 'MCP registry not loaded' };
    try { await mcpRegistry.removeServer(id); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('mcpServerEnable', async (_, id, enabled) => {
    loadAgentModules();
    const mcpRegistry = getMcpRegistry();
    if (!mcpRegistry) return { ok: false, error: 'MCP registry not loaded' };
    try { return { ok: true, server: await mcpRegistry.setEnabled(id, enabled) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('mcpServerTest', async (_, config) => {
    loadAgentModules();
    const mcpRegistry = getMcpRegistry();
    if (!mcpRegistry) return { ok: false, error: 'MCP registry not loaded' };
    try { return await mcpRegistry.testServer(config); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('mcpToolsRefresh', async () => {
    loadAgentModules();
    const mcpRegistry = getMcpRegistry();
    if (!mcpRegistry) return { ok: false, error: 'MCP registry not loaded' };
    try { return { ok: true, tools: await mcpRegistry.refreshTools() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // ── Agent control ─────────────────────────────────────────────────────────
  ipcMain.handle('agentControl', async (event, runId, action) => {
    const run = findActiveRun(runId);
    if (!run) return { ok: false, error: 'No active agent run' };
    if (action === 'approve-plan' || action === 'reject-plan') {
      const pending = planActPending.get(runId);
      if (!pending) return { ok: false, error: 'No plan-pending state for run' };
      if (action === 'approve-plan') {
        pending.resolve('approve');
        planActApprovedRuns.add(runId);
        const payload = { type: 'plan-decision', runId, decision: 'approve' };
        run.observe(payload);
        broadcastAgentStep(payload, event.sender);
        return { ok: true };
      } else {
        pending.resolve('reject');
        const payload = { type: 'plan-decision', runId, decision: 'reject' };
        run.observe(payload);
        broadcastAgentStep(payload, event.sender);
        try { run.stop(); } catch (_) {}
        return { ok: true };
      }
    }
    let result;
    if (action === 'pause') result = run.pause();
    else if (action === 'resume') result = run.resume();
    else if (action === 'step') result = run.step();
    else if (action === 'stop') result = run.stop();
    else return { ok: false, error: `Unknown agent control: ${action}` };
    const payload = { type: 'control', runId: run.record.id, action, status: run.record.status, currentStepId: run.record.currentStepId || null };
    run.observe(payload);
    broadcastAgentStep(payload, event.sender);
    return result;
  });

  ipcMain.handle('agentStep', async (_, stepId, decision) => {
    const run = pendingAgentSteps.get(stepId);
    if (!run) return { ok: false, error: 'No waiting step for this id' };
    return run.resolveStep(stepId, decision);
  });

  // Sprint-2.9 — subagent abort. The renderer Inspector subagent tree
  // exposes a "stop" button on running cards which calls this IPC.
  // The matching entry is created in main.js spawnSubagent and removed
  // when the run completes. Setting aborted=true makes the child loop's
  // controller.isStopped() return true on the next iteration.
  ipcMain.handle('subagentAbort', async (_, childRunId) => {
    if (!global._subagentAbortRegistry) return { ok: false, error: 'no registry' };
    const entry = global._subagentAbortRegistry.get(childRunId);
    if (!entry) return { ok: false, error: 'No active subagent with that id' };
    entry.aborted = true;
    return { ok: true };
  });

  ipcMain.handle('permissionAllowlistList', async () => ({
    ok: true,
    entries: getPermissionAllowlist(),
  }));

  ipcMain.handle('permissionAllowlistRevoke', async (_, id) => ({
    ok: true,
    revoked: revokePermissionAllowlist(String(id || '')),
    entries: getPermissionAllowlist(),
  }));

  ipcMain.handle('agentRuns', async (_, limit = 50) => {
    const active = [...activeAgentRuns.values()].map(r => compactAgentRun(r.record)).reverse();
    return { ok: true, active, history: readAgentRuns(limit).map(compactAgentRun) };
  });

  ipcMain.handle('agentRunDetails', async (_, runId) => {
    const active = activeAgentRuns.get(runId);
    if (active) return { ok: true, run: scrubRunValue(active.record), active: true };
    const found = readAgentRuns(200).find(r => r.id === runId);
    return found ? { ok: true, run: found, active: false } : { ok: false, error: 'Run not found' };
  });

  ipcMain.handle('agentRun', async (event, userMessage, opts = {}) => {
    loadAgentModules();

    const agentLoop = getAgentLoop();
    const agentTools = getAgentTools();
    const agentMemory = getAgentMemory();
    const mcpRegistry = getMcpRegistry();
    const pluginManager = getPluginManager();
    const connectionsManager = getConnectionsManager();
    const personas = getPersonas();
    const skillsManager = getSkillsManager();
    const skillSuggester = getSkillSuggester();
    const googleAuth = getGoogleAuth();
    const githubConnector = getGithubConnector();

    if (!agentLoop) {
      return { ok: false, error: 'Agent module not loaded', steps: [] };
    }

    const runId = opts.runId || `agent-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    subagentDepthByRunId.set(runId, 0);
    const provider = opts.provider || settingsStore.get('provider') || 'gemini';
    const lang     = settingsStore.get('lang') || 'en';
    const userName = settingsStore.get('userName') || 'User';
    const runRecord = {
      id: runId,
      prompt: String(userMessage || ''),
      provider,
      model: opts.model || selectedModel(provider, opts),
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      steps: [],
      events: [],
    };
    const controller = new AgentRunController(runRecord);
    activeAgentRuns.set(runId, controller);

    let sysInfo = null;
    try { sysInfo = await agentTools.getDetailedSysInfo(); } catch(e) {}
    sysInfo = sysInfo || {};
    if (agentMemory) {
      try {
        const personaForMemory = opts.personaId || settingsStore.get('persona') || 'jarvis';
        if (typeof agentMemory.setActivePersona === 'function') {
          agentMemory.setActivePersona(personaForMemory);
        }
        const relevant = (typeof agentMemory.semanticRecall === 'function')
          ? await agentMemory.semanticRecall(userMessage, 8, { activePersona: personaForMemory }).catch(() => agentMemory.recall(userMessage, 8))
          : agentMemory.recall(userMessage, 8);
        sysInfo.memory = {
          facts: agentMemory.getAllFacts(),
          relevant,
          recentConversations: agentMemory.searchConversations(userMessage, 5),
          userProfileBlock: typeof agentMemory.buildUserProfileBlock === 'function'
            ? agentMemory.buildUserProfileBlock()
            : '',
        };
      } catch (_) {}
    }
    try {
      const ws = currentWorkspaceRoot();
      if (ws) {
        const block = getWorkspaceMemory().buildSystemBlock(ws);
        if (block) sysInfo.workspaceMemoryBlock = block;
      }
    } catch (_) {}
    if (githubConnector) {
      try { sysInfo.github_repos = githubConnector.listRepos(); } catch (_) {}
    }
    if (connectionsManager) {
      try { sysInfo.connections = connectionsManager.list().filter(c => c.connected).map(c => ({ id: c.id, name: c.name, toolCount: c.toolCount })); } catch (_) {}
    }
    if (googleAuth) {
      try {
        sysInfo.google_workspace = { connected: Boolean(googleAuth.isAuthenticated?.()) };
        if (sysInfo.google_workspace.connected) await ensureGoogleWorkspaceTools().catch(() => null);
      } catch (_) {}
    }

    let pendingAttachedImages = Array.isArray(opts.attachedImages)
      ? opts.attachedImages.filter(im => im && im.dataUrl)
      : [];

    function parseDataUrl(dataUrl) {
      const m = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl || '');
      if (!m) return null;
      return { mediaType: m[1], base64: m[2] };
    }

    const aiFn = async (messages, systemPrompt, agentMeta = {}) => {
      const fetch = require('node-fetch');
      const localEp = localOpenAIEndpoint(provider);
      const k = localEp ? (localEp.key || '__local_no_key__') : keysStore.get(`k_${provider}`);
      if (!k) return { error: `${provider} key not set → Settings` };

      const includeImages = pendingAttachedImages.length > 0;
      const imagesToSend = includeImages ? pendingAttachedImages.slice() : [];
      if (includeImages) pendingAttachedImages = [];

      try {
        if (provider === 'gemini') {
          const model = selectedModel('gemini', opts);
          const contents = messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content || '...' }]
          }));
          const fixed = [];
          for (const m of contents) {
            if (!fixed.length && m.role !== 'user') continue;
            if (fixed.length && fixed[fixed.length-1].role === m.role)
              fixed[fixed.length-1].parts[0].text += '\n' + m.parts[0].text;
            else fixed.push(m);
          }
          if (!fixed.length) fixed.push({ role:'user', parts:[{text: userMessage}] });
          if (fixed[fixed.length-1].role !== 'user') fixed.push({ role:'user', parts:[{text:'continue'}] });
          if (imagesToSend.length) {
            const lastUser = fixed[fixed.length - 1];
            for (const im of imagesToSend) {
              const p = parseDataUrl(im.dataUrl);
              if (p) lastUser.parts.push({ inline_data: { mime_type: p.mediaType, data: p.base64 } });
            }
          }
          const geminiBody = applyReasoningProfile('gemini', model, {
            system_instruction:{parts:[{text:systemPrompt}]},
            contents:fixed,
            generationConfig:{maxOutputTokens:4096}
          });
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${k}`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify(geminiBody)
          });
          const d = await r.json();
          if (d.error) return { error: d.error.message };
          return { reply: d.candidates?.[0]?.content?.parts?.[0]?.text || 'No response', model };
        }

        if (provider === 'claude') {
          const model = selectedModel('claude', opts);
          const useNativeTools = Boolean(agentMeta.nativeTools && agentMeta.tools?.length);
          const toolPack = useNativeTools ? nativeToolPack(agentMeta.tools) : { tools: [], map: {} };
          let claudeMessages = useNativeTools ? toAnthropicMessages(messages) : messages;
          if (imagesToSend.length && claudeMessages.length) {
            claudeMessages = claudeMessages.slice();
            let li = claudeMessages.length - 1;
            while (li >= 0 && claudeMessages[li].role !== 'user') li--;
            if (li >= 0) {
              const orig = claudeMessages[li];
              const text = typeof orig.content === 'string' ? orig.content
                         : Array.isArray(orig.content) ? orig.content.find(x => x.type === 'text')?.text || '' : '';
              const blocks = [];
              for (const im of imagesToSend) {
                const p = parseDataUrl(im.dataUrl);
                if (p) blocks.push({
                  type: 'image',
                  source: { type: 'base64', media_type: p.mediaType, data: p.base64 },
                });
              }
              if (text) blocks.push({ type: 'text', text });
              claudeMessages[li] = { role: 'user', content: blocks };
            }
          }
          const body = applyReasoningProfile('claude', model, {
            model,
            max_tokens:4096,
            system:systemPrompt,
            messages: claudeMessages
          });
          if (useNativeTools) body.tools = toAnthropicTools(toolPack.tools);
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method:'POST',
            headers:{'Content-Type':'application/json','x-api-key':k,'anthropic-version':'2023-06-01'},
            body:JSON.stringify(body)
          });
          const d = await r.json();
          if (d.error) return { error: d.error.message };
          if (!d.content || !d.content[0]) return { error: 'Empty response from Claude' };
          const toolCalls = mapNativeToolCalls(parseAnthropicToolCalls(d), toolPack.map);
          const text = (d.content || []).find(b => b && b.type === 'text')?.text || '';
          return { reply: text || (toolCalls.length ? '' : firstTextFromAnthropic(d)), toolCalls, model };
        }

        // OpenAI-compatible
        const endpoints = {
          openai:     { url:'https://api.openai.com/v1/chat/completions',                    model:selectedModel('openai', opts) },
          groq:       { url:'https://api.groq.com/openai/v1/chat/completions',               model:selectedModel('groq', opts) },
          grok:       { url:'https://api.x.ai/v1/chat/completions',                          model:selectedModel('grok', opts) },
          deepseek:   { url:'https://api.deepseek.com/chat/completions',                     model:selectedModel('deepseek', opts) },
          mistral:    { url:'https://api.mistral.ai/v1/chat/completions',                    model:selectedModel('mistral', opts) },
          qwen:       { url:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model:selectedModel('qwen', opts) },
          perplexity: { url:'https://api.perplexity.ai/chat/completions',                    model:selectedModel('perplexity', opts) },
          openrouter: { url:'https://openrouter.ai/api/v1/chat/completions',                 model:selectedModel('openrouter', opts) },
        };
        const ep = localEp || endpoints[provider] || endpoints.openai;
        const headers = {'Content-Type':'application/json'};
        if (!localEp || localEp.key) headers.Authorization = `Bearer ${k}`;
        if (provider === 'openrouter') {
          headers['HTTP-Referer'] = 'https://horizonaai.dev';
          headers['X-Title'] = 'Horizon Genesis';
        }
        if (provider === 'cohere') {
          const model = selectedModel('cohere', opts);
          const r = await fetch('https://api.cohere.com/v2/chat', {
            method:'POST',
            headers,
            body:JSON.stringify({ model, messages:[{role:'system',content:systemPrompt},...messages], max_tokens:4096 })
          });
          const d = await r.json();
          if (d.message?.error || d.error) return { error: d.message?.error || d.error || 'Cohere error' };
          return { reply: d.message?.content?.[0]?.text || d.text || 'No response', model };
        }
        const useNativeOpenAITools = provider === 'openai' && Boolean(agentMeta.nativeTools && agentMeta.tools?.length);
        const toolPack = useNativeOpenAITools ? nativeToolPack(agentMeta.tools) : { tools: [], map: {} };
        let openaiMessages = useNativeOpenAITools
          ? toOpenAIChatMessages(messages, systemPrompt)
          : [{role:'system',content:systemPrompt},...messages];
        if (imagesToSend.length && openaiMessages.length) {
          openaiMessages = openaiMessages.slice();
          let li = openaiMessages.length - 1;
          while (li >= 0 && openaiMessages[li].role !== 'user') li--;
          if (li >= 0) {
            const orig = openaiMessages[li];
            const text = typeof orig.content === 'string' ? orig.content : '';
            const parts = [];
            for (const im of imagesToSend) {
              parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
            }
            if (text) parts.push({ type: 'text', text });
            openaiMessages[li] = { role: 'user', content: parts };
          }
        }
        const body = applyReasoningProfile(provider, ep.model, {
          model:ep.model,
          max_tokens:4096,
          messages: openaiMessages
        });
        if (useNativeOpenAITools) body.tools = toOpenAITools(toolPack.tools);
        const r = await fetch(ep.url, {
          method:'POST',
          headers,
          body:JSON.stringify(body)
        });
        const d = await r.json();
        if (d.error) return { error: d.error.message };
        if (!d.choices || !d.choices[0]) return { error: `Empty response from ${provider}` };
        const message = d.choices[0].message || {};
        const toolCalls = useNativeOpenAITools ? mapNativeToolCalls(parseOpenAIToolCalls(message), toolPack.map) : [];
        return { reply: message.content || '', toolCalls, model: ep.model };

      } catch(e) { return { error: e.message }; }
    };

    const screenCapFn = async () => {
      try {
        const src = await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1280,height:720}});
        if (!src.length) return null;
        return { ok:true, base64: src[0].thumbnail.toPNG().toString('base64') };
      } catch { return null; }
    };

    let mcpTools = [];
    if (mcpRegistry && settingsStore.get('mcp.enabled') !== false) {
      try { mcpTools = await mcpRegistry.toolsForAgent(); }
      catch (e) { console.warn('MCP tools unavailable:', e.message); }
    }

    let pluginTools = [];
    if (pluginManager && typeof pluginManager.getToolDefinitions === 'function') {
      try { pluginTools = pluginManager.getToolDefinitions() || []; }
      catch (e) { console.warn('Plugin tools unavailable:', e.message); }
    }

    let connectionTools = [];
    if (connectionsManager && typeof connectionsManager.toolsForAgent === 'function') {
      try { connectionTools = connectionsManager.toolsForAgent() || []; }
      catch (e) { console.warn('Connection tools unavailable:', e.message); }
    }
    connectionTools.push(...googleConnectionToolsForAgent(), ...githubConnectionToolsForAgent());

    const activePersonaId = settingsStore.get('persona') || 'jarvis';
    let allowedToolGroups = null;
    try {
      if (personas && typeof personas.getPersonaFull === 'function') {
        const personaFull = personas.getPersonaFull(activePersonaId);
        if (Array.isArray(personaFull?.allowedTools)) allowedToolGroups = personaFull.allowedTools;
      }
    } catch (_) {}
    const fullAccessMode = !!opts.unlockAllTools;
    const personaAllowsTool = (toolName) => {
      if (fullAccessMode) return true;
      if (!agentLoop?.toolAllowedByPersona) return true;
      return agentLoop.toolAllowedByPersona(toolName, allowedToolGroups);
    };

    const dispatchToolFn = async (tool, args) => {
      if (!personaAllowsTool(tool)) {
        return {
          ok: false,
          err: `Tool ${tool} is disabled for persona ${activePersonaId}`,
          error: `Tool ${tool} is disabled for persona ${activePersonaId}`,
        };
      }
      if (mcpRegistry && String(tool || '').includes('__')) {
        const mcpResult = await mcpRegistry.dispatch(tool, args);
        if (mcpResult) return mcpResult;
      }
      const connToolName = String(tool || '');
      if (connToolName.startsWith('conn_google_')) {
        return dispatchGoogleConnectionTool(connToolName, args || {});
      }
      if (connToolName.startsWith('conn_github_')) {
        return dispatchGithubConnectionTool(connToolName, args || {});
      }
      if (connToolName.startsWith('conn_') && connectionsManager) {
        const connResult = await connectionsManager.dispatch(tool, args || {});
        if (connResult) return connResult;
      }
      const t = String(tool || '');
      if (t.startsWith('plugin_') && pluginManager) {
        const def = pluginTools.find(d => d && d.name === t);
        if (def && def.pluginId) {
          const toolName = t.slice(`plugin_${def.pluginId}_`.length);
          try {
            const r = await pluginManager.executeTool(def.pluginId, toolName, args || {});
            return r;
          } catch (e) {
            return { ok: false, error: 'Plugin tool failed: ' + (e?.message || e) };
          }
        }
      }
      return agentTools.dispatchTool(tool, args, { runId, event });
    };

    const planActGateOn = settingsStore.get('planActGate') === true;
    let firstExecutingSeen = false;
    const onStep = async (step) => {
      if (planActGateOn
          && step?.type === 'executing'
          && !firstExecutingSeen
          && !planActApprovedRuns.has(runId)) {
        firstExecutingSeen = true;
        const planPending = {
          type: 'plan-pending',
          runId,
          firstTool: step.tool,
          firstArgs: step.args,
          reason: step.reason,
        };
        controller.observe(planPending);
        broadcastAgentStep(planPending, event.sender);
        const decision = await new Promise((resolve) => {
          planActPending.set(runId, { resolve, broadcastedAt: Date.now() });
        });
        planActPending.delete(runId);
        if (decision === 'reject') {
          const rejected = { type: 'plan-rejected', runId };
          controller.observe(rejected);
          broadcastAgentStep(rejected, event.sender);
          return;
        }
      }
      controller.observe(step);
      broadcastAgentStep(step, event.sender);
    };

    let result;
    try {
      const startStep = { type: 'run-start', runId, provider, model: runRecord.model, prompt: runRecord.prompt };
      controller.observe(startStep);
      broadcastAgentStep(startStep, event.sender);
      let skillsBlock = '';
      let skillsSelected = null;
      if (skillsManager) {
        try {
          const res = skillsManager.getSkillsBlock(userMessage, {
            forcedIds: Array.isArray(opts.forcedSkillIds) ? opts.forcedSkillIds : [],
          });
          skillsBlock = res.block || '';
          skillsSelected = {
            selected: (res.selected || []).map(s => ({ id: s.id, score: s.score, breakdown: s.breakdown, scope: s.scope, forced: s.forced, truncated: s.truncated, bytes: s.bytes })),
            scored: (res.scored || []).map(s => ({ id: s.id, score: s.score, breakdown: s.breakdown, scope: s.scope, forced: s.forced })),
          };
          skillsManager.recordUsage(skillsSelected.selected.map(s => s.id), userMessage, 'selected');
          const skillsStep = { type: 'skills-selected', runId, payload: skillsSelected };
          controller.observe(skillsStep);
          broadcastAgentStep(skillsStep, event.sender);
        } catch (e) {
          console.warn('skills resolve failed:', e.message);
        }
      }

      result = await agentLoop.runAgentLoop(userMessage, {
        aiFn,
        sysInfo,
        lang,
        userName,
        history: opts.history || [],
        maxSteps: opts.maxSteps || 8,
        onStep,
        analyzeScreenFn: screenCapFn,
        runId,
        control: controller,
        nativeTools: provider === 'claude' || provider === 'openai',
        extraTools: [...mcpTools, ...pluginTools, ...connectionTools],
        personaId: activePersonaId,
        allowedToolGroups,
        dispatchToolFn,
        skillsBlock,
        skillsSelected
      });
    } catch (e) {
      result = { ok: false, error: e.message, steps: runRecord.steps };
    } finally {
      runRecord.status = controller.stopped || result?.stopped ? 'stopped' : (result?.ok ? 'done' : 'error');
      runRecord.endedAt = new Date().toISOString();
      runRecord.answer = result?.answer || null;
      runRecord.error = result?.error || null;
      activeAgentRuns.delete(runId);
      subagentDepthByRunId.delete(runId);
      if (controller.pending) pendingAgentSteps.delete(controller.pending.stepId);
      const endStep = { type: 'run-end', runId, status: runRecord.status, result: scrubRunValue(result) };
      controller.observe(endStep);
      appendAgentRun(runRecord);
      broadcastAgentStep(endStep, event.sender);
    }

    if (agentMemory) {
      try {
        if (typeof agentMemory.learnFromTurn === 'function') {
          agentMemory.learnFromTurn(userMessage, result?.answer || result?.error || '', {
            provider,
            model: runRecord.model,
            persona: activePersonaId,
            runId,
          });
        } else {
          agentMemory.remember(`Task: ${userMessage}`, 'agent_task', 7);
          if (result.ok && result.answer) {
            agentMemory.remember(`Result: ${result.answer.slice(0, 200)}`, 'agent_result', 6);
          }
        }
      } catch (e) {
        console.warn('Memory learning failed:', e.message);
      }
    }

    if (skillSuggester) {
      try {
        if (skillsManager && typeof skillsManager.list === 'function') {
          skillSuggester.setKnownSkills((skillsManager.list() || []).map(s => s.id));
        }
        skillSuggester.ingestTurn(userMessage, {
          goalMet: result?.reflection?.goalMet || null,
          answer: result?.answer || '',
          runId,
        });
      } catch (e) {
        console.warn('SkillSuggester ingestTurn failed:', e.message);
      }
    }

    return { ...result, runId };
  });

  // ── DIRECT TOOL CALLS ────────────────────────────────────────────────────
  ipcMain.handle('agentTool', async (event, toolName, args) => {
    loadAgentModules();
    const agentTools = getAgentTools();
    const mcpRegistry = getMcpRegistry();
    const connectionsManager = getConnectionsManager();
    if (!agentTools) return { ok: false, err: 'Agent not loaded' };
    if (mcpRegistry && String(toolName || '').includes('__')) {
      const mcpResult = await mcpRegistry.dispatch(toolName, args);
      if (mcpResult) return mcpResult;
    }
    const tool = String(toolName || '');
    if (tool.startsWith('conn_google_')) {
      return withPermission(
        event.sender,
        tool,
        args || {},
        'Run Google connection tool',
        () => dispatchGoogleConnectionTool(tool, args || {})
      );
    }
    if (tool.startsWith('conn_github_')) {
      return withPermission(
        event.sender,
        tool,
        args || {},
        'Run GitHub connection tool',
        () => dispatchGithubConnectionTool(tool, args || {})
      );
    }
    if (tool.startsWith('conn_') && connectionsManager) {
      return withPermission(
        event.sender,
        tool,
        args || {},
        'Run connection tool',
        () => connectionsManager.dispatch(tool, args || {})
      );
    }
    return agentTools.dispatchTool(toolName, args);
  });
}

module.exports = { register };
