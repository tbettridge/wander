// State-only orchestration for one persistent person changing travel activity.
//
// Route choice, clocks, steering, and rendering remain outside this module.
// It atomically joins the canonical person location, itinerary, and rail-seat
// contracts inside living-world state so visible and off-screen executors can
// drive the same durable transitions.

import {
  createNpcSpatialState,
  normalizeNpcLocation,
  normalizeNpcResidence,
  npcSpatialSnapshot,
} from './npclocation.mjs';
import {
  blockItineraryLeg,
  completeItineraryLeg,
  currentItineraryLeg,
  failItineraryLeg,
  itinerarySnapshot,
  ITINERARY_STATUS,
  restoreItinerarySnapshot,
  resumeItineraryLeg,
  startItineraryLeg,
  validateItinerary,
} from './npcitinerary.mjs';
import { RailPassengerManifest } from './railpassengers.mjs';
import { TrainScheduleModel } from './railservice.mjs';

export const NPC_ITINERARY_TRANSITION = Object.freeze({
  start: 'start',
  complete: 'complete',
  block: 'block',
  resume: 'resume',
  fail: 'fail',
});

const TERMINAL_ITINERARY_STATUS = new Set([
  ITINERARY_STATUS.completed,
  ITINERARY_STATUS.failed,
]);

/** Persist a validated itinerary and make it the NPC's one active trip. */
export function registerNpcItinerary(state, itinerary, { allowDisabled = false } = {}) {
  requireMobility(state, allowDisabled);
  validateItinerary(itinerary);
  const entity = requireNpc(state, itinerary.actorId);
  requireMatchingResidence(entity, itinerary.residence);
  requireItineraryFeatures(state, itinerary, allowDisabled);

  // An itinerary ID is an exact-once planning receipt. Streaming activation or
  // a retried scheduler call must never replace its persisted progress with a
  // fresh planned copy.
  const existing = loadNpcItinerary(state, itinerary.id);
  if (existing) {
    if (existing.actorId !== entity.id) {
      throw new Error(`Itinerary ${itinerary.id} already belongs to ${existing.actorId}.`);
    }
    requireMatchingResidence(entity, existing.residence);
    return existing;
  }

  if (entity.itineraryId && entity.itineraryId !== itinerary.id) {
    const prior = loadNpcItinerary(state, entity.itineraryId);
    if (prior && !TERMINAL_ITINERARY_STATUS.has(prior.status)) {
      throw new Error(`NPC ${entity.id} already has active itinerary ${prior.id}.`);
    }
  }
  for (const stored of Object.values(state.itineraries || {})) {
    const prior = restoreItinerarySnapshot(stored);
    if (prior.id !== itinerary.id && prior.actorId === entity.id
      && !TERMINAL_ITINERARY_STATUS.has(prior.status)) {
      throw new Error(`NPC ${entity.id} already has active itinerary ${prior.id}.`);
    }
  }

  persistItinerary(state, entity, itinerary);
  return loadNpcItinerary(state, itinerary.id);
}

/** Restore a defensive mutable itinerary copy from living-world state. */
export function loadNpcItinerary(state, itineraryId) {
  const id = requiredId(itineraryId, 'itineraryId');
  const stored = state?.itineraries?.[id];
  return stored ? restoreItinerarySnapshot(stored) : null;
}

export function activeNpcItinerary(state, actorId) {
  const entity = state?.entities?.[requiredId(actorId, 'actorId')];
  if (!entity?.itineraryId) return null;
  const itinerary = loadNpcItinerary(state, entity.itineraryId);
  return itinerary && !TERMINAL_ITINERARY_STATUS.has(itinerary.status) ? itinerary : null;
}

/**
 * Advance one itinerary transition and optionally publish its resulting place.
 *
 * The location is validated before the itinerary copy is changed, so malformed
 * presentation input cannot partially advance durable state.
 */
export function transitionNpcItinerary(state, itineraryId, {
  type,
  legId = null,
  details = {},
  location = null,
  allowDisabled = false,
} = {}) {
  requireMobility(state, allowDisabled);
  const itinerary = loadNpcItinerary(state, itineraryId);
  if (!itinerary) throw new RangeError(`Unknown NPC itinerary: ${itineraryId}.`);
  const entity = requireNpc(state, itinerary.actorId);
  requireMatchingResidence(entity, itinerary.residence);
  requireItineraryFeatures(state, itinerary, allowDisabled);
  const nextLocation = location == null ? null : normalizeNpcLocation(location);
  if (location != null && !nextLocation) throw new TypeError('Invalid itinerary transition location.');

  const targetLegId = legId || currentItineraryLeg(itinerary)?.id;
  let receipt;
  switch (type) {
    case NPC_ITINERARY_TRANSITION.start:
      receipt = startItineraryLeg(itinerary, targetLegId, details);
      break;
    case NPC_ITINERARY_TRANSITION.complete:
      receipt = completeItineraryLeg(itinerary, targetLegId, details);
      break;
    case NPC_ITINERARY_TRANSITION.block:
      receipt = blockItineraryLeg(itinerary, targetLegId, details);
      break;
    case NPC_ITINERARY_TRANSITION.resume:
      receipt = resumeItineraryLeg(itinerary, targetLegId, details);
      break;
    case NPC_ITINERARY_TRANSITION.fail:
      receipt = failItineraryLeg(itinerary, targetLegId, details);
      break;
    default:
      throw new TypeError(`Unknown NPC itinerary transition: ${type}.`);
  }

  persistItinerary(state, entity, itinerary, nextLocation);
  return { receipt, itinerary: loadNpcItinerary(state, itinerary.id), entity };
}

/** Restore a passenger manifest copy for use by simulation or rendering. */
export function railPassengerManifest(state, runId) {
  const id = requiredId(runId, 'runId');
  const stored = state?.railManifests?.[id];
  return stored ? RailPassengerManifest.restore(stored) : null;
}

/** Return a defensive, validated authoritative service timeline snapshot. */
export function railServiceSnapshot(state, serviceId) {
  const id = requiredId(serviceId, 'serviceId');
  const stored = state?.railServices?.[id];
  return stored ? TrainScheduleModel.restore(stored).snapshot() : null;
}

/** Persist schedule progress without allowing a key/service identity mismatch. */
export function persistRailServiceSnapshot(state, serviceId, snapshot) {
  requireRailMobility(state);
  const id = requiredId(serviceId, 'serviceId');
  const validated = TrainScheduleModel.restore(snapshot).snapshot();
  if (validated.serviceId !== id) {
    throw new TypeError(`Rail service snapshot ${validated.serviceId} does not match ${id}.`);
  }
  state.railServices ||= {};
  const before = JSON.stringify(state.railServices[id] ?? null);
  const stored = JSON.parse(JSON.stringify(validated));
  state.railServices[id] = stored;
  if (before !== JSON.stringify(stored)) incrementRevision(state);
  return JSON.parse(JSON.stringify(stored));
}

/** Reserve capacity without changing the NPC's current place. */
export function reserveNpcRailPassenger(state, {
  runId,
  personId,
  originStationId,
  destinationStationId,
  carriageIndex = null,
  seatIndex = null,
} = {}) {
  requireRailMobility(state);
  const entity = requireNpc(state, personId);
  requireCanonicalSpatialEntity(entity);
  const manifest = railPassengerManifest(state, runId)
    || new RailPassengerManifest({ runId: requiredId(runId, 'runId') });
  const before = JSON.stringify(state.railManifests?.[manifest.runId] ?? null);
  const reservation = manifest.reserve({
    personId: entity.id,
    originStationId,
    destinationStationId,
    carriageIndex,
    seatIndex,
  });
  state.railManifests ||= {};
  state.railManifests[manifest.runId] = manifest.snapshot();
  if (before !== JSON.stringify(state.railManifests[manifest.runId])) incrementRevision(state);
  return reservation;
}

/** Exact-once boarding publishes a canonical train-seat location. */
export function boardNpcRailPassenger(state, {
  runId,
  personId,
  stationId,
  serviceTick = null,
} = {}) {
  requireRailMobility(state);
  const entity = requireNpc(state, personId);
  requireCanonicalSpatialEntity(entity);
  const manifest = railPassengerManifest(state, runId);
  if (!manifest) throw new RangeError(`Unknown rail passenger manifest: ${runId}.`);
  const result = manifest.board(entity.id, stationId, { serviceTick });
  const reservation = manifest.reservationForPerson(entity.id);
  const location = {
    kind: 'train-seat',
    runId: manifest.runId,
    carriageId: `carriage:${reservation.carriageIndex}`,
    seatId: `seat:${reservation.seatIndex}`,
  };
  persistRailTransition(state, entity, manifest, location, {
    kind: 'train-ride', runId: manifest.runId,
    destinationStationId: reservation.destinationStationId,
  });
  return { ...result, reservation, location: { ...entity.location } };
}

/** Exact-once alighting moves the same NPC onto a caller-supplied platform. */
export function alightNpcRailPassenger(state, {
  runId,
  personId,
  stationId,
  platformLocation,
  serviceTick = null,
} = {}) {
  requireRailMobility(state);
  const entity = requireNpc(state, personId);
  requireCanonicalSpatialEntity(entity);
  const location = normalizeNpcLocation(platformLocation);
  if (!location || location.kind !== 'station-platform' || location.stationId !== stationId) {
    throw new TypeError('Alighting requires a canonical location on the destination platform.');
  }
  const manifest = railPassengerManifest(state, runId);
  if (!manifest) throw new RangeError(`Unknown rail passenger manifest: ${runId}.`);
  const result = manifest.alight(entity.id, stationId, { serviceTick });
  const reservation = manifest.reservationForPerson(entity.id);
  persistRailTransition(state, entity, manifest, location, {
    kind: 'station-arrival', stationId, runId: manifest.runId,
  });
  return { ...result, reservation, location: { ...entity.location } };
}

function persistItinerary(state, entity, itinerary, location = null) {
  state.itineraries ||= {};
  const before = JSON.stringify([
    state.itineraries[itinerary.id] ?? null,
    entity.itineraryId ?? null,
    entity.activity ?? null,
    entity.location ?? null,
  ]);
  state.itineraries[itinerary.id] = itinerarySnapshot(itinerary);
  entity.itineraryId = TERMINAL_ITINERARY_STATUS.has(itinerary.status) ? null : itinerary.id;
  entity.activity = TERMINAL_ITINERARY_STATUS.has(itinerary.status)
    ? null : itineraryActivity(itinerary);
  if (location) entity.location = spatialLocation(entity, location);
  const after = JSON.stringify([
    state.itineraries[itinerary.id], entity.itineraryId,
    entity.activity, entity.location ?? null,
  ]);
  if (before !== after) incrementRevision(state);
}

function persistRailTransition(state, entity, manifest, location, activity) {
  state.railManifests ||= {};
  const before = JSON.stringify([
    state.railManifests[manifest.runId] ?? null,
    entity.location ?? null,
    entity.activity ?? null,
  ]);
  state.railManifests[manifest.runId] = manifest.snapshot();
  entity.location = spatialLocation(entity, location);
  entity.activity = { ...activity };
  const after = JSON.stringify([
    state.railManifests[manifest.runId], entity.location, entity.activity,
  ]);
  if (before !== after) incrementRevision(state);
}

function spatialLocation(entity, location) {
  return npcSpatialSnapshot(createNpcSpatialState({
    residence: entity.residence,
    location,
  })).location;
}

function itineraryActivity(itinerary) {
  const leg = currentItineraryLeg(itinerary);
  return {
    kind: 'itinerary',
    itineraryId: itinerary.id,
    status: itinerary.status,
    legKind: leg?.kind ?? null,
    direction: leg?.direction ?? null,
  };
}

function requireMobility(state, allowDisabled = false) {
  if (!state || typeof state !== 'object') throw new TypeError('Living-world state is required.');
  if (!allowDisabled && state.features?.unifiedNpcMobilityEnabled !== true) {
    throw new Error('Unified NPC mobility is disabled.');
  }
}

function requireRailMobility(state) {
  requireMobility(state);
  if (state.features?.npcRailTravelEnabled !== true) throw new Error('NPC rail travel is disabled.');
}

function requireItineraryFeatures(state, itinerary, allowDisabled = false) {
  if (allowDisabled) return;
  const legs = Array.isArray(itinerary?.legs) ? itinerary.legs : [];
  const requiresRail = legs.some((leg) => [
    'board-train', 'train-ride', 'alight-train',
  ].includes(leg?.kind));
  const leisure = legs.some((leg) => (
    leg?.kind === 'destination-activity' && leg.data?.activityKind === 'leisure'
  )) || itinerary?.purpose?.kind === 'leisure';
  if (requiresRail && state.features?.npcRailTravelEnabled !== true) {
    throw new Error('NPC rail travel is disabled for this itinerary.');
  }
  if (leisure && state.features?.npcLeisureTravelEnabled !== true) {
    throw new Error('NPC leisure travel is disabled for this itinerary.');
  }
}

function requireNpc(state, actorId) {
  const id = requiredId(actorId, 'actorId');
  const entity = state?.entities?.[id];
  if (!entity) throw new RangeError(`Unknown living-world entity: ${id}.`);
  if (entity.kind !== 'npc' || entity.tombstone) throw new TypeError(`Entity ${id} is not an active NPC.`);
  return entity;
}

function requireCanonicalSpatialEntity(entity) {
  if (!normalizeNpcResidence(entity?.residence) || !normalizeNpcLocation(entity?.location)) {
    throw new TypeError(`NPC ${entity?.id || '(unknown)'} has no canonical spatial state.`);
  }
}

function requireMatchingResidence(entity, itineraryResidence) {
  const residence = normalizeNpcResidence(entity?.residence);
  const planned = normalizeNpcResidence(itineraryResidence);
  if (!residence || !planned || JSON.stringify(residence) !== JSON.stringify(planned)) {
    throw new TypeError(`Itinerary residence does not match NPC ${entity?.id || '(unknown)'}.`);
  }
}

function incrementRevision(state) {
  state.revision = Math.max(0, Math.floor(Number(state.revision) || 0)) + 1;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}
