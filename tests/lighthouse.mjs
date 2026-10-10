import test from 'node:test';
import assert from 'node:assert/strict';
import { createLighthousePlan, lighthouseWorldPoint, lighthouseLocalPoint, lighthouseWalkableClaims,
  lighthouseCollisionSegments, lighthouseGalleryContains } from '../src/lighthouseplan.mjs';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import { StructureCollisionIndex } from '../src/structurecollision.mjs';
import { planInterior } from '../src/interiorplan.mjs';

const make = (height = 26, yaw = 0, ground = () => 0) => createLighthousePlan({ key: `lighthouse:${height}:${yaw}`,
  seed: 4, towerH: height, x: 210, y: 8, z: -340, yaw }, ground);
function runtime(plan, ground = () => 0) {
  const world = { seed: 1, height: (x, z) => { const p = lighthouseLocalPoint(plan, { x, y: 0, z }); return ground(p.x, p.z) + plan.y; } };
  const surface = new WalkableSurface(world, { trailsAround: () => [] }), collision = new StructureCollisionIndex();
  const releaseSurface = surface.registerClaims(lighthouseWalkableClaims(plan));
  const releaseCollision = collision.registerSemanticPlan({ id: plan.id, buildings: plan.buildings, collisionRecipes: lighthouseCollisionSegments(plan) });
  return { surface, collision, release() { releaseSurface(); releaseCollision(); } };
}

test('lighthouse preserves the original lamp centre even on sloped, rotated terrain', () => {
  for (const height of [22, 26, 32, 38]) {
    const ground = (x, z) => x * .13 + z * .06, p = make(height, 1.7, ground), r = Math.max(2.9, height * .13);
    let min = ground(0, 0);
    for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; min = Math.min(min, ground(Math.cos(a) * (r + 1.4), Math.sin(a) * (r + 1.4))); }
    assert.ok(Math.abs(p.lampY - (min - 1.3 + 2.6 + height + .55 + 1)) < 1e-9);
    assert.equal(p.legacyTopRadius, r * .6);
    assert.ok(p.stairs.every(s => s.outerR - s.innerR > 1.3));
    assert.ok(p.rise <= .16);
    assert.ok(p.pitch - .1 > 2.1);
    const world = lighthouseWorldPoint(p, -2, 5, 3), local = lighthouseLocalPoint(p, world);
    assert.ok(Math.hypot(local.x + 2, local.y - 5, local.z - 3) < 1e-9);
  }
});

test('keeper house furnishings leave its front, partitions and tower connection traversable', () => {
  for (const yaw of [0, .7, 2.4]) {
    const p = make(26, yaw), { surface, collision, release } = runtime(p), furniture = planInterior(p.worldHouse);
    const roofs = collision.collectRainCovers();
    assert.equal(roofs.length, 1);
    assert.ok(Math.hypot(roofs[0].x - p.worldHouse.x, roofs[0].z - p.worldHouse.z) < 1e-9);
    assert.ok(furniture.placements.some(p => p.assetId === 'bed'));
    assert.ok(furniture.placements.some(p => p.assetId === 'hearth'));
    assert.ok(furniture.placements.some(p => p.assetId === 'table'));
    const h = p.house;
    for (let x = h.x - h.depth / 2 - .1; x < -p.baseRadius + .3; x += .05) {
      const point = lighthouseWorldPoint(p, x, p.floorY, 0);
      assert.equal(collision.collides(point.x, point.z, point.y), null, `doorway/corridor at ${x}`);
      assert.ok(Math.abs(surface.heightAt(point.x, point.z, point.y) - point.y) < 1e-9);
    }
    release();
  }
});

test('every spiral turn can be climbed and descended without snapping to overhead turns or the gallery', () => {
  for (const height of [22, 26, 32]) for (const yaw of [0, 1.2]) {
    const p = make(height, yaw), { surface, collision, release } = runtime(p);
    const samples = [];
    for (const step of p.stairs) for (const t of [.15, .5, .85]) {
      const angle = step.a0 + (step.a1 - step.a0) * t, r = step.outerR - .5;
      samples.push({ point: lighthouseWorldPoint(p, Math.cos(angle) * r, step.y, Math.sin(angle) * r), step });
    }
    for (const ordered of [samples, [...samples].reverse()]) {
      let previous = { ...ordered[0].point };
      for (const { point, step } of ordered) {
        const position = { ...point, y: previous.y };
        collision.resolveMovement(position, previous);
        assert.ok(Math.hypot(position.x - point.x, position.z - point.z) < .015, `blocked at ${step.id}`);
        const y = surface.heightAt(position.x, position.z, previous.y);
        assert.ok(Math.abs(y - point.y) < .001, `incorrect support at ${step.id}: ${y} vs ${point.y}`);
        previous = { ...position, y };
      }
    }
    release();
  }
});

test('gallery guards the lamp, perimeter and stairwell while leaving the stair exit open', () => {
  const p = make(), { surface, collision, release } = runtime(p), last = p.stairs.at(-1);
  const r = last.outerR - .5, a = p.stairEndAngle + .14;
  assert.ok(lighthouseGalleryContains(p, Math.cos(a) * r, Math.sin(a) * r));
  const exit = lighthouseWorldPoint(p, Math.cos(a) * r, p.galleryY, Math.sin(a) * r);
  assert.equal(collision.collides(exit.x, exit.z, exit.y), null);
  assert.equal(surface.heightAt(exit.x, exit.z, exit.y), exit.y);
  for (let i = 0; i < 64; i++) {
    const a = i / 64 * Math.PI * 2, r = p.galleryRadius - .1;
    const edge = lighthouseWorldPoint(p, Math.cos(a) * r, p.galleryY, Math.sin(a) * r);
    assert.ok(collision.collides(edge.x, edge.z, edge.y), 'outer railing has a collision gap');
  }
  release();
  assert.equal(surface.structureClaims.size, 0);
  assert.equal(collision.records.size, 0);
});
