import { rasterizeTrailGrassMask, trailEcologyAt, trailsAround } from './trails.js';

export const GRASS_FIELD_SIZE = 96;
export const GRASS_TRAIL_MASK_SIZE = 384;
export const GRASS_FIELD_COVER = 260;
export const GRASS_TRAIL_CACHE_VERSION = 1;

export function grassFieldAnchorForPlayer(
  playerX,
  playerZ,
  cover = GRASS_FIELD_COVER,
  fieldSize = GRASS_FIELD_SIZE,
) {
  const texel = cover / (fieldSize - 1);
  const ix = Math.round((playerX - cover * 0.5) / texel);
  const iz = Math.round((playerZ - cover * 0.5) / texel);
  return {
    x: ix * texel,
    z: iz * texel,
    ix,
    iz,
    key: `${GRASS_TRAIL_CACHE_VERSION}:${ix},${iz}:${fieldSize}:${GRASS_TRAIL_MASK_SIZE}`,
  };
}

// Produce every trail-dependent input the blanket grass field needs. Keeping
// this THREE-free lets a dedicated worker own route solving, mask rasterization
// and the formerly incremental nearest-segment ecology queries.
export function buildGrassTrailBundle(world, spec) {
  const {
    x: minX,
    z: minZ,
    cover = GRASS_FIELD_COVER,
    fieldSize = GRASS_FIELD_SIZE,
    maskSize = GRASS_TRAIL_MASK_SIZE,
  } = spec;
  const trails = [];
  const started = performance.now();
  trailsAround(world, minX + cover * 0.5, minZ + cover * 0.5,
    world.seed, cover * 0.76, trails);
  const queried = performance.now();

  const coverage = new Uint8Array(maskSize * maskSize);
  rasterizeTrailGrassMask(trails, minX, minZ, cover, maskSize, coverage);
  const rastered = performance.now();

  const height = new Uint8Array(fieldSize * fieldSize).fill(255);
  if (trails.length) {
    const ecology = {};
    for (let iz = 0; iz < fieldSize; iz++) {
      const z = minZ + (iz / (fieldSize - 1)) * cover;
      for (let ix = 0; ix < fieldSize; ix++) {
        const x = minX + (ix / (fieldSize - 1)) * cover;
        trailEcologyAt(trails, x, z, ecology);
        if (ecology.zone !== 'none') {
          height[iz * fieldSize + ix] = Math.round(
            Math.max(0.05, Math.min(1, ecology.grassHeight)) * 255,
          );
        }
      }
    }
  }
  const finished = performance.now();
  return {
    key: spec.key,
    x: minX,
    z: minZ,
    coverage,
    height,
    edgeCount: trails.length,
    queryMs: queried - started,
    rasterMs: rastered - queried,
    ecologyMs: finished - rastered,
    totalMs: finished - started,
  };
}
