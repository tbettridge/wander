import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import {
  TrainScheduleModel,
  TRAIN_PHASE,
  forwardGap,
  nameRegionalStations,
  xrSeatOriginOffset,
} from '../src/railservice.mjs';

// --- forwardGap wraps correctly on a closed route --------------------------
assert.equal(forwardGap(10, 40, 100), 30);
assert.equal(forwardGap(90, 10, 100), 20, 'gap must wrap past the seam');
assert.equal(forwardGap(50, 50, 100), 0);

// --- XR seating cancels the current tracked head pose at the eye anchor ----
assert.deepEqual(xrSeatOriginOffset({ x: 0.18, y: 1.72, z: -0.09 }, 0), {
  x: -0.18,
  y: -1.72,
  z: 0.09,
});
const turnedHead = { x: 0.18, y: 1.72, z: -0.09 };
const turnedYaw = Math.PI * 0.5;
const turnedOffset = xrSeatOriginOffset(turnedHead, turnedYaw);
const turnedC = Math.cos(turnedYaw), turnedS = Math.sin(turnedYaw);
assert.ok(Math.abs(turnedOffset.x + turnedC * turnedHead.x + turnedS * turnedHead.z) < 1e-12);
assert.ok(Math.abs(turnedOffset.y + turnedHead.y) < 1e-12);
assert.ok(Math.abs(turnedOffset.z - turnedS * turnedHead.x + turnedC * turnedHead.z) < 1e-12);

// --- schedule reaches every station in order and dwells --------------------
const length = 12000;
const stops = [0, 2600, 5400, 8100, 10200];
const model = new TrainScheduleModel(length, stops, { cruiseSpeed: 16, dwell: 4 });
assert.equal(model.phase, TRAIN_PHASE.dwelling, 'train should start dwelling at a station');
assert.equal(model.currentStationIndex, 0);

const dt = 1 / 30;
const visited = [];
let maxSpeed = 0;
let arrivalSpeedPeak = 0;
let lastPhase = model.phase;
for (let i = 0; i < 90000; i++) {
  const before = model.velocity;
  model.step(dt);
  maxSpeed = Math.max(maxSpeed, model.velocity);
  if (model.justArrived) {
    // Arrivals must be gentle — never snap to a stop from cruising speed.
    arrivalSpeedPeak = Math.max(arrivalSpeedPeak, before);
    visited.push(model.currentStationIndex);
  }
  // Velocity must never exceed the cruise ceiling (plus a step of slack).
  assert.ok(model.velocity <= model.cruiseSpeed + 0.05, `overspeed ${model.velocity}`);
  lastPhase = model.phase;
  if (visited.length >= 7) break;
}
assert.ok(visited.length >= 6, `train did not complete a circuit: ${visited}`);
// Visits should march through the stops in ascending route order and wrap.
const order = [1, 2, 3, 4, 0, 1];
assert.deepEqual(visited.slice(0, 6), order, `unexpected stop order: ${visited}`);
assert.ok(maxSpeed > 10, `train never reached cruising speed: ${maxSpeed}`);
assert.ok(arrivalSpeedPeak < 1.0, `arrivals were not gentle: ${arrivalSpeedPeak} m/s a step before stop`);

// --- uneven headset frame cadence cannot step across and skip a station ----
const xrCadence = [1 / 90, 1 / 72, 0.1, 0.045, 0.1, 1 / 90];
const xrModel = new TrainScheduleModel(1200, [0, 260, 610, 920], {
  cruiseSpeed: 16,
  dwell: 4,
});
const xrVisited = [];
for (let i = 0; i < 30000 && xrVisited.length < 8; i++) {
  const gapBefore = xrModel.distanceToNext;
  const movingBefore = !xrModel.atStation;
  xrModel.step(xrCadence[i % xrCadence.length]);
  assert.ok(
    !movingBefore || xrModel.justArrived || xrModel.atStation
      || gapBefore >= 4 || xrModel.distanceToNext < 8,
    `VR cadence skipped a stop: ${gapBefore.toFixed(3)}m became ${xrModel.distanceToNext.toFixed(3)}m`,
  );
  if (xrModel.justArrived) xrVisited.push(xrModel.currentStationIndex);
}
assert.deepEqual(xrVisited.slice(0, 7), [1, 2, 3, 0, 1, 2, 3],
  `VR cadence missed or reordered stations: ${xrVisited}`);

// --- doors open during dwell and are shut while moving ---------------------
const doorModel = new TrainScheduleModel(length, stops, { dwell: 6 });
let sawOpenDoors = false;
let doorsShutWhileMoving = true;
for (let i = 0; i < 4000; i++) {
  doorModel.step(dt);
  if (doorModel.atStation && doorModel.doorFactor > 0.9) sawOpenDoors = true;
  if (!doorModel.atStation && doorModel.doorFactor > 0.01) doorsShutWhileMoving = false;
}
assert.ok(sawOpenDoors, 'doors never fully opened during a dwell');
assert.ok(doorsShutWhileMoving, 'doors were open while the train was moving');

// --- naming is deterministic, unique, and biome-flavoured ------------------
const world = new World(20260612);
const plan = planRegionalRailway(world, { center: { x: 0, z: 0 }, seed: 20260612, stationCount: 5 });
const names = nameRegionalStations(plan, { world, seed: plan.seed });
assert.equal(names.length, plan.stations.length);
assert.ok(plan.stations.every((s) => typeof s.name === 'string' && s.name.length > 2));
assert.equal(new Set(names).size, names.length, `station names collided: ${names}`);
// Re-naming the same plan/seed yields identical names.
const again = nameRegionalStations(plan, { world, seed: plan.seed });
assert.deepEqual(names, again);

const serviceSource = await readFile(new URL('../src/railservice.js', import.meta.url), 'utf8');
assert.match(serviceSource, /this\.xrSeatOrigin = new THREE\.Object3D\(\)/,
  'regional train needs a dedicated WebXR seat tracking origin');
assert.match(serviceSource, /xrSeatOriginOffset\(camera\.position, seatYaw, _seatOffset\)/,
  'boarding must remove the headset tracked height from the authored eye anchor');

console.log(`railservice PASS · circuit ${visited.slice(0, 6).join('→')} · peak ${maxSpeed.toFixed(1)}m/s · ${names.join(', ')}`);
