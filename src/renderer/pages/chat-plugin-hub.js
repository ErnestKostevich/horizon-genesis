// PR-V Phase 3.7 — Plugin Hub module.
// Extracted from chat.html inline <script> (was lines 5245-5529).
//
// Plugin Hub UI: lists installed plugins, lets user toggle/share/
// remove them, opens per-plugin settings panels with credentials,
// runs plugin tools interactively, and supports creating a plugin
// from a form or installing from a URL.
//
// State: hubCurrentTab, hubPluginsCache
// Fns:
//   openHub, closeHub, hubTab, renderHubBody
//   togglePlugin, execPluginTool, execPluginToolInteractive
//   sharePlugin, removePlugin
//   openPluginSettings, savePluginSettings, runPluginActionFromSettings
//   createPluginFromForm, installFromUrl
//
// Loaded as external script AFTER main inline so window.* globals it
// reads (H plugin IPC, addMsg, lang, customConfirm, etc.) are defined.

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// PLUGIN HUB
// ═══════════════════════════════════════════════════════════════
var hubCurrentTab = 'installed';
var hubPluginsCache = [];

function openHub() {
  setActiveSurface('plugins', { keepPanels:['hub-panel'] });
  document.getElementById('hub-panel').classList.add('show');
  hubTab('installed');
}
function closeHub() {
  document.getElementById('hub-panel').classList.remove('show');
  if (isSurfaceActive('plugins')) closeActiveSurface();
}
function hubTab(tab) {
  hubCurrentTab = tab;
  ['installed','create','import'].forEach(t => {
    document.getElementById(`hub-tab-${t}`)?.classList.toggle('on', t === tab);
  });
  renderHubBody();
}

async function renderHubBody() {
  const body = document.getElementById('hub-body');
  if (hubCurrentTab === 'installed') {
    // Sprint 4 — Task 4: skeleton rows while H.pluginList() resolves.
    body.innerHTML = (typeof hzSkelRows === 'function')
      ? hzSkelRows(4, { height: 56, gap: 12 })
      : '<div style="color:var(--t3);font-size:11px;margin-bottom:12px">Loading plugins...</div>';
    try {
      const plugins = await H.pluginList();
      hubPluginsCache = plugins;
      if (!plugins.length) {
        body.innerHTML = `<div class="empty-state"><div class="es-icon"><svg class="licon lg"><use href="#i-puzzle"/></svg></div><h3>No plugins installed</h3><p>Go to Marketplace to discover and install plugins, or create your own.</p><button class="sc-btn primary" onclick="openStore()">Browse Marketplace</button></div>`;
        return;
      }
      body.innerHTML = plugins.map(p => `
        <div class="hub-plugin">
          <div class="hub-plugin-head">
            <div class="hub-plugin-icon">${pluginIcon(p.icon)}</div>
            <div class="hub-plugin-info">
              <div class="hub-plugin-name">${p.name} <span style="font-size:9px;color:var(--t3);font-weight:400">v${p.version}</span></div>
              <div class="hub-plugin-meta">${p.author || 'Community'} · ${(p.toolList||p.tools||[]).length || p.tools || 0} tools</div>
            </div>
            <div class="sw ${p.enabled !== false ? 'on' : ''}" onclick="togglePlugin('${p.id}',this)" title="Enable/Disable"></div>
          </div>
          <div class="hub-plugin-tools">
            ${(p.toolList || (Array.isArray(p.tools) ? p.tools : [])).map(t => `<div class="hub-tool" onclick="execPluginToolInteractive('${p.id}','${t.name}')" title="${t.description||''}"><svg class="licon" style="vertical-align:-2px"><use href="#i-play"/></svg> ${t.name}</div>`).join('')}
          </div>
          <div class="hub-plugin-footer">
            <div style="font-size:10px;color:var(--t3)">${p.description||''}</div>
            <div class="hub-actions">
              ${(p.settings && p.settings.length) ? `<button class="hub-btn" onclick="openPluginSettings('${p.id}')"><svg class="licon" style="vertical-align:-2px"><use href="#i-settings"/></svg> Settings</button>` : ''}
              <button class="hub-btn share" onclick="sharePlugin('${p.id}')">Share URL</button>
              <button class="hub-btn remove" onclick="removePlugin('${p.id}')">Remove</button>
            </div>
          </div>
        </div>
      `).join('');
    } catch(e) {
      body.innerHTML = `<div class="empty-state"><div class="es-icon"><svg class="licon lg"><use href="#i-x"/></svg></div><h3>Couldn't load plugins</h3><p>${(e.message || String(e)).replace(/[<>]/g,'')}</p><button class="sc-btn" onclick="renderHubBody()">Try again</button></div>`;
    }
  } else if (hubCurrentTab === 'create') {
    body.innerHTML = `
      <div class="wf-create">
        <h3 style="display:flex;align-items:center;gap:6px"><svg class="licon"><use href="#i-plus"/></svg> Create Custom Plugin</h3>
        <div class="wf-field"><label>Plugin Name</label><input class="wf-input" id="cp-name" placeholder="My Awesome Plugin"/></div>
        <div class="wf-field"><label>Description</label><input class="wf-input" id="cp-desc" placeholder="What does this plugin do?"/></div>
        <div class="wf-field"><label>Icon (emoji)</label><input class="wf-input" id="cp-icon" placeholder="🧩" style="width:80px"/></div>
        <div class="wf-field">
          <label>Tools (JSON array)</label>
          <textarea class="wf-textarea" id="cp-tools" style="min-height:120px" placeholder='[{"name":"my_tool","description":"Does something","action":"notify","args":{"message":"Hello from plugin!"}}]'></textarea>
        </div>
        <button class="wf-ai-btn" onclick="createPluginFromForm()">Create Plugin</button>
        <div style="font-size:10px;color:var(--t3);margin-top:8px">Tool actions: notify, open_url, run_code, speak, send_message, type_text, press_key, wait</div>
      </div>
    `;
  } else if (hubCurrentTab === 'import') {
    body.innerHTML = `
      <div class="url-install">
        <label>Install plugin from share URL</label>
        <div class="url-install-row">
          <input class="url-install-input" id="url-install-input" placeholder="horizon://plugin/..."/>
          <button class="url-install-btn" onclick="installFromUrl()">Install</button>
        </div>
      </div>
      <div style="font-size:11px;color:var(--t3);margin-top:8px">Share URLs look like: <code style="color:var(--acc);font-size:10px">horizon://plugin/base64data</code></div>
    `;
  }
}

async function togglePlugin(id, sw) {
  try {
    const r = await H.pluginToggle(id);
    if (r.ok) sw.classList.toggle('on', r.enabled);
  } catch(_) {}
}

async function execPluginTool(pluginId, toolName, args = {}) {
  try {
    const r = await H.pluginExecTool(pluginId, toolName, args);
    if (r && r.ok) {
      let payload = '';
      const data = r.data ?? r.result ?? r;
      if (data && typeof data === 'object') {
        const clean = { ...data };
        delete clean.ok;
        if (typeof clean.out === 'string' && clean.out) payload = '\n' + clean.out;
        else if (typeof clean.error === 'string' && clean.error) payload = '\n' + clean.error;
        else {
        const keys = Object.keys(clean);
        if (keys.length) {
          try { payload = '\n```\n' + JSON.stringify(clean, null, 2).slice(0, 800) + '\n```'; } catch (_) {}
        }
        }
      } else if (typeof data === 'string' && data) {
        payload = '\n' + data;
      }
      addMsg('bot', `Plugin executed: **${toolName}**` + payload);
    } else {
      addMsg('bot', `Plugin error: ${(r && r.error) || 'unknown'}`);
    }
  } catch(e) { addMsg('bot', `Plugin error: ${e.message}`); }
}

async function execPluginToolInteractive(pluginId, toolName) {
  try {
    let plugins = hubPluginsCache || [];
    if (!plugins.length) plugins = await H.pluginList();
    const plugin = plugins.find(p => p.id === pluginId);
    const tool = (plugin?.toolList || plugin?.tools || []).find(t => t.name === toolName) || {};
    const spec = tool.params || tool.schema || {};
    const args = {};
    const entries = Array.isArray(spec)
      ? spec.map(name => [name, 'string'])
      : Object.entries(spec);
    for (const [name, kind] of entries) {
      const hint = typeof kind === 'string' ? kind : (kind?.description || kind?.type || 'value');
      const value = await customPrompt(`${plugin?.name || pluginId} / ${toolName} - ${name} (${hint})`, '');
      if (value == null) return;
      const trimmed = String(value).trim();
      if (!trimmed) continue;
      if (/number|integer|float/i.test(String(hint))) args[name] = Number(trimmed);
      else if (/boolean|bool/i.test(String(hint))) args[name] = /^(true|1|yes|y)$/i.test(trimmed);
      else {
        try { args[name] = /^[\[{]/.test(trimmed) ? JSON.parse(trimmed) : trimmed; }
        catch(_) { args[name] = trimmed; }
      }
    }
    await execPluginTool(pluginId, toolName, args);
  } catch (e) {
    addMsg('bot', `Plugin error: ${e.message}`);
  }
}

async function sharePlugin(id) {
  try {
    const url = await H.pluginShareUrl(id);
    if (url) {
      await H.copy(url);
      H.notify('Plugin Hub', 'Share URL copied to clipboard!');
      addMsg('bot', `\u{1F517} Share URL copied!\n\`${url.slice(0,60)}...\``);
    }
  } catch(e) { addMsg('bot', `⚠️ ${e.message}`); }
}

async function removePlugin(id) {
  try {
    await H.pluginUninstall(id);
    if (document.getElementById('hub-panel')?.classList.contains('show')) renderHubBody();
    if (document.getElementById('store-panel')?.classList.contains('show')) renderStoreBody();
    H.notify('Plugin Hub', 'Plugin removed');
  } catch(_) {}
}

// --- Plugin settings modal (used for Spotify Client ID, etc.) ---------------
async function openPluginSettings(pluginId) {
  const plugins = await H.pluginList();
  const p = plugins.find(x => x.id === pluginId);
  if (!p) return;
  const settings = p.settings || [];
  const cfg = p.config || {};
  if (!settings.length) { H.notify?.('Plugin', 'No settings for this plugin'); return; }

  let host = document.getElementById('plugin-settings-modal');
  if (!host) {
    host = document.createElement('div');
    host.id = 'plugin-settings-modal';
    host.className = 'cmd-palette';
    host.style.alignItems = 'center';
    host.onclick = (e) => { if (e.target === host) host.classList.remove('show'); };
    document.body.appendChild(host);
  }
  const actionToolNames = (p.toolList || []).map(t => t.name).filter(n => /^(connect|authorize|auth|login|disconnect|status)$/i.test(n));
  host.innerHTML = `
    <div class="cmd-box" style="width:460px;max-width:92vw">
      <div style="padding:18px 20px 12px;border-bottom:1px solid var(--b1);display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:32px;height:32px;border-radius:8px;background:var(--acc3);display:flex;align-items:center;justify-content:center;font-size:16px">${pluginIcon(p.icon)}</div>
          <div><div style="font-size:13px;font-weight:700;color:var(--tx)">${p.name}</div><div style="font-size:10px;color:var(--t3)">Settings</div></div>
        </div>
        <button class="fph-x" onclick="document.getElementById('plugin-settings-modal').classList.remove('show')" aria-label="Close"><svg class="licon"><use href="#i-x"/></svg></button>
      </div>
      <div style="padding:16px 20px;max-height:60vh;overflow-y:auto">
        <div id="plugin-settings-err" style="display:none" class="auth-err"></div>
        ${settings.map(s => `
          <div class="auth-field">
            <label>${s.label || s.key}${s.required ? ' <span style="color:var(--red)">*</span>' : ''}</label>
            <input id="ps-${s.key}" type="${s.type === 'password' ? 'password' : 'text'}"
              value="${(cfg[s.key] ?? '').toString().replace(/"/g,'&quot;')}"
              placeholder="${(s.placeholder || '').replace(/"/g,'&quot;')}"/>
            ${s.hint ? `<div style="font-size:10px;color:var(--t3);margin-top:4px;line-height:1.5">${s.hint}</div>` : ''}
          </div>
        `).join('')}
      </div>
      <div style="padding:12px 20px;border-top:1px solid var(--b1);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
        ${actionToolNames.map(n => `<button class="sc-btn" onclick="runPluginActionFromSettings('${p.id}','${n}')">${n === 'connect' || n === 'authorize' || n === 'auth' || n === 'login' ? '\u{1F517} ' + n.charAt(0).toUpperCase()+n.slice(1) : n}</button>`).join('')}
        <button class="sc-btn primary" onclick="savePluginSettings('${p.id}')">Save</button>
      </div>
    </div>
  `;
  host.classList.add('show');
}

async function savePluginSettings(pluginId) {
  const plugins = await H.pluginList();
  const p = plugins.find(x => x.id === pluginId);
  if (!p) return;
  const cfg = {};
  (p.settings || []).forEach(s => {
    const el = document.getElementById('ps-' + s.key);
    if (el) cfg[s.key] = el.value.trim();
  });
  for (const s of (p.settings || [])) {
    if (s.required && !cfg[s.key]) {
      const err = document.getElementById('plugin-settings-err');
      if (err) { err.textContent = `${s.label || s.key} is required.`; err.style.display = 'block'; }
      return;
    }
  }
  const r = await H.pluginSetConfig(pluginId, cfg);
  if (r.ok) {
    H.notify?.('Plugin', 'Settings saved');
    document.getElementById('plugin-settings-modal')?.classList.remove('show');
    renderHubBody();
  } else {
    const err = document.getElementById('plugin-settings-err');
    if (err) { err.textContent = r.error || 'Could not save'; err.style.display = 'block'; }
  }
}

async function runPluginActionFromSettings(pluginId, toolName) {
  // Persist current form values first, then run (e.g. "connect")
  await savePluginSettings(pluginId);
  await execPluginTool(pluginId, toolName);
}

async function createPluginFromForm() {
  const name = document.getElementById('cp-name').value.trim();
  const desc = document.getElementById('cp-desc').value.trim();
  const icon = document.getElementById('cp-icon').value.trim() || '🧩';
  const toolsRaw = document.getElementById('cp-tools').value.trim();
  if (!name) { H.notify('Plugin Hub', 'Plugin name required'); return; }
  let tools = [];
  try { tools = JSON.parse(toolsRaw || '[]'); } catch(e) { H.notify('Plugin Hub', 'Invalid JSON in tools'); return; }
  const plugin = { id: 'custom_' + Date.now(), name, description: desc, icon, version: '1.0.0', author: userName, tier: 'local', permissions: ['local:actions'], tools };
  try {
    const r = await H.pluginInstall(plugin);
    if (r.ok) {
      addMsg('bot', lang === 'ru' ? `🧩 Плагин **${name}** создан!` : `🧩 Plugin **${name}** created!`);
      hubTab('installed');
    } else { H.notify('Plugin Hub', r.error); }
  } catch(e) { H.notify('Plugin Hub', e.message); }
}

async function installFromUrl() {
  const url = document.getElementById('url-install-input').value.trim();
  if (!url) return;
  try {
    const r = await H.pluginInstallFromUrl(url);
    if (r.ok) {
      addMsg('bot', lang === 'ru' ? `🧩 Плагин **${r.name}** установлен!` : `🧩 Plugin **${r.name}** installed!`);
      hubTab('installed');
    } else { H.notify('Plugin Hub', r.error); }
  } catch(e) { H.notify('Plugin Hub', e.message); }
}

// Sprint 2.8 — sandbox-proof inline onclick exposure.
if (typeof window !== 'undefined') {
  ['openHub','closeHub','hubTab'].forEach(function (n) {
    try {
      var fn = eval('typeof ' + n + " === 'function' ? " + n + ' : null');
      if (fn) window[n] = fn;
    } catch (_) {}
  });
}

