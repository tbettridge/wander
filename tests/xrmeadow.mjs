import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
assert.match(terrain, /grassMode = xrPatchMode \? 'xr-patches' : 'desktop'/,
  'chunk plans must select patch mode without changing desktop generation');
assert.match(vegetation, /float xrPatchGrowth = 1\.0 - smoothstep/,
  'patches must grow smoothly through a distance band');
assert.match(vegetation, /transformed \*= mix\(1\.0, xrPatchGrowth, uXRGrassPatchActive\)/,
  'distance growth must be isolated behind the XR mode uniform');
assert.doesNotMatch(main, /XRMeadow|xrMeadow/,
  'the camera-following XR meadow renderer must stay retired');

console.log('xrmeadow PASS · planted chunk patches · lowland + foothill habitat · terrain pigment · distance growth');
