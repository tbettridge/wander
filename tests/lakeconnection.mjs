import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { refineBasinConnection, wetBasinAt } from '../src/basinmembership.mjs';
import { fitRiverReach } from '../src/riverterrain.mjs';
import { bakeSparseRiverComponent, SparseRiverComponentField } from '../src/riversparsemesh.mjs';
import { WaterField } from '../src/waterfield.mjs';
import { BASIN_PLAN_VERSION, descriptorHash } from '../src/hydrologyformat.mjs';
import { prepareBasinOutletSurvey } from '../src/hydrologyworker.js';

function fixture() {
  const world = new World(1, { generationVersion: 3 });
  world._naturalHeight = (x, z, out) => {
    const h = Math.min(5, 1 + (x * x + z * z) / 300);
    if (out) out.h = h;
    return h;
  };
  const basin = refineBasinConnection(world, { id: 'lake', kind: 'lake', level: 4, centerX: 0, centerZ: 0,
    bounds: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 } });
  const reach = fitRiverReach(world, { status: 'candidate', source: 'out',
    points: [{ x: 20, z: 0, waterY: 4 }, { x: 100, z: 0, waterY: 4 }] },
  { basins: [basin], oceanMouth: false, sourceClosure: false });
  return { world, basin, reach, component: { status: 'fitted', reaches: [reach], basins: [basin], junctions: [] } };
}
function plan(seed, extras) {
  const p = { version: BASIN_PLAN_VERSION, seed, generationVersion: 3, regionX: 0, regionZ: 0,
    preview: true, basins: [], ...extras };
  return { ...p, hash: descriptorHash(p) };
}

test('one lake/channel mesh retains a level surface and the deeper lake bed', () => {
  const { world, basin, reach, component } = fixture();
  assert.equal(reach.status, 'fitted');
  assert.deepEqual(reach.basinIds, ['lake']);
  const mesh = bakeSparseRiverComponent(world, component);
  assert.equal(mesh.status, 'baked');
  assert.deepEqual(mesh.basinIds, ['lake']);
  const field = new SparseRiverComponentField(JSON.parse(JSON.stringify(mesh))), sample = {};
  for (let x = 0; x < 96; x += 0.5) {
    assert.ok(field.sample(x, 0, world._naturalHeight(x, 0), sample));
    assert.ok(sample.signedDepth > 0, 'no submerged bank wall between lake and channel');
    assert.equal(sample.waterY, basin.level);
  }
  field.sample(0, 0, 1, sample);
  assert.equal(sample.floor, 1);
  assert.equal(sample.bodyKind, 'lake');
  field.sample(80, 0, 5, sample);
  assert.equal(sample.bodyKind, 'river');
  field.sample(40, 0, 5, sample);
  assert.equal(sample.bodyKind, 'river', 'lake material stops at the natural basin shore');
  assert.equal(wetBasinAt([basin], 0, 0).id, basin.id);
  assert.equal(wetBasinAt([basin], 0, 40), null);
  const accepted = new WaterField(world.seed, [plan(world.seed, { components: [mesh] })]);
  assert.equal(accepted.components.size, 1);
});

test('lake support cannot publish a standalone river or conflicting surface', () => {
  const { world, basin, reach, component } = fixture();
  assert.throws(() => new WaterField(world.seed, [plan(world.seed, { reaches: [reach] })]), /combined water mesh/);
  assert.equal(bakeSparseRiverComponent(world, { ...component, basins: [] }).reason, 'missing-lake-composition');
  const badReach = { ...reach, points: reach.points.map(p => ({ ...p, waterY: p.waterY - 0.1 })) };
  assert.equal(bakeSparseRiverComponent(world, { ...component, reaches: [badReach] }).reason, 'junction-head-conflict');
  const mesh = bakeSparseRiverComponent(world, component);
  assert.throws(() => new WaterField(world.seed, [plan(world.seed, { basins: [basin], components: [mesh] })]), /basin ownership/);
  assert.throws(() => refineBasinConnection(world, { ...basin, bounds: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 } }), /budget/);
  const detached = fitRiverReach(world, { status: 'candidate', source: 'detached',
    points: [{ x: 60, z: 0, waterY: 4 }, { x: 100, z: 0, waterY: 4 }] },
  { oceanMouth: false, sourceClosure: false });
  assert.equal(bakeSparseRiverComponent(world, { ...component, reaches: [detached] }).reason, 'disconnected-lake-outlet');
});

test('real outlet bank fitting distinguishes survey success from full channel feasibility', () => {
  const { report } = prepareBasinOutletSurvey({ seed: 20260612, regionX: 0, regionZ: 0 });
  assert.equal(report.outlets.length, 4);
  assert.ok(report.outlets.every(o => o.status === 'candidate'));
  assert.equal(report.outlets.filter(o => o.bankFit.status === 'fitted').length, 1);
  assert.equal(report.outlets.filter(o => o.bankFit.reason === 'incompatible-water-intervals').length, 1);
  assert.equal(report.outlets.filter(o => o.bankFit.reason === 'river-bend-too-tight').length, 2);
  assert.equal(report.activationReady, false);
});
