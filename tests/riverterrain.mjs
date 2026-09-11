import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { RiverRoutePlanner } from '../src/riverroute.mjs';
import { fitRiverReach, RiverReachField, riverSectionFloor } from '../src/riverterrain.mjs';

function straightFixture() {
  const world = { seed: 1, _naturalHeight: (x, z) => 4 - z * 0.01 + x * x * 0.004 };
  const route = { status: 'candidate', source: 'spring', points: Array.from({ length: 9 }, (_, i) => ({
    x: 0, z: i * 50, waterY: Math.max(0, 3.4 - i * 0.5),
  })) };
  return { world, route };
}

test('fitted river sections have level water, bounded width and continuous bed/banks', () => {
  const { world, route } = straightFixture();
  const reach = fitRiverReach(world, route);
  assert.equal(reach.status, 'fitted');
  const field = new RiverReachField(reach);
  for (const p of reach.points.slice(10, -10)) {
    for (const side of ['left', 'right']) {
      const sign = side === 'left' ? -1 : 1;
      const width = p[`${side}Width`], bank = p[`${side}BankWidth`];
      assert.ok(width >= 3.2 && width <= 5.2);
      const at = offset => riverSectionFloor(p, sign * offset, world._naturalHeight(sign * offset, p.z));
      assert.equal(at(width), p.waterY);
      assert.ok(Math.abs(at(width - 1e-6) - at(width + 1e-6)) < 1e-5);
      assert.ok(Math.abs(at(width + bank - 1e-6) - at(width + bank + 1e-6)) < 1e-5);
      if (p.waterY > 0) assert.ok(p[`${side}BankY`] >= p.waterY + 0.199);
      for (const offset of [0.3, 1, 2.5]) {
        const sample = {};
        assert.equal(field.sample(sign * offset, p.z, world._naturalHeight(sign * offset, p.z), sample), true);
        assert.equal(sample.waterY, p.waterY);
        assert.ok(sample.signedDepth > 0);
        assert.ok(Math.abs(sample.flowX) < 1e-9);
        assert.ok(sample.flowZ > 0);
      }
    }
  }
  assert.equal(reach.points.at(-1).waterY, 0);
  assert.equal(field.sample(0, -1, 4.01, {}), false, 'no extrusion past spring');
  assert.equal(field.sample(0, 401, -0.01, {}), false, 'no extrusion past outlet');
});

test('fitting retains incompatible crossing levels and never overrides the mouth earthwork budget', () => {
  const { world, route } = straightFixture();
  const fixed = fitRiverReach(world, route, { fixedLevels: [{ id: 'bridge', x: 0, z: 200, minY: 1.5, maxY: 1.5 }] });
  assert.equal(fixed.status, 'fitted');
  assert.equal(fixed.points.find(p => p.z === 200).waterY, 1.5);
  const high = fitRiverReach(world, route, { fixedLevels: [{ id: 'bridge', x: 0, z: 200, minY: 10, maxY: 10 }] });
  assert.equal(high.status, 'retain-legacy');
  const missed = fitRiverReach(world, route, { fixedLevels: [{ id: 'bridge', x: 30, z: 200, minY: 1, maxY: 2 }] });
  assert.equal(missed.reason, 'missed-crossing-anchor');
  const highLand = fitRiverReach({ seed: 1, _naturalHeight: () => 20 }, route);
  assert.equal(highLand.status, 'retain-legacy');
  assert.equal(highLand.reason, 'incompatible-water-intervals');
});

test('real terrain routes respect cut/fill budgets between fitted sections', () => {
  const world = new World(20260612), planner = new RiverRoutePlanner(world);
  for (const [x, z] of [[1200, -1900], [0, -2200], [-2000, -2200]]) {
    const reach = fitRiverReach(world, planner.route({ x, z }));
    assert.equal(reach.status, 'fitted');
    assert.deepEqual(fitRiverReach(world, planner.route({ x, z })), reach);
    const field = new RiverReachField(reach);
    for (let i = 1; i < reach.points.length; i++) {
      const a = reach.points[i - 1], b = reach.points[i];
      assert.ok(a.waterY >= b.waterY - 1e-9);
      assert.ok(a.waterY - b.waterY <= (b.arc - a.arc) * reach.maxGrade + 1e-9);
    }
    for (let pz = reach.bounds.minZ; pz < reach.bounds.maxZ; pz += 1) {
      for (let px = reach.bounds.minX; px < reach.bounds.maxX; px += 1) {
        const natural = world._naturalHeight(px, pz), sample = {};
        if (!field.sample(px, pz, natural, sample)) continue;
        assert.ok(sample.floor - natural <= reach.maxFill + 1e-6, 'fill budget');
        assert.ok(natural - sample.floor <= reach.maxCut + 1e-6, 'cut budget');
        assert.ok(Number.isFinite(sample.waterY));
        assert.ok(Math.hypot(sample.flowX, sample.flowZ) <= 0.700001);
      }
    }
  }
});

test('candidate river survives plan serialization and the actual geometry worker', async () => {
  const { prepareReachPreview } = await import('../src/hydrologyworker.js');
  const { buildTerrainArrays, buildRiver, sampleRenderedTerrainTriangle } = await import('../src/chunkgen.js');
  const { plan } = prepareReachPreview({ seed: 20260612, x: -2000, z: -2200 });
  const world = new World(plan.seed, { waterPlans: [JSON.parse(JSON.stringify(plan))] });
  const { descriptorHash } = await import('../src/hydrologyformat.mjs');
  const overlap = structuredClone(plan);
  overlap.reaches.push({ ...structuredClone(overlap.reaches[0]), id: 'unresolved-tributary' });
  const { hash: ignoredHash, ...overlapPayload } = overlap;
  overlap.hash = descriptorHash(overlapPayload);
  assert.throws(() => world.installWaterPlans([overlap]), /Unresolved overlapping/);
  assert.equal(world.waterField.plans[0].hash, plan.hash);
  const terrain = buildTerrainArrays(world, -14, -16, 16, 140);
  assert.equal(terrain.res, 70);
  const river = buildRiver(-14, -16, 16, 140, terrain.river);
  assert.ok(river?.wet.some(depth => depth > 0.5));
  assert.ok(river.body.some((v, i) => i % 4 === 0 && v === -1));
  assert.deepEqual(buildTerrainArrays(world, -14, -16, 112, 140).river, terrain.river);
  let count = 0;
  for (let i = 0; i < river.wet.length; i++) {
    if (river.body[i * 4] !== -1 || river.wet[i] > 1e-6) continue;
    const x = river.positions[i * 3], y = river.positions[i * 3 + 1], z = river.positions[i * 3 + 2];
    const ground = sampleRenderedTerrainTriangle(terrain.positions, terrain.res, 140, -14 * 140, -16 * 140, x, z).y;
    // Contact uses the same clipped terrain triangle. GPU float32 positions
    // around kilometre coordinates contribute sub-millimetre rounding.
    assert.ok(Math.abs(y - ground) < 0.002);
    count++;
  }
  assert.ok(count > 20);
  const messages = [];
  globalThis.self = { postMessage(message, transfer = []) { messages.push(structuredClone(message, { transfer })); } };
  try {
    await import('../src/worker.js?river-terrain-test');
    self.onmessage({ data: { type: 'init', seed: plan.seed, waterPlans: [plan] } });
    self.onmessage({ data: { type: 'build', id: 1, cx: -14, cz: -16, res: 16, chunkSize: 140,
      doTerrain: true, waterPlanHash: world.waterPlanHash } });
    const built = messages.at(-1);
    assert.equal(built.type, 'built');
    assert.equal(built.waterPlanHash, world.waterPlanHash);
    assert.deepEqual(built.river, river);
  } finally { delete globalThis.self; }
});
