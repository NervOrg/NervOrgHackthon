import * as THREE from 'three';
import { Npc } from './npc.js';
import * as ws from './ws.js';
import { toast } from './ui.js';

export class World {
  constructor(scene) {
    this.scene = scene;
    this.npcs = new Map(); // id -> Npc
    this.generationRows = new Map(); // id -> DOM row
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
      this._upsertGenerationStatus(msg.id, {
        title: shortPrompt(msg.prompt),
        status: 'Generating',
        animationText: 'Animation: checking...',
        animationKind: '',
      });
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
      if (msg.message) {
        const parsed = parseAnimationProgress(msg.message);
        this._upsertGenerationStatus(msg.id, {
          status: shortProgress(msg.message),
          ...(parsed || {}),
        });
      }
    });

    ws.on('npc_ready', (msg) => {
      const npc = this.npcs.get(msg.npc.id);
      if (npc) {
        npc.promote(msg.npc);
      } else {
        this._add(msg.npc);
      }
      this._upsertGenerationStatus(msg.npc.id, {
        title: msg.npc.name || shortPrompt(msg.npc.prompt),
        status: 'Ready',
        ...animationStatusFromCount(msg.npc.animation_count || 0),
      });
      toast(`"${msg.npc.name}" is here.`, 'ok');
    });

    ws.on('npc_failed', (msg) => {
      const npc = this.npcs.get(msg.id);
      if (npc) {
        this.group.remove(npc.root);
        npc.dispose();
        this.npcs.delete(msg.id);
      }
      this._upsertGenerationStatus(msg.id, {
        status: 'Failed',
        animationText: 'Animation: failed',
        animationKind: 'error',
      });
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

  _upsertGenerationStatus(id, patch) {
    const wrap = document.getElementById('generation-status');
    if (!wrap) return;
    wrap.hidden = false;

    let row = this.generationRows.get(id);
    if (!row) {
      row = document.createElement('div');
      row.className = 'generation-row';
      row.innerHTML = [
        '<div class="generation-title"></div>',
        '<div class="generation-meta">',
        '  <span class="generation-progress"></span>',
        '  <span class="animation-badge"></span>',
        '</div>',
      ].join('');
      wrap.prepend(row);
      this.generationRows.set(id, row);
    }

    const title = patch.title || row.dataset.title || id;
    const status = patch.status || row.dataset.status || 'Working';
    const animationText = patch.animationText || row.dataset.animationText || 'Animation: checking...';
    const animationKind = patch.animationKind ?? row.dataset.animationKind ?? '';

    row.dataset.title = title;
    row.dataset.status = status;
    row.dataset.animationText = animationText;
    row.dataset.animationKind = animationKind;
    row.querySelector('.generation-title').textContent = title;
    row.querySelector('.generation-progress').textContent = status;
    const badge = row.querySelector('.animation-badge');
    badge.textContent = animationText;
    badge.className = `animation-badge ${animationKind}`.trim();

    while (wrap.children.length > 4) {
      const last = wrap.lastElementChild;
      const removeId = [...this.generationRows.entries()].find(([, el]) => el === last)?.[0];
      if (removeId) this.generationRows.delete(removeId);
      last.remove();
    }
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

function shortProgress(message) {
  const clean = String(message).replace(/\s+/g, ' ').trim();
  return clean.length > 36 ? clean.slice(0, 33) + '...' : clean;
}

function parseAnimationProgress(message) {
  const text = String(message);
  const match = text.match(/GLB contains (\d+) animation clip/);
  if (match) return animationStatusFromCount(Number(match[1]));
  if (text.includes('GLB contains no animation clips')) return animationStatusFromCount(0);
  return null;
}

function animationStatusFromCount(count) {
  return count > 0
    ? { animationText: `Animation: ${count} clip${count === 1 ? '' : 's'}`, animationKind: 'ok' }
    : { animationText: 'Animation: procedural', animationKind: 'fallback' };
}

function shortPrompt(p) {
  if (!p) return '...';
  return p.length > 32 ? p.slice(0, 30) + '…' : p;
}
