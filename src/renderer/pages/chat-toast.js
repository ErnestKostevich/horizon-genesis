// chat-toast.js — Phase 17
//
// Tiny dependency-free toast notification system. Replaces the
// "console.warn or silent failure" pattern that was the previous
// state of affairs whenever a save or test action completed.
//
// Public API on the global window:
//   toast.success(title, desc?, opts?)
//   toast.error(title, desc?, opts?)
//   toast.warn(title, desc?, opts?)
//   toast.info(title, desc?, opts?)
//
// opts = { duration: ms (default 4000), persistent: bool }
//
// CSS lives in chat-redesign.css (.hz-toast-container, .hz-toast, etc).
// Auto-stacks bottom-right, auto-dismisses, click ✕ to close early.

(function () {
  'use strict';

  const ICONS = { success: '✓', error: '✗', warn: '⚠', info: 'ℹ' };

  function ensureContainer() {
    let c = document.getElementById('hz-toast-container');
    if (c) return c;
    c = document.createElement('div');
    c.id = 'hz-toast-container';
    c.className = 'hz-toast-container';
    c.setAttribute('aria-live', 'polite');
    c.setAttribute('role', 'status');
    document.body.appendChild(c);
    return c;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function show(kind, title, desc, opts) {
    const duration = (opts && Number.isFinite(opts.duration)) ? opts.duration : 4000;
    const persistent = !!(opts && opts.persistent);
    const container = ensureContainer();

    const node = document.createElement('div');
    node.className = 'hz-toast hz-toast-' + kind;
    node.innerHTML = `
      <span class="hz-toast-icon">${ICONS[kind] || ''}</span>
      <div class="hz-toast-body">
        <div class="hz-toast-title">${escapeHtml(title)}</div>
        ${desc ? `<div class="hz-toast-desc">${escapeHtml(desc)}</div>` : ''}
      </div>
      <button class="hz-toast-close" aria-label="Dismiss">✕</button>
    `;
    container.appendChild(node);

    let dismissTimer = null;
    function dismiss() {
      if (!node.parentNode) return;
      if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
      node.classList.add('hz-toast-out');
      setTimeout(() => { try { node.remove(); } catch (_) {} }, 250);
    }

    node.querySelector('.hz-toast-close').addEventListener('click', dismiss);

    // Pause auto-dismiss on hover
    if (!persistent) {
      const arm = () => { dismissTimer = setTimeout(dismiss, duration); };
      arm();
      node.addEventListener('mouseenter', () => {
        if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
      });
      node.addEventListener('mouseleave', arm);
    }
    return dismiss;
  }

  window.toast = {
    success: (title, desc, opts) => show('success', title, desc, opts),
    error:   (title, desc, opts) => show('error',   title, desc || '', { duration: 6000, ...opts }),
    warn:    (title, desc, opts) => show('warn',    title, desc, opts),
    info:    (title, desc, opts) => show('info',    title, desc, opts),
  };

  // Some legacy code in chat.html calls window.showToast — bridge it
  // so we don't have to migrate every site at once.
  window.showToast = function (msg, kind) {
    const k = kind === 'error' || kind === 'warn' || kind === 'info' ? kind : 'success';
    window.toast[k](msg);
  };
})();
