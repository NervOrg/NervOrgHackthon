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

  const vehicleIssues = validateVehicleAssembly(report, prompt);
  issues.push(...vehicleIssues);

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

function validateVehicleAssembly(report, prompt) {
  const kind = vehicleKind(prompt);
  if (!kind) return [];

  const combined = report.bounds.combined;
  const nodes = (report.bounds.nodes || []).filter((entry) => isValidBounds(entry.worldBounds));
  if (!isValidBounds(combined) || nodes.length < 2) return [];

  const issues = [];
  const wheels = nodes.filter((entry) => hasNameToken(entry, /\b(wheel|tire|tyre)\b/i));
  const bodies = nodes.filter((entry) => hasNameToken(entry, /\b(body|chassis|frame|base|hull)\b/i));
  const cabins = nodes.filter((entry) => hasNameToken(entry, /\b(cabin|cab|cockpit|window|windscreen|roof)\b/i));
  const expectedWheels = kind === 'bike' ? 2 : 4;

  if (wheels.length > 0 && wheels.length < expectedWheels) {
    issues.push(`Vehicle appears to have only ${wheels.length} wheel node(s); expected at least ${expectedWheels} for a ${kind}.`);
  }

  if (wheels.length >= expectedWheels) {
    const wheelBounds = combineEntryBounds(wheels);
    const body = largestEntry(bodies.length ? bodies : nodes.filter((entry) => !wheels.includes(entry)));
    if (body) {
      const extension = maxExtensionBeyond(body.worldBounds, wheelBounds, [0, 2]);
      const allowedExtension = Math.max(Math.max(wheelBounds.size[0], wheelBounds.size[2]) * 1.25, Math.max(combined.size[0], combined.size[2]) * 0.35);
      if (extension > allowedExtension) {
        issues.push(`Vehicle body "${body.nodeName || body.nodeIndex}" extends too far beyond the wheel envelope (${extension.toFixed(2)}, allowed ${allowedExtension.toFixed(2)}); recenter/assemble body, cabin, and wheels before export.`);
      }
      const wheelCentersY = wheels.map((entry) => entry.worldBounds.center[1]);
      const averageWheelCenterY = average(wheelCentersY);
      const averageWheelDiameterY = average(wheels.map((entry) => entry.worldBounds.size[1]));
      const minimumBodyBottom = averageWheelCenterY - averageWheelDiameterY * 0.25;
      if (body.worldBounds.min[1] < minimumBodyBottom) {
        issues.push(`Vehicle body "${body.nodeName || body.nodeIndex}" drops through the wheels (body bottom ${body.worldBounds.min[1].toFixed(2)}, expected above ${minimumBodyBottom.toFixed(2)}); lift/reshape the body so wheels remain visibly attached outside the lower body.`);
      }
    }

    const wheelLayoutIssue = validateWheelLayout(wheels, wheelBounds, combined, kind);
    if (wheelLayoutIssue) issues.push(wheelLayoutIssue);

    const highWheels = wheels.filter((entry) => entry.worldBounds.center[1] > combined.min[1] + combined.size[1] * 0.6);
    for (const wheel of highWheels) {
      issues.push(`Wheel node "${wheel.nodeName || wheel.nodeIndex}" is too high in the vehicle bounds; wheels should sit near the lower body.`);
    }
  }

  if (bodies.length && cabins.length) {
    const bodyBounds = combineEntryBounds(bodies);
    for (const cabin of cabins) {
      if (!boundsNearOnAxes(cabin.worldBounds, bodyBounds, [0, 2], 0.25)) {
        issues.push(`Vehicle cabin "${cabin.nodeName || cabin.nodeIndex}" is separated from the body envelope; attach it to the body before export.`);
      }
      if (boundsMostlyInside(cabin.worldBounds, bodyBounds, 0.05)) {
        issues.push(`Vehicle cabin/window "${cabin.nodeName || cabin.nodeIndex}" is buried inside the body bounds; it should be visible on top of or outside the body shell.`);
      }
    }
  }

  return issues;
}

function vehicleKind(prompt) {
  const text = prompt || '';
  if (/\b(bike|motorcycle|motorbike|scooter)\b/i.test(text)) return 'bike';
  if (/\b(car|truck|vehicle|bus|van|lorry|jeep|taxi|ambulance)\b/i.test(text)) return 'car';
  return null;
}

function validateWheelLayout(wheels, wheelBounds, combined, kind) {
  const xSpread = wheelBounds.size[0];
  const zSpread = wheelBounds.size[2];
  const minSideSpread = combined.size[0] * 0.25;
  const minLengthSpread = combined.size[2] * (kind === 'bike' ? 0.35 : 0.2);

  if (xSpread < minSideSpread && kind !== 'bike') {
    return `Vehicle wheels are not spread across left/right sides (wheel x spread ${xSpread.toFixed(2)}, expected at least ${minSideSpread.toFixed(2)}).`;
  }
  if (zSpread < minLengthSpread) {
    return `Vehicle wheels are not spread along the vehicle length (wheel z spread ${zSpread.toFixed(2)}, expected at least ${minLengthSpread.toFixed(2)}).`;
  }
  return null;
}

function hasNameToken(entry, pattern) {
  const normalized = String(entry.nodeName || '').replace(/[_-]+/g, ' ');
  return pattern.test(normalized);
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

function combineEntryBounds(entries) {
  const boundsList = entries.map((entry) => entry.worldBounds).filter(Boolean);
  if (!boundsList.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const bounds of boundsList) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], bounds.min[i]);
      max[i] = Math.max(max[i], bounds.max[i]);
    }
  }
  return annotateBounds({ min, max });
}

function largestEntry(entries) {
  return entries
    .filter((entry) => isValidBounds(entry.worldBounds))
    .sort((a, b) => boundsVolume(b.worldBounds) - boundsVolume(a.worldBounds))[0] || null;
}

function maxExtensionBeyond(bounds, reference, axes) {
  if (!bounds || !reference) return 0;
  return Math.max(...axes.flatMap((axis) => [
    Math.max(0, reference.min[axis] - bounds.min[axis]),
    Math.max(0, bounds.max[axis] - reference.max[axis]),
  ]));
}

function boundsNearOnAxes(bounds, reference, axes, toleranceRatio) {
  return axes.every((axis) => {
    const tolerance = Math.max(reference.size[axis] * toleranceRatio, 0.25);
    return bounds.max[axis] >= reference.min[axis] - tolerance
      && bounds.min[axis] <= reference.max[axis] + tolerance;
  });
}

function boundsMostlyInside(bounds, reference, marginRatio) {
  if (!bounds || !reference) return false;
  return [0, 1, 2].every((axis) => {
    const margin = Math.max(reference.size[axis] * marginRatio, 0.03);
    return bounds.min[axis] >= reference.min[axis] + margin
      && bounds.max[axis] <= reference.max[axis] - margin;
  });
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function boundsVolume(bounds) {
  return bounds.size.reduce((product, value) => product * Math.max(value, 0), 1);
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

function annotateBounds(bounds) {
  const size = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  return {
    min: bounds.min,
    max: bounds.max,
    size,
    center: [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ],
  };
}

function vectorLength(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

function formatVec(v) {
  return `[${v.map((n) => Number(n).toFixed(2)).join(', ')}]`;
}
