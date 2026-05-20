'use strict';

// Non-streaming chat completion + dialectic extractor.
// Was inline in main.js for the longest time; factored out in Sprint 6.
// Takes a deps object so the closures over `personas` / `dialecticModel`
// resolve lazily — those modules are only constructed after the first
// loadAgentModules() call.

function createAiCompletion(deps) {
  const {
    keysStore, settingsStore,
    selectedModel, applyReasoningProfile, localOpenAIEndpoint,
    resolveSkillsForMessages, appendSkillsToSystemPrompt,
    loadAgentModules,
    getPersonas, getDialecticModel,
  } = deps;

  async function runAiCompletion(_, messages, provider, system, opts) {
    const fetch    = require('node-fetch');
    const userName = settingsStore.get('userName') || 'user';

    const detectLang = () => {
      try {
        const recent = (messages || []).filter(m => m.role === 'user').slice(-5);
        const text = recent.map(m => String(m.content || '')).join(' ');
        return /[А-Яа-яЁё]/.test(text) ? 'ru' : 'en';
      } catch (_) { return 'en'; }
    };
    const lang = detectLang();

    const identity = `You are Horizon AI — an advanced personal desktop agent. You were created by Ernest Kostevich. You are NOT Claude, ChatGPT, Gemini, or any other AI — you are Horizon. User: ${userName}. Time: ${new Date().toLocaleString()}. You are intelligent, friendly, somewhat like JARVIS from Marvel. You can control the PC, see the screen. Use Markdown. Mirror the user's language: reply in whichever language they wrote in (Russian, English, anything else). Stay consistent within a conversation unless the user switches languages.`;

    let personaPrompt = '';
    try {
      loadAgentModules();
      const personas = getPersonas();
      if (personas) {
        const personaId = settingsStore.get('persona') || 'jarvis';
        const pp = personas.getPersonaPrompt(personaId, lang);
        if (pp && (!system || !system.includes(pp.slice(0, 32)))) {
          personaPrompt = pp;
        }
      }
    } catch (_) { /* persona is optional */ }

    const sysParts = [identity];
    if (personaPrompt) sysParts.push(personaPrompt);
    if (system && (!system.includes('Ты') && !system.includes('You are'))) {
      sysParts.push(system);
    } else if (system) {
      sysParts.length = 0;
      sysParts.push(system);
    }
    try {
      const dialecticModel = getDialecticModel();
      if (dialecticModel && typeof dialecticModel.injection === 'function') {
        const dial = dialecticModel.injection(6);
        if (dial) sysParts.push(dial);
      }
    } catch (_) {}
    const skillsResolved = resolveSkillsForMessages(messages, opts || {});
    const sysMsg = appendSkillsToSystemPrompt(sysParts.join('\n\n'), skillsResolved);

    const _usage = (d, provider) => {
      try {
        if (provider === 'claude') {
          const u = d?.usage; if (!u) return null;
          const p = u.input_tokens || 0, c = u.output_tokens || 0;
          return { prompt: p, completion: c, total: p + c };
        }
        if (provider === 'gemini') {
          const u = d?.usageMetadata; if (!u) return null;
          return {
            prompt: u.promptTokenCount || 0,
            completion: u.candidatesTokenCount || 0,
            total: u.totalTokenCount || ((u.promptTokenCount||0)+(u.candidatesTokenCount||0))
          };
        }
        if (provider === 'cohere') {
          const t = d?.usage?.tokens || d?.meta?.tokens; if (!t) return null;
          const p = t.input_tokens || 0, c = t.output_tokens || 0;
          return { prompt: p, completion: c, total: p + c };
        }
        const u = d?.usage; if (!u) return null;
        return {
          prompt: u.prompt_tokens || 0,
          completion: u.completion_tokens || 0,
          total: u.total_tokens || ((u.prompt_tokens||0)+(u.completion_tokens||0))
        };
      } catch (_) { return null; }
    };

    try {
      switch (provider) {
        case 'claude': {
          const k = keysStore.get('k_claude');
          if (!k) return { error: lang==='ru'?'Ключ Claude не задан → Настройки':'Claude key not set → Settings' };
          const claudeModel = selectedModel('claude', opts);
          const respProfile = settingsStore.get('responseProfile') || 'balanced';
          const claudeBody = { model: claudeModel, max_tokens: 4096, system: sysMsg, messages };
          if (respProfile === 'deep') {
            claudeBody.thinking = { type: 'enabled', budget_tokens: 8000 };
            claudeBody.max_tokens = 16000;
          }
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method:'POST', headers:{'Content-Type':'application/json','x-api-key':k,'anthropic-version':'2023-06-01'},
            body:JSON.stringify(claudeBody)
          });
          const d = await r.json(); if (d.error) return { error: d.error.message };
          const textBlock = (d.content || []).find(b => b && b.type === 'text');
          return { reply: textBlock?.text || d.content?.[0]?.text || 'No response', model: claudeModel, usage: _usage(d,'claude') };
        }
        case 'openai': {
          const k = keysStore.get('k_openai');
          if (!k) return { error: lang==='ru'?'Ключ OpenAI не задан':'OpenAI key not set' };
          const openaiModel = selectedModel('openai', opts);
          const respProfile = settingsStore.get('responseProfile') || 'balanced';
          const isReasoningModel = /^o[134]/.test(openaiModel) || /thinking|reasoning/.test(openaiModel);
          const openaiBody = { model: openaiModel, max_tokens: 4096, messages: [{role:'system',content:sysMsg},...messages] };
          if (isReasoningModel) {
            if (respProfile === 'deep') openaiBody.reasoning_effort = 'high';
            else if (respProfile === 'fast') openaiBody.reasoning_effort = 'low';
          }
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
            body:JSON.stringify(openaiBody)
          });
          const d = await r.json(); if (d.error) return { error: d.error.message };
          return { reply: d.choices?.[0]?.message?.content || 'No response', model: openaiModel, usage: _usage(d,'openai') };
        }
        case 'gemini': {
          const k = keysStore.get('k_gemini');
          if (!k) return { error: lang==='ru'?'Ключ Gemini не задан. Бесплатно: aistudio.google.com':'Gemini key not set. Free at aistudio.google.com' };
          const model = selectedModel('gemini', opts);
          const rawContents = messages.map(m => ({ role: m.role==='assistant'?'model':'user', parts:[{text: m.content||'...'}] }));
          const contents = [];
          for (const msg of rawContents) {
            if (contents.length === 0) {
              if (msg.role === 'user') contents.push(msg);
            } else if (contents[contents.length-1].role !== msg.role) {
              contents.push(msg);
            } else {
              contents[contents.length-1].parts[0].text += '\n' + msg.parts[0].text;
            }
          }
          if (!contents.length) contents.push({ role:'user', parts:[{text: messages[messages.length-1]?.content || '...'}] });
          if (contents[contents.length-1].role !== 'user') contents.push({ role:'user', parts:[{text:'...'}] });

          const respProfile = settingsStore.get('responseProfile') || 'balanced';
          const generationConfig = { maxOutputTokens:4096, temperature:0.7 };
          if (/^gemini-(2\.5|3)/.test(model)) {
            if (respProfile === 'deep') generationConfig.thinkingConfig = { thinkingBudget: -1 };
            else if (respProfile === 'fast') generationConfig.thinkingConfig = { thinkingBudget: 0 };
          }
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${k}`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ system_instruction:{parts:[{text:sysMsg}]}, contents, generationConfig })
          });
          const d = await r.json();
          if (d.error) return { error: d.error.message };
          const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            const reason = d.candidates?.[0]?.finishReason || d.promptFeedback?.blockReason || 'empty response';
            return { error: `Gemini: ${reason}. Check your API key at aistudio.google.com` };
          }
          return { reply: text, model, usage: _usage(d,'gemini') };
        }
        case 'groq': {
          const k = keysStore.get('k_groq');
          if (!k) return { error: lang==='ru'?'Ключ Groq не задан. Бесплатно: groq.com':'Groq key not set. Free at groq.com' };
          const groqModel = selectedModel('groq', opts);
          const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
            body:JSON.stringify({ model:groqModel, max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
          });
          const d = await r.json(); if (d.error) return { error: d.error.message };
          return { reply: d.choices?.[0]?.message?.content || 'No response', model: groqModel, usage: _usage(d,'groq') };
        }
        case 'grok': {
          const k = keysStore.get('k_grok');
          if (!k) return { error: lang==='ru'?'Ключ Grok (xAI) не задан → console.x.ai':'Grok (xAI) key not set → console.x.ai' };
          const grokModel = selectedModel('grok', opts);
          const r = await fetch('https://api.x.ai/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
            body:JSON.stringify({ model:grokModel, max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
          });
          const d = await r.json(); if (d.error) return { error: d.error.message };
          return { reply: d.choices?.[0]?.message?.content || 'No response', model: grokModel, usage: _usage(d,'grok') };
        }
        case 'deepseek': {
          const k = keysStore.get('k_deepseek');
          if (!k) return { error: lang==='ru'?'Ключ DeepSeek не задан → platform.deepseek.com':'DeepSeek key not set → platform.deepseek.com' };
          const deepseekModel = selectedModel('deepseek', opts);
          const r = await fetch('https://api.deepseek.com/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
            body:JSON.stringify({ model:deepseekModel, max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
          });
          const d = await r.json(); if (d.error) return { error: d.error.message };
          return { reply: d.choices?.[0]?.message?.content || 'No response', model: deepseekModel, usage: _usage(d,'deepseek') };
        }
        case 'mistral': {
          const k = keysStore.get('k_mistral');
          if (!k) return { error: lang==='ru'?'Ключ Mistral не задан → console.mistral.ai':'Mistral key not set → console.mistral.ai' };
          const mistralModel = selectedModel('mistral', opts);
          const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
            body:JSON.stringify({ model:mistralModel, max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
          });
          const d = await r.json(); if (d.error) return { error: d.error.message };
          return { reply: d.choices?.[0]?.message?.content || 'No response', model: mistralModel, usage: _usage(d,'mistral') };
        }
        case 'qwen': {
          const k = keysStore.get('k_qwen');
          if (!k) return { error: lang==='ru'?'Ключ Qwen не задан → dashscope.aliyuncs.com':'Qwen key not set → dashscope.aliyuncs.com' };
          const qwenModel = selectedModel('qwen', opts);
          const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
            body:JSON.stringify({ model:qwenModel, max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
          });
          const d = await r.json(); if (d.error) return { error: d.error.message };
          return { reply: d.choices?.[0]?.message?.content || 'No response', model: qwenModel, usage: _usage(d,'qwen') };
        }
        case 'perplexity': {
          const k = keysStore.get('k_perplexity');
          if (!k) return { error: lang==='ru'?'Ключ Perplexity не задан → perplexity.ai/settings/api':'Perplexity key not set → perplexity.ai/settings/api' };
          const pplxModel = selectedModel('perplexity', opts);
          const r = await fetch('https://api.perplexity.ai/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
            body:JSON.stringify({ model:pplxModel, max_tokens:4096, messages:[{role:'system',content:sysMsg},...messages] })
          });
          const d = await r.json(); if (d.error) return { error: d.error.message || d.error };
          return { reply: d.choices?.[0]?.message?.content || 'No response', model: pplxModel, usage: _usage(d,'perplexity') };
        }
        case 'cohere': {
          const k = keysStore.get('k_cohere');
          if (!k) return { error: lang==='ru'?'Ключ Cohere не задан → dashboard.cohere.com':'Cohere key not set → dashboard.cohere.com' };
          const cohereModel = selectedModel('cohere', opts);
          const r = await fetch('https://api.cohere.com/v2/chat', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${k}`},
            body:JSON.stringify({ model:cohereModel, messages:[{role:'system',content:sysMsg},...messages], max_tokens:4096 })
          });
          const d = await r.json(); if (d.message?.error || d.error) return { error: d.message?.error || d.error || 'Cohere error' };
          const text = d.message?.content?.[0]?.text || d.text || 'No response';
          return { reply: text, model: cohereModel, usage: _usage(d,'cohere') };
        }
        case 'openrouter': {
          const k = keysStore.get('k_openrouter');
          if (!k) return { error: lang==='ru'?'Ключ OpenRouter не задан → openrouter.ai/keys':'OpenRouter key not set → openrouter.ai/keys' };
          const orModel = selectedModel('openrouter', opts);
          const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${k}`,
              'HTTP-Referer': 'https://horizonaai.dev',
              'X-Title': 'Horizon Genesis',
            },
            body: JSON.stringify({ model: orModel, max_tokens: 4096, messages: [{role:'system',content:sysMsg},...messages] })
          });
          const d = await r.json();
          if (d.error) return { error: d.error.message || d.error };
          return { reply: d.choices?.[0]?.message?.content || 'No response', model: orModel, usage: _usage(d,'openrouter') };
        }
        case 'ollama':
        case 'lmstudio':
        case 'localai': {
          const ep = localOpenAIEndpoint(provider);
          const headers = { 'Content-Type': 'application/json' };
          if (ep.key) headers.Authorization = `Bearer ${ep.key}`;
          const r = await fetch(ep.url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: selectedModel(provider, opts),
              max_tokens: 4096,
              messages: [{ role: 'system', content: sysMsg }, ...messages],
            }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) return { error: d.error?.message || d.error || `${provider} connection failed (${r.status})` };
          return { reply: d.choices?.[0]?.message?.content || 'No response', model: selectedModel(provider, opts), usage: _usage(d, provider) };
        }
        default: return { error: `Unknown provider: ${provider}` };
      }
    } catch(e) { return { error: `Network error: ${e.message}` }; }
  }

  async function _extractDialecticDiffs(user, assistant, recent, ctx) {
    try {
      if (!user || !assistant) return [];
      const recentLines = (recent || [])
        .slice(0, 5)
        .map(r => `- [${r.kind}] ${r.after}${r.before ? ' (was: ' + r.before + ')' : ''}`)
        .join('\n') || '(empty — this is one of the first records)';

      const systemPrompt = [
        'You are a user-model extractor. After each conversation turn, you emit a JSON object describing what NEW information the turn revealed about the user.',
        '',
        'Valid kinds:',
        '  belief          — a new opinion or preference the user revealed',
        '  desire          — a new goal or want',
        '  knowledge       — a fact about the user\'s skills / context they just stated',
        '  theory-of-mind  — an assumption we made that was confirmed or refuted',
        '  correction      — something the user explicitly corrected',
        '',
        'Recent diff log (do not re-emit these):',
        recentLines,
        '',
        'Rules:',
        '  • Emit AT MOST 3 entries. Empty {"updates":[]} is fine if nothing was learned.',
        '  • Skip trivial small-talk and acknowledgements.',
        '  • Skip facts the user has clearly stated before (see the log above).',
        '  • Each entry: {"kind":"...","before":null or "...","after":"<= 200 chars","evidence":"<= 120 chars quote","confidence":0.0..1.0}',
        '  • RESPOND WITH RAW JSON ONLY. No prose, no markdown fences.',
      ].join('\n');

      const messages = [{
        role: 'user',
        content: 'TURN:\nUser: ' + String(user).slice(0, 1200) + '\nAssistant: ' + String(assistant).slice(0, 1200),
      }];
      const activeProvider = settingsStore.get('provider') || 'gemini';
      const opts = { temperature: 0.1, maxTokens: 280 };
      const r = await runAiCompletion(null, messages, activeProvider, systemPrompt, opts);
      if (!r || r.error || !r.reply) return [];
      let raw = String(r.reply).trim();
      raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (_) {
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) return [];
        try { parsed = JSON.parse(m[0]); } catch (_) { return []; }
      }
      const list = Array.isArray(parsed) ? parsed
                 : Array.isArray(parsed?.updates) ? parsed.updates
                 : [];
      return list
        .filter(x => x && typeof x === 'object' && x.kind && x.after)
        .slice(0, 3);
    } catch (e) {
      console.warn('[dialectic] extractor exception:', e.message);
      return [];
    }
  }

  return { runAiCompletion, _extractDialecticDiffs };
}

module.exports = { createAiCompletion };
