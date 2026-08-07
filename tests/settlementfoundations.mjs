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
  BUILDING_FLOOR_SURFACE, FOUNDATION_MARGIN, FOUNDATION_STEP_UP,
} from '../src/settlementplan.mjs';
import { buildingWorldPoint } from '../src/buildingplan.mjs';
import { StructureCollisionIndex } from '../src/structurecollision.mjs';

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
  let tallChecked = 0, lowChecked = 0, capChecked = 0;
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
          assert.equal(sides(building).length, 4,
            `${building.id} stands ${height.toFixed(2)}m proud and needs sides`);
          tallChecked++;
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
