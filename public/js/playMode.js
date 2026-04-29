import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const WALK_SPEED = 5;
const EYE_HEIGHT = 1.7;
const TALK_DISTANCE = 3.5;
const GROUND_RAY_HEIGHT = 50; // start ray this far above the player

export class PlayMode {
  constructor({ renderer, camera, scene, world, walkable }) {
    this.renderer = renderer;
    this.camera = camera;
    this.scene = scene;
    this.world = world;
    this.walkable = walkable;
    this.controls = new PointerLockControls(camera, renderer.domElement);

    this.keys = new Set();
    this.raycaster = new THREE.Raycaster();
    this.groundRay = new THREE.Raycaster();
    this.targetNpc = null;
    this.activeNpc = null;
    this.dialogueIndex = 0;

    this._bind = {
      keydown: this._onKeyDown.bind(this),
      keyup: this._onKeyUp.bind(this),
      click: this._onClick.bind(this),
    };
  }

  attach() {
    this.scene.add(this.controls.getObject());
    // Spawn at origin, eye height, facing -Z.
    const obj = this.controls.getObject();
    obj.position.set(0, EYE_HEIGHT, 6);
    this.camera.rotation.set(0, 0, 0);

    document.addEventListener('keydown', this._bind.keydown);
    document.addEventListener('keyup', this._bind.keyup);
    this.renderer.domElement.addEventListener('click', this._bind.click);

    document.getElementById('crosshair').hidden = false;
  }

  dispose() {
    document.removeEventListener('keydown', this._bind.keydown);
    document.removeEventListener('keyup', this._bind.keyup);
    this.renderer.domElement.removeEventListener('click', this._bind.click);

    if (this.controls.isLocked) this.controls.unlock();
    this.scene.remove(this.controls.getObject());

    document.getElementById('interact-hint').hidden = true;
    document.getElementById('dialogue-panel').hidden = true;
    document.getElementById('crosshair').hidden = false;
    this.activeNpc?.setEngaged?.(false);
    this.activeNpc = null;
    this.targetNpc = null;
  }

  update(dt) {
    if (this.activeNpc) {
      // Freeze movement while in dialogue.
    } else if (this.controls.isLocked) {
      const speed = WALK_SPEED * dt;
      // PointerLockControls.moveForward only moves on the XZ plane, so this
      // already gives us the "look down doesn't sink you" behaviour we want.
      if (this.keys.has('keyw')) this.controls.moveForward(speed);
      if (this.keys.has('keys')) this.controls.moveForward(-speed);
      if (this.keys.has('keya')) this.controls.moveRight(-speed);
      if (this.keys.has('keyd')) this.controls.moveRight(speed);
      this._followGround();
    }

    if (!this.activeNpc) this._updateInteractTarget();
  }

  _followGround() {
    if (!this.walkable) return;
    const obj = this.controls.getObject();
    // Cast a ray straight down from well above the player to find the
    // highest walkable surface beneath them (so we walk over the slopes
    // instead of through them).
    const origin = new THREE.Vector3(obj.position.x, obj.position.y + GROUND_RAY_HEIGHT, obj.position.z);
    this.groundRay.set(origin, new THREE.Vector3(0, -1, 0));
    this.groundRay.far = GROUND_RAY_HEIGHT * 2;
    const hits = this.groundRay.intersectObject(this.walkable, true);
    if (hits.length) {
      obj.position.y = hits[0].point.y + EYE_HEIGHT;
    } else {
      obj.position.y = EYE_HEIGHT;
    }
  }

  _updateInteractTarget() {
    const center = new THREE.Vector2(0, 0);
    this.raycaster.setFromCamera(center, this.camera);
    this.raycaster.far = TALK_DISTANCE + 1;
    const hits = this.raycaster.intersectObject(this.world.group, true);
    let target = null;
    if (hits.length) {
      const npc = this.world.npcFromObject(hits[0].object);
      if (npc && !npc.pending && hits[0].distance <= TALK_DISTANCE) target = npc;
    }
    if (target !== this.targetNpc) {
      this.targetNpc = target;
      const hint = document.getElementById('interact-hint');
      if (target) {
        hint.innerHTML = `Press <kbd>E</kbd> to talk to <strong>${escapeHtml(
          target.data.name || 'NPC'
        )}</strong>`;
        hint.hidden = false;
      } else {
        hint.hidden = true;
      }
    }
  }

  _onKeyDown(e) {
    this.keys.add(e.code.toLowerCase());

    if (this.activeNpc) {
      if (e.code === 'Escape') {
        this._endDialogue();
        e.preventDefault();
        return;
      }
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        this._advanceDialogue();
        return;
      }
    } else if (e.code === 'KeyE' && this.targetNpc) {
      this._startDialogue(this.targetNpc);
      e.preventDefault();
    } else if (e.code === 'Escape' && this.controls.isLocked) {
      this.controls.unlock();
    }
  }

  _onKeyUp(e) {
    this.keys.delete(e.code.toLowerCase());
  }

  _onClick(e) {
    if (e.target !== this.renderer.domElement) return;
    if (this.activeNpc) {
      this._advanceDialogue();
      return;
    }
    if (!this.controls.isLocked) this.controls.lock();
  }

  _startDialogue(npc) {
    this.activeNpc = npc;
    npc.setEngaged?.(true);
    this.dialogueIndex = 0;
    if (this.controls.isLocked) this.controls.unlock();

    const panel = document.getElementById('dialogue-panel');
    panel.hidden = false;
    document.getElementById('interact-hint').hidden = true;
    this._renderDialogueLine();
  }

  _renderDialogueLine() {
    const npc = this.activeNpc;
    if (!npc) return;
    const lines = (npc.data.dialogue && npc.data.dialogue.length > 0)
      ? npc.data.dialogue
      : ['(this NPC has nothing to say yet)'];
    const line = lines[this.dialogueIndex] || '';
    document.getElementById('dialogue-name').textContent = npc.data.name || 'NPC';
    document.getElementById('dialogue-line').textContent = line;
    document.getElementById('dialogue-progress').textContent =
      `${this.dialogueIndex + 1} / ${lines.length}`;
  }

  _advanceDialogue() {
    if (!this.activeNpc) return;
    const lines = this.activeNpc.data.dialogue || [];
    this.dialogueIndex += 1;
    if (this.dialogueIndex >= Math.max(lines.length, 1)) {
      this._endDialogue();
    } else {
      this._renderDialogueLine();
    }
  }

  _endDialogue() {
    this.activeNpc?.setEngaged?.(false);
    this.activeNpc = null;
    this.dialogueIndex = 0;
    document.getElementById('dialogue-panel').hidden = true;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
