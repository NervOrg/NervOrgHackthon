/*
 * Generator dispatcher.
 *
 * Picks a backend at request time based on env vars:
 *   - FAKE_GENERATOR=1                     → fake (instant placeholder, no Blender)
 *   - GENERATOR=openai (default)           → OpenAI agent loop + Blender MCP
 *   - GENERATOR=codex                      → Codex CLI + Blender MCP (legacy path)
 *
 * The exported `generateNpc` keeps the same signature so server.js doesn't
 * need to know which backend is in use.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { buildComponentManifest, generateWithOpenAI } from './openaiAgent.js';
import { formatValidationForProgress, validateGeneratedGlb } from './generationQualityGate.js';
import { inspectGlb } from './glbInspector.js';

const ASSETS_DIR = path.resolve('assets');
const JOBS_DIR = path.resolve('jobs');

const TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 15 * 60 * 1000);
const POLL_MS = 1500;
const MIN_GLB_BYTES = 1024;

/**
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.prompt
 * @param {(msg: string) => void} [opts.onProgress]
 * @returns {Promise<{ glb_url: string | null, animation_count?: number, components: Array<object> }>}
 */
export async function generateNpc(opts) {
  await fsp.mkdir(ASSETS_DIR, { recursive: true });
  await fsp.mkdir(JOBS_DIR, { recursive: true });

  if (process.env.FAKE_GENERATOR === '1') return normalizeGenerationResult(await fakeGenerate(opts));

  const backend = (process.env.GENERATOR || 'openai').toLowerCase();
  if (backend === 'openai') return normalizeGenerationResult(await withTimeout(generateWithOpenAI(opts), TIMEOUT_MS));
  if (backend === 'codex') return normalizeGenerationResult(await withTimeout(generateWithCodex(opts), TIMEOUT_MS));
  throw new Error(`Unknown GENERATOR=${backend}`);
}

function normalizeGenerationResult(result) {
  return {
    ...result,
    components: Array.isArray(result?.components) ? result.components : [],
  };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Generation timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Fake generator (FAKE_GENERATOR=1) — useful for UI work without Blender.
// ---------------------------------------------------------------------------

async function fakeGenerate({ id, prompt, onProgress = () => {} }) {
  onProgress('FAKE_GENERATOR active');
  const delaySec = Number(process.env.FAKE_DELAY_SEC || 3);
  for (let i = 0; i < delaySec; i++) {
    onProgress(`Pretending to render... ${i + 1}/${delaySec}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  void prompt;
  const glbPath = path.join(ASSETS_DIR, `${id}.glb`);
  if (fs.existsSync(glbPath)) await fsp.rm(glbPath, { force: true });
  return { glb_url: null, animation_count: 0, components: [] };
}

// ---------------------------------------------------------------------------
// Codex generator (GENERATOR=codex) — kept for compatibility / fallback.
// ---------------------------------------------------------------------------

function buildCodexPrompt({ id, prompt, glbPath, statusPath }) {
  return [
    `Use the blender-mcp tools to create the requested 3D asset based on this description: "${prompt}".`,
    'The request may be a character, vehicle, prop, building, creature, group, or abstract object. Build the requested thing directly.',
    '',
    'Animation from prompt:',
    '- Treat animation words in the prompt as hard requirements.',
    '- If the prompt asks for waving, walking, dancing, spinning, breathing, hovering, pulsing, attacking, driving, flying, or any other motion, create that exact motion as a short seamless looping Blender action.',
    '- Name the primary action clearly, such as Idle, Wave, Walk, Hover, Spin, Dance, Drive, Fly, or Attack.',
    '- If the prompt does not specify motion but the asset can plausibly move, create a subtle Idle loop.',
    '',
    'Hard requirements:',
    `- Export the final result as a single GLB file to: ${glbPath}`,
    '- Center the model at the origin with the FEET at Y=0 and the model facing -Z.',
    '- Keep total polygon count under 50,000.',
    '- Apply all transforms before export and include materials/textures embedded in the GLB.',
    '- When the asset can plausibly move, create a short looping animation action using Blender keyframes, bones, or object transforms.',
    '- Export animation data in the GLB with export_animations=True, export_skins=True, and export_bake_animation=True.',
    '- Use a natural real-world scale for the requested asset. Characters are usually ~1.8 Blender units tall; vehicles and props should use appropriate proportions.',
    '',
    'When you are completely done, write a status file to:',
    `  ${statusPath}`,
    'On success the file MUST contain valid JSON: {"status":"ok","glb_path":"<absolute path to glb>"}',
    'On failure the file MUST contain valid JSON: {"status":"error","message":"<short reason>"}',
    '',
    `Job id: ${id}`,
  ].join('\n');
}

async function readStatusFile(statusPath) {
  try {
    return JSON.parse(await fsp.readFile(statusPath, 'utf8'));
  } catch {
    return null;
  }
}

async function generateWithCodex({ id, prompt, onProgress = () => {} }) {
  const glbPath = path.join(ASSETS_DIR, `${id}.glb`);
  const blenderGlbPath = toBlenderPath(glbPath);
  const statusPath = path.join(JOBS_DIR, `${id}.json`);

  await fsp.rm(glbPath, { force: true });
  await fsp.rm(statusPath, { force: true });

  const codexCmd = process.env.CODEX_CMD || 'codex';
  const codexArgs = ['exec', '--skip-git-repo-check', buildCodexPrompt({ id, prompt, glbPath: blenderGlbPath, statusPath })];

  onProgress(`Spawning ${codexCmd}...`);
  const child = spawn(codexCmd, codexArgs, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.on('data', (buf) => {
    const line = buf.toString().trim().split('\n').slice(-1)[0];
    if (line) onProgress(line.slice(0, 200));
  });
  child.stderr.on('data', (buf) => {
    const line = buf.toString().trim().split('\n').slice(-1)[0];
    if (line) onProgress(line.slice(0, 200));
  });

  const result = await new Promise((resolve) => {
    const poll = setInterval(async () => {
      const status = await readStatusFile(statusPath);
      if (status) {
        clearInterval(poll);
        resolve({ from: 'status', status });
      }
    }, POLL_MS);

    child.on('exit', (code, signal) => {
      clearInterval(poll);
      resolve({ from: 'exit', code, signal });
    });
  });

  if (!child.killed) child.kill('SIGTERM');

  const status = await readStatusFile(statusPath);
  if (status && status.status === 'error') throw new Error(status.message || 'Codex reported an error');
  if (!status || status.status !== 'ok') {
    if (result.from === 'exit' && result.code !== 0) {
      throw new Error(`Codex exited with code ${result.code}${result.signal ? ` (${result.signal})` : ''}`);
    }
    throw new Error('Codex finished without writing a status file');
  }

  let stat;
  try {
    stat = await fsp.stat(glbPath);
  } catch {
    throw new Error(`Codex claimed success but ${path.basename(glbPath)} is missing`);
  }
  if (stat.size < MIN_GLB_BYTES) {
    throw new Error(`Generated GLB is too small (${stat.size} bytes)`);
  }
  const validation = await validateGeneratedGlb(glbPath, { prompt });
  onProgress(formatValidationForProgress(validation));
  if (!validation.ok) {
    throw new Error(`Generated GLB failed quality gate: ${validation.issues.join(' ')}`);
  }
  const animationCount = countGlbAnimations(glbPath);
  onProgress(animationCount > 0
    ? `GLB contains ${animationCount} animation clip(s)`
    : 'GLB contains no animation clips; browser procedural motion will be used');
  const components = await extractComponentsFromGlb(glbPath, onProgress);
  return { glb_url: `/assets/${id}.glb`, animation_count: animationCount, components };
}

async function extractComponentsFromGlb(glbPath, onProgress) {
  try {
    const inspection = await inspectGlb(glbPath);
    const components = buildComponentManifest(inspection);
    onProgress(
      components.length > 0
        ? `Found ${components.length} named part(s): ${components.map((component) => component.name).join(', ')}`
        : 'No named parts found in GLB; components list will be empty'
    );
    return components;
  } catch (err) {
    onProgress(`Part manifest extraction failed: ${err.message}`);
    return [];
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

function toBlenderPath(p) {
  const normalized = path.resolve(p).replaceAll('\\', '/');
  const match = normalized.match(/^\/mnt\/([a-zA-Z])\/(.+)$/);
  if (!match) return normalized;
  return `${match[1].toUpperCase()}:/${match[2]}`;
}
