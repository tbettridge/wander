import assert from 'node:assert/strict';
import test from 'node:test';
import { planWaterRegionCandidates, WATER_REGION_BYTES } from '../src/hydrologyregions.mjs';
import { World } from '../src/world.js';
import { buildTerrainArrays } from '../src/chunkgen.js';
import { prepareFreshRegion, prepareRegionalPreview } from '../src/hydrologyworker.js';

test('regional generation installs multiple systems with terrain-safe density and actual worker agreement', async () => {
  const plan = planWaterRegionCandidates(4242, 1, 0);
  assert.ok(JSON.stringify(plan).length <= WATER_REGION_BYTES);
  assert.ok(plan.components.some(c => c.basinIds?.length && c.reachIds.length > 1), 'stream-fed lake retained');
  assert.ok(plan.components.some(c => !c.basinIds?.length), 'independent river retained beside lake');
  const world = new World(4242, { waterPlans: [plan] });
  const cx = Math.floor(5408 / 140), cz = 0;
  const direct = buildTerrainArrays(world, cx, cz, 16, 140);
  const high = buildTerrainArrays(world, cx, cz, 96, 140);
  assert.deepEqual(high.positions, direct.positions);
  const messages = [], previous = globalThis.self;
  try {
    globalThis.self = { postMessage(m, transfer = []) { messages.push(structuredClone(m, { transfer })); } };
    await import('../src/worker.js?regional-test');
    self.onmessage({ data: { type: 'init', seed: 4242, waterPlans: [plan], waterEpoch: 7 } });
    assert.equal(messages.at(-1).waterEpoch, 7);
    const job = { type: 'build', id: 1, waterEpoch: 6, waterPlanHash: world.waterPlanHash, cx, cz, res: 16, chunkSize: 140, doTerrain: true };
    self.onmessage({ data: job });
    assert.equal(messages.at(-1).type, 'build-error');
    self.onmessage({ data: { ...job, id: 2, waterEpoch: 7 } });
    assert.equal(messages.at(-1).type, 'built');
    assert.deepEqual(messages.at(-1).terrain.positions, direct.positions);
    assert.equal(messages.at(-1).waterPlanHash, world.waterPlanHash);
  } finally { if (previous === undefined) delete globalThis.self; else globalThis.self = previous; }
});

test('broader source sampling increases installed river reaches on representative fresh terrain', () => {
  let oldLength = 0, newLength = 0;
  for (const seed of [1, 3, 42]) {
    const old = prepareFreshRegion({ seed, regionX: 0, regionZ: 0 }).plan;
    const plan = planWaterRegionCandidates(seed, 0, 0);
    new World(seed, { waterPlans: [plan] });
    assert.ok(plan.basins.length + plan.components.filter(c => c.basinIds?.length).length > 0);
    assert.ok(plan.components.length > 1);
    assert.ok(plan.components.some(c => !c.basinIds?.length), 'lake upgrades must leave space for standalone rivers');
    assert.ok(plan.components.filter(c => c.basinIds?.length).reduce((n, c) => n + JSON.stringify(c).length, 0) <= 1750000);
    if (seed === 1) {
      assert.equal(plan.diagnostics.riverLinks, 1);
      const joined = plan.components.filter(c => c.basinIds?.includes('basin:1:3392:1784'));
      assert.equal(joined.length, 1, 'the joined lake and river have one installed owner');
      assert.equal(joined[0].oceanHandoff, true);
      assert.equal(plan.basins.some(b => b.id === 'basin:1:3392:1784'), false);
      const reachIds = plan.components.flatMap(c => c.reachIds);
      assert.equal(new Set(reachIds).size, reachIds.length, 'no retained duplicate receiving river');
    }
    oldLength += old.reaches.length;
    newLength += plan.components.reduce((n, c) => n + c.reachIds.length, 0);
  }
  assert.ok(newLength > oldLength, `published river reaches ${newLength} must exceed previous ${oldLength}`);
});

test('regional generation installs a companion pond only as part of a complete stream-fed chain', () => {
  const preview = prepareRegionalPreview({ seed: 2, regionX: 0, regionZ: 0,
    basinId: 'basin:2:3528:488', x: 3436, z: 412 });
  const { plan } = preview;
  assert.equal(plan.diagnostics.lakeLinks, 1);
  assert.equal(preview.basinCount, 2);
  assert.ok(preview.inletCount > 0, 'incoming streams fit around the retained channel');
  const companion = 'basin:2:3344:336';
  assert.equal(plan.basins.some(b => b.id === companion), false);
  assert.equal(plan.components.filter(c => c.basinIds?.includes(companion)).length, 1);
  assert.ok(plan.components.some(c => !c.basinIds?.length), 'standalone river coverage remains');
  assert.ok(JSON.stringify(plan).length <= WATER_REGION_BYTES);
  const world = new World(2, { waterPlans: [plan] });
  assert.ok(world.riverAt(3344, 336).wet);
  assert.ok(world.riverAt(3528, 488).wet);
  const allIds = [...plan.basins.map(b => b.id), ...plan.components.flatMap(c => c.basinIds || [])];
  assert.equal(new Set(allIds).size, allIds.length);
  assert.ok(allIds.length <= 5, 'companions do not populate unrelated depressions');
});
