import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceTransit,
  createTransitPlan,
  TrackBlockArbiter,
  transitionTransit,
} from '../src/interregionaltransit.mjs';
import {
  createRegionHandoff,
  HOME_WORLD_SEED_STORAGE_KEY,
  RegionRuntimeBoundary,
  persistentHomeWorldSeed,
  randomWorldSeed,
  saveHomeWorldSeed,
  startupSeed,
} from '../src/worldruntime.mjs';

test('interregional transit advances through the red commuter journey and releases blocks', () => {
  const plan = createTransitPlan({
    ticketId: 'ticket-1', originRegionId: 'region-a', destinationRegionId: 'region-b',
    originStation: { id: 'a', name: 'A', x: 0, y: 0, z: 0 },
    destinationStations: [{ id: 'b', name: 'B', x: 50, y: 0, z: 0 }],
    hostPosition: { x: 50, z: 0 }, routeDistance: 50,
  });
  let current = transitionTransit(plan, 'summoned');
  for (let i = 0; i < 40 && current.phase !== 'complete'; i += 1) current = advanceTransit(current, 1);
  assert.equal(current.phase, 'complete');
  const arbiter = new TrackBlockArbiter();
  assert.equal(arbiter.claim(plan.trackBlockId, 'train-a'), true);
  assert.equal(arbiter.claim(plan.trackBlockId, 'train-b'), false);
  assert.equal(arbiter.release(plan.trackBlockId, 'train-a'), true);
  assert.equal(arbiter.claim(plan.trackBlockId, 'train-b'), true);
});

test('region runtime handoffs are scoped and home return is explicit', () => {
  assert.equal(startupSeed({ location: { search: '?wanderSeed=17' }, fallbackSeed: 2 }), 17);
  const runtime = new RegionRuntimeBoundary({ regionId: 'region-a', seed: 2 });
  const handoff = createRegionHandoff({
    sourceRegionId: 'region-a', destinationRegionId: 'region-b', destinationSeed: 9,
    destinationName: 'Silver Vale', ticketId: 'ticket-1',
    arrivalStationId: 'station-2', arrivalStationName: 'Silver Vale Central',
    arrivalStationX: 12, arrivalStationY: 4, arrivalStationZ: -8,
  });
  assert.deepEqual([
    handoff.arrivalStationId, handoff.arrivalStationName,
    handoff.arrivalStationX, handoff.arrivalStationY, handoff.arrivalStationZ,
  ], ['station-2', 'Silver Vale Central', 12, 4, -8]);
  runtime.beginTransition(handoff);
  assert.equal(runtime.phase, 'transition');
  assert.deepEqual(runtime.arrive(), { regionId: 'region-b', seed: 9 });
  assert.deepEqual(runtime.requestHome(), {
    sourceRegionId: 'region-b', destinationRegionId: 'region-a', destinationSeed: 2,
    returnHomeOnly: true,
  });
});

test('home worlds receive one persistent random seed and URL overrides stay temporary', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const first = startupSeed({
    location: { search: '' }, storage,
    randomValues: (array) => { array[0] = 0x12345678; return array; },
  });
  assert.equal(first, 0x12345678);
  assert.equal(JSON.parse(values.get(HOME_WORLD_SEED_STORAGE_KEY)).seed, first);
  assert.equal(startupSeed({
    location: { search: '' }, storage,
    randomValues: () => { throw new Error('must not regenerate an existing home'); },
  }), first);
  assert.equal(startupSeed({ location: { search: '?wanderSeed=7' }, storage }), 7);
  assert.equal(startupSeed({ location: { search: '' }, storage }), first);
});

test('seed helpers keep generated values in the non-zero uint32 range', () => {
  assert.equal(randomWorldSeed({ randomValues: (array) => { array[0] = 0; return array; }, random: () => 0, clock: () => 0 }), 1);
  const storage = new Map();
  const adapter = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  assert.equal(saveHomeWorldSeed(-1, { storage: adapter }), 0xffffffff);
  assert.equal(persistentHomeWorldSeed({ storage: adapter, randomValues: () => 17 }), 0xffffffff);
});
