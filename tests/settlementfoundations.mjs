// Standing on the plot, not falling through it.
//
// A building sits on a pad. On sloping ground that pad is raised, and two
// separate things then have to be true: it has to reach down far enough to
// actually be in the earth, and its surface has to be something the player can
// stand on. Neither was true. The pad was sized from a sample of the CORE while
// being drawn over the whole footprint, so its downhill rim hung in the air;
// and the walkable claim covered the core alone, so the visible stone around
// the walls was terrain height underneath and the player dropped through it.
//
// Nearly half the buildings in a station village stand raised, so this was not
// an edge case.

import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from '../src/railwayterrain.mjs';
import { clearStationSettlementCache, stationSettlements } from '../src/stationsettlement.mjs';
import { cachedSettlementPlan } from '../src/settlementspatial.mjs';
import {
  BUILDING_FLOOR_SURFACE, FOUNDATION_MARGIN, FOUNDATION_STEP_UP, doorstepBlocks, portalWorldPoint,
} from '../src/settlementplan.mjs';
import { buildingWorldPoint } from '../src/buildingplan.mjs';
import { PLAYER_STRUCTURE_RADIUS, StructureCollisionIndex } from '../src/structurecollision.mjs';
import { WalkableSurface } from '../src/walkablesurface.mjs';

// One surface per plan, so the walk below stands on what the game would.
//
// Keyed by WORLD as well as plan: settlement ids are per-world and collide
// across seeds, so a cache on plan.id alone hands the second world the first
// world's claims, at the first world's terrain heights.
const SURFACES = new Map();
function surfaceForPlanIn(world, plan) {
  const key = `${world.seed}:${plan.id}`;
  let surface = SURFACES.get(key);
  if (!surface) {
    surface = new WalkableSurface(world, { seed: world.seed });
    for (const claim of plan.claims) surface.registerClaim(claim);
    SURFACES.set(key, surface);
  }
  return surface;
}

function railWorld(seed) {
  const world = new World(seed);
  const plan = planRegionalRailway(world, {
    center: { x: 0, z: 0 }, seed: world.seed ^ 0x5241494c,
    stationCount: 5, radius: 2600, searchRadius: 5200, exclusions: [],
  });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(plan));
  return world;
}

/** The lowest ground anywhere under a building's pad, sampled independently. */
function lowestUnderPad(world, building, steps = 10) {
  const fp = building.footprint;
  const x0 = fp.minX - FOUNDATION_MARGIN, x1 = fp.maxX + FOUNDATION_MARGIN;
  const z0 = fp.minZ - FOUNDATION_MARGIN, z1 = fp.maxZ + FOUNDATION_MARGIN;
  let lowest = Infinity;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lx = x0 + (x1 - x0) * t, lz = z0 + (z1 - z0) * t;
    for (const [px, pz] of [[lx, z0], [lx, z1], [x0, lz], [x1, lz]]) {
      const point = buildingWorldPoint(building, px, pz);
      lowest = Math.min(lowest, world.height(point.x, point.z));
    }
  }
  return lowest;
}

// --- no pad hangs in the air -------------------------------------------------------
// Sampled more densely here than the planner samples when sizing the pad, so
// this is an independent check rather than a restatement of the same arithmetic.
{
  let buildings = 0, raised = 0, floating = 0, worstGap = 0;
  for (const seed of [20260612, 1234, 99887, 555, 42]) {
    clearStationSettlementCache();
    const world = railWorld(seed);
    for (const site of stationSettlements(world, world.seed)) {
      for (const building of cachedSettlementPlan(world, site).buildings) {
        buildings++;
        const top = building.y + BUILDING_FLOOR_SURFACE;
        const bottom = top - building.foundationDepth;
        const lowest = lowestUnderPad(world, building);
        if (top - lowest > FOUNDATION_STEP_UP) raised++;
        const gap = bottom - lowest;
        if (gap > 0) { floating++; worstGap = Math.max(worstGap, gap); }
      }
    }
  }
  assert.ok(buildings > 400, `too few buildings sampled (${buildings})`);
  // The fix only matters because raised plots are common. If they were rare the
  // assertion below would be passing for the wrong reason.
  assert.ok(raised / buildings > 0.2,
    `only ${Math.round(100 * raised / buildings)}% of plots are raised; this proves little`);
  assert.equal(floating, 0,
    `${floating} pads hang above the ground, worst by ${worstGap.toFixed(2)}m`);
}

// --- the plot surface is what you stand on -------------------------------------------
// The claim must cover what the renderer draws: the footprint plus its margin.
{
  clearStationSettlementCache();
  const world = railWorld(20260612);
  const site = stationSettlements(world, world.seed).find((v) => v.kind === 'station-village');
  const plan = cachedSettlementPlan(world, site);
  let checked = 0;
  for (const building of plan.buildings) {
    const claim = plan.claims.find((entry) => entry.buildingId === building.id);
    assert.ok(claim, `${building.id} has no floor claim`);
    const fp = building.footprint;
    // A point just inside the pad's rim, on each side, in the building's frame.
    for (const [lx, lz] of [
      [fp.maxX + FOUNDATION_MARGIN - 0.1, 0], [fp.minX - FOUNDATION_MARGIN + 0.1, 0],
      [0, fp.maxZ + FOUNDATION_MARGIN - 0.1], [0, fp.minZ - FOUNDATION_MARGIN + 0.1],
    ]) {
      const point = buildingWorldPoint(building, lx, lz);
      assert.ok(claim.contains(point.x, point.z),
        `${building.id}: the pad rim at (${lx.toFixed(1)}, ${lz.toFixed(1)}) is not standable`);
      checked++;
    }
    // And well outside it is not claimed, or every building would pave its lane.
    const beyond = buildingWorldPoint(building, fp.maxX + FOUNDATION_MARGIN + 3, 0);
    assert.ok(!claim.contains(beyond.x, beyond.z),
      `${building.id}: the claim reaches past its own pad`);
  }
  assert.ok(checked > 100, `too few rim samples (${checked})`);
}

// --- a high plot is a wall, a low one is a step ------------------------------------------
// Gathered across seeds rather than from one village: whether a given village
// happens to stand on a slope is the world's business, and a test that assumed
// it did was passing on luck.
{
  const standing = (b) => b.y + BUILDING_FLOOR_SURFACE - b.padMinTerrain;
  let tallChecked = 0, lowChecked = 0, capChecked = 0, doorChecked = 0;
  for (const seed of [20260612, 1234, 99887, 555, 42]) {
    clearStationSettlementCache();
    const world = railWorld(seed);
    for (const site of stationSettlements(world, world.seed)) {
      const plan = cachedSettlementPlan(world, site);
      const index = new StructureCollisionIndex(() => ({ portals: {} }));
      index.registerPlan(plan);
      const segments = index.records.get(plan.id).staticSegments;
      const sides = (building) => segments.filter((s) => s.id.startsWith(`${building.id}:foundation:`));
      for (const building of plan.buildings) {
        const height = standing(building);
        if (height > FOUNDATION_STEP_UP + 0.15) {
          // Three faces are a bank you should not climb; the fourth is split
          // either side of the doorway, which is why this is five and not four.
          assert.equal(sides(building).length, 5,
            `${building.id} stands ${height.toFixed(2)}m proud and needs sides`);
          tallChecked++;
          // AND THE GAP IS REAL. The ring used to close all the way round, so
          // on a raised plot a walker was stopped a metre short of their own
          // doorstep by the earth it stands on — every door on a bank in the
          // world was unreachable. Walking the door's own axis has to reach the
          // threshold; only the closed leaf may stop it.
          if (doorChecked < 40) {
            const door = building.portals.find((portal) => portal.kind === 'exterior-door');
            const mouth = portalWorldPoint(building, door);
            const nx = Math.sin(building.yaw), nz = Math.cos(building.yaw);
            let stopped = null;
            for (let t = 6; t >= PLAYER_STRUCTURE_RADIUS; t -= 0.1) {
              const x = mouth.x + nx * t, z = mouth.z + nz * t;
              const ground = world.height(x, z);
              const claim = surfaceForPlanIn(world, plan).structureAt(x, z, ground);
              const y = claim ? Math.max(ground, claim.y) : ground;
              if (index.collides(x, z, y, PLAYER_STRUCTURE_RADIUS)) { stopped = t; break; }
            }
            assert.ok(stopped === null || stopped <= PLAYER_STRUCTURE_RADIUS + 0.12,
              `${building.id}: walled out of its own doorway `
              + `${stopped === null ? '' : stopped.toFixed(1)}m short`);
            doorChecked++;
          }
          // The sides stop at the plot surface, so being above it frees you to
          // walk on rather than being fenced out of your own doorway.
          if (capChecked < 12) {
            for (const side of sides(building)) {
              assert.ok(side.maxY <= building.y + BUILDING_FLOOR_SURFACE + 1e-6,
                `${building.id}: foundation wall rises above the surface it protects`);
            }
            capChecked++;
          }
        } else if (height < FOUNDATION_STEP_UP - 0.15) {
          assert.equal(sides(building).length, 0,
            `${building.id} is a step up; walling it would block its own front door`);
          lowChecked++;
        }
      }
    }
  }
  assert.ok(tallChecked > 30, `too few raised plots to be meaningful (${tallChecked})`);
  assert.ok(lowChecked > 30, `too few flat plots to be meaningful (${lowChecked})`);
}

console.log('settlement foundations ok');


// --- you can walk right round a building on its own plinth ---------------------------
//
// The ask this was written for: step up onto the plot, follow the wall round it,
// and go in at the door. Two things stopped that. The plinth was drawn at half
// the width the claim and the collision walls used, so a quarter-metre of
// walkable, collidable ledge hung over open air the whole way round. And what
// ledge there was measured 0.5 m against a walker who is pushed 0.34 m off any
// wall they touch, leaving a 0.16 m band to stand in — technically standable,
// and in practice you slid off it and dropped to the terrain.
{
  const laps = { total: 0, clean: 0, offClaim: 0, blocked: 0 };
  for (const seed of [20260612, 99887, 42]) {
    clearStationSettlementCache();
    const world = railWorld(seed);
    for (const site of stationSettlements(world, world.seed)) {
      const plan = cachedSettlementPlan(world, site);
      const surface = surfaceForPlanIn(world, plan);
      for (const building of plan.buildings) {
        // Only this building's own collision. A neighbour standing close enough
        // to block part of the lap is a fact about how tight the village is,
        // not about whether the plinth is walkable, and mixing the two makes the
        // test fail for a reason it was not written to catch.
        const index = new StructureCollisionIndex(() => ({ portals: {} }));
        index.registerPlan({ ...plan, buildings: [building], props: [] });
        const fp = building.footprint;
        const padTop = building.y + BUILDING_FLOOR_SURFACE;
        const c = Math.cos(building.yaw), s2 = Math.sin(building.yaw);
        // Where a walker can actually be, not the geometric middle of the
        // ledge. Collision holds them PLAYER_STRUCTURE_RADIUS off the wall, so
        // on a narrow plinth the midline is inside the wall's push-out and
        // sampling it tests a place nobody can stand.
        const band = [PLAYER_STRUCTURE_RADIUS, FOUNDATION_MARGIN];
        assert.ok(band[1] - band[0] > 0.12,
          `a ${FOUNDATION_MARGIN}m plinth leaves a ${(band[1] - band[0]).toFixed(2)}m band `
          + `for a ${PLAYER_STRUCTURE_RADIUS}m walker — the perimeter is no longer walkable`);
        const mid = (band[0] + band[1]) / 2;
        // The real rectangle, offset outward by half the ledge. The footprint is
        // asymmetric — a rear wing moves minZ and leaves maxZ alone — so a
        // circle at halfWidth walks off the claim on the side with no wing and
        // reports a fault that belongs to the circle.
        const x0 = fp.minX - mid, x1 = fp.maxX + mid;
        const z0 = fp.minZ - mid, z1 = fp.maxZ + mid;
        const perimeter = 2 * ((x1 - x0) + (z1 - z0));
        laps.total++;
        let lost = 0, hit = 0;
        for (let i = 0; i < 72; i++) {
          let d = (i / 72) * perimeter, lx, lz;
          if (d < x1 - x0) { lx = x0 + d; lz = z0; }
          else if ((d -= x1 - x0) < z1 - z0) { lx = x1; lz = z0 + d; }
          else if ((d -= z1 - z0) < x1 - x0) { lx = x1 - d; lz = z1; }
          else { lz = z1 - (d - (x1 - x0)); lx = x0; }
          const x = building.x + lx * c + lz * s2, z = building.z - lx * s2 + lz * c;
          const claim = surface.structureAt(x, z, padTop);
          // A granary's own floor stands clear of its plinth on staddle stones,
          // so at its doorway the surface is legitimately the step up into it.
          if (!claim) lost++;
          else if (Math.abs(claim.y - padTop) > 0.35 && !claim.id.endsWith(':floor-step')) lost++;
          if (index.collides(x, z, padTop, PLAYER_STRUCTURE_RADIUS)) hit++;
        }
        if (lost) laps.offClaim++;
        if (hit) laps.blocked++;
        if (!lost && !hit) laps.clean++;
        assert.equal(hit, 0, `${building.id}: walled in partway round its own plinth`);
        assert.equal(lost, 0, `${building.id}: the plinth ran out from under a walker ${lost} times`);
      }
    }
  }
  assert.ok(laps.total > 300, `thin sample: ${laps.total} buildings`);
  assert.equal(laps.clean, laps.total);
  // And the ledge still holds a walker the wall has pushed off it. This is the
  // number that decides whether the plinth can be trimmed any further.
  assert.ok(FOUNDATION_MARGIN - PLAYER_STRUCTURE_RADIUS >= 0.2,
    `a ${FOUNDATION_MARGIN}m ledge leaves only `
    + `${(FOUNDATION_MARGIN - PLAYER_STRUCTURE_RADIUS).toFixed(2)}m for a walker to stand in`);
  console.log(`settlementfoundations: ${laps.clean}/${laps.total} plinths walkable right round`);
}


// --- a flight is drawn where the flight is walked -------------------------------------
//
// The claim carries a walker up to three metres of hillside. If the blocks are
// not under their feet they climb open air, and nothing else in this suite
// would notice: the last time geometry was hung off a claim by eye it was
// offset from a wall's centre line rather than its face, buried inside a wall
// 0.28 m thick, and rendered as nothing while every test stayed green.
{
  let flights = 0, blocks = 0;
  for (const seed of [20260612, 99887, 42]) {
    clearStationSettlementCache();
    const world = railWorld(seed);
    for (const site of stationSettlements(world, world.seed)) {
      const plan = cachedSettlementPlan(world, site);
      for (const flight of plan.doorsteps || []) {
        flights++;
        const run = Math.hypot(flight.bx - flight.ax, flight.bz - flight.az);
        const laid = doorstepBlocks(flight);
        assert.ok(laid.length >= 2, `${flight.id}: a flight of ${laid.length}`);
        blocks += laid.length;
        let previousTop = -Infinity;
        for (const block of laid) {
          const along = Math.hypot(block.x - flight.ax, block.z - flight.az);
          const onRamp = flight.ay + (flight.by - flight.ay) * (along / run);
          // Within half a riser of the ramp the walker is actually standing on.
          assert.ok(Math.abs(block.top - onRamp) <= 0.26,
            `${flight.id}: a tread ${(block.top - onRamp).toFixed(2)}m off the ramp it belongs to`);
          assert.ok(block.top > previousTop, `${flight.id}: a flight that stops climbing`);
          assert.ok(block.width >= 2 * PLAYER_STRUCTURE_RADIUS,
            `${flight.id}: ${block.width.toFixed(2)}m wide is narrower than a walker`);
          // Solid down into the bank, not a floating tread.
          assert.ok(block.top - block.height <= flight.ay + 1e-6,
            `${flight.id}: a tread with daylight under it`);
          previousTop = block.top;
        }
        // The last tread arrives at the surface of the plot.
        assert.ok(Math.abs(laid[laid.length - 1].top - flight.by) < 1e-6,
          `${flight.id}: the flight stops short of the plot it climbs to`);
      }
    }
  }
  // Twenty across three seeds is what these worlds hold: most doors sit on the
  // uphill side where the plot meets the ground and the claim alone lifts a
  // walker in. The guard is here to catch flights disappearing altogether, not
  // to demand a particular number of hillsides.
  assert.ok(flights >= 12, `flights have stopped being built: ${flights}`);
  console.log(`settlementfoundations: ${blocks} blocks across ${flights} flights, all on their ramp`);
}
