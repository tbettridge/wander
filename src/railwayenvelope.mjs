// The train's clearance envelope, and what may not stand in it.
//
// A train passes through anything in its way: terrain, rocks, trees. A rider
// sees each one as the carriage sliding through solid ground. This module
// states the space the line must keep empty, in the frame of the nearest track
// segment, and answers two questions about it:
//
//  * does a scattered prop (a rock, a boulder, a tree trunk) reach into it?
//    The chunk generator asks this before emitting an instance, so a cluster
//    seated beside the line, or a boulder buried in the hill above a tunnel,
//    is never generated where the train will pass through it;
//  * does the terrain, as the chunk mesh actually draws it, rise into it?
//    `auditRailwayClearance` walks the whole line for that, and for the props,
//    so a test can hold every seed to the same promise.
//
// Pure and THREE-free so the worker, the main thread and Node tests share it.

import { TUNNEL_PROFILE } from './railwaytunnel.mjs';
import { ROCK_ARCHETYPES } from './rockgeometry.mjs';

// Open line (surface, cutting, embankment, bridge, station): a carriage is
// 2.55m wide and about 3.4m tall over the rail, the engine's chimney a little
// more. Retaining walls stand at 2.35m, so 2.3m is the lateral edge of the
// space a rider sees sweep past. The floor sits just above the rail formation:
// ground and stone may come up to the ballast, never over the rails.
//
// Tunnel: the bore is the lining tube itself (2.75m half-width, crown 5m over
// the formation) plus the thickness a rib ring stands proud of it. Anything
// inside it is seen from the carriage window; anything outside it is hidden by
// the lining.
export const RAILWAY_CLEARANCE = Object.freeze({
  halfWidth: 2.3,
  floor: 0.12,
  top: 4.8,
  boreHalfWidth: TUNNEL_PROFILE.halfWidth + 0.25,
  boreFloor: TUNNEL_PROFILE.floorY,
  boreTop: TUNNEL_PROFILE.crownY + 0.35,
});

// Furthest a prop's centre can stand from the line and still reach in: the
// largest hero boulder is ~8.5m scale on a ~1.4m half-extent mesh.
export const RAILWAY_PROP_REACH = 16;

// Local half-extents of the planar rock mesh for each archetype, as the
// largest values `makePlanarRockMesh` can draw before its corner slices (which
// only remove material). Index = variant % archetype count, matching
// createVegetationLibrary's rockVariants.
function rockHalfExtents(archetype, boulder) {
  let hx = 1.06, hy = 0.86, hz = 1.06;
  if (archetype === 'slab') { hx *= 1.18; hy *= 0.55; hz *= 1.22; }
  else if (archetype === 'monolith') { hx *= 0.70; hy *= 1.48; hz *= 0.72; }
  else if (archetype === 'wedge') { hx *= 1.12; hz *= 1.08; }
  else if (archetype === 'shoulder') { hx *= 1.18; hy *= 1.08; }
  else if (archetype === 'split') { hz *= 1.18; }
  if (boulder) { hx *= 1.08; hy *= 0.96; hz *= 1.08; }
  return [hx, hy, hz];
}

const ROCK_BOUNDS = ROCK_ARCHETYPES.map((archetype) => rockHalfExtents(archetype, false));
const BOULDER_BOUNDS = ROCK_ARCHETYPES.map((archetype) => rockHalfExtents(archetype, true));

// Tree trunks: the canopy is above the train and its edges are already kept
// well back by treeClearance; the trunk is what a carriage would pass through.
// A unit tree's trunk is well under a metre across and the train is under 5m
// tall, so a 0.45m x 6m column (centred 3m up) bounds what matters.
const TRUNK = Object.freeze({ half: [0.45, 3, 0.45], centreY: 3 });
const TREE_TYPES = new Set([
  'conifer', 'broadleaf', 'oak', 'birch', 'willow', 'poplar', 'baobab', 'blossom',
  'apple', 'drytree', 'palm', 'deadtree', 'ancientoak', 'ancientfir', 'snag',
]);

/**
 * Local bounding box of a scatter instance, `{ half: [x, y, z], centreY }`, or
 * null for types the corridor does not police (grass, flowers and the other
 * soft clutter already thinned well back from the line by clearance weights).
 */
export function railwayPropBounds(type, variant = 0) {
  const archetypeIndex = ((variant | 0) % ROCK_ARCHETYPES.length + ROCK_ARCHETYPES.length)
    % ROCK_ARCHETYPES.length;
  if (type === 'rock' || type === 'pebble') return { half: ROCK_BOUNDS[archetypeIndex], centreY: 0 };
  if (type === 'boulder' || type === 'mossRock') return { half: BOULDER_BOUNDS[archetypeIndex], centreY: 0 };
  if (TREE_TYPES.has(type)) return TRUNK;
  return null;
}

/**
 * The corridor frame at (x, z) on `index` (a RailwayTerrainIndex): nearest
 * segment, its structure, the rail formation height there and the lateral
 * axis. Null when the line is not within reach.
 */
export function railwayCorridorAt(index, x, z, out = {}) {
  if (!index) return null;
  const bin = index._bin(Math.floor(x / index.binSize), Math.floor(z / index.binSize));
  if (!bin) return null;
  let best = Infinity, bestIndex = -1, bestT = 0;
  const segments = index.segments;
  for (const i of bin.segments) {
    const o = i * 6;
    const ax = segments[o], az = segments[o + 1], bx = segments[o + 3], bz = segments[o + 4];
    const dx = bx - ax, dz = bz - az;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSq)) : 0;
    const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (d < best) { best = d; bestIndex = i; bestT = t; }
  }
  if (bestIndex < 0) return null;
  const o = bestIndex * 6;
  const ax = segments[o], az = segments[o + 1], bx = segments[o + 3], bz = segments[o + 4];
  const length = Math.hypot(bx - ax, bz - az) || 1;
  out.segment = bestIndex;
  out.kind = index.kinds[bestIndex];
  out.tunnel = out.kind === 4;
  out.distance = best;
  out.x = ax + (bx - ax) * bestT;
  out.z = az + (bz - az) * bestT;
  out.formation = segments[o + 2] + (segments[o + 5] - segments[o + 2]) * bestT;
  out.tangentX = (bx - ax) / length;
  out.tangentZ = (bz - az) / length;
  out.rightX = out.tangentZ;
  out.rightZ = -out.tangentX;
  return out;
}

const _corridor = {};
const _corner = [0, 0, 0];

/**
 * Does the box `bounds` (local half-extents, centred `centreY` up), placed by
 * the column-major 4x4 `matrix` (at `offset`), reach into the train's
 * clearance? Returns the corridor frame it hit, or null.
 */
export function railwayPropIntrudes(index, matrix, offset, bounds) {
  if (!index || !bounds) return null;
  const x = matrix[offset + 12], z = matrix[offset + 14];
  const corridor = railwayCorridorAt(index, x, z, _corridor);
  if (!corridor || corridor.distance > RAILWAY_PROP_REACH) return null;
  const halfWidth = corridor.tunnel ? RAILWAY_CLEARANCE.boreHalfWidth : RAILWAY_CLEARANCE.halfWidth;
  const floor = corridor.formation
    + (corridor.tunnel ? RAILWAY_CLEARANCE.boreFloor : RAILWAY_CLEARANCE.floor);
  const top = corridor.formation + (corridor.tunnel ? RAILWAY_CLEARANCE.boreTop : RAILWAY_CLEARANCE.top);
  let minLat = Infinity, maxLat = -Infinity, minY = Infinity, maxY = -Infinity;
  const [hx, hy, hz] = bounds.half;
  for (let corner = 0; corner < 8; corner++) {
    _corner[0] = corner & 1 ? hx : -hx;
    _corner[1] = bounds.centreY + (corner & 2 ? hy : -hy);
    _corner[2] = corner & 4 ? hz : -hz;
    const wx = matrix[offset] * _corner[0] + matrix[offset + 4] * _corner[1]
      + matrix[offset + 8] * _corner[2] + x;
    const wy = matrix[offset + 1] * _corner[0] + matrix[offset + 5] * _corner[1]
      + matrix[offset + 9] * _corner[2] + matrix[offset + 13];
    const wz = matrix[offset + 2] * _corner[0] + matrix[offset + 6] * _corner[1]
      + matrix[offset + 10] * _corner[2] + z;
    const lateral = (wx - corridor.x) * corridor.rightX + (wz - corridor.z) * corridor.rightZ;
    if (lateral < minLat) minLat = lateral;
    if (lateral > maxLat) maxLat = lateral;
    if (wy < minY) minY = wy;
    if (wy > maxY) maxY = wy;
  }
  if (maxLat < -halfWidth || minLat > halfWidth) return null;
  if (maxY < floor || minY > top) return null;
  return corridor;
}

/**
 * Drop every instance of a matrix bucket that reaches into the clearance.
 * Same in-place contract as the worker's clearance filters: matrices and any
 * per-instance colour/cell/macro arrays are rebuilt together.
 */
export function filterRailwayPropIntrusions(index, data, type = data?.type, variant = data?.variant) {
  if (!index || !data?.matrices?.length) return data;
  const bounds = railwayPropBounds(type, variant);
  if (!bounds) return data;
  const count = data.matrices.length / 16;
  const keep = [];
  for (let i = 0; i < count; i++) {
    if (!railwayPropIntrudes(index, data.matrices, i * 16, bounds)) keep.push(i);
  }
  if (keep.length === count) return data;
  const pick = (array, stride) => {
    if (!array) return array;
    const out = new array.constructor(keep.length * stride);
    keep.forEach((source, target) => {
      for (let j = 0; j < stride; j++) out[target * stride + j] = array[source * stride + j];
    });
    return out;
  };
  data.matrices = pick(data.matrices, 16);
  if (data.colors) data.colors = pick(data.colors, 3);
  if (data.cells) data.cells = pick(data.cells, 1);
  if (data.macros) data.macros = pick(data.macros, 1);
  return data;
}
