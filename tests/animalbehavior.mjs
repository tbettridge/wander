import assert from 'node:assert/strict';
import {
  animalAwareness,
  arcTurnRate,
  chooseTerrainHeading,
  terrainSpeedScale,
  turnSpeedScale,
} from '../src/animalbehavior.mjs';

assert.equal(animalAwareness(24), 'unconcerned', 'distant player interrupted normal behaviour');
assert.equal(animalAwareness(12), 'pause', 'caution band did not pause the animal');
assert.equal(animalAwareness(7.99), 'flee', 'sub-8m player did not trigger flight');
assert.equal(animalAwareness(8), 'pause', 'animal fled when the player was not within 8m');

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

console.log('animalbehavior PASS · peripheral awareness · oblique hill routing · forward turn arcs');
