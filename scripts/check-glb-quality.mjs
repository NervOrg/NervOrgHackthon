#!/usr/bin/env node

import { validateGeneratedGlb, formatValidationForProgress } from '../generationQualityGate.js';

const filePath = process.argv[2];
const prompt = process.argv.slice(3).join(' ');

if (!filePath) {
  console.error('Usage: node scripts/check-glb-quality.mjs <path-to-file.glb> [prompt]');
  process.exit(2);
}

try {
  const validation = await validateGeneratedGlb(filePath, { prompt });
  console.log(formatValidationForProgress(validation));
  if (validation.warnings.length) {
    for (const warning of validation.warnings) console.log(`Warning: ${warning}`);
  }
  console.log(JSON.stringify(validation.summary, null, 2));
  process.exit(validation.ok ? 0 : 1);
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
