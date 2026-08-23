import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/world.js';
import { trailsAround } from '../src/trails.js';
import { caveAnchorsAround } from '../src/cavegen.mjs';
import { fortifiedOutpostsAround } from '../src/landmarks.js';
import { createFortifiedOutpostPlan } from '../src/fortifiedoutpost.mjs';
import { undercroftSitingFor } from '../src/keepdungeonanchor.mjs';

const world = new World(1337);
// The cave runtime cuts a hollow this wide out of the terrain at a mouth.
const CUT_RADIUS = 13;

function mouthsNear(radius) {
  const mouths = [];
  const caves = [];
  caveAnchorsAround(world, 0, 0, world.seed, radius, caves);
  for (const anchor of caves) {
    if (anchor.valid) mouths.push({ kind: 'cave', x: anchor.x, z: anchor.z });
  }
  const sites = [];
  fortifiedOutpostsAround(world, 0, 0, world.seed, radius, sites);
  for (const site of sites) {
    if (site.tier !== 'keep') continue;
    const siting = undercroftSitingFor(world, site);
    const door = createFortifiedOutpostPlan(site.outpostSeed, {
      undercroftBearing: siting.bearing, undercroftReach: siting.reach,
    }).intact.undercroft;
    if (!door) continue;
    const c = Math.cos(site.yaw), s = Math.sin(site.yaw);
    mouths.push({
      kind: 'undercroft',
      x: site.x + door.x * c + door.z * s,
      z: site.z - door.x * s + door.z * c,
    });
  }
  return mouths;
}

// A trail is laid against the smooth height field and then rendered over a hole
// the cave runtime dug afterwards, so one crossing a mouth hangs in the air
// right where the player is looking for the entrance.
test('no trail is laid across a cave mouth or an undercroft door', () => {
  const mouths = mouthsNear(50000);
  assert.ok(mouths.length > 100, `only ${mouths.length} mouths to check`);
  const edges = [];
  const offenders = [];
  let checked = 0;
  for (const mouth of mouths) {
    trailsAround(world, mouth.x, mouth.z, world.seed, 240, edges);
    let closest = Infinity;
    for (const edge of edges) {
      const s = edge.segments;
      if (!s) continue;
      // A cave spur is supposed to arrive at its mouth; only a trail passing
      // over one is the defect, so skip the edge that ends here.
      if (edge.toCave && Math.hypot(edge.toCave.x - mouth.x, edge.toCave.z - mouth.z) < 2) continue;
      for (let i = 0; i < s.count; i++) {
        // Interior only: an endpoint resting nearby is a trail arriving.
        if (s.arc[i] < 26 || edge.arcLength - s.arc[i] < 26) continue;
        const length2 = s.dx[i] * s.dx[i] + s.dz[i] * s.dz[i] || 1;
        const t = Math.max(0, Math.min(1,
          ((mouth.x - s.ax[i]) * s.dx[i] + (mouth.z - s.az[i]) * s.dz[i]) / length2));
        const distance = Math.hypot(
          mouth.x - (s.ax[i] + s.dx[i] * t), mouth.z - (s.az[i] + s.dz[i] * t));
        if (distance < closest) closest = distance;
      }
    }
    if (!Number.isFinite(closest)) continue;
    checked++;
    if (closest < CUT_RADIUS) {
      offenders.push(`${mouth.kind} at ${Math.round(mouth.x)},${Math.round(mouth.z)}: ${closest.toFixed(1)}m`);
    }
  }
  assert.ok(checked > 80, `only ${checked} mouths had a trail near them`);
  assert.deepEqual(offenders.slice(0, 5), [], `${offenders.length} of ${checked} crossed`);
});

console.log('trailmouths PASS · nothing laid over an entrance');
