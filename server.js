import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { v4 as uuid } from 'uuid';

import * as store from './worldStore.js';
import { generateNpc } from './codexRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'assets'), {
  fallthrough: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));
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
    case 'update_npc':
      return updateExistingNpc(msg);
    case 'delete_npc':
      return removeNpc(msg);
    default:
      // ignore unknown messages
      return;
  }
}

async function spawnNpc({ prompt, position, rotation }) {
  if (!prompt || typeof prompt !== 'string') return;
  const cleanPrompt = prompt.trim().slice(0, 500);
  if (!cleanPrompt) return;

  const id = `npc_${uuid().slice(0, 8)}`;
  const pos = sanitizeVec3(position, [0, 0, 0]);
  const rot = sanitizeVec3(rotation, [0, 0, 0]);
  const startedAt = Date.now();

  log(id, `▶ spawn "${cleanPrompt}"  pos=[${pos.map((n) => n.toFixed(1)).join(', ')}]`);

  broadcast({ type: 'npc_pending', id, prompt: cleanPrompt, position: pos, rotation: rot });

  try {
    const { glb_url } = await generateNpc({
      id,
      prompt: cleanPrompt,
      onProgress: (message) => {
        log(id, message);
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
      name: defaultNameFromPrompt(cleanPrompt),
      dialogue: ['Hello, traveler.'],
      created_at: new Date().toISOString(),
    };
    await store.addNpc(npc);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(id, `✓ ready in ${elapsed}s  glb_url=${glb_url ?? '(none — fake mode)'}`);
    broadcast({ type: 'npc_ready', npc });
  } catch (err) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(id, `✗ FAILED after ${elapsed}s: ${err.message || err}`);
    if (err && err.stack) console.error(err.stack);
    broadcast({ type: 'npc_failed', id, error: err.message || String(err) });
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
  if (Object.keys(safePatch).length === 0) return;

  const updated = await store.updateNpc(id, safePatch);
  if (updated) {
    broadcast({ type: 'npc_updated', id, patch: safePatch });
  }
}

async function removeNpc({ id }) {
  if (!id) return;
  const ok = await store.deleteNpc(id);
  if (ok) broadcast({ type: 'npc_deleted', id });
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
});
