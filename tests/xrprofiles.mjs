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
const painterly = xrProfileForName('painterly');
const survival = xrProfileForName('survival');
assert.equal(painterly.framebufferScale, 0.75);
assert.equal(painterly.worldTier, 'high');
assert.equal(painterly.foveation, 0.80);
assert.equal(painterly.grassPatchRadius, 1);
assert.equal(painterly.grassBladeBudget, 1500);
assert.equal(painterly.grassGrowNear, 34);
assert.equal(painterly.grassGrowFar, 60);
assert.equal(painterly.grassMidStart, 22);
assert.equal(painterly.grassMidEnd, 118);
assert.equal(painterly.grassMidBladeBudget, 90000);
assert.equal(painterly.grassFarEnd, 190);
assert.equal(painterly.shadowSize, 256);
assert.equal(painterly.shadowHz, 6);
assert.equal(survival.foveation, 0.90);
assert.equal(survival.worldTier, 'high');
assert.equal(survival.grassPatchRadius, 1);
assert.equal(survival.grassBladeBudget, 950);
assert.equal(survival.grassGrowNear, 30);
assert.equal(survival.grassGrowFar, 52);
assert.equal(survival.grassMidStart, 20);
assert.equal(survival.grassMidEnd, 100);
assert.equal(survival.grassMidBladeBudget, 60000);
assert.equal(survival.grassFarEnd, 170);
assert.equal(survival.shadowSize, 256);
assert.ok(painterly.framebufferScale > survival.framebufferScale,
  'Painterly should retain a sharper central image than Survival');
assert.ok(painterly.foveation < survival.foveation,
  'Painterly should retain more peripheral detail than Survival');
assert.ok(painterly.grassBladeBudget > survival.grassBladeBudget);
assert.ok(painterly.grassGrowFar > survival.grassGrowFar);
assert.ok(painterly.grassMidBladeBudget > survival.grassMidBladeBudget);
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
