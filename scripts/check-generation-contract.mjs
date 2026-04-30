import WebSocket from 'ws';

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const WS_URL = process.env.WS_URL || BASE_URL.replace(/^http/, 'ws') + '/ws';
const PROJECT_ID = process.env.PROJECT_ID || 'default-project';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function waitForTerminalJob(jobId) {
  const deadline = Date.now() + Number(process.env.CONTRACT_TIMEOUT_MS || 15000);
  let lastJob = null;
  while (Date.now() < deadline) {
    const payload = await request(`/api/projects/${PROJECT_ID}/generation/jobs/${jobId}`);
    lastJob = payload.job;
    if (['succeeded', 'failed', 'canceled'].includes(lastJob?.status)) return lastJob;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for job ${jobId}; last status: ${lastJob?.status ?? 'unknown'}`);
}

async function deleteNpcViaWs(id) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out deleting ${id} through WebSocket cleanup`));
    }, 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'delete_npc', id }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'npc_deleted' && msg.id === id) {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

const health = await request('/health');
assert(health.ok === true, 'health endpoint did not return ok=true');

const created = await request(`/api/projects/${PROJECT_ID}/generation/jobs`, {
  method: 'POST',
  body: JSON.stringify({
    prompt: 'a friendly contract validation robot',
    placement: {
      position: [1, 0, -2],
      rotation: [0, 0, 0],
      scale: 1,
    },
    metadata: {
      source: 'check-generation-contract',
    },
  }),
});

const job = created.job;
assert(job?.id, 'create job response did not include job.id');
assert(job.status === 'queued', `expected created job to be queued, got ${job.status}`);

const terminalJob = await waitForTerminalJob(job.id);
assert(terminalJob.status === 'succeeded', `expected job to succeed, got ${terminalJob.status}`);

const listPayload = await request(`/api/projects/${PROJECT_ID}/generation/jobs`);
assert(Array.isArray(listPayload.jobs), 'job list response did not include jobs array');
assert(listPayload.jobs.some((item) => item.id === job.id), 'job list did not include created job');

const eventsPayload = await request(`/api/projects/${PROJECT_ID}/generation/jobs/${job.id}/events`);
const eventTypes = (eventsPayload.events ?? []).map((event) => event.type);
assert(eventTypes.includes('job_queued'), 'events missing job_queued');
assert(eventTypes.includes('job_progress'), 'events missing job_progress');
assert(eventTypes.includes('job_succeeded'), 'events missing job_succeeded');

await deleteNpcViaWs(job.id);

console.log('OK generation contract', {
  jobId: job.id,
  health,
  eventTypes,
});
