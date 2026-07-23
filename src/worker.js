// Chunk-generation worker. Owns its own deterministic World (constructed from
// the shared seed) and turns build requests into transferable typed arrays, so
// the heavy noise sampling never touches the main/render thread.

import { World } from './world.js';
import { buildTerrainArrays, buildTrailSurface, buildRiver, buildScatter, buildGrass, buildClutter, buildUnderstory, chunkTouchesCoast } from './chunkgen.js';

let world = null;

self.onmessage = (e) => {
  const d = e.data;

  if (d.type === 'init') {
    world = new World(d.seed);
    self.postMessage({ type: 'ready' });
    return;
  }

  if (d.type === 'build') {
    const transfer = [];
    const coastal = chunkTouchesCoast(world, d.cx, d.cz, d.chunkSize);

    let terrain = null, trail = null, river = null;
    if (d.doTerrain) {
      terrain = buildTerrainArrays(world, d.cx, d.cz, d.res, d.chunkSize);
      trail = buildTrailSurface(world, d.cx, d.cz, d.chunkSize, d.res, terrain.positions);
      // assemble the river mesh from the water levels buildTerrainArrays
      // pre-sampled on the same vertex grid (no re-sampling)
      river = buildRiver(d.cx, d.cz, d.res, d.chunkSize, terrain.river);
      terrain.river = null;   // worker-internal only — don't post it
      transfer.push(terrain.positions.buffer, terrain.normals.buffer,
                    terrain.colors.buffer, terrain.indices.buffer);
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
      for (const b of scatter) {
        transfer.push(b.matrices.buffer);
        if (b.colors) transfer.push(b.colors.buffer);
      }
    } else if (d.treeMode === 'impostor') {
      impostors = buildScatter(world, d.cx, d.cz, d.chunkSize, { mode: 'impostor', treeDensityScale: d.treeDensityScale, res: d.res, coastal });
      for (const b of impostors) transfer.push(b.matrices.buffer);
    }

    let grass = null;
    if (d.doGrass) {
      grass = buildGrass(world, d.cx, d.cz, d.chunkSize, d.grassPerChunk);
      if (grass) {
        transfer.push(grass.matrices.buffer);
        transfer.push(grass.colors.buffer);
      }
    }

    let clutter = null, understory = null;
    if (d.doClutter) {
      clutter = buildClutter(world, d.cx, d.cz, d.chunkSize, { clutterDensityScale: d.clutterDensityScale, coastal });
      for (const b of clutter) transfer.push(b.matrices.buffer);
      understory = buildUnderstory(world, d.cx, d.cz, d.chunkSize, { clutterDensityScale: d.clutterDensityScale });
      if (understory) transfer.push(understory.matrices.buffer, understory.cells.buffer, understory.colors.buffer);
    }

    self.postMessage(
      { type: 'built', id: d.id, cx: d.cx, cz: d.cz, res: d.res, coastal, terrain, trail, river, scatter, impostors, grass, clutter, understory },
      transfer
    );
  }
};
