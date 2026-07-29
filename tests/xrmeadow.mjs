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

const [chunkgen, terrain, vegetation, grassfield, xrterrain, main] = await Promise.all([
  readFile(new URL('../src/chunkgen.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/terrain.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/vegetation.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/grassfield.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/xrterrain.js', import.meta.url), 'utf8'),
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
assert.match(vegetation, /grassMaterial\.forceSinglePass = true/,
  'near crossed tufts must use one transparent submission');
assert.match(grassfield, /new THREE\.InstancedBufferGeometry\(\)\.copy\(xrBase\)/,
  'mid grass must use compact instancing without per-blade matrices');
assert.match(grassfield, /float xrMidBand = smoothstep/,
  'mid grass must crossfade between the near and far systems');
assert.match(grassfield, /if \(uXRFieldActive > 0\.5\) return 1\.0/,
  'mid grass must skip the expensive multi-tap contact shadow path');
assert.match(xrterrain, /uXRGrassFarNear;[\s\S]*uXRGrassFarFull;/,
  'far grass must continue as geometry-free terrain shading');
assert.match(xrterrain, /vXRMeadowPaint = vec4/,
  'far meadow shading should be calculated per terrain vertex');
assert.match(main, /setXRRuntimeScale\(stage\.grassMidScale\)/,
  'the runtime governor must reduce mid geometry independently');
assert.doesNotMatch(main, /XRMeadow|xrMeadow/,
  'the retired duplicate XR meadow renderer must stay retired');

console.log('xrmeadow PASS · planted near tufts · compact mid quads · shader-only far meadow');
