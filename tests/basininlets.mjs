import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planBasins } from '../src/basinplanner.mjs';
import { planBasinDrainage } from '../src/basinoutlet.mjs';
import { addBasinInlets, planLakeSystem } from '../src/basininlets.mjs';
import { RiverRoutePlanner } from '../src/riverroute.mjs';
import { wetBasinAt } from '../src/basinmembership.mjs';
import { bakeSparseRiverComponent, SparseRiverComponentField } from '../src/riversparsemesh.mjs';
import { prepareBasinDrainagePreview } from '../src/hydrologyworker.js';

const natural = new World(42, { generationVersion: 3 });
const basin = planBasins(natural, 0, 0).basins.find(b => b.id === 'basin:42:4032:960');
const drainage = planBasinDrainage(natural, basin), system = addBasinInlets(natural, drainage);

test('a generated stream enters the pond at its level and shares the outlet mesh', () => {
  assert.equal(system.status, 'baked');
  assert.equal(system.inletCount, 1);
  assert.equal(system.component.reaches.length, 2);
  assert.ok(drainage.attempts > 1, 'an alternate shoreline fixes the original unsuitable exit');
  assert.equal(planLakeSystem(natural, basin).mesh.hash, system.mesh.hash);
  const field = new SparseRiverComponentField(JSON.parse(JSON.stringify(system.mesh))), sample = {};
  const inlet = system.component.reaches.find(r => !r.oceanMouth), end = inlet.points.at(-1);
  assert.ok(wetBasinAt([system.basin], end.x, end.z));
  assert.equal(end.waterY, basin.level);
  assert.ok(inlet.points[0].waterY > basin.level);
  assert.equal(inlet.points[0].depth, 0, 'the stream starts in a closing spring bed');
  for (const r of system.component.reaches) for (let i = 1; i < r.points.length; i++) {
    const a = r.points[i - 1], b = r.points[i];
    assert.ok(a.waterY >= b.waterY - 1e-9);
    if (a.depth < 0.2 || a.arc < 10) continue;
    for (const t of [0, 0.25, 0.5, 0.75]) {
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      assert.ok(field.sample(x, z, natural.height(x, z), sample));
      assert.ok(sample.signedDepth > 0, 'inlet and outlet have no dry breaks');
    }
  }
  field.sample(basin.centerX, basin.centerZ, natural.height(basin.centerX, basin.centerZ), sample);
  assert.equal(sample.turbidity, basin.material.turbidity);
  assert.equal(sample.exposure, basin.material.exposure);
  const preview = prepareBasinDrainagePreview({ seed: 42, regionX: 0, regionZ: 0 });
  assert.equal(preview.inletCount, 1);
  assert.equal(preview.plan.components[0].hash, system.mesh.hash);
});

test('rejected inlet attempts leave accepted water unchanged and cannot drain a lake backwards', () => {
  const limited = addBasinInlets(natural, drainage, { maxVisited: 1 });
  assert.equal(limited.inletCount, 0);
  assert.equal(limited.mesh.hash, drainage.mesh.hash);
  assert.deepEqual(limited.component, drainage.component);
  assert.equal(addBasinInlets(natural, drainage, { maxInlets: 0 }).mesh.hash, drainage.mesh.hash);
  const capped = addBasinInlets(natural, drainage, { maxBytes: JSON.stringify(drainage.mesh).length });
  assert.equal(capped.inletCount, 0);
  assert.equal(capped.mesh.hash, drainage.mesh.hash, 'optional detail cannot discard an accepted outlet');
  assert.ok(capped.inletDiagnostics.rejected.includes('inlet-detail-budget'));
  assert.throws(() => addBasinInlets(natural, drainage, { maxBytes: NaN }), /budget/);
  assert.throws(() => addBasinInlets(natural, drainage, { maxInlets: 4 }), /budget/);
  const planner = new RiverRoutePlanner(natural);
  assert.equal(planner.route({ x: basin.centerX, z: basin.centerZ }, { basinTarget: system.basin }).reason, 'source-in-target-lake');
  assert.throws(() => planner.route({ x: 100, z: 100 }, { basinTarget: {} }), /lake target/);
  const inlet = system.component.reaches.find(r => !r.oceanMouth);
  const changed = { ...inlet, points: inlet.points.map(p => ({ ...p, waterY: p.waterY + 0.1 })) };
  assert.notEqual(bakeSparseRiverComponent(natural, { ...system.component,
    reaches: system.component.reaches.map(r => r === inlet ? changed : r) }).status, 'baked');
});

test('an inland grassland lake receives two independent streams without an invented ocean outlet', () => {
  const world = new World(1, { generationVersion: 3 });
  const lake = planBasins(world, -3, -2).basins.find(b => b.id === 'basin:1:-9872:-8024');
  assert.ok(lake);
  assert.notEqual(planBasinDrainage(world, lake).status, 'baked');
  const result = planLakeSystem(world, lake);
  assert.equal(result.status, 'baked'); assert.equal(result.inland, true);
  assert.equal(result.inletCount, 2); assert.equal(result.component.reaches.length, 2);
  assert.equal(result.mesh.oceanHandoff, false);
  assert.ok(result.inletDiagnostics.visited <= 8192);
  assert.equal(planLakeSystem(world, lake).mesh.hash, result.mesh.hash);
  const field = new SparseRiverComponentField(JSON.parse(JSON.stringify(result.mesh)));
  for (const reach of result.component.reaches) {
    assert.equal(reach.oceanMouth, false); assert.equal(reach.points[0].depth, 0);
    assert.equal(reach.points.at(-1).waterY, lake.level);
    assert.ok(wetBasinAt([result.basin], reach.points.at(-1).x, reach.points.at(-1).z));
    for (let i = 1; i < reach.points.length; i++) {
      const a = reach.points[i - 1], b = reach.points[i];
      assert.ok(a.waterY >= b.waterY - 1e-9);
      if (a.depth < 0.2 || a.arc < 10) continue;
      const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2, sample = {};
      assert.ok(field.sample(x, z, world.height(x, z), sample));
      assert.ok(sample.signedDepth > 0);
    }
  }
  assert.notEqual(planLakeSystem(world, lake, { inlets: { maxInlets: 0 } }).status, 'baked');
});
