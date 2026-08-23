import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/world.js';
import { fortifiedOutpostsAround } from '../src/landmarks.js';
import { createFortifiedOutpostPlan, transformFortifiedOutpostPlan } from '../src/fortifiedoutpost.mjs';
import { StructureCollisionIndex, PLAYER_STRUCTURE_RADIUS } from '../src/structurecollision.mjs';
import { registerFortifiedOutpostRuntime } from '../src/fortifiedoutpostruntime.mjs';
import { undercroftSitingFor, keepUndercroftAnchor } from '../src/keepdungeonanchor.mjs';

const world = new World(1337);

function keepsWithUndercrofts(limit = 14) {
  const sites = [];
  // A keep is one site in four, and only about half of those sit on ground
  // that will take an undercroft, so the net has to be cast wide.
  fortifiedOutpostsAround(world, 0, 0, world.seed, 150000, sites);
  const out = [];
  for (const entry of sites) {
    if (entry.tier !== 'keep') continue;
    const siting = undercroftSitingFor(world, entry);
    const local = createFortifiedOutpostPlan(entry.outpostSeed, {
      undercroftBearing: siting.bearing, undercroftReach: siting.reach,
    });
    const anchor = keepUndercroftAnchor(world, entry, local);
    if (!anchor) continue;
    out.push({ entry, local, anchor });
    if (out.length >= limit) break;
  }
  return out;
}

// The complaint this exists for: the passage runs under the curtain wall, but
// the wall's collider spanned from the bailey's foundation upward, so it was
// solid across the only way in. You could see the door and not use it.
test('you can walk in at the undercroft door and on under the wall above it', () => {
  const keeps = keepsWithUndercrofts();
  assert.ok(keeps.length >= 6, `only ${keeps.length} keeps with an undercroft to test`);
  for (const { entry, local, anchor } of keeps) {
    const plan = transformFortifiedOutpostPlan(local, {
      x: entry.x, y: entry.y, z: entry.z, yaw: entry.yaw,
    });
    const collision = new StructureCollisionIndex();
    const release = registerFortifiedOutpostRuntime({ plan, collisionIndex: collision });
    const blocked = [];
    // From standing in the bailey, through the doorway, and on out under
    // whatever is above the passage.
    for (let along = -5; along <= 14; along += 0.4) {
      const x = anchor.x + anchor.inwardX * along;
      const z = anchor.z + anchor.inwardZ * along;
      const ground = world.height(x, z);
      for (const overFloor of [0.4, 1.1, 1.8]) {
        const hit = collision.collides(x, z, ground - 0.5 + overFloor, PLAYER_STRUCTURE_RADIUS);
        if (hit) blocked.push(`${hit.sourcePieceId || hit.id} at ${along.toFixed(1)}m, ${overFloor}m up`);
      }
    }
    release();
    assert.equal(blocked.length, 0,
      `${entry.key}: ${[...new Set(blocked)].slice(0, 4).join(' · ')}`);
  }
});

test('the doorway is tall enough to walk through, and its own jambs frame it', () => {
  for (const { local } of keepsWithUndercrofts(8)) {
    const door = local.intact.undercroft;
    // A body needs roughly two metres; anything less and you are crouching
    // through a hole rather than walking through a door.
    assert.ok(door.height >= 2.9, `door only ${door.height}m tall`);
    assert.ok(door.width >= 2.4, `door only ${door.width}m wide`);
    const jambs = local.collisionProxies.filter((p) => p.sourcePieceId === door.id);
    assert.equal(jambs.length, 2, 'a doorway has two jambs');
    // ...and they stand clear of the opening rather than across it.
    for (const jamb of jambs) {
      const midX = (jamb.ax + jamb.bx) / 2, midZ = (jamb.az + jamb.bz) / 2;
      const offset = Math.hypot(midX - door.x, midZ - door.z);
      assert.ok(offset >= door.width / 2, `jamb ${offset.toFixed(2)}m from centre`);
    }
  }
});

console.log('keepundercroft PASS · walk in at the door · nothing solid over the passage');
