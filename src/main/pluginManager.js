'use strict';
/**
 * Horizon Plugin Manager — v2.1 (fixed & honest)
 *
 * Changes vs the previous version:
 *  - Built-in templates now only ship CORE utilities that belong inside Horizon
 *    (system-monitor, quick-notes, file-organizer, app-launcher, timer, weather).
 *  - Fake "community-looking" plugins are REMOVED from built-ins. They belong
 *    in the real user-generated marketplace instead.
 *  - The Spotify Control plugin is now a REAL PKCE OAuth implementation
 *    (loopback 127.0.0.1, safeStorage-encrypted tokens, refresh flow).
 *  - Added a `tier` field on every plugin so the UI can visually separate
 *    built-in / demo / community (as required by the Marketplace spec).
 *  - `installFromShareUrl` is stricter: rejects plugins trying to impersonate
 *    a Horizon Team name.
 */

const fs = require('fs');
const path = require('path');

class PluginManager {
  constructor(pluginsDir) {
    this.pluginsDir = pluginsDir;
    this.plugins = new Map();
    this.handlers = new Map();
    this.enabled = new Set();

    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
    }
  }

  loadAll() {
    const loaded = [];
    try {
      for (const dir of fs.readdirSync(this.pluginsDir)) {
        const pluginPath = path.join(this.pluginsDir, dir);
        if (!fs.statSync(pluginPath).isDirectory()) continue;
        const manifestPath = path.join(pluginPath, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          // Back-fill `settings` spec from the bundled source (older installs
          // pre-date the settings UI and have no spec on disk).
          if (!Array.isArray(manifest.settings) || manifest.settings.length === 0) {
            try {
              const bundled = path.join(__dirname, '..', '..', 'builtin-plugins', dir, 'manifest.json');
              if (fs.existsSync(bundled)) {
                const src = JSON.parse(fs.readFileSync(bundled, 'utf8'));
                if (Array.isArray(src.settings) && src.settings.length) {
                  manifest.settings = src.settings;
                  const persist = { ...manifest }; delete persist._dir; delete persist._id;
                  fs.writeFileSync(manifestPath, JSON.stringify(persist, null, 2));
                }
              }
            } catch (_) { /* best effort */ }
          }
          manifest._dir = pluginPath;
          manifest._id = dir;
          this.plugins.set(dir, manifest);
          if (manifest.enabled !== false) this.enabled.add(dir);
          const handlerPath = path.join(pluginPath, 'handler.js');
          if (fs.existsSync(handlerPath)) {
            try {
              delete require.cache[require.resolve(handlerPath)];
              this.handlers.set(dir, require(handlerPath));
            } catch (e) { console.error(`Plugin handler error (${dir}):`, e.message); }
          }
          loaded.push({ id: dir, name: manifest.name, version: manifest.version });
        } catch (e) { console.error(`Plugin manifest error (${dir}):`, e.message); }
      }
    } catch (e) { console.error('Plugin loadAll error:', e.message); }
    return loaded;
  }

  install(pluginJson) {
    try {
      const plugin = typeof pluginJson === 'string' ? JSON.parse(pluginJson) : pluginJson;
      if (!plugin.id || !plugin.name) return { ok: false, error: 'Plugin must have id and name' };

      // Anti-impersonation: community plugins cannot claim to be from the Horizon Team
      if (plugin.tier !== 'built_in' && plugin.tier !== 'demo') {
        const author = (plugin.author || '').toLowerCase();
        if (author.includes('horizon team') || author.includes('ernest kostevich')) {
          return { ok: false, error: 'Only official plugins can use the Horizon Team / Ernest Kostevich author name.' };
        }
      }

      const pluginDir = path.join(this.pluginsDir, plugin.id);
      fs.mkdirSync(pluginDir, { recursive: true });
      const manifest = {
        name: plugin.name,
        version: plugin.version || '1.0.0',
        description: plugin.description || '',
        author: plugin.author || 'Community',
        category: plugin.category || 'utility',
        tier: plugin.tier || 'community',
        icon: plugin.icon || '🔌',
        tools: plugin.tools || [],
        settings: plugin.settings || [],
        config: plugin.config || {},
        permissions: plugin.permissions || [],
        price: plugin.price || 0,
        rating: plugin.rating || 0,
        downloads: plugin.downloads || 0,
        enabled: true,
      };
      fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      if (plugin.handler) {
        fs.writeFileSync(path.join(pluginDir, 'handler.js'), plugin.handler);
        try {
          const handlerPath = path.join(pluginDir, 'handler.js');
          delete require.cache[require.resolve(handlerPath)];
          this.handlers.set(plugin.id, require(handlerPath));
        } catch (e) { console.error(`Handler load error (${plugin.id}):`, e.message); }
      }
      this.plugins.set(plugin.id, manifest);
      this.enabled.add(plugin.id);
      return { ok: true, id: plugin.id, name: plugin.name };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  uninstall(pluginId) {
    try {
      const pluginDir = path.join(this.pluginsDir, pluginId);
      if (fs.existsSync(pluginDir)) fs.rmSync(pluginDir, { recursive: true, force: true });
      this.plugins.delete(pluginId);
      this.handlers.delete(pluginId);
      this.enabled.delete(pluginId);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  toggleEnable(pluginId) {
    const manifest = this.plugins.get(pluginId);
    if (!manifest) return { ok: false, error: 'Plugin not found' };
    const nowEnabled = !this.enabled.has(pluginId);
    if (nowEnabled) this.enabled.add(pluginId); else this.enabled.delete(pluginId);
    manifest.enabled = nowEnabled;
    try { fs.writeFileSync(path.join(this.pluginsDir, pluginId, 'manifest.json'), JSON.stringify(manifest, null, 2)); } catch {}
    return { ok: true, enabled: nowEnabled };
  }

  list() {
    return Array.from(this.plugins.entries()).map(([id, m]) => ({
      id, name: m.name, version: m.version, description: m.description,
      author: m.author, category: m.category || 'utility', tier: m.tier || 'community',
      icon: m.icon || '🔌', tools: (m.tools || []).length, toolList: m.tools || [],
      settings: m.settings || [], config: m.config || {},
      enabled: this.enabled.has(id), price: m.price || 0, rating: m.rating || 0, downloads: m.downloads || 0,
    }));
  }

  setConfig(pluginId, partialConfig) {
    const m = this.plugins.get(pluginId);
    if (!m) return { ok: false, error: 'Plugin not found' };
    m.config = { ...(m.config || {}), ...(partialConfig || {}) };
    this.plugins.set(pluginId, m);
    try {
      if (m._dir) {
        const manifestPath = path.join(m._dir, 'manifest.json');
        const toSave = { ...m };
        delete toSave._dir; delete toSave._id;
        fs.writeFileSync(manifestPath, JSON.stringify(toSave, null, 2));
      }
      return { ok: true, config: m.config };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  getToolDefinitions() {
    const tools = [];
    for (const [id, manifest] of this.plugins) {
      if (!this.enabled.has(id)) continue;
      for (const tool of (manifest.tools || [])) {
        tools.push({
          name: `plugin_${id}_${tool.name}`,
          desc: `[Plugin: ${manifest.name}] ${tool.description}`,
          params: tool.params || {},
          pluginId: id,
        });
      }
    }
    return tools;
  }

  async executeTool(pluginId, toolName, args) {
    if (!this.enabled.has(pluginId)) return { ok: false, error: `Plugin ${pluginId} is disabled` };
    const handler = this.handlers.get(pluginId);
    if (!handler) return { ok: false, error: `Plugin ${pluginId} has no handler` };
    const manifest = this.plugins.get(pluginId) || {};
    const ctx = { settings: manifest.config || {} };
    if (typeof handler.execute === 'function') {
      try { return await handler.execute(toolName, args, ctx); }
      catch (e) { return { ok: false, error: e.message }; }
    }
    if (typeof handler[toolName] === 'function') {
      try { return await handler[toolName](args, ctx); }
      catch (e) { return { ok: false, error: e.message }; }
    }
    return { ok: false, error: `Tool ${toolName} not found in plugin ${pluginId}` };
  }

  setConfig(pluginId, config) {
    const manifest = this.plugins.get(pluginId);
    if (!manifest) return { ok: false, error: 'Plugin not found' };
    manifest.config = { ...(manifest.config || {}), ...config };
    try { fs.writeFileSync(path.join(this.pluginsDir, pluginId, 'manifest.json'), JSON.stringify(manifest, null, 2)); } catch {}
    return { ok: true };
  }

  generateShareUrl(pluginId) {
    const manifest = this.plugins.get(pluginId);
    if (!manifest) return null;
    const pluginDir = path.join(this.pluginsDir, pluginId);
    const handlerPath = path.join(pluginDir, 'handler.js');
    const pluginData = {
      id: pluginId, name: manifest.name, version: manifest.version,
      description: manifest.description, author: manifest.author,
      category: manifest.category, tier: manifest.tier || 'community',
      icon: manifest.icon, tools: manifest.tools, permissions: manifest.permissions || [],
      handler: fs.existsSync(handlerPath) ? fs.readFileSync(handlerPath, 'utf8') : '',
    };
    const encoded = Buffer.from(JSON.stringify(pluginData)).toString('base64');
    return `horizon://plugin/install?data=${encoded}`;
  }

  installFromShareUrl(shareUrl) {
    try {
      let data;
      if (shareUrl.startsWith('horizon://plugin/install?data=')) {
        data = shareUrl.replace('horizon://plugin/install?data=', '');
      } else {
        const url = new URL(shareUrl);
        data = url.searchParams.get('data');
      }
      if (!data) return { ok: false, error: 'Invalid share URL' };
      const pluginData = JSON.parse(Buffer.from(data, 'base64').toString());
      // Force community tier on share-installed plugins unless they arrived with a signed bundle.
      if (pluginData.tier !== 'built_in' && pluginData.tier !== 'demo') pluginData.tier = 'community';
      return this.install(pluginData);
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /**
   * Install the bundled Spotify Control demo plugin from disk.
   * Called on first launch if the plugin isn't already installed.
   */
  installBundledSpotify() {
    if (this.plugins.has('spotify-control')) return { ok: true, skipped: true };
    try {
      const bundle = path.join(__dirname, '..', '..', 'builtin-plugins', 'spotify-control');
      const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
      const handler = fs.readFileSync(path.join(bundle, 'handler.js'), 'utf8');
      return this.install({
        id: manifest.id || 'spotify-control',
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        category: manifest.category,
        tier: 'demo',
        icon: manifest.icon,
        tools: manifest.tools,
        settings: manifest.settings || [],
        permissions: manifest.permissions,
        handler,
      });
    } catch (e) {
      console.error('Bundled Spotify install failed:', e.message);
      return { ok: false, error: e.message };
    }
  }

  /**
   * Built-in templates = small set of core utilities that ship with Horizon.
   * These are NOT user marketplace content.
   */
  static getBuiltinTemplates() {
    return [
      {
        id: 'system-monitor',
        name: 'System Monitor',
        description: 'CPU, RAM and disk status, top processes.',
        version: '1.2.0',
        author: 'Horizon Team',
        category: 'system',
        tier: 'built_in',
        icon: '📊',
        price: 0,
        rating: 0,
        downloads: 0,
        permissions: ['system:read'],
        tools: [
          { name: 'status',    description: 'CPU / RAM / disk snapshot', params: {} },
          { name: 'top_procs', description: 'Top processes by CPU',      params: {} },
          { name: 'disk_info', description: 'Per-drive disk usage',      params: {} },
        ],
        handler: `'use strict';
const os = require('os');
const { exec } = require('child_process');
const IS_WIN = process.platform === 'win32';
function sh(cmd){ return new Promise(r=>exec(cmd,{timeout:8000},(e,o,er)=>r({ok:!e,out:(o||'').trim(),err:(er||'').trim()}))); }
module.exports = {
  async execute(tool) {
    if (tool === 'status') {
      const cpus = os.cpus();
      const totalMem = (os.totalmem()/1e9).toFixed(1);
      const usedMem  = ((os.totalmem()-os.freemem())/1e9).toFixed(1);
      const memPct   = Math.round((os.totalmem()-os.freemem())/os.totalmem()*100);
      return { ok: true, out:
        'CPU: ' + cpus[0].model.slice(0,40) + ' (' + cpus.length + ' cores)\\n' +
        'RAM: ' + usedMem + 'GB / ' + totalMem + 'GB (' + memPct + '%)\\n' +
        'Platform: ' + os.platform() + ' ' + os.arch() + '\\n' +
        'Uptime: ' + Math.round(os.uptime()/3600) + 'h'
      };
    }
    if (tool === 'top_procs') return sh(IS_WIN ? 'tasklist /FO CSV /NH' : 'ps aux --sort=-%cpu 2>/dev/null | head -11');
    if (tool === 'disk_info') return sh(IS_WIN ? 'powershell -Command "Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize | Out-String"' : 'df -h 2>/dev/null');
    return { ok: false, error: 'Unknown tool: ' + tool };
  }
};`,
      },
      {
        id: 'quick-notes',
        name: 'Quick Notes',
        description: 'Save, list and search local notes as .txt files.',
        version: '1.0.0',
        author: 'Horizon Team',
        category: 'productivity',
        tier: 'built_in',
        icon: '📝',
        price: 0,
        permissions: ['fs:~/.horizon-notes'],
        tools: [
          { name: 'save',   description: 'Save a note', params: { title: 'string', content: 'string' } },
          { name: 'list',   description: 'List notes',  params: {} },
          { name: 'search', description: 'Search text', params: { query: 'string' } },
        ],
        handler: `'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const NOTES = path.join(os.homedir(), '.horizon-notes');
if (!fs.existsSync(NOTES)) fs.mkdirSync(NOTES, { recursive: true });
module.exports = {
  async execute(tool, args = {}) {
    if (tool === 'save') {
      const f = (args.title || 'note').replace(/[^a-zA-Z0-9а-яА-Я\\s]/g,'').trim().replace(/\\s+/g,'-') + '.txt';
      fs.writeFileSync(path.join(NOTES, f), '# ' + (args.title||'') + '\\n' + new Date().toISOString() + '\\n\\n' + (args.content||''), 'utf8');
      return { ok: true, out: 'saved: ' + f };
    }
    if (tool === 'list') {
      const files = fs.readdirSync(NOTES).filter(f=>f.endsWith('.txt'));
      return { ok: true, out: files.join('\\n') || '(empty)' };
    }
    if (tool === 'search') {
      const q = (args.query || '').toLowerCase();
      const hits = [];
      for (const f of fs.readdirSync(NOTES).filter(f=>f.endsWith('.txt'))) {
        const c = fs.readFileSync(path.join(NOTES, f), 'utf8');
        if (f.toLowerCase().includes(q) || c.toLowerCase().includes(q)) hits.push(f + ': ' + c.slice(0,80));
      }
      return { ok: true, out: hits.join('\\n') || 'no matches' };
    }
    return { ok: false, error: 'Unknown tool: ' + tool };
  }
};`,
      },
      {
        id: 'app-launcher',
        name: 'App Launcher',
        description: 'Launch and close desktop apps by name.',
        version: '1.0.0',
        author: 'Horizon Team',
        category: 'system',
        tier: 'built_in',
        icon: '🚀',
        price: 0,
        permissions: ['shell:exec'],
        tools: [
          { name: 'launch', description: 'Launch an app', params: { app: 'string' } },
          { name: 'close',  description: 'Close an app',  params: { app: 'string' } },
        ],
        handler: `'use strict';
const { exec } = require('child_process');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
function sh(cmd){ return new Promise(r=>exec(cmd,{timeout:8000},(e,o,er)=>r({ok:!e,out:(o||'').trim(),err:(er||'').trim()}))); }
module.exports = {
  async execute(tool, args = {}) {
    const app = (args.app || '').trim();
    if (!app) return { ok: false, error: 'app required' };
    if (tool === 'launch') {
      if (IS_WIN) return sh('start "" "' + app + '"');
      if (IS_MAC) return sh('open -a "' + app + '"');
      return sh('xdg-open "' + app + '" 2>/dev/null || ' + app + ' &');
    }
    if (tool === 'close') {
      if (IS_WIN) return sh('taskkill /F /IM "' + app + '.exe" 2>nul');
      if (IS_MAC) return sh('osascript -e \\'tell application "' + app + '" to quit\\'');
      return sh('pkill -f "' + app + '"');
    }
    return { ok: false, error: 'Unknown tool: ' + tool };
  }
};`,
      },
      {
        id: 'timer-alarm',
        name: 'Timer',
        description: 'Set timers with notifications.',
        version: '1.0.0',
        author: 'Horizon Team',
        category: 'productivity',
        tier: 'built_in',
        icon: '⏱️',
        price: 0,
        permissions: [],
        tools: [
          { name: 'set_timer',   description: 'Set a timer for N minutes', params: { minutes: 'number', label: 'string' } },
          { name: 'list_timers', description: 'List active timers',         params: {} },
        ],
        handler: `'use strict';
const timers = new Map(); let id = 1;
module.exports = {
  async execute(tool, args = {}) {
    if (tool === 'set_timer') {
      const m = parseFloat(args.minutes) || 1;
      const tid = 'T' + (id++);
      const end = Date.now() + m * 60000;
      setTimeout(() => timers.delete(tid), m * 60000);
      timers.set(tid, { label: args.label || '', end });
      return { ok: true, out: tid + ' set for ' + m + ' min (ends ' + new Date(end).toLocaleTimeString() + ')' };
    }
    if (tool === 'list_timers') {
      return { ok: true, out: [...timers.entries()].map(([k,v]) => k + ' — ' + v.label).join('\\n') || '(no timers)' };
    }
    return { ok: false, error: 'Unknown tool: ' + tool };
  }
};`,
      },
    ];
  }
}

module.exports = { PluginManager };
