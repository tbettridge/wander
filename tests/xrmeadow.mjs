import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createXRGrassPatchShape,
  sampleXRGrassPatchShape,
} from '../src/chunkgen.js';
import { mulberry32 } from '../src/noise.js';

function sequence(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

const shapes = [
  createXRGrassPatchShape(24, sequence([0.1, 0.37, 0.64])),
  createXRGrassPatchShape(24, sequence([0.5, 0.22, 0.73, 0.41])),
  createXRGrassPatchShape(24, sequence([0.9, 0.12, 0.7, 0.2, 0.5, 0.8, 0.3, 0.6])),
];
assert.deepEqual(shapes.map((shape) => shape.kind), ['ellipse', 'ragged', 'cluster']);
assert.ok(shapes[2].lobes.length >= 2 && shapes[2].lobes.length <= 4,
  'cluster patches must split into two to four smaller islands');
for (const [shapeIndex, shape] of shapes.entries()) {
  const rng = mulberry32(771 + shapeIndex);
  for (let i = 0; i < 2000; i++) {
    const point = sampleXRGrassPatchShape(shape, rng);
    assert.ok(Math.hypot(point.x, point.z) <= shape.footprint + 1e-9,
      `${shape.kind} blade escaped its bounded wind-cell footprint`);
  }
}

const [chunkgen, terrain, vegetation, main] = await Promise.all([
  readFile(new URL('../src/chunkgen.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/terrain.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/vegetation.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
]);

assert.match(chunkgen, /mode === 'xr-patches'/,
  'worker grass must expose an XR-only planted patch mode');
assert.match(chunkgen, /xrPatches \? Math\.max\(lowland, foothill\) : foothill/,
  'XR patches must extend the existing foothill habitat into lowland meadows');
assert.match(chunkgen, /groundColor\(world, x, z/,
  'patch blades must retain terrain-derived pigment');
assert.match(chunkgen, /area = xrPatches \? 8\.5 \+ rng\(\) \* 31/,
  'XR patch sizes must widen without changing their 24m² expected area');
assert.match(terrain, /grassMode = xrPatchMode \? 'xr-patches' : 'desktop'/,
  'chunk plans must select patch mode without changing desktop generation');
assert.match(vegetation, /float xrPatchGrowth = 1\.0 - smoothstep/,
  'patches must grow smoothly through a distance band');
assert.match(vegetation, /transformed \*= mix\(1\.0, xrPatchGrowth, uXRGrassPatchActive\)/,
  'distance growth must be isolated behind the XR mode uniform');
assert.doesNotMatch(main, /XRMeadow|xrMeadow/,
  'the camera-following XR meadow renderer must stay retired');

console.log('xrmeadow PASS · ellipse/ragged/cluster patches · bounded wind cells · terrain pigment · distance growth');
