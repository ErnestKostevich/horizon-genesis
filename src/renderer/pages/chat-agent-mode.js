// chat-agent-mode.js — Phase 11
//
// Makes "Agent mode" visibly distinct from "Chat mode" in the GUI:
//   - First time the user switches to Agent mode, show a consent modal
//     listing every capability the agent gains access to (computer use,
//     shell, file ops, network, messaging). User clicks "Enable agent
//     mode" once; we remember the consent in settingsStore so subsequent
//     switches just flip mode without re-asking.
//   - While Agent mode is active, render a sticky banner above the
//     composer: "⚡ AGENT IN CONTROL · screen · mouse · keyboard · files
//     · shell · network". Banner disappears when mode flips back to chat.
//   - Wraps setMode(): when called with 'agent' the modal/banner logic
//     runs; with anything else, the banner is removed.
//
// Why this isn't done inside chat.html: keeping the agent-mode UX in a
// separate file makes it easy to review the surface area of "what
// changes when the agent gets PC access" without scrolling through 6000
// lines of chat.html.

(function () {
  'use strict';

  const CONSENT_KEY = 'agentMode.consented';
  const BANNER_ID = 'agent-mode-banner';

  // Sprint-2 fix — was emoji icons (🖥️ 🖱️ ⌨️ 📂 🐚 🌐 🔁). Now each
  // capability row pulls a lucide symbol from the icon library
  // defined at the top of chat.html. The consent modal is rendered
  // into the same document, so #i-… references resolve normally.
  const CAPABILITIES = [
    { iconId: 'i-eye',       label: 'See your screen',
      detail: 'Screenshots + screen analysis on demand or automatically when your task mentions the UI.' },
    { iconId: 'i-target',    label: 'Move the mouse & click',
      detail: 'computer.click, smart_click (vision-guided), drag, scroll.' },
    { iconId: 'i-keyboard',  label: 'Type on the keyboard',
      detail: 'computer.type, keyboard.press for any key combination.' },
    { iconId: 'i-file-text', label: 'Read & write files',
      detail: 'fs.read, fs.write, search_files. Every write goes through the per-call permission gate.' },
    { iconId: 'i-terminal',  label: 'Run shell commands',
      detail: 'run_code (Python, Node, shell, PowerShell). Each command prompts unless --auto-approve.' },
    { iconId: 'i-globe',     label: 'Browse the web',
      detail: 'web.fetch, web.search, plus any connector tools you have keys for (Slack, Notion, Linear, …).' },
    { iconId: 'i-undo',      label: 'Self-reflect & retry',
      detail: 'Up to 8 multi-step iterations per task, each one observing the previous result.' },
  ];

  function hasConsented() {
    try {
      // settingsStore is exposed via preload as H.settings.get; if that
      // surface doesn't exist (very old build), fall back to localStorage.
      if (typeof H?.getSetting === 'function') {
        const v = H.getSetting(CONSENT_KEY);
        if (v != null) return !!v;
      }
    } catch (_) {}
    try { return localStorage.getItem(CONSENT_KEY) === 'true'; }
    catch (_) { return false; }
  }

  function markConsented() {
    try { if (typeof H?.setSetting === 'function') H.setSetting(CONSENT_KEY, true); } catch (_) {}
    try { localStorage.setItem(CONSENT_KEY, 'true'); } catch (_) {}
  }

  function buildConsentModal() {
    const lang = (typeof window !== 'undefined' && window.lang) || 'en';
    const isRu = lang === 'ru';

    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    overlay.id = 'agent-consent-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(0,0,0,0.66);
      display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(4px);
    `;

    const dialog = document.createElement('div');
    // `--fg` is not a defined CSS variable in this app (only `--tx` is); the
    // old fallback `#d6d8db` was a light-grey that is invisible on a light
    // paper bg under [data-theme="light"]. Pivot to `--tx` so both themes
    // resolve to a readable contrast (dark theme: #e8ecf4, light: #09090b).
    dialog.style.cssText = `
      background: var(--bg, #0f1115);
      color: var(--tx, #18181b);
      border: 1px solid var(--accent, #7c6df2);
      border-radius: 12px;
      padding: 22px 28px;
      max-width: 580px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.45),
                  0 0 30px rgba(124,109,242,0.18);
    `;

    const title = isRu ? 'Включить режим Агента?' : 'Enable Agent mode?';
    const intro = isRu
      ? 'В этом режиме Хорайзон сможет действовать на вашем ПК. Все опасные операции (запуск кода, запись файлов, клики мышью, отправка сообщений) запрашивают подтверждение на каждом шаге.'
      : 'In this mode Horizon can act on your machine. Every destructive operation (running code, writing files, mouse clicks, sending messages) still asks for confirmation on each call.';
    const confirmLabel = isRu ? 'Включить режим Агента' : 'Enable Agent mode';
    const cancelLabel = isRu ? 'Отмена' : 'Cancel';

    dialog.innerHTML = `
      <h2 style="margin:0 0 8px;font-size:18px;font-weight:700;letter-spacing:.3px;display:flex;align-items:center;gap:8px;">
        <svg class="licon"><use href="#i-zap"/></svg>${title}
      </h2>
      <p style="margin:0 0 14px;font-size:13px;line-height:1.55;color:var(--t2,#3f3f46);">${intro}</p>
      <div id="agent-consent-caps" style="display:grid;gap:8px;margin:0 0 18px;"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button id="agent-consent-cancel"  class="hub-btn" style="padding:8px 16px;">${cancelLabel}</button>
        <button id="agent-consent-confirm" class="hub-btn primary" style="padding:8px 16px;background:var(--accent-grad,linear-gradient(135deg,#7c6df2,#a78bfa));color:#fff;font-weight:600;">${confirmLabel}</button>
      </div>
    `;
    overlay.appendChild(dialog);

    const caps = dialog.querySelector('#agent-consent-caps');
    for (const c of CAPABILITIES) {
      const row = document.createElement('div');
      // `rgba(255,255,255,0.x)` borders and bg become invisible on a light
      // paper substrate. Switch to neutral var(--b1) borders + transparent
      // bg so both themes get a visible cell outline.
      row.style.cssText = `
        display:grid;grid-template-columns:28px 1fr;gap:10px;align-items:start;
        padding:8px 10px;border:1px solid var(--b1, rgba(0,0,0,.08));border-radius:8px;
        background: var(--bg2, rgba(0,0,0,0.02));
      `;
      row.innerHTML = `
        <div style="line-height:1;color:var(--accent,#7c6df2);"><svg class="licon"><use href="#${c.iconId}"/></svg></div>
        <div>
          <div style="font-weight:600;font-size:13px;color:var(--tx,#18181b);">${c.label}</div>
          <div style="font-size:11px;color:var(--t3,#52525b);line-height:1.45;">${c.detail}</div>
        </div>
      `;
      caps.appendChild(row);
    }

    return overlay;
  }

  async function askConsent() {
    return new Promise((resolve) => {
      const overlay = buildConsentModal();
      document.body.appendChild(overlay);
      const cleanup = (ok) => {
        try { overlay.remove(); } catch (_) {}
        resolve(ok);
      };
      overlay.querySelector('#agent-consent-confirm').addEventListener('click', () => cleanup(true));
      overlay.querySelector('#agent-consent-cancel').addEventListener('click', () => cleanup(false));
      // Esc to cancel
      const onKey = (e) => {
        if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); cleanup(false); }
      };
      document.addEventListener('keydown', onKey);
    });
  }

  // Sprint-2.9 — full run-control HUD. Two-row layout:
  //   Row 1 (always visible in agent mode): persona badge + capability list + ? help
  //   Row 2 (only when run active):         elapsed · tool counter · Pause · Skip · Stop
  // Backed by:
  //   - H.onAgentStep stream → tracks runId, elapsed, tool count
  //   - H.agentControl(runId, 'pause'|'step'|'stop') → action buttons

  // Module-scoped run state. Re-initialised every time a run-start fires.
  const _runState = {
    runId:     null,
    startedAt: 0,
    tools:     0,
    paused:    false,
    timerId:   null,
  };

  function _fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + 'm ' + r.toString().padStart(2, '0') + 's';
  }

  function _startElapsedTimer() {
    if (_runState.timerId) clearInterval(_runState.timerId);
    _runState.timerId = setInterval(() => {
      const el = document.getElementById('agent-run-elapsed');
      if (!el || !_runState.runId) return;
      el.textContent = _fmtElapsed(Date.now() - _runState.startedAt);
    }, 250);
  }

  function _stopElapsedTimer() {
    if (_runState.timerId) clearInterval(_runState.timerId);
    _runState.timerId = null;
  }

  function _showRunRow(runId) {
    _runState.runId = runId;
    _runState.startedAt = Date.now();
    _runState.tools = 0;
    _runState.paused = false;
    const row = document.getElementById('agent-run-controls');
    if (row) row.classList.add('active');
    _startElapsedTimer();
  }
  function _hideRunRow() {
    _runState.runId = null;
    _stopElapsedTimer();
    const row = document.getElementById('agent-run-controls');
    if (row) row.classList.remove('active');
  }
  function _bumpToolCount() {
    _runState.tools++;
    const el = document.getElementById('agent-run-tools');
    if (el) el.textContent = String(_runState.tools) + (_runState.tools === 1 ? ' tool' : ' tools');
  }
  function _setPausedVisual(p) {
    _runState.paused = !!p;
    const banner = document.getElementById(BANNER_ID);
    if (banner) banner.classList.toggle('paused', !!p);
    const pauseBtn = document.getElementById('agent-run-pause');
    if (pauseBtn) {
      pauseBtn.title = p ? 'Resume run (R)' : 'Pause run (P)';
      const lbl = pauseBtn.querySelector('span');
      if (lbl) lbl.textContent = p ? 'Resume' : 'Pause';
      const ico = pauseBtn.querySelector('use');
      if (ico) ico.setAttribute('href', p ? '#i-play' : '#i-square');
    }
  }

  async function _ctrl(action) {
    if (!_runState.runId) return;
    try { await H.agentControl?.(_runState.runId, action); } catch (_) {}
  }

  function renderBanner() {
    if (document.getElementById(BANNER_ID)) return;
    const composer = document.getElementById('composer') || document.getElementById('chat-composer');
    if (!composer) return;
    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.className = 'agent-mode-banner';
    const lang = (typeof window !== 'undefined' && window.lang) || 'en';
    const isRu = lang === 'ru';
    banner.innerHTML = `
      <div class="agent-banner-top">
        <span class="agent-badge">
          <svg class="licon" style="width:14px;height:14px"><use href="#i-zap"/></svg>
          <span>${isRu ? 'АГЕНТ' : 'AGENT'}</span>
        </span>
        <span class="agent-banner-caps">${isRu ? 'экран · мышь · клавиатура · файлы · shell · сеть' : 'screen · mouse · keyboard · files · shell · network'}</span>
        <button id="agent-mode-info" class="agent-help-btn" title="${isRu ? 'Что входит в режим Агента' : 'Capabilities reference'}">?</button>
      </div>
      <div class="agent-run-controls" id="agent-run-controls" aria-live="polite">
        <span class="agent-run-dot" aria-hidden="true"></span>
        <span class="agent-run-status">${isRu ? 'выполняется' : 'running'}</span>
        <span class="agent-run-elapsed" id="agent-run-elapsed">0s</span>
        <span class="agent-run-sep">·</span>
        <span class="agent-run-tools" id="agent-run-tools">0 tools</span>
        <span class="agent-run-spacer"></span>
        <button id="agent-run-pause" class="agent-run-btn" title="${isRu ? 'Пауза (P)' : 'Pause run (P)'}">
          <svg class="licon" width="11" height="11" aria-hidden="true"><use href="#i-square"/></svg>
          <span>${isRu ? 'Пауза' : 'Pause'}</span>
        </button>
        <button id="agent-run-skip" class="agent-run-btn" title="${isRu ? 'Шаг вперёд (S)' : 'Step forward (S)'}">
          <svg class="licon" width="11" height="11" aria-hidden="true"><use href="#i-arrow-up"/></svg>
          <span>${isRu ? 'Шаг' : 'Step'}</span>
        </button>
        <button id="agent-run-stop" class="agent-run-btn agent-run-stop" title="${isRu ? 'Остановить (Esc)' : 'Stop run (Esc)'}">
          <svg class="licon" width="11" height="11" aria-hidden="true"><use href="#i-x"/></svg>
          <span>${isRu ? 'Стоп' : 'Stop'}</span>
        </button>
      </div>
    `;
    composer.parentNode?.insertBefore(banner, composer);

    // Inject CSS once per session — keyframes + control row.
    if (!document.getElementById('agent-banner-keyframes')) {
      const style = document.createElement('style');
      style.id = 'agent-banner-keyframes';
      style.textContent = `
        @keyframes agentBannerPulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(139,92,246,0.36); }
          50%     { box-shadow: 0 0 0 6px rgba(139,92,246,0.00); }
        }
        @keyframes agentRunDotPulse {
          0%,100% { opacity: 1; box-shadow: 0 0 6px rgba(248,113,113,0.7); }
          50%     { opacity: .55; box-shadow: 0 0 0 rgba(248,113,113,0); }
        }
        .agent-mode-banner {
          display: flex; flex-direction: column; gap: 6px;
          padding: 8px 12px 8px 14px; margin: 0 0 6px;
          background: linear-gradient(90deg, rgba(139,92,246,.22), rgba(236,72,153,.18));
          border: 1px solid rgba(139,92,246,.45);
          border-radius: 10px;
          color: var(--tx, #18181b);
          animation: agentBannerPulse 2.4s ease-in-out infinite;
        }
        .agent-mode-banner.paused {
          border-color: rgba(245,158,11,.55);
          background: linear-gradient(90deg, rgba(245,158,11,.20), rgba(244,114,182,.12));
        }
        .agent-banner-top {
          display: flex; align-items: center; gap: 10px;
          font-size: 12px; font-weight: 600;
        }
        .agent-badge {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 2px 7px; border-radius: 5px;
          background: rgba(255,255,255,.10);
          border: 1px solid rgba(255,255,255,.16);
          font-weight: 700; letter-spacing: .04em; font-size: 10.5px;
        }
        .agent-banner-caps {
          font-weight: 400; font-size: 11px; opacity: .72;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          flex: 1; min-width: 0;
        }
        .agent-help-btn {
          background: transparent;
          border: 1px solid rgba(255,255,255,.18);
          color: inherit;
          padding: 2px 8px; border-radius: 6px;
          font-size: 11px; cursor: pointer;
          -webkit-app-region: no-drag;
        }
        .agent-help-btn:hover { background: rgba(255,255,255,.08); }
        /* Run controls row — collapsed by default, expands on .active */
        .agent-run-controls {
          display: none; align-items: center; gap: 8px;
          padding-top: 6px;
          border-top: 1px solid rgba(255,255,255,.10);
          font-size: 11.5px;
        }
        .agent-run-controls.active { display: flex; }
        .agent-run-dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: #f87171;
          animation: agentRunDotPulse 1.2s ease-in-out infinite;
        }
        .paused .agent-run-dot { background: #f59e0b; animation: none; opacity: .8; }
        .agent-run-status {
          font-weight: 600; letter-spacing: .02em;
          color: rgba(255,255,255,.92);
        }
        .agent-run-elapsed {
          font: 600 11px/1 var(--mono, ui-monospace, monospace);
          color: rgba(255,255,255,.96);
          padding: 2px 6px;
          border-radius: 4px;
          background: rgba(255,255,255,.08);
          border: 1px solid rgba(255,255,255,.12);
          min-width: 36px; text-align: center;
        }
        .agent-run-sep { opacity: .55; }
        .agent-run-tools {
          font: 500 11px/1.2 var(--font);
          opacity: .85;
        }
        .agent-run-spacer { flex: 1; }
        .agent-run-btn {
          -webkit-app-region: no-drag;
          display: inline-flex; align-items: center; gap: 4px;
          padding: 3px 8px;
          font: 600 11px/1 var(--font);
          color: rgba(255,255,255,.92);
          background: rgba(255,255,255,.06);
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 6px;
          cursor: pointer;
          transition: background .12s, border-color .12s, transform .08s;
        }
        .agent-run-btn:hover {
          background: rgba(255,255,255,.14);
          border-color: rgba(255,255,255,.30);
        }
        .agent-run-btn:active { transform: translateY(1px); }
        .agent-run-btn .licon { fill: none; stroke: currentColor; stroke-width: 2; }
        .agent-run-stop { color: #fecaca; border-color: rgba(248,113,113,.4); }
        .agent-run-stop:hover { background: rgba(248,113,113,.18); border-color: rgba(248,113,113,.7); color: #fecaca; }
        /* Light theme overrides */
        [data-theme="light"] .agent-mode-banner {
          background: linear-gradient(90deg, rgba(139,92,246,.16), rgba(236,72,153,.12)) !important;
          color: #1f1d4a !important;
          border-color: rgba(139,92,246,.38) !important;
        }
        [data-theme="light"] .agent-banner-caps { opacity: .80; }
        [data-theme="light"] .agent-run-controls { border-top-color: rgba(0,0,0,.10); }
        [data-theme="light"] .agent-run-status { color: #1f1d4a; }
        [data-theme="light"] .agent-run-elapsed {
          color: #18181b; background: rgba(255,255,255,.65);
          border-color: rgba(0,0,0,.10);
        }
        [data-theme="light"] .agent-run-btn {
          color: #1f1d4a; background: rgba(255,255,255,.55);
          border-color: rgba(0,0,0,.12);
        }
        [data-theme="light"] .agent-run-btn:hover {
          background: rgba(255,255,255,.85); border-color: rgba(0,0,0,.22);
        }
        [data-theme="light"] .agent-run-stop {
          color: #b91c1c; border-color: rgba(248,113,113,.5);
        }
      `;
      document.head.appendChild(style);
    }

    banner.querySelector('#agent-mode-info').addEventListener('click', (e) => {
      e.preventDefault();
      const overlay = buildConsentModal();
      overlay.querySelector('#agent-consent-confirm').textContent =
        ((typeof window !== 'undefined' && window.lang) === 'ru') ? 'Понятно' : 'Got it';
      overlay.querySelector('#agent-consent-cancel').style.display = 'none';
      document.body.appendChild(overlay);
      overlay.querySelector('#agent-consent-confirm').addEventListener('click', () => overlay.remove());
    });

    banner.querySelector('#agent-run-pause').addEventListener('click', async () => {
      const action = _runState.paused ? 'resume' : 'pause';
      _setPausedVisual(!_runState.paused);
      await _ctrl(action);
    });
    banner.querySelector('#agent-run-skip').addEventListener('click', async () => {
      await _ctrl('step');
    });
    banner.querySelector('#agent-run-stop').addEventListener('click', async () => {
      await _ctrl('stop');
      _hideRunRow();
    });

    // Keyboard shortcuts active only while the run row is visible.
    if (!banner.__runKeysBound) {
      banner.__runKeysBound = true;
      document.addEventListener('keydown', (ev) => {
        const row = document.getElementById('agent-run-controls');
        if (!row || !row.classList.contains('active')) return;
        const active = document.activeElement;
        const inComposer = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
        if (inComposer) return;
        if (ev.key === 'p' || ev.key === 'P') {
          ev.preventDefault();
          banner.querySelector('#agent-run-pause')?.click();
        } else if (ev.key === 's' || ev.key === 'S') {
          ev.preventDefault();
          banner.querySelector('#agent-run-skip')?.click();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          banner.querySelector('#agent-run-stop')?.click();
        }
      }, true);
    }
  }

  function removeBanner() {
    _hideRunRow();
    const b = document.getElementById(BANNER_ID);
    if (b) b.remove();
  }

  // Subscribe to the agent-step stream once renderBanner has been called.
  // This way idle agent-mode shows just the top row; the run-controls row
  // fades in only when an actual run starts.
  function _installRunObserver() {
    if (typeof H?.onAgentStep !== 'function' || _installRunObserver._done) return;
    _installRunObserver._done = true;
    H.onAgentStep((step) => {
      try {
        if (!step) return;
        if (step.type === 'run-start') _showRunRow(step.runId || step.id || null);
        else if (step.type === 'executing') _bumpToolCount();
        else if (step.type === 'control') {
          if (step.action === 'pause') _setPausedVisual(true);
          else if (step.action === 'resume') _setPausedVisual(false);
        } else if (step.type === 'run-end' || step.type === 'plan-rejected') {
          _hideRunRow();
        }
      } catch (_) {}
    });
  }

  // Hook setMode() — patch global to layer consent + banner on top.
  function installModeHook() {
    if (typeof window === 'undefined') return;
    const orig = window.setMode;
    if (typeof orig !== 'function') return;
    if (orig.__horizonAgentModePatched) return;
    const patched = async function (m, save = true) {
      if (m === 'agent' && !hasConsented()) {
        const ok = await askConsent();
        if (!ok) return; // user cancelled — stay in current mode
        markConsented();
      }
      const r = orig.call(this, m, save);
      if (m === 'agent') renderBanner();
      else               removeBanner();
      return r;
    };
    patched.__horizonAgentModePatched = true;
    window.setMode = patched;
  }

  // Initialise on DOM ready
  function _init() {
    installModeHook();
    _installRunObserver();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
