// Rare landmarks — deterministic, well-spaced placement across the infinite
// world. THREE-free, so the worker (vegetation clearing-halo) and the main
// thread (LandmarkManager, which builds the meshes) call the exact same
// placement functions and never drift.
//
// Placement is a coarse grid: each ~1.6 km cell deterministically decides
// whether it hosts a landmark, jitters a position inside it (clear of the
// borders so footprints never straddle cells), filters the type by the terrain
// and biome there, and seeds parametric variation.

import { mulberry32 } from './noise.js';

export const LM_CELL = 1600;            // metres per cell (~1 landmark / 2.5 km²)
const PRESENCE = 0.6;                   // fraction of cells that host one
const EDGE_MARGIN = 90;                 // keep landmarks clear of cell borders
export const LM_HALO = { giant: 50, ring: 22, cairn: 11, tower: 14 }; // tree-free radius
export const GREAT_TREE_ARCHETYPES = Object.freeze([
  'cathedral', 'forked', 'open', 'storm', 'hollow',
]);

export function greatTreeArchetype(seed) {
  const rng = mulberry32(seed >>> 0);
  return GREAT_TREE_ARCHETYPES[Math.floor(rng() * GREAT_TREE_ARCHETYPES.length)];
}

function cellRng(ci, cj, seed) {
  return mulberry32((((ci * 73856093) ^ (cj * 19349663) ^ (seed * 83492791)) >>> 0));
}

// tiny 2-D integer hash → [0,1). Used for per-probe jitter where consuming the
// cell rng would make the stream length depend on control flow.
function hash2(i, j) {
  let n = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
  n = (n ^ (n >>> 13)) | 0;
  n = Math.imul(n, 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// The landmark for one cell, or null. Pure function of (ci, cj, seed).
export function landmarkForCell(world, ci, cj, seed) {
  const rng = cellRng(ci, cj, seed);
  if (rng() > PRESENCE) return null;

  const jx = ci * LM_CELL + EDGE_MARGIN + rng() * (LM_CELL - 2 * EDGE_MARGIN);
  const jz = cj * LM_CELL + EDGE_MARGIN + rng() * (LM_CELL - 2 * EDGE_MARGIN);
  const b = world.biomeAt(jx, jz);
  if (b.h < 2.5 || b.slope > 0.5) return null;        // not underwater / on a cliff
  if (world.riverAt(jx, jz).wet) return null;         // not standing in a channel

  // viable types, weighted by environment
  let total = 0; const opts = [];
  const add = (t, w) => { if (w > 0) { opts.push([t, w]); total += w; } };
  add('giant', (b.t > 3 && b.m > 0.33 && b.h < 150) ? 3 : 0);
  add('ring', (b.slope < 0.3 && (b.id === 'grassland' || b.id === 'savanna' ||
               b.id === 'tundra' || b.id === 'taiga' || b.id === 'forest')) ? 2 : 0);
  add('cairn', (b.id === 'tundra' || b.id === 'snow' || b.h > 90) ? 3 : 1);
  // ruined watchtowers claim rises with a view — mid elevation, gentle crown
  add('tower', (b.h > 26 && b.h < 190 && b.slope < 0.32 &&
                (b.id === 'grassland' || b.id === 'savanna' || b.id === 'forest' ||
                 b.id === 'taiga' || b.id === 'tundra')) ? 2.5 : 0);
  if (total === 0) return null;
  let pick = rng() * total, type = opts[0][0];
  for (const [t, w] of opts) { pick -= w; if (pick <= 0) { type = t; break; } }

  return {
    key: ci + '_' + cj,
    x: jx, z: jz, y: b.h, type,
    seed: (((ci * 40503) ^ (cj * 65537) ^ (seed * 19260817)) >>> 0),
    halo: LM_HALO[type],
    yaw: rng() * Math.PI * 2,
  };
}

// All landmarks whose cells fall within `radius` of (px, pz). Reuses `out`.
export function landmarksAround(world, px, pz, seed, radius, out) {
  out.length = 0;
  const i0 = Math.floor((px - radius) / LM_CELL), i1 = Math.floor((px + radius) / LM_CELL);
  const j0 = Math.floor((pz - radius) / LM_CELL), j1 = Math.floor((pz + radius) / LM_CELL);
  for (let cj = j0; cj <= j1; cj++) {
    for (let ci = i0; ci <= i1; ci++) {
      const lm = landmarkForCell(world, ci, cj, seed);
      if (lm) out.push(lm);
    }
  }
  return out;
}

// Is (x, z) inside any landmark's clearing halo?
export function inLandmarkHalo(list, x, z) {
  for (let i = 0; i < list.length; i++) {
    const landmark = list[i];
    const dx = x - landmark.x, dz = z - landmark.z;
    let halo = landmark.halo;
    if (landmark.type === 'giant') {
      // Great-tree shade and root influence form an irregular forest room,
      // rather than the conspicuous circular clearing produced by a fixed
      // radius. This is seed/angle only, so workers and the main thread agree.
      const angle = Math.atan2(dz, dx);
      const phase = (landmark.seed >>> 0) / 4294967296 * Math.PI * 2;
      halo *= 1 + Math.sin(angle * 3 + phase) * 0.08
        + Math.sin(angle * 5 - phase * 0.7) * 0.05;
    }
    if (dx * dx + dz * dz < halo * halo) return true;
  }
  return false;
}

// --- Major landmarks (rare, region-scale) -------------------------------------
// A much coarser 6.4 km grid hosts at most one *major* landmark per cell —
// currently the lighthouse ruin. Placement hunts the cell for a headland: a
// bluff a little above the sea with water wrapping most of the way around it.
// The search costs a few hundred height() samples, so results are memoised
// (worker and main thread each keep their own cache; the function stays pure).

export const MAJOR_CELL = 6400;
export const MAJOR_HALO = { lighthouse: 30 };
const MAJOR_PRESENCE = 0.8;             // coastal cells are already rare — most qualify
const MAJOR_MARGIN = 320;               // keep footprint + halo clear of cell borders

const _majorCache = new Map();          // 'ci_cj_seed' -> landmark | null

// Score a candidate headland at (x, z): a rise above the sea with open water
// on several sides. Tuned to THIS world's coasts, which are gentle shelves —
// water a few hundred metres offshore is only a couple of metres deep, and
// coastal ground climbs slowly (a "bluff" here is 3–15 m, not a sea cliff).
// Returns null when the point isn't coastal.
function headlandScore(world, x, z) {
  const h = world.height(x, z);
  if (h < 3 || h > 45) return null;               // above the wash, below the peaks
  let sea = 0, land = 0, sx = 0, sz = 0;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const cs = Math.cos(a), sn = Math.sin(a);
    const near = world.height(x + cs * 180, z + sn * 180);
    if (near > 2.0) { land++; continue; }
    // confirm real open water (not a puddle) with a second, farther probe
    if (near < -1.0 && world.height(x + cs * 420, z + sn * 420) < -1.5) {
      sea++; sx += cs; sz += sn;
    }
  }
  if (sea < 3 || land < 2) return null;           // shoreline rise, not open water / inland
  // promontories (sea wrapping around) beat straight coast; ~8 m rises beat extremes
  return { score: sea + 2.5 * (1 - Math.abs(h - 8) / 30), h, seaX: sx, seaZ: sz };
}

function computeMajorLandmark(world, ci, cj, seed) {
  const rng = cellRng(ci * 3 + 11, cj * 3 - 7, seed + 0x9e37);
  if (rng() > MAJOR_PRESENCE) return null;

  // coarse scan: a jittered 9×9 probe grid over the cell interior
  const x0 = ci * MAJOR_CELL, z0 = cj * MAJOR_CELL;
  const span = MAJOR_CELL - 2 * MAJOR_MARGIN;
  const N = 9;
  let best = null, bx = 0, bz = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const jx = hash2(ci * 91 + i, cj * 57 + j) - 0.5;
      const jz = hash2(ci * 37 + i + 40, cj * 73 + j + 21) - 0.5;
      const x = x0 + MAJOR_MARGIN + ((i + 0.5) / N + (jx * 0.6) / N) * span;
      const z = z0 + MAJOR_MARGIN + ((j + 0.5) / N + (jz * 0.6) / N) * span;
      const s = headlandScore(world, x, z);
      if (s && (!best || s.score > best.score)) { best = s; bx = x; bz = z; }
    }
  }
  if (!best) return null;

  // hill-climb refinement toward the strongest headland nearby
  for (const step of [110, 45]) {
    for (let it = 0; it < 3; it++) {
      let moved = false;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const x = bx + Math.cos(a) * step, z = bz + Math.sin(a) * step;
        if (x < x0 + MAJOR_MARGIN * 0.5 || x > x0 + MAJOR_CELL - MAJOR_MARGIN * 0.5 ||
            z < z0 + MAJOR_MARGIN * 0.5 || z > z0 + MAJOR_CELL - MAJOR_MARGIN * 0.5) continue;
        const s = headlandScore(world, x, z);
        if (s && s.score > best.score) { best = s; bx = x; bz = z; moved = true; }
      }
      if (!moved) break;
    }
  }

  const b = world.biomeAt(bx, bz);
  if (b.slope > 0.42) return null;                // can't seat a tower on a cliff face
  if (world.riverAt(bx, bz).wet) return null;
  const lmSeed = (((ci * 48271) ^ (cj * 16807) ^ (seed * 22468225)) >>> 0);
  const hrng = mulberry32(lmSeed);
  return {
    key: 'M' + ci + '_' + cj,
    x: bx, z: bz, y: b.h, type: 'lighthouse',
    seed: lmSeed,
    halo: MAJOR_HALO.lighthouse,
    // local +X faces the open sea (rotation.y maps +X → (cos yaw, −sin yaw))
    yaw: Math.atan2(-best.seaZ, best.seaX),
    towerH: 22 + hrng() * 8,                      // shared by builder + beam fx
  };
}

// The major landmark for one 6.4 km cell, or null. Memoised pure function.
export function majorLandmarkForCell(world, ci, cj, seed) {
  const key = ci + '_' + cj + '_' + seed;
  if (_majorCache.has(key)) return _majorCache.get(key);
  const lm = computeMajorLandmark(world, ci, cj, seed);
  if (_majorCache.size >= 320) _majorCache.delete(_majorCache.keys().next().value);
  _majorCache.set(key, lm);
  return lm;
}

// All major landmarks whose cells fall within `radius` of (px, pz). Appends to
// `out` when `append` (so chunkgen can pool them with the standard halo list).
export function majorLandmarksAround(world, px, pz, seed, radius, out, append = false) {
  if (!append) out.length = 0;
  const i0 = Math.floor((px - radius) / MAJOR_CELL), i1 = Math.floor((px + radius) / MAJOR_CELL);
  const j0 = Math.floor((pz - radius) / MAJOR_CELL), j1 = Math.floor((pz + radius) / MAJOR_CELL);
  for (let cj = j0; cj <= j1; cj++) {
    for (let ci = i0; ci <= i1; ci++) {
      const lm = majorLandmarkForCell(world, ci, cj, seed);
      if (lm) out.push(lm);
    }
  }
  return out;
}

// Nearest major landmark, searching outward ring by ring over the coarse grid.
// A debug/teleport helper — the first call over unexplored cells is the pricey
// one (each cell's headland search), after which everything is cached.
export function nearestMajorLandmark(world, px, pz, seed, maxRings = 8) {
  const ci0 = Math.floor(px / MAJOR_CELL), cj0 = Math.floor(pz / MAJOR_CELL);
  for (let r = 0; r <= maxRings; r++) {
    let bestLm = null, bd = Infinity;
    for (let cj = cj0 - r; cj <= cj0 + r; cj++) {
      for (let ci = ci0 - r; ci <= ci0 + r; ci++) {
        if (Math.max(Math.abs(ci - ci0), Math.abs(cj - cj0)) !== r) continue;
        const lm = majorLandmarkForCell(world, ci, cj, seed);
        if (!lm) continue;
        const d = (lm.x - px) ** 2 + (lm.z - pz) ** 2;
        if (d < bd) { bd = d; bestLm = lm; }
      }
    }
    if (bestLm) return bestLm;
  }
  return null;
}
