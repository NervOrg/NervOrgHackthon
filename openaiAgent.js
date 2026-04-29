import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';

import { getMcpClient, listMcpTools, callMcpTool, toOpenAITools } from './mcpClient.js';

const ASSETS_DIR = path.resolve('assets');
const SYSTEM_PROMPT_FILE = path.resolve('config/systemPrompt.txt');
const MIN_GLB_BYTES = 1024;

const DEFAULT_SYSTEM_PROMPT = [
  'You are a 3D scene-building assistant driving Blender via the connected MCP tools.',
  'Always search for and use existing models when possible.',
  'When creating new content, work step by step and verify with viewport screenshots.',
  '',
  'Request: {{prompt}}',
].join('\n');

const SERVER_REQUIREMENTS_TEMPLATE = `

────────────────────────────────────────────
SERVER REQUIREMENTS (the system enforces these — do not deviate):
- Job ID: {{jobId}}
- When the model is ready, export the newly created/positioned object as a GLB file to EXACTLY this absolute path:
    {{glbPath}}
- Center the exported model at the origin with feet/base at Y=0, facing -Z, and apply all transforms before export.
- Use Blender's GLTF export with format='GLB' and use_selection=True so only the new object ships out (other objects in the scene may be reused by future requests — DO NOT delete them).
- Keep the exported model under 50,000 polygons.
- After the GLB file exists at the path above, you are done. End your turn with a brief summary message and no further tool calls.
- If you cannot fulfil the request, end your turn with a short message starting with "ERROR:" describing why — do not silently give up.
────────────────────────────────────────────
`.trimStart();

async function loadSystemPromptTemplate() {
  try {
    const raw = await fsp.readFile(SYSTEM_PROMPT_FILE, 'utf8');
    return raw;
  } catch {
    return DEFAULT_SYSTEM_PROMPT;
  }
}

function buildSystemPrompt({ template, prompt, jobId, glbPath }) {
  const userPart = template.replaceAll('{{prompt}}', prompt);
  const requirements = SERVER_REQUIREMENTS_TEMPLATE
    .replaceAll('{{glbPath}}', glbPath)
    .replaceAll('{{jobId}}', jobId);
  return userPart + '\n' + requirements;
}

/**
 * Run an OpenAI tool-calling agent loop, dispatching tool calls to the
 * Blender MCP client. Returns when the model stops calling tools or the GLB
 * appears on disk (whichever comes first).
 */
export async function generateWithOpenAI({ id, prompt, onProgress = () => {} }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  await fsp.mkdir(ASSETS_DIR, { recursive: true });
  const glbPath = path.join(ASSETS_DIR, `${id}.glb`);
  await fsp.rm(glbPath, { force: true });

  // Make sure MCP is up before we consume any OpenAI tokens.
  onProgress('Connecting to Blender (MCP)...');
  await getMcpClient();
  const mcpTools = await listMcpTools();
  if (mcpTools.length === 0) {
    throw new Error('Blender MCP server reported zero tools — is Blender running with the addon enabled?');
  }
  onProgress(`MCP ready (${mcpTools.length} tools)`);

  const openaiTools = toOpenAITools(mcpTools);
  const template = await loadSystemPromptTemplate();
  const systemPrompt = buildSystemPrompt({ template, prompt, jobId: id, glbPath });

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || 'gpt-4.1';
  const maxSteps = Number(process.env.OPENAI_MAX_STEPS || 80);

  /** @type {any[]} */
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Build the requested scene now: ${prompt}` },
  ];

  for (let step = 0; step < maxSteps; step++) {
    onProgress(`thinking (step ${step + 1}/${maxSteps})...`);

    const completion = await client.chat.completions.create({
      model,
      messages,
      tools: openaiTools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });

    const msg = completion.choices?.[0]?.message;
    if (!msg) throw new Error('OpenAI returned no message');

    // Push the assistant message verbatim so tool_call ids round-trip.
    messages.push(msg);

    const toolCalls = msg.tool_calls || [];

    if (toolCalls.length === 0) {
      const content = (msg.content || '').toString().trim();
      if (content.startsWith('ERROR:')) throw new Error(content.slice(6).trim() || 'agent reported error');
      onProgress(content ? content.slice(0, 200) : '(agent finished)');
      break;
    }

    // Tool messages must come back in the same order, one per call. Track
    // image content separately and forward it as a follow-up user message —
    // the OpenAI tool role only accepts string content.
    const pendingImages = [];

    for (const tc of toolCalls) {
      const fn = tc.function?.name || '';
      let args = {};
      try {
        args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch (err) {
        args = { _parseError: String(err) };
      }
      onProgress(`→ ${fn}(${shortJson(args)})`);

      let toolText;
      try {
        const result = await callMcpTool(fn, args);
        const { text, images } = formatMcpResult(result);
        toolText = text;
        for (const img of images) pendingImages.push({ name: fn, ...img });
      } catch (err) {
        toolText = JSON.stringify({ error: err.message || String(err) });
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolText.slice(0, 16000),
      });
    }

    if (pendingImages.length) {
      const content = [
        { type: 'text', text: `Images returned by ${pendingImages.map((i) => i.name).join(', ')}:` },
        ...pendingImages.map((img) => ({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.data}` },
        })),
      ];
      messages.push({ role: 'user', content });
    }

    // Early-out if the GLB has already shown up on disk.
    if (glbExistsAndValid(glbPath)) {
      onProgress('GLB detected on disk');
      break;
    }
  }

  if (!glbExistsAndValid(glbPath)) {
    throw new Error(`Agent finished but ${path.basename(glbPath)} is missing or too small`);
  }

  return { glb_url: `/assets/${id}.glb` };
}

function glbExistsAndValid(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size >= MIN_GLB_BYTES;
  } catch {
    return false;
  }
}

function formatMcpResult(result) {
  // MCP returns { content: Array<{type, text|data|...}>, isError? }
  const out = { text: '', images: [] };
  if (!result || !Array.isArray(result.content)) {
    out.text = JSON.stringify(result ?? null);
    return out;
  }
  const textParts = [];
  for (const block of result.content) {
    if (!block) continue;
    if (block.type === 'text') textParts.push(String(block.text ?? ''));
    else if (block.type === 'image' && block.data) {
      out.images.push({ data: block.data, mimeType: block.mimeType || 'image/png' });
      textParts.push('[image attached]');
    } else {
      textParts.push(JSON.stringify(block));
    }
  }
  out.text = textParts.join('\n');
  if (result.isError) out.text = `ERROR: ${out.text}`;
  return out;
}

function shortJson(obj) {
  try {
    const s = JSON.stringify(obj);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  } catch {
    return '...';
  }
}
