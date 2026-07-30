import assert from 'node:assert/strict';
import {
  MODERN_SKY_OUTPUT_MARKER,
  MODERN_SKY_SUN_DISC,
  balancedSkyFragment,
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

// ── the sky rebalance must actually apply ────────────────────────────────────
// This is a string replacement against the r185 Sky addon's fragment shader, so
// its failure mode is silence: a reworded output line matches nothing, the
// solar disc stays unbounded linear HDR, bloom clips, and no error is raised.
// These assertions are the canary for that upgrade.
// The output line is written out LITERALLY here, not interpolated from the
// constant. Building the fixture from MODERN_SKY_OUTPUT_MARKER would make this
// circular — it would match by construction even if the constant had drifted
// away from the shader r185 actually ships.
assert.equal(MODERN_SKY_OUTPUT_MARKER, 'gl_FragColor = vec4( texColor, 1.0 );',
  'the marker must stay byte-identical to the r185 Sky addon output line');
const R185_TAIL = `void main() {
  vec3 texColor = ( Lin + L0 ) * 0.04;
  texColor += vec3( 0.0, 0.0003, 0.00075 );
  gl_FragColor = vec4( texColor, 1.0 );
}`;

const applied = balancedSkyFragment(R185_TAIL);
assert.equal(applied.patched, true, 'the marker must be found in an r185-shaped shader');
assert.ok(!applied.shader.includes(MODERN_SKY_OUTPUT_MARKER),
  'the raw unbounded output must be replaced, not merely appended to');
assert.ok(applied.shader.includes('gl_FragColor = vec4(wanderSkyColor, 1.0);'),
  'the rebalanced output must still write gl_FragColor');
// the surrounding shader has to survive intact
assert.ok(applied.shader.includes('vec3 texColor = ( Lin + L0 ) * 0.04;'),
  'the replacement must not disturb the rest of the shader');

// The constants are baked into GLSL as literals, so a change to the tuning
// object that never reaches the shader would be its own silent failure.
assert.ok(applied.shader.includes(MODERN_SKY_SUN_DISC.hdrKnee.toFixed(3)),
  'the HDR knee must be emitted into the shader');
assert.ok(applied.shader.includes(MODERN_SKY_SUN_DISC.hdrShoulder.toFixed(3)),
  'the HDR shoulder must be emitted into the shader');
assert.ok(applied.shader.includes(MODERN_SKY_SUN_DISC.nightToePower.toFixed(3)),
  'the night-toe power must be emitted into the shader');
assert.ok(applied.shader.includes(MODERN_SKY_SUN_DISC.nightToeStrength.toFixed(3)),
  'the night-toe strength must be emitted into the shader');
// no unresolved template holes, and balanced delimiters
assert.ok(!applied.shader.includes('${'), 'no unresolved template placeholder');
for (const [open, close] of [['(', ')'], ['{', '}']]) {
  const o = applied.shader.split(open).length - 1;
  const c = applied.shader.split(close).length - 1;
  assert.equal(o, c, `unbalanced ${open}${close} in the rebalanced shader`);
}

// A future revision that rewords the output line must report failure and hand
// the shader back untouched, so the caller can warn instead of shipping a
// blown-out sun.
const future = 'void main() {\n  gl_FragColor = vec4( texColor, 1.0f );\n}';
const missed = balancedSkyFragment(future);
assert.equal(missed.patched, false, 'a reworded output line must not silently match');
assert.equal(missed.shader, future, 'an unmatched shader must be returned unchanged');
// and it must not throw on junk input
assert.equal(balancedSkyFragment(undefined).patched, false);
assert.equal(balancedSkyFragment('').patched, false);
