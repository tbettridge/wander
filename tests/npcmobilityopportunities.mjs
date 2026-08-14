import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildClosedRailwayCatalog,
  buildResidentMobilityOpportunities,
  isLeisureCadenceActive,
  MAX_LEISURE_OPPORTUNITIES_PER_CADENCE,
} from '../src/npcmobilityopportunities.mjs';
import { planMultimodalRoute } from '../src/npcmultimodalroute.mjs';
import { planResidentTripBatch } from '../src/npcmobilityscheduler.mjs';

function catalog(overrides = {}) {
  return {
    worldSeed: 713,
    dayIndex: 8,
    cadenceBucket: 12,
    maxLeisure: 0,
    settlements: [
      { id: 'settlement:elm' },
      { id: 'settlement:ash' },
      { id: 'settlement:birch' },
      { id: 'settlement:cedar' },
    ],
    stations: [
      { id: 'station:elm', settlementId: 'settlement:elm' },
      { id: 'station:ash', settlementId: 'settlement:ash' },
    ],
    walkingConnections: [
      walk('settlement:elm', 'settlement:ash', 1800),
      walk('settlement:ash', 'settlement:elm', 1700),
      walk('settlement:birch', 'settlement:ash', 1600),
      walk('settlement:ash', 'settlement:birch', 1500),
      walk('settlement:birch', 'settlement:cedar', 800),
      walk('settlement:cedar', 'settlement:birch', 900),
    ],
    stationAccess: [
      { settlementId: 'settlement:birch', stationId: 'station:elm', duration: 240, distance: 1200 },
    ],
    railServices: [{
      id: 'service:regional', closed: true,
      stationIds: ['station:elm', 'station:ash'],
      segmentDurations: [300, 360],
    }],
    departureWaitEstimates: {
      'station:elm|service:regional': 90,
      'station:ash|service:regional': 110,
    },
    returnDepartureWaitEstimates: {
      'station:elm|service:regional': 70,
      'station:ash|service:regional': 80,
    },
    ...overrides,
  };
}

function walk(fromSettlementId, toSettlementId, duration) {
  return { fromSettlementId, toSettlementId, duration, distance: duration * 1.2 };
}

function quest(overrides = {}) {
  return {
    id: 'quest:letter',
    actorId: 'npc:ada',
    questId: 'authored:letter',
    originSettlementId: 'settlement:elm',
    destinationSettlementId: 'settlement:ash',
    departAt: 100,
    deadlineAt: 1000,
    facts: { recipient: 'Mara Ash', sealed: true },
    activityData: { interaction: 'deliver-letter' },
    ...overrides,
  };
}

function singleQuest(options = {}, questOverrides = {}) {
  const built = buildResidentMobilityOpportunities(catalog({
    quests: [quest(questOverrides)],
    ...options,
  }));
  assert.deepEqual(built.rejected, []);
  return built.requests[0];
}

function chosenRoute(request) {
  return planMultimodalRoute({
    origin: request.origin,
    destination: request.destination,
    purposeKind: request.kind,
    departAt: request.departAt,
    deadlineAt: request.deadlineAt,
    includeReturn: true,
    ...request.routing,
  });
}

test('station-village endpoints derive zero access without invented walking legs', () => {
  const request = singleQuest();
  assert.equal(request.routing.originAccess[0].stationId, 'station:elm');
  assert.equal(request.routing.originAccess[0].duration, 0);
  assert.equal(request.routing.destinationEgress[0].duration, 0);
  const route = request.routing;
  assert.equal(route.departureWaitEstimates['station:elm|service:regional'], 90);
  assert.equal(route.returnDepartureWaitEstimates['station:ash|service:regional'], 80);
});

test('a non-station settlement receives only its explicit access estimate', () => {
  const request = singleQuest({}, {
    originSettlementId: 'settlement:birch',
    destinationSettlementId: 'settlement:ash',
  });
  assert.deepEqual(request.routing.originAccess, [{
    stationId: 'station:elm', duration: 240,
    data: { distance: 1200, settlementId: 'settlement:birch' },
  }]);
});

test('real duration facts allow direct walking to win', () => {
  const request = singleQuest({
    walkingConnections: [
      walk('settlement:elm', 'settlement:ash', 100),
      walk('settlement:ash', 'settlement:elm', 120),
    ],
  });
  assert.equal(request.routing.directWalk.duration, 100);
  assert.equal(chosenRoute(request).outbound.mode, 'walk');
});

test('rail wins with explicit station access, segment, and wait durations', () => {
  const request = singleQuest({}, {
    originSettlementId: 'settlement:birch',
    destinationSettlementId: 'settlement:ash',
  });
  assert.equal(request.routing.directWalk.duration, 1600);
  assert.equal(request.routing.railway.connections[0].serviceId, 'service:regional');
  assert.equal(request.routing.originAccess[0].duration, 240);
  assert.equal(chosenRoute(request).outbound.mode, 'rail');
});

test('closed ordered services include the wrapped final-to-first connection', () => {
  const railway = buildClosedRailwayCatalog({
    stations: [
      { id: 's:a', settlementId: 'p:a' },
      { id: 's:b', settlementId: 'p:b' },
      { id: 's:c', settlementId: 'p:c' },
    ],
    railServices: [{
      id: 'loop', closed: true,
      stationIds: ['s:a', 's:b', 's:c'], segmentDurations: [10, 20, 30],
    }],
  });
  assert.deepEqual(railway.connections, [
    { fromStationId: 's:a', toStationId: 's:b', serviceId: 'loop', duration: 10 },
    { fromStationId: 's:b', toStationId: 's:c', serviceId: 'loop', duration: 20 },
    { fromStationId: 's:c', toStationId: 's:a', serviceId: 'loop', duration: 30 },
  ]);
  assert.throws(() => buildClosedRailwayCatalog({
    stations: [{ id: 's:a', settlementId: 'p:a' }, { id: 's:b', settlementId: 'p:b' }],
    railServices: [{ id: 'open', closed: false, stationIds: ['s:a', 's:b'], segmentDurations: [1, 1] }],
  }), /closed ordered service/);
});

test('catalog and authored-request insertion order do not change output', () => {
  const input = catalog({ maxLeisure: 2, quests: [quest(), quest({
    id: 'quest:parcel', questId: 'authored:parcel', actorId: 'npc:bert',
  })] });
  const shuffled = {
    ...input,
    settlements: [...input.settlements].reverse(),
    stations: [...input.stations].reverse(),
    walkingConnections: [...input.walkingConnections].reverse(),
    stationAccess: [...input.stationAccess].reverse(),
    railServices: [...input.railServices].reverse(),
    quests: [...input.quests].reverse(),
  };
  assert.deepEqual(buildResidentMobilityOpportunities(input),
    buildResidentMobilityOpportunities(shuffled));
});

test('same-settlement trips are excluded and unknown or unreachable places are rejected', () => {
  const built = buildResidentMobilityOpportunities(catalog({
    quests: [
      quest({ id: 'same', destinationSettlementId: 'settlement:elm' }),
      quest({ id: 'unknown', destinationSettlementId: 'settlement:missing' }),
      quest({ id: 'unreachable', destinationSettlementId: 'settlement:cedar' }),
    ],
  }));
  assert.deepEqual(built.requests, []);
  assert.deepEqual(built.rejected.map(({ requestId, reason }) => ({ requestId, reason })), [
    { requestId: 'same', reason: 'same-settlement' },
    { requestId: 'unknown', reason: 'unknown-settlement' },
    { requestId: 'unreachable', reason: 'no-outbound-route' },
  ]);
});

test('no station access never creates a rail route and a real walk remains usable', () => {
  const request = singleQuest({}, {
    originSettlementId: 'settlement:birch',
    destinationSettlementId: 'settlement:cedar',
    deadlineAt: 2000,
  });
  assert.deepEqual(request.routing.destinationEgress, []);
  assert.deepEqual(request.routing.returnRoute.originAccess, []);
  assert.equal(request.routing.directWalk.duration, 800);
});

test('each six-hour leisure cadence is bounded and prefers real rail journeys', () => {
  assert.equal(isLeisureCadenceActive(12), true);
  assert.equal(isLeisureCadenceActive(13), true);

  const active = buildResidentMobilityOpportunities(catalog({ maxLeisure: 99 }));
  const leisure = active.requests.filter((request) => request.kind === 'leisure');
  assert(leisure.length <= MAX_LEISURE_OPPORTUNITIES_PER_CADENCE);
  assert.equal(new Set(leisure.map((request) => request.destination.settlementId)).size,
    leisure.length);
  assert.equal(new Set(leisure.map((request) => request.activityData.reason)).size,
    leisure.length);
  for (const request of leisure) {
    assert.notEqual(request.originSettlementId, request.destination.settlementId);
    assert(['settlement:elm', 'settlement:ash', 'settlement:birch', 'settlement:cedar']
      .includes(request.destination.settlementId));
    assert.equal(typeof request.activityData.reason, 'string');
  }
  assert(leisure.some((request) => chosenRoute(request).outbound.mode === 'rail'),
    'when a real rail route wins, at least one visible passenger journey should use it');
});

test('caller-authored quest identity, actor, timing, facts, and activity pass through', () => {
  const request = singleQuest();
  assert.equal(request.id, 'quest:letter');
  assert.equal(request.actorId, 'npc:ada');
  assert.equal(request.questId, 'authored:letter');
  assert.equal(request.departAt, 100);
  assert.equal(request.deadlineAt, 1000);
  assert.deepEqual(request.facts, { recipient: 'Mara Ash', sealed: true });
  assert.deepEqual(request.activityData, { interaction: 'deliver-letter' });

  const missed = buildResidentMobilityOpportunities(catalog({
    quests: [quest({ deadlineAt: 200 })],
  }));
  assert.equal(missed.requests.length, 0);
  assert.equal(missed.rejected[0].reason, 'quest-deadline-unreachable');
});

test('emitted requests are accepted directly by the resident trip scheduler', () => {
  const opportunities = buildResidentMobilityOpportunities(catalog({ quests: [quest()] }));
  const residence = {
    originSettlementId: 'settlement:elm',
    residenceSettlementId: 'settlement:elm',
    householdId: 'household:ada',
    homeBuildingId: 'building:ada',
  };
  const state = {
    worldSeed: 713,
    features: {
      unifiedNpcMobilityEnabled: true,
      npcRailTravelEnabled: true,
      npcLeisureTravelEnabled: true,
    },
    entities: {
      'npc:ada': {
        id: 'npc:ada', kind: 'npc', residence,
        location: {
          kind: 'building', settlementId: 'settlement:elm', buildingId: 'building:ada',
        },
      },
    },
    itineraries: {},
  };
  const planned = planResidentTripBatch(state, {
    worldSeed: 713, dayIndex: 8, cadenceBucket: 12,
    requests: opportunities.requests, maxTrips: 1,
  });
  assert.equal(planned.trips.length, 1);
  assert.equal(planned.trips[0].actorId, 'npc:ada');
  assert.equal(planned.trips[0].route.outbound.mode, 'rail');
  assert.equal(planned.trips[0].itinerary.returnPlan.required, true);
});

test('the opportunity adapter stays pure and renderer-free', async () => {
  const source = await readFile(new URL('../src/npcmobilityopportunities.mjs', import.meta.url),
    'utf8');
  for (const forbidden of ['Math.random', 'Date.now', 'performance.now', "from 'three'", 'THREE.']) {
    assert.equal(source.includes(forbidden), false, `unexpected dependency: ${forbidden}`);
  }
});
