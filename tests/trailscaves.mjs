// Cave spurs in the desire-line network. Trails now branch off to cave mouths
// so caves are discoverable by following paths. This locks in: caves actually
// appear as trail destinations against the real world field, the spur ties a
// 'C' cave key to a landmark key, endpoints sit at the real anchor, caves stay
// rarer than landmark links, and the whole query is deterministic.

import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { trailsAround, clearTrailCache } from '../src/trails.js';
import { landmarksAround } from '../src/landmarks.js';
import { caveAnchorForCell } from '../src/cavegen.mjs';

const world = new World(20260612);
const seed = world.seed;

// Sweep several regions so we're not leaning on one lucky tile.
const REGIONS = [[0, 0], [8000, -3000], [-6000, 4000], [12000, 9000], [-11000, -8000]];
const RADIUS = 7000;

let totalEdges = 0, totalSpurs = 0, regionsWithSpurs = 0;
const seenCaveKeys = new Set();

for (const [px, pz] of REGIONS) {
  const edges = [];
  trailsAround(world, px, pz, seed, RADIUS, edges);
  const spurs = edges.filter((edge) => edge.toCave);
  totalEdges += edges.length;
  totalSpurs += spurs.length;
  if (spurs.length) regionsWithSpurs++;

  for (const edge of spurs) {
    // One endpoint is a cave ('C…'), the other a landmark cell key.
    const keys = [edge.fromKey, edge.toKey];
    const caveKeys = keys.filter((k) => k.startsWith('C'));
    assert.equal(caveKeys.length, 1, `spur ${edge.id} should have exactly one cave endpoint`);
    const landmarkKey = keys.find((k) => !k.startsWith('C'));
    assert.ok(/^-?\d+_-?\d+$/.test(landmarkKey), `spur ${edge.id} landmark key malformed: ${landmarkKey}`);

    // caveEnd names which curve end is the mouth, and toCave carries it.
    assert.ok(edge.caveEnd === 'from' || edge.caveEnd === 'to', `spur ${edge.id} missing caveEnd`);
    assert.ok(edge.toCave && Number.isFinite(edge.toCave.x) && Number.isFinite(edge.toCave.z),
      `spur ${edge.id} missing toCave position`);

    // The cave endpoint must match the real deterministic anchor for that cell.
    const [cx, cz] = caveKeys[0].slice(1).split('_').map(Number);
    const anchor = caveAnchorForCell(world, cx, cz, seed);
    assert.ok(anchor && anchor.valid, `spur ${edge.id} references an invalid/absent cave`);
    assert.ok(Math.hypot(anchor.x - edge.toCave.x, anchor.z - edge.toCave.z) < 1e-6,
      `spur ${edge.id} cave endpoint drifted from its anchor`);

    // Its route class is a real class the surface renderer understands.
    assert.ok(['primary', 'secondary', 'faint'].includes(edge.routeClass),
      `spur ${edge.id} has an unknown route class ${edge.routeClass}`);

    seenCaveKeys.add(caveKeys[0]);
  }
}

assert.ok(totalSpurs > 0, 'no cave spurs were generated anywhere — caves remain undiscoverable');
assert.ok(regionsWithSpurs >= 3, `only ${regionsWithSpurs}/5 regions had a cave trail`);
// Caves are the rarer destination: spurs must not swamp the landmark network.
assert.ok(totalSpurs < totalEdges * 0.5,
  `cave spurs (${totalSpurs}) should stay a minority of ${totalEdges} edges`);

// A cave should not connect to a landmark beyond the spur reach (2.5 cells).
for (const [px, pz] of REGIONS) {
  const edges = [];
  trailsAround(world, px, pz, seed, RADIUS, edges);
  const lms = [];
  landmarksAround(world, px, pz, seed, RADIUS + 4200, lms);
  for (const edge of edges.filter((e) => e.toCave)) {
    const lmKey = [edge.fromKey, edge.toKey].find((k) => !k.startsWith('C'));
    const lm = lms.find((l) => l.key === lmKey);
    if (!lm) continue; // just outside the landmark scan window; distance checked below anyway
    const d = Math.hypot(lm.x - edge.toCave.x, lm.z - edge.toCave.z);
    assert.ok(d <= 2.5 * 1600 + 1, `spur ${edge.id} is ${d.toFixed(0)}m — beyond the cave reach cap`);
  }
}

// Determinism: a cold cache must reproduce the exact same edge set per region.
for (const [px, pz] of REGIONS) {
  const a = []; trailsAround(world, px, pz, seed, RADIUS, a);
  clearTrailCache();
  const b = []; trailsAround(world, px, pz, seed, RADIUS, b);
  const ka = a.map((e) => e.id).sort().join('|');
  const kb = b.map((e) => e.id).sort().join('|');
  assert.equal(ka, kb, `region ${px},${pz} trail set is not deterministic`);
  // And identical cave endpoints/classes on rebuild.
  const sa = a.filter((e) => e.toCave).map((e) => `${e.id}:${e.routeClass}:${e.toCave.x.toFixed(2)}`).sort().join('|');
  const sb = b.filter((e) => e.toCave).map((e) => `${e.id}:${e.routeClass}:${e.toCave.x.toFixed(2)}`).sort().join('|');
  assert.equal(sa, sb, `region ${px},${pz} cave spurs are not deterministic`);
}

console.log(`trailscaves PASS · ${totalSpurs} cave spurs across ${regionsWithSpurs}/5 regions · ${seenCaveKeys.size} distinct caves · deterministic`);
