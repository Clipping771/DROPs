// MCP (Model Context Protocol) client: connects to configured servers (stdio or HTTP) and
// exposes their tools to the agent as `mcp__<server>__<tool>`.
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const safe = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_');
const toolName = (server, tool) => `mcp__${safe(server)}__${safe(tool)}`.slice(0, 64);

// Reads `{ "mcpServers": { ... } }` from a project's .mcp.json, if present.
function projectServers(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8').replace(/^\uFEFF/, '')).mcpServers || {}; } catch { return {}; }
}

class McpManager {
  constructor() { this.servers = new Map(); }

  // configs: { name: { command, args, env, cwd } | { url, headers, transport: 'http'|'sse' }, ... }
  async sync(configs = {}) {
    const wanted = new Map(Object.entries(configs).filter(([, c]) => c && !c.disabled));
    for (const [name, s] of this.servers) {
      if (!wanted.has(name) || JSON.stringify(wanted.get(name)) !== JSON.stringify(s.config)) { await this.disconnect(name); }
    }
    await Promise.all([...wanted].map(([name, cfg]) => (this.servers.has(name) ? null : this.connect(name, cfg))));
    return this.status();
  }

  async connect(name, cfg) {
    const entry = { name, config: cfg, client: null, tools: [], status: 'connecting', error: null };
    this.servers.set(name, entry);
    try {
      const client = new Client({ name: 'drops', version: '2.0.0' });
      let transport;
      if (cfg.url) {
        const url = new URL(cfg.url);
        const opts = { requestInit: { headers: cfg.headers || {} } };
        transport = cfg.transport === 'sse' ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
      } else if (cfg.command) {
        transport = new StdioClientTransport({ command: cfg.command, args: cfg.args || [], env: { ...process.env, ...(cfg.env || {}) }, cwd: cfg.cwd, stderr: 'pipe' });
      } else throw new Error('Server needs "command" (stdio) or "url" (HTTP).');
      await withTimeout(client.connect(transport), 30000, 'connect');
      const tools = [];
      let cursor;
      do {
        const r = await withTimeout(client.listTools(cursor ? { cursor } : undefined), 20000, 'listTools');
        tools.push(...(r.tools || []));
        cursor = r.nextCursor;
      } while (cursor);
      Object.assign(entry, { client, tools, status: 'connected' });
    } catch (e) {
      Object.assign(entry, { status: 'error', error: e.message || String(e) });
    }
    return entry;
  }

  async disconnect(name) {
    const s = this.servers.get(name);
    this.servers.delete(name);
    try { await s?.client?.close(); } catch { /* ignore */ }
  }
  async closeAll() { for (const name of [...this.servers.keys()]) await this.disconnect(name); }

  toolDefs() {
    const defs = [];
    for (const s of this.servers.values()) {
      if (s.status !== 'connected') continue;
      for (const t of s.tools) {
        const schema = t.inputSchema && typeof t.inputSchema === 'object' ? { ...t.inputSchema } : { type: 'object', properties: {} };
        if (schema.type !== 'object') { schema.type = 'object'; schema.properties ||= {}; }
        delete schema.$schema;
        defs.push({ name: toolName(s.name, t.name), description: `[MCP server "${s.name}"] ${(t.description || t.name).slice(0, 1000)}`, input_schema: schema, _mcp: { server: s.name, tool: t.name, trusted: !!s.config.trust } });
      }
    }
    return defs;
  }

  find(fullName) {
    for (const s of this.servers.values()) for (const t of s.tools) if (toolName(s.name, t.name) === fullName) return { server: s, tool: t };
    return null;
  }

  async call(fullName, args, signal) {
    const hit = this.find(fullName);
    if (!hit) throw new Error(`MCP tool ${fullName} is not available (server disconnected?).`);
    const r = await hit.server.client.callTool({ name: hit.tool.name, arguments: args || {} }, undefined, { signal, timeout: 180000 });
    const parts = (r.content || []).map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri}]`;
      if (c.type === 'resource_link') return `[resource ${c.uri}]`;
      if (c.type === 'image') return `[image ${c.mimeType}]`;
      return `[${c.type}]`;
    });
    if (r.structuredContent && !parts.length) parts.push(JSON.stringify(r.structuredContent, null, 2));
    return { text: parts.join('\n') || '(empty result)', isError: !!r.isError, server: hit.server.name, tool: hit.tool.name };
  }

  status() {
    return [...this.servers.values()].map((s) => ({ name: s.name, status: s.status, error: s.error, tools: s.tools.map((t) => t.name), kind: s.config.url ? 'http' : 'stdio', trusted: !!s.config.trust }));
  }
}

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`MCP ${what} timed out after ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t));
}

module.exports = { McpManager, projectServers, toolName };
