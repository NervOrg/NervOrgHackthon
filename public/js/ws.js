const listeners = new Map();
let socket = null;
let reconnectTimer = null;

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws`;
  socket = new WebSocket(url);

  socket.addEventListener('open', () => emit('open'));
  socket.addEventListener('close', () => {
    emit('close');
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    // 'close' will follow.
  });
  socket.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg && msg.type) emit(msg.type, msg);
      emit('*', msg);
    } catch {
      // ignore
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

function emit(type, msg) {
  const set = listeners.get(type);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(msg);
    } catch (err) {
      console.error('WS listener error:', err);
    }
  }
}

export function send(msg) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

export function isOpen() {
  return socket && socket.readyState === WebSocket.OPEN;
}
