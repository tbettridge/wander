// Trails go round what villages build, not through it.
//
// The terrain solver lays routes a hundred metres a lane and has never known
// where a house stands, so a route that happened to cross a village ran through
// the walls: the path out of Ravenkeld station went through the inn, the market
// hall and five houses. These hold the promise both ways: no trail centreline
// inside a building, and nothing moved that did not have to move.

import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/world.js';
import { trailsAround } from '../src/trails.js';
import { insideObstacle, routeAroundObstacles } from '../src/trailclearance.mjs';
import { settlementsAround } from '../src/settlementplacement.mjs';
import { cachedSettlementPlan } from '../src/settlementspatial.mjs';
import { pointInsideBuilding } from '../src/settlementplan.mjs';

function samples(pts, step = 0.5) {
  const out = [];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const span = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
    const n = Math.max(1, Math.ceil(span / step));
    for (let k = 0; k <= n; k++) out.push([pts[i] + (pts[i + 2] - pts[i]) * k / n, pts[i + 1] + (pts[i + 3] - pts[i + 1]) * k / n]);
  }
  return out;
}

const house = (x, z, yaw = 0.3) => ({ kind: 'rect', x, z, yaw, minX: -5, maxX: 5, minZ: -4, maxZ: 4 });

test('a route that runs into houses is walked round them, and nothing else moves', () => {
  // A straight 400 m line with a terrace of four houses across its middle.
  const pts = [];
  for (let x = 0; x <= 400; x += 20) pts.push(x, 0);
  const shapes = [house(190, -9), house(200, 0), house(210, 9), house(220, 18)];
  const clearance = 3.5;
  const out = routeAroundObstacles(pts, shapes, { clearance });
  assert.ok(out, 'the route was re-planned');
  for (const [x, z] of samples(out)) {
    for (const shape of shapes) {
      assert.ok(!insideObstacle(shape, x, z, clearance * 0.8), `route passes ${x.toFixed(1)},${z.toFixed(1)} inside a house's clearance`);
    }
  }
  // Endpoints are graph junctions and never move.
  assert.deepEqual([out[0], out[1]], [0, 0]);
  assert.deepEqual([out[out.length - 2], out[out.length - 1]], [400, 0]);
  // Away from the houses the solved line is kept vertex for vertex.
  const kept = new Set();
  for (let i = 0; i < out.length; i += 2) kept.add(`${Math.round(out[i] * 1000)},${Math.round(out[i + 1] * 1000)}`);
  for (const x of [0, 20, 40, 60, 80, 100, 120, 300, 320, 340, 360, 380, 400]) {
    assert.ok(kept.has(`${x * 1000},0`), `vertex at ${x} m was moved though nothing was near it`);
  }
  // A short way round, not the long one.
  let length = 0;
  for (let i = 0; i + 3 < out.length; i += 2) length += Math.hypot(out[i + 2] - out[i], out[i + 3] - out[i + 1]);
  assert.ok(length < 400 + 80, `detour adds ${Math.round(length - 400)} m`);
});

test('a route with nothing in its way is left alone', () => {
  const pts = [0, 0, 100, 0, 200, 0];
  assert.equal(routeAroundObstacles(pts, [house(100, 40)], { clearance: 3 }), null);
  assert.equal(routeAroundObstacles(pts, [], { clearance: 3 }), null);
});

test('a detour through a village takes its street when there is one', () => {
  // A wall of houses across the line with a gap, and a street through the gap
  // a little off the straight line.
  const pts = [];
  for (let x = 0; x <= 300; x += 20) pts.push(x, 0);
  const shapes = [];
  for (let z = -60; z <= 60; z += 12) if (Math.abs(z - 24) > 8) shapes.push({ kind: 'rect', x: 150, z, yaw: 0, minX: -5, maxX: 5, minZ: -5, maxZ: 5 });
  const street = { kind: 'capsule', ax: 100, az: 24, bx: 200, bz: 24, radius: 2.5 };
  const out = routeAroundObstacles(pts, shapes, { clearance: 2, favoured: [street] });
  assert.ok(out);
  let throughGap = false;
  for (const [x, z] of samples(out)) {
    for (const shape of shapes) assert.ok(!insideObstacle(shape, x, z, 0), `route crosses a house at ${x.toFixed(1)},${z.toFixed(1)}`);
    if (Math.abs(x - 150) < 1 && Math.abs(z - 24) < 4) throughGap = true;
  }
  assert.ok(throughGap, 'the route goes through the gap the street uses');
});

test('no trail runs through a building of the villages it passes', () => {
  const world = new World(20260612);
  // Wide enough to take in routes the solver laid through houses, not just past them.
  const RADIUS = 8000;
  const raw = trailsAround(world, 0, 0, world.seed, RADIUS, [], { clearOfBuildings: false });
  const edges = trailsAround(world, 0, 0, world.seed, RADIUS, []);
  assert.equal(edges.length, raw.length, 'clearing buildings adds or drops no edge');
  const cleared = edges.filter((edge) => edge.clearedOf);
  assert.ok(cleared.length > 0, 'this stretch of world has a route that needed clearing, so the test exercises it');

  const plans = settlementsAround(world, 0, 0, world.seed, RADIUS + 2500, [])
    .map((site) => cachedSettlementPlan(world, site));
  const throughWalls = (edge) => samples(edge.pts, 1).some(([x, z]) => plans.some((plan) =>
    plan.buildings.some((building) => pointInsideBuilding(building, x, z, 0))));
  assert.ok(raw.some(throughWalls), 'the terrain solver alone lays at least one route through a house here');
  for (const edge of edges) {
    for (const [x, z] of samples(edge.pts, 1)) {
      for (const plan of plans) {
        for (const building of plan.buildings) {
          assert.ok(!pointInsideBuilding(building, x, z, 0),
            `${edge.id} runs through ${building.id} at ${x.toFixed(1)},${z.toFixed(1)}`);
        }
      }
    }
  }
  for (const edge of cleared) {
    const before = raw.find((item) => item.id === edge.id);
    // Same junctions, same class, and every river met where it was met before.
    assert.deepEqual([edge.pts[0], edge.pts[1]], [before.pts[0], before.pts[1]], `${edge.id} start moved`);
    assert.deepEqual([edge.pts.at(-2), edge.pts.at(-1)], [before.pts.at(-2), before.pts.at(-1)], `${edge.id} end moved`);
    assert.equal(edge.routeClass, before.routeClass);
    assert.equal(edge.fordCount, before.fordCount);
  }
});
