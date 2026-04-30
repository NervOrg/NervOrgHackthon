#!/usr/bin/env node

import { inspectGlb } from '../glbInspector.js';
import { buildComponentManifest } from '../openaiAgent.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/check-part-manifest.mjs <path-to-file.glb>');
  process.exit(2);
}

try {
  const report = await inspectGlb(filePath);
  const components = buildComponentManifest(report);

  console.log(`\nGLB: ${report.filePath}`);
  console.log(`Nodes with mesh data: ${report.bounds?.nodes?.length ?? 0}`);
  console.log(`Named parts extracted: ${components.length}`);
  console.log('');

  if (components.length === 0) {
    console.log('No named parts found.');
    console.log('Blender may have merged all geometry or left mesh objects unnamed.');
    console.log('Check that the system prompt named-part requirement is working.');
  } else {
    for (const component of components) {
      const size = component.bounds?.size ?? null;
      const sizeStr = size ? `[${size.map((n) => n.toFixed(2)).join(', ')}]` : 'no bounds';
      console.log(
        `  ${component.partId.padEnd(24)} "${component.name}"   meshIndex=${component.meshIndex ?? '-'}   size=${sizeStr}`
      );
    }
  }

  process.exit(0);
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
