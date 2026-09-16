import { priorityFlood, floodBasin } from './drainage.mjs';
import { descriptorHash, BASIN_PLAN_VERSION, BASIN_REGION_SIZE } from './hydrologyformat.mjs';
export { BASIN_PLAN_VERSION, BASIN_REGION_SIZE } from './hydrologyformat.mjs';
const SURVEY_STEP = 32;
const REFINE_STEP = 8;
const SURVEY_HALO = 512;

function sampleGrid(world, x0, z0, size, step) {
  const width = Math.round(size / step) + 1, heights = new Float64Array(width * width);
  for (let z = 0; z < width; z++) for (let x = 0; x < width; x++) {
    heights[z * width + x] = world._naturalHeight(x0 + x * step, z0 + z * step);
  }
  return { x0, z0, width, step, heights };
}

function refineCandidate(world, x, z, reservations, maxLength, blockedAt) {
  // A globally anchored window makes the same depression identical when
  // discovered from either neighbouring survey. Boundary spill is unresolved.
  const size = 1024;
  const grid = sampleGrid(world, Math.floor((x - size / 2) / REFINE_STEP) * REFINE_STEP,
    Math.floor((z - size / 2) / REFINE_STEP) * REFINE_STEP, size, REFINE_STEP);
  const { heights, width, step, x0, z0 } = grid;
  const start = Math.round((z - z0) / step) * width + Math.round((x - x0) / step);
  const drainage = priorityFlood(heights, width);
  const spill = drainage.filled[start];
  if (spill - heights[start] < 0.65 || spill < 1.25) return { rejected: 'insufficient-relief' };
  // Leave a genuine dry sill above closed water. This first basin family does
  // not invent a stream outlet where the valley graph has not supplied one.
  const level = spill - Math.min(0.45, (spill - heights[start]) * 0.22);
  const flood = floodBasin(heights, width, start, level);
  if (flood.boundary) return { rejected: 'unresolved-boundary' };
  if (flood.cells.length < 5) return { rejected: 'too-small' };
  let minX = width, minZ = width, maxX = 0, maxZ = 0, maxDepth = 0, deepest = start;
  for (const i of flood.cells) {
    const gx = i % width, gz = Math.floor(i / width);
    minX = Math.min(minX, gx); maxX = Math.max(maxX, gx);
    minZ = Math.min(minZ, gz); maxZ = Math.max(maxZ, gz);
    if (level - heights[i] > maxDepth) { maxDepth = level - heights[i]; deepest = i; }
  }
  const length = Math.max(maxX - minX, maxZ - minZ) * step;
  if (length > maxLength || maxDepth > (length <= 100 ? 3 : 15)) return { rejected: 'scale-budget' };
  const centerX = x0 + (deepest % width) * step, centerZ = z0 + Math.floor(deepest / width) * step;
  const ownerX = Math.floor(centerX / BASIN_REGION_SIZE), ownerZ = Math.floor(centerZ / BASIN_REGION_SIZE);
  minX = Math.max(0, minX - 3); minZ = Math.max(0, minZ - 3);
  maxX = Math.min(width - 1, maxX + 3); maxZ = Math.min(width - 1, maxZ + 3);
  const cols = maxX - minX + 1, rows = maxZ - minZ + 1;
  const floor = [], signed = [];
  // A dry collar covers shore interpolation and blends the conditioning back
  // to the fine natural relief. Reject crossings and existing rivers throughout
  // that collar, not just at the deepest point of the proposed lake.
  for (let gz = minZ; gz <= maxZ; gz++) for (let gx = minX; gx <= maxX; gx++) {
    const i = gz * width + gx, px = x0 + gx * step, pz = z0 + gz * step;
    if (reservations?.at(px, pz) || reservations?.routeAt(px, pz)) return { rejected: 'protected-crossing' };
    if (blockedAt?.(px, pz)) return { rejected: 'protected-site' };
    const old = {};
    world.height(px, pz, old);
    if (old.riverInfluence || world.railwayClearanceAt?.(px, pz, {})?.plantClearance > 0) {
      return { rejected: 'existing-corridor' };
    }
    floor.push(heights[i]);
    signed.push(flood.mask[i] ? level - heights[i] : Math.min(-0.001, level - heights[i]));
  }
  const area = flood.cells.length * step * step;
  const kind = length <= 100 ? 'pond' : 'lake';
  const climate = world.climate(centerX, centerZ, level);
  if (climate.m < 0.38 || climate.t < -2) return { rejected: 'climate' };
  const descriptor = {
    id: `basin:${world.seed}:${centerX}:${centerZ}`, version: BASIN_PLAN_VERSION,
    kind, form: kind === 'pond' ? 'closed-depression' : level > 45 ? 'rock-basin' : 'valley-basin',
    ownerX, ownerZ, centerX, centerZ, level, spill, drainage: 'closed',
    area, length, maxDepth, rim: flood.rim,
    bounds: { minX: x0 + minX * step, minZ: z0 + minZ * step,
      maxX: x0 + maxX * step, maxZ: z0 + maxZ * step },
    grid: { x0: x0 + minX * step, z0: z0 + minZ * step, cols, rows, step, floor, signed },
    material: { kind: kind === 'pond' ? 1 : 2, turbidity: kind === 'pond' ? 0.65 : level > 45 ? 0.12 : 0.35,
      exposure: Math.min(1, length / 500), turbulence: 0, estuary: 0 },
  };
  return { descriptor };
}

export function planBasins(world, regionX, regionZ, { reservations = null, maxBasins = 4, blockedAt = null, minSpacing = 700 } = {}) {
  if (!Number.isInteger(regionX) || !Number.isInteger(regionZ)) throw new Error('Invalid basin region');
  if (!Number.isFinite(minSpacing) || minSpacing < 96 || minSpacing > 700) throw new Error('Invalid basin spacing');
  const startTime = performance.now();
  const x0 = regionX * BASIN_REGION_SIZE, z0 = regionZ * BASIN_REGION_SIZE;
  const grid = sampleGrid(world, x0 - SURVEY_HALO, z0 - SURVEY_HALO,
    BASIN_REGION_SIZE + 2 * SURVEY_HALO, SURVEY_STEP);
  const { heights, width, step } = grid, drainage = priorityFlood(heights, width);
  const candidates = [];
  for (let z = 1; z < width - 1; z++) for (let x = 1; x < width - 1; x++) {
    const i = z * width + x, h = heights[i];
    if (h < 1 || drainage.filled[i] - h < 0.9) continue;
    if ([i - 1, i + 1, i - width, i + width].some(n => heights[n] < h || (heights[n] === h && n < i))) continue;
    const px = grid.x0 + x * step, pz = grid.z0 + z * step;
    if (px < x0 || pz < z0 || px >= x0 + BASIN_REGION_SIZE || pz >= z0 + BASIN_REGION_SIZE) continue;
    const rank = Number.parseInt(descriptorHash([world.seed, px, pz]), 16) / 0xffffffff;
    candidates.push({ x: px, z: pz, rank, relief: drainage.filled[i] - h });
  }
  // Spacing is a suitability gate, and the random rank only orders real
  // depressions. There is deliberately no minimum number of lakes per tile.
  candidates.sort((a, b) => a.rank - b.rank || a.x - b.x || a.z - b.z);
  const basins = [], rejected = {}, seen = new Set();
  const allowLake = Number.parseInt(descriptorHash(['lake-region', world.seed, regionX, regionZ]), 16) / 0xffffffff < 0.24;
  let examined = 0;
  for (const candidate of candidates) {
    if (basins.length >= maxBasins || examined >= 24) break;
    if (basins.some(b => Math.hypot(b.centerX - candidate.x, b.centerZ - candidate.z) < minSpacing)) continue;
    examined++;
    // Large basins are rarer; suitability and parent ownership must still pass.
    const maxLength = allowLake && !basins.some(b => b.kind === 'lake') ? 600 : 100;
    const result = refineCandidate(world, candidate.x, candidate.z, reservations, maxLength, blockedAt);
    if (result.rejected) { rejected[result.rejected] = (rejected[result.rejected] || 0) + 1; continue; }
    const b = result.descriptor;
    if (b.ownerX !== regionX || b.ownerZ !== regionZ) { rejected['parent-owner'] = (rejected['parent-owner'] || 0) + 1; continue; }
    if (seen.has(b.id)) continue;
    seen.add(b.id); basins.push(b);
  }
  basins.sort((a, b) => a.id.localeCompare(b.id));
  const plan = { version: BASIN_PLAN_VERSION, seed: world.seed, regionX, regionZ, basins };
  return { ...plan, hash: descriptorHash(plan), diagnostics: {
    candidates: candidates.length, examined, rejected, milliseconds: performance.now() - startTime,
    bytes: JSON.stringify(plan).length,
  } };
}
