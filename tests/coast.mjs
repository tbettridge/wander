import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { CLUTTER_RECIPES, RECIPES, VARIANT_COUNTS, coastalVariantForChunk } from '../src/vegdata.js';
import { buildClutter, buildScatter } from '../src/chunkgen.js';
import { caveAnchorsAround } from '../src/cavegen.mjs';
import { trailsAround } from '../src/trails.js';

const world = new World(20260612);
const matchingWorld = new World(20260612);

assert.ok(!RECIPES.beach.mix.some(([type]) => type === 'palm'),
  'temperate beaches still spawn palms');
assert.ok(RECIPES.beach.mix.every(([type]) => type === 'shrub' || type === 'dryshrub'),
  'beach tree layer contains a non-temperate archetype');
assert.ok(CLUTTER_RECIPES.beach.mix.some(([type]) => type === 'seaweed'),
  'strand clutter has no seaweed');
assert.ok(CLUTTER_RECIPES.beach.density <= 0.5,
  'coastal full-geometry clutter density regressed above its streaming budget');
for (const type of ['pebble', 'driftwood', 'seaweed', 'snag']) {
  const variant = coastalVariantForChunk(type, -73, -100);
  assert.ok(variant >= 0 && variant < VARIANT_COUNTS[type]);
  assert.equal(variant, coastalVariantForChunk(type, -73, -100),
    `${type} coastal variant is not deterministic`);
}

const seen = new Set();
for (let z = -24000; z <= 24000; z += 1200) {
  for (let x = -24000; x <= 24000; x += 1200) {
    const code = world.coastCodeAt(x, z);
    assert.ok(code >= 0 && code <= 1, 'coast code escaped normalized range');
    seen.add(world.coastTypeAt(x, z));
  }
}
assert.deepEqual([...seen].sort(), ['chalk', 'dune', 'rocky', 'shingle'],
  'the seed does not expose every coast family');

for (const [x, z] of [[0, 0], [9137, -4281], [-19002, 7744]]) {
  assert.equal(world.coastCodeAt(x, z), matchingWorld.coastCodeAt(x, z),
    'coast classification is not deterministic');
  const biome = world.biomeAt(x, z);
  assert.equal(biome.coastType, world.coastTypeAt(x, z));
  assert.equal(biome.coastCode, world.coastCodeAt(x, z));
}

// The chalk terrain pass must produce both a raised coastal cap and shallow
// wave-cut shelves somewhere in the seeded world, rather than being palette-only.
let chalkCap = false;
let chalkShelf = false;
for (let z = -30000; z <= 30000 && !(chalkCap && chalkShelf); z += 180) {
  for (let x = -30000; x <= 30000 && !(chalkCap && chalkShelf); x += 180) {
    if (world.coastTypeAt(x, z) !== 'chalk') continue;
    const h = world.height(x, z);
    if (h > 8 && h < 28) chalkCap = true;
    if (h > -1.8 && h < -0.45) chalkShelf = true;
  }
}
assert.ok(chalkCap, 'chalk provinces never form raised coastal caps');
assert.ok(chalkShelf, 'chalk provinces never form wave-cut shelves');

const shelfScatter = buildScatter(world, 3, -24, 64, { treeDensityScale: 1, audit: true });
assert.ok(shelfScatter.some((bucket) => bucket.type === 'tidepool' && bucket.matrices.length > 0),
  'exposed seeded shelf emits no tide pools');

// This seeded shingle chunk was previously 186 clutter objects across eight
// buckets at High. Preserve its strand identity while bounding upload payload.
const shingleClutter = buildClutter(world, -73, -100, 140, { clutterDensityScale: 0.8 });
const shingleObjects = shingleClutter.reduce((sum, bucket) => sum + bucket.matrices.length / 16, 0);
assert.ok(shingleObjects <= 125, `shingle clutter payload regressed to ${shingleObjects} objects`);
assert.ok(shingleClutter.length <= 6, `shingle clutter split into ${shingleClutter.length} upload buckets`);

const caveAnchors = [];
caveAnchorsAround(world, 0, 0, world.seed, 12000, caveAnchors);
assert.ok(caveAnchors.some((anchor) => anchor.kind === 'sea-cave'
  && (anchor.coastType === 'chalk' || anchor.coastType === 'rocky')),
  'seeded exposed coast has no sea caves');

const coastTrails = [];
trailsAround(world, 0, 0, world.seed, 9000, coastTrails);
assert.ok(coastTrails.some((edge) => edge.cliffPath && edge.toCave?.kind === 'sea-cave'
  && edge.maxGrade <= 0.26), 'sea caves have no traversable cliff paths');

console.log('coast PASS · 4 families · strand ecology · tide pools · sea caves/cliff paths');
