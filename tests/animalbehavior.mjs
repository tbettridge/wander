import assert from 'node:assert/strict';
import {
  alertnessStage,
  animalAwareness,
  arcTurnRate,
  chooseAnimalGoal,
  chooseTerrainHeading,
  terrainSpeedScale,
  turnSpeedScale,
  updateAnimalAlertness,
} from '../src/animalbehavior.mjs';

assert.equal(animalAwareness(7), 'flee', 'legacy awareness compatibility export regressed');

let alertness = 0;
for (let i = 0; i < 3; i++) {
  alertness = updateAnimalAlertness(alertness, {
    dt: 0.2, distance: 6, sightRange: 48, visible: true, inView: true,
  });
}
assert.equal(alertnessStage(alertness), 'escape',
  'a close visible player did not build persistent escape alertness');
const remembered = updateAnimalAlertness(0.65, {
  dt: 1, distance: 80, visible: false, memory: 8,
});
const forgotten = updateAnimalAlertness(0.65, {
  dt: 1, distance: 80, visible: false, memory: 0,
});
assert.ok(remembered > forgotten,
  'remembered danger did not slow alertness recovery');
const heard = updateAnimalAlertness(0, {
  dt: 0.25, distance: 15, visible: false, playerSpeed: 5,
});
assert.ok(heard > 0.05, 'running player produced no audible alertness');
assert.equal(chooseAnimalGoal({ food: 3, water: 1 }, 0.1), 'food');
assert.equal(chooseAnimalGoal({ food: 3, water: 1 }, 0.9), 'water');
assert.equal(chooseAnimalGoal({}, 0.5), 'home');

assert.equal(arcTurnRate(0, 1.2, 1.5), 0, 'stationary animal can pivot in place');
assert.ok(arcTurnRate(0.6, 1.2, 1.5) <= 0.401,
  'turn rate ignored the minimum forward turn radius');
assert.ok(turnSpeedScale(Math.PI) < turnSpeedScale(0.2),
  'sharp direction change did not reduce forward speed');
assert.ok(terrainSpeedScale(0.32) < terrainSpeedScale(0.08),
  'steep grade did not reduce movement speed');

// The direct target is a 50% uphill grade. A gentler contour exists to either
// side, so local route scoring must prefer it even though it is less direct.
const contourRoute = chooseTerrainHeading({
  x: 0,
  z: 0,
  currentHeading: 0,
  targetHeading: 0,
  lookAhead: 8,
  sampleHeight: (x, z) => z * 0.5 + Math.abs(x) * 0.015,
  traversable: () => true,
  turnPreference: 1,
});
assert.ok(Math.abs(contourRoute.heading) > 0.60,
  `route stayed on the steep fall line (${contourRoute.heading.toFixed(2)}rad)`);
assert.ok(contourRoute.grade < 0.36,
  `route did not reduce grade (${contourRoute.grade.toFixed(2)})`);

// When the destination lies directly along a contour, the animal should not
// sidehill with one pair of legs perpetually compressed. It should choose a
// shallow diagonal containing both contour and ascent/descent components.
const sidehillRoute = chooseTerrainHeading({
  x: 0,
  z: 0,
  currentHeading: Math.PI * 0.5,
  targetHeading: Math.PI * 0.5,
  lookAhead: 8,
  sampleHeight: (_x, z) => z * 0.35,
  traversable: () => true,
  turnPreference: 1,
});
assert.ok(Math.abs(sidehillRoute.heading - Math.PI * 0.5) > 0.25,
  'route followed the contour with no uphill/downhill component');
assert.ok(sidehillRoute.fallLineRatio > 0.20 && sidehillRoute.fallLineRatio < 0.72,
  `route was not an oblique traverse (${sidehillRoute.fallLineRatio.toFixed(2)} fall-line ratio)`);

const safeRoute = chooseTerrainHeading({
  x: 0,
  z: 0,
  currentHeading: 0,
  targetHeading: 0,
  sampleHeight: () => 0,
  traversable: (x) => Math.abs(x) > 0.5,
  turnPreference: -1,
});
assert.equal(safeRoute.safe, true, 'route planner selected blocked ground');
assert.ok(Math.abs(safeRoute.heading) > 0.3, 'route planner did not steer around blocked ground');

console.log('animalbehavior PASS · persistent multimodal alertness · contextual goals · oblique hill routing');
