import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  XR_GRASS_HEIGHT_SCALE,
  XR_GRASS_MID_EDGE_BLEND_METERS,
  XR_GRASS_NEAR_EDGE_BLEND_METERS,
  XR_GRASS_RECEIVES_SHADOWS,
  XR_GRASS_WIDTH_SCALE,
  scaledXRGrassDimensions,
} from '../src/xrgrassquality.mjs';

assert.equal(XR_GRASS_WIDTH_SCALE, 0.70);
assert.equal(XR_GRASS_HEIGHT_SCALE, 0.75);
assert.equal(XR_GRASS_NEAR_EDGE_BLEND_METERS, 3);
assert.equal(XR_GRASS_MID_EDGE_BLEND_METERS, 8);
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
assert.match(source, /float radialOccupancy = step\(radialHash, radialCoverage\)/,
  'XR layer edges must thin whole blades rather than scale their geometry');
assert.match(source, /float budgetKeep = mix\(uBudgetScale, 1\.0, frontProtect\)/,
  'XR adaptive pruning must preserve the forward hemisphere');
assert.match(source, /this\.mid\.count = Math\.min\(MAX_MID, this\.profile\.midGrassCount\)/,
  'XR governor changes must not shorten the submitted instance list');
assert.doesNotMatch(source, /distanceMask/,
  'XR radial transitions must not continuously scale blade geometry');
assert.doesNotMatch(source, /smoothstep\(threshold -/,
  'XR density must not continuously shrink individual blades');

console.log('xrmeadow PASS · unshadowed grass · stable foreground · density-blended edge · 30% thinner · 25% shorter');
