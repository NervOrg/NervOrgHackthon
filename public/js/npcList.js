import { on } from './ws.js';

const npcs = new Map();
const gens = new Map();
let selectedId = null;

// ── Connection status ──────────────────────────────────────────────────────

on('open',  () => setWsStatus('connected', 'Connected'));
on('close', () => setWsStatus('offline',   'Offline'));

function setWsStatus(kind, label) {
  const el = document.getElementById('ws-status');
  if (!el) return;
  const dot  = el.querySelector('.status-dot');
  const span = el.querySelector('span:last-child');
  if (dot)  dot.className  = `status-dot status-dot-${kind}`;
  if (span) span.textContent = label;
}

// ── WS event handlers ──────────────────────────────────────────────────────

on('world_state', (msg) => {
  npcs.clear();
  if (msg.npcs) {
    for (const npc of Object.values(msg.npcs)) npcs.set(npc.id, { ...npc });
  }
  renderList();
});

on('npc_pending', (msg) => {
  npcs.set(msg.id, { ...msg, pending: true });
  gens.set(msg.id, { name: msg.name || msg.prompt || msg.id, msgs: [] });
  renderList();
  renderQueue();
});

on('npc_progress', (msg) => {
  const gen = gens.get(msg.id);
  if (gen && msg.message) {
    gen.msgs.push(msg.message);
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
  npcs.set(msg.id, { ...msg, pending: false });
  gens.delete(msg.id);
  renderList();
  renderQueue();
});

on('npc_failed', (msg) => {
  npcs.delete(msg.id);
  gens.delete(msg.id);
  renderList();
  renderQueue();
});

on('npc_updated', (msg) => {
  const npc = npcs.get(msg.id);
  if (npc) Object.assign(npc, msg);
  renderList();
});

on('npc_deleted', (msg) => {
  npcs.delete(msg.id);
  gens.delete(msg.id);
  if (selectedId === msg.id) selectedId = null;
  renderList();
  renderQueue();
});

// ── Public API ─────────────────────────────────────────────────────────────

export function setSelectedId(id) {
  selectedId = id;
  renderList();
}

// ── Toolbar — Maker / Play mode buttons ───────────────────────────────────
// main.js owns #mode-toggle (hidden). We wire two visual buttons to it.

const toggle = () => document.getElementById('mode-toggle')?.click();

document.querySelector('.toolbar-maker-btn')?.addEventListener('click', () => {
  if (document.body.dataset.mode !== 'maker') toggle();
});

document.querySelector('.toolbar-play-btn')?.addEventListener('click', () => {
  if (document.body.dataset.mode !== 'play') toggle();
});

// ── Panel collapse (spawn panel) ──────────────────────────────────────────

document.getElementById('spawn-collapse-btn')?.addEventListener('click', () => {
  document.getElementById('spawn-panel')?.classList.toggle('panel-collapsed');
});

// ── Inspector tabs ────────────────────────────────────────────────────────

document.querySelectorAll('#edit-panel .panel-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;

    // Update tab button states
    document.querySelectorAll('#edit-panel .panel-tab').forEach((t) => {
      t.classList.toggle('panel-tab-active', t === btn);
    });

    // Show/hide panes
    document.querySelectorAll('#edit-panel [data-tab-pane]').forEach((pane) => {
      pane.hidden = pane.dataset.tabPane !== target;
    });
  });
});

// ── NPC list renderers ────────────────────────────────────────────────────

function renderList() {
  const el = document.getElementById('npc-list');
  if (!el) return;

  if (npcs.size === 0) {
    el.innerHTML = '<div class="empty-state">No NPCs yet — spawn one below</div>';
    return;
  }

  const html = [...npcs.values()].map((npc) => {
    const active  = npc.id === selectedId;
    const pending = npc.pending || gens.has(npc.id);
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

  const html = [...gens.values()].map((gen) => {
    const lastMsg = gen.msgs[gen.msgs.length - 1] || 'Generating…';
    return `<div class="gen-item">
        <div class="gen-item-name">${esc(gen.name)}</div>
        <div class="gen-item-msg">${esc(lastMsg)}</div>
      </div>`;
  }).join('');

  el.innerHTML = html;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
