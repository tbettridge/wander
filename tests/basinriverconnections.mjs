import test from 'node:test';
import assert from 'node:assert/strict';
import { planRiverNetwork } from '../src/rivernetwork.mjs';
import { connectBasinToRiver } from '../src/basinriverconnections.mjs';
import { SparseRiverComponentField } from '../src/riversparsemesh.mjs';
import { World } from '../src/world.js';
import { planBasins } from '../src/basinplanner.mjs';

const world = { seed: 777, _naturalHeight: (x, z) => 4 - x * .006
  + Math.min(z * z / 180, (z + x - 100) ** 2 / 360)
  - 3 * Math.exp(-((x + 128) ** 2 + (z - 228) ** 2) / 400) };
const lake = { id: 'upper', kind: 'pond', level: 4.2, centerX: -128, centerZ: 228, length: 64,
  bounds: { minX: -160, maxX: -96, minZ: 196, maxZ: 260 } };
const makeNetwork = () => planRiverNetwork(world, [{ x: -256, z: 0 }], { mouthLength: 64 }).components[0];

test('a lake outlet joins an existing river with one downstream owner and a continuous wet confluence', () => {
  const network = makeNetwork(), before = structuredClone(network);
  const result = connectBasinToRiver(world, lake, network);
  assert.equal(result.status, 'baked');
  assert.deepEqual(network, before, 'joining never mutates the fallback network');
  assert.equal(result.component.junctions.length, 1);
  assert.equal(result.component.reaches.filter(r => r.oceanMouth).length, 1);
  assert.equal(result.mesh.oceanHandoff, true);
  assert.deepEqual(result.mesh.basinIds, [lake.id]);
  assert.ok(result.visited <= 8192);
  const field = new SparseRiverComponentField(JSON.parse(JSON.stringify(result.mesh)));
  const outlet = result.component.reaches.find(r => r.points[0].nodeId === `lake-outlet:${lake.id}`);
  assert.equal(outlet.sourceClosure, false);
  assert.equal(outlet.points[0].waterY, lake.level);
  const junction = result.component.junctions[0];
  const meeting = result.component.reaches.flatMap(r => [r.points[0], r.points.at(-1)])
    .filter(p => p.nodeId === junction.nodeId);
  assert.equal(meeting.length, 3);
  assert.ok(meeting.every(p => p.waterY === junction.waterY));
  for (const reach of result.component.reaches) for (let i = 1; i < reach.points.length; i++) {
    const a = reach.points[i - 1], b = reach.points[i];
    assert.ok(a.waterY >= b.waterY - 1e-9);
    const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2, sample = {};
    if (a.arc < 24 && reach.sourceClosure) continue;
    assert.ok(field.sample(x, z, world._naturalHeight(x, z), sample));
    assert.ok(sample.signedDepth > 0);
  }
  const downstream = new Set();
  for (const edge of result.component.graph.edges) {
    assert.equal(downstream.has(edge.from), false); downstream.add(edge.from);
  }
  assert.equal(connectBasinToRiver(world, lake, network).mesh.hash, result.mesh.hash);
});

test('unsolved and uphill lake connections retain the original independent river', () => {
  const network = makeNetwork(), before = structuredClone(network);
  const limited = connectBasinToRiver(world, lake, network, { maxVisited: 1, maxAttempts: 1 });
  assert.equal(limited.status, 'rejected'); assert.equal(limited.mesh, undefined);
  assert.equal(connectBasinToRiver(world, { ...lake, level: 0 }, network).status, 'rejected');
  assert.equal(connectBasinToRiver(world, lake, {}).reason, 'invalid-receiving-network');
  assert.equal(connectBasinToRiver(world, lake, network, { existingReaches: network.reaches }).reason, 'lake-already-has-outlet');
  assert.deepEqual(network, before);
  assert.throws(() => connectBasinToRiver(world, lake, network, { maxVisited: 0 }), /budget/);
});

test('natural terrain supports a lake-to-river connection within the regional detail allowance', () => {
  const natural = new World(1, { generationVersion: 3 });
  const basin = planBasins(natural, 0, 0).basins.find(b => b.id === 'basin:1:3392:1784');
  const network = planRiverNetwork(natural, [{ x: 3575.3846153846152, z: 2048 }], { mouthLength: 64 }).components[0];
  const result = connectBasinToRiver(natural, basin, network);
  assert.equal(result.status, 'baked');
  assert.ok(JSON.stringify(result.mesh).length < 1750000);
  assert.equal(result.component.junctions.length, 1);
  assert.equal(result.mesh.oceanHandoff, true);
  const field = new SparseRiverComponentField(JSON.parse(JSON.stringify(result.mesh)));
  for (const junction of result.component.junctions) {
    const sample = {};
    assert.ok(field.sample(junction.x, junction.z, natural._naturalHeight(junction.x, junction.z), sample));
    assert.ok(sample.signedDepth > 0);
    assert.ok(Math.abs(sample.waterY - junction.waterY) < 1e-5);
  }
});
