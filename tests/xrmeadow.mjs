import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  XR_GRASS_HEIGHT_SCALE,
  XR_GRASS_OUTER_FADE_METERS,
  XR_GRASS_RECEIVES_SHADOWS,
  XR_GRASS_WIDTH_SCALE,
  scaledXRGrassDimensions,
} from '../src/xrgrassquality.mjs';

assert.equal(XR_GRASS_WIDTH_SCALE, 0.70);
assert.equal(XR_GRASS_HEIGHT_SCALE, 0.75);
assert.equal(XR_GRASS_OUTER_FADE_METERS, 2);
assert.equal(XR_GRASS_RECEIVES_SHADOWS, false);
const dimensions = scaledXRGrassDimensions(1.2, 0.2);
assert.ok(Math.abs(dimensions.height - 0.9) < 1e-12);
assert.ok(Math.abs(dimensions.width - 0.14) < 1e-12);

const source = await readFile(new URL('../src/xrmeadow.js', import.meta.url), 'utf8');
assert.doesNotMatch(source, /uShadowMap|xrGrassShadow|vXRGrassShadowCoord/,
  'XR grass regressed to sampling cast shadows');
assert.doesNotMatch(source, /uAtmoCloudMap/,
  'XR grass regressed to sampling cached cloud shadows');
assert.match(source, /float occupancy = step\(threshold, habitatKeep\)/,
  'XR density selection must remain stable and binary');
assert.doesNotMatch(source, /smoothstep\(threshold -/,
  'XR density must not continuously shrink individual blades');

console.log('xrmeadow PASS · unshadowed grass · stable occupancy · 30% thinner · 25% shorter');
