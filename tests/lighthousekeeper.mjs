import test from 'node:test';
import assert from 'node:assert/strict';
import { createLighthousePlan, lighthouseLocalPoint, lighthouseWalkableClaims, lighthouseCollisionSegments,
  lighthouseStairRoute, lighthouseOnGallery } from '../src/lighthouseplan.mjs';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import { StructureCollisionIndex } from '../src/structurecollision.mjs';
import { buildingWorldPoint } from '../src/buildingplan.mjs';

const make = (height = 26, yaw = 0, ground = () => 0) => createLighthousePlan({ key: `lighthouse:${height}:${yaw}`,
  seed: 4, towerH: height, x: 210, y: 8, z: -340, yaw }, ground);
function runtime(plan, ground = () => 0) {
  const world = { seed: 1, height: (x, z) => { const p = lighthouseLocalPoint(plan, { x, y: 0, z }); return ground(p.x, p.z) + plan.y; } };
  const surface = new WalkableSurface(world, { trailsAround: () => [] }), collision = new StructureCollisionIndex();
  const releaseSurface = surface.registerClaims(lighthouseWalkableClaims(plan));
  const releaseCollision = collision.registerSemanticPlan({ id: plan.id, buildings: plan.buildings, collisionRecipes: lighthouseCollisionSegments(plan) });
  return { surface, collision, release() { releaseSurface(); releaseCollision(); } };
}
// A resident's legs: steer straight at each waypoint in small steps, pushed off walls at
// their own radius, standing on whatever floor is under them up to a stride above.
function walk(points, start, { surface, collision }) {
  const at = { ...start };
  let blocked = 0;
  for (const target of points) {
    for (let guard = 0; guard < 4000; guard++) {
      const dx = target.x - at.x, dz = target.z - at.z, d = Math.hypot(dx, dz);
      if (d < 0.06) break;
      const step = Math.min(0.05, d), next = { x: at.x + dx / d * step, y: at.y, z: at.z + dz / d * step };
      collision.resolveMovement(next, at, 0.29);
      if (Math.hypot(next.x - at.x, next.z - at.z) < step * 0.2) { blocked++; break; }
      next.y = surface.groundAt(next.x, next.z, at.y + 0.8);
      assert.ok(next.y - at.y < 0.5, 'a step up of ' + (next.y - at.y).toFixed(2) + ' m');
      Object.assign(at, next);
    }
  }
  return { at, blocked };
}

test('the keeper climbs from the house through the back door to the gallery, and back down, without sticking or floating', () => {
  for (const height of [22, 26, 32]) for (const yaw of [0, 1.2, 2.9]) {
    const plan = make(height, yaw), rt = runtime(plan), house = plan.worldHouse;
    const route = lighthouseStairRoute(plan);
    const back = house.portals.find(portal => portal.kind === 'back-door');
    const inside = buildingWorldPoint(house, back.x, -house.depth / 2 + 0.8), outside = buildingWorldPoint(house, back.x, -house.depth / 2 - 0.95);
    const start = { x: inside.x, y: plan.y + plan.floorY, z: inside.z };
    const up = walk([outside, ...route.points, route.watch], start, rt);
    assert.equal(up.blocked, 0, `blocked on the way up (${height} m, yaw ${yaw})`);
    assert.ok(lighthouseOnGallery(plan, up.at), `ends on the gallery (${height} m, yaw ${yaw}): y ${up.at.y.toFixed(2)}`);
    assert.ok(Math.abs(up.at.y - (plan.y + plan.galleryY)) < 0.05);
    const down = walk([...route.points].reverse().concat([outside, inside]), up.at, rt);
    assert.equal(down.blocked, 0, `blocked on the way down (${height} m, yaw ${yaw})`);
    assert.ok(Math.abs(down.at.y - (plan.y + plan.floorY)) < 0.05, 'back on the ground floor');
    rt.release();
  }
});
