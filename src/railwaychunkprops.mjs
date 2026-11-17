// What a streamed chunk may keep near the railway. The chunk worker runs every
// scatter and clutter bucket through here, and so does the railway clearance
// audit, so the line is held to exactly what the game draws.

import { filterRailwayPropIntrusions } from './railwayenvelope.mjs';

const scratch = {};

/** Drop instances whose centre sits inside the line's clearance weighting
 * (`clearanceField` above `cutoff`). In place; keeps per-instance arrays in
 * step with the matrices. */
export function filterRailwayMatrixData(world, data, clearanceField, cutoff = 0.16) {
  if (!data?.matrices || !world?.railwayClearanceAt) return data;
  const matrices = data.matrices;
  const colors = data.colors || null;
  const cells = data.cells || null;
  const macros = data.macros || null;
  const keptMatrices = [];
  const keptColors = colors ? [] : null;
  const keptCells = cells ? [] : null;
  const keptMacros = macros ? [] : null;
  const count = matrices.length / 16;
  for (let i = 0; i < count; i++) {
    const x = matrices[i * 16 + 12], z = matrices[i * 16 + 14];
    const clearance = world.railwayClearanceAt(x, z, scratch)[clearanceField] || 0;
    if (clearance > cutoff) continue;
    for (let j = 0; j < 16; j++) keptMatrices.push(matrices[i * 16 + j]);
    if (keptColors) keptColors.push(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
    if (keptCells) keptCells.push(cells[i]);
    if (keptMacros) keptMacros.push(macros[i]);
  }
  data.matrices = new Float32Array(keptMatrices);
  if (keptColors) data.colors = new Float32Array(keptColors);
  if (keptCells) data.cells = new Float32Array(keptCells);
  if (keptMacros) data.macros = new Float32Array(keptMacros);
  return data;
}

/**
 * The same over a list of typed buckets, then the solid props (rocks,
 * boulders, tree trunks) whose extent, not just their centre, would reach
 * into the train's clearance or a tunnel bore. A hero boulder seated ten
 * metres off the line can still overhang it, and a stone resting on the
 * hill above a shallow tunnel can hang down into the bore, where no
 * clearance weighting reaches. Empty buckets are dropped.
 */
export function filterRailwayChunkProps(world, buckets, clearanceField, cutoff) {
  if (!buckets || !world?.railwayClearanceAt) return buckets;
  const filtered = [];
  for (const bucket of buckets) {
    filterRailwayMatrixData(world, bucket, clearanceField, cutoff);
    filterRailwayPropIntrusions(world.railwayTerrain, bucket);
    if (bucket.matrices.length) filtered.push(bucket);
  }
  if (buckets.trailRecords) filtered.trailRecords = buckets.trailRecords;
  return filtered;
}
