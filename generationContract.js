const jobs = new Map();
const eventsByJobId = new Map();
let eventSequence = 0;

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toVec3(value, fallback = [0, 0, 0]) {
  if (!Array.isArray(value) || value.length !== 3) return fallback;
  return value.map((item, index) => (Number.isFinite(item) ? Number(item) : fallback[index]));
}

function createEvent(jobId, projectId, type, message = '', payload = {}) {
  const event = {
    id: `evt_${++eventSequence}`,
    jobId,
    projectId,
    type,
    message,
    payload,
    createdAt: nowIso(),
  };
  const events = eventsByJobId.get(jobId) ?? [];
  events.push(event);
  eventsByJobId.set(jobId, events);
  return event;
}

function upsertJob(jobId, patch) {
  const previous = jobs.get(jobId) ?? {};
  const updatedAt = nowIso();
  const job = {
    ...previous,
    id: jobId,
    updatedAt,
    ...patch,
  };
  jobs.set(jobId, job);
  return clone(job);
}

export function createQueuedGenerationJob({
  id,
  projectId = 'default-project',
  prompt,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  provider = 'nervorg',
  source = 'api',
}) {
  const createdAt = nowIso();
  const job = {
    id,
    projectId,
    prompt,
    status: 'queued',
    provider,
    placement: {
      position: toVec3(position),
      rotation: toVec3(rotation),
      scale: Number.isFinite(scale) ? Number(scale) : 1,
    },
    assetId: null,
    modelUrl: null,
    metadataUrl: null,
    errorMessage: null,
    metadata: {
      source,
    },
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  };
  jobs.set(id, job);
  createEvent(id, projectId, 'job_queued', 'Generation job queued', {
    prompt,
    provider,
    placement: job.placement,
  });
  return clone(job);
}

export function markGenerationProgress(jobId, message) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const nextJob = upsertJob(jobId, { status: 'running' });
  createEvent(jobId, job.projectId, 'job_progress', message, { message });
  return nextJob;
}

export function markGenerationSucceeded(jobId, npc) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const completedAt = nowIso();
  const modelUrl = npc?.glb_url ?? null;
  const nextJob = upsertJob(jobId, {
    status: 'succeeded',
    assetId: npc?.id ?? jobId,
    modelUrl,
    errorMessage: null,
    completedAt,
    metadata: {
      ...(job.metadata ?? {}),
      npcId: npc?.id ?? jobId,
      name: npc?.name ?? null,
      dialogue: Array.isArray(npc?.dialogue) ? npc.dialogue : [],
      animationCount: Number.isFinite(npc?.animation_count) ? npc.animation_count : 0,
    },
  });
  createEvent(jobId, job.projectId, 'job_succeeded', 'Generation completed', {
    assetId: npc?.id ?? jobId,
    modelUrl,
    glbUrl: modelUrl,
    animationCount: Number.isFinite(npc?.animation_count) ? npc.animation_count : 0,
    npc,
  });
  return nextJob;
}

export function markGenerationFailed(jobId, error) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const message = error?.message ?? String(error ?? 'Generation failed');
  const completedAt = nowIso();
  const nextJob = upsertJob(jobId, {
    status: 'failed',
    errorMessage: message,
    completedAt,
  });
  createEvent(jobId, job.projectId, 'job_failed', message, { error: message });
  return nextJob;
}

export function markGenerationCanceled(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const completedAt = nowIso();
  const nextJob = upsertJob(jobId, {
    status: 'canceled',
    completedAt,
  });
  createEvent(jobId, job.projectId, 'job_canceled', 'Generated entity deleted', {});
  return nextJob;
}

export function npcToGenerationJob(npc, projectId = 'default-project') {
  return {
    id: npc.id,
    projectId,
    prompt: npc.prompt ?? npc.name ?? npc.id,
    status: 'succeeded',
    provider: 'nervorg',
    placement: {
      position: toVec3(npc.position),
      rotation: toVec3(npc.rotation),
      scale: Number.isFinite(npc.scale) ? npc.scale : 1,
    },
    assetId: npc.id,
    modelUrl: npc.glb_url ?? null,
    metadataUrl: null,
    errorMessage: null,
    metadata: {
      npcId: npc.id,
      name: npc.name ?? null,
      dialogue: Array.isArray(npc.dialogue) ? npc.dialogue : [],
      animationCount: Number.isFinite(npc.animation_count) ? npc.animation_count : 0,
    },
    createdAt: npc.created_at ?? nowIso(),
    updatedAt: npc.created_at ?? nowIso(),
    completedAt: npc.created_at ?? nowIso(),
  };
}

export function listGenerationJobs(projectId = 'default-project', npcs = []) {
  const persistedJobs = npcs.map((npc) => npcToGenerationJob(npc, projectId));
  const projectedJobs = [...jobs.values()].filter((job) => job.projectId === projectId);
  const merged = new Map();
  for (const job of persistedJobs) merged.set(job.id, job);
  for (const job of projectedJobs) merged.set(job.id, job);
  return [...merged.values()]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(clone);
}

export function getGenerationJob(projectId = 'default-project', jobId, npcs = []) {
  const projected = jobs.get(jobId);
  if (projected && projected.projectId === projectId) return clone(projected);
  const npc = npcs.find((item) => item.id === jobId);
  return npc ? npcToGenerationJob(npc, projectId) : null;
}

export function listGenerationEvents(projectId = 'default-project', jobId, npcs = []) {
  const events = (eventsByJobId.get(jobId) ?? []).filter((event) => event.projectId === projectId);
  if (events.length > 0) return events.map(clone);

  const npc = npcs.find((item) => item.id === jobId);
  if (!npc) return [];
  const job = npcToGenerationJob(npc, projectId);
  return [
    {
      id: `${jobId}:persisted:succeeded`,
      jobId,
      projectId,
      type: 'job_succeeded',
      message: 'Persisted generated entity',
      payload: {
        assetId: npc.id,
        modelUrl: npc.glb_url ?? null,
        glbUrl: npc.glb_url ?? null,
        animationCount: Number.isFinite(npc.animation_count) ? npc.animation_count : 0,
        npc,
      },
      createdAt: job.completedAt,
    },
  ];
}
