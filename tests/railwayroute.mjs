import assert from 'node:assert/strict';
import { ClosedRailRoute, createClosedRailRoute } from '../src/railwayroute.mjs';

const controls = [
  { x: -100, z: -60 }, { x: 80, z: -70 },
  { x: 120, z: 55 }, { x: -70, z: 85 },
];
const route = createClosedRailRoute(controls, (x, z) => 10 + x * 0.001, {
  sampleCount: 400,
});

assert.ok(route instanceof ClosedRailRoute);
assert.ok(route.length > 500 && route.length < 900, `unexpected loop length ${route.length}`);
assert.ok(route.maxGrade < 0.01, `unexpected grade ${route.maxGrade}`);
assert.ok(route.meanGrade > 0 && route.meanGrade < route.maxGrade);

const start = route.sampleAtDistance(0, {});
const wrapped = route.sampleAtDistance(route.length, {});
assert.ok(Math.hypot(start.x - wrapped.x, start.y - wrapped.y, start.z - wrapped.z) < 1e-7,
  'distance equal to loop length must wrap exactly to the start');

const negative = route.sampleAtDistance(-12, {});
const positive = route.sampleAtDistance(route.length - 12, {});
assert.ok(Math.hypot(negative.x - positive.x, negative.y - positive.y, negative.z - positive.z) < 1e-7,
  'negative distance wrapping is inconsistent');

for (let i = 0; i < 80; i++) {
  const sample = route.sampleAtDistance(route.length * i / 80, {});
  assert.ok(Math.abs(Math.hypot(sample.tangentX, sample.tangentY, sample.tangentZ) - 1) < 1e-7);
  assert.ok(Math.abs(Math.hypot(sample.rightX, sample.rightY, sample.rightZ) - 1) < 1e-7);
  assert.ok(Math.abs(Math.hypot(sample.upX, sample.upY, sample.upZ) - 1) < 1e-7);
  const tangentRight = sample.tangentX * sample.rightX
    + sample.tangentY * sample.rightY + sample.tangentZ * sample.rightZ;
  const tangentUp = sample.tangentX * sample.upX
    + sample.tangentY * sample.upY + sample.tangentZ * sample.upZ;
  const rightUp = sample.rightX * sample.upX
    + sample.rightY * sample.upY + sample.rightZ * sample.upZ;
  assert.ok(Math.abs(tangentRight) < 1e-7, 'route frame is not orthogonal');
  assert.ok(Math.abs(tangentUp) < 1e-7, 'route tangent/up frame is not orthogonal');
  assert.ok(Math.abs(rightUp) < 1e-7, 'route right/up frame is not orthogonal');
}

const nearest = route.nearestDistance(start.x, start.z);
assert.ok(nearest < route.length * 0.02 || nearest > route.length * 0.98);

console.log(`railwayroute PASS · ${Math.round(route.length)}m closed arc-length route`);
