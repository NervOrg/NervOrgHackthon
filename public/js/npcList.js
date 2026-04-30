import { on, send } from './ws.js';

const npcs = new Map();
const gens = new Map();
const npcParts = new Map();
const partState = new Map();
let selectedId = null;
let _activeNpcId = null;
let _activePartId = null;
let partColorThrottle = null;
let pendingPartColor = null;

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
  npcParts.clear();
  if (msg.npcs) {
    for (const npc of Object.values(msg.npcs)) {
      npcs.set(npc.id, { ...npc });
      cacheNpcComponents(npc);
    }
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
  const npc = { ...(msg.npc || msg) };
  if (!Array.isArray(npc.components) && Array.isArray(msg.components)) {
    npc.components = msg.components;
  }
  npcs.set(npc.id, { ...npc, pending: false });
  cacheNpcComponents(npc);
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
  if (msg.id === selectedId) renderPartList(npc);
});

on('npc_deleted', (msg) => {
  npcs.delete(msg.id);
  npcParts.delete(msg.id);
  gens.delete(msg.id);
  if (selectedId === msg.id) {
    selectedId = null;
    clearPartPanel();
  }
  renderList();
  renderQueue();
});

on('npc_part_updated', (msg) => {
  updatePartState(msg.id, msg.partId, msg.patch || {});
  if (msg.id === selectedId) applyPartStateToRow(msg.id, msg.partId);
  if (msg.id === _activeNpcId && msg.partId === _activePartId) syncPartInputs(msg.id, msg.partId);
});

on('npc_part_pending', (msg) => {
  setPartStatus(msg.id, msg.partId, 'Generating', 'progress');
});

on('npc_part_ready', (msg) => {
  setPartStatus(msg.id, msg.partId, 'Ready', 'ready');
  if (msg.id === _activeNpcId && msg.partId === _activePartId) {
    const btn = document.getElementById('part-generate-btn');
    if (btn) btn.disabled = false;
  }
});

on('npc_part_failed', (msg) => {
  setPartStatus(msg.id, msg.partId, 'Failed', 'failed');
  if (msg.id === _activeNpcId && msg.partId === _activePartId) {
    const btn = document.getElementById('part-generate-btn');
    if (btn) btn.disabled = false;
  }
});

export function setSelectedId(id) {
  if (!id) {
    clearPartPanel();
  } else if (id !== selectedId) {
    clearPartPanel();
  }
  selectedId = id;
  renderList();
  if (id) renderPartList(npcs.get(id));
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
  if (id !== selectedId) clearPartPanel();
  selectedId = id;
  renderList();
  renderPartList(npcs.get(id));
  document.dispatchEvent(new CustomEvent('select-npc', { detail: { id } }));
});

document.getElementById('edit-close')?.addEventListener('click', clearPartPanel);

document.addEventListener('select-npc', (e) => {
  const id = e.detail?.id;
  if (!id) return;
  if (id !== selectedId) clearPartPanel();
  selectedId = id;
  renderList();
  renderPartList(npcs.get(id));
});

document.addEventListener('select-part', (e) => {
  const { npcId, partId } = e.detail || {};
  if (!npcId || !partId) return;
  const npc = npcs.get(npcId);
  if (npcId !== selectedId) {
    selectedId = npcId;
    renderList();
    renderPartList(npc);
  }
  const name = getPartName(npc, partId);
  setActivePart(npcId, partId, name);

  const panel = document.getElementById('edit-panel');
  if (panel && !panel.hidden) switchToTab('parts');
});

document.addEventListener('npc-parts-ready', (e) => {
  const { npcId, parts } = e.detail || {};
  if (!npcId || !Array.isArray(parts)) return;
  npcParts.set(npcId, normalizeParts(parts));
  const npc = npcs.get(npcId);
  if (npc) npc.components = npcParts.get(npcId);
  if (npcId === selectedId) renderPartList(npc);
});

document.getElementById('part-color')?.addEventListener('input', (e) => {
  if (!_activeNpcId || !_activePartId) return;
  pendingPartColor = {
    npcId: _activeNpcId,
    partId: _activePartId,
    color: e.target.value,
  };
  updatePartState(_activeNpcId, _activePartId, { color: pendingPartColor.color });
  schedulePartColorSend();
});

document.getElementById('part-visible')?.addEventListener('change', (e) => {
  if (!_activeNpcId || !_activePartId) return;
  send({
    type: 'update_npc_part',
    id: _activeNpcId,
    partId: _activePartId,
    patch: { visible: e.target.checked },
  });
});

document.getElementById('part-generate-btn')?.addEventListener('click', () => {
  const promptEl = document.getElementById('part-prompt');
  const btn = document.getElementById('part-generate-btn');
  const prompt = promptEl?.value.trim();
  if (!prompt || !_activeNpcId || !_activePartId) return;

  send({
    type: 'spawn_part',
    npcId: _activeNpcId,
    partId: _activePartId,
    prompt,
  });

  setPartStatus(_activeNpcId, _activePartId, 'Generating', 'progress');
  if (btn) btn.disabled = true;
  if (promptEl) promptEl.value = '';
});

document.querySelectorAll('#edit-panel .panel-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    switchToTab(btn.dataset.tab);
    if (btn.dataset.tab === 'parts' && selectedId) renderPartList(npcs.get(selectedId));
  });
});

function switchToTab(target) {
  document.querySelectorAll('#edit-panel .panel-tab').forEach((tab) => {
    tab.classList.toggle('panel-tab-active', tab.dataset.tab === target);
  });
  document.querySelectorAll('#edit-panel [data-tab-pane]').forEach((pane) => {
    pane.hidden = pane.dataset.tabPane !== target;
  });
}

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

function renderPartList(npc) {
  const container = document.getElementById('part-list');
  if (!container) return;

  const parts = getPartsForNpc(npc);
  if (parts.length === 0) {
    container.innerHTML = '<div class="empty-state">No parts detected</div>';
    document.getElementById('part-edit')?.setAttribute('hidden', '');
    return;
  }

  container.innerHTML = parts.map(({ partId, name }) => {
    const state = getPartState(npc?.id || selectedId, partId);
    return `<div class="part-item${partId === _activePartId ? ' part-item-active' : ''}" data-part-id="${esc(partId)}" data-visible="${state.visible === false ? 'false' : 'true'}"${state.color ? ` style="--part-color: ${esc(state.color)}"` : ''}>
        <span class="part-item-name">${esc(name)}</span>
        <span class="part-status" data-part-status="${esc(partId)}">${esc(state.statusText || '')}</span>
      </div>`;
  }).join('');

  container.querySelectorAll('.part-item').forEach((row) => {
    const status = row.querySelector('.part-status');
    const state = getPartState(npc?.id || selectedId, row.dataset.partId);
    if (status && state.statusKind) status.classList.add(`gen-status-${state.statusKind}`);
    row.addEventListener('click', () => {
      const partId = row.dataset.partId;
      const npcId = npc?.id || selectedId;
      if (!npcId || !partId) return;
      setActivePart(npcId, partId, getPartName(npc, partId));
      document.dispatchEvent(new CustomEvent('select-part', {
        detail: { npcId, partId },
      }));
    });
  });

  if (_activeNpcId === (npc?.id || selectedId) && _activePartId) {
    setActivePart(_activeNpcId, _activePartId, getPartName(npc, _activePartId));
  }
}

function getPartsForNpc(npc) {
  const npcId = npc?.id || selectedId;
  if (npcId && npcParts.has(npcId)) return npcParts.get(npcId);
  const liveParts = window.__npcPartsByNpcId?.get?.(npcId);
  if (Array.isArray(liveParts)) {
    const parts = normalizeParts(liveParts);
    npcParts.set(npcId, parts);
    return parts;
  }
  if (Array.isArray(npc?.components)) return normalizeParts(npc.components);
  return [];
}

function getPartName(npc, partId) {
  const parts = getPartsForNpc(npc);
  const part = parts.find((entry) => entry.partId === partId);
  return part?.name ?? humanizePartId(partId);
}

function cacheNpcComponents(npc) {
  if (!npc?.id || !Array.isArray(npc.components)) return;
  npcParts.set(npc.id, normalizeParts(npc.components));
}

function normalizeParts(parts) {
  return parts
    .filter((part) => part && typeof part.partId === 'string')
    .map((part) => ({
      partId: part.partId,
      name: part.name || humanizePartId(part.partId),
    }));
}

function humanizePartId(partId) {
  return String(partId)
    .replace(/^stub_/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function setActivePart(npcId, partId, name) {
  _activeNpcId = npcId;
  _activePartId = partId;

  document.querySelectorAll('#part-list .part-item').forEach((row) => {
    row.classList.toggle('part-item-active', row.dataset.partId === partId);
  });

  const edit = document.getElementById('part-edit');
  if (edit) edit.hidden = false;
  const label = document.getElementById('part-name-label');
  if (label) label.textContent = name || partId;
  const btn = document.getElementById('part-generate-btn');
  if (btn) btn.disabled = false;
  syncPartInputs(npcId, partId);
}

function syncPartInputs(npcId, partId) {
  const state = getPartState(npcId, partId);
  const color = document.getElementById('part-color');
  const visible = document.getElementById('part-visible');
  if (color) color.value = state.color || '#ffffff';
  if (visible) visible.checked = state.visible !== false;
}

function clearPartPanel() {
  const container = document.getElementById('part-list');
  if (container) container.innerHTML = '';
  const edit = document.getElementById('part-edit');
  if (edit) edit.hidden = true;
  _activeNpcId = null;
  _activePartId = null;
}

function schedulePartColorSend() {
  if (partColorThrottle) return;
  partColorThrottle = setTimeout(() => {
    partColorThrottle = null;
    if (!pendingPartColor) return;
    const { npcId, partId, color } = pendingPartColor;
    send({
      type: 'update_npc_part',
      id: npcId,
      partId,
      patch: { color },
    });
    pendingPartColor = null;
  }, 80);
}

function setPartStatus(npcId, partId, text, kind) {
  const state = getPartState(npcId, partId);
  state.statusText = text;
  state.statusKind = kind;

  const status = Array.from(document.querySelectorAll('#part-list .part-status'))
    .find((el) => el.dataset.partStatus === partId);
  if (!status) return;
  status.textContent = text;
  status.classList.remove('gen-status-progress', 'gen-status-ready', 'gen-status-failed');
  if (kind) status.classList.add(`gen-status-${kind}`);
}

function updatePartState(npcId, partId, patch) {
  if (!npcId || !partId) return;
  const state = getPartState(npcId, partId);
  Object.assign(state, patch);
}

function getPartState(npcId, partId) {
  const key = `${npcId || 'unknown'}:${partId}`;
  if (!partState.has(key)) {
    partState.set(key, { color: '#ffffff', visible: true, statusText: '', statusKind: '' });
  }
  return partState.get(key);
}

function applyPartStateToRow(npcId, partId) {
  const state = getPartState(npcId, partId);
  const row = Array.from(document.querySelectorAll('#part-list .part-item'))
    .find((el) => el.dataset.partId === partId);
  if (!row) return;
  row.dataset.visible = state.visible === false ? 'false' : 'true';
  if (state.color) row.style.setProperty('--part-color', state.color);
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
