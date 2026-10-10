// CPU/geometry comparison against an isolated checkout. Run with animation and
// other CPU-heavy work stopped; this does not measure GPU time or whole-game FPS.
import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { cpus } from 'node:os';

const { values } = parseArgs({ options: {
  baseline: { type: 'string' }, current: { type: 'string', default: process.cwd() },
  output: { type: 'string', default: 'docs/water-refinement/regional-performance.json' },
  'planning-runs': { type: 'string', default: '3' },
  'geometry-runs': { type: 'string', default: '7' },
} });
if (!values.baseline) throw new Error('Usage: node scripts/benchmark-regional-water.mjs --baseline BASELINE_ROOT [--current CURRENT_ROOT] [--output OUTPUT_JSON]');
const baselineRoot = resolve(values.baseline), currentRoot = resolve(values.current);
const planningRuns = Number(values['planning-runs']), geometryRuns = Number(values['geometry-runs']);
for (const runs of [planningRuns, geometryRuns]) if (!Number.isInteger(runs) || runs < 1 || runs > 99) throw new Error('Run counts must be integers from 1 to 99');
const load = (root, file) => import(pathToFileURL(resolve(root, 'src', file)));
const [baseline, current, oldWorld, newWorld, oldChunks, newChunks] = await Promise.all([
  load(baselineRoot, 'hydrologyregions.mjs'), load(currentRoot, 'hydrologyregions.mjs'),
  load(baselineRoot, 'world.js'), load(currentRoot, 'world.js'),
  load(baselineRoot, 'chunkgen.js'), load(currentRoot, 'chunkgen.js'),
]);
const mean = values => values.reduce((sum, n) => sum + n, 0) / values.length;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const change = (before, after) => (after / before - 1) * 100;
const cases = [[20260612, -1, -1], [20260612, 0, 0], [1, 0, 0], [42, 0, 0], [4242, 1, 0]];
const rows = [], plans = [], runtimeRows = [];
const summaries = plan => ({ hash: plan.hash, bytes: Buffer.byteLength(JSON.stringify(plan)),
  systems: plan.basins.length + plan.components.length, basins: plan.basins.length,
  reaches: plan.components.reduce((n, component) => n + component.reachIds.length, 0),
  waterCells: plan.components.reduce((n, component) => n + component.grid.coords.length, 0),
  trunks: plan.components.filter(component => component.regionalTrunk).map(component => ({
    hash: component.hash, step: component.grid.step, cells: component.grid.coords.length,
    bytes: Buffer.byteLength(JSON.stringify(component)),
  })), rejected: plan.diagnostics?.rejected,
});
for (const [seed, x, z] of cases) {
  const times = { baseline: [], current: [] }, metrics = {}, latest = {};
  // Warm both planners on each exact seed/region outside the measurement.
  for (const module of [baseline, current]) module.planWaterRegionCandidates(seed, x, z);
  for (let repeat = 0; repeat < planningRuns; repeat++) {
    const order = repeat % 2 ? [['current', current], ['baseline', baseline]] : [['baseline', baseline], ['current', current]];
    for (const [name, module] of order) {
      const start = performance.now();
      latest[name] = module.planWaterRegionCandidates(seed, x, z);
      times[name].push(performance.now() - start);
      metrics[name] = summaries(latest[name]);
    }
  }
  plans.push(latest);
  const row = { seed, x, z, times, metrics,
    baselineMs: median(times.baseline), currentMs: median(times.current),
    baselineMeanMs: mean(times.baseline), currentMeanMs: mean(times.current) };
  row.changePercent = change(row.baselineMs, row.currentMs);
  row.meanChangePercent = change(row.baselineMeanMs, row.currentMeanMs);
  rows.push(row); console.log(JSON.stringify({ planning: row }));
}
for (const pair of plans) {
  const plan = pair.current, component = plan.components.find(value => value.regionalTrunk);
  if (!component) { runtimeRows.push({ seed: plan.seed, regionX: plan.regionX, regionZ: plan.regionZ, reason: 'no-installed-regional-trunk' }); continue; }
  const nativeWorld = new newWorld.World(plan.seed, { waterPlans: [plan], generationVersion: 3 });
  const forcedFineWorld = new newWorld.World(plan.seed, { waterPlans: [plan], generationVersion: 3 });
  forcedFineWorld.waterField.gridStep = () => 2;
  // The archived schema cannot decode an 8m component. Keep its World and
  // builders, but supply the fully validated current field and old 2m policy.
  const sharedBaselineWorld = new oldWorld.World(plan.seed, { generationVersion: 3 });
  sharedBaselineWorld.waterField = Object.create(forcedFineWorld.waterField);
  sharedBaselineWorld.waterPlanHash = forcedFineWorld.waterPlanHash;
  const actualBaselineWorld = new oldWorld.World(plan.seed, { waterPlans: [pair.baseline], generationVersion: 3 });
  const possible = new Map();
  for (let i = 0; i < component.grid.coords.length; i++) {
    if (component.grid.signed[i] <= 1 || component.grid.estuary[i] > .94) continue;
    const [x, z] = component.grid.coords[i].map(n => n * component.grid.step);
    const cx = Math.floor(x / 140), cz = Math.floor(z / 140), key = `${cx},${cz}`;
    if (possible.has(key)) continue;
    if (nativeWorld.waterField.gridStep(cx * 140, cz * 140, (cx + 1) * 140, (cz + 1) * 140) === 4) possible.set(key, [cx, cz]);
  }
  const eligible = [...possible.values()];
  const chunks = [...new Map([.25, .5, .75].map(fraction => {
    const chunk = eligible[Math.floor((eligible.length - 1) * fraction)];
    return [chunk?.join(','), chunk];
  })).values()].filter(Boolean);
  if (!chunks.length) { runtimeRows.push({ seed: plan.seed, regionX: plan.regionX, regionZ: plan.regionZ, reason: 'no-broad-only-chunks' }); continue; }
  const versions = {
    sharedBaseline2m: { world: sharedBaselineWorld, chunks: oldChunks },
    sharedCurrent2m: { world: forcedFineWorld, chunks: newChunks },
    actualBaseline: { world: actualBaselineWorld, chunks: oldChunks },
    actualCurrent: { world: nativeWorld, chunks: newChunks },
  };
  const run = version => chunks.map(([cx, cz]) => {
    const terrain = version.chunks.buildTerrainArrays(version.world, cx, cz, 64, 140);
    const river = version.chunks.buildRiver(cx, cz, 64, 140, terrain.river);
    return { res: terrain.res, terrainTriangles: terrain.indices.length / 3,
      waterTriangles: (river?.indices.length || 0) / 3 };
  });
  const names = Object.keys(versions), times = Object.fromEntries(names.map(name => [name, []])), geometry = {};
  for (const version of Object.values(versions)) run(version);
  for (let repeat = 0; repeat < geometryRuns; repeat++) {
    for (const name of repeat % 2 ? [...names].reverse() : names) {
      const start = performance.now(); geometry[name] = run(versions[name]);
      times[name].push(performance.now() - start);
    }
  }
  const medians = Object.fromEntries(names.map(name => [name, median(times[name])])), means = Object.fromEntries(names.map(name => [name, mean(times[name])]));
  const row = { seed: plan.seed, regionX: plan.regionX, regionZ: plan.regionZ,
    planHash: plan.hash, baselinePlanHash: pair.baseline.hash, trunk: component.hash, chunks,
    times, geometry, medians, means,
    sharedFieldChangePercent: change(medians.sharedBaseline2m, medians.actualCurrent),
    subdivisionChangePercent: change(medians.sharedCurrent2m, medians.actualCurrent),
    actualPlanChangePercent: change(medians.actualBaseline, medians.actualCurrent) };
  runtimeRows.push(row); console.log(JSON.stringify({ terrain: row }));
}
const measured = runtimeRows.filter(row => row.medians), sum = (rows, key) => rows.reduce((n, row) => n + key(row), 0);
const result = { date: new Date().toISOString(), baselineRoot, currentRoot,
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  method: { planning: `${planningRuns} alternating candidate-planning runs per exact seed/region after warming each planner on that case; arithmetic means and medians, no confidence interval.`,
    sharedField: `${geometryRuns} alternating warmed runs. Archived World/chunk builder on the identical fully validated current field with old 2m policy; current builder at 2m and native 4m. Plan construction excluded.`,
    actualPlans: 'Same representative broad-only chunk coordinates; archived/current native builders on their own accepted plans. Changed hydrology/layout is intentional and is reflected in the counts.',
    limits: 'Candidate planning and CPU terrain/water mesh construction only; excludes nine-region conflict resolution/startup, GPU, vegetation, frame rendering, plan decoding and whole-game FPS.' },
  rows, runtimeRows,
  aggregate: {
    planningMedianChangePercent: change(sum(rows, row => row.baselineMs), sum(rows, row => row.currentMs)),
    planningMeanChangePercent: change(sum(rows, row => row.baselineMeanMs), sum(rows, row => row.currentMeanMs)),
    sharedFieldMedianChangePercent: change(sum(measured, row => row.medians.sharedBaseline2m), sum(measured, row => row.medians.actualCurrent)),
    actualPlansMedianChangePercent: change(sum(measured, row => row.medians.actualBaseline), sum(measured, row => row.medians.actualCurrent)),
  },
};
const output = resolve(values.output); await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ aggregate: result.aggregate, output }));
