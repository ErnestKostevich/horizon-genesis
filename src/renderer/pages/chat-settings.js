// PR-V Phase 3.3 — Settings Panel module.
// Extracted from chat.html inline <script> (was lines 3889-4497).
// Behaviour identical. Loaded as external script AFTER main inline
// so window.* globals it reads (H IPC, lang, userName, prov, mode,
// applyLang, showGreeting, updateShellChrome, renderPersonasEditor,
// refreshPermissionAllowlist, _modelCache, MODEL_PICKER_REGISTRY,
// etc.) are defined.
//
// Contains:
//   - Tab switcher: setSettingsTab + _bootSettingsScroll IIFE + URL
//     hash → tab DOMContentLoaded handler
//   - Settings I/O: saveSetting, readSetting, setSettingsStatus,
//     loadSettingsHealth, verifySettingsPersistence, openSettingsFolder
//   - Big loader: loadPanel (parallel-fetches every key, populates
//     every input on first open)
//   - Provider/model: _seedLocalModelSelect, refreshOpenRouterModels,
//     _renderOpenRouterOptions, filterOpenRouterModels,
//     refreshLocalModels, saveModelSetting, saveLocalProvider,
//     testLocalProvider
//   - Profile / Lang / Voice: savePf, saveLang, saveVP, saveTTSProv,
//     saveElVoice, saveOAITTSVoice, loadKokoro
//   - Connections: connectGoogleFromConnections, disconnectGoogle,
//     connectGithub, _setConnStatus
//   - Response Profile: saveResponseProfile, _profileSupportsThinking,
//     updateThinkingHint
//   - Generic key saver: psvk
//
// CRITICAL: saveModelSetting is called from Cmd+K palette, slash
// commands (/model), model picker, and provider switcher. Keep it
// on window — declared as plain  so it auto-binds.

// Switch the active Settings tab. Updates the left-rail button styling and
// shows the matching <section data-pane="…">. Persists last tab via two
// channels: (1) electron settings (cross-restart persistence), (2) URL
// hash (so a renderer reload via Ctrl+R during dev keeps you on the same
// tab). Both are safe-no-ops on failure.
function setSettingsTab(name){
  if (!name) return;
  // PR-U4 — in single-scroll mode, instead of toggling .on classes
  // (which would hide other sections), we scroll-snap the requested
  // section into view. Both .psnav-tab AND .ps-toc-link get the .on
  // visual marker so the legacy + new navigations stay in sync.
  document.querySelectorAll('#psnav .psnav-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.ps-toc-link').forEach(b => b.classList.toggle('on', b.dataset.target === name));
  if (document.body.classList.contains('settings-scroll')) {
    const target = document.querySelector(`#psview > section[data-pane="${name}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    // Legacy tabbed mode — keep the original behaviour.
    document.querySelectorAll('#psview > section').forEach(s => s.classList.toggle('on', s.dataset.pane === name));
    try { document.getElementById('psview').scrollTop = 0; } catch(_) {}
  }
  try { H.set('settingsTab', name); } catch(_) {}
  try {
    if (location.hash !== '#settings/' + name) {
      history.replaceState(null, '', '#settings/' + name);
    }
  } catch(_) {}
  if (name === 'features') refreshPermissionAllowlist().catch(()=>{});
  if (name === 'personas') renderPersonasEditor().catch(()=>{});
}

// PR-U4 — boot single-scroll settings + wire IntersectionObserver
// so the right-side TOC highlights whichever section is in view
// while the user scrolls naturally (no need to click anything).
(async function _bootSettingsScroll() {
  // Default ON unless explicitly disabled.
  try {
    const v = await H.get?.('settingsScroll');
    document.body.classList.toggle('settings-scroll', v !== false);
  } catch (_) {
    document.body.classList.add('settings-scroll');
  }
  // Wait until the panel exists, then observe sections.
  setTimeout(() => {
    if (!document.body.classList.contains('settings-scroll')) return;
    const sections = document.querySelectorAll('#psview > section[data-pane]');
    if (!sections.length) return;
    const obs = new IntersectionObserver((entries) => {
      // Find the entry closest to the top that's intersecting.
      const visible = entries.filter(e => e.isIntersecting);
      if (!visible.length) return;
      const top = visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      const name = top?.target?.dataset?.pane;
      if (!name) return;
      document.querySelectorAll('.ps-toc-link').forEach(b => b.classList.toggle('on', b.dataset.target === name));
    }, {
      // Trigger when the section's top is in the upper third of the viewport.
      rootMargin: '-10% 0px -70% 0px',
      threshold: 0,
    });
    sections.forEach(s => obs.observe(s));
  }, 600);
})();

// ═══ PERSONAS EDITOR ═══════════════════════════════════════════════════
// Renders the two-column editor inside #pe-mount. Left: list of all

// PR-V Phase 3.2 — Personas Editor extracted to chat-personas.js.
// All pe* functions (renderPersonasEditor, loadPersonaSelect,
// _renderPeList, _renderPeBody, _peCollectAllowedTools, peSelect,
// peSavePrompt, peDelete, peCreateCustom, etc.) live there now.
// _peActiveId, _peCache, PE_TOOLS module-state also moved.


// On reload, if the URL hash points to a Settings tab, open the panel and
// jump to that tab. Lets devs use F5 / Ctrl+R during testing without
// losing their place.
window.addEventListener('DOMContentLoaded', () => {
  try {
    const m = (location.hash || '').match(/^#settings\/([a-z]+)$/);
    if (m && document.querySelector(`[data-pane="${m[1]}"]`)) {
      openPanel(m[1]);
    }
  } catch(_) {}
});

async function loadPanel(){
  // Parallel fetch — fast, no sequential bottleneck
  const svcs=['gemini','groq','deepseek','mistral','qwen','grok','claude','openai','perplexity','cohere','openrouter','tavily','elevenlabs','deepgram','localai','github'];
  const [keyFlags, nm, lg, vp, tp, elv, oaitv] = await Promise.all([
    Promise.all(svcs.map(s=>H.hasKey(s))),
    H.get('userName'), H.get('lang'), H.get('voiceProvider'),
    H.get('ttsProvider'), H.get('elevenLabsVoice'), H.get('openaiTtsVoice')
  ]);
  // Set key dots
  svcs.forEach((s,i)=>document.getElementById(`pd-${s}`)?.classList.toggle('on', keyFlags[i]));
  // Hydrate the model dropdowns from settingsStore so the user sees their
  // current selection (or the GA default if they've never picked one).
  const _modelDefaults = {
    claude:'claude-sonnet-4-6', openai:'gpt-5.4', gemini:'gemini-2.5-flash',
    groq:'llama-3.3-70b-versatile', deepseek:'deepseek-chat', grok:'grok-4',
    mistral:'mistral-large-latest', qwen:'qwen-plus',
    perplexity:'sonar-pro', cohere:'command-a-03-2025', openrouter:'openai/gpt-5.4-mini'
  };
  await Promise.all(Object.keys(_modelDefaults).map(async (p) => {
    try {
      const stored = await H.get('model.' + p);
      const sel = document.getElementById('ms-' + p);
      const value = typeof normalizeModelForProvider === 'function'
        ? normalizeModelForProvider(p, stored || _modelDefaults[p])
        : (stored || _modelDefaults[p]);
      if (sel) sel.value = value;
      if (stored && stored !== value) {
        await H.set('model.' + p, value).catch(()=>{});
      }
    } catch(_) {}
  }));
  // Hydrate Connections section state.
  try {
    const gAuth = await H.googleAuthStatus();
    _setConnStatus('google', !!(gAuth && gAuth.authenticated));
    const storedGoogleClientId = await H.get('googleClientId').catch(()=>null);
    const hasGoogleSecret = await H.hasKey('google_client_secret').catch(()=>false);
    const googleClientIdInput = document.getElementById('pi-gcid');
    const googleSecretInput = document.getElementById('pi-gcs');
    if (googleClientIdInput && storedGoogleClientId) googleClientIdInput.value = storedGoogleClientId;
    if (googleSecretInput && hasGoogleSecret) googleSecretInput.placeholder = '••••••••••';
  } catch(_) { _setConnStatus('google', false); }
  try {
    const ghKey = await H.hasKey('github');
    _setConnStatus('github', !!ghKey);
    if (ghKey) {
      const inp = document.getElementById('pi-github-conn');
      if (inp) inp.placeholder = '••••••••••';
    }
  } catch(_) {}
  loadTokenConnections().catch(()=>{});
  loadMcpServers().catch(()=>{});
  // Profile
  if(nm) document.getElementById('pi-name').value=nm;
  if(lg) document.getElementById('pi-lang').value=lg;
  // Voice STT
  if(vp){
    document.getElementById('pi-vprov').value=vp;
    const dg=document.getElementById('deepgram-section');
    if(dg) dg.style.display=(vp==='deepgram')?'block':'none';
  }
  // Voice TTS
  const ttsProv=tp||'system'; ttsProvider=ttsProv;
  document.getElementById('pi-ttsprov').value=ttsProv;
  document.getElementById('el-section').style.display=(ttsProv==='elevenlabs')?'block':'none';
  document.getElementById('oaitts-section').style.display=(ttsProv==='openai')?'block':'none';
  document.getElementById('kokoro-section').style.display=(ttsProv==='kokoro')?'block':'none';
  if(elv){elevenLabsVoice=elv;document.getElementById('pi-elvid').value=elv;}
  if(oaitv){openaiTtsVoice=oaitv;document.getElementById('pi-oaitts').value=oaitv;}
  // Wake-word calibration toggles + sensitivity slider.
  await loadWakeSettings();
  initWakeCalibrationUI();
  const [ou, om, om2, lu, lm, lm2] = await Promise.all([
    H.get('ollamaUrl'), H.get('ollamaModel'), H.get('model.ollama'),
    H.get('lmStudioUrl'), H.get('lmStudioModel'), H.get('model.lmstudio')
  ]);
  document.getElementById('pi-ollama-url').value = ou || 'http://127.0.0.1:11434/v1';
  document.getElementById('pi-lmstudio-url').value = lu || 'http://127.0.0.1:1234/v1';
  // Seed the local-provider model selects with the saved value so it stays
  // selected even if the local server is offline. Then refresh in the
  // background to populate the rest of the list.
  _seedLocalModelSelect('ollama', om2 || om || 'llama3.1');
  _seedLocalModelSelect('lmstudio', lm2 || lm || 'local-model');
  refreshLocalModels('ollama').catch(()=>{});
  refreshLocalModels('lmstudio').catch(()=>{});
  refreshOpenRouterModels().catch(()=>{});
  // Hydrate the Response Profile select from the saved value, then update the
  // thinking-mode hint to reflect the current provider/model combo.
  try {
    const savedProfile = (await H.get('responseProfile')) || 'balanced';
    const profSel = document.getElementById('ms-response-profile');
    if (profSel) profSel.value = savedProfile;
  } catch(_) {}
  try { updateThinkingHint(); } catch(_) {}
  try {
    const imageProvider = (await H.get('image.provider')) || 'auto';
    const imageOpenAI = (await H.get('image.model.openai')) || 'gpt-image-2';
    const imageGemini = (await H.get('image.model.gemini')) || 'gemini-2.5-flash-image';
    const setSelect = (id, value) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (value && ![...el.options].some(o => o.value === value)) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value + ' (saved)';
        el.appendChild(opt);
      }
      el.value = value;
    };
    setSelect('ms-image-provider', imageProvider);
    setSelect('ms-image-openai', imageOpenAI);
    setSelect('ms-image-gemini', imageGemini);
  } catch(_) {}
  // Hydrate the Subagent provider/model pickers from persisted settings so
  // the user sees what's currently in effect. Empty subagentProvider →
  // "Same as main agent" (the default option).
  try {
    const subProv = (await H.get('subagentProvider')) || '';
    const provSel = document.getElementById('ms-subagent-provider');
    if (provSel) provSel.value = subProv;
    const modelInput = document.getElementById('ms-subagent-model');
    if (modelInput) {
      modelInput.value = subProv ? ((await H.get(`subagentModel.${subProv}`)) || '') : '';
    }
  } catch(_) {}
  await loadSettingsHealth();
}

// Seed a local-provider <select> with the saved model so it stays selected
// even when the local server is unreachable. Refresh later overlays the
// real model list.
function _seedLocalModelSelect(provider, savedValue){
  const sel = document.getElementById('pi-' + provider + '-model');
  if (!sel) return;
  if (savedValue) {
    try { _modelCache[provider] = savedValue; } catch(_){}
    const opt = document.createElement('option');
    opt.value = savedValue;
    opt.textContent = savedValue + ' (saved)';
    opt.selected = true;
    sel.innerHTML = '';
    sel.appendChild(opt);
  }
}

// ── OpenRouter ───────────────────────────────────────────────────────────────
// OpenRouter exposes 200+ models behind one API key. We fetch its catalog,
// cache it for 24h in settings, and surface a filterable <select> in
// Settings → Models.
var _openrouterAllModels = [];

async function refreshOpenRouterModels(force=false){
  const sel = document.getElementById('ms-openrouter');
  if (!sel) return;
  const previousValue = sel.value || (await H.get('model.openrouter')) || '';
  // Try the cache first. We honour a 24h TTL.
  const cache = await H.get('openrouter.modelsCache').catch(()=>null);
  const cacheAt = await H.get('openrouter.modelsCacheAt').catch(()=>null);
  const cacheFresh = cacheAt && (Date.now() - new Date(cacheAt).getTime() < 24*60*60*1000);
  let models = (cache && cacheFresh && !force) ? cache : null;
  if (!models) {
    const r = await H.openrouterListModels?.().catch(()=>null);
    if (r?.ok && Array.isArray(r.models) && r.models.length) {
      models = r.models;
      await H.set('openrouter.modelsCache', models);
      await H.set('openrouter.modelsCacheAt', new Date().toISOString());
    }
  }
  if (!Array.isArray(models) || !models.length) {
    sel.innerHTML = '<option value="">(no models — check your OpenRouter key)</option>';
    return;
  }
  _openrouterAllModels = models;
  _renderOpenRouterOptions(models, previousValue);
}

function _renderOpenRouterOptions(models, selectedValue){
  const sel = document.getElementById('ms-openrouter');
  if (!sel) return;
  sel.innerHTML = models.map(m => {
    const id = (typeof m === 'string') ? m : m.id;
    const label = (typeof m === 'string') ? m : (m.name ? `${m.id} — ${m.name}` : m.id);
    return `<option value="${id}">${label}</option>`;
  }).join('');
  if (selectedValue) {
    const present = Array.from(sel.options).some(o => o.value === selectedValue);
    if (present) sel.value = selectedValue;
    else {
      const opt = document.createElement('option');
      opt.value = selectedValue;
      opt.textContent = selectedValue + ' (saved, not in catalog)';
      sel.appendChild(opt);
      sel.value = selectedValue;
    }
  }
}

function filterOpenRouterModels(query){
  const q = (query || '').trim().toLowerCase();
  if (!_openrouterAllModels.length) return;
  const filtered = q
    ? _openrouterAllModels.filter(m => {
        const id = (typeof m === 'string') ? m : (m.id || '');
        const name = (typeof m === 'string') ? '' : (m.name || '');
        return id.toLowerCase().includes(q) || name.toLowerCase().includes(q);
      })
    : _openrouterAllModels;
  const sel = document.getElementById('ms-openrouter');
  const current = sel?.value || '';
  _renderOpenRouterOptions(filtered, current);
}

// Pull the live model list from the local server and rebuild the <select>.
// Preserves the currently-saved selection when the server returns it.
async function refreshLocalModels(provider){
  const sel = document.getElementById('pi-' + provider + '-model');
  if (!sel) return;
  const statusEl = document.getElementById('local-' + provider + '-status');
  const previousValue = sel.value;
  try {
    const r = await H.localProviderStatus(provider);
    if (r?.ok && Array.isArray(r.models) && r.models.length) {
      sel.innerHTML = r.models.map(m => `<option value="${m}">${m}</option>`).join('');
      // Preserve selection if the saved model is in the new list. Otherwise
      // append it so the user sees their saved choice even if the server
      // doesn't ship that model anymore.
      if (previousValue && r.models.includes(previousValue)) {
        sel.value = previousValue;
      } else if (previousValue) {
        const opt = document.createElement('option');
        opt.value = previousValue;
        opt.textContent = previousValue + ' (saved, not on server)';
        sel.appendChild(opt);
        sel.value = previousValue;
      }
      try { _modelCache[provider] = sel.value || previousValue; } catch(_){}
      if (statusEl) {
        statusEl.textContent = `Loaded ${r.models.length} model${r.models.length===1?'':'s'} from ${r.url || 'local server'}.`;
        statusEl.className = 'local-status ok';
      }
      return r.models;
    }
    // Server reachable but no models, or not reachable at all.
    if (statusEl) {
      const msg = r?.error || (provider === 'ollama'
        ? 'No models found. Run `ollama pull <name>` then refresh.'
        : 'No models found. Load a model in LM Studio and start the server.');
      statusEl.textContent = msg;
      statusEl.className = 'local-status bad';
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = e.message || 'Failed to refresh model list.';
      statusEl.className = 'local-status bad';
    }
  }
  return [];
}

function setSettingsStatus(text, ok=true){
  const el=document.getElementById('settings-save-status');
  if(!el) return;
  el.textContent=text;
  el.classList.toggle('ok', ok);
  el.classList.toggle('bad', !ok);
}

async function saveSetting(key,value,label=key){
  try{
    await H.set(key,value);
    setSettingsStatus(`${label} saved. It will be restored after restart.`, true);
    await loadSettingsHealth();
    return true;
  }catch(e){
    const msg=e?.message||String(e);
    setSettingsStatus(`Could not save ${label}: ${msg}`, false);
    H.notify?.('Settings save failed', `${label}: ${msg}`);
    return false;
  }
}

async function readSetting(key,fallback=null){
  try{
    const value=await H.get(key);
    return value ?? fallback;
  }catch(_){
    return fallback;
  }
}

async function loadSettingsHealth(){
  const el=document.getElementById('settings-health');
  if(!el || !H.settingsDiagnostics) return;
  try{
    const d=await H.settingsDiagnostics();
    const s=d.saved||{};
    const enabled=[
      s.wakeOn?'Wake':'',
      s.screenWatcher?'Screen AI':'',
      s.searchOn?'Search':'',
      s.ambientOn?'Ambient':'',
      s.notificationsOn?'Notifications':''
    ].filter(Boolean).join(', ') || 'base chat';
    const localModels=[
      s.ollamaModel?`Ollama: ${escHtml(s.ollamaModel)}`:'',
      s.lmStudioModel?`LM Studio: ${escHtml(s.lmStudioModel)}`:''
    ].filter(Boolean).join(' · ') || 'local models not configured';
    el.className='local-status ok';
    el.innerHTML=[
      `<b>Storage OK.</b> ${escHtml(d.settingsPath||d.userDataPath||'Electron userData')}`,
      `Account: ${d.marketplaceUser?escHtml(d.marketplaceUser.email||d.marketplaceUser.display_name||'signed in'):'not signed in'} · Provider: ${escHtml(s.provider||provider||'gemini')} · Mode: ${escHtml(s.mode||mode||'chat')}`,
      `Enabled: ${escHtml(enabled)}`,
      `Local: ${localModels}`,
      s.settingsHealthCheckAt?`Last persistence check: ${escHtml(s.settingsHealthCheckAt)}`:''
    ].filter(Boolean).join('<br>');
  }catch(e){
    el.className='local-status bad';
    el.textContent=`Settings diagnostics failed: ${e?.message||e}`;
  }
}

async function verifySettingsPersistence(){
  const stamp=new Date().toISOString();
  const ok=await saveSetting('settingsHealthCheckAt', stamp, 'Persistence check');
  if(!ok) return;
  const value=await readSetting('settingsHealthCheckAt', '');
  setSettingsStatus(value===stamp?'Persistence verified. Restart will restore saved settings.':'Persistence check did not round-trip.', value===stamp);
  await loadSettingsHealth();
}

async function openSettingsFolder(){
  const r=await H.openSettingsFolder?.().catch(e=>({ok:false,error:e.message}));
  setSettingsStatus(r?.ok?`Opened settings folder: ${r.path}`:`Could not open settings folder: ${r?.error||'unknown error'}`, !!r?.ok);
}
async function savePf(){const n=document.getElementById('pi-name').value.trim();if(!n)return;if(await saveSetting('userName',n,'Name')){userName=n;document.getElementById('tb-sub').textContent=n.toUpperCase();showGreeting();}}

// ═══ Connections — unified OAuth + token entry points ═══
async function connectGoogleFromConnections(){
  try {
    const cid = (await H.get('googleClientId')) || '';
    const cs  = (await H.getKey('google_client_secret')) || '';
    if (!cid || !cs) {
      alert(lang==='ru'
        ? 'Сначала добавь Client ID и Client Secret для Google в секции Google Workspace ниже на странице.'
        : 'Add the Google Client ID + Secret in the Google Workspace section below first.');
      return;
    }
    const r = await H.googleAuth(cid, cs);
    if (r?.ok) {
      _setConnStatus('google', true);
    } else {
      alert((r && r.error) || (lang==='ru'?'Не удалось подключить Google':'Google sign-in failed'));
    }
  } catch(e) { console.warn('connectGoogle:', e?.message); }
}
async function disconnectGoogle(){
  try {
    await H.googleLogout();
    _setConnStatus('google', false);
  } catch(e) { console.warn('disconnectGoogle:', e?.message); }
}
async function connectGithub(){
  try {
    const inp = document.getElementById('pi-github-conn');
    const v = (inp?.value || '').trim();
    if (!v) return;
    await H.saveKey('github', v);
    _setConnStatus('github', true);
    inp.value = '';
    inp.placeholder = '••••••••••';
  } catch(e) { console.warn('connectGithub:', e?.message); }
}
const TOKEN_CONNECTION_IDS = ['slack','notion','linear','telegram_bot'];
function _connectionLabel(id){
  return ({slack:'Slack',notion:'Notion',linear:'Linear',telegram_bot:'Telegram Bot'})[id] || id;
}
async function loadTokenConnections(){
  for (const id of TOKEN_CONNECTION_IDS) {
    try {
      const has = await H.hasKey(id);
      _setConnStatus(id, !!has);
      const inp = document.getElementById('pi-' + id + '-conn');
      if (inp && has) inp.placeholder = '••••••••••';
    } catch (_) { _setConnStatus(id, false); }
  }
  try {
    const r = await H.connectionsList?.();
    if (r?.ok) {
      for (const c of r.connections || []) _setConnStatus(c.id, !!c.connected);
    }
  } catch (_) {}
  loadTelegramAllowedUsers().catch(()=>{});
  refreshTelegramRuntimeStatus().catch(()=>{});
}
async function saveTokenConnection(id){
  try {
    const inp = document.getElementById('pi-' + id + '-conn');
    const v = (inp?.value || '').trim();
    if (!v) return;
    await H.saveKey(id, v);
    if (inp) { inp.value = ''; inp.placeholder = '••••••••••'; }
    _setConnStatus(id, true);
    if (id === 'telegram_bot') refreshTelegramRuntimeStatus().catch(()=>{});
  } catch(e) {
    const st = document.getElementById('conn-' + id + '-status');
    if (st) st.textContent = e?.message || ('Could not save ' + _connectionLabel(id));
  }
}
async function testTokenConnection(id){
  const st = document.getElementById('conn-' + id + '-status');
  if (st) st.textContent = 'Testing ' + _connectionLabel(id) + '...';
  try {
    const r = await H.connectionsTest(id);
    if (st) {
      st.textContent = r?.ok
        ? (_connectionLabel(id) + ' connected. Tools are available to Agent mode.')
        : (r?.error || r?.err || _connectionLabel(id) + ' test failed.');
      st.classList.toggle('bad', !r?.ok);
      st.classList.toggle('ok', !!r?.ok);
    }
    _setConnStatus(id, !!r?.ok);
  } catch(e) {
    if (st) { st.textContent = e?.message || 'Connection test failed.'; st.classList.add('bad'); }
  }
}
function _setConnStatus(svc, connected){
  try {
    const dot = document.getElementById('pd-' + svc + '-conn');
    const st  = document.getElementById('conn-' + svc + '-status');
    if (dot) dot.classList.toggle('on', !!connected);
    if (st)  st.textContent = connected
      ? (lang==='ru' ? 'Подключено.' : 'Connected.')
      : (svc === 'google'
          ? (lang==='ru'?'Не подключено.':'Not connected.')
          : (lang==='ru'?'Не сохранено.':'Not saved.'));
    if (svc === 'google') {
      const btn = document.getElementById('conn-google-btn');
      const dis = document.getElementById('conn-google-disc');
      if (btn) btn.style.display = connected ? 'none' : '';
      if (dis) dis.style.display = connected ? '' : 'none';
    }
  } catch(_){}
}

function _parseTelegramAllowedUsers(value) {
  return [...new Set(String(value || '')
    .split(/[,\s]+/)
    .map(v => v.trim())
    .filter(v => /^\d+$/.test(v)))];
}

async function loadTelegramAllowedUsers() {
  const inp = document.getElementById('pi-telegram-owner-ids');
  const st = document.getElementById('telegram-owner-status');
  let ids = [];
  try {
    const raw = await H.get?.('connection.telegram_bot.allowed_user_ids');
    ids = Array.isArray(raw) ? raw.map(v => String(v || '').trim()).filter(Boolean) : _parseTelegramAllowedUsers(raw);
  } catch (_) {}
  if (inp) inp.value = ids.join(', ');
  if (st) {
    st.textContent = ids.length
      ? `Telegram access active: ${ids.length} user ID${ids.length === 1 ? '' : 's'} allowed.`
      : 'Locked: no Telegram user IDs are allowed yet. Send /start to the bot and it will reply with your Telegram user ID.';
    st.classList.toggle('ok', ids.length > 0);
    st.classList.toggle('bad', ids.length === 0);
  }
  return ids;
}

async function saveTelegramAllowedUsers() {
  const inp = document.getElementById('pi-telegram-owner-ids');
  const st = document.getElementById('telegram-owner-status');
  const ids = _parseTelegramAllowedUsers(inp?.value || '');
  try {
    await H.set?.('connection.telegram_bot.allowed_user_ids', ids);
    await loadTelegramAllowedUsers();
    await refreshTelegramRuntimeStatus();
  } catch(e) {
    if (st) {
      st.textContent = e?.message || 'Could not save Telegram user IDs.';
      st.classList.add('bad');
    }
  }
}

function _renderTelegramRuntimeStatus(status) {
  const st = document.getElementById('telegram-live-status');
  const btn = document.getElementById('telegram-live-toggle');
  const log = document.getElementById('telegram-live-log');
  if (btn) btn.textContent = status?.enabled ? (status.running ? 'Stop live bot' : 'Disable live bot') : 'Start live bot';
  if (st) {
    const parts = [];
    if (!status?.connected) parts.push('Token is not saved.');
    else if (status?.running && status?.locked) parts.push('Live bot is online but locked. /start replies with the sender user ID; other messages do not call AI.');
    else if (status?.running) parts.push(`Live bot is online. Replies are limited to ${status?.allowedUserIds?.length || 0} allowed Telegram user ID(s).`);
    else if (status?.enabled) parts.push('Live bot is enabled but not running. Check token/model keys and press Refresh.');
    else parts.push('Live bot is off. Start it to make Telegram messages wake Horizon and receive replies.');
    if (status?.connected && status?.locked) parts.push('Add your Telegram user ID above before expecting replies.');
    if (status?.lastError) parts.push('Last error: ' + status.lastError);
    if (status?.lastEventAt) parts.push('Last event: ' + new Date(status.lastEventAt).toLocaleString());
    st.textContent = parts.join(' ');
    st.classList.toggle('ok', !!status?.running);
    st.classList.toggle('bad', !!status?.lastError);
  }
  if (log) {
    const rows = Array.isArray(status?.logs) ? status.logs.slice(-8).reverse() : [];
    log.innerHTML = rows.length
      ? rows.map(x => `<div>[${_escHtml((x.time || '').replace('T',' ').replace('Z',''))}] ${_escHtml(x.type || 'info')}: ${_escHtml(x.message || '')}</div>`).join('')
      : '<div>No Telegram runtime events yet.</div>';
  }
}

async function refreshTelegramRuntimeStatus(){
  try {
    const r = await H.connectionsRuntimeStatus?.('telegram_bot');
    _renderTelegramRuntimeStatus(r || {});
    return r;
  } catch(e) {
    _renderTelegramRuntimeStatus({ ok:false, lastError: e?.message || String(e) });
    return null;
  }
}

async function toggleTelegramLive(){
  const current = await refreshTelegramRuntimeStatus();
  const next = !current?.enabled;
  const st = document.getElementById('telegram-live-status');
  if (st) st.textContent = next ? 'Starting Telegram live bot...' : 'Stopping Telegram live bot...';
  try {
    const r = await H.connectionsSetLive?.('telegram_bot', next);
    _renderTelegramRuntimeStatus(r || {});
    if (r && r.ok === false && st) st.textContent = r.error || 'Could not change Telegram live bot state.';
  } catch(e) {
    if (st) st.textContent = e?.message || 'Could not change Telegram live bot state.';
  }
}

window.saveTelegramAllowedUsers = saveTelegramAllowedUsers;
window.loadTelegramAllowedUsers = loadTelegramAllowedUsers;

try {
  H.onConnectionsUpdated?.((payload) => {
    const tg = (payload?.connections || []).find(c => c.id === 'telegram_bot');
    if (tg) refreshTelegramRuntimeStatus().catch(()=>{});
  });
} catch(_) {}

// Profile for response generation (fast/balanced/deep)
async function saveResponseProfile(profile){
  try {
    await H.set('responseProfile', profile);
  } catch(e) { console.warn('saveResponseProfile failed:', e?.message); }
}

// Provider/model combos that actually honour the responseProfile flag.
// Mirrors the logic in main.js around the Claude/OpenAI/Gemini switch arms.
function _profileSupportsThinking(provider, model){
  if (!provider) return false;
  if (provider === 'claude') return true; // budget_tokens works on every modern Claude.
  if (provider === 'openai') return /^o[134]/.test(model || '') || /thinking|reasoning/.test(model || '');
  if (provider === 'gemini') return /^gemini-(2\.5|3)/.test(model || '');
  return false;
}

function updateThinkingHint(){
  const el = document.getElementById('thinking-hint');
  if (!el) return;
  const profile = document.getElementById('ms-response-profile')?.value || 'balanced';
  const sel = document.getElementById('ms-' + (typeof prov !== 'undefined' ? prov : ''));
  const model = sel?.value || '';
  const supported = _profileSupportsThinking(typeof prov !== 'undefined' ? prov : '', model);
  el.classList.remove('ok','bad');
  if (profile !== 'deep') {
    el.textContent = 'Deep mode uses provider-native reasoning/thinking only when the selected model supports it.';
    return;
  }
  if (supported) {
    el.textContent = `🧠 Deep mode active for ${prov}${model ? ' / ' + model : ''} — extended thinking will be enabled on the next request.`;
    el.classList.add('ok');
  } else {
    el.textContent = `Deep mode is selected, but ${prov || 'this provider'} does not expose a thinking parameter — request will run on default settings.`;
    el.classList.add('bad');
  }
}

// Per-provider model selection (Settings → Models). Persists to electron
// settingsStore under "model.<provider>" keys; main.js H.ai handlers read
// the same keys, so the next request goes to the picked model.
async function saveModelSetting(provider, model){
  try {
    await H.set('model.' + provider, model);
    // Special case: gemini uses a separate global also read by autoNameChat.
    if (provider === 'gemini') { geminiModel = model; await H.set('geminiModel', model); }
    // Mirror into the renderer-side cache the send path reads from. Without
    // this, the chat-status-bar model picker (csb-model click → pickModel)
    // would write to settingsStore but the next `aiOptsForProvider()` call
    // would still see the stale Settings-panel `<select>` value (which only
    // reflects edits made INSIDE the Settings panel, not from the popover).
    try { _modelCache[provider] = model; } catch(_){}
    // Also push the value back into the Settings panel's <select> so the
    // dropdown reflects the picker choice if the user opens Settings next.
    try {
      const sel = document.getElementById('ms-' + provider);
      if (sel && sel.value !== model) {
        const has = [...sel.options].some(o => o.value === model);
        if (!has) {
          const opt = document.createElement('option');
          opt.value = model; opt.textContent = model;
          sel.appendChild(opt);
        }
        sel.value = model;
      }
    } catch(_){}
    // Refresh the chat status-bar pill if the active provider matches.
    // Element was removed in PR-U-MEGA — guard defensively.
    if (typeof prov !== 'undefined' && prov === provider) {
      const cm = document.getElementById('csb-model');
      if (cm) { try { cm.textContent = model; } catch(_){} }
    }
    // PR-LAYOUT-V2 — composer chip text was stale after model selection
    // because updateShellChrome wasn't being called from this path.
    // Pickers in the composer-toolbar read their value from the chip
    // text, so without this call switching model didn't visibly update
    // anything → user thought "models can't be selected".
    try { updateThinkingHint(); updateStatusBar(); renderCodeContext(); updateShellChrome(); } catch(_){}
  } catch(e) { console.warn('saveModelSetting failed:', e?.message); }
}

async function saveSubagentProvider(value) {
  // Empty string = "same as main agent"; non-empty = override. Backend
  // (spawnSubagent in main.js) falls back to the main provider when this
  // setting is empty, so an empty value is a valid saved state.
  try {
    const safeValue = String(value || '').trim();
    await H.set('subagentProvider', safeValue);
    // Pre-fill the model textbox with whatever's already saved for that
    // provider's main model so the user can see/edit it as a starting point.
    try {
      const modelInput = document.getElementById('ms-subagent-model');
      if (modelInput && safeValue) {
        const existing = await H.get(`subagentModel.${safeValue}`).catch(() => '');
        modelInput.value = existing || '';
      }
    } catch (_) {}
  } catch (e) { console.warn('saveSubagentProvider failed:', e?.message); }
}

async function saveSubagentModel(value) {
  // Saved as `subagentModel.<provider>` so each provider can have its own
  // preferred subagent model. If the user hasn't picked a subagent
  // provider yet, this is a no-op (key would be invalid).
  try {
    const provider = String((await H.get('subagentProvider').catch(() => '')) || '').trim();
    if (!provider) return; // No-op until provider is chosen
    const safeValue = String(value || '').trim();
    await H.set(`subagentModel.${provider}`, safeValue);
  } catch (e) { console.warn('saveSubagentModel failed:', e?.message); }
}

async function saveImageGenerationSetting(key, value){
  try {
    const safeKey = String(key || '');
    if (!['provider', 'model.openai', 'model.gemini'].includes(safeKey)) return;
    const safeValue = String(value || '').trim();
    await H.set('image.' + safeKey, safeValue);
    setSettingsStatus('Image generation setting saved.', true);
    H.notify?.('Image generation', 'Model selection saved.');
  } catch(e) {
    console.warn('saveImageGenerationSetting failed:', e?.message);
    setSettingsStatus(`Could not save image setting: ${e?.message || e}`, false);
  }
}

async function saveLang(){const next=document.getElementById('pi-lang').value;if(await saveSetting('lang',next,'Language')){lang=next;applyLang();showGreeting();}}
async function saveVP(){
  voiceProvider=document.getElementById('pi-vprov').value;
  await saveSetting('voiceProvider',voiceProvider,'Voice provider');
  const dg=document.getElementById('deepgram-section');
  if(dg) dg.style.display=(voiceProvider==='deepgram')?'block':'none';
}
async function saveLocalProvider(kind){
  let selectedModel = '';
  if(kind==='ollama'){
    await saveSetting('ollamaUrl', document.getElementById('pi-ollama-url').value.trim() || 'http://127.0.0.1:11434/v1','Ollama URL');
    selectedModel = document.getElementById('pi-ollama-model').value.trim() || 'llama3.1';
    await saveSetting('ollamaModel', selectedModel,'Ollama model');
    document.getElementById('pd-ollama')?.classList.add('on');
  }
  if(kind==='lmstudio'){
    await saveSetting('lmStudioUrl', document.getElementById('pi-lmstudio-url').value.trim() || 'http://127.0.0.1:1234/v1','LM Studio URL');
    selectedModel = document.getElementById('pi-lmstudio-model').value.trim() || 'local-model';
    await saveSetting('lmStudioModel', selectedModel,'LM Studio model');
    document.getElementById('pd-lmstudio')?.classList.add('on');
  }
  if (selectedModel) {
    try { await H.set('model.' + kind, selectedModel); } catch(e) { console.warn('save local model setting failed:', e?.message); }
    try { _modelCache[kind] = selectedModel; } catch(_){}
    if (typeof prov !== 'undefined' && prov === kind) {
      // csb-model was removed in PR-U-MEGA; updateStatusBar() handles
      // any surviving status bar elements safely.
      // PR-LAYOUT-V2 — also refresh the composer-toolbar chip so users
      // see the local model name they just selected.
      try { updateStatusBar(); updateShellChrome(); } catch(_){}
    }
  }
  H.notify?.('Local models', 'Saved local provider settings.');
}

async function testLocalProvider(kind){
  await saveLocalProvider(kind);
  const id = kind === 'ollama' ? 'local-ollama-status' : 'local-lmstudio-status';
  const el = document.getElementById(id);
  if (el) {
    el.textContent = 'Testing local server...';
    el.className = 'local-status';
  }
  try {
    const r = await H.localProviderStatus(kind);
    if (r?.ok) {
      const models = (r.models || []).slice(0, 4).join(', ');
      if (el) {
        el.textContent = models ? `Connected. Models: ${models}` : 'Connected. No model list returned yet.';
        el.classList.add('ok');
      }
      H.notify?.('Local models', `${kind === 'ollama' ? 'Ollama' : 'LM Studio'} is reachable.`);
      return;
    }
    if (el) {
      el.textContent = r?.error || 'Local server is not reachable yet.';
      el.classList.add('bad');
    }
    if (r?.installUrl) H.openUrl?.(r.installUrl);
  } catch (e) {
    if (el) {
      el.textContent = e.message || 'Local server test failed.';
      el.classList.add('bad');
    }
  }
}

async function saveTTSProv(){
  ttsProvider=document.getElementById('pi-ttsprov').value;
  await saveSetting('ttsProvider',ttsProvider,'TTS provider');
  document.getElementById('el-section').style.display=(ttsProvider==='elevenlabs')?'block':'none';
  document.getElementById('oaitts-section').style.display=(ttsProvider==='openai')?'block':'none';
  document.getElementById('kokoro-section').style.display=(ttsProvider==='kokoro')?'block':'none';
  if(ttsProvider==='kokoro') loadKokoro();
}
async function saveElVoice(){
  elevenLabsVoice=document.getElementById('pi-elvid').value.trim()||'pNInz6obpgDQGcFmaJgB';
  await saveSetting('elevenLabsVoice',elevenLabsVoice,'ElevenLabs voice');
}
async function saveOAITTSVoice(){
  openaiTtsVoice=document.getElementById('pi-oaitts').value;
  await saveSetting('openaiTtsVoice',openaiTtsVoice,'OpenAI TTS voice');
}
function loadKokoro(){
  if(typeof window.KokoroTTS !== 'undefined') return;
  const s=document.createElement('script');
  s.src='https://cdn.jsdelivr.net/npm/kokoro-js@latest/dist/kokoro.web.js';
  document.head.appendChild(s);
}
async function psvk(svc,iid,bid,did){const v=document.getElementById(iid).value.trim();if(!v)return;await H.saveKey(svc,v);const btn=document.getElementById(bid);btn.textContent='✓';btn.classList.add('ok');document.getElementById(did)?.classList.add('on');document.getElementById(iid).value='';document.getElementById(iid).placeholder='••••••••••';setTimeout(()=>{btn.textContent='Save';btn.classList.remove('ok');},2000);}

