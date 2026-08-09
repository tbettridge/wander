import test from 'node:test';
import assert from 'node:assert/strict';
import { planMultimodalRoute } from '../src/npcmultimodalroute.mjs';
import { bindNpcMobilityRoute } from '../src/npcmobilityroutebinding.mjs';
import { createItinerary } from '../src/npcitinerary.mjs';
import {
  attachNpcSpatialState, createLivingWorldState, registerLivingWorldEntity, setLivingWorldFeatures,
} from '../src/livingworldstate.mjs';
import { registerNpcItinerary } from '../src/npcmobility.mjs';
import { tickNpcMobilityItinerary } from '../src/npcmobilityexecutor.mjs';

const residence = {
  originSettlementId: 'settlement:home', residenceSettlementId: 'settlement:home',
  householdId: 'household:home:1', homeBuildingId: 'building:home:1',
};
const home = { kind: 'building', settlementId: 'settlement:home', buildingId: 'building:home:1', nodeId: null };
const destination = { kind: 'settlement-node', settlementId: 'settlement:away', nodeId: 'market' };
const homePlatform = { kind: 'station-platform', stationId: 'station:home', platformId: 'platform:home', waitAnchorId: 'wait:home:1' };
const awayPlatform = { kind: 'station-platform', stationId: 'station:away', platformId: 'platform:away', waitAnchorId: 'wait:away:1' };

function railRoute() {
  return planMultimodalRoute({
    origin: { key: 'settlement:home' }, destination: { key: 'settlement:away' },
    directWalk: null,
    originAccess: [{ stationId: 'station:home', duration: 2, kind: 'local-walk' }],
    destinationEgress: [{ stationId: 'station:away', duration: 2, kind: 'local-walk' }],
    railway: { stations: ['station:home', 'station:away'], connections: [
      { fromStationId: 'station:home', toStationId: 'station:away', serviceId: 'regional:out', duration: 80 },
      { fromStationId: 'station:away', toStationId: 'station:home', serviceId: 'regional:return', duration: 80 },
    ] },
    departureWaitEstimates: {
      'station:home|regional:out': 10,
      'station:away|regional:return': 10,
    },
  });
}

function bind(route, overrides = {}) {
  return bindNpcMobilityRoute(route, {
    residence, originLocation: home, destinationLocation: destination,
    platformLocations: { 'station:home': homePlatform, 'station:away': awayPlatform },
    activityDurationSeconds: 5,
    ...overrides,
  });
}

test('station-village rail route uses local access and binds exact platforms and board destinations', () => {
  const result = bind(railRoute());
  assert.deepEqual(result.outboundLegs.map((leg) => leg.kind), [
    'local-walk', 'station-wait', 'board-train', 'train-ride', 'alight-train', 'local-walk',
  ]);
  assert.deepEqual(result.outboundLegs[1].data.platformLocation, homePlatform);
  assert.equal(result.outboundLegs[2].data.destinationStationId, 'station:away');
  assert.deepEqual(result.outboundLegs[4].data.platformLocation, awayPlatform);
  assert.equal(result.returnLegs[2].data.destinationStationId, 'station:home');
  assert.deepEqual(result.activityData, { durationSeconds: 5, location: destination });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('duration fields and explicit regional edge facts bind a direct walk round trip', () => {
  const route = planMultimodalRoute({
    origin: { key: 'settlement:home' }, destination: { key: 'settlement:away' },
    directWalk: { duration: 20 }, includeReturn: true,
  });
  const outboundId = route.outboundLegs[0].id;
  const returnId = route.returnLegs[0].id;
  const result = bind(route, { regionalWalks: {
    [outboundId]: { edgeLocation: { kind: 'regional-edge', edgeId: 'edge:out', fromKey: 'home', toKey: 'away', progress: 0 } },
    [returnId]: { edgeLocation: { kind: 'regional-edge', edgeId: 'edge:return', fromKey: 'away', toKey: 'home', progress: 0 } },
  } });
  assert.equal(result.outboundLegs[0].data.durationSeconds, 20);
  assert.equal('duration' in result.outboundLegs[0].data, false);
  assert.deepEqual(result.outboundLegs[0].data.fromLocation, home);
  assert.deepEqual(result.outboundLegs[0].data.toLocation, destination);
  assert.deepEqual(result.returnLegs[0].data.toLocation, home);
});

test('binding fails closed for missing geography, ambiguous platforms, or a non-home origin', () => {
  const walking = planMultimodalRoute({
    origin: { key: 'settlement:home' }, destination: { key: 'settlement:away' }, directWalk: { duration: 20 },
  });
  assert.throws(() => bind(walking), /explicit canonical edge facts/);
  assert.throws(() => bind(railRoute(), { platformLocations: [homePlatform, homePlatform, awayPlatform] }), /Ambiguous/);
  assert.throws(() => bind(railRoute(), { originLocation: destination }), /canonical home building/);
});

test('bound rail route registers and executes a complete outward and return lifecycle', () => {
  const state = createLivingWorldState({ worldSeed: 5 });
  setLivingWorldFeatures(state, {
    unifiedNpcMobilityEnabled: true, npcRailTravelEnabled: true, npcLeisureTravelEnabled: true,
  });
  registerLivingWorldEntity(state, { id: 'npc:one', kind: 'npc', name: 'One' });
  attachNpcSpatialState(state, 'npc:one', { residence, location: home });
  const bound = bind(railRoute());
  registerNpcItinerary(state, createItinerary({
    id: 'trip:bound', actorId: 'npc:one', residence,
    origin: { key: 'settlement:home' }, destination: { key: 'settlement:away' },
    purpose: { kind: 'leisure' }, outboundLegs: bound.outboundLegs,
    activity: { id: 'visit', kind: 'leisure', data: bound.activityData },
    returnLegs: bound.returnLegs,
  }));
  const dwelling = (serviceId, stationId, runId) => [{ serviceId, stationId, runId, phase: 'dwelling', serviceTick: 1 }];
  tickNpcMobilityItinerary(state, 'npc:one', { deltaSeconds: 2 });
  tickNpcMobilityItinerary(state, 'npc:one', { railServices: dwelling('regional:out', 'station:home', 'run:out') });
  assert.equal(state.entities['npc:one'].location.kind, 'train-seat');
  tickNpcMobilityItinerary(state, 'npc:one', { railServices: dwelling('regional:out', 'station:away', 'run:out') });
  assert.deepEqual(state.entities['npc:one'].location, awayPlatform);
  tickNpcMobilityItinerary(state, 'npc:one', { deltaSeconds: 7 });
  tickNpcMobilityItinerary(state, 'npc:one', { deltaSeconds: 2 });
  tickNpcMobilityItinerary(state, 'npc:one', { railServices: dwelling('regional:return', 'station:away', 'run:return') });
  assert.equal(state.entities['npc:one'].location.kind, 'train-seat');
  const report = tickNpcMobilityItinerary(state, 'npc:one', {
    deltaSeconds: 2, railServices: dwelling('regional:return', 'station:home', 'run:return'),
  });
  assert.equal(report.completed, true);
  assert.deepEqual(state.entities['npc:one'].location, home);
});

test('module remains renderer, randomness, and wall-clock independent', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(
    new URL('../src/npcmobilityroutebinding.mjs', import.meta.url), 'utf8',
  ));
  assert.doesNotMatch(source, /\bTHREE\b|Math\.random|Date\.now|performance\.now/);
});
