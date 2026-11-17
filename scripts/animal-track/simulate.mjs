// Headless wildlife-and-railway soak: how long do animals spend on the track?
//
//   node --import ./scripts/animal-track/register.mjs scripts/animal-track/simulate.mjs \
//     [--seeds 20260612,20260613] [--soak-minutes 8] [--ride-laps 1] [--json out.json]
//
// Builds the real world and regional railway for each seed in Node, streams
// animals with the game's own AnimalSystem spawn code, and runs the game's own
// AnimalAgent behaviour (perception, goals, steering, structure collision) with
// the presentation stripped out: no meshes, no leg IK, no ropes. Three.js is a
// small stub (see three-stub.mjs) because the behaviour only needs its vectors.
//
// Two scenarios per seed:
//   soak  windows of ground along the whole line, animals left undisturbed for
//         --soak-minutes each — the pure "do they wander onto it and stop" case.
//   ride  the player rides the train round the loop at service speed with a
//         dwell at each station, animals streaming around them as in play. A
//         "strike" is an animal on the track within 25 m of the passing train.
//
// What is measured (animal centre within RAILWAY_FOUL_HALF_WIDTH of the line,
// at track level):
//   foul seconds, still seconds (speed < 0.2 m/s), still spells over 1 s, the
//   longest single visit, how far along the rails an animal travels per visit
//   (a square-on crossing is a few metres; walking the line is tens), stationary
//   behaviour states on the track, and spawns that land on it.

import { StructureCollisionIndex } from '../../src/structurecollision.mjs';
import {
  buildWorld, registerSettlements, ride, round, soak, summarise,
} from './harness.mjs';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const SEEDS = String(arg('seeds', '20260612,20260613,20260614,20260615')).split(',').map(Number);
const SOAK_MINUTES = Number(arg('soak-minutes', 8));
const RIDE_LAPS = Number(arg('ride-laps', 1));
const JSON_OUT = arg('json', null);
const QUIET = args.includes('--quiet');

const results = [];
for (const seed of SEEDS) {
  const started = Date.now();
  const { world, plan } = buildWorld(seed);
  const collision = new StructureCollisionIndex(() => ({ features: { interiorsEnabled: true }, portals: {} }));
  const settlements = registerSettlements(world, plan, collision);
  const result = { seed, stations: plan.stations.length, settlements };
  if (SOAK_MINUTES > 0) result.soak = summarise(soak(world, plan, collision, SOAK_MINUTES));
  if (RIDE_LAPS > 0) result.ride = summarise(ride(world, plan, collision, RIDE_LAPS));
  result.seconds = round((Date.now() - started) / 1000);
  results.push(result);
  if (!QUIET) console.log(JSON.stringify(result));
}

function total(key, scenario) {
  return results.reduce((sum, r) => sum + (r[scenario]?.[key] || 0), 0);
}
const totals = {};
for (const scenario of ['soak', 'ride']) {
  if (!results.some((r) => r[scenario])) continue;
  totals[scenario] = {
    animalHours: round(total('animalHours', scenario), 2),
    foulSeconds: round(total('foulSeconds', scenario)),
    stillSeconds: round(total('stillSeconds', scenario)),
    stationaryStateSeconds: round(total('stationaryStateSeconds', scenario)),
    stillSpellsOver1s: total('stillSpellsOver1s', scenario),
    longestStillSpell: Math.max(...results.map((r) => r[scenario]?.longestStillSpell || 0)),
    visits: total('visits', scenario),
    crossings: total('crossings', scenario),
    longestVisit: Math.max(...results.map((r) => r[scenario]?.longestVisit || 0)),
    maxAlongPerVisit: Math.max(...results.map((r) => r[scenario]?.maxAlongPerVisit || 0)),
    spawnsOnTrack: total('spawnsOnTrack', scenario),
    strikes: total('strikes', scenario),
  };
}
console.log('TOTALS ' + JSON.stringify(totals));
if (JSON_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(JSON_OUT, JSON.stringify({ seeds: SEEDS, soakMinutes: SOAK_MINUTES, rideLaps: RIDE_LAPS, results, totals }, null, 2));
}
