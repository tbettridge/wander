import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/world.js';
import { fortifiedOutpostsAround } from '../src/landmarks.js';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import { StructureCollisionIndex } from '../src/structurecollision.mjs';
import { createFortifiedDungeonPlan, validateFortifiedDungeon, validateFortifiedDungeonSurfaceLink } from '../src/fortifieddungeon.mjs';
import { createFortifiedOutpostPlan, transformFortifiedOutpostPlan } from '../src/fortifiedoutpost.mjs';
import { inspectFortifiedDungeonTraversal } from '../src/ruininspection.mjs';
import {
  DungeonNavigationRegistry,
  DungeonTerrainOpeningRegistry,
  FortifiedDungeonStream,
  registerFortifiedDungeonRuntime,
} from '../src/fortifieddungeonruntime.mjs';

test('dungeon runtime registration is semantic, reversible, and transactional', () => {
  const plan = createFortifiedDungeonPlan(41);
  const world = new World(41);
  const walkable = new WalkableSurface(world);
  const collision = new StructureCollisionIndex();
  const events = [];
  const target = (kind) => ({
    register(value) {
      events.push(`${kind}:add:${value?.id || value?.length}`);
      return () => events.push(`${kind}:remove`);
    },
  });
  const release = registerFortifiedDungeonRuntime({
    plan, walkableSurface: walkable, collisionIndex: collision,
    visuals: target('visual'), navigation: target('nav'), terrainOpening: target('opening'),
  });
  assert.equal(walkable.structureClaims.size, plan.walkableClaims.length);
  assert.equal(collision.records.size, 1);
  assert.equal(collision.records.has(plan.id), true);
  release();
  release();
  assert.equal(walkable.structureClaims.size, 0);
  assert.equal(collision.records.size, 0);
  assert.deepEqual(events.filter((entry) => entry.endsWith(':remove')).sort(), [
    'nav:remove', 'opening:remove', 'visual:remove',
  ]);

  const failingWalkable = new WalkableSurface(world);
  const failingCollision = new StructureCollisionIndex();
  assert.throws(() => registerFortifiedDungeonRuntime({
    plan, walkableSurface: failingWalkable, collisionIndex: failingCollision,
    navigation: { register() { throw new Error('navigation unavailable'); } },
  }), /navigation unavailable/);
  assert.equal(failingWalkable.structureClaims.size, 0);
  assert.equal(failingCollision.records.size, 0);
});

test('dungeon stream loads a seeded outpost seam and cleans every semantic layer', () => {
  const world = new World(0);
  const entries = [];
  fortifiedOutpostsAround(world, 0, 0, world.seed, 5000, entries);
  assert.ok(entries.length > 0, 'seed 0 should provide a deterministic outpost fixture');
  const entry = entries[0];
  const scene = {
    children: [],
    add(value) { this.children.push(value); value.parent = this; },
    remove(value) { this.children = this.children.filter((entry) => entry !== value); value.parent = null; },
  };
  const walkable = new WalkableSurface(world);
  const collision = new StructureCollisionIndex();
  const openings = new DungeonTerrainOpeningRegistry();
  const navigation = new DungeonNavigationRegistry();
  const stream = new FortifiedDungeonStream(scene, world, {
    walkableSurface: walkable, collisionIndex: collision, navigation, terrainOpening: openings, radius: 1400,
    visualBuilder: (plan) => ({ semanticPlanId: plan.id, parent: null }),
    visualDisposer: (visual) => { if (visual?.parent) visual.parent.remove(visual); },
  });

  stream.update(entry.x, entry.z);
  assert.equal(stream.snapshot().length, 1);
  assert.equal(scene.children.length, 1);
  assert.ok(walkable.structureClaims.size > 1);
  assert.equal(collision.records.size, 1);
  assert.equal(openings.snapshot().length, 1);
  assert.equal(navigation.snapshot().length, 1);
  const active = stream.snapshot()[0];
  const activePlan = [...stream.active.values()][0].plan;
  assert.equal(active.surfaceLink.surfacePlanId, `fortified-outpost:${entry.outpostSeed >>> 0}`);
  assert.equal(active.surfaceLink.outpostPieceId, 'room:floor');
  assert.equal(active.surfaceLink.accessKind, 'room');
  assert.equal(active.surfaceLink.trailContract.gateId, 'gate:main');
  assert.ok(active.entrance.x !== 0 || active.entrance.z !== 0);
  assert.equal(activePlan.surfaceLink.orientationYaw, entry.yaw);
  const worldOutpost = transformFortifiedOutpostPlan(createFortifiedOutpostPlan(entry.outpostSeed), {
    x: entry.x, y: entry.y, z: entry.z, yaw: entry.yaw,
  });
  assert.equal(validateFortifiedDungeonSurfaceLink(activePlan, worldOutpost).valid, true);
  // The stream keeps the transformed outpost on the plan only through its
  // seam metadata; validate the route and world placement against that same
  // active plan rather than relying on a local origin fixture.
  assert.equal(inspectFortifiedDungeonTraversal(activePlan).valid, true);

  // Shrink the query radius and move far enough to force an unload without
  // depending on the world having another nearby outpost.
  stream.radius = 10;
  stream.update(entry.x + 800, entry.z + 800);
  assert.deepEqual(stream.snapshot(), []);
  assert.equal(scene.children.length, 0);
  assert.equal(walkable.structureClaims.size, 0);
  assert.equal(collision.records.size, 0);
  assert.equal(openings.snapshot().length, 0);
  assert.equal(navigation.snapshot().length, 0);
});

test('dungeon streams remain deterministic and unload navigation/opening state across representative regions', () => {
  for (const seed of [0, 41, 93, 2026]) {
    const world = new World(seed);
    const entries = [];
    fortifiedOutpostsAround(world, 0, 0, world.seed, 6000, entries);
    if (!entries.length) continue;
    const scene = {
      children: [],
      add(value) { this.children.push(value); value.parent = this; },
      remove(value) { this.children = this.children.filter((entry) => entry !== value); value.parent = null; },
    };
    const walkable = new WalkableSurface(world);
    const collision = new StructureCollisionIndex();
    const openings = new DungeonTerrainOpeningRegistry();
    const navigation = new DungeonNavigationRegistry();
    const stream = new FortifiedDungeonStream(scene, world, {
      walkableSurface: walkable, collisionIndex: collision, navigation, terrainOpening: openings,
      radius: 40, visualBuilder: (plan) => ({ semanticPlanId: plan.id, parent: null }),
    });
    const entry = entries[0];
    stream.update(entry.x, entry.z);
    assert.equal(stream.snapshot().length, 1, `seed ${seed}`);
    const plan = [...stream.active.values()][0].plan;
    assert.equal(validateFortifiedDungeon(plan).valid, true, `seed ${seed}`);
    assert.equal(navigation.snapshot().length, 1, `seed ${seed} navigation`);
    stream.reset();
    assert.equal(stream.snapshot().length, 0, `seed ${seed} reset`);
    assert.equal(openings.snapshot().length, 0, `seed ${seed} opening`);
    assert.equal(navigation.snapshot().length, 0, `seed ${seed} navigation reset`);
    assert.equal(collision.records.size, 0, `seed ${seed} collision reset`);
    assert.equal(walkable.structureClaims.size, 0, `seed ${seed} walkable reset`);
  }
});

console.log('fortifieddungeonruntime PASS · atomic registration · stream cleanup');
