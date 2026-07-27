import assert from 'node:assert/strict';
import {
  GRASS_SHADOW_TAPS,
  consumeSurfaceShadowInterval,
  grassSnapshotDue,
  shadowPolicyForTier,
  surfaceShadowDue,
} from '../src/shadowquality.mjs';

assert.equal(GRASS_SHADOW_TAPS, 5, 'grass shadow filter regressed above the five-tap budget');

const high = shadowPolicyForTier('high');
assert.equal(high.surfaceHz, 30);
assert.equal(high.grassSize, 1024);
assert.equal(shadowPolicyForTier('ultra').grassSize, 1024,
  'Ultra regressed to a full-size grass copy');
assert.equal(shadowPolicyForTier('medium').grassSize, 512);
assert.equal(shadowPolicyForTier('low').grassSize, 0);
assert.equal(shadowPolicyForTier('xr-painterly').surfaceHz, 10);
assert.equal(shadowPolicyForTier('xr-painterly').grassSize, 0);
assert.equal(shadowPolicyForTier('xr-survival').surfaceHz, 6);

assert.equal(surfaceShadowDue(1 / 30 - 0.001, 30), false);
assert.equal(surfaceShadowDue(1 / 30, 30), true);
assert.equal(surfaceShadowDue(0, 30, true), true);
assert.equal(surfaceShadowDue(10, 0, true), false);
assert.ok(Math.abs(consumeSurfaceShadowInterval(0.04, 30) - (0.04 - 1 / 30)) < 1e-9);
assert.equal(consumeSurfaceShadowInterval(0.04, 30, true), 0);

const snapshot = (overrides = {}) => grassSnapshotDue({
  hasSnapshot: true,
  age: 1,
  playerX: 10,
  playerZ: 10,
  anchorX: 0,
  anchorZ: 0,
  policy: high,
  ...overrides,
});
assert.equal(snapshot(), false);
assert.equal(snapshot({ age: 4 }), true, 'age limit did not refresh the grass cache');
assert.equal(snapshot({ playerX: 24 }), true, 'X guard band did not refresh the grass cache');
assert.equal(snapshot({ playerZ: -24 }), true, 'Z guard band did not refresh the grass cache');
assert.equal(snapshot({ hasSnapshot: false }), true);
assert.equal(snapshot({ force: true }), true);

console.log('shadows PASS · 20/30 Hz surface cadence · 512/1024 grass cache · 24m guard band');
