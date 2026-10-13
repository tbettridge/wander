import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { terrainDispatchCapacity, DEFAULT_GENERATION_MAX_PENDING, DEFAULT_GENERATION_MAX_READY_BYTES,
  canContinueAssembly } from '../src/assemblybudget.mjs';
import { waterStagePayloadBytes } from '../src/waterstage.mjs';

// Exercise the actual controller methods without constructing a renderer or
// granting microphone access. Method endings are indented at class depth.
function methods(path, signatures, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const pieces = signatures.map(signature => {
    const start = source.indexOf('\n  ' + signature + ' {');
    assert.ok(start >= 0, signature);
    const end = source.indexOf('\n  }', start);
    return source.slice(start, end + 4).replaceAll('import.meta.url', JSON.stringify(new URL(path, import.meta.url).href));
  });
  return runInNewContext('({' + pieces.join(',') + '})', globals);
}

function terrain() {
  const manager = methods('../src/terrain.js', ['update(px, pz)', 'dispatch(slot, cand)',
    'onWorkerMessage(slot, data)', 'drainResults()'], {
    CHUNK_SIZE: 140, terrainDispatchCapacity, canContinueAssembly, waterStagePayloadBytes,
    performance: { now: () => 0 }, console,
  });
  Object.assign(manager, { chunks: new Map(), pending: new Map(), jobs: new Map(), results: [], resultBytes: 0,
    nextId: 1, waterEpoch: 1, world: { waterPlanHash: 'fixture' }, assemblyDebug: { peakMs: 0 },
    impostorRadius: 5, assembleMaxChunks: 1, assembleBudgetMs: 3,
    chunkPlan: (dx, dz) => Math.hypot(dx, dz) <= 5 ? { sig: 'fixture', ring: Math.hypot(dx, dz) } : null,
    assembleChunk(job) { this.chunks.set(job.key, { ...job, sig: job.plan.sig }); },
    removeChunk(key) { this.chunks.delete(key); },
    workers: Array.from({ length: 4 }, () => ({ busy: false, worker: { postMessage() {} } })),
  });
  return manager;
}

function finishWorkers(manager, bytes = 64) {
  for (const slot of manager.workers.filter(slot => slot.busy)) manager.onWorkerMessage(slot, {
    type: 'built', id: slot.jobId, waterEpoch: 1, waterPlanHash: 'fixture', positions: new Uint8Array(bytes),
  });
}

test('fast terrain workers cannot flood a stalled renderer with retained buffers', () => {
  const manager = terrain(), drain = manager.drainResults;
  manager.drainResults = () => {};
  for (let i = 0; i < 1000; i++) { manager.update(0, 0); finishWorkers(manager); }
  assert.equal(manager.results.length, DEFAULT_GENERATION_MAX_PENDING);
  assert.equal(manager.jobs.size, 0);
  assert.equal(manager.pending.size, DEFAULT_GENERATION_MAX_PENDING);
  manager.drainResults = drain;
  for (let i = 0; i < 150; i++) { manager.update(0, 0); finishWorkers(manager); }
  assert.equal(manager.results.length, 0);
  assert.equal(manager.resultBytes, 0);
  assert.equal(manager.pending.size, 0);
  assert.equal(manager.chunks.size, 81, 'generation resumes and the desired landscape finishes');
});

test('large transferred buffers stop dispatch before the count limit and stale results release bytes', () => {
  const manager = terrain(), drain = manager.drainResults;
  manager.drainResults = () => {};
  manager.update(0, 0); finishWorkers(manager, DEFAULT_GENERATION_MAX_READY_BYTES / 4);
  assert.equal(manager.results.length, 4);
  assert.equal(manager.resultBytes, DEFAULT_GENERATION_MAX_READY_BYTES);
  manager.update(0, 0);
  assert.equal(manager.workers.filter(slot => slot.busy).length, 0);
  manager.pcx = 100; manager.pcz = 100; manager.drainResults = drain;
  manager.drainResults();
  assert.equal(manager.resultBytes, 0);
  assert.equal(manager.pending.size, 0);
  assert.equal(manager.chunks.size, 0, 'obsolete results are not uploaded');
});

function saves() {
  const posted = [], written = [];
  const worker = { postMessage(message) { posted.push(structuredClone(message)); }, terminate() {} };
  const population = methods('../src/stationkeeper.js', ['saveLivingWorldState(force = false)',
    'saveLivingWorldStateInWorker()', 'onSaveWorkerMessage({ id, serialized, error })'], {
    Worker: function () { return worker; }, window: {}, URL,
  });
  Object.assign(population, { worldState: { courier: { resume: { x: 0 } } }, stateSaveElapsed: 0,
    syncCommitmentsForSave() {}, livingWorldStore: {
      save(state) { written.push({ kind: 'urgent', state: structuredClone(state) }); return true; },
      saveSerialized(state, text) { written.push({ kind: 'worker', state, text }); },
    },
  });
  return { population, worker, posted, written };
}

test('slow autosaves coalesce into one latest snapshot and retain the courier position', () => {
  const { population: p, posted, written } = saves();
  p.saveLivingWorldStateInWorker();
  for (let i = 1; i <= 1000; i++) { p.worldState.courier.resume.x = i; p.saveLivingWorldStateInWorker(); }
  assert.equal(posted.length, 1, 'do not clone a thousand complete living worlds');
  p.onSaveWorkerMessage({ id: posted[0].id, serialized: 'first' });
  assert.equal(posted.length, 2);
  assert.equal(posted[1].state.courier.resume.x, 1000, 'the follow-up saves current progress');
  p.onSaveWorkerMessage({ id: posted[1].id, serialized: 'latest' });
  assert.equal(p._saveInFlight, null);
  assert.equal(written.at(-1).text, 'latest');
});

test('urgent saves supersede old worker results without blocking future autosaves', () => {
  const { population: p, posted, written } = saves();
  p.saveLivingWorldStateInWorker(); p.saveLivingWorldStateInWorker();
  p.worldState.courier.resume.x = 200; p.saveLivingWorldState(true);
  p.onSaveWorkerMessage({ id: posted[0].id, serialized: 'old' });
  assert.equal(p._saveInFlight, null);
  assert.equal(written.length, 1); assert.equal(written[0].kind, 'urgent');
  p.saveLivingWorldStateInWorker();
  assert.equal(posted.length, 2);
  p.onSaveWorkerMessage({ id: posted[1].id, serialized: 'new' });
  assert.equal(written.at(-1).text, 'new');
});

test('a region swap drops old save results and saves the new region through the same bounded slot', () => {
  const { population: p, posted, written } = saves();
  const oldState = p.worldState; p.saveLivingWorldStateInWorker();
  p.worldState = { courier: { resume: { x: 8314 } } }; p.saveLivingWorldStateInWorker();
  p.onSaveWorkerMessage({ id: posted[0].id, serialized: 'old region' });
  assert.equal(written.length, 0);
  assert.equal(posted.length, 2);
  p.onSaveWorkerMessage({ id: posted[1].id, serialized: 'Holtwick' });
  assert.equal(written.at(-1).state, p.worldState);
  assert.notEqual(written.at(-1).state, oldState);
});

test('save worker failures retain progress with an urgent synchronous save', () => {
  const { population: p, worker, written } = saves();
  p.saveLivingWorldStateInWorker(); p.worldState.courier.resume.x = 8192;
  worker.onerror();
  assert.equal(p._saveInFlight, null); assert.equal(p._saveWorker, null);
  assert.equal(written.at(-1).state.courier.resume.x, 8192);
  assert.equal(p.saveLivingWorldStateInWorker(), false);
});
