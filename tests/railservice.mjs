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
  occupiedCarriageLanternLevel,
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

// --- only the occupied passenger car receives dim night illumination ------
assert.equal(occupiedCarriageLanternLevel(1, 0, -1), 0, 'no rider means no carriage light');
assert.equal(occupiedCarriageLanternLevel(1, 1, 0), 0, 'an empty carriage stays dark');
assert.equal(occupiedCarriageLanternLevel(0, 0, 0), 0, 'the occupied carriage stays off by day');
assert.equal(occupiedCarriageLanternLevel(1, 0, 0), 1, 'the occupied carriage reaches full lamp level at night');
const duskLamp = occupiedCarriageLanternLevel(0.5, 0, 0);
assert.ok(duskLamp > 0 && duskLamp < 1, 'the lantern must fade through dusk');

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
assert.match(mainSource, /railservice\.js\?v=3/,
  'the app entrypoint must invalidate a cached pre-egress-fix rail service module');
assert.match(indexSource, /main\.js\?v=98/,
  'the deployed page must invalidate the cached pre-egress-fix application graph');

console.log(`railservice PASS · circuit ${visited.slice(0, 6).join('→')} · peak ${maxSpeed.toFixed(1)}m/s · ${names.join(', ')}`);
