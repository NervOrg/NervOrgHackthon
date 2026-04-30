import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { v4 as uuid } from 'uuid';

import * as store from './worldStore.js';
import { generateNpc, generatePart } from './codexRunner.js';
import {
  createQueuedGenerationJob,
  getGenerationJob,
  listGenerationEvents,
  listGenerationJobs,
  markGenerationCanceled,
  markGenerationFailed,
  markGenerationProgress,
  markGenerationSucceeded,
} from './generationContract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json());
const staticHeaders = (res) => res.setHeader('Cache-Control', 'no-store');
app.use('/assets', express.static(path.join(__dirname, 'assets'), { setHeaders: staticHeaders }));
app.use('/assets', express.static(path.join(__dirname, 'demo-assets'), { setHeaders: staticHeaders }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/state', async (_req, res) => {
  const state = await store.getState();
  res.json(state);
});

app.get('/health', (_req, res) => {
  const fake = process.env.FAKE_GENERATOR === '1';
  const generator = fake ? 'fake' : (process.env.GENERATOR || 'openai').toLowerCase();
  res.json({ ok: true, generator });
});

app.post('/api/projects/:projectId/generation/jobs', async (req, res) => {
  const job = startNpcGeneration({
    projectId: req.params.projectId,
    prompt: req.body?.prompt,
    position: req.body?.placement?.position ?? req.body?.position,
    rotation: req.body?.placement?.rotation ?? req.body?.rotation,
    scale: req.body?.placement?.scale ?? req.body?.scale,
    source: 'api',
  });
  if (!job) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }
  res.status(202).json({ job });
});

app.get('/api/projects/:projectId/generation/jobs', async (req, res) => {
  const state = await store.getState();
  res.json({ jobs: listGenerationJobs(req.params.projectId, state.npcs) });
});

app.get('/api/projects/:projectId/generation/jobs/:jobId', async (req, res) => {
  const state = await store.getState();
  const job = getGenerationJob(req.params.projectId, req.params.jobId, state.npcs);
  if (!job) {
    res.status(404).json({ error: `Unknown generation job: ${req.params.jobId}` });
    return;
  }
  res.json({ job });
});

app.get('/api/projects/:projectId/generation/jobs/:jobId/events', async (req, res) => {
  const state = await store.getState();
  const job = getGenerationJob(req.params.projectId, req.params.jobId, state.npcs);
  if (!job) {
    res.status(404).json({ error: `Unknown generation job: ${req.params.jobId}` });
    return;
  }
  res.json({ events: listGenerationEvents(req.params.projectId, req.params.jobId, state.npcs) });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', async (ws) => {
  clients.add(ws);
  const state = await store.getState();
  send(ws, { type: 'world_state', npcs: state.npcs });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      await handleClientMessage(msg);
    } catch (err) {
      console.error('Error handling message:', err);
      send(ws, { type: 'error', message: err.message });
    }
  });
});

async function handleClientMessage(msg) {
  switch (msg.type) {
    case 'spawn_npc':
      return spawnNpc(msg);
    case 'spawn_part':
      return spawnPart(msg);
    case 'update_npc':
      return updateExistingNpc(msg);
    case 'update_npc_part':
      return updateExistingNpcPart(msg);
    case 'delete_npc':
      return removeNpc(msg);
    default:
      // ignore unknown messages
      return;
  }
}

async function spawnNpc({ prompt, position, rotation }) {
  startNpcGeneration({ prompt, position, rotation, source: 'ws' });
}

function startNpcGeneration({ prompt, position, rotation, scale = 1, projectId = 'default-project', source = 'ws' }) {
  if (!prompt || typeof prompt !== 'string') return;
  const cleanPrompt = prompt.trim().slice(0, 500);
  if (!cleanPrompt) return;

  const id = `npc_${uuid().slice(0, 8)}`;
  const pos = sanitizeVec3(position, [0, 0, 0]);
  const rot = sanitizeVec3(rotation, [0, 0, 0]);
  const job = createQueuedGenerationJob({
    id,
    projectId,
    prompt: cleanPrompt,
    position: pos,
    rotation: rot,
    scale,
    source,
  });
  const startedAt = Date.now();

  log(id, `▶ spawn "${cleanPrompt}"  pos=[${pos.map((n) => n.toFixed(1)).join(', ')}]`);

  broadcast({ type: 'npc_pending', id, prompt: cleanPrompt, position: pos, rotation: rot });

  void runNpcGeneration({ id, projectId, cleanPrompt, pos, rot, startedAt });
  return job;
}

async function runNpcGeneration({ id, projectId, cleanPrompt, pos, rot, startedAt }) {
  try {
    const { glb_url, animation_count = 0, components = [] } = await generateNpc({
      id,
      prompt: cleanPrompt,
      onProgress: (message) => {
        log(id, message);
        markGenerationProgress(id, message);
        broadcast({ type: 'npc_progress', id, message });
      },
    });

    const npc = {
      id,
      prompt: cleanPrompt,
      glb_url,
      position: pos,
      rotation: rot,
      scale: 1.0,
      movement_paused: false,
      animation_count,
      components,
      name: defaultNameFromPrompt(cleanPrompt),
      dialogue: ['Hello, traveler.'],
      created_at: new Date().toISOString(),
    };
    await store.addNpc(npc);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(id, `✓ ready in ${elapsed}s  glb_url=${glb_url ?? '(none — fake mode)'}`);
    markGenerationSucceeded(id, npc);
    broadcast({ type: 'npc_ready', npc });
  } catch (err) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(id, `✗ FAILED after ${elapsed}s: ${err.message || err}`);
    if (err && err.stack) console.error(err.stack);
    markGenerationFailed(id, err);
    broadcast({ type: 'npc_failed', id, error: err.message || String(err) });
  }
  void projectId;
}

async function spawnPart({ npcId, partId, prompt }) {
  if (!npcId || typeof partId !== 'string' || !partId || !prompt || typeof prompt !== 'string') return;
  const cleanPrompt = prompt.trim().slice(0, 500);
  if (!cleanPrompt) return;

  const state = await store.getState();
  const npc = state.npcs.find((entry) => entry.id === npcId);
  if (!npc) return;

  const component = Array.isArray(npc.components)
    ? npc.components.find((entry) => entry.partId === partId)
    : null;
  const partName = component?.name ?? partId;

  log(npcId, `▶ spawn_part "${partId}" prompt="${cleanPrompt}"`);
  broadcast({ type: 'npc_part_pending', id: npcId, partId });

  try {
    const { glb_url } = await generatePart({
      npcId,
      partId,
      partName,
      prompt: cleanPrompt,
      onProgress: (message) => log(npcId, `  [part:${partId}] ${message}`),
    });

    if (glb_url) {
      await store.updateNpcPartGlb(npcId, partId, glb_url);
    }

    log(npcId, `✓ part ready  glb_url=${glb_url ?? '(fake)'}`);
    broadcast({ type: 'npc_part_ready', id: npcId, partId, glb_url });
  } catch (err) {
    log(npcId, `✗ part FAILED: ${err.message || err}`);
    broadcast({ type: 'npc_part_failed', id: npcId, partId, error: err.message || String(err) });
  }
}

function log(id, msg) {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  console.log(`[${ts}] [${id}] ${msg}`);
}

async function updateExistingNpc({ id, patch }) {
  if (!id || !patch || typeof patch !== 'object') return;
  const safePatch = {};
  if (typeof patch.name === 'string') safePatch.name = patch.name.slice(0, 80);
  if (Array.isArray(patch.dialogue)) {
    safePatch.dialogue = patch.dialogue
      .filter((s) => typeof s === 'string')
      .map((s) => s.slice(0, 500))
      .slice(0, 50);
  }
  if (Array.isArray(patch.position)) safePatch.position = sanitizeVec3(patch.position, null);
  if (Array.isArray(patch.rotation)) safePatch.rotation = sanitizeVec3(patch.rotation, null);
  if (typeof patch.scale === 'number' && Number.isFinite(patch.scale)) {
    safePatch.scale = clamp(patch.scale, 0.05, 50);
  }
  if (typeof patch.movement_paused === 'boolean') {
    safePatch.movement_paused = patch.movement_paused;
  }
  if (Object.keys(safePatch).length === 0) return;

  const updated = await store.updateNpc(id, safePatch);
  if (updated) {
    broadcast({ type: 'npc_updated', id, patch: safePatch });
  }
}

async function updateExistingNpcPart({ id, partId, patch }) {
  if (!id || !partId || !patch || typeof patch !== 'object') return;
  const result = await store.updateNpcPart(id, partId, patch);
  if (result) {
    broadcast({ type: 'npc_part_updated', id: result.id, partId: result.partId, patch: result.patch });
  }
}

async function removeNpc({ id }) {
  if (!id) return;
  const ok = await store.deleteNpc(id);
  if (ok) {
    markGenerationCanceled(id);
    broadcast({ type: 'npc_deleted', id });
  }
}

function sanitizeVec3(v, fallback) {
  if (!Array.isArray(v) || v.length !== 3) return fallback;
  const out = v.map((n) => (Number.isFinite(n) ? Number(n) : 0));
  return out;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function defaultNameFromPrompt(prompt) {
  const words = prompt.split(/\s+/).slice(0, 3).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

server.listen(PORT, () => {
  const fake = process.env.FAKE_GENERATOR === '1';
  const generator = fake ? 'fake' : (process.env.GENERATOR || 'openai').toLowerCase();
  console.log('────────────────────────────────────────────────────────────');
  console.log(` edu3d server  →  http://localhost:${PORT}`);
  console.log(`  generator: ${generator}`);
  if (generator === 'fake') {
    console.log('  ⚠  FAKE mode — placeholder only, no OpenAI/Blender calls.');
    console.log('     Stop with Ctrl+C and run `npm start` for real generation.');
  } else if (generator === 'openai') {
    console.log(`  model:     ${process.env.OPENAI_MODEL || 'gpt-4.1'}`);
    console.log(`  mcp:       ${process.env.MCP_CMD || 'uvx'} ${process.env.MCP_ARGS || 'blender-mcp'}`);
    if (!process.env.OPENAI_API_KEY) {
      console.log('  ⚠  OPENAI_API_KEY is not set — every spawn will fail until it is.');
    }
  }
  console.log('────────────────────────────────────────────────────────────');

  if (!fake) {
    import('./mcpClient.js').then(({ getMcpClient, listMcpTools }) =>
      getMcpClient()
        .then(() => listMcpTools())
        .then((tools) => console.log(`  Blender MCP: connected ✓  (${tools.length} tools)`))
        .catch((err) => {
          console.log('  Blender MCP: not connected ✗');
          console.log('    → Open Blender and enable the blender-mcp addon, then spawns will work.');
          console.log(`    → (${err.message || err})`);
        })
    );
  }
});
