// Ride the regional railway of several worlds and count everything the train
// would pass through: ground the terrain mesh draws over the rails or inside a
// tunnel bore, and rocks, boulders or tree trunks inside the clearance.
//
//   node scripts/check-railway-clearance.mjs [seed ...] [--game] [--water-cache DIR] [--res 48,64,...] [--detail] [--json]
//
// Terrain is checked on every near-ring grid a quality tier can draw (--res
// overrides, e.g. --res 32 to look at the distant rings too).
//
// Without --game each seed is a plain world with the cohort's railway (fast,
// the same worlds the unit test rides). With --game the world is built the way
// the game builds it: the regional water window, the lakeshore spawn as the
// railway centre, landmark and cave exclusions and the compact 1.5km loop. Water
// planning takes a few minutes per seed; --water-cache keeps the plans on disk.
// Exits non-zero if anything intrudes.

import fs from 'node:fs';
import path from 'node:path';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from '../src/railwayterrain.mjs';
import { auditRailwayClearance, RAILWAY_NEAR_TERRAIN_RESOLUTIONS } from '../src/railwayclearanceaudit.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const optionValues = new Set([option('--water-cache'), option('--res')].filter(Boolean));
const seeds = args.filter((arg) => /^\d+$/.test(arg) && !optionValues.has(arg)).map(Number);
const game = flag('--game');
const resolutions = option('--res')
  ? option('--res').split(',').map(Number)
  : [...RAILWAY_NEAR_TERRAIN_RESOLUTIONS];
if (!seeds.length) seeds.push(...(game ? [20260612] : [20260612, 20260613, 20260614, 20260615, 20260616, 20260617]));

async function gameWorld(seed) {
  const { WaterRegionPlanner } = await import('../src/hydrologyregions.mjs');
  const { findLakeShoreSpawn } = await import('../src/lakeshorespawn.mjs');
  const { landmarksAround, majorLandmarksAround } = await import('../src/landmarks.js');
  const { caveAnchorsAround } = await import('../src/cavegen.mjs');
  const cacheDir = option('--water-cache');
  const cacheFile = cacheDir ? path.join(cacheDir, `water-${seed}.json`) : null;
  let plans;
  if (cacheFile && fs.existsSync(cacheFile)) plans = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  else {
    plans = new WaterRegionPlanner(seed).window(0, 0);
    if (cacheFile) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(plans));
    }
  }
  const world = new World(seed, { waterPlans: plans });
  const spawn = findLakeShoreSpawn(world, { regionX: 0, regionZ: 0 });
  const center = spawn ? { x: spawn.x, z: spawn.z } : { x: 0, z: 0 };
  const exclusions = [], caves = [];
  landmarksAround(world, center.x, center.z, seed, 14500, exclusions);
  majorLandmarksAround(world, center.x, center.z, seed, 14500, exclusions, true);
  caveAnchorsAround(world, center.x, center.z, seed, 14500, caves);
  for (const cave of caves) exclusions.push({ x: cave.x, z: cave.z, halo: 55, type: 'cave' });
  const plan = planRegionalRailway(world, {
    center, seed: seed ^ 0x5241494c, stationCount: 5, radius: 1500, searchRadius: 1200, exclusions,
  });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(plan));
  return { world, plan };
}

function plainWorld(seed) {
  // The game always runs generation 3 (the regional water window); without
  // water plans that is the same terrain, dry, and fast to build.
  const world = new World(seed, { generationVersion: 3 });
  const plan = planRegionalRailway(world, {
    center: { x: 0, z: 0 }, seed: seed ^ 0x5241494c, stationCount: 5, radius: 2600, searchRadius: 5200,
  });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(plan));
  return { world, plan };
}

let total = 0;
const report = [];
for (const seed of seeds) {
  const started = performance.now();
  const { world, plan } = game ? await gameWorld(seed) : plainWorld(seed);
  const audit = auditRailwayClearance(world, plan, { terrain: { resolutions } });
  const terrain = Object.fromEntries(Object.entries(audit.terrain)
    .map(([res, entry]) => [res, entry.intrusions.length]));
  const byStructure = {};
  for (const entry of Object.values(audit.terrain)) {
    for (const hit of entry.intrusions) byStructure[hit.structure] = (byStructure[hit.structure] || 0) + 1;
  }
  const props = audit.props.intrusions.length;
  const propTypes = {};
  for (const hit of audit.props.intrusions) {
    const key = `${hit.type}@${hit.structure}`;
    propTypes[key] = (propTypes[key] || 0) + 1;
  }
  const structures = plan.metrics.structures;
  const entry = {
    seed, world: game ? 'game' : 'plain', km: +(audit.length / 1000).toFixed(2),
    tunnels: structures.tunnel.count, bridges: structures.bridge.count,
    terrainMetres: terrain, terrainByStructure: byStructure,
    props, propTypes, seconds: +((performance.now() - started) / 1000).toFixed(1),
  };
  if (flag('--detail')) {
    // Contiguous stretches of line, rather than every metre of them.
    entry.terrainDetail = Object.fromEntries(Object.entries(audit.terrain).map(([res, value]) => {
      const runs = [];
      for (const hit of value.intrusions) {
        const run = runs.at(-1);
        if (run && hit.arc - run.to <= 2) {
          run.to = Math.round(hit.arc);
          run.over = Math.max(run.over, +hit.over.toFixed(2));
          if (!run.s.includes(hit.structure)) run.s.push(hit.structure);
        } else {
          runs.push({ from: Math.round(hit.arc), to: Math.round(hit.arc), x: Math.round(hit.x), z: Math.round(hit.z),
            s: [hit.structure], over: +hit.over.toFixed(2) });
        }
      }
      return [res, runs];
    }));
    entry.propDetail = audit.props.intrusions.slice(0, 40).map((hit) => ({
      type: hit.type, v: hit.variant, x: Math.round(hit.x), z: Math.round(hit.z),
      scale: +hit.scale.toFixed(2), s: hit.structure, d: +hit.distance.toFixed(1),
    }));
  }
  total += Object.values(terrain).reduce((a, b) => a + b, 0) + props;
  report.push(entry);
  if (!flag('--json')) console.log(JSON.stringify(entry));
}
if (flag('--json')) console.log(JSON.stringify(report, null, 2));
if (!flag('--json')) console.log(total ? `FAIL · ${total} intrusions` : 'PASS · the line is clear');
process.exitCode = total ? 1 : 0;
