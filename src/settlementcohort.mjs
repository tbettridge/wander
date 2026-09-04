// A cohort of villages, generated headlessly, for measuring the generator
// rather than a seed.
//
// Every design question worth asking about procedural settlements is a question
// about a population: is this village like the others, do look-alike families
// cluster, does a trade show on a house. One plan cannot answer any of them, so
// this builds a fixed set of plans from a fixed set of world seeds and hands
// them over as plain data.
//
// Villages come from railway station siting because that is where the world
// actually puts them — a synthetic site would measure a placement that never
// ships. That makes a cohort cost roughly half a second per world seed, which
// is why the size is a parameter and the default is the smallest population
// that makes a tail meaningful.
//
// No Three.js, no renderer, no browser. The plans are the same objects the
// streaming path consumes.

import { World } from './world.js';
import { planRegionalRailway } from './railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from './railwayterrain.mjs';
import { clearStationSettlementCache, stationSettlements } from './stationsettlement.mjs';
import { createSettlementPlan } from './settlementplan.mjs';
import { settlementBuildBlocker } from './settlementspatial.mjs';
import { settlementOrigin } from './settlementorigin.mjs';
import { cohortIntegrity, cohortLabel, distinctCohort, settlementIdentity } from './settlementdesign.mjs';

export { cohortIntegrity, cohortLabel, distinctCohort, settlementIdentity };

/**
 * Six world seeds, about thirty villages. Fixed rather than random: a cohort
 * that changes between runs turns a ratchet into a coin toss, and a regression
 * you cannot reproduce is not a regression you can fix.
 */
export const DEFAULT_COHORT_SEEDS = Object.freeze([
  20260612, 20260613, 20260614, 20260615, 20260616, 20260617,
]);

const RAILWAY_OPTIONS = Object.freeze({
  center: Object.freeze({ x: 0, z: 0 }),
  stationCount: 5, radius: 2600, searchRadius: 5200,
});

function railWorld(seed) {
  const world = new World(seed);
  const railway = planRegionalRailway(world, {
    ...RAILWAY_OPTIONS, seed: world.seed ^ 0x5241494c, exclusions: [],
  });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(railway));
  return world;
}

/**
 * Plans for every station settlement across `seeds`.
 *
 * The station cache is cleared per world on purpose. It is keyed by site rather
 * than by world, so carrying it across seeds hands the second world the first
 * world's villages and quietly collapses the cohort to one sample.
 */
export function generateSettlementCohort({ seeds = DEFAULT_COHORT_SEEDS } = {}) {
  const plans = [];
  for (const seed of seeds) {
    clearStationSettlementCache();
    const world = railWorld(seed);
    for (const site of stationSettlements(world, world.seed)) {
      plans.push(createSettlementPlan(site, {
        heightAt: (x, z) => world.height(x, z),
        blockedAt: settlementBuildBlocker(world, site),
        origin: settlementOrigin(world, site),
      }));
    }
  }
  clearStationSettlementCache();
  return plans;
}
