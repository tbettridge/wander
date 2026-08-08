// Villages at the stations.
//
// Phase 1 is only about the place existing: sited beside its platform, holding
// ground no other settlement claims, and building nothing on the running line.
// What is in it, and who lives there, comes later — so these assert siting and
// exclusion, and deliberately say nothing about programs or streets.
//
// The railway is planned for real rather than faked. Station placement is the
// half of this that can put a village somewhere awkward, so a hand-placed
// station would test the arithmetic and nothing about the world it must survive.

import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import {
  railwayStationSites, serializeRailwayTerrainPlan, setWorldRailwayTerrain,
} from '../src/railwayterrain.mjs';
import {
  MAJOR_STATION_VILLAGES, STATION_SETTLEMENT_TIERS, STATION_SUPPRESSION_RADIUS,
  clearStationSettlementCache, stationSettlements, suppressedByStation,
} from '../src/stationsettlement.mjs';
import {
  settlementForCell, settlementsAround, SETTLEMENT_CELL,
} from '../src/settlementplacement.mjs';
import { createSettlementPlan } from '../src/settlementplan.mjs';
import {
  cachedSettlementPlan, settlementBuildBlocker, settlementGroundAtPlans, settlementPlansNear,
} from '../src/settlementspatial.mjs';
import { WATER_LEVEL } from '../src/world.js';
import { clearTrailCache, trailsAround } from '../src/trails.js';
import { settlementOrigin } from '../src/settlementorigin.mjs';

const RAILWAY = { center: { x: 0, z: 0 }, stationCount: 5, radius: 2600, searchRadius: 5200, exclusions: [] };

function railWorld(seed) {
  const world = new World(seed);
  const plan = planRegionalRailway(world, { ...RAILWAY, seed: world.seed ^ 0x5241494c });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(plan));
  return world;
}

clearStationSettlementCache();
const world = railWorld(20260612);
const stations = railwayStationSites(world.railwayTerrain);
const villages = stationSettlements(world, world.seed);

// --- every station has a village ----------------------------------------------
// Not "most". A station is a place the line already stops at; one without a
// village would read as a platform in an empty field.
assert.equal(villages.length, stations.length,
  `each of ${stations.length} stations needs a village, got ${villages.length}`);
for (const station of stations) {
  assert.ok(villages.some((v) => v.stationIndex === station.index),
    `station ${station.index} has no village`);
}

// --- three are larger, the rest are halts --------------------------------------
{
  const major = villages.filter((v) => v.kind === 'station-village');
  const minor = villages.filter((v) => v.kind === 'station-halt');
  assert.equal(major.length, MAJOR_STATION_VILLAGES, 'three best-sited stations get the larger village');
  assert.equal(minor.length, stations.length - MAJOR_STATION_VILLAGES, 'the rest are halts');
  assert.ok(STATION_SETTLEMENT_TIERS['station-village'].radius
    > STATION_SETTLEMENT_TIERS['station-halt'].radius, 'a village outgrows a halt');
}

// --- the village is beside its platform, not on it ------------------------------
// Close enough that the station belongs to the village; far enough that the
// centre is not standing on the track.
for (const village of villages) {
  const station = stations[village.stationIndex];
  const distance = Math.hypot(village.x - station.x, village.z - station.z);
  assert.ok(distance > station.halfWidth + 20,
    `village ${village.id} centre sits ${Math.round(distance)}m from the platform — on the line`);
  assert.ok(distance < village.radius,
    `village ${village.id} centre is ${Math.round(distance)}m away; its station is outside it`);
}

// --- the village reaches its own platform --------------------------------------------
// The station is supposed to be part of the village, and the only thing that
// makes it feel that way is houses being near it. This regressed once already
// and invisibly: tightening the layout shrank the built-up area without moving
// the centre, so the nearest house retreated to 126 m and the village read as
// having vanished from the platform even though every building was still there.
//
// Asserted on the distance to the nearest BUILDING, never the centre — the
// centre can sit anywhere as long as the houses come to meet you.
{
  const nearest = [];
  for (const seed of [20260612, 1234, 99887, 555, 42]) {
    clearStationSettlementCache();
    const w = railWorld(seed);
    for (const site of stationSettlements(w, w.seed)) {
      const plan = cachedSettlementPlan(w, site);
      const station = site.station;
      assert.ok(plan.buildings.length > 0, `${site.id} has no buildings at all`);
      nearest.push(Math.min(...plan.buildings.map(
        (b) => Math.hypot(b.x - station.x, b.z - station.z))));
    }
  }
  nearest.sort((a, b) => a - b);
  const median = nearest[Math.floor(nearest.length / 2)];
  assert.ok(median < 55,
    `the median village keeps its nearest house ${Math.round(median)}m from the platform`);
  // A minority can be pushed back by terrain or by the railway taking the
  // buildable side; a majority cannot, or the feature is gone again.
  const stranded = nearest.filter((d) => d > 70).length;
  assert.ok(stranded / nearest.length < 0.2,
    `${stranded} of ${nearest.length} villages start more than 70m from their platform`);
}

// --- no grid settlement survives within a kilometre of a station -----------------
{
  const found = [];
  settlementsAround(world, 0, 0, world.seed, 12000, found);
  for (const site of found) {
    if (site.isStationSettlement) continue;
    for (const station of stations) {
      const d = Math.hypot(site.x - station.x, site.z - station.z);
      assert.ok(d >= STATION_SUPPRESSION_RADIUS,
        `grid settlement ${site.id} survived ${Math.round(d)}m from station ${station.index}`);
    }
  }
  // The loop above is satisfied by a world that simply never had a settlement
  // near a station — which is the common case, since settlements sit on a
  // 3.2 km grid and there are only five stations. So the rule itself is
  // asserted directly rather than left to the luck of the seed.
  const station = stations[0];
  assert.equal(suppressedByStation(world, station.x, station.z), true,
    'ground at a station must be suppressed');
  // 300 m out: inside the default kilometre, outside a 50 m one. Stations are
  // thousands of metres apart, so no other station reaches this point.
  const near = { x: station.x + 300, z: station.z };
  assert.equal(suppressedByStation(world, near.x, near.z), true,
    '300m from a platform is still the village’s ground');
  assert.equal(suppressedByStation(world, near.x, near.z, 50), false,
    'suppression must respect its radius rather than swallowing the map');
  // Far enough that no station reaches, in a direction away from the loop.
  const far = { x: station.x + 40000, z: station.z + 40000 };
  assert.equal(suppressedByStation(world, far.x, far.z), false,
    'open country far from the line is never suppressed');
}

// --- the villages are in the list every other system reads -----------------------
// Vegetation halos and the settlement streamer both work from settlementsAround.
// A village missing here is a village with trees growing through its houses.
{
  const near = [];
  settlementsAround(world, stations[0].x, stations[0].z, world.seed, 600, near);
  assert.ok(near.some((site) => site.isStationSettlement && site.stationIndex === stations[0].index),
    'settlementsAround must surface the station village');
}

// --- nothing is built on the running line -----------------------------------------
// The whole reason the plan builder learned about blocked ground.
{
  const index = world.railwayTerrain;
  const probe = {};
  const blockedAt = (x, z) => {
    index.clearanceAt(x, z, probe);
    if (probe.station) return true;
    return Number.isFinite(probe.formationDistance) && probe.formationDistance < 20;
  };
  let checked = 0;
  for (const village of villages) {
    const plan = createSettlementPlan(village, { heightAt: (x, z) => world.height(x, z), blockedAt });
    assert.ok(plan.buildings.length > 0, `${village.id} produced no buildings at all`);
    for (const building of plan.buildings) {
      assert.ok(!blockedAt(building.x, building.z),
        `${building.id} stands on the railway`);
      checked++;
    }
  }
  assert.ok(checked > 40, `too few buildings to be meaningful (${checked})`);
}

// --- nothing is built in the water ------------------------------------------------
// The settlement centre is sited on dry ground, but its lots spread far enough
// to reach a lake shore or a river bend, and for a while nothing stopped a
// house being planted in one. Sampled over the whole footprint, because a core
// on dry land with a wing in the river is the case that survived the first fix.
{
  let wet = 0, sampled = 0;
  for (const seed of [20260612, 1234, 99887, 555, 42]) {
    clearStationSettlementCache();
    const w = railWorld(seed);
    for (const site of stationSettlements(w, w.seed)) {
      const plan = cachedSettlementPlan(w, site);
      for (const building of plan.buildings) {
        const fp = building.footprint;
        const corners = [[0, 0], [fp.minX, fp.minZ], [fp.maxX, fp.minZ], [fp.maxX, fp.maxZ], [fp.minX, fp.maxZ]];
        for (const [lx, lz] of corners) {
          const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
          const x = building.x + lx * c + lz * s, z = building.z - lx * s + lz * c;
          sampled++;
          if (w.riverAt(x, z).wet || w.height(x, z) < WATER_LEVEL + 0.2) {
            wet++;
            assert.fail(`${building.id} stands in water at ${Math.round(x)},${Math.round(z)}`);
          }
        }
      }
    }
  }
  assert.ok(sampled > 3000, `too few footprint samples to be meaningful (${sampled})`);
  assert.equal(wet, 0);
}

// --- the vegetation layer plans the same village the streamer renders ----------------
// Two systems build this settlement independently: the streamer builds what you
// see, and the grass layer builds its own copy to decide where to stop growing.
// When only one of them knew about blocked ground they disagreed, and grass was
// cleared around houses that had been moved somewhere else.
{
  clearStationSettlementCache();
  const w = railWorld(20260612);
  for (const site of stationSettlements(w, w.seed)) {
    const vegetation = cachedSettlementPlan(w, site);
    const streamed = createSettlementPlan(site, {
      heightAt: (x, z) => w.height(x, z),
      blockedAt: settlementBuildBlocker(w, site),
      // The streamer passes the founding reason too. Leave it out here and the
      // stand-in lays the village out on a different axis from the one the
      // grass planner used — which is the disagreement this block exists to
      // catch, so it correctly failed when only one side had been updated.
      origin: settlementOrigin(w, site),
    });
    assert.equal(vegetation.buildings.length, streamed.buildings.length,
      `${site.id}: the two planners disagree on how many buildings there are`);
    for (let i = 0; i < streamed.buildings.length; i++) {
      assert.ok(Math.hypot(vegetation.buildings[i].x - streamed.buildings[i].x,
        vegetation.buildings[i].z - streamed.buildings[i].z) < 0.001,
      `${site.id}: building ${i} is in a different place for the grass than for the renderer`);
    }
  }
}

// --- the grass layer can actually see a station village -------------------------------
// settlementPlansNear walked the settlement grid directly, and station villages
// are not on it — so grass grew straight through their houses.
{
  clearStationSettlementCache();
  const w = railWorld(20260612);
  const village = stationSettlements(w, w.seed).find((v) => v.kind === 'station-village');
  const plans = settlementPlansNear(w, village.x, village.z, 430, []);
  assert.ok(plans.some((p) => p.site.id === village.id),
    'the vegetation layer must see the station village');
  // And the ground under a building reads as cleared, not as meadow.
  const plan = plans.find((p) => p.site.id === village.id);
  const building = plan.buildings[0];
  const ground = settlementGroundAtPlans(plans, building.x, building.z);
  assert.ok(ground && ground.density === 0,
    'ground inside a building must carry no grass');
  // A narrow ring at the wall is still clear, so no blade grows through the
  // masonry or out of the plinth. Offset in the building's OWN frame — a
  // world-axis offset lands somewhere diagonal once the building is rotated,
  // which is not the thing being asserted.
  const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
  const atWall = building.footprint.halfWidth + 0.5;
  const beside = settlementGroundAtPlans(plans, building.x + atWall * c, building.z - atWall * s);
  assert.ok(beside && beside.density === 0,
    'the ground right at a wall must be clear');
  // But NOT the 6.5m apron it used to be. That slab was opaque geometry, and a
  // hard-edged opaque rectangle reads as asphalt however it is tinted; a
  // village is meant to be houses in grass with worn streets between them, not
  // houses on paved lots. Grass comes back a few metres out — unless this
  // particular spot happens to be square or street, which is surfaced dirt.
  const outInTheOpen = building.footprint.halfWidth + 5.0;
  const away = settlementGroundAtPlans(plans,
    building.x + outInTheOpen * c, building.z - outInTheOpen * s);
  assert.ok(!away || away.density > 0 || away.kind === 'square' || away.kind === 'street'
    || away.kind === 'path' || away.kind === 'interior',
    'the building plot came back — grass should reach a house’s garden');
}

// --- a village is denser than the grid village it outranks --------------------------
{
  const village = villages.find((v) => v.kind === 'station-village');
  const plan = createSettlementPlan(village, { heightAt: (x, z) => world.height(x, z) });
  const density = plan.buildings.length / (Math.PI * village.radius ** 2);
  // A grid village for comparison, built the same way.
  let gridVillage = null;
  const reach = Math.ceil(12000 / SETTLEMENT_CELL);
  for (let cj = -reach; cj <= reach && !gridVillage; cj++) for (let ci = -reach; ci <= reach; ci++) {
    const site = settlementForCell(world, ci, cj, world.seed);
    if (site?.kind === 'village') { gridVillage = site; break; }
  }
  assert.ok(gridVillage, 'the sample region must hold a grid village to compare against');
  const gridPlan = createSettlementPlan(gridVillage, { heightAt: (x, z) => world.height(x, z) });
  const gridDensity = gridPlan.buildings.length / (Math.PI * gridVillage.radius ** 2);
  assert.ok(density > gridDensity * 1.3,
    `station village is not meaningfully denser (${(density * 1e6).toFixed(1)} vs ${(gridDensity * 1e6).toFixed(1)} per km²)`);
}

// --- the station spur is the village's only regional trail ---------------------------
// The village entrance must not lay a second path to the same place.
{
  clearTrailCache();
  const edges = [];
  trailsAround(world, 0, 0, world.seed, 20000, edges);
  for (const village of villages) {
    const own = edges.filter((edge) => edge.fromKey === `${village.id}:entrance`
      || edge.toKey === `${village.id}:entrance`);
    assert.equal(own.length, 0,
      `${village.id} laid its own spur as well as its station's`);
  }
  const stationSpurs = edges.filter((e) => /^R\d+$/.test(e.fromKey) || /^R\d+$/.test(e.toKey));
  assert.equal(stationSpurs.length, stations.length,
    'every station still reaches the trail network');
}

// --- a world with no railway is exactly as it was --------------------------------------
{
  clearStationSettlementCache();
  const bare = new World(20260612);
  assert.deepEqual(stationSettlements(bare, bare.seed), [], 'no railway, no station villages');
  const found = [];
  settlementsAround(bare, 0, 0, bare.seed, 6000, found);
  assert.ok(found.length > 0, 'a railway-free world still has settlements');
  assert.ok(found.every((site) => !site.isStationSettlement), 'and none of them are station villages');
}

// --- stable across seeds ----------------------------------------------------------------
// Siting reads terrain, so a seed where every candidate is underwater would
// quietly produce villages in the sea. Check the invariants hold more widely.
for (const seed of [1234, 99887, 555, 42]) {
  clearStationSettlementCache();
  clearTrailCache();
  const w = railWorld(seed);
  const list = stationSettlements(w, w.seed);
  const sites = railwayStationSites(w.railwayTerrain);
  assert.equal(list.length, sites.length, `seed ${seed}: every station needs a village`);
  assert.equal(list.filter((v) => v.kind === 'station-village').length, MAJOR_STATION_VILLAGES,
    `seed ${seed}: three larger villages`);
  for (const village of list) {
    assert.ok(w.height(village.x, village.z) > 0.4,
      `seed ${seed}: ${village.id} was sited in open water`);
  }
}

console.log('station settlements ok');
