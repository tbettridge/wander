import test from 'node:test';
import assert from 'node:assert/strict';
import { settlementForCell } from '../src/settlementplacement.mjs';
import { createSettlementPlan } from '../src/settlementplan.mjs';
import {
  attachNpcSpatialState,
  createLivingWorldState,
  registerLivingWorldEntity,
  setLivingWorldFeatures,
} from '../src/livingworldstate.mjs';
import {
  activateSettlementResidents,
  RESIDENT_REGISTRY_MODE,
} from '../src/npcresidenceregistry.mjs';

const world = {
  seed: 707,
  height(x, z) { return 18 + Math.sin(x * 0.0003) + Math.cos(z * 0.0002); },
  biomeAt(x, z) { return { h: this.height(x, z), slope: 0.04, m: 0.58, id: 'grassland' }; },
  riverAt() { return { wet: false }; },
};

function fixturePlan() {
  for (let j = -5; j <= 5; j++) for (let i = -5; i <= 5; i++) {
    const site = settlementForCell(world, i, j, world.seed);
    if (site) return createSettlementPlan(site, { heightAt: world.height.bind(world) });
  }
  throw new Error('test corpus produced no settlement');
}

function enabledState() {
  const state = createLivingWorldState({ worldSeed: world.seed });
  setLivingWorldFeatures(state, { unifiedNpcMobilityEnabled: true });
  return state;
}

test('a generated settlement plan activates a real population headlessly', () => {
  const plan = fixturePlan();
  const state = enabledState();
  const summary = activateSettlementResidents(plan, state);
  assert.equal(summary.activated, true);
  assert.ok(summary.householdCount > 0);
  assert.ok(summary.residentCount >= summary.householdCount);
  assert.equal(summary.residentIds.length, new Set(summary.residentIds).size);
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.residents), true);
  for (const resident of summary.residents) {
    const entity = state.entities[resident.id];
    assert.equal(entity.kind, 'npc');
    assert.equal(entity.residence.originSettlementId, plan.site.id);
    assert.equal(entity.residence.residenceSettlementId, plan.site.id);
    assert.equal(entity.residence.householdId, entity.householdId);
    assert.equal(entity.location.kind, 'building');
    assert.equal(entity.location.buildingId, entity.residence.homeBuildingId);
  }
});

test('repeated activation preserves identity, social state, and mutable work state', () => {
  const plan = fixturePlan();
  const state = enabledState();
  const first = activateSettlementResidents(plan, state);
  const actorId = first.residentIds[0];
  const entity = state.entities[actorId];
  const household = state.households[entity.householdId];
  const relationshipKey = Object.keys(state.relationships)
    .find((key) => state.relationships[key].ownerId === actorId);
  const workplace = Object.values(state.workplaces)
    .find((entry) => entry.settlementId === plan.site.id);
  state.memories[actorId] = [{ id: 'memory:kept', summary: 'A day by the river.' }];
  household.access.guests = 'trusted';
  if (relationshipKey) state.relationships[relationshipKey].trust = 0.13;
  if (workplace) {
    workplace.inventory.keptStock = 37;
    workplace.serviceLevel = 0.42;
  }
  const idsBefore = Object.keys(state.entities).sort();
  const revisionBefore = state.revision;

  const second = activateSettlementResidents(plan, state);
  assert.deepEqual(second.residentIds, first.residentIds);
  assert.deepEqual(Object.keys(state.entities).sort(), idsBefore);
  assert.equal(state.memories[actorId][0].id, 'memory:kept');
  assert.equal(household.access.guests, 'trusted');
  if (relationshipKey) assert.equal(state.relationships[relationshipKey].trust, 0.13);
  if (workplace) {
    assert.equal(workplace.inventory.keptStock, 37);
    assert.equal(workplace.serviceLevel, 0.42);
  }
  assert.equal(state.revision, revisionBefore, 'an unchanged activation is not a spatial mutation');
});

test('activation never drags an away resident out of a train seat', () => {
  const plan = fixturePlan();
  const state = enabledState();
  const first = activateSettlementResidents(plan, state);
  const actorId = first.residentIds[0];
  const residence = state.entities[actorId].residence;
  attachNpcSpatialState(state, actorId, {
    residence,
    location: {
      kind: 'train-seat', runId: 'run:day:18',
      carriageId: 'carriage:1', seatId: 'seat:2',
    },
  });
  const legacyLocationBefore = state.entities[actorId].locationKey;

  const second = activateSettlementResidents(plan, state);
  assert.deepEqual(state.entities[actorId].location, {
    kind: 'train-seat', runId: 'run:day:18', carriageId: 'carriage:1', seatId: 'seat:2',
  });
  assert.equal(state.entities[actorId].locationKey, legacyLocationBefore);
  assert.equal(second.residents.find((resident) => resident.id === actorId).away, true);
});

test('disabled runtime activation is a rollback-safe no-op', () => {
  const plan = fixturePlan();
  const state = createLivingWorldState({ worldSeed: world.seed });
  setLivingWorldFeatures(state, { unifiedNpcMobilityEnabled: false });
  const before = structuredClone(state);
  const summary = activateSettlementResidents(plan, state);
  assert.equal(summary.activated, false);
  assert.equal(summary.reason, 'feature-disabled');
  assert.deepEqual(state, before);
});

test('migration and preview explicitly bypass the runtime feature gate', () => {
  const plan = fixturePlan();
  const migrationState = createLivingWorldState({ worldSeed: world.seed });
  setLivingWorldFeatures(migrationState, { unifiedNpcMobilityEnabled: false });
  const migrated = activateSettlementResidents(plan, migrationState, {
    mode: RESIDENT_REGISTRY_MODE.migration,
  });
  assert.equal(migrated.activated, true);
  assert.ok(Object.keys(migrationState.entities).length > 0);

  const previewState = createLivingWorldState({ worldSeed: world.seed });
  setLivingWorldFeatures(previewState, { unifiedNpcMobilityEnabled: false });
  const before = structuredClone(previewState);
  const preview = activateSettlementResidents(plan, previewState, {
    mode: RESIDENT_REGISTRY_MODE.preview,
  });
  assert.equal(preview.activated, true);
  assert.equal(preview.preview, true);
  assert.ok(preview.residentCount > 0);
  assert.deepEqual(previewState, before, 'preview must not mutate the supplied state');
});

test('first household activation reconciles a pre-existing cold traveller without overwriting it', () => {
  const plan = fixturePlan();
  const preview = activateSettlementResidents(plan, createLivingWorldState({ worldSeed: world.seed }), {
    mode: RESIDENT_REGISTRY_MODE.preview,
  });
  const cold = preview.residents[0];
  const state = enabledState();
  registerLivingWorldEntity(state, {
    id: cold.id, kind: 'npc', name: 'Cold Traveller', mobilityNote: 'preserve-me',
  });
  attachNpcSpatialState(state, cold.id, {
    residence: {
      originSettlementId: plan.site.id,
      residenceSettlementId: plan.site.id,
      householdId: cold.householdId,
      homeBuildingId: cold.homeBuildingId,
    },
    location: {
      kind: 'train-seat', runId: 'rail-run:regional:2:4',
      carriageId: 'carriage:0', seatId: 'seat:1',
    },
  });

  activateSettlementResidents(plan, state);
  const entity = state.entities[cold.id];
  assert.equal(entity.mobilityNote, 'preserve-me');
  assert.equal(entity.location.kind, 'train-seat');
  assert.equal(entity.location.runId, 'rail-run:regional:2:4');
  assert.equal(entity.householdId, cold.householdId);
});
