import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';

import { getMcpClient, listMcpTools, callMcpTool, toOpenAITools } from './mcpClient.js';

const ASSETS_DIR = path.resolve('assets');
const SYSTEM_PROMPT_FILE = path.resolve('config/systemPrompt.txt');
const MIN_GLB_BYTES = 1024;
const MIN_PART_MESHES = 2;
const MIN_MATERIAL_COLORS = 2;

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
- Blender is reset before each job, and previous web NPCs are preserved as GLB files in /assets, not as live Blender scene objects.
- Before creating Blender geometry, make an explicit real-world reference plan: describe the requested asset's normal visible components and plausible component colors/materials, then build from that plan.
- Infer the real-world components of the requested asset before modeling, then create those components as separate named Blender objects/mesh nodes. Keep names user-facing and specific, such as Head, Torso, Left_Arm, Right_Wheel, Hull, Sail, Window, or Door.
- Do not join, merge, or collapse the component meshes into one final mesh. The final GLB must contain multiple named mesh nodes so the browser can raycast-select and edit each part independently.
- If an imported/downloaded model arrives as a single mesh, split it into meaningful loose parts when possible or rebuild a simplified multi-part version. Do not export a one-mesh opaque asset.
- Assign every component mesh at least one named Blender material with a visible base color before export. Use plausible real-world colors/materials for the requested asset; do not leave any mesh with an unassigned/default material slot, and do not use one generic grey/white material for all parts.
- Use Blender's GLTF export with format='GLB' and use_selection=True so only the requested model ships out.
- Export materials in the GLB: set export_materials='EXPORT' when calling bpy.ops.export_scene.gltf.
- Before export, clear selection and select only the visible meshes/armatures/empties that belong to this job's requested model.
- When the requested asset can plausibly move, create at least one short looping animation action (idle, hover, spin, walk-in-place, engine rock, or similar) using Blender keyframes, bones, or object transforms.
- For multi-part models, parent all visible components under one root before keyframing. Animate the root for whole-model motion, or animate multiple actual moving components. Do not animate only one isolated mesh unless it is the parent of all other visible parts.
- Export animation data in the GLB: set export_animations=True, export_skins=True, and export_bake_animation=True when calling bpy.ops.export_scene.gltf.
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
  const animationPart = buildAnimationPrompt(prompt);
  const requirements = SERVER_REQUIREMENTS_TEMPLATE
    .replaceAll('{{glbPath}}', glbPath)
    .replaceAll('{{jobId}}', jobId);
  return userPart + '\n\n' + animationPart + '\n' + requirements;
}

function buildAnimationPrompt(prompt) {
  return [
    'ANIMATION FROM PROMPT:',
    '- Treat animation words in the user prompt as hard creative requirements, not optional polish.',
    '- If the user asks for waving, walking, dancing, spinning, breathing, hovering, pulsing, attacking, driving, flying, or any other motion, create that exact motion as a short seamless looping Blender action.',
    '- Name the primary action clearly, such as Idle, Wave, Walk, Hover, Spin, Dance, Drive, Fly, or Attack.',
    '- If the prompt does not specify motion but the asset can plausibly move, create a subtle Idle loop.',
    '- For multi-part models, parent every visible component under one root before keyframing. Animate the root for whole-model idle motion, or animate multiple named moving parts for local motion.',
    '- Do not animate only one isolated component unless every other visible component is parented under that animated component.',
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
  await fsp.rm(glbPath, { force: true });

  // Make sure MCP is up before we consume any OpenAI tokens.
  onProgress('Connecting to Blender (MCP)...');
  await getMcpClient();
  const mcpTools = await listMcpTools();
  if (mcpTools.length === 0) {
    throw new Error('Blender MCP server reported zero tools — is Blender running with the addon enabled?');
  }
  await assertBlenderReady();
  await resetBlenderSceneForJob(id, onProgress);
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
      const partInspection = inspectGlbParts(glbPath);
      if (partInspection.valid) {
        onProgress(`GLB detected with ${partInspection.meshCount} component mesh node(s), ${partInspection.materialCount} material(s), and ${partInspection.distinctColorCount} distinct color(s)`);
        break;
      }

      await fsp.rm(glbPath, { force: true });
      onProgress(`GLB failed component/material validation; asking agent to fix it`);
      messages.push({
        role: 'user',
        content: [
          `The exported GLB had only ${partInspection.meshCount} mesh node(s): ${partInspection.names.join(', ') || '(none)'}.`,
          `It had ${partInspection.materialCount} material(s), ${partInspection.distinctColorCount} distinct color(s), ${partInspection.neutralMaterialCount} neutral/default material color(s), and ${partInspection.unassignedPrimitiveCount} mesh primitive(s) without assigned materials.`,
          `Its animation targets were: ${partInspection.animationTargetNames.join(', ') || '(none)'}. Root-targeted animation: ${partInspection.animationTargetsRoot ? 'yes' : 'no'}.`,
          'This is not acceptable for part editing or visual display.',
          'Research/infer the real-world appearance first, then rebuild or split the asset into multiple semantic named Blender mesh objects, parent them under one root, assign plausible non-default named material/base colors to every mesh primitive, and export again to the exact same GLB path.',
          'Do not join the parts into one mesh. Do not export any mesh without a material. Do not use one generic grey/white material for the whole model.',
          'For animation, keyframe the common root or multiple actual moving parts. Do not animate only one isolated body mesh while the rest of the parts are siblings.',
        ].join('\n'),
      });
    }
  }

  if (!glbExistsAndValid(glbPath)) {
    await repairExportCurrentScene({ id, glbPath, onProgress });
  }

  if (!glbExistsAndValid(glbPath)) {
    throw new Error(`Agent finished but ${path.basename(glbPath)} is missing or too small after repair export`);
  }

  const partInspection = inspectGlbParts(glbPath);
  if (partInspection.meshCount < MIN_PART_MESHES) {
    throw new Error(`Generated GLB has only ${partInspection.meshCount} component mesh node(s); expected multiple named parts for editing`);
  }
  if (partInspection.unassignedPrimitiveCount > 0) {
    throw new Error(`Generated GLB has ${partInspection.unassignedPrimitiveCount} mesh primitive(s) without assigned materials`);
  }
  if (partInspection.materialCount < partInspection.requiredMaterialCount) {
    throw new Error(`Generated GLB has only ${partInspection.materialCount} material(s); expected at least ${partInspection.requiredMaterialCount} plausible component material(s)`);
  }
  if (partInspection.distinctColorCount < MIN_MATERIAL_COLORS) {
    throw new Error(`Generated GLB has only ${partInspection.distinctColorCount} distinct material color(s); expected real component colors`);
  }
  if (!partInspection.animationValid) {
    throw new Error(`Generated GLB animation targets only an isolated part (${partInspection.animationTargetNames.join(', ') || 'none'}); expected root animation or multiple moving components`);
  }

  const animationCount = partInspection.animationCount;
  onProgress(`GLB contains ${partInspection.meshCount} editable component mesh node(s), ${partInspection.materialCount} material(s), and ${partInspection.distinctColorCount} distinct color(s)`);
  onProgress(animationCount > 0
    ? `GLB contains ${animationCount} animation clip(s)`
    : 'GLB contains no animation clips; browser procedural motion will be used');

  return { glb_url: `/assets/${id}.glb`, animation_count: animationCount };
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

async function resetBlenderSceneForJob(id, onProgress) {
  onProgress('Resetting Blender scene for this job...');
  const code = `
import bpy

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

for collection in (
    bpy.data.meshes,
    bpy.data.materials,
    bpy.data.images,
    bpy.data.armatures,
    bpy.data.actions,
):
    for item in list(collection):
        if item.users == 0:
            collection.remove(item)
`.trim();

  const result = await callMcpTool('execute_blender_code', {
    code,
    user_prompt: `reset Blender scene for ${id}`,
  });
  const { text } = formatMcpResult(result);
  if (result?.isError || /error|traceback/i.test(text)) {
    throw new Error(`Could not reset Blender scene: ${text.slice(0, 500)}`);
  }
}

async function repairExportCurrentScene({ id, glbPath, onProgress }) {
  onProgress('Repairing GLB export from current Blender scene...');
  const exportPath = glbPath.replaceAll('\\', '/');
  const code = `
import bpy

EXPORT_PATH = ${JSON.stringify(exportPath)}

def color_from_name(name):
    seed = sum((index + 1) * ord(char) for index, char in enumerate(name))
    hue = (seed % 360) / 360.0
    import colorsys
    r, g, b = colorsys.hsv_to_rgb(hue, 0.55, 0.82)
    return (r, g, b, 1.0)

def ensure_material(obj):
    if obj.type != 'MESH' or not obj.data:
        return
    if not obj.data.materials:
        mat = bpy.data.materials.new(f"{obj.name}_Material")
        mat.diffuse_color = color_from_name(obj.name)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get('Principled BSDF')
        if bsdf:
            bsdf.inputs['Base Color'].default_value = mat.diffuse_color
            bsdf.inputs['Roughness'].default_value = 0.65
        obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        if poly.material_index < 0 or poly.material_index >= len(obj.data.materials):
            poly.material_index = 0

def visible_meshes():
    meshes = []
    for obj in bpy.context.scene.objects:
        if obj.type == 'MESH' and not obj.hide_get() and obj.visible_get():
            meshes.append(obj)
    return meshes

meshes = visible_meshes()
if not meshes:
    raise RuntimeError('No visible mesh objects available for GLB repair export')

for obj in meshes:
    ensure_material(obj)

bpy.ops.object.select_all(action='DESELECT')
selected = set(meshes)
for mesh in meshes:
    parent = mesh.parent
    while parent:
        if parent.type in {'EMPTY', 'ARMATURE'} and not parent.hide_get() and parent.visible_get():
            selected.add(parent)
        parent = parent.parent

for obj in selected:
    obj.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.export_scene.gltf(
    filepath=EXPORT_PATH,
    export_format='GLB',
    use_selection=True,
    export_materials='EXPORT',
    export_animations=True,
    export_skins=True,
    export_bake_animation=True
)
`.trim();

  const result = await callMcpTool('execute_blender_code', {
    code,
    user_prompt: `repair GLB export for ${id}`,
  });
  const { text } = formatMcpResult(result);
  if (result?.isError || /error|traceback|runtimeerror/i.test(text)) {
    throw new Error(`Could not repair GLB export: ${text.slice(0, 500)}`);
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

function inspectGlbParts(p) {
  try {
    const json = readGlbJson(p);
    const names = (json.nodes || [])
      .filter((node) => Number.isInteger(node.mesh))
      .map((node, index) => String(node.name || `part_${index + 1}`));
    const materials = Array.isArray(json.materials) ? json.materials : [];
    const materialColors = materials.map((material) => materialBaseColor(material));
    const distinctColorCount = new Set(materialColors.map((color) => colorKey(color))).size;
    const neutralMaterialCount = materialColors.filter((color) => isNeutralDefaultColor(color)).length;
    let primitiveCount = 0;
    let unassignedPrimitiveCount = 0;
    for (const mesh of json.meshes || []) {
      for (const primitive of mesh.primitives || []) {
        primitiveCount++;
        if (!Number.isInteger(primitive.material)) unassignedPrimitiveCount++;
      }
    }
    const requiredMaterialCount = Math.min(3, Math.max(MIN_MATERIAL_COLORS, names.length));
    const animationInspection = inspectGlbAnimation(json);
    return {
      meshCount: names.length,
      names,
      materialCount: materials.length,
      requiredMaterialCount,
      distinctColorCount,
      neutralMaterialCount,
      primitiveCount,
      unassignedPrimitiveCount,
      ...animationInspection,
      valid: names.length >= MIN_PART_MESHES
        && unassignedPrimitiveCount === 0
        && materials.length >= requiredMaterialCount
        && distinctColorCount >= MIN_MATERIAL_COLORS
        && neutralMaterialCount < materials.length
        && animationInspection.animationValid,
    };
  } catch {
    return {
      meshCount: 0,
      names: [],
      materialCount: 0,
      requiredMaterialCount: MIN_MATERIAL_COLORS,
      distinctColorCount: 0,
      neutralMaterialCount: 0,
      primitiveCount: 0,
      unassignedPrimitiveCount: 0,
      animationCount: 0,
      animatedNodeCount: 0,
      animationTargetNames: [],
      animationTargetsRoot: false,
      animationValid: true,
      valid: false,
    };
  }
}

function inspectGlbAnimation(json) {
  const animations = Array.isArray(json.animations) ? json.animations : [];
  if (animations.length === 0) {
    return {
      animationCount: 0,
      animatedNodeCount: 0,
      animationTargetNames: [],
      animationTargetsRoot: false,
      animationValid: true,
    };
  }

  const targetNodeIndexes = new Set();
  for (const animation of animations) {
    for (const channel of animation.channels || []) {
      if (Number.isInteger(channel?.target?.node)) {
        targetNodeIndexes.add(channel.target.node);
      }
    }
  }

  const meshNodeIndexes = new Set(
    (json.nodes || [])
      .map((node, index) => (Number.isInteger(node.mesh) ? index : null))
      .filter((index) => index !== null)
  );
  const rootIndexes = new Set((json.scenes?.[json.scene || 0]?.nodes || []).filter(Number.isInteger));
  const animationTargetsRoot = [...targetNodeIndexes].some((index) => rootIndexes.has(index));
  const animatedMeshTargetCount = [...targetNodeIndexes].filter((index) => meshNodeIndexes.has(index)).length;
  const animationTargetNames = [...targetNodeIndexes].map((index) => json.nodes?.[index]?.name || `node_${index}`);

  return {
    animationCount: animations.length,
    animatedNodeCount: targetNodeIndexes.size,
    animationTargetNames,
    animationTargetsRoot,
    animationValid: animationTargetsRoot || animatedMeshTargetCount !== 1 || meshNodeIndexes.size <= 1,
  };
}

function materialBaseColor(material) {
  const factor = material?.pbrMetallicRoughness?.baseColorFactor;
  return Array.isArray(factor) ? factor.slice(0, 3).map(Number) : [1, 1, 1];
}

function colorKey(color) {
  return color.map((channel) => Math.round(Math.max(0, Math.min(1, channel)) * 10)).join(',');
}

function isNeutralDefaultColor(color) {
  const [r, g, b] = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max <= 0 ? 0 : (max - min) / max;
  const isGrey = saturation < 0.08;
  const isDefaultWhiteOrGrey = min > 0.72 && max < 1.01;
  return isGrey && isDefaultWhiteOrGrey;
}

function readGlbJson(p) {
  const data = fs.readFileSync(p);
  if (data.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB file');
  const jsonLength = data.readUInt32LE(12);
  const jsonType = data.toString('ascii', 16, 20);
  if (jsonType !== 'JSON') throw new Error('GLB JSON chunk missing');
  return JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8'));
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
