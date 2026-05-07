/**
 * License pill - listens to the main-process license-state IPC and renders a
 * titlebar pill: TRIAL / 12d, PRO / monthly, or EXPIRED.
 */
(function () {
  if (!window.H || typeof window.H.licenseState !== 'function') return;

  const PRICING_URL = 'https://horizonaai.dev/pricing?src=desktop';

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

  async function openUpgrade() {
    try {
      if (typeof window.H.licenseOpenUpgradePage === 'function') {
        const result = await window.H.licenseOpenUpgradePage();
        if (result?.ok) return;
        console.warn('[license-ui] upgrade open failed', result?.error || result);
      }
    } catch (err) {
      console.warn('[license-ui] upgrade open exception', err);
    }
    if (typeof window.H.openUrl === 'function') {
      const result = await window.H.openUrl(PRICING_URL);
      if (!result?.ok && result !== true) console.warn('[license-ui] fallback open failed', result);
    }
  }

  // Plans that hold the product itself, not a paid subscription. Their
  // pill should read OWNER / OFFICIAL / etc. instead of "PRO / owner",
  // and the click target opens the account / dashboard, not the upgrade
  // page (they have nothing to upgrade to).
  const PRIVILEGED = {
    owner:    'OWNER',
    official: 'OFFICIAL',
    admin:    'ADMIN',
    team:     'TEAM',
    lifetime: 'LIFETIME',
  };

  function render(state) {
    const host = ensureHost();
    if (!host || !state) return;

    const pill = document.createElement('span');
    pill.className = 'license-pill';
    const planLower = String(state.plan || '').toLowerCase();
    const privilegedLabel = PRIVILEGED[planLower];
    let label = '';
    let cls = '';
    let title = '';
    let ctaText = 'UPGRADE';
    let ctaAction = openUpgrade;

    if (privilegedLabel) {
      label = privilegedLabel;
      title = `${privilegedLabel} access — Horizon is included for this account.`;
      ctaText = 'ACCOUNT';
    } else if (state.reason === 'pro') {
      // Real paid subscriber. Show plan name only when it adds info
      // (monthly / yearly), drop generic "active" filler.
      label = planLower === 'monthly' || planLower === 'yearly'
        ? `PRO / ${planLower}`
        : 'PRO';
      title = state.expiresAt
        ? `Renews ${new Date(state.expiresAt).toLocaleDateString()}`
        : 'Pro subscription active';
      ctaText = 'MANAGE';
    } else if (state.reason === 'trial') {
      label = `TRIAL / ${state.trialDaysLeft}d`;
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
    cta.textContent = ctaText;
    cta.addEventListener('click', (e) => { e.stopPropagation(); ctaAction(); });
    pill.appendChild(cta);
    pill.addEventListener('click', ctaAction);

    host.replaceChildren(pill);
  }

  window.H.licenseState().then(render).catch(() => {});
  if (typeof window.H.onLicenseChange === 'function') window.H.onLicenseChange(render);
  if (typeof window.H.licenseRefresh === 'function') {
    setTimeout(() => { window.H.licenseRefresh().then(render).catch(() => {}); }, 1500);
  }
})();
