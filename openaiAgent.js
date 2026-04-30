import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';

import { getMcpClient, listMcpTools, callMcpTool, toOpenAITools } from './mcpClient.js';
import { formatValidationForProgress, validateGeneratedGlb } from './generationQualityGate.js';
import { inspectGlb } from './glbInspector.js';

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
- If the import creates multiple objects, parent/group the complete imported hierarchy and select every visible mesh/armature/empty that belongs to the requested model before export. Do not export a single child mesh unless it is the entire model.
- Use Blender's GLTF export with format='GLB' and use_selection=True so only the requested model ships out (other objects in the scene may be reused by future requests — DO NOT delete them).
- When the requested asset can plausibly move, create at least one short looping animation action (idle, hover, spin, walk-in-place, engine rock, or similar) using Blender keyframes, bones, or object transforms.
- Export animation data in the GLB: set export_animations=True, export_skins=True, and export_bake_animation=True when calling bpy.ops.export_scene.gltf.
- Keep the exported model under 50,000 polygons.
- Name every distinct part of the model as a separate mesh object using the pattern
  ModelType_PartName (e.g. Witch_Hat, Witch_Robe, Car_Wheel_FL). Do not merge
  separate logical parts into one mesh. Each part the user might customise must be
  its own named object.
- After the GLB file exists at the path above, you are done. End your turn with a brief summary message and no further tool calls.
- If you cannot fulfil the request, end your turn with a short message starting with "ERROR:" describing why — do not silently give up.
────────────────────────────────────────────
`.trimStart();

const PART_REQUIREMENTS_TEMPLATE = `

────────────────────────────────────────────
PART GENERATION REQUIREMENTS (the system enforces these — do not deviate):
- Job ID: {{jobId}}
- You are generating a SINGLE REPLACEMENT PART, not a full character.
- The part being replaced: {{partName}} (partId: {{partId}})
- The part belongs to NPC: {{npcId}}
- Create only the described part in isolation. Do not recreate the full character.
- Keep the part centred at the world origin with the base/bottom at Y=0 and facing -Z.
- Apply all transforms before export.
- Export as GLB to EXACTLY this path:
    {{glbPath}}
- Use Blender's GLTF export with format='GLB' and use_selection=True.
- Name the mesh object using the convention: {{npcType}}_{{partName}} (e.g. Witch_Hat, Car_Wheel_FL).
- Keep the part under 10,000 polygons.
- Do NOT create animations for a replacement part unless the prompt specifically requests motion.
- After the GLB exists at the path above, end your turn with a short summary. No further tool calls.
- If you cannot fulfil the request, end your turn with a message starting with "ERROR:".
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
  const animationPart = buildAnimationPrompt(prompt);
  const requirements = SERVER_REQUIREMENTS_TEMPLATE
    .replaceAll('{{glbPath}}', glbPath)
    .replaceAll('{{jobId}}', jobId);
  return userPart + '\n\n' + animationPart + '\n' + requirements;
}

function buildPartSystemPrompt({ template, prompt, jobId, glbPath, npcId, partId, partName }) {
  const npcType = npcId.split('_').slice(1).join('_') || 'Npc';
  const requirements = PART_REQUIREMENTS_TEMPLATE
    .replaceAll('{{jobId}}', jobId)
    .replaceAll('{{glbPath}}', glbPath)
    .replaceAll('{{npcId}}', npcId)
    .replaceAll('{{partId}}', partId)
    .replaceAll('{{partName}}', partName)
    .replaceAll('{{npcType}}', npcType);
  return template.replaceAll('{{prompt}}', prompt) + '\n\n' + requirements;
}

function buildAnimationPrompt(prompt) {
  return [
    'ANIMATION FROM PROMPT:',
    '- Treat animation words in the user prompt as hard creative requirements, not optional polish.',
    '- If the user asks for waving, walking, dancing, spinning, breathing, hovering, pulsing, attacking, driving, flying, or any other motion, create that exact motion as a short seamless looping Blender action.',
    '- Name the primary action clearly, such as Idle, Wave, Walk, Hover, Spin, Dance, Drive, Fly, or Attack.',
    '- If the prompt does not specify motion but the asset can plausibly move, create a subtle Idle loop.',
    '- Prefer simple reliable keyframed object, bone, or shape-key animation over complex rigs that may fail to export.',
    `- User prompt to interpret for animation intent: "${prompt}"`,
  ].join('\n');
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
  const blenderGlbPath = toBlenderPath(glbPath);
  await fsp.rm(glbPath, { force: true });

  // Make sure MCP is up before we consume any OpenAI tokens.
  onProgress('Connecting to Blender (MCP)...');
  await getMcpClient();
  const mcpTools = await listMcpTools();
  if (mcpTools.length === 0) {
    throw new Error('Blender MCP server reported zero tools — is Blender running with the addon enabled?');
  }
  await assertBlenderReady();
  onProgress(`MCP ready (${mcpTools.length} tools)`);

  const openaiTools = toOpenAITools(mcpTools);
  const template = await loadSystemPromptTemplate();
  const systemPrompt = buildSystemPrompt({ template, prompt, jobId: id, glbPath: blenderGlbPath });

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || 'gpt-4.1';
  const maxSteps = Number(process.env.OPENAI_MAX_STEPS || 80);
  const repairAttempts = clampNonNegativeInt(process.env.GENERATION_REPAIR_ATTEMPTS, 1);
  const repairMaxSteps = clampNonNegativeInt(process.env.GENERATION_REPAIR_MAX_STEPS, Math.max(10, Math.ceil(maxSteps / 2)));

  /** @type {any[]} */
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Build the requested scene now: ${prompt}` },
  ];

  await runAgentLoop({ client, model, messages, openaiTools, glbPath, maxSteps, onProgress, phase: 'generation' });

  if (!glbExistsAndValid(glbPath)) {
    throw new Error(`Agent finished but ${path.basename(glbPath)} is missing or too small`);
  }
  let validation = await validateGeneratedGlb(glbPath, { prompt });
  for (let attempt = 0; !validation.ok && attempt < repairAttempts; attempt++) {
    onProgress(formatValidationForProgress(validation));
    onProgress(`quality gate failed; repairing model (${attempt + 1}/${repairAttempts})...`);
    await fsp.rm(glbPath, { force: true });
    messages.push({
      role: 'user',
      content: buildRepairPrompt({
        prompt,
        glbPath: blenderGlbPath,
        issues: validation.issues,
        warnings: validation.warnings,
      }),
    });
    await runAgentLoop({
      client,
      model,
      messages,
      openaiTools,
      glbPath,
      maxSteps: repairMaxSteps,
      onProgress,
      phase: `repair ${attempt + 1}`,
    });
    if (!glbExistsAndValid(glbPath)) {
      throw new Error(`Repair attempt ${attempt + 1} finished but ${path.basename(glbPath)} is missing or too small`);
    }
    validation = await validateGeneratedGlb(glbPath, { prompt });
  }
  onProgress(formatValidationForProgress(validation));
  if (!validation.ok) {
    throw new Error(`Generated GLB failed quality gate after ${repairAttempts} repair attempt(s): ${validation.issues.join(' ')}`);
  }

  const animationCount = countGlbAnimations(glbPath);
  onProgress(animationCount > 0
    ? `GLB contains ${animationCount} animation clip(s)`
    : 'GLB contains no animation clips; browser procedural motion will be used');

  let components = [];
  try {
    const inspection = await inspectGlb(glbPath);
    components = buildComponentManifest(inspection);
    onProgress(
      components.length > 0
        ? `Found ${components.length} named part(s): ${components.map((component) => component.name).join(', ')}`
        : 'No named parts found in GLB; components list will be empty'
    );
  } catch (inspectErr) {
    onProgress(`Part manifest extraction failed: ${inspectErr.message}`);
  }

  return { glb_url: `/assets/${id}.glb`, animation_count: animationCount, components };
}

async function runAgentLoop({ client, model, messages, openaiTools, glbPath, maxSteps, onProgress, phase }) {
  for (let step = 0; step < maxSteps; step++) {
    const prefix = phase ? `${phase}: ` : '';
    onProgress(`${prefix}thinking (step ${step + 1}/${maxSteps})...`);

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
}

function buildRepairPrompt({ prompt, glbPath, issues, warnings }) {
  return [
    `The generated GLB for "${prompt}" failed backend quality validation.`,
    '',
    'Validation issues:',
    ...issues.map((issue) => `- ${issue}`),
    ...(warnings.length ? ['', 'Validation warnings:', ...warnings.map((warning) => `- ${warning}`)] : []),
    '',
    'Repair the existing Blender scene now. Do not start from scratch unless needed.',
    'Fix the component assembly, transforms, scale, root hierarchy, and export selection.',
    `Re-export the repaired model to EXACTLY this path: ${glbPath}`,
    'After the repaired GLB exists at that path, stop making tool calls and briefly summarize the repair.',
  ].join('\n');
}

export async function generatePart({ npcId, partId, partName = partId, prompt, onProgress = () => {} }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  await fsp.mkdir(ASSETS_DIR, { recursive: true });

  const jobId = `${npcId}_${partId}`;
  const glbPath = path.join(ASSETS_DIR, `${jobId}.glb`);
  await fsp.rm(glbPath, { force: true });

  onProgress('Connecting to Blender (MCP) for part generation...');
  await getMcpClient();
  const mcpTools = await listMcpTools();
  if (mcpTools.length === 0) {
    throw new Error('Blender MCP server reported zero tools — is Blender running with the addon enabled?');
  }
  await assertBlenderReady();
  onProgress(`MCP ready (${mcpTools.length} tools)`);

  const openaiTools = toOpenAITools(mcpTools);
  const template = await loadSystemPromptTemplate();
  const systemPrompt = buildPartSystemPrompt({ template, prompt, jobId, glbPath, npcId, partId, partName });

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || 'gpt-4.1';
  const maxSteps = Number(process.env.OPENAI_MAX_STEPS || 40);

  /** @type {any[]} */
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Generate the replacement part now: ${prompt}` },
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
    messages.push(msg);

    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) {
      const content = (msg.content || '').toString().trim();
      if (content.startsWith('ERROR:')) throw new Error(content.slice(6).trim() || 'agent reported error');
      onProgress(content ? content.slice(0, 200) : '(agent finished)');
      break;
    }

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

    if (glbExistsAndValid(glbPath)) {
      onProgress('Part GLB detected on disk');
      break;
    }
  }

  if (!glbExistsAndValid(glbPath)) {
    throw new Error(`Part agent finished but ${path.basename(glbPath)} is missing or too small`);
  }

  return { glb_url: `/assets/${jobId}.glb` };
}

async function assertBlenderReady() {
  let result;
  try {
    result = await callMcpTool('get_scene_info', {
      user_prompt: 'edu3d Blender readiness check',
    });
  } catch (err) {
    throw new Error(`Blender MCP is not connected to Blender: ${err.message || String(err)}`);
  }

  const { text } = formatMcpResult(result);
  if (result?.isError || /could not connect|connection refused|addon is running/i.test(text)) {
    throw new Error(`Blender MCP is not connected to Blender: ${text.slice(0, 300)}`);
  }
}

function glbExistsAndValid(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size >= MIN_GLB_BYTES;
  } catch {
    return false;
  }
}

function toBlenderPath(p) {
  const normalized = path.resolve(p).replaceAll('\\', '/');
  const match = normalized.match(/^\/mnt\/([a-zA-Z])\/(.+)$/);
  if (!match) return normalized;
  return `${match[1].toUpperCase()}:/${match[2]}`;
}

function clampNonNegativeInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

export function buildComponentManifest(report) {
  const nodes = report.bounds?.nodes ?? [];
  const named = nodes.filter((entry) => entry.nodeName && entry.nodeName.trim());
  const source = named.length > 0 ? named : nodes;

  return source.map((entry) => ({
    partId: slugifyPartId(entry.nodeName || `part_${entry.meshIndex ?? 0}`),
    name: humanizePartName(entry.nodeName || `Part ${entry.meshIndex ?? 0}`),
    meshIndex: entry.meshIndex ?? null,
    bounds: entry.worldBounds ?? null,
  }));
}

export function slugifyPartId(value) {
  return String(value)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'part';
}

export function humanizePartName(value) {
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function countGlbAnimations(p) {
  try {
    const data = fs.readFileSync(p);
    if (data.toString('ascii', 0, 4) !== 'glTF') return 0;
    const jsonLength = data.readUInt32LE(12);
    const jsonType = data.toString('ascii', 16, 20);
    if (jsonType !== 'JSON') return 0;
    const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8'));
    return Array.isArray(json.animations) ? json.animations.length : 0;
  } catch {
    return 0;
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
