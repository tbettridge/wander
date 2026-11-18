// Villagers walk on what is drawn under them: not above it, not inside it.
//
// Three things put them wrong, and each has a check here.
//
// 1. A resident walking between villages (or across their own) took their
//    height by interpolating between the corners of the walk's plan. Corners
//    are tens of metres apart and the street between them is not straight, so
//    they floated over every dip and waded through every rise. Their height
//    must be the walkable surface at the spot they are on.
// 2. The stone plinth was drawn as a box of the footprint's largest half
//    extents, centred on the origin. A house with a wing on one side had stone
//    drawn out past the other side where nothing was claimed, and anyone
//    walking by stood on the grass beneath the stoop. The drawn plinth must be
//    the claimed one.
// 3. The plinth claim was level at the pad's height everywhere, while behind a
//    house on a slope the bank climbs over the rim and buries the stone. The
//    walkable surface must never be below the ground that is drawn there.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from '../src/railwayterrain.mjs';
import { clearStationSettlementCache, stationSettlements } from '../src/stationsettlement.mjs';
import { cachedSettlementPlan } from '../src/settlementspatial.mjs';
import {
  BUILDING_FLOOR_SURFACE, FOUNDATION_STEP_UP, plinthBox, plinthRect, pointInsideBuilding,
} from '../src/settlementplan.mjs';
import { buildingWorldPoint } from '../src/buildingplan.mjs';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import { groundSettlementNpc } from '../src/settlementnpcgrounding.mjs';
import { groundNpcWalkPoint, sampleNpcWalkSegments } from '../src/npcwalkground.mjs';

function railWorld(seed) {
  const world = new World(seed);
  const plan = planRegionalRailway(world, {
    center: { x: 0, z: 0 }, seed: world.seed ^ 0x5241494c,
    stationCount: 5, radius: 2600, searchRadius: 5200, exclusions: [],
  });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(plan));
  return world;
}

const VILLAGES = (() => {
  const out = [];
  for (const seed of [20260612, 1234]) {
    clearStationSettlementCache();
    const world = railWorld(seed);
    for (const site of stationSettlements(world, world.seed)) {
      const plan = cachedSettlementPlan(world, site);
      const surface = new WalkableSurface(world, { seed: world.seed });
      surface.debug = false;
      for (const claim of plan.claims) surface.registerClaim(claim);
      out.push({ world, plan, surface });
    }
  }
  return out;
})();

// The walk a regional resident takes through a village, as the game builds
// it: the village's own lanes, corner to corner, with each corner's planned
// height.
function laneWalks(plan) {
  return (plan.paths || []).filter((path) => (path.points || []).length >= 2).map((path) => {
    const points = path.points.map((point) => ({ ...point }));
    const segments = points.slice(1).map((point, index) => ({
      from: points[index], to: point,
      length: Math.hypot(point.x - points[index].x, (point.y ?? 0) - (points[index].y ?? 0), point.z - points[index].z),
    })).filter((segment) => segment.length > 1e-6);
    return { id: path.id, path: { segments, total: segments.reduce((sum, s) => sum + s.length, 0) },
      from: points[0], to: points.at(-1) };
  }).filter((walk) => walk.path.total > 1);
}

test('a walker on a village lane stands on the ground at every step, not on a chord between corners', () => {
  let steps = 0, chordOff = 0, worstChord = 0;
  for (const { plan, surface } of VILLAGES) {
    const groundAt = (x, z) => surface.groundAt(x, z);
    for (const walk of laneWalks(plan)) {
      const count = Math.max(4, Math.ceil(walk.path.total / 0.75));
      for (let i = 0; i <= count; i++) {
        const progress = i / count;
        const chord = sampleNpcWalkSegments(walk.path, progress, walk.from, walk.to);
        const point = sampleNpcWalkSegments(walk.path, progress, walk.from, walk.to, groundAt);
        const ground = surface.groundAt(point.x, point.z);
        steps++;
        assert.ok(Math.abs(point.y - ground) < 1e-9,
          `${walk.id}: at ${(progress * 100).toFixed(0)}% the walker is ${(point.y - ground).toFixed(2)}m off the ground`);
        const off = Math.abs(chord.y - ground);
        if (off > 0.1) chordOff++;
        worstChord = Math.max(worstChord, off);
      }
    }
  }
  assert.ok(steps > 2000, `too few steps walked (${steps})`);
  // The old way really was wrong, or this test proves nothing.
  assert.ok(chordOff / steps > 0.1 && worstChord > 1,
    `interpolating between corners was only off at ${chordOff}/${steps} steps (worst ${worstChord.toFixed(2)}m)`);
  console.log(`npcground: ${steps} lane steps on the ground; the corner-to-corner height was off by over 10cm at `
    + `${Math.round(100 * chordOff / steps)}% of them, worst ${worstChord.toFixed(1)}m`);
});

test('a walker over a dip follows it down and back up', () => {
  const dip = (x) => -1.2 * Math.exp(-((x - 10) ** 2) / 8);
  const path = { segments: [{ from: { x: 0, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 }, length: 20 }], total: 20 };
  const groundAt = (x) => dip(x);
  const middle = sampleNpcWalkSegments(path, 0.5, path.segments[0].from, path.segments[0].to, groundAt);
  assert.equal(middle.x, 10);
  assert.ok(Math.abs(middle.y - dip(10)) < 1e-9, `floated ${(middle.y - dip(10)).toFixed(2)}m over the dip`);
  // Past the end of the walk they are at its end, on the ground there.
  const end = sampleNpcWalkSegments(path, 1.2, path.segments[0].from, { x: 20, y: 5, z: 0 }, groundAt);
  assert.ok(Math.abs(end.y - dip(20)) < 1e-9);
});

test('a rider keeps the carriage floor, not the ground under the train', () => {
  const point = { x: 3, y: 12.5, z: 4, supportMatrix: new Array(16).fill(0) };
  groundNpcWalkPoint(point, () => 2);
  assert.equal(point.y, 12.5);
  const walker = groundNpcWalkPoint({ x: 3, y: 12.5, z: 4 }, () => 2);
  assert.equal(walker.y, 2);
});

test('the plinth that is drawn is the plinth that is claimed, wings and party walls included', () => {
  let buildings = 0, lopsided = 0;
  for (const { plan, surface } of VILLAGES) {
    for (const building of plan.buildings) {
      buildings++;
      const rect = plinthRect(building);
      const box = plinthBox(building);
      const fp = building.footprint;
      if (fp && Math.abs(fp.maxZ + fp.minZ) > 0.5) lopsided++;
      // Same rectangle, to the millimetre.
      assert.ok(Math.abs(box.x - box.width / 2 - rect.x0) < 1e-6 && Math.abs(box.x + box.width / 2 - rect.x1) < 1e-6,
        `${building.id}: drawn plinth spans x ${(box.x - box.width / 2).toFixed(2)}..${(box.x + box.width / 2).toFixed(2)}, claim ${rect.x0.toFixed(2)}..${rect.x1.toFixed(2)}`);
      assert.ok(Math.abs(box.z - box.depth / 2 - rect.z0) < 1e-6 && Math.abs(box.z + box.depth / 2 - rect.z1) < 1e-6,
        `${building.id}: drawn plinth spans z ${(box.z - box.depth / 2).toFixed(2)}..${(box.z + box.depth / 2).toFixed(2)}, claim ${rect.z0.toFixed(2)}..${rect.z1.toFixed(2)}`);
      // Its top is the pad's height in the world, lifted core or not: the root
      // it hangs from stands at building.y plus the core's lift.
      const top = building.y + box.coreLift + box.y + box.height / 2;
      assert.ok(Math.abs(top - (building.y + BUILDING_FLOOR_SURFACE)) < 1e-6,
        `${building.id}: drawn plinth top ${top.toFixed(3)} is not the pad at ${(building.y + BUILDING_FLOOR_SURFACE).toFixed(3)}`);
      // And the claim the walker resolves against covers exactly that box:
      // just inside each drawn edge is plinth, just outside is not this one.
      const claim = plan.claims.find((entry) => entry.id === `${building.id}:plinth`);
      assert.ok(claim, `${building.id} has no plinth claim`);
      const mx = (rect.x0 + rect.x1) / 2, mz = (rect.z0 + rect.z1) / 2;
      for (const [lx, lz] of [[rect.x0 + 0.05, mz], [rect.x1 - 0.05, mz], [mx, rect.z0 + 0.05], [mx, rect.z1 - 0.05]]) {
        const p = buildingWorldPoint(building, lx, lz);
        assert.ok(claim.contains(p.x, p.z), `${building.id}: drawn stone at (${lx.toFixed(2)}, ${lz.toFixed(2)}) is not claimed`);
      }
      for (const [lx, lz] of [[rect.x0 - 0.05, mz], [rect.x1 + 0.05, mz], [mx, rect.z0 - 0.05], [mx, rect.z1 + 0.05]]) {
        const p = buildingWorldPoint(building, lx, lz);
        assert.ok(!claim.contains(p.x, p.z), `${building.id}: claimed past its drawn edge at (${lx.toFixed(2)}, ${lz.toFixed(2)})`);
      }
      void surface;
    }
  }
  assert.ok(buildings > 400, `too few buildings (${buildings})`);
  // Lopsided footprints are where a centred box went wrong. If there were none
  // this would pass for the wrong reason.
  assert.ok(lopsided > 20, `only ${lopsided} lopsided footprints; this proves little`);
});

test('a resident walking round a house is never under the bank or under the stone', () => {
  let samples = 0, banked = 0;
  for (const { world, plan, surface } of VILLAGES) {
    for (const building of plan.buildings) {
      const rect = plinthRect(building);
      const padTop = building.y + BUILDING_FLOOR_SURFACE;
      for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) {
        // A hair inside the rim: exactly on it, rounding through world space
        // decides which side of the edge a sample falls.
        const lx = rect.x0 + 0.02 + (rect.x1 - rect.x0 - 0.04) * (i / 16);
        const lz = rect.z0 + 0.02 + (rect.z1 - rect.z0 - 0.04) * (j / 16);
        const p = buildingWorldPoint(building, lx, lz);
        if (pointInsideBuilding(building, p.x, p.z, 0)) continue;   // the room's floor
        const terrain = world.height(p.x, p.z);
        // A resident arriving from either side: off the bank, or off the pad.
        // Below a pad that stands higher than a step, the plinth is a wall
        // and collision keeps them out (settlementfoundations walks that).
        const arrivals = padTop - terrain > FOUNDATION_STEP_UP ? [padTop] : [terrain, padTop];
        for (const from of arrivals) {
          const position = { x: p.x, y: from, z: p.z };
          groundSettlementNpc(position, surface);
          // What is drawn here is the higher of the stone and the grass, and
          // nothing may be standing above them both. Another building's own
          // plinth or a doorstep may be higher still, which is fine: only
          // sinking below what is drawn is wrong here.
          const drawn = Math.max(terrain, padTop);
          samples++;
          assert.ok(position.y >= drawn - 1e-6,
            `${building.id}: at (${lx.toFixed(1)}, ${lz.toFixed(1)}) a resident stands ${(drawn - position.y).toFixed(2)}m inside `
            + `${terrain > padTop ? 'the bank' : 'the stone'}`);
          if (terrain > padTop + 0.1) banked++;
        }
      }
    }
  }
  assert.ok(samples > 50000, `too few samples (${samples})`);
  assert.ok(banked > 200, `only ${banked} samples under a bank; this proves little`);
});

test('inside the walls the pad stays the floor, whatever the hill does', () => {
  let checked = 0;
  for (const { world, plan, surface } of VILLAGES) {
    for (const building of plan.buildings) {
      const padTop = building.y + BUILDING_FLOOR_SURFACE;
      const claim = plan.claims.find((entry) => entry.id === `${building.id}:plinth`);
      const fp = building.footprint;
      for (const [lx, lz] of [[0, 0], [fp.minX + 0.3, fp.minZ + 0.3], [fp.maxX - 0.3, fp.maxZ - 0.3]]) {
        const p = buildingWorldPoint(building, lx, lz);
        if (!pointInsideBuilding(building, p.x, p.z, 0)) continue;
        assert.equal(claim.heightAt(p.x, p.z), padTop, `${building.id}: the floor moved with the terrain`);
        checked++;
      }
      void world; void surface;
    }
  }
  assert.ok(checked > 1000);
});

test('the game grounds regional walkers and draws the plinth it claims', async () => {
  const [main, stream] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/settlementstream.js', import.meta.url), 'utf8'),
  ]);
  // Every planned walk is sampled with a ground function.
  const calls = main.match(/sampleNpcWalkSegments\([^)]*\)/g) || [];
  assert.ok(calls.length >= 2, 'main.js no longer samples local walks');
  for (const call of calls) assert.match(call, /npcWalkGroundAt/, `ungrounded walk sample: ${call}`);
  assert.doesNotMatch(main, /^function sampleNpcWalkSegments/m, 'a second, ungrounded walk sampler is back in main.js');
  // A straight walk between two places is grounded as well.
  assert.match(main, /return groundNpcWalkPoint\(\{\s*x, y: from\.y \+ \(to\.y - from\.y\) \* t, z,/);
  // The renderer takes its plinth from the plan.
  assert.match(stream, /const plinth = plinthBox\(building\);/);
  assert.doesNotMatch(stream, /fp\.halfWidth \* 2 \+ marginLeft/);
});
