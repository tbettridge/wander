import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLivingWorldEventOnce,
  attachNpcSpatialState,
  createLivingWorldState,
  LivingWorldStateStore,
  normalizeLivingWorldFeatures,
  normalizeLivingWorldState,
  parseLivingWorldState,
  registerLivingWorldEntity,
  serializeLivingWorldState,
} from '../src/livingworldstate.mjs';

test('a stable world event applies exactly once', () => {
  const state = createLivingWorldState({ worldSeed: 17 });
  const event = { id: 'event:letter:delivered', type: 'delivery.completed', amount: 2 };
  const reduce = (draft, incoming) => {
    draft.projections.stationInventory.wren = {
      apples: (draft.projections.stationInventory.wren?.apples || 0) + incoming.amount,
    };
    return { stock: draft.projections.stationInventory.wren.apples };
  };
  const first = applyLivingWorldEventOnce(state, event, reduce);
  const duplicate = applyLivingWorldEventOnce(state, event, reduce);
  assert.equal(first.applied, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.projections.stationInventory.wren.apples, 2);
  assert.equal(state.events.length, 1);
});

test('a throwing reducer leaves the original state untouched', () => {
  const state = createLivingWorldState({ worldSeed: 9 });
  const before = structuredClone(state);
  assert.throws(() => applyLivingWorldEventOnce(
    state,
    { id: 'event:bad', type: 'bad' },
    (draft) => {
      draft.projections.letters.x = { ownerId: 'nobody' };
      throw new Error('reject');
    },
  ));
  assert.deepEqual(state, before);
});

test('state, entities, and effect receipts survive one atomic snapshot', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const store = new LivingWorldStateStore({ worldSeed: 41, storage });
  const state = store.load();
  registerLivingWorldEntity(state, { id: 'npc:wren:porter', kind: 'npc', homeKey: 'wren' });
  applyLivingWorldEventOnce(state, { id: 'event:one', type: 'test' }, (draft) => {
    draft.projections.assets.bridge = { condition: 'repaired' };
  });
  assert.equal(store.save(state), true);
  const restored = store.load();
  assert.equal(restored.entities['npc:wren:porter'].homeKey, 'wren');
  assert.equal(restored.projections.assets.bridge.condition, 'repaired');
  assert.ok(restored.effectReceipts['event:one']);
});

test('v5 starts with empty mobility collections and completed travel rollout enabled', () => {
  const state = createLivingWorldState();
  assert.equal(state.version, 5);
  assert.equal(state.npcMobilityRolloutVersion, 1);
  assert.deepEqual(state.itineraries, {});
  assert.deepEqual(state.railServices, {});
  assert.deepEqual(state.railManifests, {});
  for (const key of [
    'unifiedNpcMobilityEnabled', 'npcRailTravelEnabled', 'npcLeisureTravelEnabled',
  ]) assert.equal(state.features[key], true, `${key} must ship enabled`);
  assert.equal(state.features.npcMigrationEnabled, false,
    'changing an NPC residence remains an explicit rollout');
});

test('pre-rollout saves enable NPC train travel once and preserve later opt-outs', () => {
  const migrated = normalizeLivingWorldState({
    version: 5,
    features: {
      unifiedNpcMobilityEnabled: false,
      npcRailTravelEnabled: false,
      npcLeisureTravelEnabled: false,
    },
  });
  assert.equal(migrated.npcMobilityRolloutVersion, 1);
  assert.equal(migrated.features.unifiedNpcMobilityEnabled, true);
  assert.equal(migrated.features.npcRailTravelEnabled, true);
  assert.equal(migrated.features.npcLeisureTravelEnabled, true);

  const optedOut = normalizeLivingWorldState({
    ...migrated,
    features: {
      ...migrated.features,
      unifiedNpcMobilityEnabled: false,
      npcRailTravelEnabled: false,
      npcLeisureTravelEnabled: false,
    },
  });
  assert.equal(optedOut.features.unifiedNpcMobilityEnabled, false);
  assert.equal(optedOut.features.npcRailTravelEnabled, false);
  assert.equal(optedOut.features.npcLeisureTravelEnabled, false);
});

test('narrative continuity state and feature dependencies survive compact persistence', () => {
  const state = createLivingWorldState({ worldSeed: 52 });
  assert.deepEqual(state.narrativeFacts, {});
  assert.deepEqual(state.narrativeFactReceipts, {});
  assert.equal(state.features.npcCommunityKnowledgeEnabled, true);
  assert.equal(state.features.npcNarrativeGraphRetrievalEnabled, true);
  assert.equal(state.features.npcNarrativeFactPropagationEnabled, true);

  state.narrativeFacts['narrative-fact:mara:bees'] = {
    id: 'narrative-fact:mara:bees', subjectId: 'npc:mara',
    statement: 'Mara keeps bees behind her cottage.', status: 'active',
  };
  state.narrativeFactReceipts['receipt:conversation:1:mara:bees'] = {
    id: 'receipt:conversation:1:mara:bees', factId: 'narrative-fact:mara:bees',
  };
  const restored = parseLivingWorldState(serializeLivingWorldState(state), { worldSeed: 52 });
  assert.equal(restored.narrativeFacts['narrative-fact:mara:bees'].subjectId, 'npc:mara');
  assert.equal(restored.narrativeFactReceipts['receipt:conversation:1:mara:bees'].factId,
    'narrative-fact:mara:bees');

  const noCommunity = normalizeLivingWorldFeatures({
    npcCommunityKnowledgeEnabled: false,
    npcNarrativeGraphRetrievalEnabled: true,
    npcNarrativeFactPropagationEnabled: true,
  });
  assert.equal(noCommunity.npcNarrativeGraphRetrievalEnabled, false);
  assert.equal(noCommunity.npcNarrativeFactPropagationEnabled, false);
  const noSocialMemory = normalizeLivingWorldFeatures({
    socialMemoryEnabled: false,
    npcNarrativeFactPropagationEnabled: true,
  });
  assert.equal(noSocialMemory.npcNarrativeFactPropagationEnabled, false);
});

test('validated NPC spatial state persists without overwriting rollback keys', () => {
  const state = createLivingWorldState();
  registerLivingWorldEntity(state, {
    id: 'npc:resident:1', kind: 'npc', homeKey: 'legacy:home',
    locationKey: 'legacy:street', inTransit: false,
  });
  const entity = attachNpcSpatialState(state, 'npc:resident:1', {
    residence: {
      originSettlementId: 'settlement:wren',
      residenceSettlementId: 'settlement:wren',
      householdId: 'household:wren:1',
      homeBuildingId: 'building:wren:4',
    },
    location: {
      kind: 'station-platform', stationId: 'station:wren',
      platformId: 'platform:wren:a', waitAnchorId: 'wait:wren:a:2',
    },
  });
  entity.activity = { kind: 'station-wait', sinceHour: 12 };
  entity.itineraryId = 'itinerary:npc:resident:1:1';
  state.itineraries[entity.itineraryId] = { id: entity.itineraryId, actorId: entity.id };
  state.railManifests['manifest:run:7'] = { id: 'manifest:run:7', runId: 'run:7' };

  assert.equal(entity.homeKey, 'legacy:home');
  assert.equal(entity.locationKey, 'legacy:street');
  const serialized = serializeLivingWorldState(state);
  const compact = JSON.parse(serialized);
  assert.equal(compact.storageFormat, 'compact-v5');
  assert.deepEqual(compact.entities[entity.id].slice(13), [
    entity.residence, entity.location, entity.activity, entity.itineraryId,
  ]);
  const restored = parseLivingWorldState(serialized);
  assert.deepEqual(restored.entities[entity.id].residence, entity.residence);
  assert.deepEqual(restored.entities[entity.id].location, entity.location);
  assert.deepEqual(restored.entities[entity.id].activity, entity.activity);
  assert.equal(restored.entities[entity.id].itineraryId, entity.itineraryId);
  assert.equal(restored.entities[entity.id].homeKey, 'legacy:home');
  assert.equal(restored.entities[entity.id].locationKey, 'legacy:street');
  assert.equal(restored.itineraries[entity.itineraryId].actorId, entity.id);
  assert.equal(restored.railManifests['manifest:run:7'].runId, 'run:7');
});

test('spatial attachment rejects malformed, unknown, and non-NPC targets', () => {
  const state = createLivingWorldState();
  registerLivingWorldEntity(state, { id: 'player:local', kind: 'player' });
  registerLivingWorldEntity(state, { id: 'npc:one', kind: 'npc', homeKey: 'legacy:home' });
  const valid = {
    residence: {
      originSettlementId: 'settlement:a', residenceSettlementId: 'settlement:a',
      householdId: null, homeBuildingId: null,
    },
    location: { kind: 'world-site', siteId: 'site:a' },
  };
  assert.throws(() => attachNpcSpatialState(state, 'npc:missing', valid), RangeError);
  assert.throws(() => attachNpcSpatialState(state, 'player:local', valid), TypeError);
  assert.throws(() => attachNpcSpatialState(state, 'npc:one', {
    ...valid, location: { kind: 'regional-edge', edgeId: 'edge:a', fromKey: 'a', toKey: 'b', progress: 2 },
  }), TypeError);
  assert.equal(state.entities['npc:one'].residence, undefined);
  assert.equal(state.entities['npc:one'].homeKey, 'legacy:home');
});

test('compact v2, v3, and v4 remain readable without invented residence', () => {
  const legacy = [
    {
      storageFormat: 'compact-v2', version: 2,
      entities: { 'npc:v2': { id: 'npc:v2', kind: 'npc', homeKey: 'ambiguous:v2' } },
    },
    {
      storageFormat: 'compact-v3', version: 3,
      entities: { 'npc:v3': ['npc:v3', 'npc', 'Three', 'resident', null, 'ambiguous:v3', 'place:v3'] },
    },
    {
      storageFormat: 'compact-v4', version: 4,
      entities: { 'npc:v4': ['npc:v4', 'npc', 'Four', 'porter', 'station:4', 'ambiguous:v4', 'place:v4'] },
    },
  ];
  for (const snapshot of legacy) {
    const state = normalizeLivingWorldState(snapshot);
    const entity = Object.values(state.entities)[0];
    assert.equal(state.version, 5);
    assert.match(entity.homeKey, /^ambiguous:/);
    assert.equal(entity.residence, undefined, `${snapshot.storageFormat} must not guess a residence`);
    assert.equal(entity.location, undefined, `${snapshot.storageFormat} must not guess a location kind`);
  }
});

test('mobility feature dependencies fail closed', () => {
  const orphanedDependents = normalizeLivingWorldFeatures({
    unifiedNpcMobilityEnabled: false,
    npcRailTravelEnabled: true,
    npcLeisureTravelEnabled: true,
    npcMigrationEnabled: true,
  });
  assert.equal(orphanedDependents.npcRailTravelEnabled, false);
  assert.equal(orphanedDependents.npcLeisureTravelEnabled, false);
  assert.equal(orphanedDependents.npcMigrationEnabled, false);

  const enabled = normalizeLivingWorldFeatures({
    unifiedNpcMobilityEnabled: true,
    npcRailTravelEnabled: true,
    npcLeisureTravelEnabled: true,
    npcMigrationEnabled: true,
  });
  assert.equal(enabled.npcRailTravelEnabled, true);
  assert.equal(enabled.npcLeisureTravelEnabled, true);
  assert.equal(enabled.npcMigrationEnabled, true);

  const noHouseholds = normalizeLivingWorldFeatures({
    householdsEnabled: false,
    unifiedNpcMobilityEnabled: true,
    npcRailTravelEnabled: true,
  });
  assert.equal(noHouseholds.unifiedNpcMobilityEnabled, false);
  assert.equal(noHouseholds.npcRailTravelEnabled, false);
});

test('v5 imports the deployed legacy key without overwriting rollback data', () => {
  const values = new Map();
  const legacyKey = 'wander.livingWorld.state.v1.73';
  const legacyRaw = JSON.stringify({
    storageFormat: 'compact-v4', version: 4, worldSeed: 73,
    entities: { 'npc:legacy': ['npc:legacy', 'npc', 'Legacy Resident'] },
  });
  values.set(legacyKey, legacyRaw);
  const store = new LivingWorldStateStore({
    worldSeed: 73,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  const state = store.load();
  assert.equal(state.entities['npc:legacy'].name, 'Legacy Resident');
  assert.equal(store.save(state), true);
  assert.equal(values.get(legacyKey), legacyRaw, 'the old reader keeps its untouched rollback snapshot');
  assert.ok(values.get('wander.livingWorld.state.v5.73')?.includes('compact-v5'));
});

test('a later rollback-era legacy save is re-imported instead of shadowed by v5', () => {
  const values = new Map();
  const legacyKey = 'wander.livingWorld.state.v1.74';
  const forwardKey = 'wander.livingWorld.state.v5.74';
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const legacySnapshot = (name, revision) => JSON.stringify({
    storageFormat: 'compact-v4', version: 4, worldSeed: 74, revision,
    entities: { 'npc:rollback': ['npc:rollback', 'npc', name] },
  });
  const firstLegacy = legacySnapshot('Before Rollback', 1);
  values.set(legacyKey, firstLegacy);

  const firstUpgrade = new LivingWorldStateStore({ worldSeed: 74, storage });
  const imported = firstUpgrade.load();
  assert.equal(imported.entities['npc:rollback'].name, 'Before Rollback');
  assert.equal(firstUpgrade.save(imported), true);
  assert.ok(values.has(forwardKey));

  const rollbackSave = legacySnapshot('Changed During Rollback', 2);
  values.set(legacyKey, rollbackSave);
  const secondUpgrade = new LivingWorldStateStore({ worldSeed: 74, storage });
  const reconciled = secondUpgrade.load();
  assert.equal(reconciled.entities['npc:rollback'].name, 'Changed During Rollback');
  assert.equal(reconciled.revision, 2);
  assert.equal(secondUpgrade.save(reconciled), true);
  assert.equal(values.get(legacyKey), rollbackSave,
    'forward reconciliation must still leave the rollback reader data untouched');

  const stableReload = new LivingWorldStateStore({ worldSeed: 74, storage }).load();
  assert.equal(stableReload.entities['npc:rollback'].name, 'Changed During Rollback');
});

test('a malformed changed rollback key falls back to the intact v5 snapshot', () => {
  const values = new Map();
  const legacyKey = 'wander.livingWorld.state.v1.75';
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  values.set(legacyKey, JSON.stringify({
    storageFormat: 'compact-v4', version: 4, worldSeed: 75,
    entities: { 'npc:intact': ['npc:intact', 'npc', 'Forward Resident'] },
  }));
  const first = new LivingWorldStateStore({ worldSeed: 75, storage });
  const state = first.load();
  assert.equal(first.save(state), true);

  values.set(legacyKey, '{malformed rollback save');
  const recovered = new LivingWorldStateStore({ worldSeed: 75, storage }).load();
  assert.equal(recovered.entities['npc:intact'].name, 'Forward Resident');
});
