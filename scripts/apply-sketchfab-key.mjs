#!/usr/bin/env node

import 'dotenv/config';

import { getMcpClient, callMcpTool } from '../mcpClient.js';

const key = process.env.SKETCHFAB_API_KEY;
if (!key) {
  console.error('SKETCHFAB_API_KEY is not set in .env');
  process.exit(1);
}

const code = `
import bpy

scene = bpy.context.scene
scene.blendermcp_use_sketchfab = True
scene.blendermcp_sketchfab_api_key = ${JSON.stringify(key)}

print("Sketchfab enabled:", scene.blendermcp_use_sketchfab)
print("Sketchfab key set:", bool(scene.blendermcp_sketchfab_api_key))
`;

try {
  await getMcpClient();
  const result = await callMcpTool('execute_blender_code', {
    code,
    user_prompt: 'Apply Sketchfab API key from edu3d .env',
  });

  const text = result?.content?.map((block) => block.text || JSON.stringify(block)).join('\n') || JSON.stringify(result);
  console.log(text);

  const status = await callMcpTool('get_sketchfab_status', {
    user_prompt: 'Verify Sketchfab API key from edu3d .env',
  });
  const statusText = status?.content?.map((block) => block.text || JSON.stringify(block)).join('\n') || JSON.stringify(status);
  console.log(statusText);
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
