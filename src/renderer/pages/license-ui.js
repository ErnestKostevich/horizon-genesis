/**
 * License pill — subscribes to the main-process license-state IPC
 * event and renders a visible pill in the titlebar so the user always
 * knows their state (trial / pro / expired). Clicking the pill opens
 * the pricing page in the default browser (or progate.html for an
 * expired license).
 *
 * Injected host: `#license-pill-host` (created below if absent, sits
 * next to the window buttons in `.tb`).
 */
(function () {
  if (!window.H || typeof window.H.onLicenseState !== 'function') {
    // Preload hasn't exposed the IPC — bail quietly.
    return;
  }

  const PRICING_URL = 'https://horizonaai.dev/pricing';

  function ensureHost() {
    let host = document.getElementById('license-pill-host');
    if (host) return host;
    const tb = document.querySelector('.tb');
    if (!tb) return null;
    host = document.createElement('div');
    host.id = 'license-pill-host';
    // Insert after the logo block so it reads: [logo] HORIZON · trial
    const logoBlock = tb.querySelector('.logo')?.parentElement || tb.firstElementChild;
    if (logoBlock && logoBlock.parentElement === tb) {
      logoBlock.insertAdjacentElement('afterend', host);
    } else {
      tb.appendChild(host);
    }
    return host;
  }

  function render(state) {
    const host = ensureHost();
    if (!host) return;

    const pill = document.createElement('span');
    pill.className = 'license-pill';
    let label = '';
    let extraCls = '';
    let title = '';

    if (state.reason === 'pro') {
      label = `PRO · ${state.plan || 'active'}`;
      title = state.expiresAt
        ? `Renews ${new Date(state.expiresAt).toLocaleDateString()}`
        : 'Pro subscription active';
    } else if (state.reason === 'trial') {
      label = `TRIAL · ${state.trialDaysLeft}d`;
      extraCls = 'trial';
      title = `${state.trialDaysLeft} days left in your free trial. Click to upgrade.`;
    } else {
      label = 'EXPIRED';
      extraCls = 'expired';
      title = 'Trial or subscription ended. Click to upgrade.';
    }

    pill.classList.add(extraCls);
    pill.title = title;
    pill.textContent = label;

    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'lp-cta';
    cta.textContent = state.reason === 'pro' ? 'MANAGE' : 'UPGRADE';
    cta.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.H.openExternal) window.H.openExternal(PRICING_URL);
    });
    pill.appendChild(cta);
    pill.addEventListener('click', () => {
      if (window.H.openExternal) window.H.openExternal(PRICING_URL);
    });

    host.innerHTML = '';
    host.appendChild(pill);
  }

  // Initial fetch.
  if (typeof window.H.licenseState === 'function') {
    window.H.licenseState().then(render).catch(() => {});
  }
  // Live updates.
  window.H.onLicenseState(render);
})();
