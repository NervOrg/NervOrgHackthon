import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let connectPromise = null;
let client = null;
let toolsCache = null;

/**
 * Lazily start the Blender MCP server (`uvx blender-mcp` by default) and
 * connect to it. The same client is reused for every job — Blender stays
 * running and the LLM can build up a shared scene across requests.
 */
export async function getMcpClient() {
  if (client) return client;
  if (!connectPromise) connectPromise = connect();
  return connectPromise;
}

async function connect() {
  const command = process.env.MCP_CMD || 'uvx';
  const args = (process.env.MCP_ARGS || 'blender-mcp').split(/\s+/).filter(Boolean);

  const transport = new StdioClientTransport({
    command,
    args,
    env: process.env,
    stderr: 'pipe',
  });

  // Surface MCP server stderr so Blender connection errors are visible.
  if (transport.stderr) {
    transport.stderr.on('data', (buf) => {
      const line = buf.toString().trim();
      if (line) console.error(`[mcp] ${line}`);
    });
  }

  const c = new Client({ name: 'edu3d', version: '0.1.0' }, { capabilities: {} });
  await c.connect(transport);
  client = c;

  c.onclose = () => {
    console.warn('[mcp] connection closed; will reconnect on next request');
    client = null;
    connectPromise = null;
    toolsCache = null;
  };

  return c;
}

export async function listMcpTools() {
  const c = await getMcpClient();
  if (toolsCache) return toolsCache;
  const result = await c.listTools();
  toolsCache = result.tools || [];
  return toolsCache;
}

export async function callMcpTool(name, args) {
  const c = await getMcpClient();
  return c.callTool({ name, arguments: args || {} });
}

/**
 * Convert MCP tool definitions to OpenAI's function-calling tool format.
 */
export function toOpenAITools(mcpTools) {
  return mcpTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
}
