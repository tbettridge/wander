// Headless activation for the people who belong to one settlement.
//
// Settlement geometry may stream out; households, work, identity and current
// location must not. This module deliberately accepts an already-generated
// plan and plain living-world state, so it can run in tests, migrations and
// cold simulation without importing THREE or a renderer.

import { generateHouseholds } from './npchousehold.mjs';
import { assignWorkplacesAndRoutines } from './npcroutine.mjs';
import { attachNpcSpatialState } from './livingworldstate.mjs';
import {
  createNpcLocation,
  createNpcResidence,
  normalizeNpcLocation,
  normalizeNpcResidence,
} from './npclocation.mjs';

export const RESIDENT_REGISTRY_MODE = Object.freeze({
  runtime: 'runtime',
  migration: 'migration',
  preview: 'preview',
});

/**
 * Activate a settlement's deterministic residents without loading geometry.
 *
 * Runtime activation is feature-gated. Migration explicitly upgrades the live
 * state while the gate is off; preview performs the same work on a private
 * clone and leaves the supplied state untouched.
 */
export function activateSettlementResidents(plan, state, {
  mode = RESIDENT_REGISTRY_MODE.runtime,
  residentsPerDwelling = 2,
} = {}) {
  validateInputs(plan, state, mode);
  if (mode === RESIDENT_REGISTRY_MODE.runtime && !state.features?.unifiedNpcMobilityEnabled) {
    return emptySummary(plan.site.id, 'feature-disabled');
  }

  const targetState = mode === RESIDENT_REGISTRY_MODE.preview ? clonePlain(state) : state;
  const households = generateHouseholds(plan, targetState, { residentsPerDwelling });
  if (targetState.features?.workRoutinesEnabled !== false) {
    assignWorkplacesAndRoutines(plan, targetState);
  }
  const homes = new Map(plan.buildings.map((building) => [building.id, building]));

  for (const household of households) {
    const home = homes.get(household.homeBuildingId);
    if (!home) throw new RangeError(`Household ${household.id} has no building in ${plan.site.id}.`);
    for (const actorId of household.memberIds) {
      const entity = targetState.entities[actorId];
      if (!entity || entity.kind !== 'npc') {
        throw new TypeError(`Household member ${actorId} is not an NPC.`);
      }
      // Existing canonical values are authoritative. In particular, retaining
      // a train-seat or regional-edge location prevents streaming activation
      // from dragging an away resident back to their house.
      const residence = normalizeNpcResidence(entity.residence) || createNpcResidence({
        originSettlementId: plan.site.id,
        residenceSettlementId: plan.site.id,
        householdId: household.id,
        homeBuildingId: household.homeBuildingId,
      });
      const location = normalizeNpcLocation(entity.location) || createNpcLocation('building', {
        settlementId: plan.site.id,
        buildingId: household.homeBuildingId,
        nodeId: home.rooms?.[0]?.id ?? null,
      });
      attachNpcSpatialState(targetState, actorId, { residence, location });
    }
  }

  return populationSummary(plan.site.id, targetState, households, {
    preview: mode === RESIDENT_REGISTRY_MODE.preview,
  });
}

function populationSummary(settlementId, state, households, { preview = false } = {}) {
  const residentIds = households.flatMap((household) => household.memberIds);
  const residentSet = new Set(residentIds);
  const residents = residentIds.map((id) => {
    const entity = state.entities[id];
    const household = state.households[entity.householdId];
    const atHome = entity.location?.kind === 'building'
      && entity.location.buildingId === household?.homeBuildingId;
    return Object.freeze({
      id,
      householdId: entity.householdId,
      homeBuildingId: household?.homeBuildingId ?? null,
      workplaceId: entity.workplaceId ?? null,
      locationKind: entity.location?.kind ?? null,
      away: !atHome,
    });
  });
  const workplaceCount = Object.values(state.workplaces || {})
    .filter((workplace) => workplace.settlementId === settlementId).length;
  const routineCount = Object.values(state.routines || {})
    .filter((routine) => residentSet.has(routine.actorId)).length;
  return Object.freeze({
    settlementId,
    activated: true,
    reason: null,
    preview,
    householdCount: households.length,
    residentCount: residents.length,
    workplaceCount,
    routineCount,
    residentIds: Object.freeze(residentIds.slice()),
    residents: Object.freeze(residents),
  });
}

function emptySummary(settlementId, reason) {
  return Object.freeze({
    settlementId,
    activated: false,
    reason,
    preview: false,
    householdCount: 0,
    residentCount: 0,
    workplaceCount: 0,
    routineCount: 0,
    residentIds: Object.freeze([]),
    residents: Object.freeze([]),
  });
}

function validateInputs(plan, state, mode) {
  if (!plan?.site?.id || !Array.isArray(plan.buildings)) {
    throw new TypeError('A generated settlement plan is required.');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('A living-world state is required.');
  }
  if (!Object.values(RESIDENT_REGISTRY_MODE).includes(mode)) {
    throw new TypeError(`Unknown resident-registry mode: ${mode}.`);
  }
}

function clonePlain(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
