import WebSocket from 'ws';

const url = process.env.WS_URL || 'ws://localhost:3711/ws';
const events = [];

const ws = new WebSocket(url);

const finished = new Promise((resolve, reject) => {
  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'spawn_npc',
      prompt: 'a friendly test robot',
      position: [1, 0, -2],
      rotation: [0, 0, 0],
    }));
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    events.push(msg.type);
    if (msg.type === 'npc_ready') {
      const id = msg.npc.id;
      ws.send(JSON.stringify({
        type: 'update_npc',
        id,
        patch: { name: 'Robo', dialogue: ['beep', 'boop'] },
      }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'delete_npc', id }));
      }, 200);
    }
    if (msg.type === 'npc_deleted') {
      ws.close();
      resolve();
    }
    if (msg.type === 'npc_failed') {
      reject(new Error(msg.error));
    }
  });

  ws.on('error', reject);

  setTimeout(() => reject(new Error(`timeout — events: ${events.join(',')}`)), 15000);
});

try {
  await finished;
  console.log('OK', events);
  process.exit(0);
} catch (err) {
  console.error('FAIL', err.message, 'events:', events);
  process.exit(1);
}
