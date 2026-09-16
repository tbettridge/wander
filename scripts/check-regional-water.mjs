import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { WaterRegionPlanner, changedWaterBounds, WATER_REGION_BYTES } from '../src/hydrologyregions.mjs';
import { waterPreviewSpawn } from '../src/hydrologypreview.mjs';
import { trailsAround } from '../src/trails.js';
import { solveCrossing } from '../src/trailcrossings.mjs';

const seed = Number(process.argv[2] || 4242), planner = new WaterRegionPlanner(seed);
const start = performance.now(), first = planner.window(0, 0);
const world = new World(seed, { waterPlans: first });
const coldMs = performance.now() - start;
const secondStart = performance.now(), second = planner.window(1, 0);
const nextWorld = new World(seed, { waterPlans: second });
const nextMs = performance.now() - secondStart;
for (const plan of first) {
  assert.ok(JSON.stringify(plan).length <= WATER_REGION_BYTES);
  const held = second.find(p => p.regionX === plan.regionX && p.regionZ === plan.regionZ);
  if (held) assert.equal(held.hash, plan.hash);
}
// The guaranteed interior shared by both windows includes the forest lake
// crossing z=0. Test actual water/terrain values, not only descriptor hashes.
let probes = 0;
for (const field of world.waterField.components.values()) {
  const g = field.mesh.grid;
  for (let i = 0; i < g.coords.length; i += 17) {
    const x = g.coords[i][0] * g.step, z = g.coords[i][1] * g.step;
    if (x < 1100 || x > 7000 || z < -3000 || z > 7000) continue;
    assert.equal(world.height(x, z), nextWorld.height(x, z));
    assert.deepEqual(world.riverAt(x, z), nextWorld.riverAt(x, z)); probes++;
  }
}
assert.ok(probes > 100);
const replay = planner.window(0, 0);
assert.deepEqual(replay.map(p => p.hash), first.map(p => p.hash));
const spawn = waterPreviewSpawn(world, '?waterPreview=regional');
assert.ok(spawn && !world.riverAt(spawn.x, spawn.z).wet);
const components = first.flatMap(p => p.components);
const edges = trailsAround(world, 2048, 2048, seed, 4000, []);
let trailMetres = 0, watersideMetres = 0, encounters = 0, supportedCrossings = 0;
for (const edge of edges) {
  let wasNear = false;
  const s = edge.segments;
  for (let i = 0; i < s.count; i++) {
    const steps = Math.max(1, Math.ceil(s.len[i] / 16));
    for (let j = 0; j < steps; j++) {
      const t = (j + 0.5) / steps, x = s.ax[i] + s.dx[i] * t, z = s.az[i] + s.dz[i] * t;
      if (x < -2800 || x > 6800 || z < -2800 || z > 6800) { wasNear = false; continue; }
      const near = [[0, 0], [40, 0], [-40, 0], [0, 40], [0, -40]].some(([dx, dz]) => world.riverAt(x + dx, z + dz).wet);
      trailMetres += s.len[i] / steps;
      if (near) { watersideMetres += s.len[i] / steps; if (!wasNear) encounters++; }
      wasNear = near;
    }
  }
  for (const ford of edge.fords || []) if (solveCrossing(world, edge, ford)) supportedCrossings++;
}
assert.ok(encounters > 0 && supportedCrossings > 0);
console.log(JSON.stringify({ seed, regions: first.length, bytes: JSON.stringify(first).length,
  closedBasins: first.reduce((n, p) => n + p.basins.length, 0), components: components.length,
  flowingBasins: components.filter(c => c.basinIds?.length).length,
  streamFedBasins: components.filter(c => c.basinIds?.length && c.reachIds.length > (c.oceanHandoff ? 1 : 0)).length,
  riverReaches: components.filter(c => !c.basinIds?.length).reduce((n, c) => n + c.reachIds.length, 0),
  sharedTerrainProbes: probes, changedBounds: changedWaterBounds(first, second).length,
  cacheEntries: planner.cache.size, coldMs, nextMs, spawn,
  trails: { edges: edges.length, kilometres: trailMetres / 1000, watersideKilometres: watersideMetres / 1000,
    proximityRuns: encounters, supportedCrossings } }, null, 2));
