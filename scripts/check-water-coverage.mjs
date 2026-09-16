// Bounded development survey. Run with: node scripts/check-water-coverage.mjs
import { World } from '../src/world.js';
import { planBasins } from '../src/basinplanner.mjs';
import { connectInlandBasins } from '../src/basinconnections.mjs';
import { planLakeSystem } from '../src/basininlets.mjs';

const cases = [20260612, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 42, 4242].map(seed => [seed, 0, 0]);
for (const seed of [42, 4242]) for (const [x, z] of [[-1, 0], [0, 1], [1, 0]]) cases.push([seed, x, z]);
if (process.argv.includes('--extended')) {
  for (const seed of [1, 7, 42, 4242, 20260612, 987654]) {
    for (const [x, z] of [[-3, -2], [-2, 3], [2, -3], [3, 2], [8, 5], [-8, -5]]) cases.push([seed, x, z]);
  }
}
const tally = values => values.reduce((counts, value) => { counts[value] = (counts[value] || 0) + 1; return counts; }, {});
const regions = [];
for (const [seed, regionX, regionZ] of cases) {
  const world = new World(seed, { generationVersion: 3 });
  const basins = planBasins(world, regionX, regionZ).basins;
  const bodies = basins.map(basin => {
    const start = performance.now(), result = planLakeSystem(world, basin, { outlet: { hydraulicRouting: !process.argv.includes('--legacy-routing') } });
    return { id: basin.id, kind: basin.kind, level: basin.level,
      biome: world.biomeAt(basin.centerX, basin.centerZ).id,
      status: result.status, stage: result.stage, reason: result.reason,
      inland: !!result.inland,
      center: [basin.centerX, basin.centerZ], length: basin.length,
      inletRejections: result.inletDiagnostics?.rejected || [],
      inlets: result.inletCount || 0, vertices: result.mesh?.grid.coords.length || 0,
      visited: result.visited || 0, inletVisited: result.inletDiagnostics?.visited || 0,
      attempts: typeof result.attempts === 'number' ? result.attempts : result.attempts?.length || 0,
      milliseconds: Math.round(performance.now() - start) };
  });
  const connections = [];
  if (process.argv.includes('--connections')) for (const source of basins) for (const target of basins) {
    if (source.level <= target.level + 0.2 || Math.hypot(source.centerX - target.centerX, source.centerZ - target.centerZ) > 1400) continue;
    const result = connectInlandBasins(world, source, target);
    connections.push({ sourceId: source.id, targetId: target.id, status: result.status, reason: result.reason, visited: result.visited });
  }
  regions.push({ seed, regionX, regionZ, bodies, connections });
  console.error(`Surveyed ${regions.length}/${cases.length}: seed ${seed}, region ${regionX},${regionZ}, ${bodies.length} basins`);
}
const bodies = regions.flatMap(r => r.bodies), accepted = bodies.filter(b => b.status === 'baked');
console.log(JSON.stringify({ summary: { regions: regions.length, basins: bodies.length,
  failures: tally(bodies.filter(b => b.status !== 'baked').map(b => `${b.stage || 'unknown'}:${b.reason}`)),
  inletRejections: tally(accepted.flatMap(b => b.inletRejections)),
  inlandConnections: regions.flatMap(r => r.connections).filter(c => c.status === 'baked').length,
  multipleInletBodies: accepted.filter(b => b.inlets > 1).length,
  flowingBodies: accepted.length, streamFedBodies: accepted.filter(b => b.inlets > 0).length,
  biomes: [...new Set(bodies.map(b => b.biome))].sort(),
  acceptedBiomes: [...new Set(accepted.map(b => b.biome))].sort() }, regions }, null, 2));
