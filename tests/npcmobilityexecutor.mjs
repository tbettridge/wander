import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachNpcSpatialState,
  createLivingWorldState,
  LivingWorldStateStore,
  registerLivingWorldEntity,
  setLivingWorldFeatures,
} from '../src/livingworldstate.mjs';
import { createItinerary, ITINERARY_LEG_KIND, ITINERARY_STATUS } from '../src/npcitinerary.mjs';
import { loadNpcItinerary, registerNpcItinerary, reserveNpcRailPassenger } from '../src/npcmobility.mjs';
import { tickAllNpcMobilityItineraries, tickNpcMobilityItinerary } from '../src/npcmobilityexecutor.mjs';

const home = { kind: 'building', settlementId: 'settlement:elm', buildingId: 'building:elm:7', nodeId: null };
const market = { kind: 'settlement-node', settlementId: 'settlement:ash', nodeId: 'market' };
const elmPlatform = { kind: 'station-platform', stationId: 'station:elm', platformId: 'platform:elm', waitAnchorId: 'wait:elm:1' };
const ashPlatform = { kind: 'station-platform', stationId: 'station:ash', platformId: 'platform:ash', waitAnchorId: 'wait:ash:1' };
const residence = {
  originSettlementId: 'settlement:elm', residenceSettlementId: 'settlement:elm',
  householdId: 'household:elm:2', homeBuildingId: 'building:elm:7',
};

function state({ rail = true, leisure = true } = {}) {
  const value = createLivingWorldState({ worldSeed: 19 });
  setLivingWorldFeatures(value, {
    unifiedNpcMobilityEnabled: true,
    npcRailTravelEnabled: rail,
    npcLeisureTravelEnabled: leisure,
  });
  registerLivingWorldEntity(value, { id: 'npc:ada', kind: 'npc', name: 'Ada' });
  attachNpcSpatialState(value, 'npc:ada', { residence, location: home });
  return value;
}

function direct() {
  return createItinerary({
    id: 'trip:direct', actorId: 'npc:ada', residence,
    origin: { key: 'building:elm:7' }, destination: { key: 'market:ash' },
    purpose: { kind: 'quest' },
    outboundLegs: [{ id: 'out', kind: ITINERARY_LEG_KIND.regionalWalk, data: {
      durationSeconds: 10, fromLocation: home, toLocation: market,
      edgeLocation: { kind: 'regional-edge', edgeId: 'elm-ash', fromKey: 'elm', toKey: 'ash', progress: 0 },
    } }],
    activity: { id: 'market', kind: 'quest', data: { durationSeconds: 5, location: market } },
    returnLegs: [{ id: 'back', kind: ITINERARY_LEG_KIND.regionalWalk, data: {
      durationSeconds: 10, fromLocation: market, toLocation: home,
      edgeLocation: { kind: 'regional-edge', edgeId: 'ash-elm', fromKey: 'ash', toKey: 'elm', progress: 0 },
    } }],
  });
}

function railTrip() {
  return createItinerary({
    id: 'trip:rail', actorId: 'npc:ada', residence,
    origin: { key: 'building:elm:7' }, destination: { key: 'market:ash' },
    purpose: { kind: 'leisure' },
    outboundLegs: [
      { id: 'walk-platform', kind: ITINERARY_LEG_KIND.localWalk, data: {
        durationSeconds: 2, fromLocation: home, toLocation: elmPlatform,
      } },
      { id: 'wait-elm', kind: ITINERARY_LEG_KIND.stationWait, data: {
        originStationId: 'station:elm', platformLocation: elmPlatform, serviceId: 'regional',
      } },
      { id: 'board-elm', kind: ITINERARY_LEG_KIND.boardTrain, data: {
        originStationId: 'station:elm', destinationStationId: 'station:ash',
        platformLocation: elmPlatform, serviceId: 'regional',
      } },
      { id: 'ride-ash', kind: ITINERARY_LEG_KIND.trainRide, data: {
        destinationStationId: 'station:ash', serviceId: 'regional',
      } },
      { id: 'alight-ash', kind: ITINERARY_LEG_KIND.alightTrain, data: {
        destinationStationId: 'station:ash', platformLocation: ashPlatform, serviceId: 'regional',
      } },
      { id: 'walk-market', kind: ITINERARY_LEG_KIND.localWalk, data: {
        durationSeconds: 2, fromLocation: ashPlatform, toLocation: market,
      } },
    ],
    activity: { id: 'visit', kind: 'leisure', data: { durationSeconds: 1, location: market } },
    returnLegs: [{ id: 'walk-home', kind: ITINERARY_LEG_KIND.localWalk, data: {
      durationSeconds: 2, fromLocation: market, toLocation: home,
    } }],
  });
}

const at = (stationId, runId = 'run:1') => [{
  serviceId: 'regional', runId, phase: 'dwelling', stationId, serviceTick: 40,
}];

test('direct walk round trip consumes deterministic time and completes at home', () => {
  const value = state();
  registerNpcItinerary(value, direct());
  const residenceBefore = structuredClone(value.entities['npc:ada'].residence);
  const report = tickNpcMobilityItinerary(value, 'npc:ada', { deltaSeconds: 25, worldHours: 12 });
  assert.equal(report.completed, true);
  assert.equal(report.consumedSeconds, 25);
  assert.deepEqual(value.entities['npc:ada'].location, home);
  assert.deepEqual(value.entities['npc:ada'].residence, residenceBefore);
  assert.equal(value.entities['npc:ada'].activity, null);
  assert.equal(loadNpcItinerary(value, 'trip:direct').status, ITINERARY_STATUS.completed);
});

test('uneven delta cadence produces the same durable outcome', () => {
  const one = state();
  const many = state();
  registerNpcItinerary(one, direct());
  registerNpcItinerary(many, direct());
  tickNpcMobilityItinerary(one, 'npc:ada', { deltaSeconds: 25, worldHours: 9 });
  for (const dt of [1, 3, 7, 2, 8, 4]) tickNpcMobilityItinerary(many, 'npc:ada', { deltaSeconds: dt, worldHours: 9 });
  assert.deepEqual(many.itineraries, one.itineraries);
  assert.deepEqual(many.entities['npc:ada'].location, one.entities['npc:ada'].location);
});

test('progress survives compact save/reload midway through a regional leg', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  let value = state();
  registerNpcItinerary(value, direct());
  tickNpcMobilityItinerary(value, 'npc:ada', { deltaSeconds: 4, worldHours: 8 });
  assert.equal(value.entities['npc:ada'].location.kind, 'regional-edge');
  assert.equal(value.entities['npc:ada'].location.progress, 0.4);
  const store = new LivingWorldStateStore({ worldSeed: 19, storage });
  assert.equal(store.save(value), true);
  value = store.load();
  tickNpcMobilityItinerary(value, 'npc:ada', { deltaSeconds: 21, worldHours: 8.1 });
  assert.equal(loadNpcItinerary(value, 'trip:direct').status, ITINERARY_STATUS.completed);
  assert.deepEqual(value.entities['npc:ada'].location, home);
});

test('multimodal passenger waits, boards one run, stays seated, and alights only at destination', () => {
  const value = state();
  registerNpcItinerary(value, railTrip());
  tickNpcMobilityItinerary(value, 'npc:ada', { deltaSeconds: 2, worldHours: 10 });
  let report = tickNpcMobilityItinerary(value, 'npc:ada', { deltaSeconds: 3, worldHours: 10.1 });
  assert.equal(report.waiting.reason, 'service');
  assert.deepEqual(value.entities['npc:ada'].location, elmPlatform);

  report = tickNpcMobilityItinerary(value, 'npc:ada', {
    deltaSeconds: 0, worldHours: 10.2, railServices: at('station:elm'),
  });
  assert.equal(report.boards.length, 1);
  assert.equal(value.entities['npc:ada'].location.kind, 'train-seat');
  const seat = structuredClone(value.entities['npc:ada'].location);

  tickNpcMobilityItinerary(value, 'npc:ada', {
    deltaSeconds: 20, worldHours: 10.4, railServices: at('station:wrong'),
  });
  assert.deepEqual(value.entities['npc:ada'].location, seat);
  assert.equal(loadNpcItinerary(value, 'trip:rail').legs.find((leg) => leg.id === 'ride-ash').status, 'active');

  report = tickNpcMobilityItinerary(value, 'npc:ada', {
    deltaSeconds: 0, worldHours: 10.5, railServices: at('station:ash'),
  });
  assert.equal(report.alights.length, 1);
  assert.deepEqual(value.entities['npc:ada'].location, ashPlatform);
  tickNpcMobilityItinerary(value, 'npc:ada', { deltaSeconds: 5, worldHours: 11 });
  assert.equal(report.boards[0]?.applied ?? true, true);
  assert.deepEqual(value.entities['npc:ada'].location, home);
});

test('a different run at the destination cannot release a seated passenger', () => {
  const value = state();
  registerNpcItinerary(value, railTrip());
  tickNpcMobilityItinerary(value, 'npc:ada', { deltaSeconds: 2 });
  tickNpcMobilityItinerary(value, 'npc:ada', { railServices: at('station:elm', 'run:correct') });
  const seat = structuredClone(value.entities['npc:ada'].location);
  tickNpcMobilityItinerary(value, 'npc:ada', { deltaSeconds: 5, railServices: at('station:ash', 'run:wrong') });
  assert.deepEqual(value.entities['npc:ada'].location, seat);
});

test('full trains leave a board leg waiting on the platform without identity corruption', () => {
  const value = state();
  registerNpcItinerary(value, railTrip());
  tickNpcMobilityItinerary(value, 'npc:ada', { deltaSeconds: 2 });
  for (let index = 0; index < 6; index++) {
    const id = `npc:filler:${index}`;
    registerLivingWorldEntity(value, { id, kind: 'npc', name: id });
    attachNpcSpatialState(value, id, { residence, location: elmPlatform });
    reserveNpcRailPassenger(value, {
      runId: 'run:full', personId: id,
      originStationId: 'station:elm', destinationStationId: 'station:ash',
    });
  }
  const beforeResidence = structuredClone(value.entities['npc:ada'].residence);
  const report = tickNpcMobilityItinerary(value, 'npc:ada', { railServices: at('station:elm', 'run:full') });
  assert.equal(report.waiting.reason, 'capacity');
  assert.deepEqual(value.entities['npc:ada'].location, elmPlatform);
  assert.deepEqual(value.entities['npc:ada'].residence, beforeResidence);
  assert.equal(loadNpcItinerary(value, 'trip:rail').legs.find((leg) => leg.id === 'board-elm').status, 'pending');
});

test('feature gates pause execution atomically', () => {
  const mobilityOff = state();
  registerNpcItinerary(mobilityOff, direct());
  setLivingWorldFeatures(mobilityOff, { unifiedNpcMobilityEnabled: false });
  const before = structuredClone(mobilityOff);
  assert.throws(() => tickNpcMobilityItinerary(mobilityOff, 'npc:ada', { deltaSeconds: 1 }), /mobility is disabled/);
  assert.deepEqual(mobilityOff, before);

  const railOff = state();
  registerNpcItinerary(railOff, railTrip());
  setLivingWorldFeatures(railOff, { npcRailTravelEnabled: false });
  const railBefore = structuredClone(railOff);
  assert.throws(() => tickNpcMobilityItinerary(railOff, 'npc:ada'), /rail travel is disabled/);
  assert.deepEqual(railOff, railBefore);
});

test('malformed movement locations fail before any durable mutation', () => {
  const value = state();
  const broken = direct();
  broken.legs[0].data.toLocation = { kind: 'regional-edge', progress: 2 };
  registerNpcItinerary(value, broken);
  const before = structuredClone(value);
  assert.throws(() => tickNpcMobilityItinerary(value, 'npc:ada', { deltaSeconds: 1 }), /Malformed canonical/);
  assert.deepEqual(value, before);
});

test('a final return leg cannot redirect the resident away from their home', () => {
  const value = state();
  const trip = direct();
  trip.legs.at(-1).data.toLocation = market;
  registerNpcItinerary(value, trip);
  const before = structuredClone(value);
  assert.throws(() => tickNpcMobilityItinerary(value, 'npc:ada', { deltaSeconds: 25 }), /original home building/);
  assert.deepEqual(value, before);
});

test('a resident held for a player conversation keeps their leg and their location', () => {
  const value = state();
  registerNpcItinerary(value, direct());
  registerLivingWorldEntity(value, { id: 'npc:bram', kind: 'npc', name: 'Bram' });
  attachNpcSpatialState(value, 'npc:bram', { residence, location: home });
  const companion = direct();
  companion.id = 'trip:companion';
  companion.actorId = 'npc:bram';
  registerNpcItinerary(value, companion);

  const reports = tickAllNpcMobilityItineraries(value, {
    deltaSeconds: 6, worldHours: 9, skipActorIds: ['npc:ada'],
  });
  assert.deepEqual(reports.map((report) => report.actorId), ['npc:bram'],
    'a held actor must not be ticked at all');
  assert.deepEqual(value.entities['npc:ada'].location, home,
    'a held actor stays exactly where the player is talking to them');
  assert.notDeepEqual(value.entities['npc:bram'].location, home,
    'everyone else keeps walking while one conversation is held');

  // The journey is paused, never cancelled: releasing the hold resumes the same
  // itinerary from the same leg.
  const resumed = tickAllNpcMobilityItineraries(value, { deltaSeconds: 6, worldHours: 9 });
  const ada = resumed.find((report) => report.actorId === 'npc:ada');
  assert.equal(loadNpcItinerary(value, 'trip:direct').status, ITINERARY_STATUS.active);
  assert.ok(ada.consumedSeconds > 0, 'the held actor resumes the leg it was holding on');
});
