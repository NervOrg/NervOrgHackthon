#!/usr/bin/env node
/*
 * Verifies your OPENAI_API_KEY:
 *   1. Hits /v1/models and prints what your key has access to
 *      (filtered to GPT-5.x family + your selected OPENAI_MODEL).
 *   2. Sends one tiny chat completion to prove the model actually responds.
 *
 * Run with:  npm run check
 */

import 'dotenv/config';
import OpenAI from 'openai';

const key = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || 'gpt-5.5';

if (!key) {
  console.error('✗ OPENAI_API_KEY is not set (check your .env file)');
  process.exit(1);
}
const masked = key.length > 14 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '(short)';
console.log(`Using key: ${masked}`);
console.log(`Configured model: ${model}`);
console.log();

const client = new OpenAI({ apiKey: key });

// 1. List models the key has access to.
let modelIds = [];
try {
  const list = await client.models.list();
  modelIds = list.data.map((m) => m.id).sort();
  console.log(`✓ Auth OK — your key sees ${modelIds.length} model(s)`);
} catch (err) {
  console.error('✗ /v1/models failed:', summarise(err));
  process.exit(1);
}

const interesting = modelIds.filter((id) => /^gpt-5(\.|-)/i.test(id));
if (interesting.length) {
  console.log('\nGPT-5.x models on your account:');
  for (const id of interesting) console.log(`  • ${id}`);
} else {
  console.log('\n(no gpt-5.x models visible — your account may be on an older tier)');
}

const hasConfigured = modelIds.includes(model);
console.log(`\nConfigured model "${model}": ${hasConfigured ? '✓ available' : '✗ NOT in /v1/models for this key'}`);

// 2. Tiny round-trip to confirm chat actually works.
console.log('\nSending 1-token round-trip to confirm chat works...');
try {
  const r = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'reply with the single word: ok' }],
    max_completion_tokens: 8,
  });
  const reply = (r.choices?.[0]?.message?.content || '').trim();
  console.log(`✓ ${model} responded: "${reply}"`);
  console.log('\nAll good. You can run: npm start');
} catch (err) {
  console.error(`✗ chat.completions.create failed:`, summarise(err));
  process.exit(2);
}

function summarise(err) {
  if (err?.status && err?.message) return `${err.status} ${err.message}`;
  return err?.message || String(err);
}
