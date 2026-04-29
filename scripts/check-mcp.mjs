#!/usr/bin/env node

import { getMcpClient, listMcpTools, callMcpTool } from '../mcpClient.js';

try {
  console.log('Connecting to Blender MCP...');
  await getMcpClient();

  const tools = await listMcpTools();
  console.log(`MCP tools: ${tools.length}`);
  if (tools.length) {
    console.log(`First tools: ${tools.slice(0, 8).map((t) => t.name).join(', ')}`);
  }

  const scene = await callMcpTool('get_scene_info', {
    user_prompt: 'edu3d MCP connectivity check',
  });
  const text = scene?.content?.map((block) => block.text || JSON.stringify(block)).join('\n') || JSON.stringify(scene);
  console.log(text.slice(0, 2000));
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
