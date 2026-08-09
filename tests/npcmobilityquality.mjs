import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachNpcSpatialState,
  createLivingWorldState,
  registerLivingWorldEntity,
  setLivingWorldFeatures,
} from '../src/livingworldstate.mjs';
import { createItinerary, ITINERARY_LEG_KIND } from '../src/npcitinerary.mjs';
import {
  boardNpcRailPassenger,
  registerNpcItinerary,
  reserveNpcRailPassenger,
} from '../src/npcmobility.mjs';
import { auditNpcMobilityState } from '../src/npcmobilityquality.mjs';
import { auditLivingWorldState } from '../src/livingworldquality.mjs';
import { createServiceRunId, RailPassengerManifest } from '../src/railpassengers.mjs';
import { TrainScheduleModel } from '../src/railservice.mjs';

const residence = {
  originSettlementId: 'settlement:elm',
  residenceSettlementId: 'settlement:elm',
  householdId: 'household:elm:2',
  homeBuildingId: 'building:elm:7',
};

function stateWithNpc(id = 'npc:elm:ada') {
  const state = createLivingWorldState({ worldSeed: 44 });
  setLivingWorldFeatures(state, {
    unifiedNpcMobilityEnabled: true,
    npcRailTravelEnabled: true,
    npcLeisureTravelEnabled: true,
  });
  registerLivingWorldEntity(state, { id, kind: 'npc', name: 'Ada Elm' });
  attachNpcSpatialState(state, id, {
    residence,
    location: {
      kind: 'station-platform', stationId: 'station:elm',
      platformId: 'platform:elm:a', waitAnchorId: 'wait:elm:a:1',
    },
  });
  return state;
}

function itinerary(actorId = 'npc:elm:ada', id = 'itinerary:ada:1') {
  return createItinerary({
    id, actorId, residence,
    origin: { kind: 'building', key: 'building:elm:7' },
    destination: { kind: 'settlement', key: 'settlement:ash' },
    activity: { kind: 'leisure' },
    outboundLegs: [
      { id: 'out:wait', kind: ITINERARY_LEG_KIND.stationWait },
      { id: 'out:board', kind: ITINERARY_LEG_KIND.boardTrain },
      { id: 'out:ride', kind: ITINERARY_LEG_KIND.trainRide },
      { id: 'out:alight', kind: ITINERARY_LEG_KIND.alightTrain },
    ],
    returnLegs: [
      { id: 'return:board', kind: ITINERARY_LEG_KIND.boardTrain },
      { id: 'return:ride', kind: ITINERARY_LEG_KIND.trainRide },
      { id: 'return:alight', kind: ITINERARY_LEG_KIND.alightTrain },
    ],
  });
}

function cleanMobilityState() {
  const state = stateWithNpc();
  registerNpcItinerary(state, itinerary());
  const runId = createServiceRunId({ serviceId: 'regional', serviceDay: 2, sequence: 4 });
  reserveNpcRailPassenger(state, {
    runId, personId: 'npc:elm:ada',
    originStationId: 'station:elm', destinationStationId: 'station:ash',
  });
  boardNpcRailPassenger(state, {
    runId, personId: 'npc:elm:ada', stationId: 'station:elm', serviceTick: 120,
  });
  return { state, runId };
}

test('a clean end-to-end mobility state passes without being mutated', () => {
  const { state } = cleanMobilityState();
  const before = JSON.stringify(state);
  const audit = auditNpcMobilityState(state);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.errors, []);
  assert.equal(audit.metrics.validItineraries, 1);
  assert.equal(audit.metrics.validManifests, 1);
  assert.equal(audit.metrics.boardedPassengers, 1);
  assert.equal(JSON.stringify(state), before, 'quality auditing must be read-only');
});

test('malformed itinerary snapshots and missing or tombstoned actors are reported', () => {
  const state = stateWithNpc();
  registerNpcItinerary(state, itinerary());
  state.itineraries['itinerary:broken'] = { v: 999 };

  const missing = structuredClone(state.itineraries['itinerary:ada:1']);
  missing.id = 'itinerary:missing';
  missing.a = 'npc:missing';
  state.itineraries[missing.id] = missing;

  registerLivingWorldEntity(state, { id: 'npc:tombstoned', kind: 'npc', tombstone: true });
  state.entities['npc:tombstoned'].tombstone = true;
  const tombstoned = structuredClone(state.itineraries['itinerary:ada:1']);
  tombstoned.id = 'itinerary:tombstoned';
  tombstoned.a = 'npc:tombstoned';
  state.itineraries[tombstoned.id] = tombstoned;

  const audit = auditNpcMobilityState(state);
  assert.equal(audit.ok, false);
  assert.ok(audit.errors.some((error) => error.code === 'itinerary.malformed'));
  assert.ok(audit.errors.some((error) => error.code === 'itinerary.actor-missing'));
  assert.ok(audit.errors.some((error) => error.code === 'itinerary.actor-inactive'));
});

test('multiple active itineraries, broken links, and residence mismatches are deterministic', () => {
  const state = stateWithNpc();
  registerNpcItinerary(state, itinerary());
  const second = structuredClone(state.itineraries['itinerary:ada:1']);
  second.id = 'itinerary:ada:2';
  state.itineraries[second.id] = second;

  const alienResidence = {
    originSettlementId: 'settlement:ash', residenceSettlementId: 'settlement:ash',
    householdId: 'household:ash:1', homeBuildingId: 'building:ash:2',
  };
  second.r = alienResidence;
  second.h[1] = alienResidence;
  state.entities['npc:elm:ada'].itineraryId = 'itinerary:missing-link';

  const first = auditNpcMobilityState(state);
  const secondAudit = auditNpcMobilityState(state);
  assert.deepEqual(secondAudit, first);
  assert.ok(first.errors.some((error) => error.code === 'itinerary.multiple-active'));
  assert.ok(first.errors.some((error) => error.code === 'entity.itinerary-link-mismatch'));
  assert.ok(first.errors.some((error) => error.code === 'itinerary.residence-mismatch'));
  assert.equal(first.metrics.actorsWithMultipleActiveItineraries, 1);
});

test('manifest restore failures expose duplicate seats and over-capacity corruption', () => {
  const state = stateWithNpc();
  registerLivingWorldEntity(state, { id: 'npc:elm:bea', kind: 'npc' });
  attachNpcSpatialState(state, 'npc:elm:bea', {
    residence,
    location: { kind: 'building', settlementId: 'settlement:elm', buildingId: 'building:elm:7' },
  });
  const duplicate = new RailPassengerManifest({ runId: 'run:duplicate' });
  duplicate.reserve({ personId: 'npc:elm:ada', originStationId: 'a', destinationStationId: 'b' });
  duplicate.reserve({ personId: 'npc:elm:bea', originStationId: 'a', destinationStationId: 'b' });
  const duplicateSnapshot = duplicate.snapshot();
  duplicateSnapshot.reservations[1].carriageIndex = duplicateSnapshot.reservations[0].carriageIndex;
  duplicateSnapshot.reservations[1].seatIndex = duplicateSnapshot.reservations[0].seatIndex;
  state.railManifests['run:duplicate'] = duplicateSnapshot;

  const capacity = new RailPassengerManifest({ runId: 'run:capacity' });
  for (let i = 0; i < 3; i++) capacity.reserve({
    personId: `npc:cap:${i}`, originStationId: 'a', destinationStationId: 'b',
    carriageIndex: 0, seatIndex: i,
  });
  const capacitySnapshot = capacity.snapshot();
  const fourth = structuredClone(capacitySnapshot.reservations[2]);
  fourth.personId = 'npc:cap:3';
  fourth.reservationId = 'run:capacity:passenger:npc%3Acap%3A3';
  fourth.seatIndex = 3;
  capacitySnapshot.reservations.push(fourth);
  state.railManifests['run:capacity'] = capacitySnapshot;

  const audit = auditNpcMobilityState(state);
  const malformedRuns = audit.errors
    .filter((error) => error.code === 'rail.manifest-malformed')
    .map((error) => error.subjectId);
  assert.deepEqual(malformedRuns, ['run:capacity', 'run:duplicate']);
  assert.equal(audit.metrics.malformedManifests, 2);
});

test('malformed persisted service progress is reported before renderer adoption', () => {
  const state = stateWithNpc();
  const schedule = new TrainScheduleModel(1000, [0, 400, 700], {
    serviceId: 'regional',
  });
  state.railServices.regional = schedule.snapshot();
  state.railServices.regional.targetStop = 0.5;
  const audit = auditNpcMobilityState(state);
  assert.equal(audit.metrics.serviceSnapshots, 1);
  assert.equal(audit.metrics.malformedServices, 1);
  assert.ok(audit.errors.some((error) => error.code === 'rail.service-malformed'));
});

test('unknown NPC reservations and boarded seat-location mismatches are reported', () => {
  const { state, runId } = cleanMobilityState();
  state.entities['npc:elm:ada'].location = {
    kind: 'train-seat', runId,
    carriageId: 'carriage:1', seatId: 'seat:2',
  };
  const unknown = new RailPassengerManifest({ runId: 'run:unknown' });
  unknown.reserve({ personId: 'npc:does-not-exist', originStationId: 'a', destinationStationId: 'b' });
  state.railManifests['run:unknown'] = unknown.snapshot();

  const audit = auditNpcMobilityState(state);
  assert.ok(audit.errors.some((error) => error.code === 'rail.reservation-unknown-npc'));
  assert.ok(audit.errors.some((error) => error.code === 'rail.boarded-location-mismatch'));
  assert.ok(auditLivingWorldState(state).errors.some((error) => (
    error.startsWith('mobility:rail.boarded-location-mismatch:')
  )), 'the main living-world gate must include mobility integrity failures');
});
