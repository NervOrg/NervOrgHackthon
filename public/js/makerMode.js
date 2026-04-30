import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import * as ws from './ws.js';
import { toast } from './ui.js';
import { setSelectedId } from './npcList.js';

const FLY_SPEED = 10; // units / sec
const FAST_MULT = 2.5;
const DRAG_DEBOUNCE_MS = 80;

export class MakerMode {
  constructor({ renderer, camera, scene, world, walkable }) {
    this.renderer = renderer;
    this.camera = camera;
    this.scene = scene;
    this.world = world;
    this.walkable = walkable;
    this.controls = new PointerLockControls(camera, renderer.domElement);
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = Math.PI;

    this.keys = new Set();
    this.selected = null;
    this.dragMode = false;
    this.lastDragSent = 0;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this._bind = {
      keydown: this._onKeyDown.bind(this),
      keyup: this._onKeyUp.bind(this),
      click: this._onCanvasClick.bind(this),
      mousemove: this._onMouseMove.bind(this),
      pointerlockChange: this._onLockChange.bind(this),
      spawn: this._onSpawnClick.bind(this),
      editClose: () => this._select(null),
      addLine: this._onAddLine.bind(this),
      delete: this._onDelete.bind(this),
      moveToggle: this._onMoveToggle.bind(this),
      motionToggle: this._onMotionToggle.bind(this),
      listSelect: this._onListSelect.bind(this),
      undo: this._onUndo.bind(this),
      redo: this._onRedo.bind(this),
      promptKey: this._onPromptKeyDown.bind(this),
    };

    this._panelInputs = null;
    this._history = [];
    this._redo = [];
  }

  attach() {
    this.scene.add(this.controls.getObject());

    document.addEventListener('keydown', this._bind.keydown);
    document.addEventListener('keyup', this._bind.keyup);
    this.renderer.domElement.addEventListener('click', this._bind.click);
    this.renderer.domElement.addEventListener('mousemove', this._bind.mousemove);
    document.addEventListener('pointerlockchange', this._bind.pointerlockChange);

    document.getElementById('spawn-btn').addEventListener('click', this._bind.spawn);
    document.getElementById('prompt-input').addEventListener('keydown', this._bind.promptKey);
    document.getElementById('edit-close').addEventListener('click', this._bind.editClose);
    document.getElementById('edit-add-line').addEventListener('click', this._bind.addLine);
    document.getElementById('edit-delete').addEventListener('click', this._bind.delete);
    document.getElementById('edit-move').addEventListener('click', this._bind.moveToggle);
    document.getElementById('edit-motion')?.addEventListener('click', this._bind.motionToggle);
    document.addEventListener('select-npc', this._bind.listSelect);
    document.addEventListener('toolbar-undo', this._bind.undo);
    document.addEventListener('toolbar-redo', this._bind.redo);

    document.getElementById('spawn-panel').hidden = false;
  }

  dispose() {
    document.removeEventListener('keydown', this._bind.keydown);
    document.removeEventListener('keyup', this._bind.keyup);
    this.renderer.domElement.removeEventListener('click', this._bind.click);
    this.renderer.domElement.removeEventListener('mousemove', this._bind.mousemove);
    document.removeEventListener('pointerlockchange', this._bind.pointerlockChange);

    document.getElementById('spawn-btn').removeEventListener('click', this._bind.spawn);
    document.getElementById('prompt-input').removeEventListener('keydown', this._bind.promptKey);
    document.getElementById('edit-close').removeEventListener('click', this._bind.editClose);
    document.getElementById('edit-add-line').removeEventListener('click', this._bind.addLine);
    document.getElementById('edit-delete').removeEventListener('click', this._bind.delete);
    document.getElementById('edit-move').removeEventListener('click', this._bind.moveToggle);
    document.getElementById('edit-motion')?.removeEventListener('click', this._bind.motionToggle);
    document.removeEventListener('select-npc', this._bind.listSelect);
    document.removeEventListener('toolbar-undo', this._bind.undo);
    document.removeEventListener('toolbar-redo', this._bind.redo);

    if (this.controls.isLocked) this.controls.unlock();
    this.scene.remove(this.controls.getObject());

    document.getElementById('spawn-panel').hidden = true;
    document.getElementById('edit-panel').hidden = true;
    if (this.selected) this.selected.setSelected(false);
    this.selected = null;
    this.dragMode = false;
  }

  update(dt) {
    if (!this.controls.isLocked) return;
    let speed = FLY_SPEED * dt;
    if (this.keys.has('shiftleft') || this.keys.has('shiftright')) {
      // Shift = down (handled below). Ctrl could be fast in future.
    }
    if (this.keys.has('controlleft') || this.keys.has('controlright')) speed *= FAST_MULT;

    if (this.keys.has('keyw')) this.controls.moveForward(speed);
    if (this.keys.has('keys')) this.controls.moveForward(-speed);
    if (this.keys.has('keya')) this.controls.moveRight(-speed);
    if (this.keys.has('keyd')) this.controls.moveRight(speed);

    const obj = this.controls.getObject();
    if (this.keys.has('space')) obj.position.y += speed;
    if (this.keys.has('shiftleft') || this.keys.has('shiftright')) obj.position.y -= speed;
    if (obj.position.y < 0.1) obj.position.y = 0.1;
  }

  // --- Input ----------------------------------------------------------------

  _onKeyDown(e) {
    // Don't intercept keys typed into form fields.
    if (this._isTypingInForm(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    this.keys.add(e.code.toLowerCase());
    if (e.code === 'Escape' && this.controls.isLocked) this.controls.unlock();
  }

  _onKeyUp(e) {
    this.keys.delete(e.code.toLowerCase());
  }

  _isTypingInForm(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  _onMouseMove(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    if (this.dragMode && this.selected && (e.buttons & 1)) {
      const point = this._raycastGround();
      if (point) {
        const pos = [point.x, point.y, point.z];
        this.selected.update({ position: pos });
        this._syncPanelFromSelected();
        const now = performance.now();
        if (now - this.lastDragSent > DRAG_DEBOUNCE_MS) {
          this.lastDragSent = now;
          ws.send({
            type: 'update_npc',
            id: this.selected.data.id,
            patch: { position: pos },
          });
        }
      }
    }
  }

  _onCanvasClick(e) {
    // If user clicked on UI, ignore.
    if (e.target !== this.renderer.domElement) return;

    if (this.dragMode && this.selected) {
      // End the drag — commit final position once more.
      ws.send({
        type: 'update_npc',
        id: this.selected.data.id,
        patch: { position: this.selected.data.position },
      });
      this.dragMode = false;
      this._reflectMoveButton();
      return;
    }

    if (!this.controls.isLocked) {
      this.controls.lock();
      return;
    }

    // While locked, the pointer is at the centre. Use (0,0) for raycast.
    const center = new THREE.Vector2(0, 0);
    this.raycaster.setFromCamera(center, this.camera);
    const hits = this.raycaster.intersectObject(this.world.group, true);
    if (hits.length) {
      const npc = this.world.npcFromObject(hits[0].object);
      if (npc && !npc.pending) {
        this._select(npc);
        // Releasing the mouse is helpful so the user can edit.
        this.controls.unlock();
      }
    }
  }

  _onLockChange() {
    // Nothing for now; could update cursor styles.
  }

  _onPromptKeyDown(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this._onSpawnClick();
    }
  }

  // --- Spawning -------------------------------------------------------------

  _onSpawnClick() {
    const input = document.getElementById('prompt-input');
    const prompt = input.value.trim();
    const status = document.getElementById('spawn-status');
    if (!prompt) {
      status.textContent = 'Type a prompt first.';
      return;
    }
    const camera = this.camera;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const spawn = new THREE.Vector3()
      .copy(camera.position)
      .add(dir.multiplyScalar(5));

    // Ray-cast straight down to land the NPC's feet on whatever surface is
    // under the spawn point (flat ground or a slope).
    const groundY = this._sampleGroundY(spawn.x, spawn.z);

    const ok = ws.send({
      type: 'spawn_npc',
      prompt,
      position: [spawn.x, groundY, spawn.z],
      rotation: [0, Math.atan2(-dir.x, -dir.z), 0],
    });
    if (!ok) {
      toast('Not connected to server', 'error');
      return;
    }
    input.value = '';
    status.textContent = 'Queued. This may take a few minutes.';
    setTimeout(() => (status.textContent = ''), 5000);
  }

  // --- Selection / edit panel -----------------------------------------------

  _select(npc) {
    if (this.selected === npc) return;
    if (this.selected) this.selected.setSelected(false);
    this.selected = npc;
    if (npc) {
      npc.setSelected(true);
      setSelectedId(npc.data.id);
      this._openEditPanel(npc);
    } else {
      setSelectedId(null);
      document.getElementById('edit-panel').hidden = true;
      this.dragMode = false;
      this._reflectMoveButton();
    }
  }

  _openEditPanel(npc) {
    const panel = document.getElementById('edit-panel');
    panel.hidden = false;

    const name = document.getElementById('edit-name');
    name.value = npc.data.name || '';
    name.oninput = () => {
      const prev = { name: npc.data.name || '' };
      npc.update({ name: name.value });
      this._sendPatch({ name: name.value }, prev);
    };

    this._renderDialogueRows(npc);

    const px = document.getElementById('edit-px');
    const py = document.getElementById('edit-py');
    const pz = document.getElementById('edit-pz');
    const ry = document.getElementById('edit-ry');
    const sc = document.getElementById('edit-scale');
    const motion = document.getElementById('edit-motion');

    const sync = () => {
      px.value = npc.data.position[0].toFixed(2);
      py.value = npc.data.position[1].toFixed(2);
      pz.value = npc.data.position[2].toFixed(2);
      ry.value = String(npc.data.rotation[1]);
      sc.value = String(npc.data.scale ?? 1);
      if (motion) {
        motion.textContent = npc.data.movement_paused ? 'Start moving' : 'Stop moving';
        motion.classList.toggle('quiet-button-primary', !!npc.data.movement_paused);
      }
    };
    sync();
    this._panelInputs = { px, py, pz, ry, sc, motion, sync };

    const updatePos = () => {
      const prev = { position: [...npc.data.position] };
      const pos = [Number(px.value) || 0, Number(py.value) || 0, Number(pz.value) || 0];
      npc.update({ position: pos });
      this._sendPatch({ position: pos }, prev);
    };
    px.oninput = updatePos;
    py.oninput = updatePos;
    pz.oninput = updatePos;
    ry.oninput = () => {
      const prev = { rotation: [...npc.data.rotation] };
      const rot = [npc.data.rotation[0], Number(ry.value) || 0, npc.data.rotation[2]];
      npc.update({ rotation: rot });
      this._sendPatch({ rotation: rot }, prev);
    };
    sc.oninput = () => {
      const prev = { scale: npc.data.scale ?? 1 };
      const s = Number(sc.value) || 1;
      npc.update({ scale: s });
      this._sendPatch({ scale: s }, prev);
    };
  }

  _renderDialogueRows(npc) {
    const wrap = document.getElementById('edit-dialogue');
    wrap.innerHTML = '';
    const lines = Array.isArray(npc.data.dialogue) ? [...npc.data.dialogue] : [];
    if (lines.length === 0) lines.push('');

    lines.forEach((line, idx) => {
      const row = document.createElement('div');
      row.className = 'dialogue-row';
      const ta = document.createElement('textarea');
      ta.rows = 2;
      ta.value = line;
      ta.maxLength = 500;
      ta.placeholder = 'Line ' + (idx + 1);
      ta.oninput = () => {
        const all = Array.from(wrap.querySelectorAll('textarea')).map((t) => t.value);
        npc.data.dialogue = all;
        this._sendPatch({ dialogue: all });
      };
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '×';
      rm.title = 'Remove';
      rm.onclick = () => {
        row.remove();
        const all = Array.from(wrap.querySelectorAll('textarea')).map((t) => t.value);
        npc.data.dialogue = all;
        this._sendPatch({ dialogue: all });
      };
      row.appendChild(ta);
      row.appendChild(rm);
      wrap.appendChild(row);
    });
  }

  _onAddLine() {
    if (!this.selected) return;
    const wrap = document.getElementById('edit-dialogue');
    const all = Array.from(wrap.querySelectorAll('textarea')).map((t) => t.value);
    all.push('');
    this.selected.data.dialogue = all;
    this._renderDialogueRows(this.selected);
    this._sendPatch({ dialogue: all });
  }

  _onDelete() {
    if (!this.selected) return;
    const id = this.selected.data.id;
    const ok = window.confirm(`Delete "${this.selected.data.name || id}"?`);
    if (!ok) return;
    ws.send({ type: 'delete_npc', id });
    this._select(null);
  }

  _onMoveToggle() {
    if (!this.selected) return;
    this.dragMode = !this.dragMode;
    this._reflectMoveButton();
    if (this.dragMode) toast('Click & drag on the ground to move the NPC.', 'info', 2500);
  }

  _onMotionToggle() {
    if (!this.selected) return;
    const prev = { movement_paused: !!this.selected.data.movement_paused };
    const movementPaused = !this.selected.data.movement_paused;
    this.selected.update({ movement_paused: movementPaused });
    this._syncPanelFromSelected();
    this._sendPatch({ movement_paused: movementPaused }, prev);
    toast(movementPaused ? 'NPC movement stopped.' : 'NPC movement started.', 'info', 1800);
  }

  _onListSelect(e) {
    const id = e.detail?.id;
    if (!id) return;
    const npc = this.world.get(id);
    if (npc && !npc.pending) {
      this._select(npc);
      if (this.controls.isLocked) this.controls.unlock();
    }
  }

  _onUndo() {
    const entry = this._history.pop();
    if (!entry) {
      toast('Nothing to undo.', 'info', 1200);
      return;
    }
    this._applyHistoryEntry(entry.id, entry.prev);
    this._redo.push(entry);
  }

  _onRedo() {
    const entry = this._redo.pop();
    if (!entry) {
      toast('Nothing to redo.', 'info', 1200);
      return;
    }
    this._applyHistoryEntry(entry.id, entry.patch);
    this._history.push(entry);
  }

  _applyHistoryEntry(id, patch) {
    const npc = this.world.get(id);
    if (!npc) return;
    npc.update(patch);
    if (this.selected === npc) this._syncPanelFromSelected();
    ws.send({ type: 'update_npc', id, patch });
  }

  _reflectMoveButton() {
    const btn = document.getElementById('edit-move');
    btn.textContent = this.dragMode ? 'Cancel move' : 'Move (drag on ground)';
    btn.classList.toggle('danger', this.dragMode);
  }

  _syncPanelFromSelected() {
    if (this._panelInputs) this._panelInputs.sync();
  }

  _sendPatch(patch, previousPatch = null) {
    if (!this.selected) return;
    if (previousPatch) {
      this._history.push({ id: this.selected.data.id, patch, prev: previousPatch });
      this._redo.length = 0;
      if (this._history.length > 50) this._history.shift();
    }
    ws.send({ type: 'update_npc', id: this.selected.data.id, patch });
  }

  _raycastGround() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.walkable, true);
    return hits[0]?.point || null;
  }

  _sampleGroundY(x, z) {
    const origin = new THREE.Vector3(x, 100, z);
    this.raycaster.set(origin, new THREE.Vector3(0, -1, 0));
    this.raycaster.far = 200;
    const hits = this.raycaster.intersectObject(this.walkable, true);
    return hits.length ? hits[0].point.y : 0;
  }
}
