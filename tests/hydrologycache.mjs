import test from 'node:test';
import assert from 'node:assert/strict';
import { WaterCandidateCache, decodeWaterCandidate, waterCacheKey } from '../src/hydrologycache.mjs';
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
