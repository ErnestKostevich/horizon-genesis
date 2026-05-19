// Horizon Mobile PWA — single-file SPA, no build step, no framework.
//
// Talks to a `horizon serve` instance via the same /api/* endpoints
// the desktop GUI uses. Bearer token + server URL live in localStorage.
//
// Pairing modes:
//   1. Manual: user types URL + token into the pairing form.
//   2. URL hash: visit https://server/?token=...&url=... (host prefills
//      both fields and auto-connects). Same shape as the QR code the
//      `horizon serve` console prints.
//
// Streaming via SSE on /api/agent — the browser EventSource handles
// keep-alive + reconnect for us.

(() => {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────
  const state = {
    url:    localStorage.getItem('horizon.url')   || '',
    token:  localStorage.getItem('horizon.token') || '',
    mode:   localStorage.getItem('horizon.mode')  || 'chat', // chat | agent
    history: [],
    sending: false,
  };

  // Pre-fill from URL hash/search params (QR pairing)
  (() => {
    const params = new URLSearchParams(location.search || location.hash.slice(1));
    const t = params.get('token');
    const u = params.get('url');
    if (t) state.token = t;
    if (u) state.url = u;
    if (t || u) {
      // Clean URL so the token isn't visible in browser history
      history.replaceState(null, '', location.pathname);
    }
  })();

  // ── Helpers ──────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  async function api(method, path, body) {
    const r = await fetch(state.url.replace(/\/$/, '') + path, {
      method,
      headers: {
        'Accept': 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'Authorization': 'Bearer ' + state.token,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${err.slice(0, 200)}`);
    }
    return r.json();
  }

  function save() {
    localStorage.setItem('horizon.url', state.url);
    localStorage.setItem('horizon.token', state.token);
    localStorage.setItem('horizon.mode', state.mode);
  }

  function show(viewId) {
    $('pair-view').classList.toggle('hidden', viewId !== 'pair');
    $('app-view').classList.toggle('hidden', viewId !== 'app');
  }

  function addMsg(role, text, opts = {}) {
    const div = document.createElement('div');
    div.className = 'msg ' + role + (opts.error ? ' error' : '');
    // Render markdown light: code, bold, line breaks
    div.innerHTML = renderInline(text);
    $('thread').appendChild(div);
    scrollBottom();
    return div;
  }

  function addStep(text) {
    const div = document.createElement('div');
    div.className = 'msg step';
    div.innerHTML = text;
    $('thread').appendChild(div);
    scrollBottom();
    return div;
  }

  function addTyping() {
    const div = document.createElement('div');
    div.className = 'typing';
    div.innerHTML = '<span></span><span></span><span></span>';
    $('thread').appendChild(div);
    scrollBottom();
    return div;
  }

  function scrollBottom() {
    const t = $('thread');
    t.scrollTop = t.scrollHeight;
  }

  function renderInline(text) {
    // Escape, then re-introduce inline markdown
    let s = String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Triple-backtick fences first
    s = s.replace(/```(\w+)?\n?([\s\S]+?)```/g, (_, lang, code) =>
      `<pre><code>${code.trim()}</code></pre>`);
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '<em>$1</em>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  // ── Pairing flow ─────────────────────────────────────────────────────
  async function tryConnect(url, token) {
    if (!url || !token) throw new Error('Server URL and token are required');
    // Probe /api/health first — fail fast on bad URL or token
    const probe = await fetch(url.replace(/\/$/, '') + '/api/health', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (probe.status === 401) throw new Error('Token rejected (401) — check the value printed by `horizon serve`');
    if (!probe.ok) throw new Error(`Server returned ${probe.status}`);
    return true;
  }

  $('pair-connect').addEventListener('click', async () => {
    const url = $('pair-url').value.trim();
    const token = $('pair-token').value.trim();
    $('pair-error').classList.add('hidden');
    try {
      await tryConnect(url, token);
      state.url = url; state.token = token; save();
      enterApp();
    } catch (e) {
      $('pair-error').textContent = e.message;
      $('pair-error').classList.remove('hidden');
    }
  });

  // Auto-connect if state already populated (returning visit or QR-paired)
  if (state.url && state.token) {
    tryConnect(state.url, state.token).then(enterApp).catch((e) => {
      // Drop bad creds + show pairing form
      $('pair-error').textContent = e.message;
      $('pair-error').classList.remove('hidden');
      show('pair');
    });
  } else {
    // Pre-fill if we have one of the two
    $('pair-url').value = state.url || '';
    $('pair-token').value = state.token || '';
    show('pair');
  }

  // ── App view ─────────────────────────────────────────────────────────
  async function enterApp() {
    show('app');
    setModePill();
    await refreshHeader();
    await populateSettings();
  }

  function setModePill() {
    const btn = $('mode-toggle');
    btn.textContent = state.mode;
    btn.dataset.mode = state.mode;
  }

  $('mode-toggle').addEventListener('click', () => {
    state.mode = state.mode === 'chat' ? 'agent' : 'chat';
    save();
    setModePill();
  });

  async function refreshHeader() {
    try {
      const v = await api('GET', '/api/version');
      $('hdr-title').textContent = 'Horizon · ' + (v.persona || 'jarvis');
      $('hdr-status').textContent = `${v.provider || '?'} · ${v.memory?.memories || 0} mem · v${v.version}`;
      $('info-url').textContent = state.url;
      $('info-mem').textContent = (v.memory?.memories || 0);
      $('info-skills').textContent = (v.skills || 0);
    } catch (e) {
      $('hdr-status').textContent = 'offline · ' + e.message.slice(0, 30);
    }
  }

  async function populateSettings() {
    try {
      const personas = await api('GET', '/api/personas');
      const v = await api('GET', '/api/version');
      const sel = $('set-persona');
      sel.innerHTML = '';
      for (const p of personas) {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.id;
        if (p.id === v.persona) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = async () => {
        await api('POST', '/api/persona', { id: sel.value }).catch(() => {});
        await refreshHeader();
      };
      // Provider dropdown — hard-coded list (matches DEFAULT_PROVIDER_MODELS)
      const provSel = $('set-provider');
      provSel.innerHTML = '';
      for (const p of ['auto','gemini','claude','openai','groq','deepseek','grok','mistral','qwen','perplexity','cohere','openrouter','together','fireworks','deepinfra','cerebras','sambanova','moonshot','zai','nebius','ollama','lmstudio']) {
        const o = document.createElement('option');
        o.value = p; o.textContent = p;
        if (p === v.provider) o.selected = true;
        provSel.appendChild(o);
      }
      provSel.onchange = async () => {
        await api('POST', '/api/model', { provider: provSel.value }).catch(() => {});
        await refreshHeader();
      };
    } catch (_) {}
  }

  // Drawer
  $('open-menu').addEventListener('click', () => $('drawer').classList.remove('hidden'));
  $('close-drawer').addEventListener('click', () => $('drawer').classList.add('hidden'));
  $('reset-pair').addEventListener('click', () => {
    localStorage.clear();
    location.reload();
  });

  // Composer — auto-grow
  const composer = $('composer');
  composer.addEventListener('input', () => {
    composer.style.height = 'auto';
    composer.style.height = Math.min(composer.scrollHeight, 120) + 'px';
  });
  composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $('send').addEventListener('click', send);

  async function send() {
    if (state.sending) return;
    const text = composer.value.trim();
    if (!text) return;
    state.sending = true;
    composer.value = '';
    composer.style.height = 'auto';
    addMsg('user', text);
    state.history.push({ role: 'user', content: text });

    if (state.mode === 'chat') {
      const typing = addTyping();
      try {
        const r = await api('POST', '/api/chat', {
          message: text,
          history: state.history.slice(-10),
        });
        typing.remove();
        if (r.error) addMsg('bot', r.error, { error: true });
        else {
          addMsg('bot', r.reply || '...');
          state.history.push({ role: 'assistant', content: r.reply });
        }
      } catch (e) {
        typing.remove();
        addMsg('bot', e.message, { error: true });
      } finally {
        state.sending = false;
        refreshHeader();
      }
    } else {
      // Agent mode — SSE stream
      await runAgentStream(text);
    }
  }

  async function runAgentStream(task) {
    const typing = addTyping();
    let answerEl = null;
    try {
      // Use POST with fetch + ReadableStream because EventSource doesn't
      // support custom headers (auth) cross-platform.
      const r = await fetch(state.url.replace(/\/$/, '') + '/api/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Authorization': 'Bearer ' + state.token,
        },
        body: JSON.stringify({
          task,
          history: state.history.slice(-10),
          max_steps: 8, reflect: true,
        }),
      });
      typing.remove();
      if (!r.ok) {
        addMsg('bot', `HTTP ${r.status} — ${await r.text().catch(() => '')}`, { error: true });
        state.sending = false;
        return;
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!chunk) continue;
          const evLine = chunk.split('\n').find(l => l.startsWith('event: '));
          const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!evLine || !dataLine) continue;
          const event = evLine.slice(7).trim();
          let data; try { data = JSON.parse(dataLine.slice(6)); } catch (_) { continue; }
          if (event === 'step') handleStep(data);
          if (event === 'end')  handleEnd(data);
        }
      }
    } catch (e) {
      typing.remove();
      addMsg('bot', e.message, { error: true });
    } finally {
      state.sending = false;
      refreshHeader();
    }
  }

  function handleStep(ev) {
    if (ev.type === 'plan' && ev.plan?.steps) {
      addStep('<strong>plan</strong><br>' + ev.plan.steps.map((s, i) => `${i+1}. ${typeof s === 'string' ? s : s.text || ''}`).join('<br>'));
    } else if (ev.type === 'executing') {
      addStep(`<strong>→ ${ev.tool}</strong> <code>${JSON.stringify(ev.args || {}).slice(0, 80)}</code>`);
    } else if (ev.type === 'result') {
      const tag = ev.ok ? '✓' : '✗';
      const out = String(ev.result?.out || ev.result?.err || '').slice(0, 200);
      addStep(`<strong>${tag} ${ev.tool}</strong> ${out}`);
    } else if (ev.type === 'reflection') {
      const tag = ev.goalMet === 'yes' ? '● goal met' : ev.goalMet === 'partial' ? '● partial' : '● not met';
      addStep(tag);
    }
  }

  function handleEnd(ev) {
    if (ev.error) {
      addMsg('bot', ev.error, { error: true });
    } else if (ev.answer) {
      addMsg('bot', ev.answer);
      state.history.push({ role: 'assistant', content: ev.answer });
    }
  }

  // Service worker for offline shell + installability
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
})();
