import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toast } from './ui.js';

const loader = new GLTFLoader();
const TARGET_HEIGHT = 1.8; // world units; auto-scaled to this on import
const NAME_COLORS = ['#5aa9ff', '#7cd9ff', '#a4f0a0', '#ffc97c', '#ff8fa3', '#c79bff'];
const WANDER_RADIUS = 1.8;
const WANDER_SPEED = 0.55;

function colorForId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return NAME_COLORS[h % NAME_COLORS.length];
}

function slugifyPartId(value, fallback = 'part') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || fallback;
}

function uniquePartId(parts, partId, index) {
  if (!parts.has(partId)) return partId;
  return `${partId}_${index + 1}`;
}

function materialColorHex(material) {
  const mat = Array.isArray(material) ? material.find((entry) => entry?.color) : material;
  return mat?.color ? `#${mat.color.getHexString()}` : '#ffffff';
}

function isEditablePartName(name) {
  return !/(^|[_\-\s])(detail|decoration|decor|decal|trimline|seam|rivet|button|stitch|whisker|claw|tooth|teeth)([_\-\s]|\d|$)/i
    .test(String(name || ''));
}

function dispatchNpcPartsReady(npcId, parts) {
  window.__npcPartsByNpcId ??= new Map();
  window.__npcPartsByNpcId.set(npcId, parts);
  document.dispatchEvent(new CustomEvent('npc-parts-ready', {
    detail: { npcId, parts },
  }));
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

function cacheBustedUrl(url, key) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${encodeURIComponent(key || Date.now())}`;
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

function classifyNpc(data) {
  const text = `${data.name || ''} ${data.prompt || ''}`.toLowerCase();
  if (/(car|vehicle|truck|lamborghini|mclaren|p1|bike|motorcycle)/.test(text)) return 'vehicle';
  if (/(gem|crystal|stone|orb|artifact|treasure)/.test(text)) return 'object';
  if (/(soldier|solder|marine|wizard|kid|slayer|dreadnought|person|human|npc)/.test(text)) return 'character';
  return 'character';
}

export class Npc {
  constructor(data) {
    this.id = data.id;
    this.data = { ...data };
    this.pending = !!data.pending;
    this.root = new THREE.Group();
    this.root.userData.npcId = data.id;
    this.modelRoot = null;
    this.mixer = null;
    this.actions = [];
    this.hasClipAnimation = false;
    this.placeholder = null;
    this.nameSprite = null;
    this.selection = null;
    this._components = Array.isArray(data.components) ? data.components : [];
    this._parts = new Map();
    this._selectedPartId = null;
    this._partHelper = null;
    this._t = Math.random() * Math.PI * 2; // animation phase per NPC
    this._life = {
      kind: classifyNpc(this.data),
      home: new THREE.Vector3(),
      target: null,
      nextDecisionAt: 0,
      engaged: false,
      visualBase: new THREE.Vector3(),
      speed: WANDER_SPEED * (0.75 + Math.random() * 0.5),
    };

    this._applyTransform();
    this._life.home.copy(this.root.position);
    this._buildPlaceholder();
    if (!this.pending && data.glb_url) this._loadGlb(data.glb_url);
    this._buildNameSprite();
  }

  tick(dt) {
    this._t += dt;
    this._partHelper?.update?.();
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
    if (!this.pending) this._tickLife(dt);
  }

  _applyTransform() {
    const p = this.data.position || [0, 0, 0];
    const r = this.data.rotation || [0, 0, 0];
    const s = typeof this.data.scale === 'number' ? this.data.scale : 1;
    this.root.position.set(p[0] || 0, p[1] || 0, p[2] || 0);
    this.root.rotation.set(r[0] || 0, r[1] || 0, r[2] || 0);
    this.root.scale.setScalar(s);
    if (this._life) this._life.home.copy(this.root.position);
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
    const loadUrl = cacheBustedUrl(url, this.data.id);
    loader.load(
      loadUrl,
      (gltf) => {
        this._clearClipAnimation();
        const model = gltf.scene;
        model.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = false;
          }
        });
        autoScaleAndCenter(model);
        this._life.visualBase.copy(model.position);
        this.modelRoot = model;
        this._setupClipAnimation(gltf);
        this.root.add(model);
        this._buildPartRegistry(model);
        if (this.placeholder) {
          this.root.remove(this.placeholder);
          this.placeholder = null;
        }
      },
      undefined,
      (err) => {
        console.error('Failed to load GLB:', loadUrl, err);
        toast(`Model file loaded in Blender, but the app could not display it. Check DevTools for ${url}.`, 'error', 7000);
      }
    );
  }

  _buildPartRegistry(gltfScene) {
    this.clearPartSelection();
    this._parts = new Map();
    const hasExplicitComponents = this._components.length > 0;

    const byMeshIndex = new Map(
      this._components.map((component) => [component.meshIndex, component])
    );

    let fallbackIndex = 0;
    gltfScene.traverse((object) => {
      if (!object.isMesh) return;
      object.userData.npcId = this.id;

      const component = byMeshIndex.get(object.userData.meshIndex ?? fallbackIndex)
        ?? this._components.find((entry) => slugifyPartId(entry.name) === slugifyPartId(object.name));

      if (hasExplicitComponents && !component) {
        fallbackIndex++;
        return;
      }
      if (!component && !isEditablePartName(object.name)) {
        fallbackIndex++;
        return;
      }

      const partId = uniquePartId(
        this._parts,
        component?.partId ?? slugifyPartId(object.name, `part_${fallbackIndex + 1}`),
        fallbackIndex
      );

      object.userData.partId = partId;
      this._parts.set(partId, object);
      fallbackIndex++;
    });

    dispatchNpcPartsReady(this.id, this.getParts());
  }

  _setupClipAnimation(gltf) {
    const clips = gltf.animations || [];
    this.hasClipAnimation = clips.length > 0;
    if (!this.hasClipAnimation) return;

    this.mixer = new THREE.AnimationMixer(this.modelRoot);
    const preferredClip = clips.find((clip) => /idle|loop|walk|hover|spin/i.test(clip.name)) || clips[0];
    this.actions = clips.map((clip) => {
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      action.clampWhenFinished = false;
      action.setLoop(THREE.LoopRepeat);
      return action;
    });
    this.mixer.clipAction(preferredClip).play();
    console.info(`Playing animation "${preferredClip.name || 'clip'}" for ${this.data.name || this.data.id}`);
  }

  _clearClipAnimation() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      if (this.modelRoot) this.mixer.uncacheRoot(this.modelRoot);
    }
    this.mixer = null;
    this.actions = [];
    this.hasClipAnimation = false;
  }

  /**
   * Update visuals when the underlying NPC data changes.
   * Pass `pending: false` and a fresh `data` object to "promote" a placeholder
   * NPC into a real one once generation completes.
   */
  update(patch) {
    Object.assign(this.data, patch);
    if ('name' in patch || 'prompt' in patch) this._life.kind = classifyNpc(this.data);
    if ('position' in patch || 'rotation' in patch || 'scale' in patch) {
      this._applyTransform();
    }
    if ('name' in patch) this._refreshNameSprite();
  }

  setComponents(components) {
    this._components = Array.isArray(components) ? components : [];
  }

  promote(data) {
    this.data = { ...this.data, ...data, pending: false };
    this.pending = false;
    this._applyTransform();
    if (this.placeholder) {
      // Keep placeholder if no glb_url (fake mode) but make it solid.
      if (data.glb_url) {
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

  setEngaged(engaged) {
    this._life.engaged = engaged;
    this._life.target = null;
  }

  _tickLife(dt) {
    const body = this.modelRoot || this.placeholder;
    if (!body) return;
    if (this.data.movement_paused) return;
    if (this.mixer) this.mixer.update(dt);

    if (this.hasClipAnimation) {
      if (!this._life.engaged) this._tickWander(dt, this._life.kind === 'vehicle' ? 0.9 : 1);
      return;
    }

    const bob = Math.sin(this._t * 2.2) * 0.025;
    const breathe = 1 + Math.sin(this._t * 2.0) * 0.012;
    const talk = this._life.engaged ? Math.sin(this._t * 10.0) * 0.045 : 0;

    if (this._life.kind === 'object') {
      body.position.y = this._life.visualBase.y + 0.12 + Math.sin(this._t * 1.8) * 0.08;
      body.rotation.y += dt * 0.35;
      body.scale.setScalar(1 + Math.sin(this._t * 2.5) * 0.025);
      return;
    }

    if (this._life.kind === 'vehicle') {
      this._tickWander(dt, 0.9);
      body.position.y = this._life.visualBase.y + Math.sin(this._t * 8.0) * 0.006;
      body.rotation.z = Math.sin(this._t * 4.5) * 0.01;
      return;
    }

    if (!this._life.engaged) this._tickWander(dt, 1);
    body.position.y = this._life.visualBase.y + bob + talk;
    body.rotation.x = Math.sin(this._t * 1.7) * 0.018;
    body.rotation.z = Math.sin(this._t * 1.3) * 0.012;
    body.scale.set(1 / breathe, breathe, 1 / breathe);
  }

  _tickWander(dt, speedMultiplier) {
    if (this._t < this._life.nextDecisionAt && !this._life.target) return;
    if (!this._life.target) this._pickWanderTarget();

    const toTarget = new THREE.Vector3().subVectors(this._life.target, this.root.position);
    toTarget.y = 0;
    const distance = toTarget.length();
    if (distance < 0.08) {
      this._life.target = null;
      this._life.nextDecisionAt = this._t + 1.5 + Math.random() * 3.5;
      return;
    }

    const step = Math.min(distance, this._life.speed * speedMultiplier * dt);
    const dir = toTarget.multiplyScalar(1 / Math.max(distance, 0.0001));
    this.root.position.addScaledVector(dir, step);

    const targetYaw = Math.atan2(dir.x, dir.z);
    const delta = Math.atan2(
      Math.sin(targetYaw - this.root.rotation.y),
      Math.cos(targetYaw - this.root.rotation.y)
    );
    this.root.rotation.y += delta * Math.min(1, dt * 5);
  }

  _pickWanderTarget() {
    const angle = Math.random() * Math.PI * 2;
    const radius = WANDER_RADIUS * (0.25 + Math.random() * 0.75);
    this._life.target = this._life.home.clone().add(new THREE.Vector3(
      Math.sin(angle) * radius,
      0,
      Math.cos(angle) * radius
    ));
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

  setSelectedPart(partId) {
    this.clearPartSelection();
    const mesh = this._parts.get(partId);
    if (!mesh) return;

    this._selectedPartId = partId;
    const box = new THREE.BoxHelper(mesh, 0xf5a623);
    box.userData.isPartHelper = true;
    box.raycast = () => {};
    (this.root.parent ?? this.root).add(box);
    this._partHelper = box;
  }

  clearPartSelection() {
    if (this._partHelper) {
      this._partHelper.parent?.remove(this._partHelper);
      this._partHelper.geometry?.dispose?.();
      this._partHelper.material?.dispose?.();
      this._partHelper = null;
    }
    this._selectedPartId = null;
  }

  getPartIds() {
    return Array.from(this._parts.keys());
  }

  getParts() {
    return this.getPartIds().map((partId) => ({
      partId,
      name: this.getPartName(partId),
      color: this.getPartColor(partId),
      visible: this.isPartVisible(partId),
    }));
  }

  getPartName(partId) {
    const component = this._components.find((entry) => entry.partId === partId);
    return component?.name ?? partId;
  }

  getPartColor(partId) {
    const mesh = this._parts.get(partId);
    return mesh ? materialColorHex(mesh.material) : '#ffffff';
  }

  isPartVisible(partId) {
    const mesh = this._parts.get(partId);
    return mesh ? mesh.visible !== false : true;
  }

  setPartColor(partId, color) {
    const mesh = this._parts.get(partId);
    if (!mesh || !color) return;

    const applyColor = (material) => {
      if (!material?.color) return material;
      const next = material.userData?.partRegistryClone ? material : material.clone();
      next.userData.partRegistryClone = true;
      next.color.set(color);
      if (next.emissive) next.emissive.set(0x000000);
      next.needsUpdate = true;
      return next;
    };

    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((material) => applyColor(material))
      : applyColor(mesh.material);
    dispatchNpcPartsReady(this.id, this.getParts());
  }

  setPartVisible(partId, visible) {
    const mesh = this._parts.get(partId);
    if (!mesh) return;
    mesh.visible = visible !== false;
    if (this._selectedPartId === partId) {
      this._partHelper?.update?.();
    }
    dispatchNpcPartsReady(this.id, this.getParts());
  }

  dispose() {
    this.clearPartSelection();
    this._clearClipAnimation();
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
