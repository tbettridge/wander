import test from 'node:test';
import assert from 'node:assert/strict';
import { connectInlandBasins } from '../src/basinconnections.mjs';
import { SparseRiverComponentField } from '../src/riversparsemesh.mjs';
import { World } from '../src/world.js';
import { planBasins } from '../src/basinplanner.mjs';
const world = { seed: 777, _naturalHeight: (x, z) => 5 - x * .01 + z * z / 144
  - 3 * Math.exp(-(x * x + z * z) / 196) - 3 * Math.exp(-((x - 200) ** 2 + z * z) / 196) };
const basin = (x, level, id) => ({ id, kind: 'pond', level, centerX: x, centerZ: 0, length: 64,
  bounds: { minX: x - 32, maxX: x + 32, minZ: -32, maxZ: 32 } });
const upper = basin(0, 4, 'upper'), lower = basin(200, 2, 'lower');

test('two inland lakes share a downhill channel and complete shoreline collars', () => {
  const result = connectInlandBasins(world, upper, lower);
  assert.equal(result.status, 'baked'); assert.equal(result.mesh.oceanHandoff, false);
  assert.deepEqual([...result.mesh.basinIds].sort(), ['lower', 'upper']);
  assert.ok(result.visited <= 8192);
  const field = new SparseRiverComponentField(JSON.parse(JSON.stringify(result.mesh)));
  const reach = result.component.reaches[0];
  assert.equal(reach.points[0].waterY, 4); assert.equal(reach.points.at(-1).waterY, 2);
  for (let i = 1; i < reach.points.length; i++) {
    const a = reach.points[i - 1], b = reach.points[i], sample = {};
    const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2;
    assert.ok(a.waterY >= b.waterY - 1e-9);
    assert.ok(field.sample(x, z, world._naturalHeight(x, z), sample));
    assert.ok(sample.signedDepth > 0);
  }
  assert.equal(connectInlandBasins(world, upper, lower).mesh.hash, result.mesh.hash);
  assert.equal(connectInlandBasins(world, upper, lower, { existingReaches: [reach] }).reason, 'lake-already-has-outlet');
});

test('inland links reject reversed, distant and unfinished connections', () => {
  assert.equal(connectInlandBasins(world, lower, upper).reason, 'invalid-downstream-lake');
  assert.equal(connectInlandBasins(world, upper, basin(2000, 2, 'far')).reason, 'inland-connection-extent');
  const limited = connectInlandBasins(world, upper, lower, { maxVisited: 1, maxAttempts: 1 });
  assert.equal(limited.status, 'rejected'); assert.equal(limited.mesh, undefined);
  assert.throws(() => connectInlandBasins(world, upper, lower, { maxVisited: 0 }), /budget/);
});

test('nearby natural depressions form a contained downhill pond chain', () => {
  const natural = new World(2, { generationVersion: 3 });
  const primary = planBasins(natural, 0, 0).basins;
  const candidates = planBasins(natural, 0, 0, { maxBasins: 12, minSpacing: 96 }).basins;
  const source = primary.find(b => b.id === 'basin:2:3528:488');
  const target = candidates.find(b => b.id === 'basin:2:3344:336');
  assert.ok(source && target);
  assert.equal(primary.some(b => b.id === target.id), false, 'the companion is not an extra independent encounter');
  const result = connectInlandBasins(natural, source, target);
  assert.equal(result.status, 'baked');
  assert.equal(result.mesh.oceanHandoff, false);
  const reach = result.component.reaches[0];
  assert.equal(reach.sourceClosure, false);
  assert.equal(reach.points[0].waterY, source.level);
  assert.equal(reach.points.at(-1).waterY, target.level);
  const field = new SparseRiverComponentField(JSON.parse(JSON.stringify(result.mesh)));
  for (let i = 1; i < reach.points.length; i++) {
    const a = reach.points[i - 1], b = reach.points[i], sample = {};
    assert.ok(a.waterY >= b.waterY - 1e-9);
    assert.ok(a.waterY - b.waterY <= (b.arc - a.arc) * reach.maxGrade + 1e-9);
    const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2;
    assert.ok(field.sample(x, z, natural._naturalHeight(x, z), sample));
    assert.ok(sample.signedDepth > 0);
  }
  assert.equal(connectInlandBasins(natural, source, target).mesh.hash, result.mesh.hash);
  assert.throws(() => planBasins(natural, 0, 0, { minSpacing: 0 }), /spacing/);
});
