#!/usr/bin/env node

import { inspectGlb } from '../glbInspector.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/inspect-glb.mjs <path-to-file.glb>');
  process.exit(2);
}

try {
  const report = await inspectGlb(filePath);
  const summary = {
    filePath: report.filePath,
    byteLength: report.byteLength,
    assetVersion: report.assetVersion,
    scene: {
      index: report.sceneIndex,
      name: report.sceneName,
    },
    counts: report.counts,
    combinedBounds: report.bounds.combined,
    roots: report.roots.map((root) => ({
      index: root.index,
      name: root.name,
      meshIndex: root.meshIndex,
      childCount: root.childIndices?.length || 0,
    })),
    meshes: report.meshes.map((mesh) => ({
      index: mesh.index,
      name: mesh.name,
      primitiveCount: mesh.primitiveCount,
      bounds: mesh.bounds,
    })),
    animations: report.animations,
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
