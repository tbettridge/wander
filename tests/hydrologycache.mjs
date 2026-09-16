import test from 'node:test';
import assert from 'node:assert/strict';
import { IndexedWaterStorage, WaterCandidateCache, decodeWaterCandidate, waterCacheKey } from '../src/hydrologycache.mjs';
import { WaterRegionPlanner, planWaterRegionCandidates } from '../src/hydrologyregions.mjs';
import { descriptorHash } from '../src/hydrologyformat.mjs';

function empty(seed, regionX, regionZ) {
  const plan = { version: 1, generationVersion: 3, regional: 1, preview: true, seed, regionX, regionZ, basins: [], components: [] };
  return { ...plan, hash: descriptorHash(plan) };
}
function storage() {
  const records = new Map();
  return { records, async get(k) { return records.get(k); }, async put(k, v) { records.set(k, v); }, async delete(k) { records.delete(k); } };
}
function batchStorage() {
  const disk = storage();
  disk.calls = { getMany: 0, putMany: 0 };
  disk.getMany = async keys => { disk.calls.getMany++; return keys.map(key => disk.records.get(key)); };
  disk.putMany = async entries => {
    disk.calls.putMany++;
    for (const { key, text } of entries) disk.records.set(key, text);
  };
  return disk;
}

function indexedMemory(options) {
  const disk = new IndexedWaterStorage(null, options);
  const plans = new Map(), metadataRecords = new Map();
  let transactions = 0;
  disk.transaction = async action => {
    transactions++;
    let result;
    const later = callback => queueMicrotask(() => callback?.());
    const planStore = {
      get(key) {
        const request = { result: plans.get(key) };
        later(() => request.onsuccess?.());
        return request;
      },
      put(text, key) { plans.set(key, text); },
      delete(key) { plans.delete(key); },
    };
    const metadata = {
      put(record) { metadataRecords.set(record.key, { ...record }); },
      delete(key) { metadataRecords.delete(key); },
      getAll() {
        const request = { result: [...metadataRecords.values()].map(record => ({ ...record })) };
        later(() => request.onsuccess?.());
        return request;
      },
    };
    action(planStore, metadata, value => { result = value; });
    await new Promise(resolve => queueMicrotask(resolve));
    return result;
  };
  disk.plans = plans;
  disk.metadata = metadataRecords;
  Object.defineProperty(disk, 'transactionCount', { get: () => transactions });
  return disk;
}

test('persistent candidates survive a planner restart without changing resolved geography', async () => {
  const disk = storage(), cache = new WaterCandidateCache(disk);
  let generated = 0;
  const createCandidates = (...args) => { generated++; return empty(...args); };
  const firstPlanner = new WaterRegionPlanner(42, { createCandidates });
  const first = await firstPlanner.cachedWindow(-1, 2, cache);
  assert.equal(generated, 25);
  const restarted = new WaterRegionPlanner(42, { maxEntries: 9, createCandidates });
  const updates = [];
  assert.deepEqual(await restarted.cachedWindow(-1, 2, new WaterCandidateCache(disk), p => updates.push(p)), first);
  assert.equal(generated, 25);
  assert.equal(updates.at(-1).reused, 25);
  assert.equal(restarted.cache.size, 9);
  assert.deepEqual(first, new WaterRegionPlanner(42, { createCandidates: empty }).window(-1, 2));
  await new WaterRegionPlanner(42, { createCandidates }).cachedWindow(0, 2, cache);
  assert.equal(generated, 30, 'adjacent travel only generates five new dependency regions');
});

test('candidate batch reads and writes stay aligned and preserve individual-storage fallback', async () => {
  const disk = batchStorage(), cache = new WaterCandidateCache(disk);
  const first = empty(42, 0, 0), second = empty(42, 1, 2);
  await cache.putMany([first, second]);
  assert.equal(disk.calls.putMany, 1);
  assert.deepEqual(await cache.getMany(42, [
    { x: 1, z: 2 }, { x: 99, z: 99 }, { x: 0, z: 0 }, { x: 1, z: 2 },
  ]), [second, null, first, second]);
  assert.equal(disk.calls.getMany, 1);

  const fallback = new WaterCandidateCache(storage());
  await fallback.putMany([first]);
  assert.deepEqual(await fallback.getMany(42, [{ x: 0, z: 0 }, { x: 3, z: 3 }]), [first, null]);
});

test('candidate batch corruption is isolated while valid records remain reusable', async () => {
  const disk = batchStorage(), cache = new WaterCandidateCache(disk);
  const valid = empty(42, 1, 0);
  disk.records.set(waterCacheKey(42, 0, 0), 'invalid JSON');
  disk.records.set(waterCacheKey(42, 1, 0), JSON.stringify(valid));
  assert.deepEqual(await cache.getMany(42, [{ x: 0, z: 0 }, { x: 1, z: 0 }]), [null, valid]);
  assert.equal(disk.records.has(waterCacheKey(42, 0, 0)), false);
  assert.equal(cache.disabled, false);
});

test('candidate batch work is split into bounded storage calls and failures disable persistence', async () => {
  const disk = batchStorage(), cache = new WaterCandidateCache(disk);
  const regions = Array.from({ length: 65 }, (_, x) => ({ x, z: 0 }));
  assert.equal((await cache.getMany(42, regions)).every(value => value === null), true);
  assert.equal(disk.calls.getMany, 2);

  const plans = regions.map(({ x, z }) => empty(42, x, z));
  await cache.putMany(plans);
  assert.equal(disk.calls.putMany, 2);

  const failing = batchStorage();
  failing.getMany = async () => { throw new Error('storage denied'); };
  const denied = new WaterCandidateCache(failing);
  assert.deepEqual(await denied.getMany(42, [{ x: 0, z: 0 }, { x: 1, z: 0 }]), [null, null]);
  assert.equal(denied.disabled, true);

  const malformed = batchStorage();
  const safe = new WaterCandidateCache(malformed);
  await safe.putMany([null, { seed: 42 }, empty(42, 0, 0)]);
  assert.equal(malformed.calls.putMany, 1, 'valid plans still publish beside malformed inputs');
  assert.deepEqual(await safe.get(42, 0, 0), empty(42, 0, 0));
});

test('IndexedWaterStorage batch operations retain LRU byte and entry caps per transaction', async () => {
  const disk = indexedMemory({ maxBytes: 5, maxEntries: 2 });
  await disk.putMany([{ key: 'a', text: 'aa' }, { key: 'b', text: 'bb' }]);
  assert.equal(disk.transactionCount, 1);
  assert.deepEqual(await disk.getMany(['b', 'a', 'missing']), ['bb', 'aa', undefined]);
  assert.equal(disk.transactionCount, 2);
  await disk.putMany([{ key: 'c', text: 'cc' }]);
  assert.equal(disk.transactionCount, 3);
  assert.equal(disk.plans.has('a'), false, 'byte cap evicted the oldest record');
  assert.equal(disk.plans.get('b'), 'bb');
  assert.equal(disk.plans.get('c'), 'cc');

  await disk.putMany(Array.from({ length: 65 }, (_, i) => ({ key: `bulk-${i}`, text: 'x' })));
  assert.equal(disk.transactionCount, 5, 'bulk operations use at most 64 entries per transaction');
  assert.equal(disk.plans.size <= 2, true, 'entry cap remains enforced after bulk writes');
  await disk.putMany([{ key: '', text: 'ignored' }, { key: 'invalid', text: null }, ['also-invalid', 7]]);
  assert.equal(disk.plans.has('invalid'), false, 'malformed bulk entries are ignored');
});

test('corrupt, wrong-identity and old-revision cached records never replace generated candidates', async () => {
  const disk = storage(), cache = new WaterCandidateCache(disk), key = waterCacheKey(42, 0, 0);
  for (const value of ['invalid JSON', JSON.stringify(empty(9, 0, 0)), JSON.stringify({ ...empty(42, 0, 0), hash: 'bad' })]) {
    disk.records.set(key, value);
    assert.equal(await cache.get(42, 0, 0), null);
    assert.ok(!disk.records.has(key));
  }
  disk.records.set('0:42:0:0', JSON.stringify(empty(42, 0, 0)));
  assert.equal(await cache.get(42, 0, 0), null);
  const invalid = empty(42, 0, 0);
  invalid.basins.push({ bounds: { minX: 0, maxX: 1e12, minZ: 0, maxZ: 10 } });
  const { hash, ...payload } = invalid; invalid.hash = descriptorHash(payload);
  assert.throws(() => decodeWaterCandidate(JSON.stringify(invalid), 42, 0, 0), /bounds/);
  await cache.put(empty(42, 0, 0));
  assert.deepEqual(await cache.get(42, 0, 0), empty(42, 0, 0));
});

test('denied storage and quota failures preserve full deterministic generation', async () => {
  for (const failure of ['get', 'put']) {
    const disk = storage(); disk[failure] = async () => { throw new Error('storage denied'); };
    const cache = new WaterCandidateCache(disk);
    const planner = new WaterRegionPlanner(42, { createCandidates: empty });
    assert.deepEqual(await planner.cachedWindow(0, 0, cache), new WaterRegionPlanner(42, { createCandidates: empty }).window(0, 0));
    assert.equal(cache.disabled, true);
  }
});

test('real forest lake, inlet and river candidates survive persistence and full geometry validation', async () => {
  const plan = planWaterRegionCandidates(4242, 1, 0);
  const cache = new WaterCandidateCache(storage());
  await cache.put(plan);
  assert.deepEqual(await cache.get(4242, 1, 0), plan);
});


test('persistent planning keeps cross-border ownership identical after arbitrary travel order', async () => {
  const make = (seed, x, z) => {
    const p = empty(seed, x, z);
    p.basins = [{ id: `${x},${z}`, level: 2,
      bounds: { minX: x * 4096 - 100, maxX: x * 4096 + 4200, minZ: z * 4096, maxZ: z * 4096 + 4000 },
      grid: { cols: 2, rows: 2, step: 4300, floor: [0, 0, 0, 0], signed: [1, 1, 1, 1] } }];
    const { hash, ...payload } = p; p.hash = descriptorHash(payload); return p;
  };
  const cache = new WaterCandidateCache(storage());
  const planner = new WaterRegionPlanner(42, { createCandidates: make });
  const expected = planner.window(0, 0);
  await planner.cachedWindow(2, -1, cache);
  const fresh = new WaterRegionPlanner(42, { createCandidates: make });
  assert.deepEqual(await fresh.cachedWindow(0, 0, cache), expected);
});
