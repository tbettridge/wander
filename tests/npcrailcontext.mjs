import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState, registerLivingWorldEntity, attachNpcSpatialState } from '../src/livingworldstate.mjs';
import { createItinerary } from '../src/npcitinerary.mjs';
import { registerNpcItinerary } from '../src/npcmobility.mjs';
import { tickNpcMobilityItinerary } from '../src/npcmobilityexecutor.mjs';
import { npcRailJourneyContext } from '../src/npcrailtraffic.mjs';
import { boundNpcGroundMovement, NPC_MAX_HUMAN_RUN_SPEED, NPC_NORMAL_WALK_LIMIT } from '../src/npcmobilitypace.mjs';
import { advanceWorkRoutines } from '../src/npcroutine.mjs';
import { fallbackDialogue, fallbackChatReply, conversationSystemPrompt, composeDialogueTurn, compactDialogueContext } from '../src/livingworld.mjs';
import { buildStationDialogueContext, landmarkLikelyVisible } from '../src/livingworldcontext.mjs';
import { NpcMobilityPresentationReconciler } from '../src/npcmobilitypresentation.js';
import { NpcLiveEncounterBridge } from '../src/npcliveencounter.mjs';

const home = { kind: 'building', settlementId: 'elm', buildingId: 'elm:home' };
const away = { kind: 'building', settlementId: 'ash', buildingId: 'ash:home' };
const platform = (id) => ({ kind: 'station-platform', stationId: id, platformId: `${id}:main`, waitAnchorId: `${id}:wait` });
const stations = [{ id: 'elm', name: 'Elm Halt' }, { id: 'ash', name: 'Ash Wells' }];
function fixture({ rail = false, purpose = { kind: 'visit' } } = {}) {
  const state = createLivingWorldState();
  registerLivingWorldEntity(state, { id: 'ada', kind: 'npc', name: 'Ada' });
  const residence = { originSettlementId: 'elm', residenceSettlementId: 'elm', householdId: 'house:ada', homeBuildingId: 'elm:home' };
  attachNpcSpatialState(state, 'ada', { residence, location: home });
  const legs = (direction, from, to, a, b) => rail ? [
    { id: `${direction}:walk`, kind: 'local-walk', data: { fromLocation: a, toLocation: platform(from), durationSeconds: 10 } },
    { id: `${direction}:wait`, kind: 'station-wait', data: { originStationId: from, platformLocation: platform(from), serviceId: 'regional' } },
    { id: `${direction}:board`, kind: 'board-train', data: { originStationId: from, destinationStationId: to, platformLocation: platform(from), serviceId: 'regional' } },
    { id: `${direction}:ride`, kind: 'train-ride', data: { destinationStationId: to, serviceId: 'regional' } },
    { id: `${direction}:alight`, kind: 'alight-train', data: { destinationStationId: to, platformLocation: platform(to), serviceId: 'regional' } },
    { id: `${direction}:destination`, kind: 'local-walk', data: { fromLocation: platform(to), toLocation: b, durationSeconds: 10 } },
  ] : [{ id: direction, kind: 'local-walk', data: { fromLocation: a, toLocation: b, durationSeconds: 10 } }];
  registerNpcItinerary(state, createItinerary({ id: 'trip', actorId: 'ada', residence,
    origin: { key: 'elm:home' }, destination: { key: 'ash:home' }, purpose,
    outboundLegs: legs('outbound', 'elm', 'ash', home, away),
    activity: { kind: 'visit', data: { durationSeconds: 0, durationHours: 1.25, location: away } },
    returnLegs: legs('return', 'ash', 'elm', away, home) }));
  return state;
}
const service = (id) => [{ serviceId: 'regional', runId: 'run', phase: 'dwelling', stationId: id,
  nextStationId: id, doorFactor: 1, serviceTick: 1, dwellRemaining: 100, dwell: 16 }];
function passenger() {
  const state = fixture({ rail: true, purpose: { kind: 'visit', transport: 'rail', reason: 'family-visit',
    description: 'visiting my family in Ash Wells', originName: 'Elm Halt', destinationName: 'Ash Wells',
    companionNames: ['Bram'], durationHours: 1.25 } });
  tickNpcMobilityItinerary(state, 'ada', { deltaSeconds: 30, worldHours: 9, railServices: service('elm') });
  return state;
}

test('legacy ten-second access and egress walks obey physical distance instead of deadlines', () => {
  const state = fixture();
  tickNpcMobilityItinerary(state, 'ada', { deltaSeconds: 10, worldHours: 23, walkDurationFor: () => 800 });
  const executor = state.entities.ada.activity.executor;
  assert.equal(executor.durationSeconds, 800);
  assert.equal(executor.progress, 10 / 800);
  assert.equal(state.entities.ada.itineraryId, 'trip');
});

test('repairing a saved fast walk preserves position and then advances at walking speed', () => {
  const state = fixture();
  tickNpcMobilityItinerary(state, 'ada', { deltaSeconds: 5, worldHours: 9 });
  assert.equal(state.entities.ada.activity.executor.progress, 0.5);
  tickNpcMobilityItinerary(state, 'ada', { deltaSeconds: 1, worldHours: 20, walkDurationFor: () => 800 });
  assert.equal(state.entities.ada.activity.executor.progress, 0.5 + 1 / 800);
});

test('ground presentation cannot jump faster than an ordinary human run', () => {
  const previous = { x: 0, y: 0, z: 0 };
  const next = { x: 80, y: 1, z: 40, mode: 'walk', heading: 1 };
  const bounded = boundNpcGroundMovement(previous, next, 0.1);
  assert.ok(Math.hypot(bounded.x, bounded.y, bounded.z) <= NPC_MAX_HUMAN_RUN_SPEED * 0.1 + 1e-9);
  assert.equal(boundNpcGroundMovement(previous, { ...next, supportMatrix: Array(16).fill(0) }, 0.1).x, 80,
    'being carried by a train is not running');
  assert.equal(boundNpcGroundMovement(previous, next, 0).x, 0);
});

test('the actual presentation consumer caps a corner or phase handoff without changing canonical state', () => {
  const state = fixture();
  tickNpcMobilityItinerary(state, 'ada', { deltaSeconds: 0, worldHours: 9 });
  let x = 0;
  const root = { position: { x: 0, y: 0, z: 0 } };
  const reconciler = new NpcMobilityPresentationReconciler({ stateProvider: () => state,
    identityProvider: () => ({ id: 'ada' }), locationResolver: () => ({ x, y: 0, z: 0, mode: 'walk' }),
    cullRange: 2000, avatarFactory: () => ({ root, update: ({ resolved }) => Object.assign(root.position, resolved) }) });
  reconciler.update(0.1, { x: 0, y: 0, z: 0 });
  const before = structuredClone(state);
  x = 100; reconciler.update(0.1, { x: 0, y: 0, z: 0 });
  assert.ok(root.position.x <= NPC_NORMAL_WALK_LIMIT * 0.1 + 1e-9);
  assert.deepEqual(state, before);
});

test('live voice lookups refresh public train scenery while preserving the host narrative context', async () => {
  const context = { journey: { transport: 'rail', to: 'Ash Wells' }, biome: 'forest',
    scenery: { nearbyLandmarks: [] }, targets: [], currentLocation: { kind: 'train' } };
  const bridge = new NpcLiveEncounterBridge({ contextForActor: () => context,
    conversationBridge: { lookup: async () => ({ speakable: [{ id: 'host-fact' }] }) } });
  const reservation = { remoteConversationId: 'host-session', context: { social: { privateFact: 'retained' } } };
  const result = await bridge.lookup({ actor: {}, reservation }, 'What is outside?');
  assert.equal(result.currentSituation.biome, 'forest');
  assert.equal(result.speakable[0].id, 'host-fact');
  assert.equal(reservation.context.social.privateFact, 'retained');
  context.biome = 'taiga';
  assert.equal((await bridge.lookup({ actor: {}, reservation }, 'And now?')).currentSituation.biome, 'taiga');
});

test('a travel day suspends work, gives no fictitious shift outcome, and allows an unhurried return', () => {
  const state = fixture();
  state.routines.shift = { id: 'shift', actorId: 'ada', days: [0, 1, 2, 3, 4, 5, 6], startHour: 8,
    endHour: 17, destinationKey: 'work', homeKey: 'home', workplaceId: 'shop' };
  state.workplaces.shop = { id: 'shop', kind: 'workshop', inventory: {} };
  const location = structuredClone(state.entities.ada.location);
  advanceWorkRoutines(state, 10);
  assert.equal(state.routines.shift.state, 'travelling');
  assert.deepEqual(state.entities.ada.location, location);
  state.entities.ada.itineraryId = null; state.entities.ada.inTransit = false;
  assert.deepEqual(advanceWorkRoutines(state, 18), []);
  assert.equal(state.workplaces.shop.completedShifts, undefined);
  advanceWorkRoutines(state, 32);
  assert.equal(state.routines.shift.state, 'working');
});

test('passenger context identifies the train, actual destination, reason, companions and flexible return', () => {
  const state = passenger();
  const journey = npcRailJourneyContext(state, 'ada', { stations, service: service('elm')[0] });
  assert.equal(journey.onTrain, true); assert.equal(journey.transport, 'rail');
  assert.match(journey.doing, /sitting.*train/);
  assert.equal(journey.from, 'Elm Halt'); assert.equal(journey.to, 'Ash Wells');
  assert.equal(journey.reason, 'family-visit'); assert.deepEqual(journey.companions, ['Bram']);
  assert.equal(journey.returnTiming.visitHours, 1.25);
  assert.equal(journey.returnTiming.flexible, true); assert.match(journey.returnPlan, /next convenient train.*Elm Halt/);
});

test('older rail itineraries also have journey context and return legs reverse the destination', () => {
  const state = fixture({ rail: true, purpose: { kind: 'leisure' } });
  tickNpcMobilityItinerary(state, 'ada', { deltaSeconds: 30, worldHours: 9, railServices: service('elm') });
  assert.equal(npcRailJourneyContext(state, 'ada', { stations }).to, 'Ash Wells');
  tickNpcMobilityItinerary(state, 'ada', { deltaSeconds: 40, worldHours: 10, railServices: service('ash') });
  tickNpcMobilityItinerary(state, 'ada', { deltaSeconds: 1, worldHours: 12, railServices: service('ash') });
  const journey = npcRailJourneyContext(state, 'ada', { stations });
  assert.equal(journey.returning, true); assert.equal(journey.to, 'Elm Halt'); assert.equal(journey.from, 'Ash Wells');
});

test('authored and AI dialogue carry passenger facts rather than home greetings or invented errands', () => {
  const state = passenger();
  const journey = npcRailJourneyContext(state, 'ada', { stations });
  const landmark = { id: 'ruin', name: 'the ruined watchtower', kind: 'tower', distanceM: 140,
    distancePhrase: 'a short way off', direction: 'west', likelyVisible: true };
  const context = { npc: { id: 'ada', name: 'Ada', role: 'weaver' }, station: { id: 'train', name: 'the regional train' },
    targets: [{ id: 'train', name: 'the regional train', kind: 'train' }, landmark], biome: 'forest',
    scenery: { biome: 'forest', nearbyLandmarks: [landmark] }, currentLocation: { kind: 'train' }, journey };
  assert.match(fallbackDialogue(context).text, /regional train.*family.*Ash Wells/);
  assert.match(fallbackChatReply(context, 'Where are you going and why?').text, /family.*Ash Wells/);
  assert.match(fallbackChatReply(context, 'Why are you on this train, where are you going and when will you return home?').text,
    /regional train.*family.*Ash Wells.*Elm Halt/);
  assert.match(fallbackChatReply(context, 'When will you return home?').text, /hour or two.*Elm Halt/);
  assert.match(fallbackChatReply(context, 'What can you see outside?').text, /forest.*ruined watchtower/);
  const prompt = conversationSystemPrompt(context);
  assert.match(prompt, /passenger aboard the regional train/);
  assert.match(prompt, /supersedes older journey phases/);
  assert.doesNotMatch(prompt, /you are out walking it right now/);
  const live = composeDialogueTurn('What about the scenery now?', null, { ...context, biome: 'taiga' });
  assert.match(live, /GAME_CURRENT_SITUATION/); assert.match(live, /"biome":"taiga"/);
  assert.equal(compactDialogueContext(context, { level: 2 }).journey.to, 'Ash Wells');
});

test('scenery follows the speaker position, excludes distant landmarks, and respects terrain occlusion', () => {
  const world = { seed: 17, biomeAt: (x) => ({ id: x < 500 ? 'grassland' : 'taiga', h: 42, slope: 0.1, t: 4, m: 0.5 }),
    riverAt: () => ({ wet: false }), height: () => 42 };
  const context = buildStationDialogueContext({ world, station: { id: 'train', name: 'the regional train', x: 0, z: 0 },
    player: { x: 0, z: 0 }, origin: { x: 1600, y: 44, z: 0 }, onTrain: true });
  assert.equal(context.biome, 'taiga'); assert.equal(context.currentLocation.kind, 'train');
  assert.ok(context.scenery.nearbyLandmarks.every((entry) => entry.distanceM <= 350));
  const from = { x: 0, y: 2, z: 0 }, target = { x: 300, z: 0 };
  assert.equal(landmarkLikelyVisible({ heightAt: () => 0 }, from, target), true);
  assert.equal(landmarkLikelyVisible({ heightAt: (x) => x > 100 && x < 200 ? 20 : 0 }, from, target), false);
  assert.equal(landmarkLikelyVisible({ height: (x) => x > 100 && x < 200 ? 20 : 0 }, from, target), false);
});
