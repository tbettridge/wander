import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachNpcSpatialState,
  createLivingWorldState,
  registerLivingWorldEntity,
  setLivingWorldFeatures,
} from '../src/livingworldstate.mjs';
import {
  MAX_RESIDENT_TRIPS_PER_CADENCE,
  planResidentTripBatch,
  residentTripItineraryId,
  scheduleResidentTripBatch,
} from '../src/npcmobilityscheduler.mjs';

const railway = {
  stations: ['station:elm', 'station:ash'],
  connections: [
    { fromStationId: 'station:elm', toStationId: 'station:ash', serviceId: 'service:out', duration: 300 },
    { fromStationId: 'station:ash', toStationId: 'station:elm', serviceId: 'service:return', duration: 300 },
  ],
};

function state({ leisure = true, rail = true, residents = ['ada', 'bert', 'cy'] } = {}) {
  const world = createLivingWorldState({ worldSeed: 818 });
  setLivingWorldFeatures(world, {
    unifiedNpcMobilityEnabled: true,
    npcRailTravelEnabled: rail,
    npcLeisureTravelEnabled: leisure,
  });
  for (const name of residents) addResident(world, name);
  return world;
}

function addResident(world, name, settlementId = 'settlement:elm') {
  const id = `npc:${name}`;
  const buildingId = `building:${name}`;
  registerLivingWorldEntity(world, { id, kind: 'npc', name });
  attachNpcSpatialState(world, id, {
    residence: {
      originSettlementId: settlementId,
      residenceSettlementId: settlementId,
      householdId: `household:${name}`,
      homeBuildingId: buildingId,
    },
    location: { kind: 'building', settlementId, buildingId },
  });
  return world.entities[id];
}

function request(overrides = {}) {
  return {
    id: 'market-day',
    kind: 'leisure',
    originSettlementId: 'settlement:elm',
    origin: { kind: 'settlement', key: 'settlement:elm' },
    destination: { kind: 'settlement', key: 'settlement:ash' },
    routing: {
      directWalk: { duration: 1800 },
      originAccess: [{ stationId: 'station:elm', duration: 0 }],
      destinationEgress: [{ stationId: 'station:ash', duration: 0 }],
      railway,
      departureWaitEstimates: {
        'station:elm|service:out': 120,
        'station:ash|service:return': 90,
      },
    },
    ...overrides,
  };
}

function planned(world, requests, options = {}) {
  return planResidentTripBatch(world, {
    worldSeed: 818, dayIndex: 3, cadenceBucket: 12,
    requests, maxTrips: requests.length, ...options,
  });
}

test('a station-village resident gets a round trip without an invented access walk', () => {
  const plan = planned(state(), [request()]);
  assert.equal(plan.trips.length, 1);
  assert.equal(plan.trips[0].route.outbound.mode, 'rail');
  assert.equal(plan.trips[0].itinerary.legs[0].kind, 'station-wait');
  assert.equal(plan.trips[0].itinerary.returnPlan.required, true);
});

test('a non-station resident walks to rail, rides, and walks onward', () => {
  const trip = planned(state(), [request({
    routing: {
      ...request().routing,
      originAccess: [{ stationId: 'station:elm', duration: 240 }],
      destinationEgress: [{ stationId: 'station:ash', duration: 180 }],
    },
  })]).trips[0];
  assert.deepEqual(trip.route.outboundLegs.map((leg) => leg.kind), [
    'regional-walk', 'station-wait', 'board-train', 'train-ride', 'alight-train', 'regional-walk',
  ]);
  assert.equal(trip.route.returnLegs[0].kind, 'regional-walk');
  assert.equal(trip.route.returning.mode, 'rail');
});

test('direct walking wins when faster and is the fallback when rail is gated off', () => {
  const fastWalk = request({ routing: { ...request().routing, directWalk: { duration: 100 } } });
  assert.equal(planned(state(), [fastWalk]).trips[0].route.outbound.mode, 'walk');

  const noRail = planned(state({ rail: false }), [request()]).trips[0];
  assert.equal(noRail.route.outbound.mode, 'walk');
  assert.equal(noRail.itinerary.legs.some((leg) => leg.kind.includes('train')), false);
});

test('leisure scheduling is feature gated without mutating state', () => {
  const world = state({ leisure: false });
  const before = structuredClone(world);
  const plan = planned(world, [request()]);
  assert.deepEqual(plan.trips, []);
  assert.deepEqual(plan.rejected, [{ requestId: 'market-day', reason: 'leisure-disabled' }]);
  assert.deepEqual(world, before);
});

test('an explicit quest preserves its deadline and facts and rejects an unreachable deadline', () => {
  const quest = request({
    id: 'deliver-letter', kind: 'quest', actorId: 'npc:ada', questId: 'quest:letter',
    departAt: 100, deadlineAt: 900,
    facts: { recipient: 'Mara Ash', sealed: true },
  });
  const trip = planned(state({ leisure: false }), [quest]).trips[0];
  assert.equal(trip.actorId, 'npc:ada');
  assert.deepEqual(trip.itinerary.purpose, {
    cadence: { cadenceBucket: 12, dayIndex: 3 },
    deadlineAt: 900,
    facts: { recipient: 'Mara Ash', sealed: true },
    kind: 'quest',
    questId: 'quest:letter',
    requestId: 'deliver-letter',
  });
  assert.deepEqual(trip.itinerary.legs.find((leg) => leg.kind === 'destination-activity').data.facts,
    { recipient: 'Mara Ash', sealed: true });

  const missed = planned(state({ leisure: false }), [{ ...quest, deadlineAt: 400 }]);
  assert.equal(missed.trips.length, 0);
  assert.equal(missed.rejected[0].reason, 'quest-deadline-unreachable');
});

test('away, committed, and non-canonical people are excluded and shortages stay shortages', () => {
  const world = state();
  world.entities['npc:ada'].location = {
    kind: 'regional-edge', edgeId: 'trail:1', fromKey: 'elm', toKey: 'ash', progress: 0.2,
  };
  world.entities['npc:bert'].itineraryId = 'itinerary:existing';
  world.entities['npc:cy'].activity = { kind: 'station-duty' };
  const beforeIds = Object.keys(world.entities);
  const plan = planned(world, [request()]);
  assert.equal(plan.trips.length, 0);
  assert.equal(plan.rejected[0].reason, 'resident-shortage');
  assert.deepEqual(Object.keys(world.entities), beforeIds, 'the scheduler never invents a filler NPC');
});

test('selection and itinerary output are independent of request and entity insertion order', () => {
  const first = state({ residents: ['ada', 'bert', 'cy'] });
  const second = state({ residents: ['cy', 'ada', 'bert'] });
  const requests = [request({ id: 'fair' }), request({ id: 'picnic' })];
  const a = planned(first, requests, { maxTrips: 2 });
  const b = planned(second, [...requests].reverse(), { maxTrips: 2 });
  assert.deepEqual(a.trips, b.trips);
});

test('registration is exact-once, bounded, and always keeps the original home return plan', () => {
  const world = state({ residents: ['ada', 'bert', 'cy', 'dot', 'eve'] });
  const requests = Array.from({ length: 8 }, (_, index) => request({ id: `outing:${index}` }));
  const first = scheduleResidentTripBatch(world, {
    worldSeed: 818, dayIndex: 4, cadenceBucket: 2, requests, maxTrips: 99,
  });
  assert.equal(first.budget, MAX_RESIDENT_TRIPS_PER_CADENCE);
  assert.equal(first.trips.length, MAX_RESIDENT_TRIPS_PER_CADENCE);
  assert.equal(Object.keys(world.itineraries).length, MAX_RESIDENT_TRIPS_PER_CADENCE);
  for (const trip of first.trips) {
    assert.deepEqual(trip.itinerary.returnPlan.home,
      world.entities[trip.actorId].residence);
    assert.equal(trip.itinerary.id, residentTripItineraryId({
      worldSeed: 818, dayIndex: 4, cadenceBucket: 2,
      requestId: trip.requestId, actorId: trip.actorId,
    }));
  }

  const retry = scheduleResidentTripBatch(world, {
    worldSeed: 818, dayIndex: 4, cadenceBucket: 2, requests, maxTrips: 99,
  });
  assert.equal(retry.trips.length, 0);
  assert.equal(Object.keys(world.itineraries).length, MAX_RESIDENT_TRIPS_PER_CADENCE);
});
