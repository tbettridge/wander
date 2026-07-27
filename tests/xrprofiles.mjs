import assert from 'node:assert/strict';
import {
  DEFAULT_XR_PROFILE,
  XR_PROFILES,
  chooseXRFrameRate,
  missedXRFrames,
  normalizeXRProfileName,
  normalizedSupportedFrameRates,
  xrFrameBudgetMs,
  xrProfileForName,
} from '../src/xrprofiles.mjs';

assert.equal(DEFAULT_XR_PROFILE, 'painterly');
assert.equal(normalizeXRProfileName('survival'), 'survival');
assert.equal(normalizeXRProfileName('unknown'), 'painterly');
assert.equal(xrProfileForName('painterly').framebufferScale, 0.82);
assert.equal(xrProfileForName('survival').foveation, 0.90);
assert.equal(xrProfileForName('painterly').nearGrassCount, 12000);
assert.equal(xrProfileForName('painterly').midGrassCount, 48000);
assert.equal(xrProfileForName('survival').nearGrassCount, 6000);
assert.equal(xrProfileForName('survival').shadowSize, 256);
assert.ok(Object.isFrozen(XR_PROFILES));
assert.ok(Object.isFrozen(XR_PROFILES.painterly));

assert.deepEqual(normalizedSupportedFrameRates(new Float32Array([90, 72, 90, 120])), [72, 90, 120]);
assert.equal(chooseXRFrameRate([72, 90, 120], 72), 72);
assert.equal(chooseXRFrameRate([60, 90], 72), 90);
assert.equal(chooseXRFrameRate([60], 72), 60);
assert.equal(chooseXRFrameRate([], 72), null);
assert.equal(xrFrameBudgetMs(72).toFixed(2), '13.89');

assert.equal(missedXRFrames(1 / 72, 72), 0);
assert.equal(missedXRFrames(2 / 72, 72), 1);
assert.equal(missedXRFrames(3 / 72, 72), 2);
assert.equal(missedXRFrames(0, 72), 0);

console.log('xrprofiles PASS · isolated Painterly/Survival display profiles · 72 Hz preference');
