import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachNpcSpatialState,
  createLivingWorldState,
  registerLivingWorldEntity,
  setLivingWorldFeatures,
} from '../src/livingworldstate.mjs';
import {
  createItinerary,
  currentItineraryLeg,
  ITINERARY_LEG_KIND,
  ITINERARY_STATUS,
} from '../src/npcitinerary.mjs';
import {
  activeNpcItinerary,
  alightNpcRailPassenger,
  boardNpcRailPassenger,
  loadNpcItinerary,
  NPC_ITINERARY_TRANSITION,
  railPassengerManifest,
  persistRailServiceSnapshot,
  railServiceSnapshot,
  registerNpcItinerary,
  reserveNpcRailPassenger,
  seatNpcRailPassenger,
  standNpcRailPassenger,
  transitionNpcItinerary,
} from '../src/npcmobility.mjs';
import { createServiceRunId } from '../src/railpassengers.mjs';
import { TrainScheduleModel } from '../src/railservice.mjs';

const residence = {
  originSettlementId: 'settlement:elm',
  residenceSettlementId: 'settlement:elm',
  householdId: 'household:elm:2',
  homeBuildingId: 'building:elm:7',
};

function enabledState({ rail = true } = {}) {
  const state = createLivingWorldState({ worldSeed: 44 });
  setLivingWorldFeatures(state, {
    unifiedNpcMobilityEnabled: true,
    npcRailTravelEnabled: rail,
    npcLeisureTravelEnabled: true,
  });
  registerLivingWorldEntity(state, { id: 'npc:elm:ada', kind: 'npc', name: 'Ada Elm' });
  attachNpcSpatialState(state, 'npc:elm:ada', {
    residence,
    location: {
      kind: 'building', settlementId: 'settlement:elm',
      buildingId: 'building:elm:7', nodeId: 'room:front',
    },
  });
  return state;
}

function itinerary(id = 'itinerary:ada:1') {
  return createItinerary({
    id,
    actorId: 'npc:elm:ada',
    residence,
    origin: { kind: 'building', key: 'building:elm:7' },
    destination: { kind: 'settlement', key: 'settlement:ash' },
    activity: { kind: 'leisure', data: { purpose: 'market-day' } },
    outboundLegs: [
      { id: 'out:walk', kind: ITINERARY_LEG_KIND.localWalk },
      { id: 'out:wait', kind: ITINERARY_LEG_KIND.stationWait },
      { id: 'out:board', kind: ITINERARY_LEG_KIND.boardTrain },
      { id: 'out:ride', kind: ITINERARY_LEG_KIND.trainRide },
      { id: 'out:alight', kind: ITINERARY_LEG_KIND.alightTrain },
    ],
    returnLegs: [
      { id: 'return:board', kind: ITINERARY_LEG_KIND.boardTrain },
      { id: 'return:ride', kind: ITINERARY_LEG_KIND.trainRide },
      { id: 'return:alight', kind: ITINERARY_LEG_KIND.alightTrain },
      { id: 'return:walk', kind: ITINERARY_LEG_KIND.localWalk },
    ],
  });
}

function finishCurrent(state, itineraryId, location = null) {
  const active = loadNpcItinerary(state, itineraryId);
  const legId = currentItineraryLeg(active).id;
  transitionNpcItinerary(state, itineraryId, {
    type: NPC_ITINERARY_TRANSITION.start, legId,
  });
  return transitionNpcItinerary(state, itineraryId, {
    type: NPC_ITINERARY_TRANSITION.complete, legId, location,
  });
}

test('one persistent resident owns one durable round-trip itinerary', () => {
  const state = enabledState();
  const registered = registerNpcItinerary(state, itinerary());
  assert.equal(registered.actorId, 'npc:elm:ada');
  assert.equal(state.entities['npc:elm:ada'].itineraryId, registered.id);
  assert.equal(activeNpcItinerary(state, 'npc:elm:ada').id, registered.id);

  const residenceBefore = structuredClone(state.entities['npc:elm:ada'].residence);
  while (activeNpcItinerary(state, 'npc:elm:ada')) finishCurrent(state, registered.id);
  const completed = loadNpcItinerary(state, registered.id);
  assert.equal(completed.status, ITINERARY_STATUS.completed);
  assert.equal(state.entities['npc:elm:ada'].itineraryId, null);
  assert.deepEqual(state.entities['npc:elm:ada'].residence, residenceBefore);
  assert.equal(state.entities['npc:elm:ada'].id, 'npc:elm:ada');
});

test('itinerary transition and location publication are exact-once', () => {
  const state = enabledState();
  registerNpcItinerary(state, itinerary());
  const legId = currentItineraryLeg(loadNpcItinerary(state, 'itinerary:ada:1')).id;
  transitionNpcItinerary(state, 'itinerary:ada:1', {
    type: 'start', legId,
  });
  const first = transitionNpcItinerary(state, 'itinerary:ada:1', {
    type: 'complete', legId,
    location: {
      kind: 'settlement-node', settlementId: 'settlement:elm', nodeId: 'street:station-road',
    },
  });
  const revision = state.revision;
  const duplicate = transitionNpcItinerary(state, 'itinerary:ada:1', {
    type: 'complete', legId,
    location: {
      kind: 'settlement-node', settlementId: 'settlement:elm', nodeId: 'street:station-road',
    },
  });
  assert.deepEqual(duplicate.receipt, first.receipt);
  assert.equal(state.revision, revision);
  assert.equal(state.entities['npc:elm:ada'].location.kind, 'settlement-node');
  assert.equal(loadNpcItinerary(state, 'itinerary:ada:1').legIndex, 1);
});

test('a second live itinerary for the same person is rejected', () => {
  const state = enabledState();
  registerNpcItinerary(state, itinerary());
  assert.throws(() => registerNpcItinerary(state, itinerary('itinerary:ada:2')), /already has active/);
  assert.equal(Object.keys(state.itineraries).length, 1);
});

test('retrying the same itinerary registration cannot reset persisted progress', () => {
  const state = enabledState();
  const original = itinerary();
  registerNpcItinerary(state, original);
  finishCurrent(state, original.id);
  const revision = state.revision;
  const retried = registerNpcItinerary(state, itinerary());
  assert.equal(retried.legIndex, 1);
  assert.equal(state.revision, revision);
  assert.equal(loadNpcItinerary(state, original.id).legIndex, 1);
});

test('rail reservations move the same resident from platform to seat and onward', () => {
  const state = enabledState();
  const actor = state.entities['npc:elm:ada'];
  attachNpcSpatialState(state, actor.id, {
    residence: actor.residence,
    location: {
      kind: 'station-platform', stationId: 'station:elm',
      platformId: 'platform:elm:a', waitAnchorId: 'wait:elm:a:1',
    },
  });
  const runId = createServiceRunId({ serviceId: 'regional', serviceDay: 2, sequence: 4 });
  const reservation = reserveNpcRailPassenger(state, {
    runId, personId: actor.id,
    originStationId: 'station:elm', destinationStationId: 'station:ash',
  });
  const boarded = boardNpcRailPassenger(state, {
    runId, personId: actor.id, stationId: 'station:elm', serviceTick: 120,
  });
  assert.equal(boarded.applied, true);
  assert.deepEqual(actor.location, {
    kind: 'train-carriage', runId,
    carriageId: `carriage:${reservation.carriageIndex}`,
    zoneId: 'vestibule',
    seatId: `seat:${reservation.seatIndex}`,
  });
  seatNpcRailPassenger(state, { runId, personId: actor.id });
  assert.equal(actor.location.kind, 'train-seat');
  standNpcRailPassenger(state, { runId, personId: actor.id, zoneId: 'door-queue' });
  assert.equal(actor.location.kind, 'train-carriage');
  assert.equal(actor.location.zoneId, 'door-queue');
  assert.equal(railPassengerManifest(state, runId)
    .occupantsInCarriage(reservation.carriageIndex)[0].personId, actor.id);

  const revision = state.revision;
  const duplicate = boardNpcRailPassenger(state, {
    runId, personId: actor.id, stationId: 'station:elm', serviceTick: 999,
  });
  assert.equal(duplicate.applied, false);
  assert.equal(state.revision, revision);

  const alighted = alightNpcRailPassenger(state, {
    runId, personId: actor.id, stationId: 'station:ash', serviceTick: 240,
    platformLocation: {
      kind: 'station-platform', stationId: 'station:ash',
      platformId: 'platform:ash:a', waitAnchorId: 'wait:ash:a:2',
    },
  });
  assert.equal(alighted.applied, true);
  assert.equal(actor.location.kind, 'station-platform');
  assert.equal(actor.location.stationId, 'station:ash');
  assert.deepEqual(railPassengerManifest(state, runId)
    .occupantsInCarriage(reservation.carriageIndex), []);
  assert.deepEqual(actor.residence, residence);
});

test('disabled mobility and invalid transition locations leave state untouched', () => {
  const disabled = enabledState({ rail: false });
  assert.throws(() => reserveNpcRailPassenger(disabled, {
    runId: 'run:x', personId: 'npc:elm:ada',
    originStationId: 'a', destinationStationId: 'b',
  }), /rail travel is disabled/);
  const state = enabledState();
  registerNpcItinerary(state, itinerary());
  const before = structuredClone(state);
  assert.throws(() => transitionNpcItinerary(state, 'itinerary:ada:1', {
    type: 'start', location: { kind: 'regional-edge', progress: 2 },
  }), /Invalid itinerary transition location/);
  assert.deepEqual(state, before);
});

test('itinerary registration and resumption honor rail and leisure subfeature gates', () => {
  const railDisabled = enabledState({ rail: false });
  assert.throws(() => registerNpcItinerary(railDisabled, itinerary()), /rail travel is disabled/);
  assert.deepEqual(railDisabled.itineraries, {});

  const leisureDisabled = enabledState();
  setLivingWorldFeatures(leisureDisabled, { npcLeisureTravelEnabled: false });
  assert.throws(() => registerNpcItinerary(leisureDisabled, itinerary()), /leisure travel is disabled/);
  assert.deepEqual(leisureDisabled.itineraries, {});

  const paused = enabledState();
  registerNpcItinerary(paused, itinerary());
  setLivingWorldFeatures(paused, { npcRailTravelEnabled: false });
  const before = structuredClone(paused);
  assert.throws(() => transitionNpcItinerary(paused, 'itinerary:ada:1', {
    type: NPC_ITINERARY_TRANSITION.start,
  }), /rail travel is disabled/);
  assert.deepEqual(paused, before, 'disabling rail pauses persisted work without deleting or advancing it');
});

test('authoritative train progress persists without reusing a reset run ID', () => {
  const state = enabledState();
  const schedule = new TrainScheduleModel(1200, [0, 260, 610, 920], {
    serviceId: 'regional', dwell: 0.5,
  });
  while (schedule.runSequence < 1) schedule.step(0.1);
  const runId = schedule.serviceRunId;
  const persisted = persistRailServiceSnapshot(state, 'regional', schedule.snapshot());
  persisted.stops[0].distance = 999;
  assert.notEqual(state.railServices.regional.stops[0].distance, 999,
    'the persistence return value must not share nested objects with state');
  const restored = TrainScheduleModel.restore(railServiceSnapshot(state, 'regional'));
  assert.equal(restored.serviceRunId, runId);
  assert.equal(restored.runSequence, schedule.runSequence);
  assert.equal(restored.nextStationIndex, schedule.nextStationIndex);
  assert.throws(() => persistRailServiceSnapshot(state, 'another-service', schedule.snapshot()),
    /does not match/);
});
