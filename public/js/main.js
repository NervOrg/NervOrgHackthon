import * as THREE from 'three';
import * as ws from './ws.js';
import { World } from './world.js';
import { MakerMode } from './makerMode.js';
import { PlayMode } from './playMode.js';
import { setModeUI, toast } from './ui.js';
import { createTerrain } from './terrain.js';

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b8e8);
scene.fog = new THREE.Fog(0x87b8e8, 60, 200);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 500);
camera.position.set(0, 1.7, 6);

// --- Lighting -------------------------------------------------------------
const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x6c7a8a, 0.6);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 1.05);
sun.position.set(20, 30, 15);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 120;
sun.shadow.camera.left = -50;
sun.shadow.camera.right = 50;
sun.shadow.camera.top = 50;
sun.shadow.camera.bottom = -50;
sun.shadow.bias = -0.0005;
scene.add(sun);

// --- Ground + terrain (the "walkable" group) ------------------------------
// Both modes raycast against this group: play mode for ground-following
// camera height, maker mode for drag-to-move snapping.
const walkable = new THREE.Group();
walkable.name = 'walkable';
scene.add(walkable);

const groundSize = 200;
const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize);
groundGeo.rotateX(-Math.PI / 2);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x8aa46f, roughness: 1 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.receiveShadow = true;
ground.name = 'ground';
walkable.add(ground);

const grid = new THREE.GridHelper(groundSize, groundSize / 2, 0x556644, 0x556644);
grid.material.opacity = 0.25;
grid.material.transparent = true;
grid.position.y = 0.01;
scene.add(grid);

const terrainSlopes = createTerrain();
walkable.add(terrainSlopes);

// --- World & WS -----------------------------------------------------------
const world = new World(scene);
ws.connect();
ws.on('open', () => toast('Connected', 'ok', 1500));
ws.on('close', () => toast('Disconnected — retrying...', 'error', 2000));

// --- Modes ----------------------------------------------------------------
let currentMode = null;
let currentModeName = null;

function setMode(name) {
  if (currentModeName === name) return;
  if (currentMode) currentMode.dispose();
  setModeUI(name);
  if (name === 'maker') {
    currentMode = new MakerMode({ renderer, camera, scene, world, walkable });
  } else {
    currentMode = new PlayMode({ renderer, camera, scene, world, walkable });
  }
  currentMode.attach();
  currentModeName = name;
}

document.getElementById('mode-toggle').addEventListener('click', () => {
  setMode(currentModeName === 'maker' ? 'play' : 'maker');
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Tab' && !isTypingInForm(e.target)) {
    e.preventDefault();
    setMode(currentModeName === 'maker' ? 'play' : 'maker');
  }
});

function isTypingInForm(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

// Default mode: Maker (so an empty world isn't boring).
setMode('maker');

// --- Resize ---------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// --- Render loop ----------------------------------------------------------
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (currentMode && typeof currentMode.update === 'function') currentMode.update(dt);
  world.tick(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
