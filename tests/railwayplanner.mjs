import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import {
  planRegionalRailway,
  RAILWAY_PLANNER_LIMITS,
} from '../src/railwayplanner.mjs';

const summaries = [];
for (const seed of [20260612, 812731, 41]) {
  const world = new World(seed);
  const options = { center: { x: 0, z: 0 }, seed, stationCount: 5 };
  const plan = planRegionalRailway(world, options);
  assert.equal(plan.stations.length, 5);
  assert.equal(plan.segments.length, 5);
  assert.ok(plan.points.length > 300, 'regional loop is undersampled');
  assert.ok(plan.metrics.length >= RAILWAY_PLANNER_LIMITS.targetMinLength,
    `loop too short: ${plan.metrics.length}`);
  assert.ok(plan.metrics.length <= RAILWAY_PLANNER_LIMITS.targetMaxLength,
    `loop too long: ${plan.metrics.length}`);
  assert.ok(plan.metrics.maxGrade <= RAILWAY_PLANNER_LIMITS.maxFormationGrade + 1e-6,
    `formation exceeds grade limit: ${plan.metrics.maxGrade}`);
  assert.ok(plan.metrics.minCurveRadius > 150,
    `alignment violates the regional curve envelope: ${plan.metrics.minCurveRadius}`);
  assert.ok(plan.stations.every((station) => Number.isFinite(station.routeDistance)));
  assert.ok(plan.stations.every((station) => station.biome !== 'ocean'),
    'a station was placed offshore');
  assert.ok(plan.points.every((point) => Number.isFinite(point.formationY)));
  assert.ok(plan.route.length > 0);
  assert.ok(plan.centerOffset <= 9000);
  summaries.push(`${seed}:${(plan.metrics.length / 1000).toFixed(1)}km/${plan.metrics.planningMs.toFixed(0)}ms`);
}

const deterministicWorld = new World(20260612);
const first = planRegionalRailway(deterministicWorld, {
  center: { x: 125, z: -240 }, seed: 9917, stationCount: 4,
});
const second = planRegionalRailway(deterministicWorld, {
  center: { x: 125, z: -240 }, seed: 9917, stationCount: 4,
});
assert.deepEqual(
  first.stations.map(({ x, z, biome }) => [x, z, biome]),
  second.stations.map(({ x, z, biome }) => [x, z, biome]),
  'station placement is not deterministic',
);
assert.deepEqual(Array.from(first.route.positions), Array.from(second.route.positions),
  'alignment is not deterministic');
assert.ok(first.metrics.length >= RAILWAY_PLANNER_LIMITS.targetMinLength);

const sixStationPlan = planRegionalRailway(deterministicWorld, {
  center: { x: 0, z: 0 }, seed: 20260612, stationCount: 6,
});
assert.equal(sixStationPlan.stations.length, 6);
assert.ok(sixStationPlan.metrics.length >= RAILWAY_PLANNER_LIMITS.targetMinLength);
assert.ok(sixStationPlan.metrics.length <= RAILWAY_PLANNER_LIMITS.targetMaxLength);
assert.ok(sixStationPlan.metrics.minCurveRadius > 150);

console.log(`railwayplanner PASS · ${summaries.join(' · ')}`);
