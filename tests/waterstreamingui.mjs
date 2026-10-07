import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { waterBoundsAffectArea, waterWorkerPlans } from '../src/waterstage.mjs';

const terrain = await readFile(new URL('../src/terrain.js', import.meta.url), 'utf8');
const methods = terrain.slice(terrain.indexOf('  refreshWaterPlans(bounds)'), terrain.indexOf('  startWaterStage(world)'));

function terrainHarness() {
  const state = { waterBoundsAffectArea, waterWorkerPlans, CHUNK_SIZE: 140 };
  const manager = vm.runInNewContext(`new (class {${methods}})()`, state);
  Object.assign(manager, {
    world: { seed: 42, waterField: { plans: [] } }, waterEpoch: 1, impostorRadius: 3,
    chunks: new Map([[0, 0], [-1, 0], [10, 10]].map(([cx, cz]) => [`${cx},${cz}`, { cx, cz, mesh: {} }])),
    pending: new Set(['old']), jobs: new Map([[1, {}]]), results: [{}], waterRebuildKeys: new Set(),
    workers: [{ worker: { postMessage(message) { state.workerMessage = message; } } }],
    cancelWaterStage() {}, removeChunk(key) { this.chunks.delete(key); }, neededNear: 0,
  });
  return { manager, state };
}

test('a distant river refresh retains every loaded terrain buffer and replaces stale worker jobs', () => {
  const { manager: m, state } = terrainHarness(), before = new Map(m.chunks);
  assert.equal(m.refreshWaterPlans([{ minX: 1e6, minZ: 1e6, maxX: 1e6 + 10, maxZ: 1e6 + 10 }]), false);
  for (const [key, chunk] of before) assert.equal(m.chunks.get(key), chunk);
  assert.equal(m.pending.size, 0);
  assert.equal(m.jobs.size, 0);
  assert.equal(m.results.length, 0);
  assert.equal(state.workerMessage.waterEpoch, 2);
});

test('a changed shore rebuilds touching and neighbouring terrain, retaining unrelated scenery', () => {
  const { manager: m } = terrainHarness(), far = m.chunks.get('10,10');
  assert.equal(m.refreshWaterPlans([{ minX: 20, minZ: 20, maxX: 60, maxZ: 60 }]), true);
  assert.deepEqual([...m.waterRebuildKeys].sort(), ['-1,0', '0,0']);
  assert.equal(m.chunks.get('10,10'), far);
});

test('view bounds include negative tiles and a conservative sampling halo', () => {
  const { manager: m } = terrainHarness();
  const bounds = [{ minX: -705, minZ: -20, maxX: -700, maxZ: 20 }];
  assert.equal(m.waterPlansAffectView(bounds, -1, 0), true);
  assert.equal(m.waterPlansAffectView(bounds, 10000, 10000), false);
  assert.equal(m.waterPlansAffectView([], -1, 0), false);
});

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const start = main.indexOf('function updateWaterStreaming()');
const update = main.slice(start, main.indexOf('\n}\n', start) + 2);

function streamHarness({ affectsView = false, stageReady = false, fallback = false,
  rebuilding = false, held = false, nearPending = 0, hasTerrain = true, contains = true } = {}) {
  const previous = { plans: [], hash: 'old' }, next = { plans: [], hash: 'new' };
  const result = { plans: next.plans, preparedField: next };
  const state = {
    world: { seed: 42, waterField: previous, waterPlanHash: 'old' },
    waterStageResult: null, waterRebuilding: rebuilding, waterTravelHeld: held, navGraph: {},
    hydrologyStream: { ready: rebuilding ? null : result, update() {}, contains: () => contains,
      commit() { this.ready = null; state.commits++; }, fail(error) { this.error = error; } },
    commits: 0, stages: 0, refreshes: 0, stageCommits: 0, performance: { now: () => 0 },
    World: class { constructor(seed, { waterField }) { this.waterField = waterField; this.waterPlanHash = waterField.hash; } },
    changedWaterBounds: () => [], waterPlanningMessage: () => 'Preparing terrain',
    controls: { rig: { position: { x: 0, z: 0 } }, inputLocked: held,
      setInputLocked(locked) { this.inputLocked = locked; } },
    chunkMgr: {
      waterPlansAffectView: () => affectsView, cancelWaterStage() {},
      refreshWaterPlans() { state.refreshes++; return fallback; },
      startWaterStage(world) { state.stages++; this.stagedWater = { world, stageLastProgress: 0,
        stageOverflow: fallback, assemblyDebug: {} }; },
      waterStageReady: () => stageReady, commitWaterStage() { state.stageCommits++; },
      hasTerrainAt: () => hasTerrain, pendingNearby: () => nearPending,
      pendingWaterTerrain: () => 99,
    },
    farTerrain: { resetRegion() {} }, water: { resetRegion() {} }, grassField: { resetRegion() {} },
    waterLoading: { style: {} },
  };
  vm.runInNewContext(`${update}\nupdateWaterStreaming();`, state);
  return { state, previous, next };
}

test('a distant-only water window commits without staging and uploading a new visible landscape', () => {
  const { state: s, next } = streamHarness();
  assert.equal(s.world.waterField, next);
  assert.equal(s.world.waterPlanHash, 'new');
  assert.equal(s.stages, 0);
  assert.equal(s.refreshes, 1);
  assert.equal(s.commits, 1);
  assert.equal(s.controls.inputLocked, false);
});

test('nearby water changes keep the previous whole landscape until staged terrain is ready', () => {
  const { state: s, previous } = streamHarness({ affectsView: true });
  assert.equal(s.world.waterField, previous);
  assert.equal(s.stages, 1);
  assert.equal(s.commits, 0);
  const { state: ready, next } = streamHarness({ affectsView: true, stageReady: true });
  assert.equal(ready.world.waterField, next);
  assert.equal(ready.stageCommits, 1);
  assert.equal(ready.commits, 1);
});

test('fallback rebuilding releases walking when nearby ground is ready while distant scenery continues', () => {
  const { state: blocked } = streamHarness({ affectsView: true, fallback: true, nearPending: 1 });
  assert.equal(blocked.controls.inputLocked, true);
  const { state: ready } = streamHarness({ rebuilding: true, held: true });
  assert.equal(ready.chunkMgr.pendingWaterTerrain(), 99);
  assert.equal(ready.controls.inputLocked, false);
  assert.equal(ready.waterTravelHeld, false);
  assert.equal(ready.waterLoading.style.display, 'none');
});

test('movement still waits at an unprepared regional edge or when nearby ground is missing', () => {
  assert.equal(streamHarness({ rebuilding: true, hasTerrain: false }).state.controls.inputLocked, true);
  assert.equal(streamHarness({ contains: false }).state.controls.inputLocked, true);
});
