// PR-V Phase 3.8 — Marketplace Store + Horizon Account.
// Extracted from chat.html inline <script> (was lines 5249-5835).
//
// Two adjacent surfaces bundled because they both gate on the same
// account/session state and the Account panel is what unlocks the
// Marketplace install flow.
//
//   1. Marketplace Store
//      State: storeCurrentTab, storeCat, storeItems, storeInstalled
//      Fns: openStore, closeStore, storeTab, renderStoreBody,
//           renderStoreWorkflows, renderStoreWorkflowMarketCards,
//           renderStorePlugins, renderStoreCards, filterStore,
//           installStorePlugin, publishPlugin
//
//   2. Horizon Account (SSO with marketplace website)
//      State: acctCurrentTab
//      Fns: openAccount, closeAccount, acctTab, renderAcctBody,
//           acctOpenWebAuth, acctDoLogin, acctDoSignup, acctLogout
//
// Loaded as external script AFTER main inline so window.* globals
// it reads (H IPC marketplace/auth, addMsg, lang, customConfirm,
// etc.) are defined.

// ═══════════════════════════════════════════════════════════════
// MARKETPLACE STORE
// ═══════════════════════════════════════════════════════════════
var storeCurrentTab = 'plugins';
var storeCat = 'all';
var storeItems = [];
var storeInstalled = [];

// ═══════════════════════════════════════════════════════════════
// HORIZON ACCOUNT (SSO with marketplace website)
// ═══════════════════════════════════════════════════════════════
var acctCurrentTab = 'login';
var currentUser = null;

async function refreshAccount() {
  try {
    const r = await H.marketMe();
    currentUser = (r && r.ok) ? r.user : null;
  } catch (_) { currentUser = null; }
  const btn = document.getElementById('acct-btn');
  if (btn) {
    if (currentUser) {
      btn.textContent = (currentUser.display_name || currentUser.email || '?').slice(0, 1).toUpperCase();
      btn.classList.add('loggedin');
      btn.title = `Signed in as ${currentUser.display_name || currentUser.email}`;
    } else {
      btn.textContent = '👤';
      btn.classList.remove('loggedin');
      btn.title = 'Horizon account — sign in or create one';
    }
  }
  if (document.getElementById('acct-panel')?.classList.contains('show')) renderAcctBody();
  if (document.getElementById('store-panel')?.classList.contains('show') && storeCurrentTab === 'plugins') renderStoreBody();
}

function openAccount() {
  setActiveSurface('account', { keepPanels:['acct-panel'] });
  document.getElementById('acct-panel').classList.add('show');
  acctTab(currentUser ? 'profile' : 'login');
}
function closeAccount() {
  document.getElementById('acct-panel').classList.remove('show');
  if (isSurfaceActive('account')) closeActiveSurface();
}
function acctTab(tab) {
  acctCurrentTab = tab;
  const tabs = document.getElementById('acct-tabs');
  if (currentUser) {
    tabs.innerHTML = `<button class="ftab on" onclick="acctTab('profile')">My account</button>`;
  } else {
    ['login','signup'].forEach(t => {
      const el = document.getElementById(`acct-tab-${t}`);
      if (el) el.classList.toggle('on', t === tab);
    });
  }
  renderAcctBody();
}

// Plans that already include the desktop agent — they should NOT additionally
// surface a "Pro" badge, otherwise an admin/owner sees "Owner Pro" which is
// noisy and slightly misleading. Mirrors the marketplace web app
// (PRIVILEGED_LICENSE_PLANS in Pricing.jsx / Dashboard.jsx).
var _PRIVILEGED_LICENSE_PLANS = new Set(['owner','official','admin','team','lifetime']);

async function _getLicenseStateSafe(){
  try { return (typeof H !== 'undefined' && H.licenseState) ? await H.licenseState() : null; }
  catch(_) { return null; }
}

async function renderAcctBody() {
  const body = document.getElementById('acct-body');
  if (currentUser) {
    const initials = (currentUser.display_name || currentUser.email || '?').slice(0, 1).toUpperCase();
    // Pull license state alongside the user so the Pro badge reflects the
    // server-truth from /api/license/status, not stale UI state.
    const license = await _getLicenseStateSafe();
    const plan = String(license?.plan || '').toLowerCase();
    const isPrivilegedPlan = _PRIVILEGED_LICENSE_PLANS.has(plan);
    const badges = [];
    // Owner — reserved for the project itself (admin AND official).
    // Official — affiliated accounts that aren't the admin (e.g. team).
    // Both are project-side identity badges — never inferred from license alone.
    if (currentUser.is_admin && currentUser.is_official) badges.push(`<span class="acct-badge admin">Owner</span>`);
    else if (currentUser.is_official) badges.push(`<span class="acct-badge admin">Official</span>`);
    // Pro — earned via active subscription. Skip when the user already holds a
    // privileged plan (owner/official/admin/team/lifetime), since the desktop
    // is included for them; no need for the "Pro" decoration.
    if (license?.active && !isPrivilegedPlan) badges.push(`<span class="acct-badge pro">Pro</span>`);
    if (currentUser.is_verified) badges.push(`<span class="acct-badge">Verified</span>`);
    body.innerHTML = `
      <div class="acct-card">
        <div class="acct-avatar">${initials}</div>
        <div class="acct-info">
          <div class="acct-name">${currentUser.display_name || '—'} ${badges.join(' ')}</div>
          <div class="acct-email">${currentUser.email || ''}</div>
        </div>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="sc-btn primary" onclick="openMarketplaceWeb()">Open my dashboard on the web</button>
        <button class="sc-btn" onclick="acctLogout()">Sign out</button>
      </div>
      <div class="auth-hint" style="margin-top:18px">
        You are signed into Horizon Marketplace. Plugins you install, publish or purchase are tied to this account.<br/>
        The same credentials work on the website and in this app.
      </div>
    `;
    return;
  }
  if (acctCurrentTab === 'signup') {
    body.innerHTML = `
      <div class="auth-card">
        <h3>Create your Horizon account</h3>
        <div class="auth-sub">One account for the website and the desktop app.</div>
        <div id="auth-err" style="display:none" class="auth-err"></div>
        <button class="auth-web-btn" onclick="acctOpenWebAuth('signup')">Continue with Google / GitHub</button>
        <div class="auth-divider">or email</div>
        <div class="auth-field"><label>Display name</label><input id="auth-name" placeholder="Ernest Kostevich" autocomplete="name"/></div>
        <div class="auth-field"><label>Email</label><input id="auth-email" type="email" placeholder="you@example.com" autocomplete="email"/></div>
        <div class="auth-field"><label>Password</label><input id="auth-pw" type="password" placeholder="At least 8 characters" autocomplete="new-password"/></div>
        <button class="auth-submit" id="auth-submit" onclick="acctDoSignup()">Create account</button>
        <div class="auth-hint">Already have an account? <a onclick="acctTab('login')">Sign in</a></div>
      </div>
    `;
  } else {
    body.innerHTML = `
      <div class="auth-card">
        <h3>Sign in to Horizon</h3>
        <div class="auth-sub">Use the same email and password as the marketplace website.</div>
        <div id="auth-err" style="display:none" class="auth-err"></div>
        <button class="auth-web-btn" onclick="acctOpenWebAuth('login')">Continue with Google / GitHub</button>
        <div class="auth-divider">or email</div>
        <div class="auth-field"><label>Email</label><input id="auth-email" type="email" placeholder="you@example.com" autocomplete="email"/></div>
        <div class="auth-field"><label>Password</label><input id="auth-pw" type="password" placeholder="••••••••" autocomplete="current-password"/></div>
        <button class="auth-submit" id="auth-submit" onclick="acctDoLogin()">Sign in</button>
        <div class="auth-hint">No account yet? <a onclick="acctTab('signup')">Create one</a></div>
      </div>
    `;
  }
}

function _authShowErr(msg) {
  const el = document.getElementById('auth-err');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

async function acctOpenWebAuth(mode) {
  try {
    const r = await H.marketOpenWebAuth(mode || 'login');
    if (!r?.ok) return _authShowErr(r?.error || 'Could not open browser sign-in.');
    H.notify?.('Horizon', 'Finish sign-in in the browser. The app will reconnect automatically.');
  } catch (e) {
    _authShowErr(e.message || 'Could not open browser sign-in.');
  }
}

async function acctDoLogin() {
  const email = (document.getElementById('auth-email')?.value || '').trim();
  const pw = document.getElementById('auth-pw')?.value || '';
  if (!email || !pw) return _authShowErr('Email and password are required.');
  const btn = document.getElementById('auth-submit');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const r = await H.marketLogin(email, pw);
    if (!r.ok) { _authShowErr(r.error || 'Invalid credentials'); return; }
    currentUser = r.user;
    await refreshAccount();
    acctTab('profile');
    H.notify?.('Horizon', `Welcome back, ${r.user.display_name || r.user.email}`);
  } catch (e) {
    _authShowErr(e.message || 'Network error');
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}

async function acctDoSignup() {
  const name = (document.getElementById('auth-name')?.value || '').trim();
  const email = (document.getElementById('auth-email')?.value || '').trim();
  const pw = document.getElementById('auth-pw')?.value || '';
  if (!name || !email || !pw) return _authShowErr('All fields are required.');
  if (pw.length < 8) return _authShowErr('Password must be at least 8 characters.');
  const btn = document.getElementById('auth-submit');
  btn.disabled = true; btn.textContent = 'Creating account…';
  try {
    const r = await H.marketSignup(email, pw, name);
    if (!r.ok) { _authShowErr(r.error || 'Could not create account'); return; }
    currentUser = r.user;
    await refreshAccount();
    acctTab('profile');
    H.notify?.('Horizon', `Welcome, ${r.user.display_name || r.user.email}!`);
  } catch (e) {
    _authShowErr(e.message || 'Network error');
  } finally {
    btn.disabled = false; btn.textContent = 'Create account';
  }
}

async function acctLogout() {
  await H.marketLogout();
  currentUser = null;
  await refreshAccount();
  acctTab('login');
}

async function openMarketplaceWeb() {
  const url = await H.marketGetWebUrl();
  H.openUrl(url + '/dashboard');
}

function openStore() {
  setActiveSurface('marketplace', { keepPanels:['store-panel'] });
  document.getElementById('store-panel').classList.add('show');
  storeTab('plugins');
}
function closeStore() {
  document.getElementById('store-panel').classList.remove('show');
  if (isSurfaceActive('marketplace')) closeActiveSurface();
}
function storeTab(tab) {
  storeCurrentTab = tab;
  ['plugins','workflows','publish'].forEach(t => {
    document.getElementById(`store-tab-${t}`)?.classList.toggle('on', t === tab);
  });
  renderStoreBody();
}

async function renderStoreBody() {
  const body = document.getElementById('store-body');
  if (storeCurrentTab === 'plugins') {
    body.innerHTML = '<div style="color:var(--t3);font-size:11px">Loading marketplace...</div>';
    try {
      // Pass `type: 'plugin'` so the Plugins tab only shows plugins. Without
      // this, items published as workflows on the marketplace bled into the
      // plugin grid (the backend `/api/plugins` returns *both* types when
      // no filter is supplied — see plugins_routes.py:188).
      const r = await H.marketRemoteList({ type: 'plugin' });
      if (!r.ok) {
        const url = await H.marketGetUrl();
        body.innerHTML = `<div style="color:var(--red);font-size:11px;padding:16px;border:1px solid rgba(255,80,80,.3);border-radius:10px">
          <b>Cannot reach marketplace</b><br/>${r.error || 'network error'}<br/><br/>
          <span style="color:var(--t3)">Server: <code>${url}</code></span><br/>
          <span style="color:var(--t3)">Check Settings -> Marketplace URL or your internet connection.</span>
        </div>`;
        return;
      }
      storeItems = r.items || [];
      const installed = (await H.pluginList()).map(p => p.id);
      storeInstalled = installed;
      renderStorePlugins(storeItems, installed);
    } catch(e) {
      body.innerHTML = `<div style="color:var(--red);font-size:11px">Error: ${e.message}</div>`;
    }
  } else if (storeCurrentTab === 'workflows') {
    await renderStoreWorkflows(body);
  } else if (storeCurrentTab === 'publish') {
    const url = await H.marketGetWebUrl();
    body.innerHTML = `
      <div class="publish-cta">
        <div class="publish-cta-icon">&#128640;</div>
        <div class="publish-cta-text">
          <h3>Publishing happens on the web</h3>
          <p>The full 5-step publisher, moderation queue, reviews and creator analytics live on the marketplace site. Open the dashboard to submit a plugin.</p>
        </div>
        <button class="publish-cta-btn" onclick="H.openUrl('${url}/publish')">Open publisher</button>
      </div>
      <div class="empty-state"><div class="es-icon">&#9889;</div><h3>Why not in the app?</h3>
      <p>Publishing needs: account identity, human moderation, screenshots, pricing review. That's a web surface - the desktop app only runs plugins.</p>
      <div style="margin-top:14px;display:flex;gap:8px;justify-content:center">
        <button class="sc-btn primary" onclick="H.openUrl('${url}/publish')">Publish a plugin</button>
        <button class="sc-btn" onclick="H.openUrl('${url}/dashboard')">My shelf / earnings</button>
      </div></div>
    `;
  }
}

async function renderStoreWorkflows(body) {
  body.innerHTML = '<div style="color:var(--t3);font-size:11px">Loading workflows...</div>';
  let items = [];
  let activeRuns = [];
  let marketWorkflows = [];
  let marketErr = '';
  let error = '';
  // (a) Local engine workflows — what the user has stored on their machine.
  try {
    const list = await H.workflowList?.();
    items = Array.isArray(list) ? list : [];
  } catch(e) {
    error = e?.message || 'workflow list failed';
  }
  // (b) Marketplace-published workflows — fetched separately so we can
  // render an "Install" CTA per item. Failure here is non-fatal: local
  // workflows still render even if marketplace is down.
  try {
    const r = await H.marketRemoteList({ type: 'workflow' });
    if (r && r.ok) marketWorkflows = r.items || [];
    else marketErr = (r && r.error) || 'marketplace unreachable';
  } catch (e) {
    marketErr = e?.message || 'marketplace fetch failed';
  }
  try {
    const live = await H.workflowActiveRuns?.();
    activeRuns = Array.isArray(live) ? live : [];
  } catch(_) {}

  if (error) {
    body.innerHTML = `<div style="color:var(--red);font-size:11px;padding:16px;border:1px solid rgba(255,80,80,.3);border-radius:10px">
      <b>Cannot load workflows</b><br/>${_escHtml(error)}
    </div>`;
    return;
  }

  const enabledCount = items.filter(w => w.enabled !== false).length;
  const scheduledCount = items.filter(w => w.trigger && w.trigger !== 'manual').length;
  const runCount = items.reduce((sum, w) => sum + Number(w.runCount || 0), 0);
  const lastRun = items.map(w => w.lastRun).filter(Boolean).sort().at(-1);
  const rows = items.map(w => {
    const id = _escAttr(w.id || '');
    const steps = Array.isArray(w.steps) ? w.steps.length : 0;
    const runs = Number(w.runCount || 0);
    const ok = Number(w.successCount || 0);
    const fail = Number(w.failCount || 0);
    const rate = runs ? Math.round((ok / Math.max(1, ok + fail)) * 100) : null;
    const trigger = _wfTriggerKind(String(w.trigger || 'manual'));
    return `
      <div class="wf-card" style="margin-bottom:10px">
        <div class="wf-head">
          <div>
            <div class="wf-name">${_escHtml(w.name || 'Untitled workflow')}</div>
            <div class="wf-desc">${_escHtml(w.description || 'No description yet')}</div>
          </div>
          <div class="wf-trigger-badge" style="${w.enabled === false ? 'color:var(--t3);border-color:var(--b1)' : 'color:var(--green);border-color:rgba(52,211,153,.28);background:rgba(52,211,153,.08)'}">${w.enabled === false ? 'paused' : 'enabled'}</div>
        </div>
        <div class="wf-steps">
          <div class="wf-step"><span class="wf-step-icon">&#9889;</span>${steps} ${steps === 1 ? 'step' : 'steps'}</div>
          <div class="wf-step"><span class="wf-step-icon">&#9654;</span>${runs} ${runs === 1 ? 'run' : 'runs'}</div>
          <div class="wf-step"><span class="wf-step-icon">&#10003;</span>${rate === null ? 'no success data' : `${rate}% success`}</div>
          <div class="wf-step"><span class="wf-step-icon">&#8987;</span>${_escHtml(w.lastRun ? _wfFmtRel(w.lastRun) : 'never run')}</div>
        </div>
        <div class="wf-footer">
          <div class="wf-trigger">Trigger: <span class="wf-trigger-badge ${trigger.cls || ''}">${_escHtml(trigger.label)}</span></div>
          <div class="wf-actions">
            <button class="wf-btn run" onclick="runStoreWorkflow('${id}')">&#9654; Run</button>
            <button class="wf-btn" onclick="openWorkflowPanelFromStore('overview')">Open</button>
          </div>
        </div>
      </div>`;
  }).join('');

  const liveBlock = activeRuns.length ? `
    <div class="wfp-live" style="margin-bottom:14px">
      <div class="wfp-live-h">
        <div class="wfp-live-title"><span class="wfp-live-eyebrow">running</span>${_escHtml(activeRuns[0].name || activeRuns[0].workflowId || 'Workflow')}</div>
        <div class="wfp-live-meta">${Number(activeRuns[0].currentStep || 0) + 1}/${Number(activeRuns[0].totalSteps || 0)} steps</div>
      </div>
      <div class="wfp-graph">${(activeRuns[0].steps || []).map((s, i) => `
        <div class="wfp-node ${s.status || 'pending'}">
          <div class="wfp-node-kind">${_escHtml(_wfStepKind(s.action))}</div>
          <div class="wfp-node-label">${_escHtml(_wfStepLabel(s.action))}</div>
        </div>${i < (activeRuns[0].steps || []).length - 1 ? '<div class="wfp-link"></div>' : ''}
      `).join('')}</div>
    </div>` : '';

  body.innerHTML = `
    <div class="wfp-kpis" style="margin-bottom:14px">
      <div class="wfp-kpi"><div class="wfp-kpi-label">Stored</div><div class="wfp-kpi-value">${items.length}</div><div class="wfp-kpi-trend flat">local workflows</div></div>
      <div class="wfp-kpi"><div class="wfp-kpi-label">Enabled</div><div class="wfp-kpi-value">${enabledCount}</div><div class="wfp-kpi-trend ${enabledCount ? 'up' : 'flat'}">ready to run</div></div>
      <div class="wfp-kpi"><div class="wfp-kpi-label">Scheduled</div><div class="wfp-kpi-value">${scheduledCount}</div><div class="wfp-kpi-trend flat">timers / wake</div></div>
      <div class="wfp-kpi"><div class="wfp-kpi-label">Last run</div><div class="wfp-kpi-value" style="font-size:18px">${_escHtml(_wfFmtRel(lastRun))}</div><div class="wfp-kpi-trend flat">${runCount} total runs</div></div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button class="sc-btn primary" onclick="openWorkflowPanelFromStore('overview')">Open Workflows</button>
      <button class="sc-btn" onclick="openWorkflowPanelFromStore('create')">Create workflow</button>
      <button class="sc-btn" onclick="renderStoreBody()">Refresh</button>
    </div>
    ${liveBlock}
    <div style="font:600 9px/1 var(--mono);letter-spacing:1.4px;text-transform:uppercase;color:var(--t3);margin:18px 0 10px">YOUR WORKFLOWS — ${items.length}</div>
    ${items.length ? rows : `
      <div class="empty-state" style="padding:24px 16px">
        <div class="es-icon">&#9889;</div>
        <h3>No local workflows yet</h3>
        <p>Create one or install one from the marketplace below.</p>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:center">
          <button class="sc-btn primary" onclick="openWorkflowPanelFromStore('create')">Create workflow</button>
          <button class="sc-btn" onclick="openWorkflowPanelFromStore('overview')">Open Workflows</button>
        </div>
      </div>`}

    <div style="font:600 9px/1 var(--mono);letter-spacing:1.4px;text-transform:uppercase;color:var(--t3);margin:24px 0 10px">MARKETPLACE WORKFLOWS — ${marketWorkflows.length}</div>
    ${marketErr
      ? `<div style="color:var(--t3);font-size:11px;padding:14px;border:1px dashed var(--b1);border-radius:10px">Marketplace unavailable: ${_escHtml(marketErr)}. Local workflows above still work.</div>`
      : (marketWorkflows.length
        ? renderStoreWorkflowMarketCards(marketWorkflows, items)
        : `<div style="color:var(--t3);font-size:11px;padding:14px;border:1px dashed var(--b1);border-radius:10px">No workflows have been published to the marketplace yet. Be the first — open the publisher on the web.</div>`)
    }
  `;
}

// Render the marketplace-workflow cards. Each card carries an Install
// button which routes through H.marketRemoteInstallWorkflow → the
// engine's create() so triggers actually fire after install. We dedupe
// by id against the local list so already-installed workflows show
// "Installed" instead of a duplicate Install button.
function renderStoreWorkflowMarketCards(remoteItems, localItems) {
  const localIds = new Set((localItems || []).map(w => (w && w.id ? String(w.id) : '')).filter(Boolean));
  return remoteItems.map(it => {
    const id = _escAttr(it.id || it.slug || '');
    const installed = localIds.has(String(it.id || it.slug || ''));
    const stepsCount = Array.isArray(it.tools) ? it.tools.length : 0;
    return `
      <div class="phd-card" style="margin-bottom:10px">
        <div class="phd-card-h">
          <div class="phd-card-icon">${pluginIcon(it.icon || '\u{26A1}')}</div>
          <div class="phd-card-info">
            <div class="phd-card-name">${_escHtml(it.name || 'Untitled')}</div>
            <div class="phd-card-author">${_escHtml(it.author_name || it.author || 'unknown')}</div>
          </div>
        </div>
        <div class="phd-card-desc">${_escHtml(it.short_description || it.description || 'No description')}</div>
        <div class="phd-card-foot">
          <div class="phd-card-meta">
            <span>${stepsCount} ${stepsCount === 1 ? 'step' : 'steps'}</span>
            <span>v${_escHtml(it.version || '1.0.0')}</span>
          </div>
          <button class="phd-card-cta ${installed ? 'on' : ''}" ${installed ? 'disabled' : ''} onclick="installStoreWorkflow('${id}', this)">${installed ? '✓ Installed' : 'Install'}</button>
        </div>
      </div>`;
  }).join('');
}

window.installStoreWorkflow = async function (id, btn) {
  if (!id) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Installing...'; }
  try {
    const r = await H.marketRemoteInstallWorkflow(id);
    if (r && r.ok) {
      if (btn) { btn.classList.add('on'); btn.textContent = '✓ Installed'; }
      try { H.notify?.('Workflow installed', r.workflow?.name || 'Workflow ready'); } catch (_) {}
      // Refresh the store body so KPIs / dedupe updates.
      setTimeout(() => { renderStoreBody().catch(() => {}); }, 400);
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Install'; }
      alert('Install failed: ' + (r?.error || 'unknown error'));
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Install'; }
    alert('Install failed: ' + (e?.message || e));
  }
};

function openWorkflowPanelFromStore(tab = 'overview') {
  closeStore();
  openWorkflows();
  if (tab && tab !== 'overview') wfTab(tab);
}

async function runStoreWorkflow(id) {
  closeStore();
  await runWorkflowById(id);
}

function renderStorePlugins(items, installed) {
  const body = document.getElementById('store-body');
  const cats = ['all', ...new Set(items.map(i => i.category).filter(Boolean))];
  const acctBanner = currentUser
    ? `<div style="display:flex;gap:10px;align-items:center;padding:8px 12px;background:rgba(52,211,153,.06);border:1px solid rgba(52,211,153,.2);border-radius:10px;margin-bottom:14px;font-size:11px;color:var(--t2)">
        <span style="font-size:14px">&#10003;</span>
        <span>Signed in as <b>${currentUser.display_name || currentUser.email}</b>. Installs, purchases and reviews are tied to your account.</span>
      </div>`
    : `<div style="display:flex;gap:10px;align-items:center;padding:8px 12px;background:var(--acc3);border:1px solid rgba(108,140,255,.25);border-radius:10px;margin-bottom:14px;font-size:11px;color:var(--t2)">
        <span style="font-size:14px">&#128100;</span>
        <span style="flex:1">Not signed in. Free plugins install anonymously - paid plugins need an account.</span>
        <button class="sc-btn primary" style="padding:4px 10px" onclick="openAccount()">Sign in</button>
      </div>`;
  body.innerHTML = `
    ${acctBanner}
    <div class="store-search">
      <input class="store-search-input" id="store-q" placeholder="Search plugins..." oninput="filterStore(this.value)"/>
    </div>
    <div class="store-cats">
      ${cats.map(c => `<button class="store-cat ${c === storeCat ? 'on' : ''}" onclick="setStoreCat('${c}')">${c === 'all' ? 'All' : c}</button>`).join('')}
    </div>
    <div class="store-grid" id="store-grid">
      ${items.length ? renderStoreCards(items, installed) : '<div class="empty-state"><div class="es-icon">&#128269;</div><h3>No real marketplace plugins yet</h3><p>Horizon only shows plugins returned by the marketplace API. Local built-ins live under Installed.</p></div>'}
    </div>
  `;
}

function renderStoreCards(items, installed) {
  return items.map(p => {
    const isInstalled = installed.includes(p.id);
    const rawRating = Number(p.rating_avg || p.rating || 0);
    const ratingText = rawRating > 0 ? rawRating.toFixed(1).replace(/\.0$/, '') + '/5' : 'Not rated';
    const installs = Number(p.downloads || p.installs || 0);
    const installText = installs > 0 ? installs.toLocaleString() + ' installs' : 'No installs yet';
    const price = p.price_usd ?? p.price ?? 0;
    const safeId = String(p.id || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const safeSlug = String(p.slug || p.id || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const author = p.author_name || p.author || 'Horizon Team';
    const verified = p.author_verified ? ' <span style="color:var(--green);font-size:9px" title="Verified author">\u2713</span>' : '';
    const desc = p.short_description || p.description || '';
    return `
      <div class="store-card">
        <div class="sc-head">
          <div class="sc-icon">${pluginIcon(p.icon)}</div>
          <div class="sc-meta">
            <div class="sc-name">${p.name}</div>
            <div class="sc-author">${author}${verified}</div>
          </div>
        </div>
        <div class="sc-desc">${desc}</div>
        <div class="sc-footer">
          <div class="sc-tags">
            <span class="sc-tag ${price > 0 ? 'paid' : 'free'}">${price > 0 ? '$' + price : 'Free'}</span>
            ${p.category ? `<span class="sc-tag">${p.category}</span>` : ''}
            <span class="sc-tag">${(p.tools||[]).length} tools</span>
          </div>
          <div class="sc-actions">
            <div class="sc-rating"><span>${ratingText}</span><span class="sc-dl">${installText}</span></div>
            <button class="sc-btn ${isInstalled ? 'installed' : 'primary'}" onclick="${isInstalled ? `removePlugin('${safeId}')` : `installStorePlugin('${safeId}', ${price}, '${safeSlug}')`}">${isInstalled ? 'Installed \u2713' : (price > 0 ? 'Buy - $' + price : 'Install')}</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function setStoreCat(cat) {
  storeCat = cat;
  document.querySelectorAll('.store-cat').forEach(b => b.classList.toggle('on', b.textContent.toLowerCase() === cat || (cat === 'all' && b.textContent === 'All')));
  const q = document.getElementById('store-q')?.value || '';
  filterStore(q);
}

function filterStore(q) {
  const filtered = storeItems.filter(i => {
    const matchCat = storeCat === 'all' || i.category === storeCat;
    const matchQ = !q || i.name.toLowerCase().includes(q.toLowerCase()) || (i.description||'').toLowerCase().includes(q.toLowerCase());
    return matchCat && matchQ;
  });
  const grid = document.getElementById('store-grid');
  if (grid) grid.innerHTML = filtered.length ? renderStoreCards(filtered, storeInstalled) : '<div class="empty-state"><div class="es-icon">&#128269;</div><h3>No matching real plugins</h3><p>Try a different category or search query.</p></div>';
}

async function installStorePlugin(id, price = 0, slug = '') {
  const openPluginPurchase = async () => {
    const url = await H.marketGetWebUrl();
    const pluginKey = slug || id;
    const pluginUrl = `${String(url || 'https://horizonaai.dev').replace(/\/+$/, '')}/plugin/${encodeURIComponent(pluginKey)}`;
    H.openUrl(pluginUrl);
    H.notify?.('Marketplace', 'Opening browser to complete purchase securely.');
    addMsg('bot', `Plugin purchases are securely handled on the marketplace website.\n\nOpened: ${pluginUrl}`);
  };
  if (price > 0) {
    await openPluginPurchase();
    return;
  }
  try {
    const r = await H.marketRemoteInstall(id);
    if (r.ok) {
      addMsg('bot', lang === 'ru' ? `🧩 Плагин **${r.name}** установлен!` : `🧩 Plugin **${r.name}** installed!`);
      renderStoreBody();
    } else {
      if (/unauthor|401|login/i.test(r.error || '')) {
        H.notify?.('Marketplace', 'Sign in required to install this plugin.');
        openAccount();
      } else {
        H.notify?.('Marketplace', r.error || 'install failed');
      }
    }
  } catch(e) { 
    H.notify?.('Marketplace', e.message); 
  }
}

async function publishPlugin() {
  try {
    const url = await H.marketGetWebUrl();
    const publishUrl = `${String(url || 'https://horizonaai.dev').replace(/\/+$/, '')}/publish`;
    H.openUrl(publishUrl);
    H.notify('Marketplace', 'Publishing opens in your browser dashboard.');
    addMsg('bot', `Marketplace publishing now happens on the web dashboard so moderation, ownership and payouts are real.\n\nOpened: ${publishUrl}`);
  } catch(e) {
    H.notify('Marketplace', e.message || 'Could not open publisher');
  }
}


