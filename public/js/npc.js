import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const TARGET_HEIGHT = 1.8; // world units; auto-scaled to this on import
const NAME_COLORS = ['#5aa9ff', '#7cd9ff', '#a4f0a0', '#ffc97c', '#ff8fa3', '#c79bff'];

function colorForId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return NAME_COLORS[h % NAME_COLORS.length];
}

/**
 * Build a "loading blob" used while a GLB is being generated. It's a glowing
 * low-poly icosphere that pulses, bobs, and rotates. The animation runs in
 * Npc.tick(dt) — call it from the render loop.
 */
function buildLoadingBlob({ color = '#5aa9ff' } = {}) {
  const group = new THREE.Group();
  group.userData.isLoadingBlob = true;

  const c = new THREE.Color(color);
  const mat = new THREE.MeshStandardMaterial({
    color: c,
    emissive: c.clone().multiplyScalar(0.85),
    emissiveIntensity: 1.2,
    roughness: 0.35,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    opacity: 0.92,
  });
  const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 1), mat);
  blob.position.y = 1.0;
  blob.castShadow = true;
  group.add(blob);

  // Soft glow halo around the blob (no shadows, additive-ish).
  const haloMat = new THREE.MeshBasicMaterial({
    color: c,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(new THREE.IcosahedronGeometry(0.95, 1), haloMat);
  halo.position.y = 1.0;
  group.add(halo);
  group.userData.haloRef = halo;
  group.userData.blobRef = blob;

  return group;
}

/**
 * Static stand-in shown when an NPC has no GLB (e.g. FAKE_GENERATOR mode).
 * Looks like a humanoid capsule so the world isn't full of identical spheres.
 */
function buildStaticPlaceholder({ color = '#5aa9ff' } = {}) {
  const group = new THREE.Group();
  const c = new THREE.Color(color);
  const mat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: 0.05 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 6, 12), mat);
  body.position.y = 0.95;
  body.castShadow = true;
  group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), mat.clone());
  head.position.y = 1.75;
  head.castShadow = true;
  group.add(head);
  return group;
}

function autoScaleAndCenter(root) {
  const box = new THREE.Box3().setFromObject(root);
  if (!isFinite(box.min.x) || box.isEmpty()) return;
  const size = new THREE.Vector3();
  box.getSize(size);
  const height = Math.max(size.y, 0.001);

  const scale = TARGET_HEIGHT / height;
  root.scale.multiplyScalar(scale);

  // Recompute box after scaling and align so that feet are at y=0,
  // and the model is centered horizontally over the spawn point.
  const box2 = new THREE.Box3().setFromObject(root);
  const center2 = new THREE.Vector3();
  box2.getCenter(center2);
  root.position.x -= center2.x;
  root.position.z -= center2.z;
  root.position.y -= box2.min.y;
}

function makeNameSprite(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 56px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(8, 10, 14, 0.78)';
  const padX = 30;
  const w = Math.min(canvas.width - 8, ctx.measureText(name).width + padX * 2);
  const x = (canvas.width - w) / 2;
  const y = 24;
  const r = 20;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + 80, r);
  ctx.arcTo(x + w, y + 80, x, y + 80, r);
  ctx.arcTo(x, y + 80, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(name, canvas.width / 2, y + 40);

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.6, 0.4, 1);
  sprite.renderOrder = 999;
  return sprite;
}

export class Npc {
  constructor(data) {
    this.data = { ...data };
    this.pending = !!data.pending;
    this.root = new THREE.Group();
    this.root.userData.npcId = data.id;
    this.modelRoot = null;
    this.placeholder = null;
    this.nameSprite = null;
    this.selection = null;
    this._t = Math.random() * Math.PI * 2; // animation phase per NPC

    this._applyTransform();
    this._buildPlaceholder();
    if (!this.pending && data.glb_url) this._loadGlb(data.glb_url);
    this._buildNameSprite();
  }

  tick(dt) {
    this._t += dt;
    // Animate the loading blob if one is present.
    if (this.placeholder && this.placeholder.userData?.isLoadingBlob) {
      const blob = this.placeholder.userData.blobRef;
      const halo = this.placeholder.userData.haloRef;
      const pulse = 0.85 + Math.sin(this._t * 3.5) * 0.15;
      blob.scale.setScalar(pulse);
      halo.scale.setScalar(1 + Math.sin(this._t * 3.5 + 0.5) * 0.18);
      const bob = Math.sin(this._t * 1.6) * 0.18;
      this.placeholder.position.y = bob;
      blob.rotation.y += dt * 0.8;
      blob.rotation.x += dt * 0.4;
      blob.material.emissiveIntensity = 0.9 + Math.sin(this._t * 4.0) * 0.4;
      halo.material.opacity = 0.12 + Math.sin(this._t * 3.5) * 0.08;
    }
  }

  _applyTransform() {
    const p = this.data.position || [0, 0, 0];
    const r = this.data.rotation || [0, 0, 0];
    const s = typeof this.data.scale === 'number' ? this.data.scale : 1;
    this.root.position.set(p[0] || 0, p[1] || 0, p[2] || 0);
    this.root.rotation.set(r[0] || 0, r[1] || 0, r[2] || 0);
    this.root.scale.setScalar(s);
  }

  _buildPlaceholder() {
    const color = colorForId(this.data.id);
    this.placeholder = this.pending
      ? buildLoadingBlob({ color })
      : buildStaticPlaceholder({ color });
    this.root.add(this.placeholder);
  }

  _buildNameSprite() {
    const name = this.data.name || '';
    if (!name) return;
    this.nameSprite = makeNameSprite(name);
    this.nameSprite.position.set(0, 2.3, 0);
    this.root.add(this.nameSprite);
  }

  _refreshNameSprite() {
    if (this.nameSprite) {
      this.root.remove(this.nameSprite);
      this.nameSprite.material.map?.dispose();
      this.nameSprite.material.dispose();
      this.nameSprite = null;
    }
    this._buildNameSprite();
  }

  _loadGlb(url) {
    loader.load(
      url,
      (gltf) => {
        const model = gltf.scene;
        model.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = false;
          }
        });
        autoScaleAndCenter(model);
        this.modelRoot = model;
        this.root.add(model);
        if (this.placeholder) {
          this.root.remove(this.placeholder);
          this.placeholder = null;
        }
      },
      undefined,
      (err) => {
        console.error('Failed to load GLB:', url, err);
      }
    );
  }

  /**
   * Update visuals when the underlying NPC data changes.
   * Pass `pending: false` and a fresh `data` object to "promote" a placeholder
   * NPC into a real one once generation completes.
   */
  update(patch) {
    Object.assign(this.data, patch);
    if ('position' in patch || 'rotation' in patch || 'scale' in patch) {
      this._applyTransform();
    }
    if ('name' in patch) this._refreshNameSprite();
  }

  promote(data) {
    this.data = { ...this.data, ...data, pending: false };
    this.pending = false;
    this._applyTransform();
    if (this.placeholder) {
      // Keep placeholder if no glb_url (fake mode) but make it solid.
      if (data.glb_url) {
        this.root.remove(this.placeholder);
        this.placeholder = null;
        this._loadGlb(data.glb_url);
      } else {
        this.root.remove(this.placeholder);
        this.placeholder = null;
        this._buildPlaceholder();
      }
    } else if (data.glb_url) {
      this._loadGlb(data.glb_url);
    }
    this._refreshNameSprite();
  }

  setSelected(selected) {
    if (selected && !this.selection) {
      const box = new THREE.Box3().setFromObject(this.root);
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const geom = new THREE.BoxGeometry(size.x + 0.1, size.y + 0.1, size.z + 0.1);
      const edges = new THREE.EdgesGeometry(geom);
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0x5aa9ff })
      );
      // The box is in world space; convert to local.
      this.root.worldToLocal(center);
      line.position.copy(center);
      this.selection = line;
      this.root.add(line);
    } else if (!selected && this.selection) {
      this.root.remove(this.selection);
      this.selection.geometry.dispose();
      this.selection.material.dispose();
      this.selection = null;
    }
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
      if (o.material?.map) o.material.map.dispose?.();
    });
  }
}
