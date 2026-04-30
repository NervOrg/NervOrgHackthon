#!/usr/bin/env node

import { checkCarCorrectness } from '../carCorrectness.js';

const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: node scripts/check-car-correctness.mjs <path-to-file.glb>');
  process.exit(2);
}

try {
  const result = await checkCarCorrectness(filePath);
  console.log(`Car correctness ${result.ok ? 'passed' : 'failed'} (score ${result.score}/100)`);
  for (const issue of result.issues) console.log(`Issue: ${issue}`);
  for (const warning of result.warnings) console.log(`Warning: ${warning}`);
  console.log(JSON.stringify({
    features: result.featureStatus,
    summary: result.summary,
  }, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
