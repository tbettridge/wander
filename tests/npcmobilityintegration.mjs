import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createLivingWorldState,
  DEFAULT_LIVING_WORLD_FEATURES,
  normalizeLivingWorldFeatures,
} from '../src/livingworldstate.mjs';
import { activateSettlementResidents } from '../src/npcresidenceregistry.mjs';
import {
  createServiceRunId,
  PLAYER_PREFERRED_SEAT,
  RailPassengerManifest,
} from '../src/railpassengers.mjs';
import { TrainScheduleModel } from '../src/railservice.mjs';

const source = async (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('unified mobility rollout flags default off and enforce their dependencies', () => {
  for (const key of [
    'unifiedNpcMobilityEnabled',
    'npcRailTravelEnabled',
    'npcLeisureTravelEnabled',
    'npcMigrationEnabled',
  ]) assert.equal(DEFAULT_LIVING_WORLD_FEATURES[key], false, `${key} must default off`);

  const state = createLivingWorldState({ worldSeed: 91 });
  assert.equal(state.features.unifiedNpcMobilityEnabled, false);
  assert.equal(state.features.npcRailTravelEnabled, false);
  assert.deepEqual(
    normalizeLivingWorldFeatures({
      unifiedNpcMobilityEnabled: false,
      npcRailTravelEnabled: true,
      npcLeisureTravelEnabled: true,
      npcMigrationEnabled: true,
    }),
    { ...DEFAULT_LIVING_WORLD_FEATURES },
    'dependent mobility features cannot become active while the parent gate is off',
  );
});

test('headless resident activation is a default-off no-op without geometry', () => {
  const state = createLivingWorldState({ worldSeed: 92 });
  const before = structuredClone(state);
  const result = activateSettlementResidents({
    site: { id: 'settlement:headless-contract' }, buildings: [],
  }, state);
  assert.equal(result.activated, false);
  assert.equal(result.reason, 'feature-disabled');
  assert.deepEqual(state, before);
});

test('schedule and manifest share a run ID and ordinary reservations protect player seats', () => {
  const schedule = new TrainScheduleModel(1000, [0, 500], {
    serviceId: 'integration-line', serviceDay: 7,
  });
  const expectedRunId = createServiceRunId({
    serviceId: 'integration-line', serviceEpoch: schedule.serviceEpoch,
    serviceDay: 7, sequence: 0,
  });
  assert.equal(schedule.serviceRunId, expectedRunId);
  const manifest = new RailPassengerManifest({ runId: schedule.serviceRunId });
  for (let index = 0; index < 6; index++) {
    manifest.reserve({
      personId: `npc:integration:${index}`,
      originStationId: 'station:a',
      destinationStationId: 'station:b',
    });
  }
  assert.deepEqual(manifest.playerAvailableSeat(0), {
    carriageIndex: 0, seatIndex: PLAYER_PREFERRED_SEAT,
  });
  assert.deepEqual(manifest.playerAvailableSeat(1), {
    carriageIndex: 1, seatIndex: PLAYER_PREFERRED_SEAT,
  });
});

test('browser wiring keeps passenger authority outside the railway renderer', async () => {
  const [main, railway] = await Promise.all([source('main.js'), source('railservice.js')]);
  const providerStart = main.indexOf('passengerManifestProvider: (runId) =>');
  const providerEnd = main.indexOf('const regionalRailway =', providerStart);
  assert.ok(providerStart >= 0 && providerEnd > providerStart,
    'main must install the optional passenger manifest provider');
  const providerWiring = main.slice(providerStart, providerEnd);
  assert.match(providerWiring, /features\?\.npcRailTravelEnabled/,
    'main provider must remain behind the rail-travel feature gate');
  assert.match(providerWiring, /railPassengerManifest\(livingWorldPopulation\.worldState, runId\)/,
    'main provider must read the durable manifest for the schedule run');
  assert.doesNotMatch(providerWiring,
    /reserveNpcRailPassenger|boardNpcRailPassenger|alightNpcRailPassenger|\.reserve\(|\.board\(|\.alight\(/,
    'main provider must not mutate passenger authority');

  assert.match(railway, /passengerManifestProvider = null/,
    'the renderer integration must remain optional');
  assert.match(railway,
    /if \(!this\.schedule \|\| !this\.passengerManifestProvider\) return null/,
    'an absent provider must preserve the legacy fallback');
  assert.match(railway,
    /this\.passengerManifestProvider\(this\.schedule\.serviceRunId, this\.schedule\)/,
    'the renderer must query by the authoritative schedule run ID');
  assert.match(railway,
    /catch \{[\s\S]{0,180}this\._passengerManifestReadFailed = true/,
    'malformed passenger authority must be isolated from input handling');
  assert.match(railway,
    /nearestCarriageSeat\([\s\S]{0,180}npcClaimsSeat\(manifest, this\.ridingCarriage, index\)/,
    'optional seating must honor reservations through the pure capacity contract');
  assert.match(railway, /npcClaimsSeat\(manifest, this\.ridingCarriage, candidate\)/,
    'view cycling must skip NPC-reserved or occupied seat anchors');
  assert.match(railway, /passengerSeatAnchor\(carriageIndex, seatIndex\)/,
    'the NPC materializer seam must expose a bounds-safe seat anchor');

  assert.match(railway, /enterStanding\([\s\S]{0,1000}this\.controls\.enabled = true/,
    'walking aboard must preserve locomotion instead of requiring a seat');
  const sitStart = railway.indexOf('  trySitNearest() {');
  const sitEnd = railway.indexOf('\n  sit(seatIndex) {', sitStart);
  const sitBody = railway.slice(sitStart, sitEnd);
  assert.ok(sitStart >= 0 && sitEnd > sitStart);
  assert.ok(sitBody.indexOf('this._passengerManifestReadFailed')
    < sitBody.indexOf('return this.sit'),
  'corrupt passenger authority must fail closed before optional seating');
});

test('browser wiring checkpoints the authoritative timetable behind the rail gate', async () => {
  const [main, railway] = await Promise.all([source('main.js'), source('railservice.js')]);
  const serviceStart = main.indexOf('const regionalRailwayService = new RegionalRailwayService');
  const serviceEnd = main.indexOf('const regionalRailway =', serviceStart);
  assert.ok(serviceStart >= 0 && serviceEnd > serviceStart,
    'main must construct the regional passenger service');
  const wiring = main.slice(serviceStart, serviceEnd);
  assert.match(wiring,
    /scheduleSnapshotProvider: \(serviceId\) => \([\s\S]*features\?\.npcRailTravelEnabled[\s\S]*railServiceSnapshot\(/,
    'restoring the timetable must remain behind the rail-travel feature gate');
  assert.match(wiring,
    /onScheduleSnapshot: \(serviceId, snapshot\) => \{[\s\S]*features\?\.npcRailTravelEnabled[\s\S]*persistRailServiceSnapshot\(/,
    'checkpointing the timetable must remain behind the rail-travel feature gate');

  assert.match(railway, /scheduleSnapshotProvider = null/,
    'saved timetable restoration must remain an optional renderer adapter');
  assert.match(railway, /onScheduleSnapshot = null/,
    'timetable checkpointing must remain an optional renderer adapter');
  assert.match(railway,
    /this\.schedule = this\.restoreScheduleSnapshot\(freshSchedule, plan\)/,
    'a compatible durable timeline must be restored when the plan is installed');
  assert.match(railway,
    /this\.publishScheduleSnapshot\(this\.schedule\.justArrived \|\| this\.schedule\.justDeparted\)/,
    'arrivals and departures must be checkpointed immediately');
  assert.match(railway, /Math\.abs\(expected\.length - restored\.length\) > 1e-6/,
    'stale snapshots must not be applied to a different route');
  assert.match(railway, /expected\.serviceEpoch !== restored\.serviceEpoch/,
    'a changed station alignment must not inherit a stale service run');
  assert.match(railway, /catch \{\s*return freshSchedule;\s*\}/,
    'malformed state must fall back without freezing the visible service');
});

test('settlement streaming and station warming activate the same headless registry', async () => {
  const [main, stream, spatial] = await Promise.all([
    source('main.js'), source('settlementstream.js'), source('settlementspatial.mjs'),
  ]);
  assert.match(stream,
    /if \(this\.state\.features\.unifiedNpcMobilityEnabled\) \{\s*activatedPopulation = activateSettlementResidents\(plan, this\.state\)/,
    'streamed settlements must materialize residents from headless activation');
  assert.match(stream,
    /function canonicalResidentIsLocal[\s\S]{0,240}entity\?\.location\?\.kind === 'building'[\s\S]{0,120}entity\.location\.settlementId === settlementId/,
    'the settlement renderer must not duplicate away trail, platform, or train residents at home');
  assert.match(stream,
    /_reconcileCanonicalResidents\(current\)[\s\S]{0,1400}resident\.root\.removeFromParent\(\)[\s\S]{0,120}resident\.avatar\.dispose\(\)/,
    'an already-materialized home avatar must be removed when canonical ownership moves away');
  assert.match(stream,
    /_reconcileCanonicalResidents\(current\)[\s\S]{0,1200}if \(this\.isActorInDialogue\(resident\.actorId\)\) continue;[\s\S]{0,600}resident\.root\.removeFromParent\(\)/,
    'the resident the player is talking to must survive the reconcile that would delete them');
  assert.match(stream,
    /household\.memberIds\.forEach\(\(id, index\) => \{[\s\S]{0,800}residentBlueprints\.set\(id, blueprint\)[\s\S]{0,450}if \(index < take && canonicalHere\) pending\.push\(blueprint\)/,
    'every household member needs a return-home blueprint even when the initial visible queue is capped');

  const warmStart = main.indexOf('warmStationSettlementPlans(world, world.seed');
  const warmEnd = main.indexOf('if (villages)', warmStart);
  assert.ok(warmStart >= 0 && warmEnd > warmStart,
    'main must warm station settlement plans during service-plan installation');
  const warmWiring = main.slice(warmStart, warmEnd);
  assert.match(warmWiring,
    /onPlan: \(settlementPlan\) => \{[\s\S]*activateSettlementResidents\(\s*settlementPlan, livingWorldPopulation\.worldState/,
    'station plan warming must activate residents before geometry streams');
  assert.match(spatial,
    /const plan = cachedSettlementPlan\(world, site\);\s*if \(typeof onPlan === 'function'\) onPlan\(plan\)/,
    'the station warming helper must invoke its callback for each cached plan');
});

test('station duty adopts canonical residents before station avatars are queued', async () => {
  const [main, keeper, debug] = await Promise.all([
    source('main.js'), source('stationkeeper.js'), source('debug.js'),
  ]);
  for (const key of [
    'unifiedNpcMobilityEnabled',
    'npcRailTravelEnabled',
    'npcLeisureTravelEnabled',
    'npcMigrationEnabled',
  ]) {
    assert.match(keeper, new RegExp(`${key}: this\\.features\\.${key}`),
      `${key} must exist on the live debug model before lil-gui binds it`);
  }
  assert.match(debug,
    /for \(const featureController of featureControllers\) featureController\.updateDisplay\(\)/,
    'dependent mobility toggles must follow normalized feature state in the live debug panel');
  const serviceStart = main.indexOf('onServicePlan: (plan) => {');
  const serviceEnd = main.indexOf('\n  },\n});', serviceStart);
  assert.ok(serviceStart >= 0 && serviceEnd > serviceStart);
  const wiring = main.slice(serviceStart, serviceEnd);
  const activateAt = wiring.indexOf('activateSettlementResidents(');
  const contextAt = wiring.indexOf('stationDutyContexts.push(');
  const providerAt = wiring.indexOf('setStationRosterProvider(');
  const refreshAt = wiring.indexOf('refreshCanonicalStationDuty()');
  const queueAt = wiring.indexOf('livingWorldPopulation.setPlan(plan)');
  assert.ok(activateAt >= 0 && activateAt < contextAt && contextAt < providerAt
    && providerAt < refreshAt && refreshAt < queueAt,
  'canonical activation, context publication, and duty refresh must precede station avatar queuing');
  assert.match(main,
    /function refreshCanonicalStationDuty\(\)[\s\S]{0,900}livingWorldPopulation\.reconcileCanonicalStationRosters\(\)[\s\S]{0,120}settlementSystem\.reconcileCanonicalResidents\(\)/,
    'platform owners must be removed before released residents rematerialize at home');
  assert.match(main,
    /livingWorldPopulation\.update\([\s\S]{0,3000}refreshCanonicalStationDutyUnlessTalking\(\);\s*settlementSystem\.update/,
    'the world-clock update must drive half-hour station duty refreshes at runtime');

  // A duty bucket turns over roughly every twenty-nine real seconds, which is
  // inside a single conversation. Reassigning the speaker deletes them from
  // both populations, which is what used to end the dialogue and the pointer
  // lock together. Every cadence-driven reassignment defers instead.
  assert.match(main,
    /function refreshCanonicalStationDutyUnlessTalking\(\) \{\s*if \(livingWorldPopulation\.dialoguePartnerId\(\)\) return null;/,
    'the half-hourly duty refresh must be held while the player is mid-conversation');
  assert.match(main,
    /function scheduleNpcMobilityTrips\(\)[\s\S]{0,600}if \(livingWorldPopulation\.dialoguePartnerId\(\)\) return null;[\s\S]{0,400}lastNpcMobilityCadence === cadenceKey/,
    'nobody may be scheduled onto a trip while the player is talking to them');
  assert.match(main,
    /tickAllNpcMobilityItineraries\([\s\S]{0,700}skipActorIds: talkingTo \? \[talkingTo\] : \[\]/,
    'only the speaker pauses mid-journey; the rest of the world keeps walking');
  assert.match(keeper,
    /if \(this\.isTalkingTo\(actor\.identity\?\.id\)\) \{\s*this\.rosterReconcileDeferred = true;\s*return false;/,
    'removeActor must never delete the person holding an open dialogue');
  assert.match(keeper,
    /if \(this\.rosterReconcileDeferred && !this\.dialogueOpen\) \{[\s\S]{0,200}this\.reconcileCanonicalStationRosters\(\)/,
    'a roster change deferred by a conversation must be replayed once it ends');

  assert.match(keeper,
    /if \(this\.worldState\.features\?\.unifiedNpcMobilityEnabled\) \{[\s\S]{0,420}canonicalStationDescriptors/,
    'unified station presentation must consume the canonical duty roster');
  assert.match(keeper,
    /else \{\s*descriptors = createStationPopulation/,
    'the authored legacy roster must remain the disabled-mode fallback only');
  assert.match(keeper,
    /if \(!actor\.canonicalDuty && !actor\.canonicalMobility\s*&& rosterIndex < this\.travellersPerStation\)/,
    'canonical duty and itinerary residents must never receive legacy traveller journeys');
  assert.match(keeper,
    /const entity = actor\.canonicalDuty \|\| actor\.canonicalMobility\s*\? existing\s*:\s*registerLivingWorldEntity/,
    'adopted residents must preserve their existing canonical entity record');
  assert.match(keeper,
    /Itinerary travellers have one continuous presentation owner[\s\S]{0,180}return duty/,
    'station duty must leave itinerary travellers to the continuous mobility renderer');
  assert.match(keeper,
    /reconcileCanonicalStationRosters\(\)[\s\S]{0,1800}this\.removeActor\(actor\)[\s\S]{0,900}this\.pending\.push\(item\)/,
    'live roster changes must remove stale owners and queue only the new canonical residents');
});

test('boarded rail passengers keep one canonical moving presentation', async () => {
  const [main, keeper, railway] = await Promise.all([
    source('main.js'), source('stationkeeper.js'), source('railservice.js'),
  ]);
  assert.match(main,
    /Itinerary travellers keep one world-space avatar while walking, boarding,[\s\S]{0,120}seat-only renderer stays disabled/,
    'the former seat-only renderer must not duplicate a continuous traveller');
  assert.match(main,
    /npcPassengerWorldPose\(transfer\)/,
    'main must resolve NPC transfer phases against the live moving carriage');
  assert.match(keeper,
    /canonicalResidentIdentity\(personId\)[\s\S]{0,500}createSettlementResidentIdentity/,
    'train passengers must retain the same household-keyed appearance used at home');
  assert.match(keeper,
    /createRailPassengerPresentation\(\{ identity \}[\s\S]{0,900}seatLocalPosition: \{ x: 0, y: -1\.75, z: 0 \}/,
    'the shared avatar must receive an authored seated carriage pose');
  assert.match(railway,
    /reconcilePassengerPresentations\(dt\)[\s\S]{0,120}if \(this\.seated\) this\.syncSeatedRig/,
    'NPC seat occupancy must reconcile before the player camera is synchronized');
});

test('pure mobility and railway contracts have no THREE or Math.random dependency', async () => {
  const pureModules = [
    'npclocation.mjs',
    'npcitinerary.mjs',
    'npcmobility.mjs',
    'npcmobilitydemand.mjs',
    'npcmultimodalroute.mjs',
    'npcresidenceregistry.mjs',
    'npcresidentidentity.mjs',
    'npcstationduty.mjs',
    'npcstationdutyrefresh.mjs',
    'npcmobilityscheduler.mjs',
    'npcmobilityopportunities.mjs',
    'npcmobilityroutebinding.mjs',
    'npcmobilityexecutor.mjs',
    'npcrailtransfer.mjs',
    'npcmobilitypresentation.js',
    'npcmigration.mjs',
    'railpassengerpresentation.mjs',
    'railpassengers.mjs',
    'railservice.mjs',
  ];
  const contents = await Promise.all(pureModules.map(source));
  for (let index = 0; index < pureModules.length; index++) {
    assert.doesNotMatch(contents[index], /Math\.random\s*\(/,
      `${pureModules[index]} must remain deterministic`);
    assert.doesNotMatch(contents[index], /from\s+['"]three(?:\/[^'"]*)?['"]|import\s+\*\s+as\s+THREE/,
      `${pureModules[index]} must remain THREE-free`);
  }
});
