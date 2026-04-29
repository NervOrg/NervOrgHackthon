import * as THREE from 'three';
import { Npc } from './npc.js';
import * as ws from './ws.js';
import { toast } from './ui.js';

export class World {
  constructor(scene) {
    this.scene = scene;
    this.npcs = new Map(); // id -> Npc
    this.group = new THREE.Group();
    this.group.name = 'npcs';
    scene.add(this.group);
    this._wireEvents();
  }

  _wireEvents() {
    ws.on('world_state', (msg) => {
      // Replace everything.
      for (const npc of this.npcs.values()) {
        this.group.remove(npc.root);
        npc.dispose();
      }
      this.npcs.clear();
      for (const data of msg.npcs) this._add(data);
    });

    ws.on('npc_pending', (msg) => {
      this._add({
        id: msg.id,
        prompt: msg.prompt,
        position: msg.position,
        rotation: msg.rotation || [0, 0, 0],
        scale: 1,
        name: 'generating...',
        dialogue: [],
        glb_url: null,
        pending: true,
      });
      toast(`Generating "${shortPrompt(msg.prompt)}"...`, 'info');
    });

    ws.on('npc_progress', (msg) => {
      const npc = this.npcs.get(msg.id);
      if (npc && msg.message) npc.update({ name: shortPrompt(npc.data.prompt) });
    });

    ws.on('npc_ready', (msg) => {
      const npc = this.npcs.get(msg.npc.id);
      if (npc) {
        npc.promote(msg.npc);
      } else {
        this._add(msg.npc);
      }
      toast(`"${msg.npc.name}" is here.`, 'ok');
    });

    ws.on('npc_failed', (msg) => {
      const npc = this.npcs.get(msg.id);
      if (npc) {
        this.group.remove(npc.root);
        npc.dispose();
        this.npcs.delete(msg.id);
      }
      toast(`Generation failed: ${msg.error || 'unknown error'}`, 'error', 6000);
    });

    ws.on('npc_updated', (msg) => {
      const npc = this.npcs.get(msg.id);
      if (npc) npc.update(msg.patch);
    });

    ws.on('npc_deleted', (msg) => {
      const npc = this.npcs.get(msg.id);
      if (!npc) return;
      this.group.remove(npc.root);
      npc.dispose();
      this.npcs.delete(msg.id);
    });

    ws.on('error', (msg) => {
      toast(msg.message || 'Server error', 'error');
    });
  }

  _add(data) {
    const npc = new Npc(data);
    this.npcs.set(data.id, npc);
    this.group.add(npc.root);
    return npc;
  }

  get(id) {
    return this.npcs.get(id);
  }

  *[Symbol.iterator]() {
    for (const v of this.npcs.values()) yield v;
  }

  tick(dt) {
    for (const npc of this.npcs.values()) npc.tick(dt);
  }

  /**
   * Find an NPC corresponding to a Three.js raycast hit.
   * Walks up the parent chain until it finds one tagged with userData.npcId.
   */
  npcFromObject(obj) {
    let cur = obj;
    while (cur) {
      if (cur.userData && cur.userData.npcId) return this.npcs.get(cur.userData.npcId);
      cur = cur.parent;
    }
    return null;
  }
}

function shortPrompt(p) {
  if (!p) return '...';
  return p.length > 32 ? p.slice(0, 30) + '…' : p;
}
