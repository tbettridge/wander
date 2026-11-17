import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import {
  TrainScheduleModel,
  TRAIN_SCHEDULE_SNAPSHOT_VERSION,
  TRAIN_PHASE,
  forwardGap,
  nameRegionalStations,
  stepTrainLanternShare,
  TRAIN_LANTERN_HANDOVER_SECONDS,
  trainLanternNightLevel,
  trainLanternState,
  PASSENGER_HINT_SECONDS,
  stepPassengerHintTimer,
  xrSeatOriginOffset,
} from '../src/railservice.mjs';
import { createServiceRunId } from '../src/railpassengers.mjs';
import {
  serializeRailwayTerrainPlan, setWorldRailwayTerrain,
} from '../src/railwayterrain.mjs';
import { clearStationSettlementCache, stationSettlements } from '../src/stationsettlement.mjs';
import { settlementOrigin } from '../src/settlementorigin.mjs';
import { stationVillageName } from '../src/settlementspatial.mjs';

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

// --- carriage lamps: drawn light off the train, real lights only aboard -----
assert.equal(trainLanternNightLevel(0), 0, 'the carriage lamps are off by day');
assert.equal(trainLanternNightLevel(1), 1, 'the carriage lamps reach full level at night');
const duskLamp = trainLanternNightLevel(0.5);
assert.ok(duskLamp > 0 && duskLamp < 1, 'the lamps must fade through dusk');

const offTrainNight = trainLanternState(1, false);
assert.equal(offTrainNight.level, 1, 'the lamps still glow at night with nobody aboard');
assert.equal(offTrainNight.realVisible, false, 'no real light while the player is off the train');
assert.equal(offTrainNight.baked, 1, 'off the train the lamps\' light is drawn at full level');
const aboardNight = trainLanternState(1, true);
assert.equal(aboardNight.realVisible, true, 'real lights while aboard at night');
assert.equal(aboardNight.real, 1);
assert.equal(aboardNight.baked, 0, 'the drawn copy steps aside once the real lights are on');
for (const night of [0, 0.2, 0.35, 0.5, 0.8, 1]) {
  for (const aboard of [false, true]) {
    const state = trainLanternState(night, aboard);
    assert.ok(Math.abs(state.real + state.baked - state.level) < 1e-12,
      'drawn and real light together always equal the lamp level, so the swap is seamless');
  }
}
const aboardDay = trainLanternState(0, true);
assert.equal(aboardDay.realVisible, false, 'no real light by day, even aboard');
assert.equal(aboardDay.baked, 0);

// Simulate a night ride in a consist of N cars: wait, board, walk between the
// cars several times, then step off and walk away. Every car shares one state,
// so the count of visible point lights must change only on boarding and once
// the hand-back after leaving finishes. Each change of that count recompiles
// lit programs, so walking between cars must never cause one.
function simulateNightRide(carCount) {
  const dt = 1 / 60;
  let ridingCarriage = -1;
  let share = 0;
  const counts = [];
  let litWhileAboard = true;
  let seamless = true;
  let largestRealStep = 0;
  let previousReal = 0;
  const frame = () => {
    const aboard = ridingCarriage >= 0;
    share = stepTrainLanternShare(share, aboard, dt);
    const state = trainLanternState(1, aboard, share);
    const lit = Array.from({ length: carCount }, () => state.realVisible);
    counts.push(lit.filter(Boolean).length);
    if (aboard && !lit.every(Boolean)) litWhileAboard = false;
    if (Math.abs(state.real + state.baked - state.level) > 1e-12) seamless = false;
    largestRealStep = Math.max(largestRealStep, Math.abs(state.real - previousReal));
    previousReal = state.real;
  };
  for (let f = 0; f < 60; f++) frame(); // waiting on the platform
  ridingCarriage = 0;
  for (let f = 0; f < 120; f++) frame();
  for (let crossing = 0; crossing < 6; crossing++) {
    ridingCarriage = (ridingCarriage + 1) % carCount; // through the gangway
    for (let f = 0; f < 60; f++) frame();
  }
  ridingCarriage = -1; // stepped off
  for (let f = 0; f < 180; f++) frame();
  let changes = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] !== counts[i - 1]) changes++;
  return { changes, litWhileAboard, seamless, largestRealStep, finalCount: counts.at(-1), share };
}
for (const cars of [1, 2, 3]) {
  const ride = simulateNightRide(cars);
  assert.ok(ride.litWhileAboard, `all ${cars} car lamps stay lit while walking between cars`);
  assert.equal(ride.changes, 2, `${cars}-car train: lights change only on boarding and after leaving`);
  assert.equal(ride.finalCount, 0, `${cars}-car train: no real light once the hand-back finishes`);
  assert.equal(ride.share, 0);
  assert.ok(ride.seamless, 'drawn and real light always add up to the lamp level');
  assert.ok(ride.largestRealStep < 0.05, 'the real lights ramp in and out rather than popping');
}
assert.equal(stepTrainLanternShare(0, true, TRAIN_LANTERN_HANDOVER_SECONDS), 1);
assert.equal(stepTrainLanternShare(1, false, TRAIN_LANTERN_HANDOVER_SECONDS), 0);
assert.equal(stepTrainLanternShare(Number.NaN, true, 0), 0);
// Stepping back aboard mid hand-back keeps the lights on, with no extra change.
assert.equal(trainLanternState(1, true, 0.4).realVisible, true);
assert.equal(trainLanternState(1, false, 0.4).realVisible, true, 'still handing back');
assert.equal(trainLanternState(1, false, 0).realVisible, false);

// --- passenger control hints clear from the view after onboarding ----------
assert.deepEqual(PASSENGER_HINT_SECONDS, { boarding: 7, arrival: 6, seatSwitch: 3 });
assert.equal(stepPassengerHintTimer(PASSENGER_HINT_SECONDS.boarding, 2), 5,
  'boarding controls should count down while riding');
assert.equal(stepPassengerHintTimer(1, 4), 0,
  'an expired passenger hint must not persist below zero');

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

// --- schedule state survives JSON round trips during dwell and motion ------
{
  const original = new TrainScheduleModel(1200, [0, 260, 610, 920], {
    cruiseSpeed: 16, dwell: 4, serviceId: 'roundtrip-line',
  });
  original.step(1.25);
  const dwellSnapshot = JSON.parse(JSON.stringify(original.snapshot()));
  assert.equal(dwellSnapshot.version, TRAIN_SCHEDULE_SNAPSHOT_VERSION);
  assert.equal(dwellSnapshot.serviceDay, 0);
  assert.equal(original.serviceRunId, createServiceRunId({
    serviceId: 'roundtrip-line', serviceEpoch: original.serviceEpoch,
    serviceDay: 0, sequence: 0,
  }), 'schedule and passenger manifests must share one canonical run ID');
  const dwellRestored = TrainScheduleModel.restore(dwellSnapshot);
  assert.deepEqual(dwellRestored.snapshot(), dwellSnapshot,
    'dwelling state must survive a JSON round trip exactly');

  while (original.atStation) original.step(0.25);
  for (let i = 0; i < 30; i++) original.step(1 / 30);
  assert.notEqual(original.phase, TRAIN_PHASE.dwelling, 'motion fixture must be moving');
  const motionSnapshot = JSON.parse(JSON.stringify(original.snapshot()));
  const motionRestored = TrainScheduleModel.restore(motionSnapshot);
  assert.deepEqual(motionRestored.snapshot(), motionSnapshot,
    'motion state must survive a JSON round trip exactly');

  const originalVisits = [], restoredVisits = [];
  for (let i = 0; i < 50000 && originalVisits.length < 7; i++) {
    original.step(1 / 30);
    motionRestored.step(1 / 30);
    if (original.justArrived) originalVisits.push(original.currentStationIndex);
    if (motionRestored.justArrived) restoredVisits.push(motionRestored.currentStationIndex);
  }
  assert.deepEqual(restoredVisits, originalVisits,
    'restored service must retain the same subsequent station sequence');
}

// --- route epochs isolate stale manifests and event IDs span service days --
{
  const first = new TrainScheduleModel(1200, [0, 260, 610, 920], {
    dwell: 0.5, serviceId: 'epoch-line', serviceDay: 0,
  });
  const changed = new TrainScheduleModel(1200, [0, 280, 610, 920], {
    dwell: 0.5, serviceId: 'epoch-line', serviceDay: 0,
  });
  assert.notEqual(first.serviceEpoch, changed.serviceEpoch,
    'a changed alignment must receive a different manifest namespace');
  assert.notEqual(first.serviceRunId, changed.serviceRunId,
    'a changed alignment must not reuse an old passenger run ID');

  const nextDay = new TrainScheduleModel(1200, [0, 260, 610, 920], {
    dwell: 0.5, serviceId: 'epoch-line', serviceDay: 1,
  });
  first.step(0.5);
  nextDay.step(0.5);
  assert.ok(first.justDeparted && nextDay.justDeparted);
  assert.notEqual(first.departureEvent.eventId, nextDay.departureEvent.eventId,
    'event receipts must be unique across service days');
}

// --- malformed persistence fails before an invalid cursor reaches getters --
{
  const valid = new TrainScheduleModel(1200, [0, 260, 610, 920]).snapshot();
  assert.throws(() => TrainScheduleModel.restore({ ...valid, targetStop: 0.5 }),
    /non-negative integer/);
  assert.throws(() => TrainScheduleModel.restore({ ...valid, doorFactor: 1.5 }),
    /snapshot bounds/);
  assert.throws(() => TrainScheduleModel.restore({ ...valid, distance: 25 }),
    /dwelling train schedule/);
  assert.throws(() => TrainScheduleModel.restore({ ...valid, velocity: 5 }),
    /dwelling train schedule/);
  assert.throws(() => TrainScheduleModel.restore({
    ...valid, phase: TRAIN_PHASE.cruising, doorFactor: 1, dwellRemaining: 5,
  }), /moving train schedule/);
  assert.throws(() => TrainScheduleModel.restore({
    ...valid,
    stops: valid.stops.map((stop, index) => index === 1 ? { ...stop, index: 0 } : stop),
  }), /stop ordering/);
}

// --- service events are stable, unique, and identify their run -------------
{
  const events = new TrainScheduleModel(1200, [0, 260, 610, 920], {
    cruiseSpeed: 16, dwell: 1, serviceId: 'event-line',
  });
  const arrivals = [], departures = [];
  for (let i = 0; i < 50000 && arrivals.length < 5; i++) {
    events.step(1 / 30);
    if (events.justArrived) {
      assert.equal(events.arrivalEvent.type, 'arrival');
      assert.equal(events.arrivalEvent.stationIndex, events.currentStationIndex);
      arrivals.push(events.arrivalEvent);
    }
    if (events.justDeparted) {
      assert.equal(events.departureEvent.type, 'departure');
      departures.push(events.departureEvent);
    }
  }
  assert.equal(new Set(arrivals.map((event) => event.eventId)).size, arrivals.length);
  assert.equal(new Set(departures.map((event) => event.eventId)).size, departures.length);
  assert.deepEqual(arrivals.slice(0, 4).map((event) => event.stationIndex), [1, 2, 3, 0]);
  assert.equal(arrivals[3].runSequence, 0, 'return arrival closes the current service run');
  assert.equal(departures[4].runSequence, 1, 'next departure opens a new service run');
  assert.notEqual(departures[3].serviceRunId, departures[4].serviceRunId);
}

// --- event identity is independent of ordinary and uneven frame cadence ----
{
  const regular = new TrainScheduleModel(1200, [0, 260, 610, 920], {
    cruiseSpeed: 16, dwell: 1, serviceId: 'cadence-line',
  });
  const uneven = new TrainScheduleModel(1200, [0, 260, 610, 920], {
    cruiseSpeed: 16, dwell: 1, serviceId: 'cadence-line',
  });
  const collect = (subject, cadence) => {
    const ids = [];
    for (let i = 0; i < 80000 && ids.length < 8; i++) {
      subject.step(cadence[i % cadence.length]);
      if (subject.justArrived) ids.push(subject.arrivalEvent.eventId);
    }
    return ids;
  };
  const regularIds = collect(regular, [1 / 60]);
  const unevenIds = collect(uneven, [1 / 90, 1 / 72, 0.045, 0.1]);
  assert.deepEqual(unevenIds, regularIds,
    'arrival identity and ordering must not depend on render cadence');
}

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

// --- a station is named after the village it serves --------------------------
//
// Two naming systems ran independently and disagreed: the platform sign read
// "Birchley Gate" while the village around it was called "Raven Spring". A
// railway named its stations after the places they served, and one place with
// two names is worse than either name on its own.
{
  const railed = new World(4242);
  const railPlan = planRegionalRailway(railed, {
    center: { x: 0, z: 0 }, seed: railed.seed ^ 0x5241494c,
    stationCount: 5, radius: 2600, searchRadius: 5200, exclusions: [],
  });
  setWorldRailwayTerrain(railed, serializeRailwayTerrainPlan(railPlan));
  clearStationSettlementCache();
  const served = nameRegionalStations(railPlan, {
    world: railed, seed: railPlan.seed,
    placeName: (station) => stationVillageName(railed, station),
  });
  assert.equal(new Set(served).size, served.length, `station names collided: ${served}`);
  const villages = stationSettlements(railed, railed.seed);
  assert.ok(villages.length > 0, 'the fixture needs station villages to name from');
  let matched = 0;
  for (const village of villages) {
    const station = railPlan.stations[village.stationIndex];
    if (station && station.name === settlementOrigin(railed, village).name) matched++;
  }
  assert.equal(matched, villages.length,
    `${villages.length - matched} of ${villages.length} stations disagree with their village`);
}

// --- and without a village to borrow from, it names them the old way ----------
// No railway terrain means no station villages, which is the state the world is
// in before the line is planned. Every station still gets a name.
{
  const bare = new World(20260612);
  const barePlan = planRegionalRailway(bare, { center: { x: 0, z: 0 }, seed: 20260612, stationCount: 5 });
  const fallback = nameRegionalStations(barePlan, {
    world: bare, seed: barePlan.seed, placeName: () => null,
  });
  assert.equal(fallback.length, barePlan.stations.length);
  assert.ok(fallback.every((name) => typeof name === 'string' && name.length > 2));
  assert.equal(new Set(fallback).size, fallback.length);
}

const serviceSource = await readFile(new URL('../src/railservice.js', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const lanternSource = await readFile(new URL('../src/trainlanterns.js', import.meta.url), 'utf8');
assert.match(serviceSource, /const lanterns = trainLanternState\(nightAmount, this\.riding, this\._trainLanternShare\)/,
  'carriage lamps follow being aboard the train, not which carriage the player is in');
assert.doesNotMatch(serviceSource, /lantern[^\n]*ridingCarriage/i,
  'no carriage lamp may depend on the carriage the player stands in');
assert.match(serviceSource, /for \(const material of Object\.values\(this\.materials\)\) this\.trainLanterns\.patch\(material\)/,
  'every train material must draw the lamps\' light while the real lights are off');
assert.match(serviceSource, /this\.trainLanterns\.patch\(carriage\.lantern\.globeMaterial\)/,
  'the cloned lamp globes need the drawn light too');
assert.match(serviceSource, /this\.trainLanterns\.setBakedLevel\(lanterns\.baked\)/);
assert.match(serviceSource, /new TrainLanternLight\(CARRIAGE_LANTERN_LIGHT\)/,
  'the drawn light must use the real lights\' colour, intensity, distance and decay');
assert.match(serviceSource, /new THREE\.PointLight\(\s*CARRIAGE_LANTERN_LIGHT\.color, 0, CARRIAGE_LANTERN_LIGHT\.distance, CARRIAGE_LANTERN_LIGHT\.decay\)/);
assert.match(lanternSource, /getDistanceAttenuation\( length\( trainLanternVector \), uTrainLanternDistance, uTrainLanternDecay \)/,
  'the drawn light must fall off exactly as three\'s point light does');
assert.match(lanternSource, /RE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \)/,
  'the drawn light must shade through the material\'s own direct-light equation');
assert.match(lanternSource, /customProgramCacheKey = \(\) => `\$\{previousKey\?\.\(\) \|\| ''\}:train-lantern-bake-v1`/);
assert.match(serviceSource, /this\.xrSeatOrigin = new THREE\.Object3D\(\)/,
  'regional train needs a dedicated WebXR seat tracking origin');
assert.match(serviceSource, /xrSeatOriginOffset\(camera\.position, seatYaw, _seatOffset\)/,
  'boarding must remove the headset tracked height from the authored eye anchor');
assert.match(serviceSource, /this\.ridingHintTimer = PASSENGER_HINT_SECONDS\.boarding/,
  'boarding must begin a short passenger-control onboarding window');
assert.match(serviceSource, /const showRidingHint = this\.ridingHintTimer > 0/,
  'riding action cues must clear after their onboarding timer expires');
assert.match(serviceSource, /import \{ RailPassengerManifest \} from '\.\/railpassengers\.mjs'/,
  'the renderer adapter must consume the pure passenger contract');
assert.match(serviceSource, /passengerManifestProvider\(this\.schedule\.serviceRunId, this\.schedule\)/,
  'the optional provider must be keyed by the authoritative schedule run ID');
assert.match(serviceSource, /manifest instanceof RailPassengerManifest/,
  'the optional provider must return the pure manifest contract');
assert.match(serviceSource, /passengerSeatAnchor\(carriageIndex, seatIndex\)/,
  'later NPC materialization needs a bounds-safe authored seat-anchor lookup');
assert.match(serviceSource, /detectWalkingBoarding\(\)[\s\S]{0,900}carriageThresholdCrossing/,
  'boarding must be detected by a physical open-door threshold crossing');
assert.match(serviceSource, /carriageThresholdCrossing\([\s\S]{0,400}carriageBoardingApproach/,
  'a doorway approach stopped at a jamb must still activate the reliable auto-step');
assert.match(serviceSource,
  /direction: 'exit',[\s\S]{0,500}carriageAlightingApproach[\s\S]{0,300}carriageAlightingRecovery/,
  'alighting must catch both a jamb-stopped step and an already-outside rider');
assert.match(serviceSource,
  /_localPlayer\.z = crossing\.z;\s*this\.exitStanding\(crossing, _localPlayer\);\s*return null/,
  'a successful egress must release carriage ownership before train movement is captured');
assert.match(serviceSource, /trySitNearest\(\)[\s\S]{0,900}nearestCarriageSeat/,
  'seating must remain optional and require proximity to an authored seat');
assert.match(serviceSource, /npcClaimsSeat\(manifest, this\.ridingCarriage, index\)/,
  'optional seating must honor NPC-reserved and occupied anchors');
assert.match(serviceSource, /npcClaimsSeat\(manifest, this\.ridingCarriage, candidate\)/,
  'seat cycling must skip NPC-reserved and occupied authored anchors');
assert.ok(serviceSource.includes('if (this.riding || !this.carriages[carriageIndex]) return false;'),
  'boarding rejection must report failure without mutating player controls');
assert.match(serviceSource, /if \(this\.seated\) this\.syncSeatedRig\(\);\s*else this\.carryStandingPassenger/,
  'standing passengers must remain mobile and be carried by the moving carriage transform');
assert.match(serviceSource,
  /const postHeight = layout\.sideHeaderBottomY - layout\.sideSillTopY[\s\S]{0,900}for \(const \[z0, z1\] of sidePosts\)/,
  'carriage mullions must extend from the sill into the raised roof header');
assert.doesNotMatch(serviceSource, /\[x, 2\.50, \(z0 \+ z1\) \/ 2\]/,
  'the former floating rail must not cut horizontally across the panoramic windows');
assert.match(serviceSource, /makeCarriage\(this\.materials, \{ interCarEnd: i === 0 \? -1 : 1 \}\)/,
  'the paired carriages must open only their mutually facing end vestibules');
assert.match(serviceSource, /this\.updateInterCarGangway\(\)/,
  'the articulated passenger bridge must follow the moving carriage endpoints every frame');
assert.match(serviceSource, /transferAcrossGangway\(_worldResolved\)/,
  'walking across the bridge must transfer moving-frame ownership without teleporting');
assert.match(serviceSource, /Open vestibule floor tongue/,
  'each connected carriage end needs a visible floor tongue through its open vestibule');
assert.match(serviceSource, /Gangway portal header/,
  'the bridge needs a clearly rendered structural portal at each carriage end');
assert.ok(Number(mainSource.match(/railservice\.js\?v=(\d+)/)?.[1]) >= 4,
  'the app entrypoint must invalidate a cached pre-egress-fix rail service module');
// A floor, not a pin: this only has to be newer than the broken build, and an
// equality here made every later cache bump fail an unrelated test.
const deployedEntrypointVersion = Number(indexSource.match(/main\.js\?v=(\d+)/)?.[1]);
assert.ok(deployedEntrypointVersion >= 107,
  `the deployed page must invalidate the cached pre-egress-fix application graph, saw v=${deployedEntrypointVersion}`);

console.log(`railservice PASS · circuit ${visited.slice(0, 6).join('→')} · peak ${maxSpeed.toFixed(1)}m/s · ${names.join(', ')}`);
