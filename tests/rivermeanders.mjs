import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeRiverMeanders } from '../src/rivermeanders.mjs';

const point = (id, x, z, waterY = 4) => ({ id, x, z, waterY, preferredY: waterY });

function segmentedReach({ id = 'trunk', length = 640, spacing = 64, waterDrop = 2 } = {}) {
  const count = Math.round(length / spacing);
  return {
    status: 'candidate',
    reaches: [{ id, status: 'candidate', source: `${id}:source`, outlet: `${id}:outlet`,
      sourceClosure: false, oceanMouth: false,
      points: Array.from({ length: count + 1 }, (_, index) => point(
        index === 0 ? `${id}:source` : index === count ? `${id}:outlet` : `${id}:node:${index}`,
        0, index * spacing, 5 - waterDrop * index / count)) }],
    junctions: [],
  };
}

function flatValley() {
  return { seed: 77, _naturalHeight: (x, z) => 8 - z * 0.004 + x * x * 0.00002 };
}

test('broad flat valley receives deterministic nonperiodic bends with canonical endpoints', () => {
  const input = segmentedReach({ spacing: 4 });
  const first = proposeRiverMeanders(flatValley(), input, { seed: 123 });
  const second = proposeRiverMeanders(flatValley(), input, { seed: 123 });
  assert.deepEqual(first, second);
  assert.equal(first.status, 'candidate');
  const route = first.reaches[0];
  assert.equal(route.points[0].id, 'trunk:source');
  assert.equal(route.points.at(-1).id, 'trunk:outlet');
  assert.equal(route.points[0].x, 0);
  assert.equal(route.points.at(-1).x, 0);
  assert.equal(route.profileArcLength, 640);
  assert.ok(route.points.length < input.reaches[0].points.length, '4 m-like source data must be bounded');
  assert.ok(first.diagnostics.reaches[0].meandered);
  assert.ok(first.diagnostics.reaches[0].maxOffset >= 10);
  assert.ok(first.diagnostics.reaches[0].maxOffset <= 30);
  assert.ok(first.diagnostics.reaches[0].sinuosity > 1.01);
  assert.deepEqual(input.reaches[0].points, segmentedReach({ spacing: 4 }).reaches[0].points, 'proposal is pure');
});

test('junction and mouth collars stay on the canonical tangent', () => {
  const input = segmentedReach({ length: 768 });
  input.junctions = [{ id: 'junction:start', nodeId: 'trunk:source', x: 0, z: 0 }];
  input.reaches[0].oceanMouth = true;
  const result = proposeRiverMeanders(flatValley(), input, { seed: 9, junctionLength: 128, mouthLength: 64 });
  const points = result.reaches[0].points;
  for (const point of points.filter(point => point.arc <= 128 + 1e-6)) assert.equal(point.x, 0);
  for (const point of points.filter(point => point.arc >= 768 - 64 - 1e-6)) assert.equal(point.x, 0);
  assert.equal(points[0].id, 'trunk:source');
  assert.equal(points.at(-1).id, 'trunk:outlet');
});

test('steep or confined terrain is retained straight with low amplitude', () => {
  const world = { seed: 1, _naturalHeight: (x, z) => 8 - z * 0.004 + x * x * 0.05 };
  const result = proposeRiverMeanders(world, segmentedReach(), { seed: 1 });
  const diagnostic = result.diagnostics.reaches[0];
  assert.equal(diagnostic.meandered, false);
  assert.match(diagnostic.reason, /steep-or-confined|unsafe-footprint|low-amplitude-terrain/);
  assert.deepEqual(result.reaches[0].points, segmentedReach().reaches[0].points);
});

test('oversampled route is resampled near 32 m and moved interior ids are removed', () => {
  const input = segmentedReach({ length: 512, spacing: 4 });
  const result = proposeRiverMeanders(flatValley(), input, { seed: 44, maxSamples: 128 });
  const route = result.reaches[0];
  assert.ok(route.points.length <= 128);
  const distances = route.points.slice(1).map((current, index) =>
    Math.hypot(current.x - route.points[index].x, current.z - route.points[index].z));
  assert.ok(Math.min(...distances) > 7, 'fitter must receive nondegenerate derivatives');
  const interiorIds = route.points.slice(1, -1).map(point => point.id).filter(Boolean);
  assert.ok(interiorIds.length < input.reaches[0].points.length - 2);
});

test('steep reaches remain straight and seed identity changes broad-valley bends', () => {
  const steep = segmentedReach({ waterDrop: 45 });
  const retained = proposeRiverMeanders(flatValley(), steep);
  assert.equal(retained.diagnostics.proposed, 0);
  assert.deepEqual(retained.reaches[0].points, steep.reaches[0].points);
  const input = segmentedReach();
  assert.notDeepEqual(proposeRiverMeanders(flatValley(), input, { seed: 10 }).reaches,
    proposeRiverMeanders(flatValley(), input, { seed: 11 }).reaches);
});

test('a turn within a junction collar retains the original endpoint heading', () => {
  const input = segmentedReach({ length: 768 });
  input.reaches[0].points[1].x = 12;
  input.reaches[0].points.at(-2).x = -12;
  input.junctions = [
    { nodeId: 'trunk:source', x: 0, z: 0 },
    { nodeId: 'trunk:outlet', x: 0, z: 768 },
  ];
  const result = proposeRiverMeanders(flatValley(), input, { junctionLength: 128 });
  const after = result.reaches[0].points, before = input.reaches[0].points;
  for (const end of [0, 1]) {
    const [a, b] = end ? after.slice(-2) : after.slice(0, 2);
    const [c, d] = end ? before.slice(-2) : before.slice(0, 2);
    const cross = (b.x - a.x) * (d.z - c.z) - (b.z - a.z) * (d.x - c.x);
    assert.ok(Math.abs(cross) < 1e-6, 'anchored connection must not rotate');
  }
});
