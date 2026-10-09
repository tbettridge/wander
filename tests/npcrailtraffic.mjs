import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState, attachNpcSpatialState, registerLivingWorldEntity, LivingWorldStateStore } from '../src/livingworldstate.mjs';
import { createItinerary } from '../src/npcitinerary.mjs';
import { TrainScheduleModel } from '../src/railservice.mjs';
import { createServiceRunId, railVehicleId, RailPassengerManifest } from '../src/railpassengers.mjs';
import { registerNpcItinerary, reserveNpcRailPassenger, reserveNpcRailParty, railVehiclePassengerManifest, loadNpcItinerary, releaseMissedRailReservations } from '../src/npcmobility.mjs';
import { scheduleRailPassengerTraffic, npcRailJourneyContext } from '../src/npcrailtraffic.mjs';
import { tickAllNpcMobilityItineraries, tickNpcMobilityItinerary } from '../src/npcmobilityexecutor.mjs';
import { trainPassengerTarget } from '../src/npcmobilitydemand.mjs';
import { auditNpcMobilityState } from '../src/npcmobilityquality.mjs';
import { npcRailCarriageLocalPose } from '../src/npcrailtransfer.mjs';

function fixture(seed = 19) {
  const state = createLivingWorldState({ worldSeed: seed });
  const stations = Array.from({ length: 4 }, (_, index) => {
    const id = `station:${index}`, settlementId = `town:${index}`, residentIds = [], buildings = [];
    for (let householdIndex = 0; householdIndex < 8; householdIndex++) {
      const householdId = `${settlementId}:household:${householdIndex}`, homeBuildingId = `${householdId}:home`;
      const memberIds = [];
      buildings.push({ id: homeBuildingId, program: 'dwelling', x: 12 + householdIndex * 5, z: index * 1000 });
      for (let member = 0; member < 3; member++) {
        const actorId = `${householdId}:person:${member}`;
        const entity = registerLivingWorldEntity(state, { id: actorId, kind: 'npc', name: `Resident ${index}.${householdIndex}.${member}`,
          householdId, workplaceId: `${settlementId}:work`, workplaceName: `Workshop ${index}`, role: member === 2 ? 'child' : 'worker' });
        attachNpcSpatialState(state, actorId, { residence: { originSettlementId: settlementId, residenceSettlementId: settlementId,
          householdId, homeBuildingId }, location: { kind: 'building', settlementId, buildingId: homeBuildingId } });
        residentIds.push(entity.id); memberIds.push(entity.id);
      }
      state.households[householdId] = { id: householdId, form: 'partners', memberIds, homeBuildingId };
    }
    buildings.push({ id: `${settlementId}:work`, program: 'workshop', x: 80, z: index * 1000 });
    return { id, settlementId, residentIds, name: `Town ${index}`, segmentSeconds: 90,
      plan: { buildings, localGraph: { nodes: [{ key: `${settlementId}:centre`, kind: 'centre', x: 50, z: index * 1000 }] } } };
  });
  const schedule = new TrainScheduleModel(4000, [0, 1000, 2000, 3000], { dwell: 16, serviceId: 'regional' });
  return { state, stations, schedule };
}

function descriptor(schedule, stations) {
  return { runId: schedule.serviceRunId, serviceId: schedule.serviceId, phase: schedule.phase,
    stationId: schedule.atStation ? stations[schedule.currentStationIndex].id : null,
    nextStationId: stations[schedule.nextStationIndex].id, doorFactor: schedule.doorFactor,
    dwellRemaining: schedule.dwellRemaining, dwell: schedule.dwell,
    etaSeconds: schedule.etaSeconds, serviceTick: schedule.serviceSeconds, departureSequence: schedule.departureSequence };
}

test('whole-train targets obey all five sky periods and stay deterministic', () => {
  for (const [hour, period, min, max] of [[7, 'morning', 4, 6], [12, 'daytime', 2, 4],
    [17, 'afternoon', 4, 6], [20, 'evening', 1, 3], [0, 'night', 1, 2], [23, 'night', 1, 2]]) {
    for (let seed = 1; seed <= 50; seed++) {
      const input = { worldSeed: seed, runId: 'run:1', hour, departureSequence: 7 };
      const result = trainPassengerTarget(input);
      assert.deepEqual(result, trainPassengerTarget(input));
      assert.equal(result.period, period); assert.ok(result.target >= min && result.target <= max);
    }
  }
});

test('a fresh service starts occupied by real residents and does not bootstrap again after reload', () => {
  const { state, stations, schedule } = fixture();
  const result = scheduleRailPassengerTraffic(state, { stations, service: descriptor(schedule, stations), bootstrap: true, hour: 7 });
  assert.ok(result.bootstrapped.length >= 4 && result.bootstrapped.length <= 6);
  for (const id of result.bootstrapped) {
    const entity = state.entities[id];
    assert.ok(entity.householdId && entity.residence.homeBuildingId);
    assert.ok(entity.itineraryId);
    assert.equal(entity.activity.legKind, 'train-ride');
    const context = npcRailJourneyContext(state, id);
    assert.ok(context.purpose && context.from && context.to && context.returnPlan);
  }
  const values = new Map(), storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const store = new LivingWorldStateStore({ worldSeed: state.worldSeed, storage });
  assert.equal(store.save(state), true);
  const restored = store.load();
  const again = scheduleRailPassengerTraffic(restored, { stations, service: descriptor(schedule, stations), bootstrap: true, hour: 7 });
  assert.equal(again.bootstrapped.length, 0);
  for (const id of result.bootstrapped) assert.deepEqual(restored.entities[id].location, state.entities[id].location);
  assert.equal(auditNpcMobilityState(restored).ok, true);
});

test('the same physical train keeps old-circuit occupancy, standing places and player seats', () => {
  const { state, stations, schedule } = fixture();
  const run0 = schedule.serviceRunId;
  const run1 = createServiceRunId({ serviceId: schedule.serviceId, serviceEpoch: schedule.serviceEpoch, sequence: 1 });
  const ids = stations[0].residentIds.slice(0, 6);
  const allocations = reserveNpcRailParty(state, { runId: run0, originStationId: stations[0].id,
    destinationStationId: stations[2].id, members: ids.map((personId, i) => ({ personId, accommodation: i === 1 ? 'standing' : 'seat' })) });
  assert.equal(railVehicleId(run0), railVehicleId(run1));
  const view = railVehiclePassengerManifest(state, run1);
  assert.equal(view.reservations().length, 6);
  assert.ok(view.playerAvailableSeat(0)); assert.ok(view.playerAvailableSeat(1));
  const before = JSON.stringify(state.railManifests);
  assert.throws(() => reserveNpcRailPassenger(state, { runId: run1, personId: stations[1].residentIds[0],
    originStationId: stations[1].id, destinationStationId: stations[2].id }), /available|capacity/);
  assert.equal(JSON.stringify(state.railManifests), before);
  const standing = allocations.find((a) => a.accommodation === 'standing');
  assert.equal(standing.seatIndex, null);
});

test('a family gets all its places or no mutations when only two remain', () => {
  const { state, stations, schedule } = fixture();
  for (const personId of stations[0].residentIds.slice(0, 4)) reserveNpcRailPassenger(state, {
    runId: schedule.serviceRunId, personId, originStationId: stations[0].id, destinationStationId: stations[1].id });
  const before = JSON.stringify(state);
  assert.throws(() => reserveNpcRailParty(state, { runId: schedule.serviceRunId,
    originStationId: stations[1].id, destinationStationId: stations[2].id,
    members: stations[1].residentIds.slice(0, 3).map((personId) => ({ personId })) }), /available|capacity/);
  assert.equal(JSON.stringify(state), before);
});

test('repeat journeys on the same circuit retain the earlier boarding and alighting receipts', () => {
  const manifest = new RailPassengerManifest({ runId: 'run:1' });
  const first = manifest.reserve({ personId: 'person:1', originStationId: 'a', destinationStationId: 'b' });
  manifest.board('person:1', 'a'); manifest.alight('person:1', 'b');
  const second = manifest.reserve({ personId: 'person:1', originStationId: 'b', destinationStationId: 'a' });
  assert.notEqual(first.reservationId, second.reservationId);
  const restored = RailPassengerManifest.restore(manifest.snapshot());
  assert.equal(restored.reservations().length, 2);
  assert.ok(restored.reservations().find((r) => r.reservationId === first.reservationId).alightReceipt);
  assert.equal(restored.reservationForPerson('person:1').reservationId, second.reservationId);
});

test('old seat-only saves remain readable and missed boarding releases places without moving the person', () => {
  const { state, stations, schedule } = fixture();
  const id = stations[0].residentIds[0], entity = state.entities[id];
  const reservation = reserveNpcRailPassenger(state, { runId: schedule.serviceRunId, personId: id,
    originStationId: stations[0].id, destinationStationId: stations[1].id });
  const snapshot = state.railManifests[schedule.serviceRunId];
  snapshot.version = 1;
  assert.equal(RailPassengerManifest.restore(snapshot).reservationForPerson(id).reservationId, reservation.reservationId);
  const before = structuredClone(entity.location);
  const released = releaseMissedRailReservations(state, { runId: schedule.serviceRunId, phase: 'cruising', stationId: null });
  assert.equal(released, 1);
  assert.deepEqual(entity.location, before);
  assert.equal(railVehiclePassengerManifest(state, schedule.serviceRunId).reservations().length, 0);
});

test('a passenger crossing the starting station stays aboard through rollover and completes the return trip', () => {
  const { state, stations, schedule } = fixture();
  const entity = state.entities[stations[3].residentIds[0]], home = structuredClone(entity.location);
  const platform = (index) => ({ kind: 'station-platform', stationId: stations[index].id,
    platformId: `platform:${index}:main`, waitAnchorId: `wait:${index}` });
  const destination = { kind: 'building', settlementId: stations[1].settlementId, buildingId: stations[1].plan.buildings[0].id };
  const legs = (direction, origin, dest, from, to) => [
    { id: `${direction}:walk`, kind: 'local-walk', data: { durationSeconds: 10, fromLocation: from, toLocation: platform(origin) } },
    { id: `${direction}:wait`, kind: 'station-wait', data: { originStationId: stations[origin].id, platformLocation: platform(origin) } },
    { id: `${direction}:board`, kind: 'board-train', data: { originStationId: stations[origin].id, destinationStationId: stations[dest].id, platformLocation: platform(origin) } },
    { id: `${direction}:ride`, kind: 'train-ride', data: { destinationStationId: stations[dest].id } },
    { id: `${direction}:alight`, kind: 'alight-train', data: { destinationStationId: stations[dest].id, platformLocation: platform(dest) } },
    { id: `${direction}:finish`, kind: 'local-walk', data: { durationSeconds: 10, fromLocation: platform(dest), toLocation: to } },
  ];
  const trip = createItinerary({ id: 'trip:rollover', actorId: entity.id, residence: entity.residence,
    origin: { key: home.buildingId }, destination: { key: destination.buildingId }, purpose: { kind: 'visit' },
    outboundLegs: legs('outbound', 3, 1, home, destination),
    activity: { kind: 'visit', data: { durationSeconds: 0, durationHours: 0.1, location: destination } },
    returnLegs: legs('return', 1, 3, destination, home) });
  registerNpcItinerary(state, trip);
  let boards = 0, alights = 0, crossedRunBoundary = false;
  for (let frame = 0; frame < 6000 && entity.itineraryId; frame++) {
    schedule.step(0.25); state.clock.worldHours += 0.25 / 50;
    const report = tickNpcMobilityItinerary(state, entity.id, { deltaSeconds: 0.25,
      worldHours: state.clock.worldHours, railServices: [descriptor(schedule, stations)] });
    boards += report.boards.filter((r) => r.applied).length;
    alights += report.alights.filter((r) => r.applied).length;
    if (entity.location.runId && entity.location.runId !== schedule.serviceRunId) {
      crossedRunBoundary = true;
      assert.ok(railVehiclePassengerManifest(state, schedule.serviceRunId).reservationForPerson(entity.id));
    }
  }
  assert.equal(crossedRunBoundary, true); assert.equal(boards, 2); assert.equal(alights, 2);
  assert.equal(loadNpcItinerary(state, trip.id).status, 'completed');
  assert.deepEqual(entity.location, home);
  assert.equal(auditNpcMobilityState(state).ok, true);
});

test('long village access walks are staged before the first train instead of leaving a whole empty circuit', () => {
  const { state, stations, schedule } = fixture(19);
  const plan = scheduleRailPassengerTraffic(state, { stations, service: descriptor(schedule, stations),
    bootstrap: true, hour: 7, walkDurationFor: () => 350 });
  const approaching = plan.planned.filter((trip) => !plan.bootstrapped.includes(trip.actorId));
  assert.ok(approaching.length > 0);
  assert.ok(approaching.some((trip) => (state.entities[trip.actorId].activity?.executor?.progress || 0) > 0.5));
  const departures = [];
  for (let frame = 0; frame < 1100; frame++) {
    schedule.step(0.5); state.clock.worldHours += 0.5 / 50;
    const service = descriptor(schedule, stations);
    scheduleRailPassengerTraffic(state, { stations, service, hour: 7, walkDurationFor: () => 350 });
    tickAllNpcMobilityItineraries(state, { deltaSeconds: 0.5, worldHours: state.clock.worldHours, railServices: [service] });
    if (schedule.justDeparted) departures.push(railVehiclePassengerManifest(state, schedule.serviceRunId)
      .reservations().filter((r) => r.status === 'boarded').length);
  }
  assert.ok(departures.length >= 4);
  assert.ok(departures.slice(0,4).every((n) => n >= 1 && n <= 6), JSON.stringify(departures));
});

test('a damaged itinerary cannot prevent other passengers progressing', () => {
  const { state, stations, schedule } = fixture();
  const result = scheduleRailPassengerTraffic(state, { stations, service: descriptor(schedule, stations), bootstrap: true, hour: 7 });
  const bad = result.bootstrapped[0], good = result.bootstrapped[1];
  state.itineraries[state.entities[bad].itineraryId] = { id: 'damaged', actorId: bad };
  const errors = [];
  const reports = tickAllNpcMobilityItineraries(state, { deltaSeconds: 0.1, worldHours: 1,
    railServices: [descriptor(schedule, stations)], onError: (_error, id) => errors.push(id) });
  assert.deepEqual(errors, [bad]);
  assert.ok(reports.find((report) => report.actorId === good && !report.error));
});

test('ordinary departures remain occupied over full day/night circuits, and peak trains are busier', () => {
  for (const seed of [7, 19, 42]) {
    const { state, stations, schedule } = fixture(seed);
    scheduleRailPassengerTraffic(state, { stations, service: descriptor(schedule, stations), bootstrap: true, hour: 0 });
    const samples = [], purposes = new Set(), homes = new Map(Object.values(state.entities).map((e) => [e.id, JSON.stringify(e.residence)]));
    for (let frame = 0; frame < 2400; frame++) {
      const dt = 1; state.clock.worldHours += dt / 50; schedule.step(dt);
      const service = descriptor(schedule, stations);
      service.npcPassengerLimit = trainPassengerTarget({ worldSeed: seed, runId: service.runId,
        departureSequence: service.departureSequence, hour: state.clock.worldHours % 24 }).target;
      const plan = scheduleRailPassengerTraffic(state, { stations, service, hour: state.clock.worldHours % 24 });
      for (const trip of plan.planned) purposes.add(trip.purpose.reason);
      const reports = tickAllNpcMobilityItineraries(state, { deltaSeconds: dt, worldHours: state.clock.worldHours, railServices: [service] });
      assert.equal(reports.filter((report) => report.error).length, 0);
      if (schedule.justDeparted) {
        const count = railVehiclePassengerManifest(state, schedule.serviceRunId).reservations().filter((r) => r.status === 'boarded').length;
        samples.push({ count, period: trainPassengerTarget({ runId: schedule.serviceRunId, hour: state.clock.worldHours % 24 }).period });
      }
    }
    const occupied = samples.filter((s) => s.count >= 1 && s.count <= 6);
    assert.ok(occupied.length / samples.length >= 0.95, JSON.stringify({ seed, samples }));
    const mean = (periods) => { const group = samples.filter((s) => periods.includes(s.period)); return group.reduce((n, s) => n + s.count, 0) / group.length; };
    assert.ok(mean(['morning', 'afternoon']) > mean(['night']), JSON.stringify({ seed, samples }));
    assert.deepEqual([...purposes].sort(), ['family-visit', 'friend-visit', 'pleasure-trip', 'work-errand']);
    for (const entity of Object.values(state.entities)) assert.equal(JSON.stringify(entity.residence), homes.get(entity.id));
    assert.equal(auditNpcMobilityState(state).ok, true, JSON.stringify(auditNpcMobilityState(state).errors));
    assert.ok(state.metrics.groupsFormed > 0);
    console.info(JSON.stringify({ seed, departures: samples.length, occupied: occupied.length,
      peakMean: mean(['morning', 'afternoon']), nightMean: mean(['night']), families: state.metrics.groupsFormed }));
  }
});
