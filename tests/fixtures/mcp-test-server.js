// Tiny MCP server used by the tests: exposes `get_ticket` (fake issue tracker) and `add` tools over stdio.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({ name: 'h2o-test-tracker', version: '1.0.0' });
const tickets = { 'BUG-42': { title: 'Cart total off by a cent', status: 'open', assignee: 'ada', detail: 'cartTotal sums floats; 0.1*3 != 0.3' } };

server.registerTool('get_ticket', {
  description: 'Fetch an issue from the team tracker by its key (e.g. BUG-42).',
  inputSchema: { key: z.string().describe('Ticket key') },
}, async ({ key }) => {
  const t = tickets[key];
  if (!t) return { content: [{ type: 'text', text: `No ticket ${key}` }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify({ key, ...t }) }] };
});

server.registerTool('add', {
  description: 'Add two numbers.',
  inputSchema: { a: z.number(), b: z.number() },
}, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));

server.connect(new StdioServerTransport());
