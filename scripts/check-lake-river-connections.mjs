// Installed regional coverage, including admission budgets and fallback lakes.
// Run: node scripts/check-lake-river-connections.mjs --extended
import { planWaterRegionCandidates } from '../src/hydrologyregions.mjs';
import { WATER_CACHE_REVISION } from '../src/hydrologyformat.mjs';

const cases = [20260612, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 42, 4242].map(seed => [seed, 0, 0]);
if (process.argv.includes('--extended')) for (const seed of [1, 7, 42, 4242, 20260612, 987654]) {
  for (const [x, z] of [[-3, -2], [-2, 3], [2, -3], [3, 2], [8, 5], [-8, -5]]) cases.push([seed, x, z]);
}
const regions = cases.map(([seed, regionX, regionZ], index) => {
  const plan = planWaterRegionCandidates(seed, regionX, regionZ);
  console.error(`Surveyed ${index + 1}/${cases.length}: seed ${seed}, region ${regionX},${regionZ}`);
  return { seed, regionX, regionZ, hash: plan.hash, ...plan.diagnostics };
});
const sum = key => regions.reduce((n, region) => n + region[key], 0);
console.log(JSON.stringify({ revision: WATER_CACHE_REVISION, summary: {
  regions: regions.length, lakeLinks: sum('lakeLinks'), riverLinks: sum('riverLinks'), multipleInletBodies: sum('multipleInlets'),
  inlets: sum('inlets'), connectedLakeSystems: sum('flowing'), closedBasins: sum('closed'),
}, regions }, null, 2));
