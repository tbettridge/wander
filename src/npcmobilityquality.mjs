// Read-only integrity checks for the unified NPC mobility boundary.
//
// Validation remains authoritative in the itinerary, location, and passenger
// modules. This auditor restores through those public APIs and only checks the
// cross-record relationships that no individual contract can see.

import { normalizeNpcLocation, normalizeNpcResidence } from './npclocation.mjs';
import { ITINERARY_STATUS, restoreItinerarySnapshot } from './npcitinerary.mjs';
import { PASSENGER_STATUS, RailPassengerManifest } from './railpassengers.mjs';
import { TrainScheduleModel } from './railservice.mjs';

const TERMINAL = new Set([ITINERARY_STATUS.completed, ITINERARY_STATUS.failed]);

export function auditNpcMobilityState(state) {
  const errors = [];
  const metrics = {
    itinerarySnapshots: 0,
    validItineraries: 0,
    malformedItineraries: 0,
    activeItineraries: 0,
    actorsWithMultipleActiveItineraries: 0,
    serviceSnapshots: 0,
    validServices: 0,
    malformedServices: 0,
    manifestSnapshots: 0,
    validManifests: 0,
    malformedManifests: 0,
    reservations: 0,
    boardedPassengers: 0,
    issues: 0,
  };
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    addError(errors, 'state.malformed', 'living-world', null, 'Living-world state must be an object.');
    metrics.issues = errors.length;
    return { ok: false, errors, metrics };
  }

  const entities = state.entities && typeof state.entities === 'object' ? state.entities : {};
  const validItineraries = new Map();
  const activeByActor = new Map();
  for (const itineraryId of sortedKeys(state.itineraries)) {
    metrics.itinerarySnapshots++;
    let itinerary;
    try {
      itinerary = restoreItinerarySnapshot(state.itineraries[itineraryId]);
      if (itinerary.id !== itineraryId) {
        throw new TypeError(`Snapshot id ${itinerary.id} does not match storage key ${itineraryId}.`);
      }
    } catch (error) {
      metrics.malformedItineraries++;
      addError(errors, 'itinerary.malformed', itineraryId, null, errorMessage(error));
      continue;
    }
    metrics.validItineraries++;
    validItineraries.set(itineraryId, itinerary);
    const entity = entities[itinerary.actorId];
    if (!entity) {
      addError(errors, 'itinerary.actor-missing', itineraryId, itinerary.actorId,
        `Itinerary actor ${itinerary.actorId} is missing.`);
    } else if (entity.tombstone || entity.kind !== 'npc') {
      addError(errors, 'itinerary.actor-inactive', itineraryId, itinerary.actorId,
        `Itinerary actor ${itinerary.actorId} is tombstoned or is not an NPC.`);
    } else if (!sameResidence(entity.residence, itinerary.residence)) {
      addError(errors, 'itinerary.residence-mismatch', itineraryId, itinerary.actorId,
        `Itinerary residence does not match NPC ${itinerary.actorId}.`);
    }

    if (!TERMINAL.has(itinerary.status)) {
      metrics.activeItineraries++;
      if (!activeByActor.has(itinerary.actorId)) activeByActor.set(itinerary.actorId, []);
      activeByActor.get(itinerary.actorId).push(itinerary.id);
      if (entity && entity.itineraryId !== itinerary.id) {
        addError(errors, 'entity.itinerary-link-mismatch', itinerary.actorId, itinerary.id,
          `NPC ${itinerary.actorId} does not link to active itinerary ${itinerary.id}.`);
      }
    } else if (entity?.itineraryId === itinerary.id) {
      addError(errors, 'entity.itinerary-link-mismatch', itinerary.actorId, itinerary.id,
        `NPC ${itinerary.actorId} links to terminal itinerary ${itinerary.id}.`);
    }
  }

  for (const [actorId, ids] of [...activeByActor.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    ids.sort();
    if (ids.length > 1) {
      metrics.actorsWithMultipleActiveItineraries++;
      addError(errors, 'itinerary.multiple-active', actorId, ids.join(','),
        `NPC ${actorId} has ${ids.length} active itineraries.`);
    }
  }

  for (const entityId of sortedKeys(entities)) {
    const entity = entities[entityId];
    if (!entity?.itineraryId) continue;
    const itinerary = validItineraries.get(entity.itineraryId);
    if (!itinerary || itinerary.actorId !== entityId || TERMINAL.has(itinerary.status)) {
      addError(errors, 'entity.itinerary-link-mismatch', entityId, entity.itineraryId,
        `NPC ${entityId} links to a missing, foreign, or terminal itinerary.`);
    }
  }

  for (const serviceId of sortedKeys(state.railServices)) {
    metrics.serviceSnapshots++;
    try {
      const service = TrainScheduleModel.restore(state.railServices[serviceId]);
      if (service.serviceId !== serviceId) {
        throw new TypeError(`Service ${service.serviceId} does not match storage key ${serviceId}.`);
      }
      metrics.validServices++;
    } catch (error) {
      metrics.malformedServices++;
      addError(errors, 'rail.service-malformed', serviceId, null, errorMessage(error));
    }
  }

  for (const runId of sortedKeys(state.railManifests)) {
    metrics.manifestSnapshots++;
    let manifest;
    try {
      manifest = RailPassengerManifest.restore(state.railManifests[runId]);
      if (manifest.runId !== runId) {
        throw new TypeError(`Manifest run ${manifest.runId} does not match storage key ${runId}.`);
      }
    } catch (error) {
      metrics.malformedManifests++;
      addError(errors, 'rail.manifest-malformed', runId, null, errorMessage(error));
      continue;
    }
    metrics.validManifests++;
    for (const reservation of manifest.reservations()) {
      metrics.reservations++;
      if (reservation.kind !== 'npc') continue;
      const entity = entities[reservation.personId];
      if (!entity || entity.kind !== 'npc' || entity.tombstone) {
        addError(errors, 'rail.reservation-unknown-npc', runId, reservation.personId,
          `Reservation belongs to unknown or inactive NPC ${reservation.personId}.`);
        continue;
      }
      if (reservation.status !== PASSENGER_STATUS.boarded) continue;
      metrics.boardedPassengers++;
      const location = normalizeNpcLocation(entity.location);
      const expectedCarriage = `carriage:${reservation.carriageIndex}`;
      const expectedSeat = `seat:${reservation.seatIndex}`;
      if (!location || !['train-seat', 'train-carriage'].includes(location.kind) || location.runId !== runId
          || location.carriageId !== expectedCarriage || location.seatId !== expectedSeat) {
        addError(errors, 'rail.boarded-location-mismatch', runId, reservation.personId,
          `Boarded NPC ${reservation.personId} is not in its reserved carriage/seat assignment ${expectedCarriage}/${expectedSeat}.`);
      }
    }
  }

  errors.sort((a, b) => a.code.localeCompare(b.code)
    || a.subjectId.localeCompare(b.subjectId)
    || String(a.relatedId || '').localeCompare(String(b.relatedId || ''))
    || a.message.localeCompare(b.message));
  metrics.issues = errors.length;
  return { ok: errors.length === 0, errors, metrics };
}

function sameResidence(a, b) {
  const left = normalizeNpcResidence(a);
  const right = normalizeNpcResidence(b);
  return !!left && !!right
    && left.originSettlementId === right.originSettlementId
    && left.residenceSettlementId === right.residenceSettlementId
    && left.householdId === right.householdId
    && left.homeBuildingId === right.homeBuildingId;
}

function addError(errors, code, subjectId, relatedId, message) {
  const duplicate = errors.some((error) => error.code === code
    && error.subjectId === String(subjectId) && error.relatedId === relatedId);
  if (!duplicate) errors.push({ code, subjectId: String(subjectId), relatedId, message });
}

function sortedKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
