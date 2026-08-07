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
import { PROP_KIND, propCollisionRadius } from '../src/settlementprops.mjs';
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
const plans = villages.map((site) => createSettlementPlan(site, {
  heightAt: (x, z) => world.height(x, z),
  blockedAt: settlementBuildBlocker(world, site),
}));

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
  // Everything in the square is actually in the square.
  for (const prop of village.props) {
    assert.ok(Math.hypot(prop.x - village.square.x, prop.z - village.square.z) <= village.square.radius + 0.5,
      `${prop.id} is outside the square it furnishes`);
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
