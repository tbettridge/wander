import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRegionalTrunk } from '../src/regionaltrunks.mjs';
import { extendRegionalTrunk } from '../src/regionaltributaries.mjs';
import { addRegionalDelta } from '../src/regionaldeltas.mjs';
import { prepareRiverJunctions } from '../src/riverjunctions.mjs';
import { SparseRiverComponentField } from '../src/riversparsemesh.mjs';

const world = new World(20260612, { generationVersion: 3 });
const trunk = planRegionalTrunk(world, -1, -1);
const original = JSON.stringify(trunk);
const existingNetwork = { components: [{ routes: [{ source: 'existing-valley-source',
  points: [{ x: -3623.3846153846152, z: -109.53846153846143 }] }] }] };
const expanded = extendRegionalTrunk(world, trunk, existingNetwork);
const main = expanded.component.reaches.filter(reach => reach.channelProfile.regionalTrunk);
const branches = expanded.component.reaches.filter(reach => !reach.channelProfile.regionalTrunk);

test('regional tributaries retain the accepted main shape and fit flowing narrow branches into shared heads', () => {
  assert.equal(trunk.status, 'baked');
  assert.equal(expanded.diagnostics.tributaries.accepted, 2);
  assert.equal(branches.length, 2);
  assert.ok(expanded.diagnostics.tributaries.proposed <= 6);
  assert.equal(prepareRiverJunctions(expanded.component).status, 'prepared');
  const shape = point => Object.fromEntries(Object.entries(point).filter(([key]) =>
    !['arc', 'nodeId', 'preferredY', 'waterY'].includes(key)));
  const retained = main.flatMap((reach, i) => i ? reach.points.slice(1) : reach.points);
  assert.deepEqual(retained.map(shape), trunk.component.reaches[0].points.map(shape));
  assert.equal(JSON.stringify(trunk), original, 'a rejected proposal cannot mutate the accepted trunk');
  for (const reach of main) {
    assert.equal(reach.channelProfile.id, trunk.component.reaches[0].channelProfile.id);
    assert.equal(reach.channelProfile.morphology, true);
    assert.equal(reach.maxCut, trunk.component.reaches[0].maxCut);
    assert.equal(reach.maxFill, trunk.component.reaches[0].maxFill);
    assert.ok(reach.bounds.maxZ - reach.bounds.minZ <= trunk.component.reaches[0].bounds.maxZ
      - trunk.component.reaches[0].bounds.minZ);
  }
  for (const branch of branches) {
    assert.ok(branch.points[0].waterY > branch.points.at(-1).waterY + 0.1,
      'the wide main collar must not flatten an entire small creek');
    assert.ok(branch.points.every(point => point.leftWidth + point.rightWidth < 30));
    const source = branch.points[0], outlet = branch.points.at(-1);
    assert.ok(outlet.leftWidth + outlet.rightWidth > (source.leftWidth + source.rightWidth) * 1.8,
      'the creek must emerge gradually instead of starting with a full-width rectangular cap');
    assert.ok(outlet.arc / Math.hypot(outlet.x - source.x, outlet.z - source.z) > 1.012,
      'a tributary must have a visible sweep instead of a straight drain');
    assert.equal(branch.channelProfile.morphology, true);
  }
  for (const junction of expanded.component.junctions) {
    const incident = expanded.component.reaches.flatMap(reach =>
      [reach.points[0], reach.points.at(-1)].filter(point => point.nodeId === junction.nodeId));
    assert.ok(incident.length >= 3);
    assert.ok(incident.every(point => point.x === junction.x && point.z === junction.z
      && point.waterY === junction.waterY));
  }
  for (const reach of expanded.component.reaches) for (let i = 1; i < reach.points.length; i++) {
    const a = reach.points[i - 1], b = reach.points[i];
    assert.ok(a.waterY >= b.waterY - 1e-9);
    assert.ok(a.waterY - b.waterY <= (b.arc - a.arc) * reach.maxGrade + 1e-9);
  }
});

test('the joint sparse mesh stays bounded and continuously owns the main river and both feeders', () => {
  assert.equal(expanded.mesh.grid.step, 8);
  assert.ok(expanded.mesh.grid.coords.length <= 21000);
  assert.ok(JSON.stringify(expanded.mesh).length <= 2000000);
  const field = new SparseRiverComponentField(expanded.mesh), sample = {};
  for (const reach of expanded.component.reaches) for (const point of reach.points) {
    if ((reach.sourceClosure && point.arc < 48) || reach.points.at(-1).arc - point.arc < 8) continue;
    assert.ok(field.sample(point.x, point.z, world._naturalHeight(point.x, point.z), sample));
    assert.ok(sample.signedDepth > 0.03, `dry centerline in ${reach.id} at ${point.arc}`);
  }
  const repeat = extendRegionalTrunk(world, trunk, existingNetwork);
  assert.equal(repeat.mesh.hash, expanded.mesh.hash);
});

test('incoming creek sources close as narrow dry springs without carving a bowl behind the head', () => {
  const field = new SparseRiverComponentField(expanded.mesh), sample = {};
  for (const reach of branches) {
    const source = reach.points[0];
    assert.ok(source.leftWidth + source.rightWidth < 3);
    assert.equal(source.depth, 0);
    assert.equal(reach.sourceClosure, true);
    assert.equal(reach.oceanMouth, false);
    assert.ok(field.sample(source.x, source.z, world._naturalHeight(source.x, source.z), sample));
    assert.ok(sample.signedDepth <= 0.03, 'the spring nose must meet dry ground');
    assert.equal(sample.estuary, 0, 'an incoming source must retain its freshwater material');
    const behindX = source.x - source.tx * 16, behindZ = source.z - source.tz * 16;
    const grid = expanded.mesh.grid;
    let nearest = -1, distance = Infinity;
    for (let i = 0; i < grid.coords.length; i++) {
      const [x, z] = grid.coords[i];
      const d = (x * grid.step - behindX) ** 2 + (z * grid.step - behindZ) ** 2;
      if (d < distance) { distance = d; nearest = i; }
    }
    assert.ok(nearest >= 0 && distance < 64);
    assert.equal(grid.floor[nearest], grid.natural[nearest], 'ground behind the source must stay natural');
    assert.ok(grid.signed[nearest] <= 0, 'there must be no isolated water patch behind the spring');
  }
});

test('regional feeders reuse an existing local source and coexist with the physical sea delta', () => {
  const localNetwork = existingNetwork;
  const before = JSON.stringify(localNetwork);
  const result = extendRegionalTrunk(world, trunk, localNetwork);
  assert.ok(result.diagnostics.tributaries.attempts.some(attempt => attempt.stage === 'accepted'
    && attempt.source === 'existing-valley-source' && attempt.origin === 'local-network'));
  assert.equal(JSON.stringify(localNetwork), before);
  const delta = addRegionalDelta(world, result);
  assert.ok(delta.delta.arms >= 2, 'a new feeder must leave room for a shared physical delta');
  assert.equal(prepareRiverJunctions(delta.component).status, 'prepared');
  assert.ok(JSON.stringify(delta.mesh).length <= 2000000);
});

test('unsupported inputs and landscapes without safe sources retain the accepted trunk', () => {
  const rejected = { status: 'rejected', reason: 'terrain' };
  assert.equal(extendRegionalTrunk(world, rejected, null), rejected);
  const submerged = Object.create(world);
  submerged._naturalHeight = () => -1;
  const result = extendRegionalTrunk(submerged, trunk, { components: [] });
  assert.equal(result.mesh, trunk.mesh);
  assert.equal(result.component, trunk.component);
  assert.equal(result.diagnostics.tributaries.accepted, 0);
});
