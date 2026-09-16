import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { fitRiverComponent } from '../src/rivercomponent.mjs';
import { bakeRiverComponent, RiverComponentMeshField } from '../src/rivercomponentmesh.mjs';
import { buildTerrainArrays, buildRiver, sampleRenderedTerrainTriangle } from '../src/chunkgen.js';
import { descriptorHash, BASIN_PLAN_VERSION } from '../src/hydrologyformat.mjs';

function meshPlan(mesh) {
  const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, preview: true,
    seed: mesh.seed, regionX: 0, regionZ: 0, basins: [], components: [mesh] };
  return { ...payload, hash: descriptorHash(payload) };
}

function rehash(value) {
  const { hash, status, activationReady, ...payload } = value;
  value.hash = descriptorHash(payload);
  return value;
}

function fixture() {
  const world = new World(1, { generationVersion: 3 });
  world._naturalHeight = (x, z, out) => { if (out) out.h = 5; return 5; };
  const join = { id: 'join', x: 0, z: 0, waterY: 3 };
  const route = (id, a, b) => ({ id, status: 'candidate', sourceClosure: false, oceanMouth: false, points: [a, b] });
  const input = { status: 'candidate', reaches: [
    route('a', { id: 'a', x: -50, z: -100, waterY: 3 }, join),
    route('b', { id: 'b', x: 50, z: -100, waterY: 3 }, join),
    route('out', join, { id: 'out', x: 0, z: 100, waterY: 3 }),
  ], junctions: [{ id: 'junction:join', nodeId: 'join' }] };
  return { world, component: fitRiverComponent(world, input, { junctionLength: 64, maxFill: 0 }) };
}

test('joined channel grid has continuous wet approaches and one level through the confluence', () => {
  const { world, component } = fixture();
  const mesh = bakeRiverComponent(world, component);
  assert.equal(mesh.status, 'baked');
  assert.equal(mesh.activationReady, false);
  const reversed = bakeRiverComponent(world, { ...component, reaches: [...component.reaches].reverse() });
  assert.equal(reversed.hash, mesh.hash);
  world.waterField = new RiverComponentMeshField(JSON.parse(JSON.stringify(mesh)));
  const head = component.junctions[0].waterY;
  for (const reach of component.reaches) for (const p of reach.points) {
    if (Math.hypot(p.x, p.z) > 48) continue;
    const water = world.riverAt(p.x, p.z);
    assert.equal(water.wet, true);
    assert.ok(Math.abs(water.y - head) < 1e-8);
  }
  for (let z = -2; z <= 2; z += 0.25) for (let x = -2; x <= 2; x += 0.25) {
    assert.equal(world.riverAt(x, z).wet, true, 'no dry wall across the tributary mouths');
  }
});

test('production terrain/water builders mesh the junction with matching shoreline triangles and chunk edges', () => {
  const { world, component } = fixture();
  const mesh = bakeRiverComponent(world, component);
  assert.equal(mesh.status, 'baked');
  world.waterField = new RiverComponentMeshField(mesh);
  let contacts = 0;
  const chunks = new Map();
  for (const cx of [-1, 0]) for (const cz of [-1, 0]) {
    const terrain = buildTerrainArrays(world, cx, cz, 8, 40);
    assert.equal(terrain.res, 20);
    assert.deepEqual(buildTerrainArrays(world, cx, cz, 64, 40).river, terrain.river);
    const river = buildRiver(cx, cz, 8, 40, terrain.river);
    assert.ok(river?.positions.length > 0);
    for (let i = 0; i < river.wet.length; i++) {
      if (river.wet[i] > 1e-6) continue;
      const [x, y, z] = river.positions.slice(i * 3, i * 3 + 3);
      const ground = sampleRenderedTerrainTriangle(terrain.positions, terrain.res, 40, cx * 40, cz * 40, x, z).y;
      assert.ok(Math.abs(y - ground) < 0.002);
      contacts++;
    }
    chunks.set(`${cx},${cz}`, terrain);
  }
  assert.ok(contacts > 20);
  for (const cz of [-1, 0]) {
    const left = chunks.get(`-1,${cz}`), right = chunks.get(`0,${cz}`);
    for (let row = 0; row <= 20; row++) {
      const a = (row * 21 + 20) * 3, b = row * 21 * 3;
      assert.deepEqual(left.positions.slice(a, a + 3), right.positions.slice(b, b + 3));
    }
  }
});

test('component mesh rejects excess size, unsupported fill and corrupt serialized grids', () => {
  const { world, component } = fixture();
  assert.equal(bakeRiverComponent(world, component, { maxCells: 10 }).reason, 'component-mesh-budget');
  const low = { seed: 1, _naturalHeight: () => 1 };
  assert.ok(['junction-cut-budget', 'uncontained-component-water'].includes(bakeRiverComponent(low, component).reason));
  const mesh = bakeRiverComponent(world, component);
  mesh.grid.floor[0] += 1;
  assert.throws(() => new RiverComponentMeshField(mesh), /identity/);
});

test('component plan uses the same World and actual worker terrain/water payloads', async () => {
  const { prepareJunctionPreview } = await import('../src/hydrologyworker.js');
  const { plan } = prepareJunctionPreview({ seed: 20260612, x: 2600, z: 500 });
  const world = new World(plan.seed, { waterPlans: [JSON.parse(JSON.stringify(plan))] });
  assert.equal(world.waterField.components.size, 1);
  assert.equal(world.waterField.gridStep(10000, 10000, 10140, 10140), null);
  assert.equal(world.riverAt(2600, 500).wet, true);
  const g = plan.components[0].grid;
  for (let i = 0; i < g.floor.length; i++) {
    assert.ok(g.natural[i] - g.floor[i] >= -1e-7, 'the junction never raises ground');
    assert.ok(g.natural[i] - g.floor[i] <= 6 + 1e-7, 'cuts remain within budget');
  }
  const terrain = buildTerrainArrays(world, 18, 3, 16, 140);
  const river = buildRiver(18, 3, 16, 140, terrain.river);
  assert.ok(river?.wet.some(depth => depth > 0.5));
  const messages = [];
  globalThis.self = { postMessage(message, transfer = []) { messages.push(structuredClone(message, { transfer })); } };
  try {
    await import('../src/worker.js?component-mesh-runtime-test');
    self.onmessage({ data: { type: 'init', seed: plan.seed, waterPlans: [plan] } });
    assert.equal(messages.at(-1).type, 'ready');
    self.onmessage({ data: { type: 'build', id: 1, cx: 18, cz: 3, res: 16, chunkSize: 140,
      doTerrain: true, waterPlanHash: world.waterPlanHash } });
    const built = messages.at(-1);
    assert.equal(built.type, 'built');
    assert.equal(built.waterPlanHash, world.waterPlanHash);
    assert.deepEqual(built.river, river);
    assert.deepEqual(built.terrain.positions, terrain.positions);
    let contacts = 0;
    for (let i = 0; i < river.wet.length; i++) {
      if (river.wet[i] > 1e-6) continue;
      const [x, y, z] = river.positions.slice(i * 3, i * 3 + 3);
      const ground = sampleRenderedTerrainTriangle(terrain.positions, terrain.res, 140, 18 * 140, 3 * 140, x, z).y;
      assert.ok(Math.abs(y - ground) < 0.002);
      contacts++;
    }
    assert.ok(contacts > 20);
  } finally { delete globalThis.self; }
});

test('component publication rejects malformed bounds, wet borders and duplicate ownership atomically', () => {
  const { world: fixtureWorld, component } = fixture();
  const mesh = bakeRiverComponent(fixtureWorld, component), plan = meshPlan(mesh);
  const world = new World(plan.seed, { waterPlans: [plan] });
  const oldField = world.waterField;
  const badBounds = structuredClone(mesh);
  badBounds.bounds.maxX += 128;
  assert.throws(() => world.installWaterPlans([meshPlan(rehash(badBounds))]), /bounds/);
  const wetBorder = structuredClone(mesh);
  wetBorder.grid.head[0] = wetBorder.grid.floor[0] + 1;
  wetBorder.grid.signed[0] = 1;
  assert.throws(() => world.installWaterPlans([meshPlan(rehash(wetBorder))]), /dry collar/);
  const duplicate = structuredClone(plan);
  duplicate.components.push(mesh);
  assert.throws(() => world.installWaterPlans([rehash(duplicate)]), /Duplicate river component/);
  const collision = structuredClone(plan);
  collision.reaches = [component.reaches[0]];
  assert.throws(() => world.installWaterPlans([rehash(collision)]), /ownership/);
  const published = structuredClone(plan);
  published.preview = false;
  assert.throws(() => world.installWaterPlans([rehash(published)]), /preview/);
  assert.equal(world.waterField, oldField);
  // The dry collar meets the current natural surface continuously, even if
  // the interpolated survey differs between lattice vertices.
  const field = [...oldField.components.values()][0], sample = {};
  assert.equal(field.sample(mesh.bounds.minX, 0, 6, sample), true);
  assert.equal(sample.floor, 6);
  assert.ok(sample.signedDepth < 0);
});
