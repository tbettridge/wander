import test from 'node:test';
import assert from 'node:assert/strict';
import { RiverRoutePlanner, riverBoundaryPortals } from '../src/riverroute.mjs';

test('candidate rivers follow terrain to an actual ocean outlet across planning boundaries', () => {
  const world = { _naturalHeight: (x, z) => 20 - z * 0.022 + x * x * 0.0003 };
  const planner = new RiverRoutePlanner(world, { maxVisited: 4096 });
  const route = planner.route({ x: 128, z: 0 });
  assert.equal(route.status, 'candidate');
  assert.ok(route.points.at(-1).h < -0.25);
  assert.equal(route.points.at(-1).waterY, 0);
  assert.ok(Math.abs(route.points.at(-1).x) < 128, 'river should seek the valley floor');
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1], b = route.points[i];
    assert.ok(a.waterY >= b.waterY - 1e-9);
    assert.ok(a.waterY - b.waterY <= (b.arc - a.arc) * 0.025 + 1e-9);
  }
  const portals = riverBoundaryPortals(route, 256);
  assert.ok(portals.length >= 3);
  for (const p of portals) assert.ok(Math.abs(p[p.axis] - p.boundary * 256) < 1e-8);
  planner.nodes.clear();
  assert.deepEqual(planner.route({ x: 128, z: 0 }), route);
  const tinyCache = new RiverRoutePlanner(world, { maxVisited: 4096, nodeLimit: 16 });
  assert.deepEqual(tinyCache.route({ x: 128, z: 0 }), route);
});

test('unresolved inland routing never creates a square lake or a tile-edge outlet', () => {
  const planner = new RiverRoutePlanner({ _naturalHeight: () => 20 }, { maxVisited: 128 });
  const result = planner.route({ x: -4096, z: -4096 });
  assert.equal(result.status, 'retain-legacy');
  assert.equal(result.reason, 'outlet-search-budget');
  assert.equal(result.visited, 128);
  assert.equal(result.points, undefined);
});

test('exact crossing sources survive routing and identity does not round nearby anchors together', () => {
  const planner = new RiverRoutePlanner({ _naturalHeight: (x, z) => 8 - z * 0.02 + x * x * 0.0001 });
  const start = { x: 17.0001, z: 13.25, minY: 7, maxY: 7.5 };
  const route = planner.route(start);
  assert.equal(route.status, 'candidate');
  assert.equal(route.points[0].x, start.x);
  assert.equal(route.points[0].z, start.z);
  assert.ok(route.points[0].waterY >= start.minY && route.points[0].waterY <= start.maxY);
  assert.equal(new Set(route.points.map(point => point.id)).size, route.points.length);
  assert.notEqual(planner.route({ ...start, x: 17.0002 }).source, route.source);
  assert.deepEqual(planner.route(start), route);
  const ocean = new RiverRoutePlanner({ _naturalHeight: () => -2 }).route(start);
  assert.equal(ocean.reason, 'source-in-ocean');
  assert.equal(ocean.visited, 0);
});
