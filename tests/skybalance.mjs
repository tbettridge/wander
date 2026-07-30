import assert from 'node:assert/strict';
import {
  MODERN_SKY_SUN_DISC,
  modernSkyHighlightShoulder,
  modernSkyNightToe,
  modernSkySunDiscGain,
} from '../src/skybalance.mjs';

const horizon = modernSkySunDiscGain(0, 1);
const golden = modernSkySunDiscGain(0.32, 1);
const noon = modernSkySunDiscGain(1, 1);
const overcast = modernSkySunDiscGain(0, 0);

assert.ok(horizon > golden && golden > noon,
  'the solar disc should retain its strongest restrained glow near the horizon');
assert.ok(horizon <= MODERN_SKY_SUN_DISC.horizonGain + Number.EPSILON);
assert.ok(noon >= MODERN_SKY_SUN_DISC.highSunGain);
assert.ok(overcast < horizon && overcast > 0,
  'weather should mute the disc without making cloud-filtered sun vanish abruptly');
assert.equal(modernSkySunDiscGain(0, 2), horizon,
  'weather visibility must be clamped before it scales the solar disc');

const ordinarySky = modernSkyHighlightShoulder(0.5);
const brightHalo = modernSkyHighlightShoulder(20);
const extremeDisc = modernSkyHighlightShoulder(100000);
assert.equal(ordinarySky, 0.5,
  'the modern shoulder should leave ordinary sky values below its knee unchanged');
assert.ok(brightHalo < 5 && extremeDisc < 1 / MODERN_SKY_SUN_DISC.hdrShoulder,
  'solar HDR energy must approach a finite ceiling before bloom');
assert.ok(extremeDisc > brightHalo,
  'the shoulder should remain monotonic and preserve a distinct sun core');
assert.equal(modernSkyNightToe(0.02, 0), 0.02,
  'the modern night toe must not alter daytime sky values');
assert.ok(modernSkyNightToe(0.02, 1) > 0.02 && modernSkyNightToe(0.02, 1) < 0.14,
  'midnight should regain restrained low-end separation without the full r165 lift');

console.log('skybalance PASS · finite r185 HDR sun shoulder · horizon character retained · weather-gated disc');
