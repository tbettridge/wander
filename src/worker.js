// Chunk-generation worker. Owns its own deterministic World (constructed from
// the shared seed) and turns build requests into transferable typed arrays, so
// the heavy noise sampling never touches the main/render thread.

import { World } from './world.js';
import { buildTerrainArrays, buildTrailSurface, buildRiver, buildScatter, buildGrass, buildClutter, buildUnderstory, chunkTouchesCoast } from './chunkgen.js';
import { setWorldRailwayTerrain } from './railwayterrain.mjs';

let world = null;
let railwayTerrainSpec = null;
let railwayRevision = 0;
const railwayClearance = {};

function filterMatrixData(data, clearanceField, cutoff = 0.16) {
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
    const clearance = world.railwayClearanceAt(x, z, railwayClearance)[clearanceField] || 0;
    if (clearance > cutoff) continue;
    for (let j = 0; j < 16; j++) keptMatrices.push(matrices[i * 16 + j]);
    if (keptColors) {
      keptColors.push(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
    }
    if (keptCells) keptCells.push(cells[i]);
    if (keptMacros) keptMacros.push(macros[i]);
  }
  data.matrices = new Float32Array(keptMatrices);
  if (keptColors) data.colors = new Float32Array(keptColors);
  if (keptCells) data.cells = new Float32Array(keptCells);
  if (keptMacros) data.macros = new Float32Array(keptMacros);
  return data;
}

function filterBuckets(buckets, clearanceField, cutoff) {
  if (!buckets || !world?.railwayClearanceAt) return buckets;
  const filtered = [];
  for (const bucket of buckets) {
    filterMatrixData(bucket, clearanceField, cutoff);
    if (bucket.matrices.length) filtered.push(bucket);
  }
  if (buckets.trailRecords) filtered.trailRecords = buckets.trailRecords;
  return filtered;
}

self.onmessage = (e) => {
  const d = e.data;

  if (d.type === 'init') {
    world = new World(d.seed);
    if (railwayTerrainSpec) setWorldRailwayTerrain(world, railwayTerrainSpec);
    self.postMessage({ type: 'ready' });
    return;
  }

  if (d.type === 'railwayTerrain') {
    railwayTerrainSpec = d.spec || null;
    railwayRevision = d.revision || railwayRevision + 1;
    if (world) setWorldRailwayTerrain(world, railwayTerrainSpec);
    return;
  }

  if (d.type === 'build') {
    const transfer = [];
    const coastal = chunkTouchesCoast(world, d.cx, d.cz, d.chunkSize);
    const railwayNearby = !!world.railwayTerrain?.intersectsBounds(
      d.cx * d.chunkSize,
      d.cz * d.chunkSize,
      (d.cx + 1) * d.chunkSize,
      (d.cz + 1) * d.chunkSize,
    );

    let terrain = null, trail = null, river = null;
    if (d.doTerrain) {
      terrain = buildTerrainArrays(world, d.cx, d.cz, d.res, d.chunkSize);
      trail = buildTrailSurface(world, d.cx, d.cz, d.chunkSize, d.res, terrain.positions);
      // assemble the river mesh from the water levels buildTerrainArrays
      // pre-sampled on the same vertex grid (no re-sampling)
      river = buildRiver(d.cx, d.cz, d.res, d.chunkSize, terrain.river);
      terrain.river = null;   // worker-internal only — don't post it
      transfer.push(terrain.positions.buffer, terrain.normals.buffer,
                    terrain.colors.buffer, terrain.macros.buffer,
                    terrain.shades.buffer, terrain.indices.buffer);
      if (trail) transfer.push(trail.positions.buffer, trail.normals.buffer,
                               trail.colors.buffer, trail.indices.buffer);
      if (river) {
        transfer.push(river.positions.buffer, river.wet.buffer,
                      river.flow.buffer, river.indices.buffer);
        if (river.fall) transfer.push(river.fall.positions.buffer, river.fall.uvs.buffer,
                                      river.fall.indices.buffer, river.fall.mist.buffer);
      }
    }

    let scatter = null, impostors = null;
    if (d.treeMode === 'full') {
      scatter = buildScatter(world, d.cx, d.cz, d.chunkSize, { mode: 'full', treeDensityScale: d.treeDensityScale, res: d.res, coastal });
      if (railwayNearby) scatter = filterBuckets(scatter, 'treeClearance', 0.14);
      for (const b of scatter) {
        transfer.push(b.matrices.buffer);
        if (b.colors) transfer.push(b.colors.buffer);
      }
    } else if (d.treeMode === 'impostor') {
      impostors = buildScatter(world, d.cx, d.cz, d.chunkSize, { mode: 'impostor', treeDensityScale: d.treeDensityScale, res: d.res, coastal });
      if (railwayNearby) impostors = filterBuckets(impostors, 'treeClearance', 0.12);
      for (const b of impostors) transfer.push(b.matrices.buffer);
    }

    let grass = null;
    if (d.doGrass) {
      grass = buildGrass(world, d.cx, d.cz, d.chunkSize, d.grassPerChunk);
      if (railwayNearby) grass = filterMatrixData(grass, 'grassClearance', 0.12);
      if (grass && !grass.matrices.length) grass = null;
      if (grass) {
        transfer.push(grass.matrices.buffer);
        transfer.push(grass.colors.buffer);
        transfer.push(grass.macros.buffer);
      }
    }

    let clutter = null, understory = null;
    if (d.doClutter) {
      clutter = buildClutter(world, d.cx, d.cz, d.chunkSize, { clutterDensityScale: d.clutterDensityScale, coastal });
      if (railwayNearby) clutter = filterBuckets(clutter, 'plantClearance', 0.12);
      for (const b of clutter) transfer.push(b.matrices.buffer);
      understory = buildUnderstory(world, d.cx, d.cz, d.chunkSize, { clutterDensityScale: d.clutterDensityScale });
      if (railwayNearby) understory = filterMatrixData(understory, 'plantClearance', 0.12);
      if (understory && !understory.matrices.length) understory = null;
      if (understory) transfer.push(understory.matrices.buffer, understory.cells.buffer, understory.colors.buffer);
    }

    self.postMessage(
      { type: 'built', id: d.id, cx: d.cx, cz: d.cz, res: d.res, coastal, terrain, trail, river, scatter, impostors, grass, clutter, understory, railwayRevision },
      transfer
    );
  }
};
