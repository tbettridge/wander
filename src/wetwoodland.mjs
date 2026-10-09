// Still pools in wet woodland.
//
// Alder carr lies in the wettest low ground, and its hollows hold water: dark,
// still pools between the tussocks that mirror the trees. They are not part of
// the planned hydrology (no river feeds them, nothing can drain them); they are
// a surface laid into hollows of the terrain, so they never move a bank, a
// village or the railway. Each sits a few centimetres above the lowest ground
// of its hollow, and where the rim of the hollow rises above that level the
// terrain itself draws the shoreline.
//
// Deterministic from the world: one candidate per POOL_CELL lattice cell, so
// the worker that builds a chunk's pools, the placement that keeps plants out
// of them and the reflection that mirrors them all agree. Pure and THREE-free.

import { mulberry32 } from './noise.js';
import { settlementsAround } from './settlementplacement.mjs';
import { nearestTrailPoint, trailsAround } from './trails.js';

export const POOL_CELL = 26;
const POOL_MAX_RADIUS = 7.2;
const CACHE_LIMIT = 6000;
const _stand = {};
const _trail = {};

function cacheFor(world) {
  return world._wetPoolCache || (world._wetPoolCache = new Map());
}

function cellSeed(world, ix, iz) {
  return (Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663) ^ Math.imul(world.seed | 0, 83492791) ^ 0x504f4f4c) >>> 0;
}

/** The pool in lattice cell (ix, iz), or null. Cached per world. */
export function wetPoolForCell(world, ix, iz) {
  const cache = cacheFor(world);
  const key = `${ix},${iz}`;
  if (cache.has(key)) return cache.get(key);
  const pool = planPool(world, ix, iz);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, pool);
  return pool;
}

function planPool(world, ix, iz) {
  const rng = mulberry32(cellSeed(world, ix, iz));
  if (rng() > 0.62) return null;
  const x = (ix + 0.22 + rng() * 0.56) * POOL_CELL;
  const z = (iz + 0.22 + rng() * 0.56) * POOL_CELL;
  const r = 2.4 + rng() * (POOL_MAX_RADIUS - 2.4) * (0.4 + 0.6 * rng());
  const yaw = rng() * Math.PI * 2, seed = rng(), lilies = rng();
  const b = world.biomeAt(x, z);
  if (b.id !== 'forest' || b.slope > 0.09 || !world.forestStand) return null;
  if (world.forestStand(x, z, b.m, b.t, b.h, _stand).wet < 0.6) return null;
  // A hollow, not a hump or a slope: the rim stands level with or a little
  // above the middle, and no more than a few tens of centimetres either way.
  const centre = b.h;
  let rimMin = Infinity, rimMax = -Infinity, rimSum = 0;
  for (let k = 0; k < 8; k++) {
    const a = yaw + (k / 8) * Math.PI * 2;
    const h = world.height(x + Math.cos(a) * r * 0.92, z + Math.sin(a) * r * 0.92);
    rimMin = Math.min(rimMin, h); rimMax = Math.max(rimMax, h); rimSum += h;
  }
  const rimMean = rimSum / 8;
  if (rimMax - rimMin > 0.5 || rimMean < centre - 0.06 || rimMean - centre > 0.6) return null;
  const water = world.riverAt(x, z);
  if (water.wet) return null;   // real water already lies here
  if (world.railwayClearanceAt) {
    const rail = world.railwayClearanceAt(x, z);
    if (rail && (rail.plantClearance > 0 || rail.grassClearance > 0)) return null;
  }
  for (const site of settlementsAround(world, x, z, world.seed, r + 40, [])) {
    if (Math.hypot(site.x - x, site.z - z) < (site.exclusionHalo || site.radius || 60) + r) return null;
  }
  const trails = trailsAround(world, x, z, world.seed, r + 30, []);
  if (trails.length) {
    nearestTrailPoint(trails, x, z, _trail);
    if (_trail.distance < r + 2.5 + (_trail.width || 0)) return null;
  }
  // Brim the hollow: level with the middle of the rim where it rises, never
  // much above the middle of the pool, so the water lies IN the ground.
  const y = Math.min(centre + 0.32, Math.max(centre + 0.05, rimMean - 0.04));
  return { id: `pool:${ix}:${iz}`, x, z, y, r, yaw, seed, lilies };
}

/** Every pool whose centre lies in the rectangle [x0, x1) × [z0, z1). */
export function wetPoolsInRect(world, x0, z0, x1, z1, out = []) {
  out.length = 0;
  const i0 = Math.floor(x0 / POOL_CELL), i1 = Math.floor((x1 - 1e-6) / POOL_CELL);
  const j0 = Math.floor(z0 / POOL_CELL), j1 = Math.floor((z1 - 1e-6) / POOL_CELL);
  for (let iz = j0; iz <= j1; iz++) for (let ix = i0; ix <= i1; ix++) {
    const pool = wetPoolForCell(world, ix, iz);
    if (pool && pool.x >= x0 && pool.x < x1 && pool.z >= z0 && pool.z < z1) out.push(pool);
  }
  return out;
}

/**
 * The pool covering (x, z), if any, widened by `margin` metres. Cheap enough
 * to ask for every plant: outside wet woodland it costs one stand lookup.
 */
export function wetPoolAt(world, x, z, margin = 0.3, b = null) {
  if (b && b.id !== 'forest') return null;
  // Pools need wet woodland at their centre, and the stand changes over
  // a hundred metres or more, so ground well outside it can skip the lattice.
  if (b && world.forestStand && world.forestStand(x, z, b.m, b.t, b.h, _stand).wet < 0.3) return null;
  const ic = Math.floor(x / POOL_CELL), jc = Math.floor(z / POOL_CELL);
  for (let iz = jc - 1; iz <= jc + 1; iz++) for (let ix = ic - 1; ix <= ic + 1; ix++) {
    const pool = wetPoolForCell(world, ix, iz);
    if (!pool) continue;
    const d = Math.hypot(x - pool.x, z - pool.z);
    if (d < pool.r + margin) return pool;
  }
  return null;
}
