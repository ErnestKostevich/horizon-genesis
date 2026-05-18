'use strict';

const crypto = require('crypto');
const { MCPServerClient } = require('./mcpClient');

function slugifyName(name) {
  return String(name || 'server')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'server';
}

function normalizeServerConfig(input = {}) {
  const id = input.id || `${slugifyName(input.name)}-${crypto.randomBytes(3).toString('hex')}`;
  const args = Array.isArray(input.args)
    ? input.args.map(String).filter(Boolean)
    : String(input.args || '').split(/\s+/).map(s => s.trim()).filter(Boolean);
  let env = input.env || {};
  if (typeof env === 'string') {
    env = Object.fromEntries(env.split(/\r?\n/).map(line => {
      const idx = line.indexOf('=');
      if (idx <= 0) return null;
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    }).filter(Boolean));
  }
  return {
    id,
    name: String(input.name || id).trim() || id,
    command: String(input.command || '').trim(),
    args,
    env: env && typeof env === 'object' ? env : {},
    cwd: input.cwd ? String(input.cwd) : '',
    timeoutMs: Math.min(Math.max(Number(input.timeoutMs) || 20000, 3000), 120000),
    enabled: input.enabled !== false,
  };
}

function splitNamespacedTool(name) {
  const idx = String(name || '').indexOf('__');
  if (idx <= 0) return null;
  return { serverId: name.slice(0, idx), toolName: name.slice(idx + 2) };
}

class MCPRegistry {
  constructor(settingsStore) {
    this.settingsStore = settingsStore;
    this.clients = new Map();
    this.toolCache = [];
  }

  getServers() {
    const raw = this.settingsStore.get('mcp.servers') || [];
    return Array.isArray(raw) ? raw.map(normalizeServerConfig) : [];
  }

  saveServers(servers) {
    this.settingsStore.set('mcp.servers', servers.map(normalizeServerConfig));
  }

  async closeRemoved(nextServers) {
    const nextIds = new Set(nextServers.map(s => s.id));
    for (const [id, client] of this.clients.entries()) {
      if (!nextIds.has(id)) {
        await client.close();
        this.clients.delete(id);
      }
    }
  }

  getClient(config) {
    if (!this.clients.has(config.id)) this.clients.set(config.id, new MCPServerClient(config));
    const existing = this.clients.get(config.id);
    existing.config = config;
    return existing;
  }

  async listServers() {
    const servers = this.getServers();
    await this.closeRemoved(servers);
    return servers.map(s => {
      const client = this.clients.get(s.id);
      return {
        ...s,
        connected: Boolean(client?.client),
        toolCount: client?.tools?.length || 0,
        lastError: client?.lastError || null,
        connectedAt: client?.connectedAt || null,
      };
    });
  }

  async upsertServer(input) {
    const next = normalizeServerConfig(input);
    const servers = this.getServers();
    const idx = servers.findIndex(s => s.id === next.id);
    if (idx >= 0) servers[idx] = next;
    else servers.push(next);
    this.saveServers(servers);
    const old = this.clients.get(next.id);
    if (old) await old.close();
    this.clients.delete(next.id);
    return next;
  }

  async removeServer(id) {
    const servers = this.getServers().filter(s => s.id !== id);
    this.saveServers(servers);
    const client = this.clients.get(id);
    if (client) await client.close();
    this.clients.delete(id);
    this.toolCache = this.toolCache.filter(t => t.serverId !== id);
    return true;
  }

  async setEnabled(id, enabled) {
    const servers = this.getServers();
    const target = servers.find(s => s.id === id);
    if (!target) throw new Error('MCP server not found');
    target.enabled = Boolean(enabled);
    this.saveServers(servers);
    if (!target.enabled && this.clients.has(id)) await this.clients.get(id).close();
    return target;
  }

  async testServer(input) {
    const config = normalizeServerConfig(input);
    const temp = new MCPServerClient(config);
    try {
      const tools = await temp.listTools();
      return { ok: true, tools: tools.map(t => ({ name: t.name, description: t.description || '' })), count: tools.length };
    } finally {
      await temp.close();
    }
  }

  async refreshTools() {
    const tools = [];
    const errors = [];
    for (const server of this.getServers().filter(s => s.enabled)) {
      const client = this.getClient(server);
      try {
        const listed = await client.listTools();
        for (const tool of listed) {
          tools.push({
            serverId: server.id,
            serverName: server.name,
            name: `${server.id}__${tool.name}`,
            originalName: tool.name,
            desc: `[MCP: ${server.name}] ${tool.description || tool.name}`,
            params: tool.inputSchema || {},
            inputSchema: tool.inputSchema || { type: 'object', properties: {}, additionalProperties: true },
          });
        }
      } catch (e) {
        client.lastError = e.message;
        errors.push({ serverId: server.id, serverName: server.name, error: e.message });
      }
    }
    this.toolCache = tools;
    this.settingsStore.set('mcp.toolsCache', tools.map(t => ({
      serverId: t.serverId, serverName: t.serverName, name: t.name, originalName: t.originalName, desc: t.desc, inputSchema: t.inputSchema
    })));
    this.settingsStore.set('mcp.toolsCacheAt', new Date().toISOString());
    this.settingsStore.set('mcp.lastErrors', errors);
    return tools;
  }

  async toolsForAgent() {
    if (!this.toolCache.length) {
      try {
        await this.refreshTools();
      } catch (_) {}
      if (!this.toolCache.length) {
        const cached = this.settingsStore.get('mcp.toolsCache') || [];
        if (Array.isArray(cached)) this.toolCache = cached.map(t => ({
          ...t,
          params: t.inputSchema || {},
          inputSchema: t.inputSchema || { type: 'object', properties: {}, additionalProperties: true },
        }));
      }
    }
    // PHASE: anti-loop fix. setEnabled() / removeServer() can run between
    // refreshTools cycles, but the cached toolCache wasn't invalidated —
    // so the agent kept seeing tools from disabled servers, called them,
    // got "MCP server not enabled" errors, and looped (e.g. the
    // system-monitor__status spam the user reported). Filter the cache
    // through the CURRENT enabled-server list on every call. Cheap —
    // toolCache is usually <100 entries.
    const liveServers = new Set(
      this.getServers().filter(s => s.enabled !== false).map(s => s.id)
    );
    return this.toolCache.filter(t => liveServers.has(t.serverId));
  }

  async dispatch(toolName, args = {}) {
    const parsed = splitNamespacedTool(toolName);
    if (!parsed) return null;
    const server = this.getServers().find(s => s.id === parsed.serverId && s.enabled);
    if (!server) {
      // PHASE: anti-loop — same fix as pluginManager.executeTool. Return
      // an unambiguous "do not retry" message so the LLM doesn't repeat
      // the same disabled tool call across turns.
      return {
        ok: false,
        error: `MCP server "${parsed.serverId}" is disabled or not configured. Do NOT call ${toolName} again — answer the user directly or pick a different tool.`,
        err: `Tool unavailable: ${parsed.serverId}. Switch strategy.`,
        unavailable: true,
      };
    }
    const client = this.getClient(server);
    return client.callTool(parsed.toolName, args);
  }
}

module.exports = { MCPRegistry, normalizeServerConfig, splitNamespacedTool };
