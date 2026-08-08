// A village with a middle.
//
// Phase 2 made the buildings varied and Phase 1 made them close together, and
// the result still read as a field of houses, because evenly-spread points do
// not become a village by being nearer to each other. This is the layout that
// fixes that: a square, streets off it, and buildings standing along those
// streets facing the road.
//
// The assertions are about the things that make it legible — the square stays
// empty, the doors face the street, the civic buildings take the frontage —
// rather than about exact positions, which are the layout's business.

import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from '../src/railwayterrain.mjs';
import { clearStationSettlementCache, stationSettlements } from '../src/stationsettlement.mjs';
import { createSettlementPlan } from '../src/settlementplan.mjs';
import { settlementBuildBlocker } from '../src/settlementspatial.mjs';
import {
  facingToward, insideSquare, layoutSpecFor, planSettlementLayout,
} from '../src/settlementlayout.mjs';
import { buildingWorldPoint } from '../src/buildingplan.mjs';
import { settlementOrigin } from '../src/settlementorigin.mjs';
import { PROP_KIND, STONE_KINDS, propCollisionRadius } from '../src/settlementprops.mjs';
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

clearStationSettlementCache();
const world = railWorld(20260612);
const villages = stationSettlements(world, world.seed);
const origins = villages.map((site) => settlementOrigin(world, site));
const plans = villages.map((site, i) => createSettlementPlan(site, {
  heightAt: (x, z) => world.height(x, z),
  blockedAt: settlementBuildBlocker(world, site),
  origin: origins[i],
}));

// --- the main street runs to whatever the village is FOR ---------------------------
//
// The visible payoff of a founding reason: walk the main street of a place and
// it takes you to the thing that put it there. Street angles are measured in the
// (cos, sin) convention that `site.yaw` uses — NOT the (sin, cos) one that
// `facingToward` uses for doors — and mixing the two lays the main street at
// ninety degrees to its own reason.
{
  for (let i = 0; i < villages.length; i++) {
    const site = villages[i], origin = origins[i], plan = plans[i];
    const spec = layoutSpecFor(site.kind);
    const layout = planSettlementLayout(site, spec, origin);
    const main = layout.streets[0];
    const wanted = Math.atan2(origin.z - site.z, origin.x - site.x);
    const off = Math.abs(Math.atan2(
      Math.sin(main.angle - wanted), Math.cos(main.angle - wanted),
    ));
    // Exact when the reason is far enough off the centre to have a bearing at
    // all; a reason underfoot falls back to the site's own facing.
    if (origin.distance > 1) {
      assert.ok(off < 1e-9,
        `${site.id}: the main street is ${(off * 180 / Math.PI).toFixed(0)}° off its ${origin.kind}`);
    }
    assert.ok(main.width >= spec.streetWidth, 'the founding axis should be the widest street');
    assert.equal(layout.streets.length, spec.streets, 'street count must not drift');

    // The square drifts toward the reason but must stay well inside the built
    // area, or the lots on the far side fall off the end of it.
    const drift = Math.hypot(layout.square.x - site.x, layout.square.z - site.z);
    assert.ok(drift <= spec.squareRadius * 0.36,
      `${site.id}: the square wandered ${drift.toFixed(1)}m from the site`);

    // And every lot still falls outside it, which is the one thing the layout
    // exists to protect.
    for (const lot of layout.lots) {
      assert.equal(insideSquare(layout.square, lot.x, lot.z), false,
        `${site.id}: lot ${lot.id} was placed inside the square`);
    }
    assert.ok(plan.buildings.length > 0, `${site.id} built nothing`);
  }
}

// --- a station village keeps its approach from the platform --------------------------
// The founding axis takes street 0. Where the station is on a different bearing
// the line's own approach has to survive as a street of its own, or you arrive
// at a village with no road into it.
{
  for (let i = 0; i < villages.length; i++) {
    const site = villages[i], origin = origins[i];
    const layout = planSettlementLayout(site, layoutSpecFor(site.kind), origin);
    const apart = Math.abs(Math.atan2(
      Math.sin(site.yaw - layout.streets[0].angle), Math.cos(site.yaw - layout.streets[0].angle),
    ));
    if (apart <= 0.55) continue;                  // the two axes already coincide
    const hasApproach = layout.streets.some((street) => Math.abs(Math.atan2(
      Math.sin(street.angle - site.yaw), Math.cos(street.angle - site.yaw),
    )) < 1e-9);
    assert.ok(hasApproach, `${site.id}: no street runs to the station`);
  }
}

// --- facing is solved, not guessed ---------------------------------------------
// A building's front is its local +z, and buildingWorldPoint maps that onto
// (sin yaw, cos yaw) — so facing a point is atan2(dx, dz), not atan2(dz, dx).
// Getting this backwards puts every door on the wrong side of every house.
{
  const yaw = facingToward(0, 0, 10, 0);          // target due +x
  const front = buildingWorldPoint({ x: 0, y: 0, z: 0, yaw }, 0, 5);
  assert.ok(front.x > 4.9, `the front should face the target, landed at ${front.x.toFixed(2)}`);
  assert.ok(Math.abs(front.z) < 0.01, 'and not off to one side');
}

// --- every village has a square and streets ---------------------------------------
for (const plan of plans) {
  assert.ok(plan.square, `${plan.site.id} has no square`);
  assert.ok(plan.streets.length >= 3, `${plan.site.id} has only ${plan.streets.length} streets`);
  assert.ok(plan.square.radius > 10, 'a square needs to be a space, not a gap');
}

// --- the square stays empty ---------------------------------------------------------
// The one piece of ground the layout exists to protect. A building in it is not
// a tight village, it is a blocked square.
for (const plan of plans) {
  for (const building of plan.buildings) {
    assert.ok(!insideSquare(plan.square, building.x, building.z),
      `${building.id} is standing in the square`);
  }
}

// --- doors face the street they stand on ----------------------------------------------
// The whole reason lot facings are held through terrain fitting. A house that
// turned to save a doorstep would open onto its neighbour's wall.
{
  let checked = 0, facing = 0;
  for (const plan of plans) {
    for (const building of plan.buildings) {
      const door = building.portals.find((p) => p.kind === 'exterior-door');
      const outside = buildingWorldPoint(building, door.x, building.depth / 2 + 3);
      // Stepping out of the door must take you nearer the village centre line
      // it fronts — either the square or the street axis it stands on.
      const fromCentre = Math.hypot(building.x - plan.square.x, building.z - plan.square.z);
      const doorFromCentre = Math.hypot(outside.x - plan.square.x, outside.z - plan.square.z);
      const towardStreet = doorFromCentre < fromCentre;
      // A lot on the far side of a street faces back across it, so allow either
      // sense — what must never happen is a door into the building's own back.
      const behind = buildingWorldPoint(building, door.x, -building.depth / 2 - 3);
      const behindFromCentre = Math.hypot(behind.x - plan.square.x, behind.z - plan.square.z);
      assert.notEqual(towardStreet, behindFromCentre < doorFromCentre - 1e-6,
        `${building.id}: door and back are on the same side`);
      if (towardStreet) facing++;
      checked++;
    }
  }
  assert.ok(checked > 60, `too few buildings to be meaningful (${checked})`);
  // Square frontage and the inner side of every street face inward, so a clear
  // majority should open toward the middle.
  assert.ok(facing / checked > 0.45,
    `only ${Math.round(100 * facing / checked)}% of doors open toward the village`);
}

// --- the civic buildings take the square ------------------------------------------------
// The roster puts them first and the layout offers square frontage first, so
// this is the two halves agreeing rather than a coincidence.
{
  const village = plans.find((p) => p.site.kind === 'station-village');
  const onSquare = village.buildings
    .filter((b) => Math.hypot(b.x - village.square.x, b.z - village.square.z) < village.square.radius + 26)
    .map((b) => b.program);
  for (const program of ['church', 'inn']) {
    assert.ok(onSquare.includes(program), `the ${program} should front the square, saw ${onSquare.join(', ')}`);
  }
}

// --- the square is furnished ---------------------------------------------------------------
{
  const village = plans.find((p) => p.site.kind === 'station-village');
  const kinds = village.props.map((p) => p.kind);
  assert.ok(kinds.includes(PROP_KIND.well), 'a square needs its well');
  assert.ok(kinds.filter((k) => k === PROP_KIND.stall).length >= 3, 'and a market worth the name');
  const well = village.props.find((p) => p.kind === PROP_KIND.well);
  assert.ok(Math.hypot(well.x - village.square.x, well.z - village.square.z) < 0.01,
    'the well belongs in the middle');

  // The founding stone stands out at the end of a street, off the carriageway,
  // made of whatever rock that country gives you.
  const stone = village.props.find((p) => p.kind === PROP_KIND.foundingStone);
  assert.ok(stone, 'a village should be marked with its founding');
  const fromSquare = Math.hypot(stone.x - village.square.x, stone.z - village.square.z);
  assert.ok(fromSquare > village.square.radius,
    `the founding stone is only ${fromSquare.toFixed(0)}m out — it belongs past the houses`);
  // Out past the houses along the road it chose, but never further than that
  // road goes — it marks the end of the village, not a point in open country.
  const main = village.streets[stone.street];
  const dirX = Math.cos(main.angle), dirZ = Math.sin(main.angle);
  const along = (stone.x - village.square.x) * dirX + (stone.z - village.square.z) * dirZ;
  const streetEnd = Math.hypot(main.toX - village.square.x, main.toZ - village.square.z);
  assert.ok(along > village.square.radius,
    `the founding stone is only ${along.toFixed(0)}m along the main street`);
  assert.ok(along <= streetEnd + 0.5,
    `the founding stone is ${along.toFixed(0)}m out, past the ${streetEnd.toFixed(0)}m street`);
  // Off the road, not in it.
  const across = Math.abs((stone.x - village.square.x) * -dirZ + (stone.z - village.square.z) * dirX);
  assert.ok(across > main.width / 2,
    'the founding stone is standing in the carriageway');
  assert.ok(stone.height > 0.8 && stone.height < 3.2, `a ${stone.height.toFixed(2)}m stone`);
  assert.ok(Object.keys(STONE_KINDS).includes(stone.stone), `unknown rock ${stone.stone}`);
  assert.ok(propCollisionRadius(stone) > 0, 'you should not walk through a standing stone');
}

// --- and no founding stone stands in the river ---------------------------------------------
// The street runs the full built reach while a ford is often half that out, so
// the road crosses the water and keeps going: placing the stone at the street's
// outer end put two of five villages' stones in the channel, one of them over a
// metre deep. It has to walk back onto ground a building would be allowed on.
{
  for (const plan of plans) {
    const stone = plan.props.find((p) => p.kind === PROP_KIND.foundingStone);
    // Every laid-out village raises one. Dropping it silently when the ground
    // was awkward is how the first fix "passed": no stone in the river, and no
    // stone anywhere either.
    assert.ok(stone, `${plan.site.id} raised no founding stone`);
    const river = world.riverAt(stone.x, stone.z);
    assert.equal(river.wet, false,
      `${plan.site.id}: the founding stone is standing in ${river.depth.toFixed(2)}m of water`);
    assert.ok(world.height(stone.x, stone.z) > 0.9,
      `${plan.site.id}: the founding stone is below the waterline`);
    // Still outside the square, wherever it ended up retreating to.
    assert.ok(Math.hypot(stone.x - plan.square.x, stone.z - plan.square.z) > plan.square.radius,
      `${plan.site.id}: the founding stone retreated into the square`);
  }
  // Everything that furnishes the square is actually in the square. The
  // founding stone is the one prop that is not square furniture — it stands at
  // the far end of the main street, marking the end of the village that faces
  // whatever the village is for.
  for (const plan of plans) {
    for (const prop of plan.props) {
      if (prop.kind === PROP_KIND.foundingStone) continue;
      assert.ok(Math.hypot(prop.x - plan.square.x, prop.z - plan.square.z) <= plan.square.radius + 0.5,
        `${prop.id} is outside the square it furnishes`);
    }
  }
}

// --- the well is solid, the benches are not -------------------------------------------------
{
  const village = plans.find((p) => p.site.kind === 'station-village');
  const well = village.props.find((p) => p.kind === PROP_KIND.well);
  const bench = village.props.find((p) => p.kind === PROP_KIND.bench);
  assert.ok(propCollisionRadius(well) > 0, 'you should not be able to walk through a well');
  assert.equal(propCollisionRadius(bench), 0, 'a bench you get caught on is worse than one you step over');

  const index = new StructureCollisionIndex(() => ({ portals: {} }));
  index.registerPlan(village);
  const from = { x: well.x, y: well.y + 1, z: well.z - 6 };
  const target = { x: well.x, y: well.y + 1, z: well.z };
  const result = index.resolveMovement({ ...target }, from);
  assert.ok(result.blocked, 'the well must stop a walker');
}

// --- streets are laid as circulation, not just drawn -----------------------------------------
{
  const village = plans.find((p) => p.site.kind === 'station-village');
  const streetPaths = village.paths.filter((p) => p.id.includes(':street:'));
  assert.ok(streetPaths.length >= village.streets.length,
    'each street should carry at least one run of path');
  const streetNodes = village.localGraph.nodes.filter((n) => n.kind === 'street');
  assert.ok(streetNodes.length > 6, `streets need nodes to connect to, saw ${streetNodes.length}`);
}

// --- the layout offers more lots than a village can use ----------------------------------------
// Holding a lot's facing costs the terrain fitter its quarter-turns, so lots
// get refused far more often than they used to. The supply has to absorb that.
{
  const site = villages.find((v) => v.kind === 'station-village');
  const spec = layoutSpecFor(site.kind);
  const layout = planSettlementLayout(site, spec);
  assert.ok(layout.lots.length > 60, `only ${layout.lots.length} lots for a village of ~35`);
  assert.equal(layout.lots[0].kind, 'square-front', 'square frontage must be offered first');
  for (const lot of layout.lots) {
    assert.ok(!insideSquare(layout.square, lot.x, lot.z), `${lot.id} was placed in the square`);
  }
}

console.log('settlement layout ok');
