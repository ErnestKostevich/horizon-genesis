// `horizon plugins` — list and inspect installed plugins (CLI-side).
//
// The Electron app drives plugin install/enable through PluginManager
// (which needs IPC + the renderer's permission dialogs). CLI exposes a
// read-only view here: what's installed, what permissions each has,
// what tools each registers. To install/remove, use the desktop app
// or the `horizon://` deep links.
//
// Subcommands:
//   horizon plugins list                — installed plugins
//   horizon plugins show <id>           — manifest dump
//   horizon plugins enable <id> | disable <id>  — toggle enable flag in settings
//
// We read directly from <userData>/plugins/<id>/manifest.json so this
// works even when the Electron PluginManager isn't loaded.

const fs = require('fs');
const path = require('path');
const { fmt } = require('../tty');

function pluginsDir(userDataDir) {
  return path.join(userDataDir, 'plugins');
}

function listInstalled(userDataDir) {
  const dir = pluginsDir(userDataDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const id of fs.readdirSync(dir)) {
    const mfPath = path.join(dir, id, 'manifest.json');
    if (!fs.existsSync(mfPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
      out.push({ id, dir: path.join(dir, id), manifest });
    } catch (_) {}
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function run({ runtime, args, flags }) {
  const sub = args[0] || 'list';
  const rest = args.slice(1);
  if (sub === 'list')              return list(runtime, flags);
  if (sub === 'show')              return show(runtime, rest, flags);
  if (sub === 'enable')            return toggle(runtime, rest, true);
  if (sub === 'disable')           return toggle(runtime, rest, false);
  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write('Try: list | show <id> | enable <id> | disable <id>\n');
  return 2;
}

function list(rt, flags) {
  const plugins = listInstalled(rt.userDataDir);
  const enabledMap = rt.settingsStore.get('plugins.enabled') || {};
  if (flags.json) {
    process.stdout.write(JSON.stringify(plugins.map(p => ({
      id: p.id, name: p.manifest.name, version: p.manifest.version,
      description: p.manifest.description,
      enabled: enabledMap[p.id] !== false,
      permissions: p.manifest.permissions || [],
      tools: p.manifest.tools || [],
    })), null, 2) + '\n');
    return 0;
  }
  if (!plugins.length) {
    process.stdout.write(fmt.dim('\n  no plugins installed · browse horizonaai.dev/browse\n\n'));
    return 0;
  }
  process.stdout.write('\n' + fmt.bold('Plugins') + '\n\n');
  for (const p of plugins) {
    const on = enabledMap[p.id] !== false;
    const dot = on ? fmt.green('●') : fmt.dim('○');
    const ver = p.manifest.version ? fmt.dim('v' + p.manifest.version) : '';
    process.stdout.write(`  ${dot} ${fmt.cyan(p.id.padEnd(24))} ${fmt.bold((p.manifest.name || '').padEnd(20))} ${ver}\n`);
    if (p.manifest.description) process.stdout.write(`      ${fmt.dim(p.manifest.description.slice(0, 80))}\n`);
    const perms = p.manifest.permissions || [];
    if (perms.length) process.stdout.write(`      ${fmt.dim('perms:')} ${fmt.dim(perms.join(', '))}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

function show(rt, rest, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('id required') + '\n'); return 2; }
  const plugins = listInstalled(rt.userDataDir);
  const p = plugins.find(x => x.id === id);
  if (!p) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  if (flags.json) { process.stdout.write(JSON.stringify(p.manifest, null, 2) + '\n'); return 0; }
  process.stdout.write(JSON.stringify(p.manifest, null, 2) + '\n');
  return 0;
}

function toggle(rt, rest, enabled) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('id required') + '\n'); return 2; }
  const enabledMap = rt.settingsStore.get('plugins.enabled') || {};
  enabledMap[id] = !!enabled;
  rt.settingsStore.set('plugins.enabled', enabledMap);
  process.stdout.write(fmt.ok(`${enabled ? 'enabled' : 'disabled'} ${id}`) + '\n');
  return 0;
}

module.exports = { run };
