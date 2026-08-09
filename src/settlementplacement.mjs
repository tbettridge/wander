import { mulberry32 } from './noise.js';
import { stationSettlements, suppressedByStation } from './stationsettlement.mjs';

export const SETTLEMENT_CELL = 3200;
export const SETTLEMENT_GENERATION_VERSION = 1;
const MARGIN = 360;
const PRESENCE = 0.58;
const CANDIDATES = 32;
const RADII = Object.freeze({ farmstead: 70, hamlet: 130, village: 230, town: 380 });
const cache = new Map();

function hash(ci, cj, seed, channel = 0) {
  return (Math.imul(ci, 73856093) ^ Math.imul(cj, 19349663)
    ^ Math.imul(seed >>> 0, 83492791) ^ Math.imul(channel, 2654435761)) >>> 0;
}

function kindFor(roll) {
  if (roll < 0.62) return 'farmstead';
  if (roll < 0.84) return 'hamlet';
  if (roll < 0.96) return 'village';
  return 'town';
}

function terrainScore(world, x, z) {
  const biome = world.biomeAt(x, z);
  if (!biome || biome.h < 2.5 || biome.slope > 0.34 || world.riverAt(x, z).wet) return null;
  const e = 28;
  const relief = Math.max(
    Math.abs(world.height(x + e, z) - biome.h), Math.abs(world.height(x - e, z) - biome.h),
    Math.abs(world.height(x, z + e) - biome.h), Math.abs(world.height(x, z - e) - biome.h));
  if (relief > 8) return null;
  const moistureFit = 1 - Math.abs((biome.m ?? 0.5) - 0.55);
  return 8 - biome.slope * 15 - relief * 0.35 + moistureFit * 2;
}

export function settlementForCell(world, ci, cj, seed = world?.seed ?? 1) {
  const cacheKey = `${seed >>> 0}:${ci}:${cj}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const cellSeed = hash(ci, cj, seed);
  const rng = mulberry32(cellSeed);
  if (rng() > PRESENCE) { cache.set(cacheKey, null); return null; }
  const baseX = ci * SETTLEMENT_CELL;
  const baseZ = cj * SETTLEMENT_CELL;
  const span = SETTLEMENT_CELL - MARGIN * 2;
  let best = null;
  for (let i = 0; i < CANDIDATES; i++) {
    const probe = mulberry32(hash(ci, cj, seed, i + 1));
    const x = baseX + MARGIN + probe() * span;
    const z = baseZ + MARGIN + probe() * span;
    const score = terrainScore(world, x, z);
    if (score === null) continue;
    const ranked = score + probe() * 1.5;
    if (!best || ranked > best.score) best = { x, z, score: ranked, biome: world.biomeAt(x, z) };
  }
  if (!best) { cache.set(cacheKey, null); return null; }
  const kind = kindFor(rng());
  const radius = RADII[kind];
  const yaw = rng() * Math.PI * 2;
  const id = `settlement:${ci}:${cj}`;
  const entranceDistance = radius * 0.82;
  const result = Object.freeze({
    id, key: id, kind, seed: cellSeed, worldSeed: seed >>> 0, generationVersion: SETTLEMENT_GENERATION_VERSION,
    x: best.x, y: best.biome.h, z: best.z, yaw, radius,
    bounds: { minX: best.x - radius, maxX: best.x + radius, minZ: best.z - radius, maxZ: best.z + radius },
    exclusionHalo: radius + 24,
    regionalEntrance: {
      key: `${id}:entrance`,
      x: best.x + Math.cos(yaw) * entranceDistance,
      y: world.height(best.x + Math.cos(yaw) * entranceDistance, best.z + Math.sin(yaw) * entranceDistance),
      z: best.z + Math.sin(yaw) * entranceDistance,
    },
    trailClass: kind === 'town' || kind === 'village' ? 'primary' : 'secondary',
    silhouetteCue: kind === 'town' ? 'spire' : kind === 'village' ? 'hall' : kind === 'hamlet' ? 'chimneys' : 'roof',
    planHash: `${cellSeed.toString(36)}:${SETTLEMENT_GENERATION_VERSION}`,
  });
  cache.set(cacheKey, result);
  if (cache.size > 4096) cache.delete(cache.keys().next().value);
  return result;
}

/**
 * Every settlement whose ground falls within `radius` of (x, z).
 *
 * Two sources meet here. The grid cells above are a pure function of position
 * and seed; the station villages are not — they exist only once a railway plan
 * has been installed on the world (see stationsettlement.mjs). Merging them at
 * the query rather than at the source keeps `settlementForCell` pure, and gives
 * suppression one place to happen instead of every caller remembering it.
 *
 * A grid settlement near a station is dropped rather than moved. Moving it
 * would change where it is as a function of something it cannot see, and two
 * placers quietly disagreeing about the same ground is the bug this avoids.
 */
export function settlementsAround(world, x, z, seed, radius, out = []) {
  out.length = 0;
  const i0 = Math.floor((x - radius) / SETTLEMENT_CELL), i1 = Math.floor((x + radius) / SETTLEMENT_CELL);
  const j0 = Math.floor((z - radius) / SETTLEMENT_CELL), j1 = Math.floor((z + radius) / SETTLEMENT_CELL);
  for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) {
    const site = settlementForCell(world, ci, cj, seed);
    if (!site || suppressedByStation(world, site.x, site.z)) continue;
    if (Math.hypot(site.x - x, site.z - z) <= radius + site.radius) out.push(site);
  }
  for (const site of stationSettlements(world, seed)) {
    if (Math.hypot(site.x - x, site.z - z) <= radius + site.radius) out.push(site);
  }
  return out;
}

export function nearestSettlement(world, x, z, seed = world?.seed ?? 1, maxRings = 8) {
  const ci0 = Math.floor(x / SETTLEMENT_CELL), cj0 = Math.floor(z / SETTLEMENT_CELL);
  let best = null, bestD = Infinity;
  // Station villages are few and unsorted by cell, so they are considered up
  // front; the ring search below can then still terminate early on distance.
  for (const site of stationSettlements(world, seed)) {
    const d = Math.hypot(site.x - x, site.z - z);
    if (d < bestD) { best = site; bestD = d; }
  }
  for (let r = 0; r <= maxRings; r++) {
    for (let cj = cj0 - r; cj <= cj0 + r; cj++) for (let ci = ci0 - r; ci <= ci0 + r; ci++) {
      if (Math.max(Math.abs(ci - ci0), Math.abs(cj - cj0)) !== r) continue;
      const site = settlementForCell(world, ci, cj, seed);
      if (!site || suppressedByStation(world, site.x, site.z)) continue;
      const d = Math.hypot(site.x - x, site.z - z);
      if (d < bestD) { best = site; bestD = d; }
    }
    if (best && bestD < r * SETTLEMENT_CELL) break;
  }
  return best;
}

export function inSettlementHalo(sites, x, z) {
  return sites.some((site) => (site.x - x) ** 2 + (site.z - z) ** 2 < site.exclusionHalo ** 2);
}
