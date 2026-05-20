// Horizon Mobile PWA — single-file SPA, no build step, no framework.
//
// Talks to a `horizon serve` instance via the same /api/* endpoints
// the desktop GUI uses. Bearer token + server URL live in localStorage.
//
// Pairing modes (most → least common):
//   1. QR scan from desktop: user opens Settings → Mobile → Connect phone
//      (or `horizon mobile`), scans the QR. The QR encodes a URL of the
//      form  http://<lan-ip>:18789/?token=<hex>  — the PWA picks up both
//      the token and the server URL on first load, saves them, and lands
//      the user straight in the chat.
//   2. In-PWA camera scan: user opens the PWA directly (typing the IP or
//      via a bookmark) → sees the pair screen → taps "Scan QR with camera"
//      and we use BarcodeDetector (Chrome Android, Edge) or a file-picker
//      fallback to extract the same URL.
//   3. Manual entry: collapsed `<details>` for users who already have the
//      URL + token in hand (e.g. copied from the desktop UI).
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

  // Pre-fill from URL hash/search params (QR pairing). If only `token`
  // is present, assume the PWA is being served from the same origin as
  // the API and default state.url to location.origin — this is what
  // `horizon mobile` produces and what every QR pair flow expects.
  //
  // We check BOTH ?search and #hash because some third-party QR scanner
  // apps strip the `?` and present the URL with a `#` (or vice versa).
  // ingestPairUrl() below is shared with the in-app camera scanner so
  // any of those paths funnels through one parser. We save() on hit so
  // reloads after pairing don't bounce the user back to the pair form.
  ingestPairUrl(location.href);

  /**
   * Pull `token` and `url` out of any URL string and merge into state.
   * Used both on initial load and when the camera scanner returns a hit.
   * If the URL is just a token-only link (`?token=…`), defaults the
   * server URL to the URL's origin (which is what `horizon mobile`
   * produces — the QR points at the same server that serves the PWA).
   *
   * Returns true if at least a token was found.
   */
  function ingestPairUrl(raw, opts = {}) {
    try {
      const u = new URL(raw, location.href);
      const hashParams = new URLSearchParams(
        (u.hash || '').replace(/^#/, '')
      );
      const searchParams = new URLSearchParams(u.search || '');
      const token = searchParams.get('token') || hashParams.get('token');
      const serverUrl = searchParams.get('url') || hashParams.get('url');
      if (!token && !serverUrl) return false;
      if (token) state.token = token;
      if (serverUrl) state.url = serverUrl;
      else if (token && !state.url) {
        // QR was scanned while loading PWA directly (e.g. user typed the
        // IP, then later tapped the in-app scanner). Use the URL's origin
        // as the API target — `horizon mobile` always serves the PWA
        // from the same host:port as the API.
        try { state.url = new URL(raw, location.href).origin; }
        catch (_) { state.url = location.origin; }
      }
      if (opts.save !== false) save();
      // Strip the token from the visible URL so it doesn't leak into
      // history / share sheets. Only touch history if the payload we
      // ingested actually came from the current location bar — passing
      // a scanned-QR string in shouldn't rewrite history.
      if (raw === location.href && (location.search || location.hash)) {
        history.replaceState(null, '', location.pathname);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  async function api(method, path, body) {
    let r;
    try {
      r = await fetch(state.url.replace(/\/$/, '') + path, {
        method,
        headers: {
          'Accept': 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          'Authorization': 'Bearer ' + state.token,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      // Network error — server unreachable. Re-throw with a clearer message.
      throw new Error('cannot reach server (check Wi-Fi / URL)');
    }
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      // Try to surface a JSON error if the server returned one
      let detail = err.slice(0, 200);
      try {
        const j = JSON.parse(err);
        if (j.error) detail = j.error;
      } catch (_) {}
      if (r.status === 401) throw new Error('unauthorized — token rejected');
      if (r.status === 404) throw new Error(`not found (${path})`);
      throw new Error(`HTTP ${r.status}: ${detail}`);
    }
    // Some endpoints accidentally return HTML when misrouted — catch the
    // JSON parse error and give a useful hint instead of "Unexpected
    // token '<'".
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      if (text.trim().startsWith('<')) {
        throw new Error('server returned HTML (check token / server URL)');
      }
      throw new Error('bad JSON from server');
    }
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

  // QR scan button — opens the camera (BarcodeDetector) or file picker.
  const pairScanBtn = $('pair-scan');
  if (pairScanBtn) pairScanBtn.addEventListener('click', openQrScanner);

  // Auto-connect if state already populated (returning visit or QR-paired).
  // Includes the case where we just ingested `?token=…` from location: the
  // server-URL was set to location.origin, so the probe should succeed and
  // the user never sees the pair form at all — straight to chat.
  if (state.url && state.token) {
    tryConnect(state.url, state.token).then(enterApp).catch((e) => {
      // Drop bad creds + show pairing form
      $('pair-error').textContent = e.message;
      $('pair-error').classList.remove('hidden');
      // Open the manual details so the user can see / fix the bad values
      const det = document.querySelector('.pair-manual');
      if (det) det.open = true;
      show('pair');
    });
  } else {
    // Pre-fill if we have one of the two
    $('pair-url').value = state.url || '';
    $('pair-token').value = state.token || '';
    show('pair');
  }

  // ── QR camera scanner ────────────────────────────────────────────────
  // Two-tier approach:
  //   tier 1 — BarcodeDetector API (Chrome on Android, Edge, etc.)
  //            Live video feed + a 200 ms poll on detector.detect(video).
  //            On first hit we stop the stream, ingest the URL, connect.
  //   tier 2 — File picker fallback (iOS Safari, Firefox).
  //            User taps "Choose QR photo" → snaps a pic with their camera
  //            app (the `capture="environment"` attribute hints the system
  //            camera) → we run BarcodeDetector on the still image if
  //            available, otherwise show a hint to use the OS camera app.
  let qrScanState = { stream: null, raf: 0, running: false };

  async function openQrScanner() {
    const modal = $('qr-scan-modal');
    const video = $('qr-scan-video');
    const fallback = $('qr-scan-fallback');
    const errEl = $('pair-scan-err');
    errEl.classList.add('hidden');
    modal.classList.remove('hidden');

    // Tier 1: live BarcodeDetector. Requires camera permission + secure
    // context (https or localhost). If either is missing, show the
    // file-picker fallback right away — no point asking for permission
    // we can't use.
    const isSecure = window.isSecureContext || /^localhost$|^127\.|^\[?::1\]?$/.test(location.hostname);
    const hasDetector = ('BarcodeDetector' in window);

    if (!hasDetector || !isSecure || !navigator.mediaDevices?.getUserMedia) {
      fallback.classList.remove('hidden');
      video.classList.add('hidden');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      qrScanState.stream = stream;
      qrScanState.running = true;
      video.classList.remove('hidden');
      fallback.classList.add('hidden');
      video.srcObject = stream;
      await video.play().catch(() => {});

      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      const tick = async () => {
        if (!qrScanState.running) return;
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length) {
            const raw = codes[0].rawValue || '';
            if (raw && handleScannedPayload(raw)) {
              closeQrScanner();
              return;
            }
          }
        } catch (_) { /* swallow per-frame errors — keep polling */ }
        qrScanState.raf = setTimeout(tick, 200);
      };
      tick();
    } catch (e) {
      // Permission denied / no camera — fall back to file picker.
      fallback.classList.remove('hidden');
      video.classList.add('hidden');
      const fbErr = $('qr-scan-fallback-err');
      if (fbErr) {
        fbErr.textContent = 'Camera unavailable: ' + (e.message || e.name || 'unknown');
        fbErr.classList.remove('hidden');
      }
    }
  }

  function closeQrScanner() {
    const modal = $('qr-scan-modal');
    qrScanState.running = false;
    if (qrScanState.raf) { clearTimeout(qrScanState.raf); qrScanState.raf = 0; }
    if (qrScanState.stream) {
      try { qrScanState.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      qrScanState.stream = null;
    }
    modal.classList.add('hidden');
  }

  // Process a scanned/decoded payload. Returns true if it looked like a
  // pair URL we could use, false otherwise (lets the camera loop keep
  // polling instead of bailing on a random QR).
  function handleScannedPayload(raw) {
    if (!ingestPairUrl(raw)) {
      const errEl = $('pair-scan-err');
      errEl.textContent = 'That QR doesn\'t look like a Horizon pairing code. Make sure you\'re scanning the one from Settings → Mobile → Connect phone.';
      errEl.classList.remove('hidden');
      return false;
    }
    // Probe + enter the app. Show errors back on the pair card on failure.
    tryConnect(state.url, state.token).then(enterApp).catch((e) => {
      const errEl = $('pair-scan-err');
      errEl.textContent = 'Connected to QR but server rejected token: ' + e.message;
      errEl.classList.remove('hidden');
      const det = document.querySelector('.pair-manual');
      if (det) det.open = true;
    });
    return true;
  }

  // Close button + Escape
  const qrCloseBtn = $('qr-scan-close');
  if (qrCloseBtn) qrCloseBtn.addEventListener('click', closeQrScanner);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('qr-scan-modal').classList.contains('hidden')) {
      closeQrScanner();
    }
  });
  // Tap outside the frame to close
  $('qr-scan-modal').addEventListener('click', (e) => {
    if (e.target.id === 'qr-scan-modal') closeQrScanner();
  });

  // File-picker fallback: decode QR from a still image.
  const qrFileInput = $('qr-file-input');
  if (qrFileInput) qrFileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const fbErr = $('qr-scan-fallback-err');
    fbErr.classList.add('hidden');
    if (!('BarcodeDetector' in window)) {
      fbErr.textContent = 'This browser can\'t decode QR images. Try opening the camera app, scan the QR, then tap the link that appears.';
      fbErr.classList.remove('hidden');
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      const codes = await detector.detect(bitmap);
      if (!codes || !codes.length) {
        fbErr.textContent = 'No QR code found in that image — try again with a sharper photo.';
        fbErr.classList.remove('hidden');
        return;
      }
      const raw = codes[0].rawValue || '';
      if (!handleScannedPayload(raw)) return;
      closeQrScanner();
    } catch (err) {
      fbErr.textContent = 'Failed to decode image: ' + (err.message || err.name || 'unknown');
      fbErr.classList.remove('hidden');
    } finally {
      // Allow re-picking the same file
      try { qrFileInput.value = ''; } catch (_) {}
    }
  });

  // ── App view ─────────────────────────────────────────────────────────
  let statusPollTimer = null;

  async function enterApp() {
    show('app');
    setModePill();
    await refreshHeader();
    await populateSettings();
    startStatusPoll();
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

  /** Pull /api/status and update the header dot + persona/provider summary. */
  async function refreshHeader() {
    try {
      const s = await api('GET', '/api/status');
      $('hdr-title').textContent = 'Horizon · ' + (s.persona || 'jarvis');
      $('hdr-status').textContent = `online · ${s.provider || '?'} · ${s.memoryCount || 0} mem · v${s.serverVersion}`;
      $('hdr-status').classList.remove('offline');
      $('hdr-status').classList.add('online');
      $('info-url').textContent = state.url;
      $('info-mem').textContent = (s.memoryCount || 0);
      $('info-skills').textContent = (s.skillsCount || 0);
      return s;
    } catch (e) {
      $('hdr-status').textContent = 'offline · ' + e.message.slice(0, 40);
      $('hdr-status').classList.remove('online');
      $('hdr-status').classList.add('offline');
      return null;
    }
  }

  /** Poll /api/status every 10s for a live online indicator. */
  function startStatusPoll() {
    if (statusPollTimer) clearInterval(statusPollTimer);
    statusPollTimer = setInterval(() => { refreshHeader().catch(() => {}); }, 10_000);
  }

  async function populateSettings() {
    try {
      const [personas, providers, status] = await Promise.all([
        api('GET', '/api/personas').catch(() => []),
        api('GET', '/api/providers').catch(() => []),
        api('GET', '/api/status').catch(() => ({})),
      ]);

      const sel = $('set-persona');
      sel.innerHTML = '';
      const personaList = Array.isArray(personas) ? personas : [];
      for (const p of personaList) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name ? `${p.id} · ${p.name}` : p.id;
        if (p.id === status.persona) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = async () => {
        try {
          await api('POST', '/api/settings', { persona: sel.value });
        } catch (e) {
          // Old server with no /api/settings — fall back to /api/persona
          await api('POST', '/api/persona', { id: sel.value }).catch(() => {});
        }
        await refreshHeader();
      };

      const provSel = $('set-provider');
      provSel.innerHTML = '';
      const provList = Array.isArray(providers) && providers.length ? providers
        // Backstop list in case /api/providers is missing on an old server.
        : ['auto','gemini','claude','openai','groq','deepseek','grok','mistral','qwen','perplexity','cohere','openrouter','together','fireworks','deepinfra','cerebras','sambanova','moonshot','zai','nebius','ollama','lmstudio'].map(id => ({ id, hasKey: false }));
      for (const p of provList) {
        const o = document.createElement('option');
        o.value = p.id;
        // Mark configured providers with a • so the user sees what works
        const tag = p.hasKey ? ' •' : p.local ? ' (local)' : '';
        o.textContent = p.id + tag;
        if (p.id === status.provider) o.selected = true;
        provSel.appendChild(o);
      }
      provSel.onchange = async () => {
        try {
          await api('POST', '/api/settings', { provider: provSel.value });
        } catch (e) {
          await api('POST', '/api/model', { provider: provSel.value }).catch(() => {});
        }
        await refreshHeader();
      };
    } catch (e) {
      // Surface the error in the drawer so the user can see why the
      // dropdowns are empty.
      $('info-url').textContent = state.url + ' (' + e.message + ')';
    }
  }

  // Drawer
  $('open-menu').addEventListener('click', () => $('drawer').classList.remove('hidden'));
  $('close-drawer').addEventListener('click', () => $('drawer').classList.add('hidden'));
  $('reset-pair').addEventListener('click', () => {
    if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
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
