import fs from 'node:fs/promises';
import path from 'node:path';
import { Mutex } from 'async-mutex';

const WORLD_FILE = path.resolve('world.json');
const TMP_FILE = `${WORLD_FILE}.tmp`;

const mutex = new Mutex();
let cache = null;

async function load() {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(WORLD_FILE, 'utf8');
    cache = JSON.parse(raw);
  } catch {
    cache = { npcs: [] };
  }
  if (!Array.isArray(cache.npcs)) cache.npcs = [];
  return cache;
}

async function flush() {
  await fs.writeFile(TMP_FILE, JSON.stringify(cache, null, 2));
  await fs.rename(TMP_FILE, WORLD_FILE);
}

export async function getState() {
  return mutex.runExclusive(async () => {
    const w = await load();
    // Return a deep-ish copy so callers can't mutate the cache.
    return { npcs: w.npcs.map((n) => ({ ...n })) };
  });
}

export async function addNpc(npc) {
  return mutex.runExclusive(async () => {
    const w = await load();
    w.npcs.push(npc);
    await flush();
    return { ...npc };
  });
}

export async function updateNpc(id, patch) {
  return mutex.runExclusive(async () => {
    const w = await load();
    const idx = w.npcs.findIndex((n) => n.id === id);
    if (idx === -1) return null;
    const allowed = ['name', 'dialogue', 'position', 'rotation', 'scale', 'glb_url'];
    for (const key of allowed) {
      if (key in patch) w.npcs[idx][key] = patch[key];
    }
    await flush();
    return { ...w.npcs[idx] };
  });
}

export async function deleteNpc(id) {
  return mutex.runExclusive(async () => {
    const w = await load();
    const before = w.npcs.length;
    w.npcs = w.npcs.filter((n) => n.id !== id);
    if (w.npcs.length === before) return false;
    await flush();
    return true;
  });
}
