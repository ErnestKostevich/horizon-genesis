// `horizon mcp` — manage MCP (Model Context Protocol) servers.
//
// Stored in settingsStore key `mcp.servers` as an array of
//   { id, name, command, args, env, enabled }
// (same schema the Electron app's MCPRegistry expects, so config
// migrates both ways).
//
// Subcommands:
//   horizon mcp list                       — show configured servers + enabled flag
//   horizon mcp add <name> <command> ...   — register a new server (rest = args)
//   horizon mcp remove <id>                — unregister
//   horizon mcp enable <id> | disable <id>
//   horizon mcp tools                      — list tools exposed by all enabled servers (best-effort, calls toolsForAgent if registry loaded)

const crypto = require('crypto');
const { fmt } = require('../tty');

async function run({ runtime, args, flags }) {
  const sub = args[0] || 'list';
  const rest = args.slice(1);
  if (sub === 'list')                return list(runtime, flags);
  if (sub === 'add')                 return add(runtime, rest, flags);
  if (sub === 'remove' || sub === 'rm') return remove(runtime, rest, flags);
  if (sub === 'enable')              return setEnabled(runtime, rest, true);
  if (sub === 'disable')             return setEnabled(runtime, rest, false);
  if (sub === 'tools')               return tools(runtime, flags);

  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write('Try: list | add <name> <command> [args...] | remove <id> | enable/disable | tools\n');
  return 2;
}

function getServers(rt) {
  return rt.settingsStore.get('mcp.servers') || [];
}
function setServers(rt, list) {
  rt.settingsStore.set('mcp.servers', list);
}

function list(rt, flags) {
  const servers = getServers(rt);
  const enabled = rt.settingsStore.get('mcp.enabled');
  if (flags.json) {
    process.stdout.write(JSON.stringify({ mcpEnabled: !!enabled, servers }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write('\n' + fmt.bold('MCP servers') + ' · ' + (enabled ? fmt.green('global on') : fmt.dim('global off')) + '\n\n');
  if (!servers.length) {
    process.stdout.write(fmt.dim('  none configured · try `horizon mcp add filesystem npx -y @modelcontextprotocol/server-filesystem ~/Documents`\n\n'));
    return 0;
  }
  for (const s of servers) {
    const dot = s.enabled === false ? fmt.dim('○') : fmt.green('●');
    process.stdout.write(`  ${dot} ${fmt.cyan(s.id.padEnd(16))} ${fmt.bold((s.name || '').padEnd(20))} ${fmt.dim(s.command + ' ' + (s.args || []).join(' '))}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

function add(rt, rest, flags) {
  const name = rest[0];
  const command = rest[1];
  const argv = rest.slice(2);
  if (!name || !command) {
    process.stderr.write(fmt.err('Usage: horizon mcp add <name> <command> [args...]') + '\n');
    process.stderr.write(fmt.dim('Example: horizon mcp add filesystem npx -y @modelcontextprotocol/server-filesystem ~/code\n'));
    return 2;
  }
  const servers = getServers(rt);
  const entry = {
    id: 'mcp-' + crypto.randomBytes(3).toString('hex'),
    name, command, args: argv, env: {}, enabled: true,
  };
  servers.push(entry);
  setServers(rt, servers);
  // Auto-enable global MCP if it was off
  if (!rt.settingsStore.get('mcp.enabled')) rt.settingsStore.set('mcp.enabled', true);
  process.stdout.write(fmt.ok('added ' + fmt.cyan(entry.id) + ' · ' + name) + '\n');
  return 0;
}

function remove(rt, rest, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('id required') + '\n'); return 2; }
  const servers = getServers(rt);
  const filtered = servers.filter(s => s.id !== id);
  if (filtered.length === servers.length) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  setServers(rt, filtered);
  process.stdout.write(fmt.ok('removed ' + id) + '\n');
  return 0;
}

function setEnabled(rt, rest, enabled) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('id required') + '\n'); return 2; }
  const servers = getServers(rt);
  const s = servers.find(x => x.id === id);
  if (!s) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
  s.enabled = !!enabled;
  setServers(rt, servers);
  process.stdout.write(fmt.ok(`${enabled ? 'enabled' : 'disabled'} ${id}`) + '\n');
  return 0;
}

function tools(rt, flags) {
  // mcpRegistry is Electron-only — CLI runtime doesn't currently load it.
  // We show what's stored + a note explaining where to see live tool lists.
  const servers = getServers(rt).filter(s => s.enabled !== false);
  if (flags.json) { process.stdout.write(JSON.stringify(servers, null, 2) + '\n'); return 0; }
  process.stdout.write(fmt.dim('  MCP tool listing is exposed by the Electron app (Settings → MCP).\n'));
  process.stdout.write(fmt.dim('  CLI runtime doesn\'t spawn MCP processes yet — use the desktop app for live tool calls.\n'));
  if (servers.length) {
    process.stdout.write('\n' + fmt.bold('  Configured & enabled:') + '\n');
    for (const s of servers) {
      process.stdout.write(`    ${fmt.cyan(s.name || s.id)}  ${fmt.dim(s.command + ' ' + (s.args || []).join(' '))}\n`);
    }
  }
  return 0;
}

module.exports = { run };
