import assert from 'node:assert/strict';
import { generateCaveGraph } from '../src/cavegen.mjs';
import { createCaveField } from '../src/cavefield.mjs';
import {
  buildCaveHydrologyPlan,
  caveHydrologyProfile,
  caveWaterProximity,
} from '../src/cavehydrology.mjs';

let grotto = null;
for (let seed = 1; seed < 200 && !grotto; seed++) {
  const graph = generateCaveGraph(seed, { biome: 'forest', hillClass: 'high' });
  if (graph.geology === 'grotto') grotto = graph;
}
assert.ok(grotto, 'found deterministic grotto fixture');
const field = createCaveField(grotto);
const plan = buildCaveHydrologyPlan(grotto, field);
const repeated = buildCaveHydrologyPlan(grotto, field);
assert.deepEqual(plan, repeated, 'hydrology is deterministic');
assert.ok(plan.streams.length > 0, 'grotto channel edges create streams');
assert.ok(plan.pools.length > 0, 'grotto creates at least one pool');
for (const stream of plan.streams) {
  assert.ok(stream.points.length >= 3);
  assert.ok(stream.points.every((point) => Number.isFinite(point.y)));
  assert.ok(stream.points.every((point) => point.y >= point.floorY + 0.0319), 'rill stays above its sampled bed');
  for (let i = 1; i < stream.points.length; i++) {
    assert.ok(stream.points[i].y <= stream.points[i - 1].y + 1e-9, 'rill follows gravity');
    assert.ok(stream.points[i].halfWidth <= 0.56, 'rill leaves a dry route');
  }
}
assert.ok(plan.junctions.length > 0, 'channel network creates welded water junctions');
for (const junction of plan.junctions) {
  const endpointHeights = [];
  for (const stream of plan.streams) {
    if (stream.fromNode === junction.nodeId) endpointHeights.push(stream.points[0].y);
    if (stream.toNode === junction.nodeId) endpointHeights.push(stream.points.at(-1).y);
  }
  assert.ok(endpointHeights.length >= 2);
  assert.ok(endpointHeights.every((height) => Math.abs(height - junction.y) < 1e-9), 'incident rills share one junction level');
}
for (const pool of plan.pools) {
  assert.equal(pool.points.length, 28);
  assert.ok(pool.points.every((point) => field.sdf(point.x, point.y, point.z) < 0), 'pool remains inside cave air');
}
assert.equal(caveWaterProximity(plan, plan.samplePoints[0]), 1);
assert.equal(caveWaterProximity(plan, { x: 1e4, y: 1e4, z: 1e4 }), 0);
assert.ok(caveHydrologyProfile('ice').frozen);
assert.equal(caveHydrologyProfile('unknown'), caveHydrologyProfile('limestone'));

assert.ok(plan.drips.length > 0, 'wet grotto has ceiling drips');
assert.ok(plan.drips.every((drip) => drip.top > drip.bottom));
assert.ok(plan.mist.length > 0, 'wet pools or falls generate local mist');

console.log(`cavehydrology PASS · ${plan.streams.length} streams · ${plan.pools.length} pools · ${plan.drips.length} drips · ${plan.waterfalls.length} falls`);
