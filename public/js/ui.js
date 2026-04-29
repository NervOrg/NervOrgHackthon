const toastsEl = () => document.getElementById('toasts');

export function toast(message, kind = 'info', durationMs = 3500) {
  const wrap = toastsEl();
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.2s';
    setTimeout(() => el.remove(), 220);
  }, durationMs);
}

export function setModeUI(mode) {
  document.body.dataset.mode = mode;
  document.getElementById('mode-indicator').textContent =
    mode === 'maker' ? 'Maker Mode' : 'Play Mode';
  document.getElementById('mode-toggle').textContent =
    mode === 'maker' ? 'Switch to Play' : 'Switch to Maker';

  document.querySelectorAll('[data-mode-only]').forEach((el) => {
    const allow = el.getAttribute('data-mode-only') === mode;
    if (!allow) el.setAttribute('hidden', '');
  });
  document.querySelectorAll('#hud-help [data-mode]').forEach((el) => {
    el.toggleAttribute('hidden', el.getAttribute('data-mode') !== mode);
  });
  document.getElementById('crosshair').toggleAttribute('hidden', false);
}
