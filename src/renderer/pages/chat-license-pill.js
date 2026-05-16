// PR-V Phase 3.24 — License Pill (Pro/Trial/Expired status indicator).
// Extracted from chat.html inline <script> (was lines 2006-2088).
//
// State: _PRIVILEGED_PILL_LABELS — map of owner/official/admin/team/
//   lifetime → display label (these accounts hold the product, not
//   subscribers).
//
// Fns:
//   refreshLicensePill — calls H.licenseState() and updates the
//                        chat-status-bar pill (PRO / TRIAL Xd / EXPIRED
//                        / OWNER / OFFICIAL / etc.)
//   onLicensePillClick — opens upgrade page via H.licenseOpenUpgradePage
//
// Also registers a H.onLicenseChange listener at file load that
// re-renders the pill + refreshes the account-panel badge if open.

// ═══ LICENSE PILL — show Pro/Trial/Expired status in chat status bar ═══
// IMPORTANT: H.licenseState() returns the licenseManager.evaluate() shape
// ({allowed, reason, plan, trialDaysLeft, expiresAt}), NOT the raw
// /api/license/status payload. Earlier code read state.active and
// state.in_trial which never exist on this shape, so every render fell
// through to the EXPIRED branch — even on active trials. That bug is what
// painted "● EXPIRED" on a 5-day-trial account.
//
// We also surface privileged plans (owner/official/admin/team/lifetime)
// with their own label instead of "PRO · owner" — those accounts hold the
// product, they're not subscribers.
var _PRIVILEGED_PILL_LABELS = {
  owner:    'OWNER',
  official: 'OFFICIAL',
  admin:    'ADMIN',
  team:     'TEAM',
  lifetime: 'LIFETIME',
};
async function refreshLicensePill() {
  // PR-LAYOUT-V5 — tb-license-pill was removed (it duplicated the
  // existing #license-pill-host injected by license-ui.js). license-ui.js
  // handles its own rendering via window.H.onLicenseChange / licenseState
  // — we don't need to write to it from here. We still write to the
  // legacy csb-license pill in chat-status-bar for any back-compat path
  // (it's CSS-hidden via #csb-license { display:none !important } above).
  const pills = [
    document.getElementById('csb-license'),
  ].filter(Boolean);
  if (!pills.length) return;
  try {
    const state = await H.licenseState();
    if (!state) { pills.forEach(p => { p.style.display = 'none'; }); return; }
    let text = '', cls = '', title = '', show = true;
    const plan = String(state.plan || '').toLowerCase();
    const privileged = _PRIVILEGED_PILL_LABELS[plan];
    if (privileged) {
      text = privileged;
      cls = 'accent';
      title = privileged + ' access - Horizon is included for this account.';
    } else if (state.reason === 'pro') {
      text = 'PRO';
      cls = 'accent';
      const planSuffix = plan ? ' - ' + plan : '';
      title = 'Pro active' + planSuffix + (state.expiresAt ? ' - renews ' + new Date(state.expiresAt).toLocaleDateString() : '');
    } else if (state.reason === 'trial') {
      const days = state.trialDaysLeft != null ? state.trialDaysLeft : null;
      text = days != null ? 'TRIAL ' + days + 'd' : 'TRIAL';
      cls = 'warn';
      title = 'Free trial - ' + (days != null ? days + ' days' : '') + ' left. Click to upgrade.';
    } else if (state.reason === 'trial-expired' || state.reason === 'expired') {
      text = 'EXPIRED';
      cls = 'danger';
      title = state.reason === 'trial-expired'
        ? 'Trial ended. Click to upgrade.'
        : 'Subscription expired. Click to renew.';
    } else {
      show = false;
    }
    pills.forEach(pill => {
      if (!show) { pill.style.display = 'none'; return; }
      pill.style.display = 'inline-flex';
      pill.classList.remove('accent', 'warn', 'danger');
      if (cls) pill.classList.add(cls);
      pill.textContent = text;
      pill.title = title;
    });
  } catch (_) {
    pills.forEach(p => { try { p.style.display = 'none'; } catch (__) {} });
  }
}
function onLicensePillClick() {
  try { H.licenseOpenUpgradePage && H.licenseOpenUpgradePage(); } catch(_){}
}
// Update license pill when desktop pushes a license-state event.
// The account panel reads the same state for the Pro badge, so refresh it
// here too when it's open — otherwise the badge lags behind by up to an hour
// (the license refresh interval).
try {
  H.onLicenseChange && H.onLicenseChange(() => {
    refreshLicensePill();
    if (document.getElementById('acct-panel')?.classList.contains('show')) renderAcctBody();
  });
} catch(_){}


