// Why a village is here.
//
// The claim this has to keep is that the reason is EVIDENCE-LED: a village that
// comes out a ford is a village with a river next to it, and one that comes out
// a harbour can actually reach the sea. A founding reason that contradicts the
// ground it stands on is worse than no founding reason, because the layout, the
// name and the villagers all then repeat the contradiction.
//
// The first cut failed exactly this way and the distribution caught it: nine
// villages in ten came out `harbour`, because the guard tested
// `biome.coastType`, which is a coastal STYLE sampled from a noise field and
// defined everywhere on the map, including several hundred metres up a mountain.

import assert from 'node:assert/strict';
import { World, WATER_LEVEL } from '../src/world.js';
import { settlementForCell } from '../src/settlementplacement.mjs';
import {
  ORIGIN_KINDS, clearSettlementOriginCache, settlementOrigin,
} from '../src/settlementorigin.mjs';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import {
  serializeRailwayTerrainPlan, setWorldRailwayTerrain,
} from '../src/railwayterrain.mjs';
import { clearStationSettlementCache, stationSettlements } from '../src/stationsettlement.mjs';

function surveyed(world, span = 14) {
  const rows = [];
  for (let ci = -span; ci <= span; ci++) {
    for (let cj = -span; cj <= span; cj++) {
      const site = settlementForCell(world, ci, cj, world.seed);
      if (site) rows.push({ site, origin: settlementOrigin(world, site) });
    }
  }
  return rows;
}

const world = new World(1337);
const survey = surveyed(world);
assert.ok(survey.length > 400, `expected a real spread of settlements, got ${survey.length}`);

// --- evidence-led, not diced ------------------------------------------------------
{
  let fords = 0, harbours = 0, shrines = 0;
  for (const { site, origin } of survey) {
    if (origin.kind === 'ford') {
      fords++;
      // The point it named must actually be a channel you could cross.
      assert.ok(world.riverAt(origin.x, origin.z).wet,
        `${origin.name} is a ford whose crossing is on dry land`);
      assert.ok(origin.distance <= 130,
        `${origin.name}'s ford is ${origin.distance.toFixed(0)}m away — too far to be why it is here`);
    }
    if (origin.kind === 'harbour') {
      harbours++;
      assert.ok(world.height(origin.x, origin.z) <= WATER_LEVEL + 0.35,
        `${origin.name} is a harbour that cannot reach water`);
    }
    if (origin.kind === 'shrine') {
      shrines++;
      assert.ok(origin.distance <= 520,
        `${origin.name}'s shrine is ${origin.distance.toFixed(0)}m off`);
    }
    // Whatever the reason, it is somewhere you could walk to from the village.
    assert.ok(Number.isFinite(origin.x) && Number.isFinite(origin.z));
    assert.ok(origin.strength >= 0 && origin.strength <= 1);
    assert.ok(ORIGIN_KINDS.includes(origin.kind), `unknown kind ${origin.kind}`);
  }
  assert.ok(fords > 10, `a world with rivers should found some villages on them (${fords})`);
  assert.ok(harbours > 10, `and some on the coast (${harbours})`);
  assert.ok(shrines > 0, 'and at least a few on somewhere people already came to');
}

// --- a world's villages are not all the same idea ------------------------------------
{
  const tally = new Map();
  for (const { origin } of survey) tally.set(origin.kind, (tally.get(origin.kind) || 0) + 1);
  assert.ok(tally.size >= 5,
    `only ${tally.size} founding reasons across ${survey.length} settlements`);
  for (const [kind, count] of tally) {
    assert.ok(count / survey.length < 0.45,
      `${kind} accounts for ${(count / survey.length * 100).toFixed(0)}% of settlements — that is a template, not a reason`);
  }
}

// --- names --------------------------------------------------------------------------
{
  const seen = new Map();
  for (const { site, origin } of survey) {
    assert.match(origin.name, /^[A-Z][A-Za-z]*( [A-Z][a-z]+)*$/,
      `"${origin.name}" is not a place name`);
    assert.ok(origin.name.length >= 4 && origin.name.length <= 28, `"${origin.name}"`);
    const at = seen.get(origin.name) || [];
    at.push(site);
    seen.set(origin.name, at);
  }
  // Two Newtons in a county is England; two in a valley is a bug.
  let closeClashes = 0;
  for (const sites of seen.values()) {
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        if (Math.hypot(sites[i].x - sites[j].x, sites[i].z - sites[j].z) < 6000) closeClashes++;
      }
    }
  }
  assert.ok(closeClashes <= 6,
    `${closeClashes} pairs of identically-named settlements within 6km of each other`);
  assert.ok(seen.size > survey.length * 0.5,
    `only ${seen.size} distinct names for ${survey.length} settlements`);
}

// --- the same world names the same places forever --------------------------------------
{
  const before = survey.map(({ origin }) => `${origin.kind}:${origin.name}:${origin.x.toFixed(3)}`);
  clearSettlementOriginCache();
  const after = surveyed(new World(1337)).map(({ origin }) => `${origin.kind}:${origin.name}:${origin.x.toFixed(3)}`);
  assert.deepEqual(after, before, 'a village must have the same reason and name on every visit');
}

// --- deriving a reason must not move the village ------------------------------------------
{
  clearSettlementOriginCache();
  const site = surveyed(world, 4)[0].site;
  const snapshot = JSON.stringify(site);
  settlementOrigin(world, site);
  assert.equal(JSON.stringify(site), snapshot,
    'the origin changed the site — trails key off settlement positions and would feed back');
}

// --- the railway made some places, but only some -------------------------------------------
{
  clearStationSettlementCache();
  clearSettlementOriginCache();
  const railed = new World(4242);
  const plan = planRegionalRailway(railed, {
    center: { x: 0, z: 0 }, stationCount: 5, radius: 2600, searchRadius: 5200,
    exclusions: [], seed: railed.seed ^ 0x5241494c,
  });
  setWorldRailwayTerrain(railed, serializeRailwayTerrainPlan(plan));
  const villages = stationSettlements(railed, railed.seed);
  assert.ok(villages.length >= 4, `expected station villages, got ${villages.length}`);
  const kinds = villages.map((site) => settlementOrigin(railed, site));
  for (const origin of kinds) {
    assert.ok(origin.name, 'every station village needs a name');
    assert.equal(origin.age, origin.kind === 'railway' ? 'new' : 'old');
  }
  // Most villages predate the line, as they did in life — so a railway founding
  // has to be possible and must not be the answer for all of them.
  assert.ok(kinds.some((origin) => origin.kind !== 'railway'),
    'every station village was invented by the railway — nothing was here first');
}

console.log(`settlementorigin PASS · ${survey.length} settlements · evidence-led · named · stable`);
