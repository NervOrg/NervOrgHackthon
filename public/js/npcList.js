import { on } from './ws.js';

const npcs = new Map();
const gens = new Map();
let selectedId = null;

on('open', () => setWsStatus('connected', 'Connected'));
on('close', () => setWsStatus('offline', 'Offline'));

function setWsStatus(kind, label) {
  const el = document.getElementById('ws-status');
  if (!el) return;
  const dot = el.querySelector('.status-dot');
  const span = el.querySelector('span:last-child');
  if (dot) dot.className = `status-dot status-dot-${kind}`;
  if (span) span.textContent = label;
}

on('world_state', (msg) => {
  npcs.clear();
  if (msg.npcs) {
    for (const npc of Object.values(msg.npcs)) npcs.set(npc.id, { ...npc });
  }
  renderList();
});

on('npc_pending', (msg) => {
  npcs.set(msg.id, { ...msg, pending: true });
  gens.set(msg.id, {
    name: msg.name || msg.prompt || msg.id,
    msgs: [],
    animationText: 'Animation: checking...',
    animationKind: '',
    done: false,
  });
  renderList();
  renderQueue();
});

on('npc_progress', (msg) => {
  const gen = gens.get(msg.id);
  if (gen && msg.message) {
    gen.msgs.push(msg.message);
    Object.assign(gen, parseAnimationProgress(msg.message) || {});
    renderQueue();
  }
  const npc = npcs.get(msg.id);
  if (npc && msg.name) {
    npc.name = msg.name;
    if (gens.has(msg.id)) gens.get(msg.id).name = msg.name;
    renderList();
  }
});

on('npc_ready', (msg) => {
  const npc = msg.npc || msg;
  npcs.set(npc.id, { ...npc, pending: false });
  const gen = gens.get(npc.id) || { msgs: [] };
  Object.assign(gen, {
    name: npc.name || npc.prompt || npc.id,
    msgs: [...(gen.msgs || []), 'Ready'],
    done: true,
    ...animationStatusFromCount(npc.animation_count || 0),
  });
  gens.set(npc.id, gen);
  renderList();
  renderQueue();
});

on('npc_failed', (msg) => {
  npcs.delete(msg.id);
  const gen = gens.get(msg.id) || { name: msg.id, msgs: [] };
  Object.assign(gen, {
    msgs: [...(gen.msgs || []), msg.error || 'Generation failed'],
    animationText: 'Animation: failed',
    animationKind: 'error',
    done: true,
  });
  gens.set(msg.id, gen);
  renderList();
  renderQueue();
});

on('npc_updated', (msg) => {
  const npc = npcs.get(msg.id);
  if (npc) Object.assign(npc, msg.patch || msg);
  renderList();
});

on('npc_deleted', (msg) => {
  npcs.delete(msg.id);
  gens.delete(msg.id);
  if (selectedId === msg.id) selectedId = null;
  renderList();
  renderQueue();
});

export function setSelectedId(id) {
  selectedId = id;
  renderList();
}

const toggle = () => document.getElementById('mode-toggle')?.click();

document.querySelector('.toolbar-maker-btn')?.addEventListener('click', () => {
  if (document.body.dataset.mode !== 'maker') toggle();
});

document.querySelector('.toolbar-play-btn')?.addEventListener('click', () => {
  if (document.body.dataset.mode !== 'play') toggle();
});

document.getElementById('spawn-collapse-btn')?.addEventListener('click', () => {
  document.getElementById('spawn-panel')?.classList.toggle('panel-collapsed');
});

document.getElementById('npc-list')?.addEventListener('click', (e) => {
  const item = e.target.closest('.npc-list-item');
  if (!item) return;
  const id = item.dataset.npcId;
  if (!id) return;
  selectedId = id;
  renderList();
  document.dispatchEvent(new CustomEvent('select-npc', { detail: { id } }));
});

document.querySelectorAll('#edit-panel .panel-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('#edit-panel .panel-tab').forEach((tab) => {
      tab.classList.toggle('panel-tab-active', tab === btn);
    });
    document.querySelectorAll('#edit-panel [data-tab-pane]').forEach((pane) => {
      pane.hidden = pane.dataset.tabPane !== target;
    });
  });
});

function renderList() {
  const el = document.getElementById('npc-list');
  if (!el) return;

  if (npcs.size === 0) {
    el.innerHTML = '<div class="empty-state">No NPCs yet - spawn one below</div>';
    return;
  }

  const html = [...npcs.values()].map((npc) => {
    const active = npc.id === selectedId;
    const pending = npc.pending || (gens.has(npc.id) && !gens.get(npc.id).done);
    return `<button
        class="npc-list-item${active ? ' npc-list-item-active' : ''}"
        data-npc-id="${esc(npc.id)}"
        title="${esc(npc.name || 'Unnamed')}"
      >
        <span class="npc-list-dot${pending ? ' npc-list-dot-pending' : ''}"></span>
        <span class="npc-list-name">${esc(npc.name || 'Unnamed')}</span>
      </button>`;
  }).join('');

  el.innerHTML = html;
}

function renderQueue() {
  const el = document.getElementById('generation-queue');
  if (!el) return;

  if (gens.size === 0) {
    el.innerHTML = '';
    return;
  }

  const html = [...gens.values()].slice(-4).reverse().map((gen) => {
    const lastMsg = gen.msgs[gen.msgs.length - 1] || 'Generating...';
    const animationText = gen.animationText || 'Animation: checking...';
    const animationKind = gen.animationKind || '';
    return `<div class="gen-item">
        <div class="gen-item-name">${esc(gen.name)}</div>
        <div class="gen-item-msg">${esc(lastMsg)}</div>
        <div class="gen-item-meta">
          <span class="animation-badge ${esc(animationKind)}">${esc(animationText)}</span>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = html;
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

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
