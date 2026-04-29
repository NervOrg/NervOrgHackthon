import * as THREE from 'three';

// Tiny seeded PRNG so the terrain layout is stable per page load (mulberry32).
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE = [
  0x7aa05a, // grass
  0x8aab63,
  0x6f9450,
  0x9b8b5a, // dry tan
  0xb09a6a,
  0x6b8a78, // mossy
  0x556b54, // dark forest
];

/**
 * Build a group of low-poly mounds/slopes scattered around the origin.
 * Each mound is a cone with low radial segments (very faceted = "low poly")
 * and flat shading. Vertices are slightly jittered so no two look the same.
 *
 * Returns the group — add it to the scene yourself.
 */
export function createTerrain({
  count = 26,
  area = 80,
  exclusionRadius = 7,
  seed = 1337,
} = {}) {
  const rand = mulberry32(seed);
  const group = new THREE.Group();
  group.name = 'terrain';

  for (let i = 0; i < count; i++) {
    // Pick a position that's outside the spawn exclusion zone.
    let x = 0;
    let z = 0;
    for (let tries = 0; tries < 8; tries++) {
      x = (rand() * 2 - 1) * area;
      z = (rand() * 2 - 1) * area;
      if (Math.hypot(x, z) >= exclusionRadius) break;
    }

    const height = 1.2 + rand() * 7;
    const radius = 2 + rand() * 5;
    // 4–8 radial segments → faceted, low-poly look.
    const radialSegments = 4 + Math.floor(rand() * 5);
    const heightSegments = 1 + Math.floor(rand() * 2);

    const geom = new THREE.ConeGeometry(
      radius,
      height,
      radialSegments,
      heightSegments,
      false
    );
    jitterGeometry(geom, rand, 0.18);
    geom.computeVertexNormals();

    const color = PALETTE[Math.floor(rand() * PALETTE.length)];
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(x, height / 2, z);
    mesh.rotation.y = rand() * Math.PI * 2;
    // Slight random tilt so they're not all perfectly upright.
    mesh.rotation.x = (rand() - 0.5) * 0.18;
    mesh.rotation.z = (rand() - 0.5) * 0.18;
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    group.add(mesh);
  }

  return group;
}

function jitterGeometry(geom, rand, amount) {
  const pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    // Skip the apex (top vertex of the cone) so the peaks stay sharp.
    const y = pos.getY(i);
    const isApex = i === 0 || (geom.parameters && y > geom.parameters.height / 2 - 0.001);
    if (isApex) continue;
    pos.setX(i, pos.getX(i) + (rand() - 0.5) * amount);
    pos.setY(i, pos.getY(i) + (rand() - 0.5) * amount * 0.5);
    pos.setZ(i, pos.getZ(i) + (rand() - 0.5) * amount);
  }
  pos.needsUpdate = true;
}
