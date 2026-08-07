// The shape of a building, and what must survive being given one.
//
// The core is the interior: rooms, partitions, the working door, the floor the
// player stands on. Massing hangs solid volumes off that core, and the whole
// risk of this phase is that one of them ends up somewhere it breaks the
// interior — across the doorway, or claiming ground the path router needs.
//
// So these assert the invariants rather than the appearance. Variety is
// measured, because "more varied" is the actual goal and a grammar that always
// picks the same branch would pass every structural check.

import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import {
  BUILDING_PROGRAMS, buildingWorldPoint, createBuildingPlan, validateBuildingPlan,
} from '../src/buildingplan.mjs';
import { MASS_ROLE, massCollides, massingFootprint, validateMasses } from '../src/buildingmassing.mjs';
import { createSettlementPlan } from '../src/settlementplan.mjs';
import { collisionSegmentsForBuilding, StructureCollisionIndex } from '../src/structurecollision.mjs';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from '../src/railwayterrain.mjs';
import { clearStationSettlementCache, stationSettlements } from '../src/stationsettlement.mjs';

// --- every program plans, and validates ----------------------------------------
for (const program of BUILDING_PROGRAMS) {
  for (let s = 0; s < 24; s++) {
    const building = createBuildingPlan({ id: `b:${program}:${s}`, program, seed: 7919 * (s + 1) });
    const validation = validateBuildingPlan(building);
    assert.ok(validation.valid, `${program} seed ${s}: ${validation.errors.join(', ')}`);
    assert.ok(validateMasses(building.masses).valid, `${program} seed ${s}: bad masses`);
    assert.equal(building.masses[0].role, MASS_ROLE.core, 'the core comes first');
  }
}

// --- the core is still one rectangle -------------------------------------------
// The interior, the partitions and the floor claim all read width/depth. If
// massing ever changed those, every one of them would be quietly wrong.
for (const program of BUILDING_PROGRAMS) {
  const building = createBuildingPlan({ id: `core:${program}`, program, seed: 4242 });
  const core = building.masses[0];
  assert.equal(core.width, building.width, `${program}: core width must be the building width`);
  assert.equal(core.depth, building.depth, `${program}: core depth must be the building depth`);
  assert.equal(core.dx, 0);
  assert.equal(core.dz, 0);
}

// --- nothing solid stands in the doorway ----------------------------------------
// The door is at +z, and the approach path routes straight out through it. A
// wing across that face is a building nobody can enter.
{
  let checked = 0;
  for (const program of BUILDING_PROGRAMS) {
    for (let s = 0; s < 40; s++) {
      const building = createBuildingPlan({ id: `door:${program}:${s}`, program, seed: s * 2654435761 });
      const door = building.portals.find((p) => p.kind === 'exterior-door');
      // Sample the ground from the threshold out along the approach.
      for (const distance of [0.4, 1.2, 2.1, 3.2]) {
        const z = building.depth / 2 + distance;
        for (const item of building.masses) {
          if (item.role === MASS_ROLE.core || !massCollides(item)) continue;
          const insideX = Math.abs(door.x - item.dx) < item.width / 2 + door.width / 2;
          const insideZ = z > item.dz - item.depth / 2 && z < item.dz + item.depth / 2;
          assert.ok(!(insideX && insideZ),
            `${building.id}: ${item.role} blocks the doorway at ${distance}m`);
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 500, `too few door approaches sampled (${checked})`);
}

// --- the footprint really contains every mass -------------------------------------
// Spatial code trusts this for lot overlap and path routing. A mass outside it
// is a building that overlaps its neighbour or swallows a lane.
for (const program of BUILDING_PROGRAMS) {
  for (let s = 0; s < 20; s++) {
    const building = createBuildingPlan({ id: `fp:${program}:${s}`, program, seed: s * 40503 + 11 });
    const { halfWidth, halfDepth } = building.footprint;
    assert.deepEqual(building.footprint, massingFootprint(building.masses), 'footprint must match its masses');
    for (const item of building.masses) {
      if (item.role === MASS_ROLE.spire) continue;
      assert.ok(Math.abs(item.dx) + item.width / 2 <= halfWidth + 1e-9,
        `${building.id}: ${item.role} sticks out of the footprint in x`);
      assert.ok(Math.abs(item.dz) + item.depth / 2 <= halfDepth + 1e-9,
        `${building.id}: ${item.role} sticks out of the footprint in z`);
    }
    assert.ok(halfWidth >= building.width / 2 - 1e-9 && halfDepth >= building.depth / 2 - 1e-9,
      `${building.id}: footprint must be at least the core`);
  }
}

// --- attached masses are solid ------------------------------------------------------
// A tower you can walk through is worse than no tower.
{
  const building = createBuildingPlan({ id: 'church:solid', program: 'church', seed: 1234 });
  const tower = building.masses.find((m) => m.role === MASS_ROLE.tower);
  assert.ok(tower, 'a church needs its tower');
  const index = new StructureCollisionIndex(() => ({ portals: {} }));
  index.registerPlan({ id: 'plan', buildings: [building] });
  const centre = buildingWorldPoint(building, tower.dx, tower.dz);
  // Walk from outside the tower toward its middle; something must stop it.
  const from = buildingWorldPoint(building, tower.dx, tower.dz - tower.depth / 2 - 2);
  const position = { x: centre.x, y: building.y + 1, z: centre.z };
  const result = index.resolveMovement(position, { x: from.x, y: building.y + 1, z: from.z });
  assert.ok(result.blocked, 'the tower must stop a walker');
  // And the spire, which never reaches the ground, must not.
  const spire = building.masses.find((m) => m.role === MASS_ROLE.spire);
  if (spire) assert.equal(massCollides(spire), false, 'a spire is in the air, not underfoot');
}

// --- the interior is untouched ---------------------------------------------------------
// Core wall segments must be exactly what they were before massing existed:
// four sides with a gap for the door, plus partitions.
{
  const building = createBuildingPlan({ id: 'interior', program: 'dwelling', seed: 99 });
  const core = collisionSegmentsForBuilding(building);
  assert.equal(core.filter((s) => s.id.includes(':wall:')).length, 5,
    'the core still has its five wall runs');
  assert.ok(core.some((s) => s.id.endsWith(':wall:front-left')));
  assert.ok(core.some((s) => s.id.endsWith(':wall:front-right')));
}

// --- variety, which is the point --------------------------------------------------------
{
  const silhouette = (b) => b.masses.map((m) => `${m.role}:${m.dx.toFixed(1)}:${m.dz.toFixed(1)}:${m.width.toFixed(1)}`).join('|');
  const shapes = new Set();
  for (let s = 0; s < 400; s++) {
    shapes.add(silhouette(createBuildingPlan({ id: `v:${s}`, program: 'dwelling', seed: s * 2654435761 })));
  }
  assert.ok(shapes.size > 100, `dwellings are not varied enough: ${shapes.size} shapes in 400 seeds`);
  // A church is recognisably a church: it should nearly always carry a tower.
  let towers = 0;
  for (let s = 0; s < 60; s++) {
    const church = createBuildingPlan({ id: `c:${s}`, program: 'church', seed: s * 7919 + 3 });
    if (church.masses.some((m) => m.role === MASS_ROLE.tower)) towers++;
  }
  assert.equal(towers, 60, 'every church needs its tower to read as one');
}

// --- villages differ from each other ------------------------------------------------------
// The style is shared within a settlement precisely so that settlements differ.
// Per-building randomness alone averages out and makes every village the same mix.
{
  clearStationSettlementCache();
  const world = new World(20260612);
  const rail = planRegionalRailway(world, {
    center: { x: 0, z: 0 }, seed: world.seed ^ 0x5241494c,
    stationCount: 5, radius: 2600, searchRadius: 5200, exclusions: [],
  });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(rail));
  const villages = stationSettlements(world, world.seed);
  const profiles = villages.map((site) => {
    const plan = createSettlementPlan(site, { heightAt: (x, z) => world.height(x, z) });
    const slate = plan.buildings.filter((b) => b.materials.roof === 'slate').length / plan.buildings.length;
    const stone = plan.buildings.filter((b) => b.materials.wall === 'stone').length / plan.buildings.length;
    return { id: site.id, slate, stone, buildings: plan.buildings.length };
  });
  const spread = Math.max(...profiles.map((p) => p.slate)) - Math.min(...profiles.map((p) => p.slate));
  assert.ok(spread > 0.2,
    `villages should differ in character; slate share spread was only ${spread.toFixed(2)}`);

  // And a station village actually gets its civic buildings.
  const village = villages.find((v) => v.kind === 'station-village');
  const plan = createSettlementPlan(village, { heightAt: (x, z) => world.height(x, z) });
  for (const program of ['church', 'school', 'market-hall', 'inn']) {
    assert.ok(plan.buildings.some((b) => b.program === program),
      `a station village must have its ${program}`);
  }
}

console.log('building massing ok');
