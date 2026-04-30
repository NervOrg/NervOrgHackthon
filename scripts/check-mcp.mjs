#!/usr/bin/env node

import 'dotenv/config';
import { getMcpClient, listMcpTools, callMcpTool } from '../mcpClient.js';

const DEFAULT_TIMEOUT_MS = 30000;

try {
  printRuntimeConfig();

  console.log('Starting MCP server and connecting...');
  await withTimeout(getMcpClient(), DEFAULT_TIMEOUT_MS, 'Timed out while connecting to the MCP server');
  console.log('MCP server connection: ok');

  const tools = await withTimeout(listMcpTools(), DEFAULT_TIMEOUT_MS, 'Timed out while listing MCP tools');
  console.log(`MCP tools: ${tools.length}`);
  if (tools.length) {
    console.log(`First tools: ${tools.slice(0, 8).map((t) => t.name).join(', ')}`);
  } else {
    failWithHint('MCP server started but returned zero tools.', [
      'Confirm the MCP package is installed and starts correctly.',
      'Run `uvx blender-mcp` manually to inspect startup errors.',
    ]);
  }

  const getSceneInfo = tools.find((tool) => tool.name === 'get_scene_info');
  if (!getSceneInfo) {
    failWithHint('MCP server did not expose get_scene_info.', [
      'Confirm this is the Blender MCP server, not a different MCP package.',
      'Check MCP_CMD and MCP_ARGS in `.env`.',
    ]);
  }

  console.log('Checking Blender addon response...');
  const scene = await withTimeout(callMcpTool('get_scene_info', {
    user_prompt: 'edu3d MCP connectivity check',
  }), DEFAULT_TIMEOUT_MS, 'Timed out while asking Blender for scene info');
  const text = formatMcpText(scene);
  if (scene?.isError || /could not connect|connection refused|addon is running|failed to connect/i.test(text)) {
    failWithHint(`Blender addon response failed: ${text.slice(0, 500)}`, [
      'Open Blender before running the app.',
      'Enable/start the Blender MCP addon inside Blender.',
      'If Node runs in WSL and Blender runs on Windows, set BLENDER_HOST to the Windows WSL gateway IP.',
      'Confirm BLENDER_PORT matches the addon port.',
    ]);
  }

  console.log('Blender addon response: ok');
  console.log(text.slice(0, 2000));
  console.log('Readiness check complete.');
  process.exit(0);
} catch (err) {
  console.error('Readiness check failed.');
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}

function printRuntimeConfig() {
  const command = process.env.MCP_CMD || 'uvx';
  const args = process.env.MCP_ARGS || 'blender-mcp';
  const host = process.env.BLENDER_HOST || '(default from MCP server)';
  const port = process.env.BLENDER_PORT || '(default from MCP server)';

  console.log('Blender MCP runtime configuration:');
  console.log(`  MCP_CMD=${command}`);
  console.log(`  MCP_ARGS=${args}`);
  console.log(`  BLENDER_HOST=${host}`);
  console.log(`  BLENDER_PORT=${port}`);
  console.log(`  OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? '(set)' : '(not set; not needed for this check)'}`);
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} after ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function formatMcpText(result) {
  if (!result || !Array.isArray(result.content)) return JSON.stringify(result ?? null);
  return result.content
    .map((block) => {
      if (!block) return '';
      if (block.type === 'text') return String(block.text ?? '');
      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join('\n');
}

function failWithHint(message, hints) {
  const lines = [message, '', 'Next actions:', ...hints.map((hint) => `- ${hint}`)];
  throw new Error(lines.join('\n'));
}
