import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRiverNetwork } from '../src/rivernetwork.mjs';
import { bakeSparseRiverComponent } from '../src/riversparsemesh.mjs';
import { prepareBasinDrainagePreview } from '../src/hydrologyworker.js';
import { BASIN_PLAN_VERSION, descriptorHash } from '../src/hydrologyformat.mjs';
import { buildTerrainArrays, buildRiver, sampleRenderedTerrainTriangle } from '../src/chunkgen.js';

const sources = [
  { x: 2958.222222222222, z: 2958.222222222222 },
  { x: 2958.222222222222, z: 3413.3333333333335 },
  { x: 3413.3333333333335, z: 3413.3333333333335 },
];

test('character network on generated terrain retains tributaries, supported banks and an ocean handoff', () => {
  const world = new World(20260612, { generationVersion: 3 });
  const options = { riverCharacter: true, mouthLength: 64 };
  const network = planRiverNetwork(world, sources, options);
  assert.deepEqual(network, planRiverNetwork(world, [...sources].reverse(), options));
  assert.equal(network.components.length, 1);
  const component = network.components[0];
  assert.equal(component.junctions.length, 2);
  assert.ok(component.hierarchy);
  assert.equal(component.hierarchy.catchment.crossRegionComplete, false);
  assert.equal(component.hierarchy.catchment.provenance, 'catchment-proxy');
  const nominal = component.reaches.map(r => r.channelProfile.halfWidth);
  assert.ok(Math.max(...nominal) > Math.min(...nominal) * 1.4, 'downstream accumulation must be visible');
  for (const reach of component.reaches) {
    for (let i = 0; i < reach.points.length; i++) {
      const p = reach.points[i];
      assert.ok(Number.isFinite(p.waterY));
      assert.ok(p.x >= reach.bounds.minX && p.x <= reach.bounds.maxX);
      assert.ok(p.z >= reach.bounds.minZ && p.z <= reach.bounds.maxZ);
      if (i) assert.ok(p.waterY <= reach.points[i - 1].waterY + 1e-9);
    }
  }
  const mesh = bakeSparseRiverComponent(world, component);
  assert.equal(mesh.status, 'baked', JSON.stringify(mesh));
  assert.equal(mesh.oceanHandoff, true);
  for (let i = 0; i < mesh.grid.floor.length; i++) {
    assert.ok(mesh.grid.natural[i] - mesh.grid.floor[i] <= 6 + 1e-7);
    assert.ok(mesh.grid.floor[i] - mesh.grid.natural[i] <= 2 + 1e-7);
  }
  const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, seed: world.seed,
    regionX: 0, regionZ: 0, preview: true, basins: [], components: [mesh] };
  const installed = new World(world.seed, { waterPlans: [{ ...payload, hash: descriptorHash(payload) }] });
  const target = component.junctions[0];
  const cx = Math.floor(target.x / 140), cz = Math.floor(target.z / 140);
  const terrain = buildTerrainArrays(installed, cx, cz, 16, 140);
  const water = buildRiver(cx, cz, 16, 140, terrain.river);
  assert.ok(water?.indices.length > 0, 'visible water geometry must be installed');
  const high = buildTerrainArrays(installed, cx, cz, 96, 140);
  assert.deepEqual(high.positions, terrain.positions);
  assert.deepEqual(buildRiver(cx, cz, 96, 140, high.river), water);
  let shores = 0;
  for (let i = 0; i < water.wet.length; i++) {
    if (water.wet[i] > 1e-6) continue;
    const [x, y, z] = water.positions.slice(i * 3, i * 3 + 3);
    const ground = sampleRenderedTerrainTriangle(terrain.positions, terrain.res, 140, cx * 140, cz * 140, x, z).y;
    assert.ok(Math.abs(y - ground) < 0.002, 'rendered shoreline must meet the same terrain');
    shores++;
  }
  assert.ok(shores > 20);
});

test('lake current preview keeps the same shoreline, bed and water levels', () => {
  const request = { seed: 42, regionX: 0, regionZ: 0, basinId: 'basin:42:4032:960' };
  const baseline = prepareBasinDrainagePreview(request);
  const preview = prepareBasinDrainagePreview({ ...request, lakeTransitions: true });
  assert.ok(preview.contactCount >= 2, 'outlet and at least one inlet');
  const before = baseline.plan.components[0].grid, after = preview.plan.components[0].grid;
  for (const key of ['coords', 'head', 'floor', 'signed', 'lakeKind']) assert.deepEqual(after[key], before[key]);
  let changed = 0;
  for (let i = 0; i < after.coords.length; i++) {
    assert.ok(Number.isFinite(after.flowX[i]) && Number.isFinite(after.flowZ[i]));
    assert.ok(Math.hypot(after.flowX[i], after.flowZ[i]) <= 1 + 1e-9);
    if (!after.lakeKind[i]) {
      assert.equal(after.flowX[i], before.flowX[i]); assert.equal(after.flowZ[i], before.flowZ[i]);
    } else if (after.flowX[i] !== before.flowX[i] || after.flowZ[i] !== before.flowZ[i]) changed++;
  }
  assert.ok(changed > 0, 'lake transition must reach the installed water mesh');
  assert.notEqual(baseline.plan.hash, preview.plan.hash);
});
