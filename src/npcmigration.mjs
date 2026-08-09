// Rare, permanent moves for persistent residents.
//
// This module is deliberately state-only: it neither invents housing nor moves
// rendered actors. A caller supplies authored destination household/home
// candidates and may apply the immutable proposal at a safe simulation point.

import {
  createNpcLocation,
  createNpcResidence,
  normalizeNpcLocation,
  normalizeNpcResidence,
} from './npclocation.mjs';
import {
  ITINERARY_ACTIVITY_KIND,
  ITINERARY_STATUS,
  restoreItinerarySnapshot,
} from './npcitinerary.mjs';

export const NPC_MIGRATION_VERSION = 1;
// Exactly one of 64 deterministic hash cohorts is eligible after a completed
// journey. This is an upper bound: housing and safety checks make actual moves
// rarer. No clock or random-number source participates in the decision.
export const NPC_MIGRATION_RATE_DENOMINATOR = 64;

const COMPLETED_PURPOSES = new Set(Object.values(ITINERARY_ACTIVITY_KIND));
const TERMINAL_COMMITMENTS = new Set(['resolved', 'failed']);

/** Return a JSON-safe immutable decision without changing living-world state. */
export function planNpcMigration({
  state,
  actorId,
  itineraryId,
  destinationCandidates = [],
} = {}) {
  requireState(state);
  const personId = requiredId(actorId, 'actorId');
  const tripId = requiredId(itineraryId, 'itineraryId');
  const base = decisionBase(personId, tripId);
  if (state.features?.npcMigrationEnabled !== true) return decision(base, 'feature-disabled');

  const entity = state.entities?.[personId];
  if (!entity || entity.kind !== 'npc' || entity.tombstone) return decision(base, 'invalid-actor');
  const residence = normalizeNpcResidence(entity.residence);
  const location = normalizeNpcLocation(entity.location);
  if (!residence || !location) return decision(base, 'invalid-residence');
  if (hasActiveTravelOrCommitment(state, entity)) return decision(base, 'actor-busy');

  const itinerary = completedItinerary(state, tripId, personId);
  if (!itinerary) return decision(base, 'travel-not-completed');
  const visitedSettlementId = destinationSettlementId(itinerary);
  if (!visitedSettlementId) return decision(base, 'invalid-destination');
  if (!isAtCanonicalHome(entity, residence, location)) return decision(base, 'actor-away');

  const bucket = migrationCohortBucket({
    worldSeed: state.worldSeed,
    actorId: personId,
    itineraryId: tripId,
  });
  if (bucket !== 0) return decision({ ...base, bucket }, 'common-cohort');

  const candidates = normalizeCandidates(destinationCandidates)
    .filter((candidate) => candidate.settlementId === visitedSettlementId)
    .filter((candidate) => candidate.settlementId !== residence.residenceSettlementId)
    .filter((candidate) => validAvailableHome(state, candidate, personId));
  if (!candidates.length) return decision({ ...base, bucket }, 'no-available-home');

  const selected = candidates[hashText(`${state.worldSeed}|${personId}|${tripId}|home`) % candidates.length];
  const migrationId = migrationIdFor(personId, tripId, selected.householdId);
  return deepFreeze({
    version: NPC_MIGRATION_VERSION,
    eligible: true,
    reason: 'eligible',
    bucket,
    migrationId,
    receiptId: migrationId,
    eventId: `${migrationId}:event`,
    actorId: personId,
    itineraryId: tripId,
    source: {
      settlementId: residence.residenceSettlementId,
      householdId: residence.householdId,
      homeBuildingId: residence.homeBuildingId,
    },
    destination: { ...selected },
  });
}

/**
 * Apply a proposal as one validated membership/address transaction.
 * A repeated application returns the original receipt and changes no state.
 */
export function applyNpcMigration(state, proposal) {
  requireState(state);
  validateProposalShape(proposal);
  const prior = state.effectReceipts?.[proposal.receiptId];
  if (prior) {
    if (prior.migrationId !== proposal.migrationId || prior.actorId !== proposal.actorId
      || prior.itineraryId !== proposal.itineraryId
      || prior.toHouseholdId !== proposal.destination.householdId) {
      throw new Error(`Migration receipt collision: ${proposal.receiptId}.`);
    }
    return deepFreeze({ applied: false, exactOnce: true, receipt: clonePlain(prior) });
  }
  if (state.features?.npcMigrationEnabled !== true) throw new Error('NPC migration is disabled.');

  const entity = state.entities?.[proposal.actorId];
  if (!entity || entity.kind !== 'npc' || entity.tombstone) throw new TypeError('Migration actor is invalid.');
  const residence = normalizeNpcResidence(entity.residence);
  const location = normalizeNpcLocation(entity.location);
  if (!residence || !location) throw new TypeError('Migration actor lacks canonical spatial state.');
  if (hasActiveTravelOrCommitment(state, entity)) throw new Error('Migration actor is busy.');
  if (!completedItinerary(state, proposal.itineraryId, entity.id)) {
    throw new Error('Migration requires a successfully completed itinerary.');
  }
  if (!isAtCanonicalHome(entity, residence, location)) throw new Error('Migration actor is away from home.');
  if (migrationCohortBucket({
    worldSeed: state.worldSeed, actorId: entity.id, itineraryId: proposal.itineraryId,
  }) !== 0) throw new Error('Migration actor is not in the rare eligibility cohort.');
  if (proposal.source.settlementId !== residence.residenceSettlementId
    || proposal.source.householdId !== residence.householdId
    || proposal.source.homeBuildingId !== residence.homeBuildingId) {
    throw new Error('Migration source residence has changed.');
  }
  if (proposal.destination.settlementId === residence.residenceSettlementId) {
    throw new Error('Migration destination is the current residence.');
  }
  const itinerary = completedItinerary(state, proposal.itineraryId, entity.id);
  if (destinationSettlementId(itinerary) !== proposal.destination.settlementId) {
    throw new Error('Migration destination was not the completed journey destination.');
  }
  if (!validAvailableHome(state, proposal.destination, entity.id)) {
    throw new Error('Migration destination home is invalid or full.');
  }

  const oldHousehold = state.households?.[residence.householdId];
  const newHousehold = state.households?.[proposal.destination.householdId];
  if (!oldHousehold || !newHousehold || oldHousehold === newHousehold) {
    throw new Error('Migration requires distinct existing households.');
  }
  const memberships = Object.values(state.households || {})
    .filter((household) => household?.memberIds?.includes(entity.id));
  if (memberships.length !== 1 || memberships[0].id !== oldHousehold.id) {
    throw new Error('Migration actor does not have one authoritative household membership.');
  }

  // Prepare every replacement before mutating state. From this point onward all
  // values are plain assignments, so observers never see dual membership.
  const oldMemberIds = oldHousehold.memberIds.filter((id) => id !== entity.id);
  const newMemberIds = [...newHousehold.memberIds, entity.id];
  const oldAccessMembers = updateAccessMembers(oldHousehold, entity.id, false);
  const newAccessMembers = updateAccessMembers(newHousehold, entity.id, true);
  const nextResidence = createNpcResidence({
    originSettlementId: residence.originSettlementId,
    residenceSettlementId: proposal.destination.settlementId,
    householdId: proposal.destination.householdId,
    homeBuildingId: proposal.destination.homeBuildingId,
  });
  const nextLocation = createNpcLocation('building', {
    settlementId: proposal.destination.settlementId,
    buildingId: proposal.destination.homeBuildingId,
  });
  const receipt = {
    id: proposal.receiptId,
    migrationId: proposal.migrationId,
    eventId: proposal.eventId,
    type: 'npc.migrated',
    actorId: entity.id,
    itineraryId: proposal.itineraryId,
    fromSettlementId: residence.residenceSettlementId,
    toSettlementId: nextResidence.residenceSettlementId,
    fromHouseholdId: residence.householdId,
    toHouseholdId: nextResidence.householdId,
  };
  const event = { ...receipt, id: proposal.eventId, receiptId: proposal.receiptId };
  if (state.events?.some((stored) => stored?.id === event.id)) {
    throw new Error(`Migration event collision: ${event.id}.`);
  }

  oldHousehold.memberIds = oldMemberIds;
  newHousehold.memberIds = newMemberIds;
  if (oldAccessMembers) oldHousehold.access.members = oldAccessMembers;
  if (newAccessMembers) newHousehold.access.members = newAccessMembers;
  entity.residence = { ...nextResidence };
  entity.householdId = nextResidence.householdId;
  entity.homeKey = nextResidence.homeBuildingId;
  entity.location = { ...nextLocation };
  entity.locationKey = nextResidence.homeBuildingId;
  entity.activity = null;
  entity.inTransit = false;
  state.effectReceipts ||= {};
  state.effectReceipts[proposal.receiptId] = clonePlain(receipt);
  state.events ||= [];
  state.events.push(event);
  state.revision = nonNegativeInteger(state.revision) + 1;
  return deepFreeze({ applied: true, exactOnce: false, receipt: clonePlain(receipt) });
}

/** Public for diagnostics/tests: the stable 0..63 cohort for one completed trip. */
export function migrationCohortBucket({ worldSeed = 1, actorId, itineraryId } = {}) {
  return hashText(`${Number(worldSeed) || 1}|${requiredId(actorId, 'actorId')}|${requiredId(itineraryId, 'itineraryId')}|migration`)
    % NPC_MIGRATION_RATE_DENOMINATOR;
}

function decision(base, reason) {
  return deepFreeze({ version: NPC_MIGRATION_VERSION, eligible: false, reason, ...base });
}

function decisionBase(actorId, itineraryId) {
  return { actorId, itineraryId };
}

function completedItinerary(state, itineraryId, actorId) {
  const snapshot = state.itineraries?.[itineraryId];
  if (!snapshot) return null;
  try {
    const itinerary = restoreItinerarySnapshot(snapshot);
    return itinerary.actorId === actorId && itinerary.status === ITINERARY_STATUS.completed
      && COMPLETED_PURPOSES.has(itinerary.purpose?.kind) ? itinerary : null;
  } catch {
    return null;
  }
}

function destinationSettlementId(itinerary) {
  if (itinerary?.destination?.kind !== 'settlement') return null;
  try { return requiredId(itinerary.destination.key, 'destination.key'); } catch { return null; }
}

function normalizeCandidates(inputs) {
  const candidates = [];
  const seen = new Set();
  for (const value of Array.isArray(inputs) ? inputs : []) {
    try {
      const candidate = {
        settlementId: requiredId(value?.settlementId, 'candidate.settlementId'),
        householdId: requiredId(value?.householdId, 'candidate.householdId'),
        homeBuildingId: requiredId(value?.homeBuildingId, 'candidate.homeBuildingId'),
        capacity: positiveInteger(value?.capacity),
      };
      const key = `${candidate.settlementId}\u0000${candidate.householdId}\u0000${candidate.homeBuildingId}`;
      if (!seen.has(key)) { seen.add(key); candidates.push(candidate); }
    } catch { /* malformed caller candidates are not housing */ }
  }
  return candidates.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function validAvailableHome(state, candidate, actorId) {
  let capacity;
  try { capacity = positiveInteger(candidate?.capacity); } catch { return false; }
  const household = state.households?.[candidate.householdId];
  return !!household && household.id === candidate.householdId
    && household.homeBuildingId === candidate.homeBuildingId
    && Array.isArray(household.memberIds)
    && !household.memberIds.includes(actorId)
    && new Set(household.memberIds).size === household.memberIds.length
    && household.memberIds.length < capacity;
}

function hasActiveTravelOrCommitment(state, entity) {
  if (entity.itineraryId || entity.inTransit) return true;
  return Object.values(state.commitments || {}).some((commitment) => (
    commitment?.actorId === entity.id && !TERMINAL_COMMITMENTS.has(commitment.state)
  ));
}

function isAtCanonicalHome(entity, residence, location) {
  return location.kind === 'building'
    && location.settlementId === residence.residenceSettlementId
    && location.buildingId === residence.homeBuildingId;
}

function updateAccessMembers(household, actorId, add) {
  if (!household.access || !Array.isArray(household.access.members)) return null;
  const without = household.access.members.filter((id) => id !== actorId);
  return add ? [...without, actorId] : without;
}

function validateProposalShape(value) {
  if (!value || value.version !== NPC_MIGRATION_VERSION || value.eligible !== true
    || value.reason !== 'eligible') throw new TypeError('An eligible migration proposal is required.');
  for (const field of ['migrationId', 'receiptId', 'eventId', 'actorId', 'itineraryId']) {
    requiredId(value[field], `proposal.${field}`);
  }
  for (const field of ['settlementId', 'householdId', 'homeBuildingId']) {
    requiredId(value.source?.[field], `proposal.source.${field}`);
    requiredId(value.destination?.[field], `proposal.destination.${field}`);
  }
  positiveInteger(value.destination.capacity);
  const expectedId = migrationIdFor(value.actorId, value.itineraryId, value.destination.householdId);
  if (value.migrationId !== expectedId || value.receiptId !== expectedId
    || value.eventId !== `${expectedId}:event`) {
    throw new TypeError('Migration proposal identity is inconsistent.');
  }
}

function migrationIdFor(actorId, itineraryId, householdId) {
  return `npc-migration:${encodeURIComponent(actorId)}:${encodeURIComponent(itineraryId)}:${encodeURIComponent(householdId)}`;
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError('A positive housing capacity is required.');
  return number;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function requireState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('Living-world state is required.');
  }
}
