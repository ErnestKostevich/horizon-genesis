'use strict';

const { Client } = require('@modelcontextprotocol/sdk/client');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { CallToolResultSchema, ListToolsResultSchema } = require('@modelcontextprotocol/sdk/types.js');

function normalizeEnv(env) {
  if (!env || typeof env !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key) continue;
    out[String(key)] = String(value ?? '');
  }
  return out;
}

function contentToText(content) {
  if (!Array.isArray(content)) return '';
  return content.map(item => {
    if (!item) return '';
    if (item.type === 'text') return item.text || '';
    if (item.type === 'image') return `[image ${item.mimeType || ''}]`;
    if (item.type === 'resource') return `[resource ${item.resource?.uri || ''}]`;
    return JSON.stringify(item);
  }).filter(Boolean).join('\n');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

class MCPServerClient {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.lastError = null;
    this.connectedAt = null;
    this.requestTimeoutMs = Number(config?.timeoutMs) || 20000;
  }

  async connect() {
    if (this.client) return this.client;
    if (!this.config?.command) throw new Error('MCP server command is required');

    const client = new Client(
      { name: 'horizon-genesis', version: '1.0.0' },
      { capabilities: {} }
    );
    const extraEnv = normalizeEnv(this.config.env);
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: Array.isArray(this.config.args) ? this.config.args : [],
      env: extraEnv ? { ...getDefaultEnvironment(), ...extraEnv } : undefined,
      cwd: this.config.cwd || undefined,
      stderr: 'pipe'
    });

    let stderr = '';
    try {
      transport.stderr?.on?.('data', chunk => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4000);
      });
    } catch (_) {}

    client.onerror = error => {
      this.lastError = error?.message || String(error);
    };

    try {
      await withTimeout(client.connect(transport), this.requestTimeoutMs, 'MCP connect');
      this.client = client;
      this.transport = transport;
      this.connectedAt = new Date().toISOString();
      this.lastError = null;
      return client;
    } catch (e) {
      this.lastError = stderr ? `${e.message}\n${stderr}` : e.message;
      try { await transport.close(); } catch (_) {}
      throw new Error(this.lastError);
    }
  }

  async close() {
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.connectedAt = null;
    if (transport) {
      try { await transport.close(); } catch (_) {}
    }
  }

  async request(method, params, schema) {
    const client = await this.connect();
    try {
      return await withTimeout(client.request({ method, params }, schema), this.requestTimeoutMs, `MCP ${method}`);
    } catch (e) {
      this.lastError = e.message;
      await this.close();
      throw e;
    }
  }

  async listTools() {
    const result = await this.request('tools/list', {}, ListToolsResultSchema);
    this.tools = Array.isArray(result.tools) ? result.tools : [];
    return this.tools;
  }

  async callTool(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args || {} }, CallToolResultSchema);
    const out = contentToText(result.content);
    return {
      ok: !result.isError,
      out: out || JSON.stringify(result.structuredContent || result.content || result),
      content: out,
      structuredContent: result.structuredContent || null,
      raw: result
    };
  }
}

module.exports = { MCPServerClient, contentToText };
