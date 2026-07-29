import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  LANTERN_SWING_LIMIT,
  createLanternSwingState,
  lanternFlicker,
  lanternIgnitionTarget,
  lanternLightIntensity,
  lanternPresenceTarget,
  lanternSwingTarget,
  stepLanternSwing,
} from '../src/lanternmotion.mjs';

const samples = Array.from({ length: 600 }, (_, i) => lanternFlicker(i / 60));
assert.ok(Math.min(...samples) >= 0.93, 'flame must never strobe dark');
assert.ok(Math.max(...samples) <= 1, 'flame flicker must remain restrained');
assert.ok(new Set(samples.map((value) => value.toFixed(4))).size > 100,
  'flicker should stay alive instead of repeating a short stepped loop');
assert.equal(lanternFlicker(2.5), lanternFlicker(2.5), 'flicker must be deterministic');
assert.equal(lanternLightIntensity(0, 3), 0, 'an extinguished lantern must emit no light');
assert.ok(lanternLightIntensity(1, 3) > 3, 'a lit lantern must provide useful local light');
assert.equal(lanternPresenceTarget(true, 0), 1,
  'summoning begins with the unlit physical lantern');
assert.equal(lanternIgnitionTarget(true, 0.7), 0,
  'flame must wait until the lantern is nearly presented');
assert.ok(lanternIgnitionTarget(true, 0.98) > 0.9,
  'flame must fade up at the end of the reveal');
assert.equal(lanternPresenceTarget(false, 0.5), 1,
  'lantern must remain presented while its light fades');
assert.equal(lanternPresenceTarget(false, 0), 0,
  'fully extinguished lantern must be allowed to withdraw');

const drive = lanternSwingTarget({
  accelerationX: 100,
  accelerationZ: -100,
  speed: 20,
  walkPhase: Math.PI * 0.5,
});
assert.ok(Math.abs(drive.pitch) <= LANTERN_SWING_LIMIT);
assert.ok(Math.abs(drive.roll) <= LANTERN_SWING_LIMIT);

const swing = createLanternSwingState();
for (let i = 0; i < 90; i++) {
  stepLanternSwing(swing, 1 / 60, { pitch: 0.12, roll: -0.08 });
}
assert.ok(swing.pitch > 0.105 && swing.pitch < 0.125,
  'weighted pendulum must settle near its driven pitch');
assert.ok(swing.roll < -0.07 && swing.roll > -0.09,
  'weighted pendulum must settle near its driven roll');
for (let i = 0; i < 180; i++) {
  stepLanternSwing(swing, 1 / 60, { pitch: 0, roll: 0 });
}
assert.ok(Math.abs(swing.pitch) < 0.001 && Math.abs(swing.roll) < 0.001,
  'pendulum must damp cleanly after motion stops');

const source = await readFile(new URL('../src/carriedlantern.js', import.meta.url), 'utf8');
assert.match(source, /new THREE\.PointLight\(0xffc36a/,
  'carried lantern must use a warm amber point light');
assert.match(source, /new THREE\.PointLight\(0xffc36a, 0, 0, 1\.7\)/,
  'carried lantern must use natural attenuation without a finite cutoff ring');
assert.match(source, /getControllerGrip\(index\)/,
  'XR lantern must follow a physical grip space');
assert.match(source, /this\.root\.quaternion\.copy\(_worldQuaternion\)\.invert\(\)/,
  'XR lantern must hang against gravity instead of copying wrist rotation');
assert.match(source, /!xr && allowDynamicShadows/,
  'costly point-light shadows must stay out of standalone XR');
assert.match(source, /this\.root\.visible = hasPresentationSpace/,
  'the extinguished, withdrawn lantern subtree must stop rendering');

console.log('lanternmotion PASS · staged reveal/ignite · staged extinguish/hide · deterministic flame · damped swing · XR grip anchor');
