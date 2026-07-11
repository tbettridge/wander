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
export const LM_HALO = { giant: 28, ring: 22, cairn: 11 }; // tree-free radius

function cellRng(ci, cj, seed) {
  return mulberry32((((ci * 73856093) ^ (cj * 19349663) ^ (seed * 83492791)) >>> 0));
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
    const dx = x - list[i].x, dz = z - list[i].z;
    if (dx * dx + dz * dz < list[i].halo * list[i].halo) return true;
  }
  return false;
}
