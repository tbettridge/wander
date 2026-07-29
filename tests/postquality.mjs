import assert from 'node:assert/strict';
import {
  desktopLanternPixelProtection,
  desktopLanternGradeProtection,
  msaaSamplesForTier,
  resolveMsaaSamples,
} from '../src/postquality.mjs';

assert.equal(msaaSamplesForTier('potato'), 0);
assert.equal(msaaSamplesForTier('low'), 0);
assert.equal(msaaSamplesForTier('medium'), 0);
assert.equal(msaaSamplesForTier('high'), 2);
assert.equal(msaaSamplesForTier('ultra'), 2);

assert.equal(resolveMsaaSamples('medium', 'auto'), 0);
assert.equal(resolveMsaaSamples('ultra', 'auto'), 2);
assert.equal(resolveMsaaSamples('medium', '4'), 4);
assert.equal(resolveMsaaSamples('ultra', 0), 0);
assert.equal(resolveMsaaSamples('high', 'invalid'), 2);

assert.equal(desktopLanternGradeProtection(0), 0,
  'an extinguished lantern must not alter the desktop grade');
assert.ok(desktopLanternGradeProtection(4.2) > 0.99,
  'a fully lit lantern must preserve its falloff toe indoors and outdoors');
assert.ok(desktopLanternGradeProtection(0.7) > 0.2
  && desktopLanternGradeProtection(0.7) < 0.5,
  'ignition must blend the grade protection smoothly');
assert.ok(desktopLanternPixelProtection(1, 4, 0.03) > 0.5,
  'nearby dim lamplight should retain a smooth desktop falloff');
assert.equal(desktopLanternPixelProtection(1, 49, 0.03), 0,
  'distant cave darkness must retain the authored grade');
assert.equal(desktopLanternPixelProtection(1, 4, 0), 0,
  'nearby pixels with no light signal must not receive a grey lift');

console.log('postquality PASS · tier MSAA + local-light grade protection');
