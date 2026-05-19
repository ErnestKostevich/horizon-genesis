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

  const CAPABILITIES = [
    { icon: '🖥️', label: 'See your screen',
      detail: 'Screenshots + screen analysis on demand or automatically when your task mentions the UI.' },
    { icon: '🖱️', label: 'Move the mouse & click',
      detail: 'computer.click, smart_click (vision-guided), drag, scroll.' },
    { icon: '⌨️', label: 'Type on the keyboard',
      detail: 'computer.type, keyboard.press for any key combination.' },
    { icon: '📂', label: 'Read & write files',
      detail: 'fs.read, fs.write, search_files. Every write goes through the per-call permission gate.' },
    { icon: '🐚', label: 'Run shell commands',
      detail: 'run_code (Python, Node, shell, PowerShell). Each command prompts unless --auto-approve.' },
    { icon: '🌐', label: 'Browse the web',
      detail: 'web.fetch, web.search, plus any connector tools you have keys for (Slack, Notion, Linear, …).' },
    { icon: '🔁', label: 'Self-reflect & retry',
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
    dialog.style.cssText = `
      background: var(--bg, #0f1115);
      color: var(--fg, #d6d8db);
      border: 1px solid var(--accent, #8b5cf6);
      border-radius: 12px;
      padding: 22px 28px;
      max-width: 580px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.45),
                  0 0 30px rgba(139,92,246,0.18);
    `;

    const title = isRu ? '⚡ Включить режим Агента?' : '⚡ Enable Agent mode?';
    const intro = isRu
      ? 'В этом режиме Хорайзон сможет действовать на вашем ПК. Все опасные операции (запуск кода, запись файлов, клики мышью, отправка сообщений) запрашивают подтверждение на каждом шаге.'
      : 'In this mode Horizon can act on your machine. Every destructive operation (running code, writing files, mouse clicks, sending messages) still asks for confirmation on each call.';
    const confirmLabel = isRu ? 'Включить режим Агента' : 'Enable Agent mode';
    const cancelLabel = isRu ? 'Отмена' : 'Cancel';

    dialog.innerHTML = `
      <h2 style="margin:0 0 8px;font-size:18px;font-weight:700;letter-spacing:.3px;">${title}</h2>
      <p style="margin:0 0 14px;font-size:13px;line-height:1.55;color:var(--t2,#9aa0a6);">${intro}</p>
      <div id="agent-consent-caps" style="display:grid;gap:8px;margin:0 0 18px;"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button id="agent-consent-cancel"  class="hub-btn" style="padding:8px 16px;">${cancelLabel}</button>
        <button id="agent-consent-confirm" class="hub-btn primary" style="padding:8px 16px;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff;font-weight:600;">${confirmLabel}</button>
      </div>
    `;
    overlay.appendChild(dialog);

    const caps = dialog.querySelector('#agent-consent-caps');
    for (const c of CAPABILITIES) {
      const row = document.createElement('div');
      row.style.cssText = `
        display:grid;grid-template-columns:28px 1fr;gap:10px;align-items:start;
        padding:8px 10px;border:1px solid rgba(255,255,255,0.06);border-radius:8px;
        background: rgba(255,255,255,0.02);
      `;
      row.innerHTML = `
        <div style="font-size:18px;line-height:1;">${c.icon}</div>
        <div>
          <div style="font-weight:600;font-size:13px;">${c.label}</div>
          <div style="font-size:11px;color:var(--t3,#7a808a);line-height:1.45;">${c.detail}</div>
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

  function renderBanner() {
    if (document.getElementById(BANNER_ID)) return;
    const composer = document.getElementById('composer') || document.getElementById('chat-composer');
    if (!composer) return;
    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.style.cssText = `
      display: flex; align-items: center; gap: 10px;
      padding: 8px 14px; margin: 0 0 6px;
      background: linear-gradient(90deg,
                  rgba(139,92,246,0.22), rgba(236,72,153,0.18));
      border: 1px solid rgba(139,92,246,0.45);
      border-radius: 10px;
      font-size: 12px; font-weight: 600;
      color: var(--fg, #d6d8db);
      animation: agentBannerPulse 2.4s ease-in-out infinite;
    `;
    const lang = (typeof window !== 'undefined' && window.lang) || 'en';
    const isRu = lang === 'ru';
    banner.innerHTML = `
      <span style="font-size:16px;">⚡</span>
      <span>${isRu ? 'АГЕНТ УПРАВЛЯЕТ ПК' : 'AGENT IN CONTROL'}</span>
      <span style="opacity:.65;font-weight:400;font-size:11px;">
        ${isRu ? 'экран · мышь · клавиатура · файлы · shell · сеть' : 'screen · mouse · keyboard · files · shell · network'}
      </span>
      <button id="agent-mode-info" style="
        margin-left:auto; background:transparent; border:1px solid rgba(255,255,255,0.18);
        color:inherit; padding:3px 9px; border-radius:6px; font-size:11px; cursor:pointer;
      ">?</button>
    `;
    composer.parentNode?.insertBefore(banner, composer);

    // Inject pulse keyframes (once)
    if (!document.getElementById('agent-banner-keyframes')) {
      const style = document.createElement('style');
      style.id = 'agent-banner-keyframes';
      style.textContent = `
        @keyframes agentBannerPulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(139,92,246,0.36); }
          50%     { box-shadow: 0 0 0 6px rgba(139,92,246,0.00); }
        }
      `;
      document.head.appendChild(style);
    }

    banner.querySelector('#agent-mode-info').addEventListener('click', (e) => {
      e.preventDefault();
      // Re-show consent modal as a reference card; consent already given.
      const overlay = buildConsentModal();
      overlay.querySelector('#agent-consent-confirm').textContent =
        ((typeof window !== 'undefined' && window.lang) === 'ru') ? 'Понятно' : 'Got it';
      overlay.querySelector('#agent-consent-cancel').style.display = 'none';
      document.body.appendChild(overlay);
      overlay.querySelector('#agent-consent-confirm').addEventListener('click', () => overlay.remove());
    });
  }

  function removeBanner() {
    const b = document.getElementById(BANNER_ID);
    if (b) b.remove();
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
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installModeHook);
  } else {
    installModeHook();
  }
})();
