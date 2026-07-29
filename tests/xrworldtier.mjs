import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TIERS } from '../src/quality.js';
import { XR_PROFILES } from '../src/xrprofiles.mjs';
import {
  DEFAULT_XR_WORLD_TIER,
  XR_WORLD_TIERS,
  normalizeXRWorldTierName,
  xrWorldTierForName,
  xrWorldTierLabel,
} from '../src/xrworldtier.mjs';

const low = TIERS.find((tier) => tier.name === 'low');
const medium = TIERS.find((tier) => tier.name === 'medium');
const high = xrWorldTierForName('high');

assert.equal(DEFAULT_XR_WORLD_TIER, 'high');
assert.equal(normalizeXRWorldTierName('unknown'), 'high');
assert.equal(high.name, 'xr-high');
assert.ok(high.viewRadius > low.viewRadius,
  'XR High must not inherit Quest desktop Low terrain reach');
assert.ok(high.treeRadius > low.treeRadius,
  'XR High must carry real trees beyond Quest desktop Low');
assert.ok(high.impostorRadius > low.impostorRadius);
assert.ok(high.nearRes > medium.nearRes,
  'XR High terrain should exceed desktop Medium vertex resolution');
assert.ok(high.nearRes < TIERS.find((tier) => tier.name === 'high').nearRes,
  'XR High should retain headset-appropriate terrain cost');
assert.equal(high.shadowSize, 256);
assert.equal(XR_PROFILES.painterly.worldTier, 'high');
assert.equal(XR_PROFILES.survival.worldTier, 'high');
assert.match(xrWorldTierLabel(high), /XR High · terrain 840m · real trees 420m/);
assert.ok(Object.isFrozen(XR_WORLD_TIERS));
assert.ok(Object.isFrozen(high));

const [main, terrain] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/terrain.js', import.meta.url), 'utf8'),
]);
assert.match(main, /xrWorldTierActive = xrWorldTierForName\(profile\.worldTier\)/);
assert.match(main, /applyWorldRenderTier\(xrWorldTierActive, \{ xr: true \}\)/);
assert.match(main, /quality\.apply\(\)/,
  'desktop quality must be reapplied after XR ends');
assert.match(terrain, /setWorldRenderTier\(tier\)/);
assert.match(terrain, /':world:' \+ this\.worldTierSignature/,
  'world-tier changes must invalidate stale streamed chunks');

console.log('xrworldtier PASS · explicit XR High reach · profile isolation · desktop restoration');
