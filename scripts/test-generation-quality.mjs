#!/usr/bin/env node

import assert from 'node:assert/strict';

import { inspectGlbBuffer } from '../glbInspector.js';
import { validateInspectionReport } from '../generationQualityGate.js';

const tests = [
  ['inspect valid GLB metadata and bounds', testInspectValidGlb],
  ['reject malformed GLB buffers', testRejectMalformedGlb],
  ['reject empty GLB placeholder', testRejectEmptyGlb],
  ['reject separated vehicle assembly', testRejectSeparatedVehicle],
  ['accept simple assembled vehicle', testAcceptValidVehicle],
];

for (const [name, run] of tests) {
  await run();
  console.log(`ok - ${name}`);
}

console.log(`Generation quality tests passed (${tests.length})`);

function testInspectValidGlb() {
  const buffer = createGlb({
    nodes: [
      node('Gemstone', 0, [1, 2, 3]),
    ],
    meshes: [
      mesh('GemstoneMesh', bounds([-0.5, 0, -0.5], [0.5, 1, 0.5])),
    ],
    sceneNodes: [0],
  });

  const report = inspectGlbBuffer(buffer, { filePath: 'valid.glb' });
  assert.equal(report.counts.sceneRoots, 1);
  assert.equal(report.counts.meshPrimitives, 1);
  assert.deepEqual(report.bounds.combined.size, [1, 1, 1]);
  assert.deepEqual(report.bounds.combined.center, [1, 2.5, 3]);
}

function testRejectMalformedGlb() {
  assert.throws(
    () => inspectGlbBuffer(Buffer.from('nope'), { filePath: 'bad.glb' }),
    /too small/,
  );
}

function testRejectEmptyGlb() {
  const report = inspectGlbBuffer(createGlb({ nodes: [], meshes: [], sceneNodes: [] }), {
    filePath: 'empty.glb',
  });
  const validation = validateInspectionReport(report, { prompt: 'placeholder' });
  assert.equal(validation.ok, false);
  assert.match(validation.issues.join(' '), /no scene root nodes/i);
  assert.match(validation.issues.join(' '), /no mesh primitives/i);
  assert.match(validation.issues.join(' '), /no finite combined mesh bounds/i);
}

function testRejectSeparatedVehicle() {
  const report = inspectGlbBuffer(createCarGlb({ separatedBody: true }), {
    filePath: 'bad-car.glb',
  });
  const validation = validateInspectionReport(report, { prompt: 'a low poly car' });
  assert.equal(validation.ok, false);
  assert.match(validation.issues.join(' '), /extends too far beyond the wheel envelope/i);
}

function testAcceptValidVehicle() {
  const report = inspectGlbBuffer(createCarGlb({ separatedBody: false }), {
    filePath: 'valid-car.glb',
  });
  const validation = validateInspectionReport(report, { prompt: 'a low poly car' });
  assert.equal(validation.ok, true, validation.issues.join(' '));
}

function createCarGlb({ separatedBody }) {
  const nodes = [
    node('LowpolyCar_Body', 0, [0, 0, separatedBody ? 5 : 0]),
    node('LowpolyCar_Cabin', 1, [0, 0, separatedBody ? 5 : 0]),
    node('LowpolyCar_Wheel_FL', 2, [-0.8, 0.25, 1]),
    node('LowpolyCar_Wheel_FR', 2, [0.8, 0.25, 1]),
    node('LowpolyCar_Wheel_RL', 2, [-0.8, 0.25, -1]),
    node('LowpolyCar_Wheel_RR', 2, [0.8, 0.25, -1]),
  ];

  const meshes = [
    mesh('BodyMesh', bounds([-1, 0.3, -1.5], [1, 0.8, 1.5])),
    mesh('CabinMesh', bounds([-0.55, 0.8, -0.5], [0.55, 1.3, 0.7])),
    mesh('WheelMesh', bounds([-0.2, -0.2, -0.2], [0.2, 0.2, 0.2])),
  ];

  return createGlb({ nodes, meshes, sceneNodes: nodes.map((_, index) => index) });
}

function createGlb({ nodes, meshes, sceneNodes }) {
  const accessors = [];
  const gltfMeshes = meshes.map((entry) => {
    const accessorIndex = accessors.length;
    accessors.push({
      componentType: 5126,
      count: 8,
      type: 'VEC3',
      min: entry.bounds.min,
      max: entry.bounds.max,
    });
    return {
      name: entry.name,
      primitives: [
        {
          attributes: {
            POSITION: accessorIndex,
          },
        },
      ],
    };
  });

  return makeGlbBuffer({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: sceneNodes }],
    nodes,
    meshes: gltfMeshes,
    accessors,
  });
}

function makeGlbBuffer(json) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const paddedJsonLength = align4(jsonBytes.length);
  const paddedJson = Buffer.alloc(paddedJsonLength, 0x20);
  jsonBytes.copy(paddedJson);

  const totalLength = 12 + 8 + paddedJson.length;
  const buffer = Buffer.alloc(totalLength);
  buffer.writeUInt32LE(0x46546c67, 0);
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(totalLength, 8);
  buffer.writeUInt32LE(paddedJson.length, 12);
  buffer.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(buffer, 20);
  return buffer;
}

function node(name, meshIndex, translation = [0, 0, 0]) {
  return {
    name,
    mesh: meshIndex,
    translation,
  };
}

function mesh(name, meshBounds) {
  return {
    name,
    bounds: meshBounds,
  };
}

function bounds(min, max) {
  return { min, max };
}

function align4(value) {
  return Math.ceil(value / 4) * 4;
}
