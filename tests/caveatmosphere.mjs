import assert from 'node:assert/strict';
import {
  adaptCaveExposure,
  caveEntranceLight,
  caveExposureTarget,
  caveFogRange,
  caveInteriorTarget,
} from '../src/caveatmosphere.mjs';

const mouth = [0, 2, -36];
assert.equal(caveInteriorTarget(false, { x: 0, y: 2, z: 0 }, mouth), 0,
  'outdoor player must retain the surface atmosphere');
assert.equal(caveInteriorTarget(true, { x: 0, y: 2, z: -36 }, mouth), 0,
  'portal threshold should not switch atmosphere abruptly');
assert.ok(caveInteriorTarget(true, { x: 0, y: 2, z: -26 }, mouth) > 0.3,
  'first chamber should begin the underground blend');
assert.equal(caveInteriorTarget(true, { x: 38, y: -8, z: -34 }, mouth), 1,
  'a cave bending behind the mouth plane must remain fully underground');
assert.equal(caveInteriorTarget(true, { x: 0, y: -28, z: -35 }, mouth), 1,
  'a stacked level directly below the mouth must remain fully underground');

const clearDay = caveEntranceLight(0.65, 0, {
  sunVisibility: 1, hemiScale: 1, cloudShade: 0, storm: 0, rain: 0,
});
const overcastDay = caveEntranceLight(0.65, 0, {
  sunVisibility: 0.5, hemiScale: 1.2, cloudShade: 0.6, storm: 0, rain: 0.03,
});
const stormDay = caveEntranceLight(0.65, 0, {
  sunVisibility: 0.2, hemiScale: 1.08, cloudShade: 0.8, storm: 1, rain: 1,
});
const fullMoon = caveEntranceLight(-0.75, 1, { moonVisibility: 1 });
const newMoon = caveEntranceLight(-0.75, 0, { moonVisibility: 1 });
assert.ok(clearDay.intensity > overcastDay.intensity,
  'clear daylight should penetrate farther than flat overcast light');
assert.ok(overcastDay.intensity > stormDay.intensity,
  'storm entrances should be markedly darker than overcast entrances');
assert.ok(fullMoon.intensity > newMoon.intensity,
  'moon phase should affect night entrance visibility');
assert.ok(caveEntranceLight(0, 0, { sunVisibility: 1 }).warmth > clearDay.warmth,
  'dawn/dusk entrance light should be warmer than midday');

const deepTarget = caveExposureTarget(1);
let entering = 1;
for (let i = 0; i < 60; i++) entering = adaptCaveExposure(entering, deepTarget, 1 / 60);
let leaving = deepTarget;
for (let i = 0; i < 60; i++) leaving = adaptCaveExposure(leaving, 1, 1 / 60);
assert.ok(entering > 1 && entering < deepTarget, 'dark adaptation should ease, not pop');
assert.ok(leaving < entering, 'returning to daylight should adapt faster than entering darkness');
const dryFog = caveFogRange(1, 0), wetFog = caveFogRange(1, 1);
assert.ok(wetFog.near < dryFog.near && wetFog.far < dryFog.far,
  'wet cave atmosphere should be denser than dry cave air');

console.log(`caveatmosphere PASS · day ${clearDay.intensity.toFixed(2)} · storm ${stormDay.intensity.toFixed(2)} · exposure ${deepTarget.toFixed(2)}`);
