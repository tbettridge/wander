import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import {
  clearTrailCache,
  rasterizeTrailGrassMask,
  trailEcologyAt,
  trailsAround,
} from '../src/trails.js';
import {
  GRASS_FIELD_COVER,
  GRASS_FIELD_SIZE,
  GRASS_TRAIL_MASK_SIZE,
  buildGrassTrailBundle,
  grassFieldAnchorForPlayer,
} from '../src/grasstrailprep.mjs';

const positive = grassFieldAnchorForPlayer(37.25, 91.5);
const repeated = grassFieldAnchorForPlayer(37.25, 91.5);
const negative = grassFieldAnchorForPlayer(-37.25, -91.5);
assert.deepEqual(positive, repeated, 'anchor snapping is not deterministic');
assert.ok(negative.ix < 0 && negative.iz < 0, 'negative coordinates did not retain signed grid cells');
assert.equal(positive.x, positive.ix * (GRASS_FIELD_COVER / (GRASS_FIELD_SIZE - 1)));

const world = new World(1337);
const anchor = grassFieldAnchorForPlayer(0, 0);
clearTrailCache();
const bundle = buildGrassTrailBundle(world, anchor);
assert.equal(bundle.key, anchor.key);
assert.equal(bundle.coverage.length, GRASS_TRAIL_MASK_SIZE ** 2);
assert.equal(bundle.height.length, GRASS_FIELD_SIZE ** 2);

clearTrailCache();
const trails = [];
trailsAround(world, anchor.x + GRASS_FIELD_COVER / 2,
  anchor.z + GRASS_FIELD_COVER / 2, world.seed, GRASS_FIELD_COVER * 0.76, trails);
const expectedMask = new Uint8Array(GRASS_TRAIL_MASK_SIZE ** 2);
rasterizeTrailGrassMask(trails, anchor.x, anchor.z,
  GRASS_FIELD_COVER, GRASS_TRAIL_MASK_SIZE, expectedMask);
assert.deepEqual(bundle.coverage, expectedMask, 'worker-ready coverage differs from the synchronous mask');

const ecology = {};
for (let iz = 0; iz < GRASS_FIELD_SIZE; iz += 7) {
  for (let ix = 0; ix < GRASS_FIELD_SIZE; ix += 7) {
    const x = anchor.x + (ix / (GRASS_FIELD_SIZE - 1)) * GRASS_FIELD_COVER;
    const z = anchor.z + (iz / (GRASS_FIELD_SIZE - 1)) * GRASS_FIELD_COVER;
    trailEcologyAt(trails, x, z, ecology);
    const expected = ecology.zone === 'none' ? 255
      : Math.round(Math.max(0.05, Math.min(1, ecology.grassHeight)) * 255);
    assert.equal(bundle.height[iz * GRASS_FIELD_SIZE + ix], expected,
      `trail height mismatch at ${ix},${iz}`);
  }
}

console.log(`grasstrailprep PASS · ${bundle.edgeCount} edges · ${bundle.totalMs.toFixed(1)}ms off-thread bundle · exact mask`);
