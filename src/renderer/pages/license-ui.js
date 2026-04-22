/**
 * License pill — listens to the main-process `license-state` IPC and
 * renders a titlebar pill: TRIAL · 12d / PRO · monthly / EXPIRED.
 * Clicking opens the hosted upgrade page via the existing IPC (the
 * main process decides whether that is progate.html or the web
 * pricing page, and handles deep links correctly).
 *
 * All API names match what preload.js already exposes, no renderer
 * contract changes required.
 */
(function () {
  if (!window.H || typeof window.H.licenseState !== 'function') return;

  const PRICING_URL = 'https://horizonaai.dev/pricing';

  function ensureHost() {
    let host = document.getElementById('license-pill-host');
    if (host) return host;
    const tb = document.querySelector('.tb');
    if (!tb) return null;
    host = document.createElement('div');
    host.id = 'license-pill-host';
    const logo = tb.querySelector('.logo');
    const afterLogo = logo?.parentElement === tb ? logo : logo?.parentElement;
    if (afterLogo && afterLogo.parentElement === tb) {
      afterLogo.insertAdjacentElement('afterend', host);
    } else {
      tb.appendChild(host);
    }
    return host;
  }

  function openUpgrade() {
    if (typeof window.H.licenseOpenUpgradePage === 'function') {
      window.H.licenseOpenUpgradePage();
      return;
    }
    if (typeof window.H.openUrl === 'function') window.H.openUrl(PRICING_URL);
  }

  function render(state) {
    const host = ensureHost();
    if (!host || !state) return;

    const pill = document.createElement('span');
    pill.className = 'license-pill';
    let label = '';
    let cls = '';
    let title = '';

    if (state.reason === 'pro') {
      label = `PRO · ${state.plan || 'active'}`;
      title = state.expiresAt
        ? `Renews ${new Date(state.expiresAt).toLocaleDateString()}`
        : 'Pro subscription active';
    } else if (state.reason === 'trial') {
      label = `TRIAL · ${state.trialDaysLeft}d`;
      cls = 'trial';
      title = `${state.trialDaysLeft} days left in your free trial. Click to upgrade.`;
    } else {
      label = 'EXPIRED';
      cls = 'expired';
      title = 'Trial or subscription ended. Click to upgrade.';
    }
    if (cls) pill.classList.add(cls);
    pill.title = title;
    pill.textContent = label;

    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'lp-cta';
    cta.textContent = state.reason === 'pro' ? 'MANAGE' : 'UPGRADE';
    cta.addEventListener('click', (e) => { e.stopPropagation(); openUpgrade(); });
    pill.appendChild(cta);
    pill.addEventListener('click', openUpgrade);

    host.replaceChildren(pill);
  }

  window.H.licenseState().then(render).catch(() => {});
  if (typeof window.H.onLicenseChange === 'function') window.H.onLicenseChange(render);
  if (typeof window.H.licenseRefresh === 'function') {
    setTimeout(() => { window.H.licenseRefresh().then(render).catch(() => {}); }, 1500);
  }
})();
