// Deterministic station-duty projection for canonical settlement residents.
//
// This module creates no people and renders nothing. It selects existing local
// residents for quiet station work/loiter roles, then publishes their activity
// and canonical platform location through the living-world spatial contract.

import { attachNpcSpatialState } from './livingworldstate.mjs';
import { normalizeNpcLocation, normalizeNpcResidence } from './npclocation.mjs';
import {
  selectMobilityCandidates,
  stationPopulationTarget,
} from './npcmobilitydemand.mjs';

export const STATION_DUTY_SLOTS = Object.freeze([
  Object.freeze({ slotKey: 'keeper', role: 'station keeper' }),
  Object.freeze({ slotKey: 'porter', role: 'railway porter' }),
  Object.freeze({ slotKey: 'local', role: 'local resident' }),
  Object.freeze({ slotKey: 'vendor', role: 'platform vendor' }),
]);

/**
 * Select an authored 0..4-person station roster from existing canonical people.
 * The mobility demand contract supplies daytime/night-time density; a shortage
 * remains visible rather than being filled with a synthetic actor.
 */
export function planStationDutyRoster({
  state,
  stationId,
  settlementId,
  residents,
  worldSeed = state?.worldSeed ?? 1,
  dayIndex = Math.floor((state?.clock?.worldHours ?? 0) / 24),
  hour = state?.clock?.worldHours ?? 12,
} = {}) {
  requireState(state);
  const station = requiredId(stationId, 'stationId');
  const settlement = requiredId(settlementId, 'settlementId');
  const demand = stationPopulationTarget({ worldSeed, stationId: station, dayIndex, hour });
  const candidates = uniqueResidentIds(residents)
    .map((personId) => state.entities?.[personId])
    .filter((entity) => eligibleResident(state, entity, settlement, station))
    .map((entity) => ({ personId: entity.id }));
  const selected = selectMobilityCandidates(candidates, demand.target, {
    worldSeed,
    demandKey: `station-duty:${station}:${demand.dayIndex}:${demand.hourBucket}`,
  });
  const assignments = selected.map((candidate, index) => {
    const slot = STATION_DUTY_SLOTS[index];
    return Object.freeze({
      personId: candidate.personId,
      stationId: station,
      settlementId: settlement,
      slotKey: slot.slotKey,
      role: slot.role,
      location: platformLocation(station, slot.slotKey),
    });
  });
  return Object.freeze({
    stationId: station,
    settlementId: settlement,
    dayIndex: demand.dayIndex,
    hourBucket: demand.hourBucket,
    daytime: demand.daytime,
    target: demand.target,
    shortage: Math.max(0, demand.target - assignments.length),
    assignments: Object.freeze(assignments),
  });
}

/**
 * Publish a planned roster exactly once. Reapplying an unchanged roster leaves
 * revision and entities untouched. All assignments are validated before the
 * first mutation so a malformed roster cannot partially move residents.
 */
export function applyStationDutyRoster(state, roster) {
  requireState(state);
  if (state.features?.unifiedNpcMobilityEnabled !== true) {
    throw new Error('Unified NPC mobility is disabled.');
  }
  const assignments = validateRoster(state, roster);
  const selectedIds = new Set(assignments.map((assignment) => assignment.personId));
  const releaseCandidates = Object.values(state.entities || {}).filter((entity) => (
    entity?.kind === 'npc'
    && entity.activity?.kind === 'station-duty'
    && entity.activity.stationId === roster.stationId
    && !selectedIds.has(entity.id)
  ));
  const conflictedIds = [];
  const releases = releaseCandidates.flatMap((entity) => {
    const location = normalizeNpcLocation(entity.location);
    const committed = Object.values(state.commitments || {}).some((commitment) => (
      commitment?.actorId === entity.id
      && !['resolved', 'failed'].includes(commitment.state)
    ));
    // Activity is only a projection. A newer itinerary/rail transition may
    // have moved canonical location before it replaced the old duty label; in
    // that interleaving, location truth wins and must never be teleported home.
    if (!location || location.kind !== 'station-platform'
      || location.stationId !== roster.stationId
      || entity.itineraryId || entity.inTransit || committed) {
      conflictedIds.push(entity.id);
      return [];
    }
    const residence = normalizeNpcResidence(entity.residence);
    if (!residence || residence.residenceSettlementId !== roster.settlementId
      || !residence.homeBuildingId) {
      throw new TypeError(`Station duty resident ${entity.id} cannot return to a canonical home.`);
    }
    return [{
      entity,
      location: {
        kind: 'building',
        settlementId: residence.residenceSettlementId,
        buildingId: residence.homeBuildingId,
      },
    }];
  });
  const changedIds = [];
  const unchangedIds = [];
  for (const assignment of assignments) {
    const entity = state.entities[assignment.personId];
    const nextActivity = {
      kind: 'station-duty',
      stationId: assignment.stationId,
      slotKey: assignment.slotKey,
      role: assignment.role,
    };
    const before = JSON.stringify([entity.location, entity.activity]);
    attachNpcSpatialState(state, entity.id, {
      residence: entity.residence,
      location: assignment.location,
    });
    if (JSON.stringify(entity.activity ?? null) !== JSON.stringify(nextActivity)) {
      entity.activity = nextActivity;
      state.revision = nonNegativeInteger(state.revision) + 1;
    }
    if (before === JSON.stringify([entity.location, entity.activity])) unchangedIds.push(entity.id);
    else changedIds.push(entity.id);
  }
  const releasedIds = [];
  for (const release of releases) {
    const { entity } = release;
    attachNpcSpatialState(state, entity.id, {
      residence: entity.residence,
      location: release.location,
    });
    entity.activity = null;
    state.revision = nonNegativeInteger(state.revision) + 1;
    releasedIds.push(entity.id);
  }
  return Object.freeze({
    stationId: roster.stationId,
    applied: changedIds.length > 0 || releasedIds.length > 0,
    changedIds: Object.freeze(changedIds),
    unchangedIds: Object.freeze(unchangedIds),
    releasedIds: Object.freeze(releasedIds),
    conflictedIds: Object.freeze(conflictedIds.sort()),
    assignments: Object.freeze(assignments.map((assignment) => Object.freeze({ ...assignment }))),
  });
}

function validateRoster(state, roster) {
  const station = requiredId(roster?.stationId, 'roster.stationId');
  const settlement = requiredId(roster?.settlementId, 'roster.settlementId');
  if (!Array.isArray(roster.assignments)) throw new TypeError('Station duty assignments are required.');
  if (roster.assignments.length > STATION_DUTY_SLOTS.length) {
    throw new RangeError('Station duty roster exceeds authored slot capacity.');
  }
  const people = new Set();
  const slots = new Set();
  return roster.assignments.map((input) => {
    const personId = requiredId(input?.personId, 'assignment.personId');
    const slotKey = requiredId(input?.slotKey, 'assignment.slotKey');
    const slot = STATION_DUTY_SLOTS.find((candidate) => candidate.slotKey === slotKey);
    if (!slot || input.role !== slot.role) throw new TypeError(`Invalid station duty slot ${slotKey}.`);
    if (input.stationId !== station || input.settlementId !== settlement) {
      throw new TypeError('Station duty assignment does not match its roster.');
    }
    if (people.has(personId)) throw new TypeError(`Duplicate station duty resident ${personId}.`);
    if (slots.has(slotKey)) throw new TypeError(`Duplicate station duty slot ${slotKey}.`);
    people.add(personId);
    slots.add(slotKey);
    const entity = state.entities?.[personId];
    if (!eligibleResident(state, entity, settlement, station)) {
      throw new TypeError(`Station duty resident ${personId} is not an eligible canonical resident.`);
    }
    const expectedLocation = platformLocation(station, slotKey);
    const suppliedLocation = normalizeNpcLocation(input.location);
    if (!suppliedLocation || JSON.stringify(suppliedLocation) !== JSON.stringify(expectedLocation)) {
      throw new TypeError(`Invalid station platform location for ${personId}.`);
    }
    return {
      personId,
      stationId: station,
      settlementId: settlement,
      slotKey,
      role: slot.role,
      location: expectedLocation,
    };
  });
}

function eligibleResident(state, entity, settlementId, stationId) {
  if (!entity || entity.kind !== 'npc' || entity.tombstone
    || entity.itineraryId || entity.inTransit) return false;
  const committed = Object.values(state.commitments || {}).some((commitment) => (
    commitment?.actorId === entity.id
    && !['resolved', 'failed'].includes(commitment.state)
  ));
  if (committed) return false;
  const residence = normalizeNpcResidence(entity.residence);
  const location = normalizeNpcLocation(entity.location);
  if (!residence || !location || residence.residenceSettlementId !== settlementId) return false;
  if (location.kind === 'building' || location.kind === 'settlement-node') {
    return location.settlementId === settlementId;
  }
  // Exact-once planning/application keeps current members of this same roster
  // eligible without treating residents assigned to another station as local.
  return location.kind === 'station-platform' && location.stationId === stationId
    && entity.activity?.kind === 'station-duty' && entity.activity.stationId === stationId;
}

function platformLocation(stationId, slotKey) {
  return Object.freeze({
    kind: 'station-platform',
    stationId,
    platformId: `${stationId}:platform:main`,
    waitAnchorId: `${stationId}:wait:${slotKey}`,
  });
}

function uniqueResidentIds(residents) {
  const ids = new Set();
  for (const resident of Array.isArray(residents) ? residents : []) {
    const id = typeof resident === 'string' ? resident : resident?.personId ?? resident?.id;
    if (typeof id === 'string' && id.length && id.trim() === id) ids.add(id);
  }
  return [...ids].sort();
}

function requireState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('Living-world state is required.');
  }
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}
