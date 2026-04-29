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

import { generateWithOpenAI } from './openaiAgent.js';

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
 * @returns {Promise<{ glb_url: string | null }>}
 */
export async function generateNpc(opts) {
  await fsp.mkdir(ASSETS_DIR, { recursive: true });
  await fsp.mkdir(JOBS_DIR, { recursive: true });

  if (process.env.FAKE_GENERATOR === '1') return fakeGenerate(opts);

  const backend = (process.env.GENERATOR || 'openai').toLowerCase();
  if (backend === 'openai') return withTimeout(generateWithOpenAI(opts), TIMEOUT_MS);
  if (backend === 'codex') return withTimeout(generateWithCodex(opts), TIMEOUT_MS);
  throw new Error(`Unknown GENERATOR=${backend}`);
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
  return { glb_url: null };
}

// ---------------------------------------------------------------------------
// Codex generator (GENERATOR=codex) — kept for compatibility / fallback.
// ---------------------------------------------------------------------------

function buildCodexPrompt({ id, prompt, glbPath, statusPath }) {
  return [
    `Use the blender-mcp tools to create the requested 3D asset based on this description: "${prompt}".`,
    'The request may be a character, vehicle, prop, building, creature, group, or abstract object. Build the requested thing directly.',
    '',
    'Hard requirements:',
    `- Export the final result as a single GLB file to: ${glbPath}`,
    '- Center the model at the origin with the FEET at Y=0 and the model facing -Z.',
    '- Keep total polygon count under 50,000.',
    '- Apply all transforms before export and include materials/textures embedded in the GLB.',
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
  const statusPath = path.join(JOBS_DIR, `${id}.json`);

  await fsp.rm(glbPath, { force: true });
  await fsp.rm(statusPath, { force: true });

  const codexCmd = process.env.CODEX_CMD || 'codex';
  const codexArgs = ['exec', '--skip-git-repo-check', buildCodexPrompt({ id, prompt, glbPath, statusPath })];

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
  return { glb_url: `/assets/${id}.glb` };
}
