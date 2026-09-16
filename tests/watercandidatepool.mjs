import test from 'node:test';
import assert from 'node:assert/strict';
import { WaterCandidatePool, waterCandidateConcurrency } from '../src/watercandidatepool.mjs';
import { WaterRegionPlanner } from '../src/hydrologyregions.mjs';
import { planWaterRegionCandidates } from '../src/hydrologyregions.mjs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { descriptorHash } from '../src/hydrologyformat.mjs';

function candidate(seed, regionX, regionZ) {
  const payload = { version: 1, generationVersion: 3, regional: 1, preview: true,
    seed, regionX, regionZ, basins: [], components: [] };
  return { ...payload, hash: descriptorHash(payload), diagnostics: {} };
}
function factory() {
  const workers = [];
  return { workers, create() {
    const worker = { sent: [], terminated: false,
      postMessage(value) { this.sent.push(value); }, terminate() { this.terminated = true; },
      complete() {
        const request = this.sent.shift();
        this.onmessage({ data: { type: 'candidate-ready', id: request.id,
          planJSON: JSON.stringify(candidate(request.seed, request.x, request.z)) } });
      } };
    workers.push(worker); return worker;
  } };
}
test('candidate pool bounds workers and queued jobs, routing out-of-order results by identity', async () => {
  const f = factory(), pool = new WaterCandidatePool({ size: 2, maxJobs: 3, workerFactory: () => f.create() });
  const jobs = [pool.generate(2, 0, 0), pool.generate(2, 1, 0), pool.generate(2, 2, 0)];
  await assert.rejects(pool.generate(2, 3, 0), /queue budget/);
  assert.equal(f.workers.length, 2);
  f.workers[1].complete(); f.workers[1].complete(); f.workers[0].complete();
  assert.deepEqual((await Promise.all(jobs)).map(plan => plan.regionX), [0, 1, 2]);
  pool.dispose(); assert.ok(f.workers.every(worker => worker.terminated));
});
test('candidate corruption rejects the complete queued stage and terminates workers', async () => {
  const f = factory(), pool = new WaterCandidatePool({ size: 1, workerFactory: () => f.create() });
  const first = pool.generate(2, 0, 0), queued = pool.generate(2, 1, 0);
  const checks = [assert.rejects(first, /identity/), assert.rejects(queued, /identity/)];
  const request = f.workers[0].sent[0];
  f.workers[0].onmessage({ data: { type: 'candidate-ready', id: request.id,
    planJSON: JSON.stringify(candidate(3, 0, 0)) } });
  await Promise.all(checks); assert.equal(f.workers[0].terminated, true);
});
test('concurrent candidate completion preserves canonical arbitration, cache LRU and progress', async () => {
  const serial = new WaterRegionPlanner(2, { maxEntries: 9, createCandidates: candidate });
  const parallel = new WaterRegionPlanner(2, { maxEntries: 9, createCandidates: candidate });
  const store = () => ({ get: async () => null, put: async () => {} });
  const expected = await serial.cachedWindow(0, 0, store());
  const written = [], progress = [], phases = [];
  let active = 0, peak = 0;
  const actual = await parallel.cachedWindow(0, 0, {
    getMany: async (_, entries) => entries.map(() => null),
    putMany: async plans => written.push(...plans.map(plan => `${plan.regionX},${plan.regionZ}`)),
  }, value => progress.push(value), {
    generationConcurrency: 3, onPhase: (name, ms) => phases.push([name, ms]),
    generateCandidates: async (seed, x, z) => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, (2 - x) % 3));
      active--; return candidate(seed, x, z);
    },
  });
  assert.deepEqual(actual, expected);
  assert.deepEqual([...parallel.cache.keys()], [...serial.cache.keys()]);
  assert.equal(peak, 3); assert.equal(written.length, 25);
  assert.equal(written[0], '-2,-2'); assert.equal(written.at(-1), '2,2');
  assert.deepEqual(progress.map(value => value.completed), Array.from({ length: 26 }, (_, i) => i));
  assert.deepEqual(phases.map(([name]) => name), ['cache-read', 'generation', 'cache-write', 'finalization']);
  assert.ok(phases.every(([, ms]) => Number.isFinite(ms) && ms >= 0));
  assert.deepEqual([1, 4, 8, undefined].map(waterCandidateConcurrency), [1, 2, 3, 1]);
});

test('the real candidate worker preserves every numeric value and hash of a river/lake region', async () => {
  const url = new URL('../src/watercandidateworker.js', import.meta.url).href;
  const pool = new WaterCandidatePool({ size: 1, workerFactory: () => {
    const worker = new NodeWorker(`
      const { parentPort, workerData } = require('node:worker_threads');
      globalThis.self = { postMessage: data => parentPort.postMessage(data) };
      import(workerData).then(() => parentPort.on('message', data => self.onmessage({ data })));
    `, { eval: true, workerData: url });
    const bridge = { postMessage: data => worker.postMessage(data), terminate: () => worker.terminate() };
    worker.on('message', data => bridge.onmessage?.({ data }));
    worker.on('error', error => bridge.onerror?.(error));
    return bridge;
  } });
  try {
    const actual = await pool.generate(4242, 1, 0);
    const expected = planWaterRegionCandidates(4242, 1, 0);
    assert.ok(actual.components.some(component => component.basinIds?.length));
    assert.deepEqual(actual, expected);
  } finally { pool.dispose(); }
});
