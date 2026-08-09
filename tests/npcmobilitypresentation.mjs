import assert from 'node:assert/strict';
import test from 'node:test';
import { NpcMobilityPresentationReconciler } from '../src/npcmobilitypresentation.js';

const residence = Object.freeze({
  originSettlementId: 'village:a', residenceSettlementId: 'village:a',
  householdId: 'household:a', homeBuildingId: 'building:a',
});

const trail = (progress = 0.25) => Object.freeze({
  kind: 'regional-edge', edgeId: 'edge:a-b', fromKey: 'a', toKey: 'b', progress,
});

function fixture(options = {}) {
  const state = {
    features: { unifiedNpcMobilityEnabled: true },
    entities: {
      'npc:a': { id: 'npc:a', kind: 'npc', residence, location: trail() },
    },
  };
  const events = { creates: [], updates: [], removals: [], disposals: [] };
  const identities = { 'npc:a': Object.freeze({ id: 'npc:a', name: 'Ada' }) };
  const reconciler = new NpcMobilityPresentationReconciler({
    stateProvider: () => state,
    identityProvider: (id) => identities[id],
    locationResolver: (location) => ({
      x: location.progress * 100, y: 2, z: 5, heading: 0.5, progress: location.progress,
    }),
    excludedActorIdsProvider: () => [],
    avatarFactory: ({ actorId }) => {
      events.creates.push(actorId);
      return {
        root: { removeFromParent: () => events.removals.push(actorId) },
        update: (input) => events.updates.push(input),
        dispose: () => events.disposals.push(actorId),
      };
    },
    cullRange: 80,
    ...options,
  });
  return { state, events, identities, reconciler };
}

test('creates once, updates deterministically, and removes an ineligible actor once', () => {
  const { state, events, reconciler } = fixture();
  assert.deepEqual(reconciler.update(0.1, { x: 0, y: 0, z: 0 }), {
    active: 1, created: 1, updated: 1, removed: 0,
  });
  reconciler.update(0.2, { x: 0, y: 0, z: 0 });
  assert.deepEqual(events.creates, ['npc:a']);
  assert.equal(events.updates.length, 2);
  state.entities['npc:a'].location = { kind: 'building', settlementId: 'village:a', buildingId: 'building:a', nodeId: null };
  assert.equal(reconciler.update(0.1, { x: 0, z: 0 }).removed, 1);
  reconciler.update(0.1, { x: 0, z: 0 });
  assert.deepEqual(events.removals, ['npc:a']);
  assert.deepEqual(events.disposals, ['npc:a']);
});

test('canonical progress drives resolved walking updates with dt and distance', () => {
  const { state, events, reconciler } = fixture();
  reconciler.update(0.125, { x: 20, y: 4, z: 5 });
  state.entities['npc:a'].location = trail(0.6);
  reconciler.update(0.25, { x: 20, y: 4, z: 5 });
  assert.deepEqual(events.updates.map(({ resolved, dt, distance }) => ({ resolved, dt, distance })), [
    { resolved: { x: 25, y: 2, z: 5, heading: 0.5, progress: 0.25 }, dt: 0.125, distance: 5 },
    { resolved: { x: 60, y: 2, z: 5, heading: 0.5, progress: 0.6 }, dt: 0.25, distance: 40 },
  ]);
});

test('renderer ownership exclusions prevent duplicates and remove existing walkers', () => {
  const excluded = new Set(['npc:a']);
  const { events, reconciler } = fixture({ excludedActorIdsProvider: () => excluded });
  assert.equal(reconciler.update(0.1, { x: 0, z: 0 }).active, 0);
  assert.equal(events.creates.length, 0);
  excluded.clear();
  reconciler.update(0.1, { x: 0, z: 0 });
  excluded.add('npc:a');
  reconciler.update(0.1, { x: 0, z: 0 });
  assert.deepEqual(events.creates, ['npc:a']);
  assert.deepEqual(events.disposals, ['npc:a']);
});

test('culling removes only presentation and permits deterministic re-entry', () => {
  const { state, events, reconciler } = fixture();
  const before = structuredClone(state);
  reconciler.update(0.1, { x: 200, z: 0 });
  assert.equal(events.creates.length, 0);
  reconciler.update(0.1, { x: 0, z: 0 });
  reconciler.update(0.1, { x: 200, z: 0 });
  reconciler.update(0.1, { x: 0, z: 0 });
  assert.deepEqual(events.creates, ['npc:a', 'npc:a']);
  assert.deepEqual(events.disposals, ['npc:a']);
  assert.deepEqual(state, before, 'culling must not delete or move canonical state');
});

test('settlement-node is opt-in through the location resolver', () => {
  const locationResolver = (location) => location.kind === 'settlement-node'
    ? { x: 3, y: 0, z: 4, heading: 1, progress: 0.5 } : null;
  const { state, reconciler } = fixture({ locationResolver });
  state.entities['npc:a'].location = {
    kind: 'settlement-node', settlementId: 'village:a', nodeId: 'node:lane',
  };
  assert.equal(reconciler.update(0.1, { x: 0, z: 0 }).active, 1);
});

test('malformed resolver and identity results fail closed per actor', () => {
  const { state, events, reconciler } = fixture({
    identityProvider: (id) => id === 'npc:a' ? { id: 'wrong-person' } : { id },
    locationResolver: () => ({ x: NaN, y: 0, z: 0, heading: 0, progress: 0 }),
  });
  state.entities['npc:b'] = { id: 'npc:b', kind: 'npc', residence, location: trail(0.1) };
  assert.equal(reconciler.update(0.1, { x: 0, z: 0 }).active, 0);
  assert.equal(events.creates.length, 0);
});

test('provider and presentation failures are isolated without leaving ownership', () => {
  const { state, events, reconciler } = fixture({
    identityProvider: (id) => {
      if (id === 'npc:a') throw new Error('identity unavailable');
      return { id };
    },
  });
  state.entities['npc:b'] = { id: 'npc:b', kind: 'npc', residence, location: trail(0.1) };
  const first = reconciler.update(0.1, { x: 0, z: 0 });
  assert.equal(first.active, 1);
  assert.deepEqual(events.creates, ['npc:b']);

  let ownershipAvailable = true;
  const globalFailure = fixture({
    excludedActorIdsProvider: () => {
      if (!ownershipAvailable) throw new Error('owners unavailable');
      return [];
    },
  });
  globalFailure.reconciler.update(0.1, { x: 0, z: 0 });
  ownershipAvailable = false;
  globalFailure.reconciler.update(0.1, { x: 0, z: 0 });
  assert.equal(globalFailure.reconciler.materializedActorIds().length, 0);
  assert.deepEqual(globalFailure.events.disposals, ['npc:a']);
});

test('factory and per-frame presentation failures fail closed per actor', () => {
  const state = {
    features: { unifiedNpcMobilityEnabled: true },
    entities: {
      'npc:a': { id: 'npc:a', kind: 'npc', residence, location: trail(0.1) },
      'npc:b': { id: 'npc:b', kind: 'npc', residence, location: trail(0.2) },
    },
  };
  const disposed = [];
  const reconciler = new NpcMobilityPresentationReconciler({
    stateProvider: () => state,
    identityProvider: (id) => ({ id }),
    locationResolver: (location) => ({
      x: location.progress * 10, y: 0, z: 0, heading: 0, progress: location.progress,
    }),
    excludedActorIdsProvider: () => [],
    avatarFactory: ({ actorId }) => {
      if (actorId === 'npc:a') throw new Error('asset unavailable');
      return {
        root: { removeFromParent() {} },
        update: () => { throw new Error('animation unavailable'); },
        dispose: () => disposed.push(actorId),
      };
    },
  });
  assert.deepEqual(reconciler.update(0.1, { x: 0, z: 0 }), {
    active: 0, created: 1, updated: 0, removed: 1,
  });
  assert.deepEqual(disposed, ['npc:b']);
});

test('feature disabling and disposal remove presentations cleanly and exactly once', () => {
  const { state, events, reconciler } = fixture();
  reconciler.update(0.1, { x: 0, z: 0 });
  state.features.unifiedNpcMobilityEnabled = false;
  reconciler.update(0.1, { x: 0, z: 0 });
  assert.deepEqual(events.disposals, ['npc:a']);
  state.features.unifiedNpcMobilityEnabled = true;
  reconciler.update(0.1, { x: 0, z: 0 });
  reconciler.setEnabled(false);
  reconciler.setEnabled(false);
  reconciler.dispose();
  reconciler.dispose();
  assert.deepEqual(events.disposals, ['npc:a', 'npc:a']);
  assert.equal(reconciler.update(0.1, { x: 0, z: 0 }).active, 0);
});

test('reconciliation does not mutate entities, locations, residences, or identities', () => {
  const { state, identities, reconciler } = fixture();
  const beforeState = structuredClone(state);
  const beforeIdentities = structuredClone(identities);
  reconciler.update(0.1, { x: 0, y: 0, z: 0 });
  assert.deepEqual(state, beforeState);
  assert.deepEqual(identities, beforeIdentities);
});
