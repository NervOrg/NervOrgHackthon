import path from 'node:path';

import { inspectGlb } from './glbInspector.js';

const REQUIRED_FEATURES = [
  'body',
  'wheels',
  'windows',
  'frontLights',
  'rearLights',
  'trim',
];

export async function checkCarCorrectness(filePath) {
  const report = await inspectGlb(filePath);
  return checkCarInspection(report);
}

export function checkCarInspection(report) {
  const nodes = (report.bounds?.nodes || [])
    .filter((entry) => entry.nodeName && entry.worldBounds);
  const combined = report.bounds?.combined;
  const issues = [];
  const warnings = [];

  const groups = {
    body: find(nodes, /\b(body|chassis|hull|frame|hood|bonnet|deck)\b/i),
    wheels: find(nodes, /\b(wheel|tire|tyre)\b/i),
    windows: find(nodes, /\b(window|windshield|windscreen|glass|cabin)\b/i),
    frontLights: find(nodes, /\b(headlight|headlamp)\b/i),
    rearLights: find(nodes, /\b(taillight|tail_light|rear_light|brake_light)\b/i),
    trim: find(nodes, /\b(trim|grille|bumper|mirror|handle|spoiler|splitter|skirt|accent|rim)\b/i),
    details: find(nodes, /\b(detail|decoration|vent|seam|panel|plate|exhaust|stripe|spoiler|handle|mirror|grille)\b/i),
  };

  if (!combined) {
    issues.push('GLB has no combined bounds.');
  } else {
    const [width, height, length] = combined.size;
    if (length < width * 1.25) {
      issues.push(`Car silhouette is not length-dominant enough (width ${fmt(width)}, length ${fmt(length)}).`);
    }
    if (height > Math.max(length, width) * 0.75) {
      warnings.push(`Car is unusually tall relative to its footprint (height ${fmt(height)}).`);
    }
  }

  if (!groups.body.length) issues.push('Missing a recognizable body/chassis/hood region.');
  if (groups.wheels.length < 4) issues.push(`Expected at least 4 wheel/tire nodes, found ${groups.wheels.length}.`);
  if (!groups.windows.length) issues.push('Missing windows/glass/cabin region.');
  if (!groups.frontLights.length) issues.push('Missing front headlights.');
  if (!groups.rearLights.length) warnings.push('Missing rear taillights/brake lights.');
  if (!groups.trim.length) warnings.push('Missing trim/grille/bumper/mirror/accent details.');
  if (groups.details.length < 4) warnings.push(`Low visible-detail count (${groups.details.length}); car may look too plain for demo.`);

  if (combined && groups.wheels.length >= 4) {
    const wheelBounds = combineEntries(groups.wheels);
    const wheelCenters = groups.wheels.map((entry) => entry.worldBounds.center);
    const wheelMinY = Math.min(...groups.wheels.map((entry) => entry.worldBounds.min[1]));
    const wheelMaxCenterY = Math.max(...wheelCenters.map((center) => center[1]));
    const lowBandTop = combined.min[1] + combined.size[1] * 0.55;
    if (wheelMaxCenterY > lowBandTop) {
      issues.push(`Wheels are too high in the model bounds (highest wheel center Y ${fmt(wheelMaxCenterY)}, expected below ${fmt(lowBandTop)}).`);
    }
    if (Math.abs(wheelMinY - combined.min[1]) > Math.max(combined.size[1] * 0.18, 0.1)) {
      warnings.push('Wheel bottoms are not close to the lowest part of the car.');
    }
    const xSpread = wheelBounds.size[0];
    const zSpread = wheelBounds.size[2];
    if (xSpread < combined.size[0] * 0.55) {
      issues.push(`Wheels are not spread across left/right sides enough (spread ${fmt(xSpread)}).`);
    }
    if (zSpread < combined.size[2] * 0.45) {
      issues.push(`Wheels are not spread across front/rear enough (spread ${fmt(zSpread)}).`);
    }
  }

  const featureStatus = Object.fromEntries(
    REQUIRED_FEATURES.map((name) => [name, name === 'wheels' ? groups[name].length >= 4 : groups[name].length > 0])
  );
  const featurePoints = Object.values(featureStatus).filter(Boolean).length;
  const issuePenalty = issues.length * 18;
  const warningPenalty = warnings.length * 6;
  const score = clamp(Math.round((featurePoints / REQUIRED_FEATURES.length) * 100 - issuePenalty - warningPenalty), 0, 100);

  return {
    ok: issues.length === 0 && score >= 70,
    score,
    issues,
    warnings,
    features: Object.fromEntries(Object.entries(groups).map(([key, entries]) => [key, entries.map((entry) => entry.nodeName)])),
    featureStatus,
    summary: {
      filePath: path.resolve(report.filePath),
      meshPrimitives: report.counts.meshPrimitives,
      nodes: report.counts.nodes,
      boundsSize: combined?.size || null,
    },
  };
}

function find(nodes, pattern) {
  return nodes.filter((entry) => pattern.test(normalize(entry.nodeName)));
}

function normalize(name) {
  return String(name || '').replace(/[_:.-]+/g, ' ');
}

function combineEntries(entries) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const entry of entries) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], entry.worldBounds.min[i]);
      max[i] = Math.max(max[i], entry.worldBounds.max[i]);
    }
  }
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

function fmt(value) {
  return Number(value).toFixed(2);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
