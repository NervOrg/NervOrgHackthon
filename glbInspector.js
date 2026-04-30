import fs from 'node:fs/promises';
import path from 'node:path';

const GLB_MAGIC = 0x46546c67; // glTF
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a; // JSON
const BIN_CHUNK = 0x004e4942; // BIN\0

export async function inspectGlb(filePath) {
  const absolutePath = path.resolve(filePath);
  const data = await fs.readFile(absolutePath);
  return inspectGlbBuffer(data, { filePath: absolutePath });
}

export function inspectGlbBuffer(data, { filePath = '(buffer)' } = {}) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data);
  if (data.length < 20) {
    throw new Error(`GLB is too small to contain a header and JSON chunk (${data.length} bytes)`);
  }

  const magic = data.readUInt32LE(0);
  const version = data.readUInt32LE(4);
  const declaredLength = data.readUInt32LE(8);
  if (magic !== GLB_MAGIC) throw new Error('File is not a GLB: missing glTF magic');
  if (version !== GLB_VERSION) throw new Error(`Unsupported GLB version ${version}; expected ${GLB_VERSION}`);
  if (declaredLength !== data.length) {
    throw new Error(`GLB declared length ${declaredLength} does not match actual length ${data.length}`);
  }

  const chunks = readChunks(data);
  const jsonChunk = chunks.find((chunk) => chunk.type === JSON_CHUNK);
  if (!jsonChunk) throw new Error('GLB is missing required JSON chunk');

  let json;
  try {
    json = JSON.parse(data.subarray(jsonChunk.start, jsonChunk.end).toString('utf8').trim());
  } catch (err) {
    throw new Error(`GLB JSON chunk is invalid: ${err.message}`);
  }

  const binChunk = chunks.find((chunk) => chunk.type === BIN_CHUNK) || null;
  const sceneIndex = Number.isInteger(json.scene) ? json.scene : 0;
  const scene = json.scenes?.[sceneIndex] || json.scenes?.[0] || null;
  const sceneRoots = Array.isArray(scene?.nodes) ? scene.nodes : [];
  const rootSummaries = sceneRoots.map((nodeIndex) => summarizeNode(json, nodeIndex, null, new Set()));
  const meshSummaries = summarizeMeshes(json);
  const nodeBounds = [];
  for (const root of rootSummaries) collectNodeBounds(root, nodeBounds);
  const combinedBounds = combineBounds(nodeBounds.map((entry) => entry.worldBounds).filter(Boolean));

  return {
    filePath,
    byteLength: data.length,
    declaredLength,
    jsonByteLength: jsonChunk.length,
    binByteLength: binChunk?.length || 0,
    assetVersion: json.asset?.version || null,
    sceneIndex,
    sceneName: scene?.name || null,
    counts: {
      scenes: json.scenes?.length || 0,
      sceneRoots: sceneRoots.length,
      nodes: json.nodes?.length || 0,
      meshes: json.meshes?.length || 0,
      meshPrimitives: meshSummaries.reduce((sum, mesh) => sum + mesh.primitiveCount, 0),
      materials: json.materials?.length || 0,
      animations: json.animations?.length || 0,
      accessors: json.accessors?.length || 0,
      bufferViews: json.bufferViews?.length || 0,
      buffers: json.buffers?.length || 0,
    },
    roots: rootSummaries,
    meshes: meshSummaries,
    animations: summarizeAnimations(json),
    bounds: {
      combined: combinedBounds,
      nodes: nodeBounds,
    },
  };
}

function readChunks(data) {
  const chunks = [];
  let offset = 12;
  while (offset < data.length) {
    if (offset + 8 > data.length) throw new Error('GLB chunk header is truncated');
    const length = data.readUInt32LE(offset);
    const type = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > data.length) throw new Error(`GLB chunk ${formatChunkType(type)} extends past end of file`);
    chunks.push({ type, typeLabel: formatChunkType(type), length, start, end });
    offset = end;
  }
  return chunks;
}

function summarizeNode(json, nodeIndex, parentIndex, seen) {
  const node = json.nodes?.[nodeIndex];
  if (!node) return { index: nodeIndex, parentIndex, missing: true, children: [] };
  if (seen.has(nodeIndex)) return { index: nodeIndex, parentIndex, cycle: true, children: [] };

  const nextSeen = new Set(seen);
  nextSeen.add(nodeIndex);
  const localTransform = readNodeTransform(node);
  const mesh = Number.isInteger(node.mesh) ? summarizeMesh(json, node.mesh) : null;
  const worldBounds = mesh?.bounds ? transformBounds(mesh.bounds, localTransform) : null;

  return {
    index: nodeIndex,
    parentIndex,
    name: node.name || null,
    meshIndex: Number.isInteger(node.mesh) ? node.mesh : null,
    childIndices: Array.isArray(node.children) ? [...node.children] : [],
    transform: localTransform,
    localMeshBounds: mesh?.bounds || null,
    worldBounds,
    children: (node.children || []).map((childIndex) => summarizeNode(json, childIndex, nodeIndex, nextSeen)),
  };
}

function summarizeMeshes(json) {
  return (json.meshes || []).map((mesh, index) => summarizeMesh(json, index, mesh));
}

function summarizeMesh(json, meshIndex, mesh = json.meshes?.[meshIndex]) {
  if (!mesh) return { index: meshIndex, missing: true, primitiveCount: 0, bounds: null };
  const primitiveBounds = (mesh.primitives || [])
    .map((primitive, primitiveIndex) => summarizePrimitiveBounds(json, primitive, primitiveIndex))
    .filter(Boolean);
  return {
    index: meshIndex,
    name: mesh.name || null,
    primitiveCount: mesh.primitives?.length || 0,
    primitiveBounds,
    bounds: combineBounds(primitiveBounds.map((primitive) => primitive.bounds).filter(Boolean)),
  };
}

function summarizePrimitiveBounds(json, primitive, primitiveIndex) {
  const positionAccessorIndex = primitive.attributes?.POSITION;
  if (!Number.isInteger(positionAccessorIndex)) return null;
  const accessor = json.accessors?.[positionAccessorIndex];
  if (!accessor || !Array.isArray(accessor.min) || !Array.isArray(accessor.max)) return null;
  return {
    primitiveIndex,
    positionAccessorIndex,
    vertexCount: accessor.count || 0,
    bounds: boundsFromMinMax(accessor.min, accessor.max),
  };
}

function summarizeAnimations(json) {
  return (json.animations || []).map((animation, index) => ({
    index,
    name: animation.name || null,
    channelCount: animation.channels?.length || 0,
    samplerCount: animation.samplers?.length || 0,
    targets: (animation.channels || []).map((channel) => ({
      nodeIndex: Number.isInteger(channel.target?.node) ? channel.target.node : null,
      nodeName: Number.isInteger(channel.target?.node) ? json.nodes?.[channel.target.node]?.name || null : null,
      path: channel.target?.path || null,
    })),
  }));
}

function readNodeTransform(node) {
  return {
    translation: vec3(node.translation, [0, 0, 0]),
    rotation: vec4(node.rotation, [0, 0, 0, 1]),
    scale: vec3(node.scale, [1, 1, 1]),
    hasMatrix: Array.isArray(node.matrix),
  };
}

function transformBounds(bounds, transform) {
  if (!bounds) return null;
  const corners = [
    [bounds.min[0], bounds.min[1], bounds.min[2]],
    [bounds.min[0], bounds.min[1], bounds.max[2]],
    [bounds.min[0], bounds.max[1], bounds.min[2]],
    [bounds.min[0], bounds.max[1], bounds.max[2]],
    [bounds.max[0], bounds.min[1], bounds.min[2]],
    [bounds.max[0], bounds.min[1], bounds.max[2]],
    [bounds.max[0], bounds.max[1], bounds.min[2]],
    [bounds.max[0], bounds.max[1], bounds.max[2]],
  ];
  return combinePoints(corners.map((corner) => transformPoint(corner, transform)));
}

function transformPoint(point, transform) {
  const scaled = [
    point[0] * transform.scale[0],
    point[1] * transform.scale[1],
    point[2] * transform.scale[2],
  ];
  const rotated = rotateByQuaternion(scaled, transform.rotation);
  return [
    rotated[0] + transform.translation[0],
    rotated[1] + transform.translation[1],
    rotated[2] + transform.translation[2],
  ];
}

function rotateByQuaternion(point, q) {
  const [x, y, z] = point;
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

function collectNodeBounds(node, out) {
  if (node.worldBounds) {
    out.push({
      nodeIndex: node.index,
      nodeName: node.name,
      meshIndex: node.meshIndex,
      worldBounds: node.worldBounds,
    });
  }
  for (const child of node.children || []) collectNodeBounds(child, out);
}

function boundsFromMinMax(min, max) {
  return annotateBounds({ min: min.slice(0, 3), max: max.slice(0, 3) });
}

function combineBounds(boundsList) {
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

function combinePoints(points) {
  return combineBounds(points.map((point) => ({ min: point, max: point })));
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

function vec3(value, fallback) {
  return Array.isArray(value) && value.length >= 3 ? value.slice(0, 3).map(Number) : [...fallback];
}

function vec4(value, fallback) {
  return Array.isArray(value) && value.length >= 4 ? value.slice(0, 4).map(Number) : [...fallback];
}

function formatChunkType(type) {
  return Buffer.from([
    type & 0xff,
    (type >> 8) & 0xff,
    (type >> 16) & 0xff,
    (type >> 24) & 0xff,
  ]).toString('ascii').replace(/\0/g, '\\0');
}
