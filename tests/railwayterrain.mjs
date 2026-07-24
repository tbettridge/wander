import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import {
  RailwayTerrainIndex,
  serializeRailwayTerrainPlan,
  setWorldRailwayTerrain,
  RAILWAY_TRACKBED_DROP,
} from '../src/railwayterrain.mjs';

const world = new World(20260612);
const plan = planRegionalRailway(world, {
  center: { x: 0, z: 0 }, seed: 20260612, stationCount: 5,
});
const spec = serializeRailwayTerrainPlan(plan);
const cloned = structuredClone(spec);
const index = new RailwayTerrainIndex(cloned);
assert.equal(index.signature, spec.signature);
assert.equal(index.segmentCount, plan.points.length);
assert.equal(index.stationCount, plan.stations.length);

const station = plan.stations[0];
assert.ok(index.intersectsBounds(station.x - 1, station.z - 1, station.x + 1, station.z + 1));
assert.equal(index.intersectsBounds(1e7, 1e7, 1e7 + 140, 1e7 + 140), false);
const stationBase = world.height(station.x, station.z);
const stationQuery = index.query(stationBase, station.x, station.z, {});
assert.equal(stationQuery.structure, 'station');
assert.ok(stationQuery.station);
// The platform shelf sits on the trackbed (a ballast depth below rail level),
// following the running line rather than a flat slab.
assert.ok(Math.abs(stationQuery.height - (station.formationY - RAILWAY_TRACKBED_DROP)) < 0.25,
  `station shelf ${stationQuery.height} not a trackbed below formation ${station.formationY}`);
assert.equal(stationQuery.treeClearance, 1);
assert.equal(stationQuery.grassClearance, 1);

const surfaceIndex = plan.points.findIndex((point) => point.structure === 'cut' || point.structure === 'fill');
assert.ok(surfaceIndex >= 0, 'test plan has no earthwork sample');
const point = plan.points[surfaceIndex];
const base = world.height(point.x, point.z);
const centre = index.query(base, point.x, point.z, {});
// The running-line subgrade settles a ballast depth below the rail formation.
assert.ok(Math.abs(centre.height - (point.formationY - RAILWAY_TRACKBED_DROP)) < 0.08,
  `earthwork subgrade ${centre.height} not a trackbed below formation ${point.formationY}`);
assert.ok(centre.weight > 0.98);
const far = index.query(base, point.x + 80, point.z + 80, {});
assert.equal(far.weight, 0);
assert.equal(far.height, base);

const bridgePoint = plan.points.find((candidate) => candidate.structure === 'bridge'
  && plan.stations.every((candidateStation) => Math.hypot(
    candidate.x - candidateStation.x, candidate.z - candidateStation.z,
  ) > 80));
assert.ok(bridgePoint, 'test plan has no bridge sample away from a station');
const bridgeBase = world.height(bridgePoint.x, bridgePoint.z);
const bridgeQuery = index.query(bridgeBase, bridgePoint.x, bridgePoint.z, {});
assert.equal(bridgeQuery.height, bridgeBase, 'bridge spans must not raise terrain to rail level');
assert.equal(bridgeQuery.weight, 0);
assert.ok(bridgeQuery.treeClearance > 0.98, 'bridge right-of-way should remain tree-free');

const original = world.height(station.x, station.z);
setWorldRailwayTerrain(world, spec);
assert.ok(Math.abs(world.height(station.x, station.z) - (station.formationY - RAILWAY_TRACKBED_DROP)) < 0.25);
assert.equal(world.railwayClearanceAt(station.x, station.z, {}).treeClearance, 1);
setWorldRailwayTerrain(world, null);
assert.ok(Math.abs(world.height(station.x, station.z) - original) < 1e-9);

console.log(`railwayterrain PASS · ${index.segmentCount} indexed segments · ${index.bins.size} spatial bins`);
