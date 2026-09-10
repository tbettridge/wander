// Read-only diagnosis of the current river model and generated meshes.
// Run from any directory; JSON is written to stdout. This is a baseline audit,
// not a test that codifies the current broken water shape as expected behavior.
import { World } from '../../src/world.js';
import { buildTerrainArrays, buildRiver } from '../../src/chunkgen.js';
import { splitQuadValue } from '../../src/terraincut.mjs';
import { planRegionalRailway } from '../../src/railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from '../../src/railwayterrain.mjs';

const sample = (world, x, z) => {
  const river = {};
  const ground = world.height(x, z, river);
  return { ...river, ground };
};
const wet = (r) => (r.signedDepth ?? r.waterY - r.floor) > 0.03 && r.waterY > 0.25 && r.ch > 0.001;
const seeds = [20260612, 4242];
const sweep = seeds.map((seed) => {
  const world = new World(seed);
  let samples = 0, wetSamples = 0, sagOver1m = 0;
  const examples = [];
  for (let z = -2000; z <= 2000; z += 10) {
    for (let x = -2000; x <= 2000; x += 10) {
      samples++;
      const r = sample(world, x, z);
      if (!wet(r)) continue;
      wetSamples++;
      const sag = r.head - r.waterY;
      if (sag <= 1) continue;
      sagOver1m++;
      examples.push({ x, z, ground: r.ground, water: r.waterY, head: r.head,
        channel: r.ch, sag, depth: r.waterY - r.floor });
    }
  }
  examples.sort((a, b) => b.sag - a.sag);
  return { seed, samples, wetSamples, sagOver1m, examples: examples.slice(0, 6) };
});

const world = new World(seeds[0]);
const x = -550, z = -960;
const dx = world._riverSignalAt(x + 1, z) - world._riverSignalAt(x - 1, z);
const dz = world._riverSignalAt(x, z + 1) - world._riverSignalAt(x, z - 1);
const length = Math.hypot(dx, dz);
const normal = { x: dx / length, z: dz / length };
const section = [];
for (let offset = -12; offset <= 32; offset += 0.5) {
  const px = x + normal.x * offset, pz = z + normal.z * offset;
  const r = sample(world, px, pz);
  section.push({ offset, x: px, z: pz, ground: r.ground, water: r.waterY,
    head: r.head, channel: r.ch, wet: wet(r) });
}

const cx = Math.floor(x / 140), cz = Math.floor(z / 140);
const meshAtExample = [112, 96, 80, 72, 56, 48, 24, 16].map((res) => {
  const terrain = buildTerrainArrays(world, cx, cz, res, 140);
  const river = buildRiver(cx, cz, res, 140, terrain.river);
  const { waterY, headY, sub } = terrain.river;
  const n = res + 1, step = 140 / res;
  const gx = (x - cx * 140) / step, gz = (z - cz * 140) / step;
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const a = iz * n + ix, corners = [a, a + 1, a + n, a + n + 1];
  const interpolate = (getter) => splitQuadValue(
    ...corners.map(getter), gx - ix, gz - iz,
  );
  return { res, cx, cz, triangles: river.indices.length / 3,
    ground: interpolate((i) => terrain.positions[i * 3 + 1]),
    water: interpolate((i) => waterY[i]),
    head: interpolate((i) => headY[i]), aWet: interpolate((i) => sub[i]) };
});

const coverage = [96, 48, 24, 16].map((res) => {
  let samples = 0, wetSamples = 0, omittedWet = 0, hiddenWet = 0;
  const examples = [];
  for (let chunkZ = -8; chunkZ <= -6; chunkZ++) {
    for (let chunkX = -5; chunkX <= -3; chunkX++) {
      const t = buildTerrainArrays(world, chunkX, chunkZ, res, 140);
      const pre = t.river, n = res + 1, step = 140 / res;
      for (let zi = 0; zi < res; zi++) {
        for (let xi = 0; xi < res; xi++) {
          for (const [fx, fz] of [[1 / 3, 1 / 3], [2 / 3, 2 / 3]]) {
            samples++;
            const px = chunkX * 140 + (xi + fx) * step;
            const pz = chunkZ * 140 + (zi + fz) * step;
            const r = world.riverAt(px, pz);
            if (!r.wet) continue;
            wetSamples++;
            const a = zi * n + xi, corners = [a, a + 1, a + n, a + n + 1];
            if (!pre || !corners.some((i) => pre.sub[i] > 0)) {
              omittedWet++;
              if (examples.length < 3) examples.push({ x: px, z: pz,
                depth: r.depth, reason: 'no wet corner' });
              continue;
            }
            const interpolate = (getter) => splitQuadValue(...corners.map(getter), fx, fz);
            const ground = interpolate((i) => t.positions[i * 3 + 1]);
            const water = interpolate((i) => pre.waterY[i]);
            if (water > ground) continue;
            hiddenWet++;
            if (examples.length < 3) examples.push({ x: px, z: pz, depth: r.depth,
              meshDepth: water - ground, reason: 'water mesh below terrain mesh' });
          }
        }
      }
    }
  }
  return { res, samples, wetSamples, omittedWet, hiddenWet, examples };
});

const railWorld = new World(seeds[0]);
const plan = planRegionalRailway(railWorld, {
  center: { x: 0, z: 0 }, seed: seeds[0], stationCount: 5,
});
setWorldRailwayTerrain(railWorld, serializeRailwayTerrainPlan(plan));
let railWetSamples = 0;
const railMismatches = [];
for (const point of plan.points) {
  for (let oz = -24; oz <= 24; oz += 4) {
    for (let ox = -24; ox <= 24; ox += 4) {
      const px = point.x + ox, pz = point.z + oz;
      const r = sample(railWorld, px, pz);
      if (!wet(r)) continue;
      railWetSamples++;
      const delta = r.ground - r.floor;
      if (Math.abs(delta) <= 0.25) continue;
      railMismatches.push({ x: px, z: pz, finalGround: r.ground,
        riverFloor: r.floor, water: r.waterY, reportedDepth: r.waterY - r.floor,
        actualDepth: r.waterY - r.ground, delta });
    }
  }
}
railMismatches.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

console.log(JSON.stringify({
  method: {
    sweepBounds: [-2000, 2000], sweepStep: 10,
    coverageChunks: { minX: -5, maxX: -3, minZ: -8, maxZ: -6 },
    coverageSamples: 'two triangle centroids per terrain cell; independent per LOD',
    railSamples: '13 by 13 grid at 4m spacing around each planned point; grids can overlap',
    limitation: 'Procedural and generated-mesh measurements; no browser screenshot or GPU rendering audit.',
  },
  sweep, section: { seed: seeds[0], x, z, normal, samples: section }, meshAtExample, coverage,
  railway: { seed: seeds[0], wetSamples: railWetSamples,
    mismatchesOver25cm: railMismatches.length, examples: railMismatches.slice(0, 4) },
}, null, 2));
