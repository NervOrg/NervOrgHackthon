import { inspectGlb } from './glbInspector.js';

const DEFAULT_LIMITS = {
  minMeshPrimitives: 1,
  maxSceneRoots: 8,
  maxDimension: 80,
  maxVolume: 80000,
  maxMeshCenterDistanceRatio: 1.2,
};

export async function validateGeneratedGlb(filePath, { prompt = '', limits = {} } = {}) {
  const report = await inspectGlb(filePath);
  const result = validateInspectionReport(report, { prompt, limits });
  return { ...result, report };
}

export function validateInspectionReport(report, { prompt = '', limits = {} } = {}) {
  const mergedLimits = { ...DEFAULT_LIMITS, ...limits };
  const issues = [];
  const warnings = [];

  if (report.counts.sceneRoots < 1) {
    issues.push('GLB has no scene root nodes.');
  }
  if (report.counts.meshPrimitives < mergedLimits.minMeshPrimitives) {
    issues.push(`GLB has no mesh primitives; found ${report.counts.meshPrimitives}.`);
  }

  const bounds = report.bounds.combined;
  if (!isValidBounds(bounds)) {
    issues.push('GLB has no finite combined mesh bounds.');
  } else {
    const [x, y, z] = bounds.size;
    const maxDimension = Math.max(x, y, z);
    const volume = Math.max(x, 0) * Math.max(y, 0) * Math.max(z, 0);
    if (maxDimension > mergedLimits.maxDimension) {
      issues.push(`GLB dimensions are too large (${formatVec(bounds.size)}); max allowed dimension is ${mergedLimits.maxDimension}.`);
    }
    if (volume > mergedLimits.maxVolume) {
      issues.push(`GLB volume is too large (${volume.toFixed(2)}); max allowed volume is ${mergedLimits.maxVolume}.`);
    }
    if (Math.min(x, y, z) <= 0) {
      issues.push(`GLB has a collapsed dimension (${formatVec(bounds.size)}).`);
    }
  }

  if (report.counts.sceneRoots > mergedLimits.maxSceneRoots && !looksLikeMultiObjectPrompt(prompt)) {
    issues.push(`GLB has too many scene roots (${report.counts.sceneRoots}); expected a single assembled model hierarchy.`);
  }

  const isolated = findIsolatedMeshNodes(report, mergedLimits);
  for (const entry of isolated) {
    issues.push(`Mesh node "${entry.nodeName || entry.nodeIndex}" is isolated from the model center (distance ${entry.distance.toFixed(2)}, allowed ${entry.allowedDistance.toFixed(2)}).`);
  }

  if (report.counts.animations === 0) {
    warnings.push('GLB has no animation clips; browser procedural motion may be used.');
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    summary: summarizeReport(report),
  };
}

export function formatValidationForProgress(validation) {
  if (validation.ok) {
    const bounds = validation.summary.boundsSize ? ` bounds=${formatVec(validation.summary.boundsSize)}` : '';
    return `GLB quality gate passed (${validation.summary.meshPrimitives} primitive(s), ${validation.summary.sceneRoots} root(s)${bounds})`;
  }
  return `GLB quality gate failed: ${validation.issues.join(' ')}`;
}

function findIsolatedMeshNodes(report, limits) {
  const combined = report.bounds.combined;
  const nodeBounds = report.bounds.nodes || [];
  if (!isValidBounds(combined) || nodeBounds.length < 2) return [];

  const diagonal = vectorLength(combined.size);
  const allowedDistance = Math.max(diagonal * limits.maxMeshCenterDistanceRatio, 2);
  const combinedCenter = combined.center;
  return nodeBounds
    .map((entry) => ({
      ...entry,
      distance: distance(entry.worldBounds.center, combinedCenter),
      allowedDistance,
    }))
    .filter((entry) => entry.distance > allowedDistance);
}

function summarizeReport(report) {
  return {
    filePath: report.filePath,
    byteLength: report.byteLength,
    sceneRoots: report.counts.sceneRoots,
    nodes: report.counts.nodes,
    meshes: report.counts.meshes,
    meshPrimitives: report.counts.meshPrimitives,
    animations: report.counts.animations,
    boundsSize: report.bounds.combined?.size || null,
  };
}

function isValidBounds(bounds) {
  return !!bounds
    && ['min', 'max', 'size', 'center'].every((key) => Array.isArray(bounds[key]) && bounds[key].length === 3)
    && [...bounds.min, ...bounds.max, ...bounds.size, ...bounds.center].every(Number.isFinite);
}

function looksLikeMultiObjectPrompt(prompt) {
  return /\b(group|set|collection|multiple|many|several|crowd|forest|city|scene|room)\b/i.test(prompt || '');
}

function distance(a, b) {
  return vectorLength([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
}

function vectorLength(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

function formatVec(v) {
  return `[${v.map((n) => Number(n).toFixed(2)).join(', ')}]`;
}
