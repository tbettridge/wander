import assert from 'node:assert/strict';
import test from 'node:test';
import { findWatershedViewpoints, watershedSightlineClear } from '../src/watershedviewpoints.mjs';

test('a ridge blocks a water sightline even when both endpoints are visible terrain', () => {
  const eye = { x: 0, y: 20, z: 0 }, target = { x: 100, y: 1, z: 0 };
  assert.equal(watershedSightlineClear(() => 0, eye, target, 4), true);
  assert.equal(watershedSightlineClear(x => x > 40 && x < 60 ? 40 : 0, eye, target, 4), false);
});

test('inspection positions use actual dry ground and remain deterministic', async () => {
  const world = {
    height: (x, z) => Math.hypot(x, z) * 0.1,
    riverAt: (x, z) => ({ wet: Math.hypot(x, z) < 8, y: 0 }),
  };
  let yields = 0;
  const options = { radii: [100, 200], angles: 8, yieldTask: async () => { yields++; } };
  const a = await findWatershedViewpoints(world, { x: 0, z: 0 }, options);
  const b = await findWatershedViewpoints(world, { x: 0, z: 0 }, options);
  assert.deepEqual(a, b);
  assert.ok(a.overlook && a.bank && yields > 0);
  for (const point of [a.overlook, a.bank]) {
    assert.equal(world.riverAt(point.x, point.z).wet, false);
    assert.equal(point.y, world.height(point.x, point.z) + 1.7);
  }
  assert.equal(a.routeKind, 'inspection-flight');
});

test('unsuitable terrain reports no overlook rather than inventing a summit', async () => {
  const world = { height: () => 0, riverAt: () => ({ wet: true, y: 1 }) };
  const views = await findWatershedViewpoints(world, { x: 0, z: 0 }, {
    radii: [100], angles: 4, yieldTask: async () => {},
  });
  assert.equal(views.overlook, null);
  assert.equal(views.bank, null);
});

test('cancelled viewpoint searches stop before publishing positions', async () => {
  const controller = new AbortController();
  const world = { height: () => 10, riverAt: () => ({ wet: false, y: 0 }) };
  await assert.rejects(findWatershedViewpoints(world, { x: 0, z: 0 }, {
    signal: controller.signal, yieldTask: async () => controller.abort(),
  }), /cancelled/);
});
