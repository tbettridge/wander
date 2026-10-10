// Compare exactly the same region workload against an isolated original checkout.
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const baselineRoot = process.argv[2];
if (!baselineRoot) throw new Error('Usage: node scripts/benchmark-water-refinement.mjs BASELINE_ROOT [OUTPUT_JSON]');
const baseline = await import(pathToFileURL(resolve(baselineRoot, 'src/hydrologyregions.mjs')));
const current = await import('../src/hydrologyregions.mjs');
const oldWorld = await import(pathToFileURL(resolve(baselineRoot, 'src/world.js')));
const oldChunks = await import(pathToFileURL(resolve(baselineRoot, 'src/chunkgen.js')));
const newWorld = await import('../src/world.js');
const newChunks = await import('../src/chunkgen.js');
const { brooksForCell } = await import('../src/forestbrooks.mjs');
// The preview's GPU comparison uses original shaders on identical current
// geometry. These temporary capture files are outside the tracked source.
await mkdir(resolve('trailer/raw'), { recursive: true });
const originalCommon = await readFile(resolve(baselineRoot, 'src/watercommon.js'), 'utf8');
const originalRiver = await readFile(resolve(baselineRoot, 'src/river.js'), 'utf8');
const originalOcean = await readFile(resolve(baselineRoot, 'src/water.js'), 'utf8');
await writeFile(resolve('trailer/raw/water-baseline-common.mjs'), originalCommon
  .replace("'./atmosphere.js'", "'/src/atmosphere.js'"));
await writeFile(resolve('trailer/raw/water-baseline-river.mjs'), originalRiver
  .replace("import { WATER_LEVEL } from './world.js';", 'const WATER_LEVEL = 0;')
  .replace("'./watercommon.js'", "'./water-baseline-common.mjs'"));
await writeFile(resolve('trailer/raw/water-baseline-ocean.mjs'), originalOcean
  .replace("import { WATER_LEVEL } from './world.js';", 'const WATER_LEVEL = 0;')
  .replace("'./watercommon.js'", "'./water-baseline-common.mjs'"));
const cases = [[1, 0, 0], [42, 0, 0], [4242, 1, 0]];
const rows = [], terrainRows = [], currentPlans = [];
// Warm both implementations once before alternating their timed runs.
for (const module of [baseline, current]) module.planWaterRegionCandidates(20260612, 0, 0);
for (const [seed, x, z] of cases) {
  const times = { baseline: [], current: [] }, metrics = {};
  for (let repeat = 0; repeat < 3; repeat++) {
    const order = repeat % 2 ? [['current', current], ['baseline', baseline]] : [['baseline', baseline], ['current', current]];
    for (const [name, module] of order) {
      const start = performance.now();
      const plan = module.planWaterRegionCandidates(seed, x, z);
      if (name === 'current' && repeat === 2) currentPlans.push(plan);
      times[name].push(performance.now() - start);
      metrics[name] = { reaches: plan.components.reduce((sum, c) => sum + c.reachIds.length, 0),
        systems: plan.components.length + plan.basins.length,
        waterCells: plan.components.reduce((sum, c) => sum + c.grid.coords.length, 0),
        bytes: JSON.stringify(plan).length };
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[1];
  const row = { seed, x, z, baselineMs: median(times.baseline), currentMs: median(times.current), times, metrics };
  row.changePercent = (row.currentMs / row.baselineMs - 1) * 100;
  rows.push(row); console.log(JSON.stringify(row));
}
// Isolate the runtime terrain/water meshing cost on identical current plans.
// This exercises dry-bank pigment and normals without conflating it with a
// different route layout. World preparation is outside the timed samples.
for (const plan of currentPlans) {
  const component = [...plan.components].sort((a, b) => b.reachIds.length - a.reachIds.length)[0];
  const wet = component.grid.coords.filter((_, i) => component.grid.signed[i] > 0.5);
  const chunks = [...new Map([0.25, 0.5, 0.75].map(fraction => {
    const [x, z] = wet[Math.floor((wet.length - 1) * fraction)];
    const cx = Math.floor(x * 2 / 140), cz = Math.floor(z * 2 / 140);
    return [`${cx},${cz}`, [cx, cz]];
  })).values()];
  const versions = {
    baseline: { world: new oldWorld.World(plan.seed, { waterPlans: [plan] }), chunks: oldChunks },
    current: { world: new newWorld.World(plan.seed, { waterPlans: [plan] }), chunks: newChunks },
  };
  const run = version => chunks.map(([cx, cz]) => {
    const terrain = version.chunks.buildTerrainArrays(version.world, cx, cz, 64, 140);
    const river = version.chunks.buildRiver(cx, cz, 64, 140, terrain.river);
    return { terrain, river };
  });
  for (const version of Object.values(versions)) run(version);
  const times = { baseline: [], current: [] }, geometry = {};
  for (let repeat = 0; repeat < 5; repeat++) for (const name of repeat % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
    const start = performance.now(), result = run(versions[name]);
    times[name].push(performance.now() - start);
    geometry[name] = result.map(({ terrain, river }) => ({
      terrainTriangles: terrain.indices.length / 3, waterTriangles: (river?.indices.length || 0) / 3,
    }));
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const row = { seed: plan.seed, chunks, baselineMs: median(times.baseline), currentMs: median(times.current), times, geometry };
  row.changePercent = (row.currentMs / row.baselineMs - 1) * 100;
  terrainRows.push(row); console.log(JSON.stringify({ terrain: row }));
}
const creekPlan = currentPlans.find(p => p.seed === 42);
const creekWorld = new newWorld.World(42, { waterPlans: [creekPlan] });
const creek = brooksForCell(creekWorld, 4, 8).find(b => b.drainage?.receiver.kind === 'river');
let forestCreek = null;
if (creek) {
  const cx = Math.floor(creek.drainage.receiver.x / 140), cz = Math.floor(creek.drainage.receiver.z / 140);
  newChunks.buildBrooks(creekWorld, cx, cz, 140);
  const baselineCreekWorld = new oldWorld.World(42, { waterPlans: [creekPlan] });
  // Same accepted paths and same water plan in both versions. Tracing is
  // outside the timing; this measures the drawn-ground sample reuse.
  baselineCreekWorld._brookCache = new Map(creekWorld._brookCache);
  const versions = { baseline: { world: baselineCreekWorld, chunks: oldChunks },
    current: { world: creekWorld, chunks: newChunks } };
  const run = name => versions[name].chunks.buildBrooks(versions[name].world, cx, cz, 140);
  run('baseline'); run('current');
  const times = { baseline: [], current: [] }, geometry = {};
  for (let repeat = 0; repeat < 9; repeat++) for (const name of repeat % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
    const start = performance.now(), built = run(name);
    times[name].push(performance.now() - start);
    geometry[name] = { waterTriangles: built.ribbon.indices.length / 3, bedTriangles: built.bed.indices.length / 3 };
  }
  const median = values => [...values].sort((a, b) => a - b)[4];
  forestCreek = { cx, cz, baselineMs: median(times.baseline), currentMs: median(times.current), times, geometry };
  forestCreek.changePercent = (forestCreek.currentMs / forestCreek.baselineMs - 1) * 100;
  console.log(JSON.stringify({ forestCreek }));
}
const result = { date: new Date().toISOString(), baselineRoot, repeats: 3, rows, forestCreek,
  terrainRows,
  terrainChangePercent: (terrainRows.reduce((n, r) => n + r.currentMs, 0) / terrainRows.reduce((n, r) => n + r.baselineMs, 0) - 1) * 100,
  totalChangePercent: (rows.reduce((n, r) => n + r.currentMs, 0) / rows.reduce((n, r) => n + r.baselineMs, 0) - 1) * 100 };
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n');
console.log(`Total median planning change: ${result.totalChangePercent.toFixed(1)}%`);
