// Deterministic, renderer-free execution of persisted NPC itineraries.
//
// Callers own route planning and presentation. This module consumes explicit
// simulation time and authoritative rail descriptors, publishing only durable
// canonical locations and compact activity progress into living-world state.

import { normalizeNpcLocation, normalizeNpcResidence } from './npclocation.mjs';
import {
  currentItineraryLeg,
  ITINERARY_LEG_KIND,
  ITINERARY_LEG_STATUS,
  ITINERARY_STATUS,
} from './npcitinerary.mjs';
import {
  activeNpcItinerary,
  alightNpcRailPassenger,
  boardNpcRailPassenger,
  loadNpcItinerary,
  NPC_ITINERARY_TRANSITION,
  railPassengerManifest,
  reserveNpcRailPassenger,
  transitionNpcItinerary,
} from './npcmobility.mjs';

const EPSILON = 1e-9;
const MAX_TRANSITIONS_PER_TICK = 64;

/**
 * Advance one person's active itinerary.
 *
 * Rail descriptors have the deliberately small shape
 * `{ serviceId?, runId, phase, stationId, serviceTick? }`. Only a descriptor
 * whose phase is `dwelling` can trigger reservation, boarding, or alighting.
 */
export function tickNpcMobilityItinerary(state, actorId, {
  deltaSeconds = 0,
  worldHours = 0,
  railServices = [],
} = {}) {
  const dt = finiteNonNegative(deltaSeconds, 'deltaSeconds');
  const hours = finiteNonNegative(worldHours, 'worldHours');
  const services = normalizeServices(railServices);
  const entity = requireActor(state, actorId);
  requireFeatures(state);
  const residenceBefore = JSON.stringify(entity.residence);
  let itinerary = activeNpcItinerary(state, entity.id);
  const report = {
    actorId: entity.id,
    itineraryId: itinerary?.id ?? null,
    consumedSeconds: 0,
    remainingSeconds: dt,
    transitions: [],
    reservations: [],
    boards: [],
    alights: [],
    completed: false,
    waiting: null,
    location: clone(entity.location),
  };
  if (!itinerary) return report;
  requireItineraryFeatures(state, itinerary);
  preflightItinerary(itinerary);

  let remaining = dt;
  for (let guard = 0; itinerary && guard < MAX_TRANSITIONS_PER_TICK; guard++) {
    const leg = currentItineraryLeg(itinerary);
    if (!leg) break;
    // All leg-specific data is validated before any transition for that leg.
    const contract = legContract(leg, itinerary, entity);
    const beforeIndex = itinerary.legIndex;
    const outcome = executeLeg({
      state, entity, itinerary, leg, contract, services, remaining, hours, report,
    });
    remaining = outcome.remaining;
    itinerary = loadNpcItinerary(state, itinerary.id);
    if (itinerary?.status === ITINERARY_STATUS.completed) {
      report.completed = true;
      itinerary = null;
    }
    if (!outcome.advanced && (itinerary?.legIndex ?? beforeIndex) === beforeIndex) break;
  }
  if (JSON.stringify(entity.residence) !== residenceBefore) {
    throw new Error('NPC mobility execution must never change residence.');
  }
  report.consumedSeconds = dt - remaining;
  report.remainingSeconds = remaining;
  report.location = clone(entity.location);
  return report;
}

/** Tick every active NPC in stable identity order. */
export function tickAllNpcMobilityItineraries(state, options = {}) {
  return Object.values(state?.entities || {})
    .filter((entity) => entity?.kind === 'npc' && entity.itineraryId && !entity.tombstone)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((entity) => tickNpcMobilityItinerary(state, entity.id, options));
}

function executeLeg(context) {
  const { leg } = context;
  switch (leg.kind) {
    case ITINERARY_LEG_KIND.localWalk:
    case ITINERARY_LEG_KIND.regionalWalk:
      return executeTimed(context, 'walk');
    case ITINERARY_LEG_KIND.destinationActivity:
      return executeTimed(context, 'activity');
    case ITINERARY_LEG_KIND.stationWait:
      return executeStationWait(context);
    case ITINERARY_LEG_KIND.boardTrain:
      return executeBoard(context);
    case ITINERARY_LEG_KIND.trainRide:
      return executeRide(context);
    case ITINERARY_LEG_KIND.alightTrain:
      return executeAlight(context);
    default:
      throw new TypeError(`Unsupported itinerary leg kind: ${leg.kind}.`);
  }
}

function executeTimed({ state, entity, itinerary, leg, contract, remaining, hours, report }) {
  startIfPending(state, itinerary.id, leg, report, contract.fromLocation);
  const restored = executorProgress(entity, leg.id);
  const elapsedBefore = restored?.elapsedSeconds ?? 0;
  const spend = Math.min(remaining, Math.max(0, contract.durationSeconds - elapsedBefore));
  const elapsed = Math.min(contract.durationSeconds, elapsedBefore + spend);
  const progress = contract.durationSeconds === 0 ? 1 : elapsed / contract.durationSeconds;
  const location = movementLocation(leg, contract, progress, entity.location);
  publishProgress(state, entity, itinerary.id, leg, {
    elapsedSeconds: elapsed, durationSeconds: contract.durationSeconds,
    progress, worldHours: hours,
  }, location);
  const nextRemaining = remaining - spend;
  if (progress + EPSILON < 1) return { remaining: nextRemaining, advanced: spend > 0 };
  const finished = transitionNpcItinerary(state, itinerary.id, {
    type: NPC_ITINERARY_TRANSITION.complete,
    legId: leg.id,
    details: { executor: 'deterministic', worldHours: hours },
    location: contract.toLocation,
  });
  report.transitions.push(clone(finished.receipt));
  return { remaining: nextRemaining, advanced: true };
}

function executeStationWait({ state, entity, itinerary, leg, contract, services, remaining, hours, report }) {
  startIfPending(state, itinerary.id, leg, report, contract.platformLocation);
  publishProgress(state, entity, itinerary.id, leg, {
    elapsedSeconds: (executorProgress(entity, leg.id)?.elapsedSeconds ?? 0) + remaining,
    progress: 0, worldHours: hours,
  }, contract.platformLocation);
  const service = matchingDwelling(services, contract, null);
  if (!service) {
    report.waiting = { reason: 'service', stationId: contract.originStationId };
    return { remaining: 0, advanced: remaining > 0 };
  }
  const finished = transitionNpcItinerary(state, itinerary.id, {
    type: NPC_ITINERARY_TRANSITION.complete, legId: leg.id,
    details: { runId: service.runId, stationId: service.stationId, worldHours: hours },
    location: contract.platformLocation,
  });
  report.transitions.push(clone(finished.receipt));
  return { remaining, advanced: true };
}

function executeBoard({ state, entity, itinerary, leg, contract, services, remaining, hours, report }) {
  const service = matchingDwelling(services, contract, null);
  if (!service) {
    report.waiting = { reason: 'service', stationId: contract.originStationId };
    return { remaining, advanced: false };
  }
  let reservation;
  try {
    reservation = reserveNpcRailPassenger(state, {
      runId: service.runId, personId: entity.id,
      originStationId: contract.originStationId,
      destinationStationId: contract.destinationStationId,
    });
  } catch (error) {
    if (!/seat is available|capacity is full/.test(String(error?.message))) throw error;
    report.waiting = { reason: 'capacity', runId: service.runId };
    return { remaining, advanced: false };
  }
  report.reservations.push(clone(reservation));
  startIfPending(state, itinerary.id, leg, report, contract.platformLocation);
  const boarded = boardNpcRailPassenger(state, {
    runId: service.runId, personId: entity.id,
    stationId: contract.originStationId, serviceTick: service.serviceTick,
  });
  report.boards.push(clone(boarded));
  const finished = transitionNpcItinerary(state, itinerary.id, {
    type: NPC_ITINERARY_TRANSITION.complete, legId: leg.id,
    details: { runId: service.runId, reservationId: reservation.reservationId, worldHours: hours },
    location: boarded.location,
  });
  report.transitions.push(clone(finished.receipt));
  return { remaining, advanced: true };
}

function executeRide({ state, entity, itinerary, leg, contract, services, remaining, hours, report }) {
  const seat = normalizeNpcLocation(entity.location);
  if (!seat || seat.kind !== 'train-seat') throw new TypeError('A train-ride leg requires a canonical train seat.');
  const manifest = railPassengerManifest(state, seat.runId);
  const reservation = manifest?.reservationForPerson(entity.id);
  if (!reservation || reservation.status !== 'boarded'
      || reservation.destinationStationId !== contract.destinationStationId
      || seat.carriageId !== `carriage:${reservation.carriageIndex}`
      || seat.seatId !== `seat:${reservation.seatIndex}`) {
    throw new TypeError('The train-ride leg does not match the exact reserved seat.');
  }
  startIfPending(state, itinerary.id, leg, report, seat);
  publishProgress(state, entity, itinerary.id, leg, {
    elapsedSeconds: (executorProgress(entity, leg.id)?.elapsedSeconds ?? 0) + remaining,
    progress: 0, runId: seat.runId, worldHours: hours,
  }, seat);
  const service = matchingDwelling(services, contract, seat.runId);
  if (!service) return { remaining: 0, advanced: remaining > 0 };
  const finished = transitionNpcItinerary(state, itinerary.id, {
    type: NPC_ITINERARY_TRANSITION.complete, legId: leg.id,
    details: { runId: seat.runId, stationId: service.stationId, worldHours: hours },
    location: seat,
  });
  report.transitions.push(clone(finished.receipt));
  return { remaining, advanced: true };
}

function executeAlight({ state, entity, itinerary, leg, contract, services, remaining, hours, report }) {
  const seat = normalizeNpcLocation(entity.location);
  if (!seat || seat.kind !== 'train-seat') throw new TypeError('An alight leg requires a canonical train seat.');
  const service = matchingDwelling(services, contract, seat.runId);
  if (!service) return { remaining, advanced: false };
  startIfPending(state, itinerary.id, leg, report, seat);
  const alighted = alightNpcRailPassenger(state, {
    runId: seat.runId, personId: entity.id, stationId: contract.destinationStationId,
    platformLocation: contract.platformLocation, serviceTick: service.serviceTick,
  });
  report.alights.push(clone(alighted));
  const finished = transitionNpcItinerary(state, itinerary.id, {
    type: NPC_ITINERARY_TRANSITION.complete, legId: leg.id,
    details: { runId: seat.runId, stationId: service.stationId, worldHours: hours },
    location: contract.platformLocation,
  });
  report.transitions.push(clone(finished.receipt));
  return { remaining, advanced: true };
}

function legContract(leg, itinerary, entity) {
  const data = leg.data || {};
  if ([ITINERARY_LEG_KIND.localWalk, ITINERARY_LEG_KIND.regionalWalk].includes(leg.kind)) {
    const fromLocation = optionalLocation(data.fromLocation) || normalizeNpcLocation(entity.location);
    const toLocation = optionalLocation(data.toLocation)
      || (leg.direction === 'return' && itinerary.legIndex === itinerary.legs.length - 1
        ? homeLocation(itinerary.residence) : null);
    if (!fromLocation || !toLocation) throw new TypeError(`Movement leg ${leg.id} requires canonical fromLocation and toLocation.`);
    if (leg.direction === 'return' && itinerary.legIndex === itinerary.legs.length - 1
        && !isHome(toLocation, itinerary.residence)) {
      throw new TypeError('The final return leg must end at the original home building.');
    }
    const durationSeconds = positiveDuration(data.durationSeconds, leg.id);
    let edgeLocation = null;
    if (leg.kind === ITINERARY_LEG_KIND.regionalWalk) {
      edgeLocation = optionalLocation(data.edgeLocation);
      if (!edgeLocation || edgeLocation.kind !== 'regional-edge') {
        throw new TypeError(`Regional walk ${leg.id} requires canonical edgeLocation.`);
      }
    }
    return { fromLocation, toLocation, edgeLocation, durationSeconds };
  }
  if (leg.kind === ITINERARY_LEG_KIND.destinationActivity) {
    return {
      fromLocation: normalizeNpcLocation(entity.location),
      toLocation: optionalLocation(data.location) || normalizeNpcLocation(entity.location),
      durationSeconds: nonNegativeDuration(data.durationSeconds ?? 0, leg.id),
    };
  }
  if (leg.kind === ITINERARY_LEG_KIND.stationWait || leg.kind === ITINERARY_LEG_KIND.boardTrain) {
    const platformLocation = optionalLocation(data.platformLocation) || normalizeNpcLocation(entity.location);
    const originStationId = requiredId(data.originStationId ?? data.stationId, 'originStationId');
    if (!platformLocation || platformLocation.kind !== 'station-platform'
        || platformLocation.stationId !== originStationId) {
      throw new TypeError(`${leg.kind} requires its canonical origin platform location.`);
    }
    return {
      platformLocation, originStationId,
      destinationStationId: leg.kind === ITINERARY_LEG_KIND.boardTrain
        ? requiredId(data.destinationStationId, 'destinationStationId') : optionalId(data.destinationStationId),
      serviceId: optionalId(data.serviceId),
    };
  }
  if (leg.kind === ITINERARY_LEG_KIND.trainRide || leg.kind === ITINERARY_LEG_KIND.alightTrain) {
    const destinationStationId = requiredId(data.destinationStationId ?? data.toStationId ?? data.stationId, 'destinationStationId');
    const platformLocation = leg.kind === ITINERARY_LEG_KIND.alightTrain
      ? optionalLocation(data.platformLocation) : null;
    if (leg.kind === ITINERARY_LEG_KIND.alightTrain
        && (!platformLocation || platformLocation.kind !== 'station-platform'
          || platformLocation.stationId !== destinationStationId)) {
      throw new TypeError('alight-train requires its canonical destination platform location.');
    }
    return { destinationStationId, platformLocation, serviceId: optionalId(data.serviceId) };
  }
  return {};
}

// Validate all explicit future route data before consuming any part of a tick.
// Context-derived locations are checked again when their leg becomes current.
function preflightItinerary(itinerary) {
  for (const [index, leg] of itinerary.legs.entries()) {
    const data = leg.data || {};
    for (const field of ['fromLocation', 'toLocation', 'edgeLocation', 'location', 'platformLocation']) {
      if (data[field] != null && !normalizeNpcLocation(data[field])) {
        throw new TypeError(`Malformed canonical itinerary location on leg ${leg.id}.`);
      }
    }
    if ([ITINERARY_LEG_KIND.localWalk, ITINERARY_LEG_KIND.regionalWalk].includes(leg.kind)) {
      positiveDuration(data.durationSeconds, leg.id);
      const finalReturn = leg.direction === 'return' && index === itinerary.legs.length - 1;
      if (data.toLocation == null && !finalReturn) {
        throw new TypeError(`Movement leg ${leg.id} requires canonical toLocation.`);
      }
      if (leg.kind === ITINERARY_LEG_KIND.regionalWalk
          && normalizeNpcLocation(data.edgeLocation)?.kind !== 'regional-edge') {
        throw new TypeError(`Regional walk ${leg.id} requires canonical edgeLocation.`);
      }
      if (finalReturn
          && data.toLocation != null && !isHome(normalizeNpcLocation(data.toLocation), itinerary.residence)) {
        throw new TypeError('The final return leg must end at the original home building.');
      }
    } else if (leg.kind === ITINERARY_LEG_KIND.destinationActivity) {
      nonNegativeDuration(data.durationSeconds ?? 0, leg.id);
    } else if ([ITINERARY_LEG_KIND.stationWait, ITINERARY_LEG_KIND.boardTrain].includes(leg.kind)
        && data.platformLocation != null) {
      const stationId = requiredId(data.originStationId ?? data.stationId, 'originStationId');
      const platform = normalizeNpcLocation(data.platformLocation);
      if (platform.kind !== 'station-platform' || platform.stationId !== stationId) {
        throw new TypeError(`${leg.kind} requires its canonical origin platform location.`);
      }
    } else if (leg.kind === ITINERARY_LEG_KIND.alightTrain) {
      const stationId = requiredId(data.destinationStationId ?? data.toStationId ?? data.stationId, 'destinationStationId');
      const platform = normalizeNpcLocation(data.platformLocation);
      if (!platform || platform.kind !== 'station-platform' || platform.stationId !== stationId) {
        throw new TypeError('alight-train requires its canonical destination platform location.');
      }
    }
  }
}

function movementLocation(leg, contract, progress, fallback) {
  if (progress + EPSILON >= 1) return contract.toLocation;
  if (leg.kind !== ITINERARY_LEG_KIND.regionalWalk) return contract.fromLocation || fallback;
  return { ...contract.edgeLocation, progress };
}

function startIfPending(state, itineraryId, leg, report, location) {
  if (leg.status === ITINERARY_LEG_STATUS.active) return;
  if (leg.status !== ITINERARY_LEG_STATUS.pending) throw new Error(`Cannot execute ${leg.id} from ${leg.status}.`);
  const started = transitionNpcItinerary(state, itineraryId, {
    type: NPC_ITINERARY_TRANSITION.start, legId: leg.id,
    details: { executor: 'deterministic' }, location,
  });
  report.transitions.push(clone(started.receipt));
}

function publishProgress(state, entity, itineraryId, leg, executor, location) {
  const canonical = normalizeNpcLocation(location);
  if (!canonical) throw new TypeError(`Executor produced an invalid location for ${leg.id}.`);
  const before = JSON.stringify([entity.activity, entity.location]);
  entity.location = { ...canonical };
  entity.activity = {
    kind: 'itinerary', itineraryId, status: 'active',
    legKind: leg.kind, direction: leg.direction,
    executor: { legId: leg.id, ...executor },
  };
  if (before !== JSON.stringify([entity.activity, entity.location])) incrementRevision(state);
}

function executorProgress(entity, legId) {
  const value = entity?.activity?.executor;
  if (!value || value.legId !== legId) return null;
  const elapsed = Number(value.elapsedSeconds);
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new TypeError('Malformed persisted itinerary executor progress.');
  return value;
}

function matchingDwelling(services, contract, runId) {
  return services.find((service) => service.phase === 'dwelling'
    && service.stationId === (contract.originStationId ?? contract.destinationStationId)
    && (!contract.serviceId || service.serviceId === contract.serviceId)
    && (!runId || service.runId === runId)) || null;
}

function normalizeServices(values) {
  if (!Array.isArray(values)) throw new TypeError('railServices must be an array.');
  return values.map((value) => {
    if (!value || typeof value !== 'object') throw new TypeError('Malformed rail service descriptor.');
    return {
      serviceId: optionalId(value.serviceId),
      runId: requiredId(value.runId, 'runId'),
      phase: requiredId(value.phase, 'phase'),
      stationId: requiredId(value.stationId, 'stationId'),
      serviceTick: value.serviceTick == null ? null : finiteNonNegative(value.serviceTick, 'serviceTick'),
    };
  });
}

function requireActor(state, actorId) {
  const id = requiredId(actorId, 'actorId');
  const entity = state?.entities?.[id];
  if (!entity || entity.kind !== 'npc' || entity.tombstone) throw new TypeError(`Unknown active NPC ${id}.`);
  if (!normalizeNpcResidence(entity.residence) || !normalizeNpcLocation(entity.location)) {
    throw new TypeError(`NPC ${id} has no canonical spatial state.`);
  }
  return entity;
}

function requireFeatures(state) {
  if (state?.features?.unifiedNpcMobilityEnabled !== true) throw new Error('Unified NPC mobility is disabled.');
}

function requireItineraryFeatures(state, itinerary) {
  const rail = itinerary.legs.some((leg) => ['board-train', 'train-ride', 'alight-train'].includes(leg.kind));
  const leisure = itinerary.purpose?.kind === 'leisure'
    || itinerary.legs.some((leg) => leg.kind === 'destination-activity' && leg.data?.activityKind === 'leisure');
  if (rail && state.features?.npcRailTravelEnabled !== true) throw new Error('NPC rail travel is disabled.');
  if (leisure && state.features?.npcLeisureTravelEnabled !== true) throw new Error('NPC leisure travel is disabled.');
}

function homeLocation(residence) {
  if (!residence.homeBuildingId) throw new TypeError('A return-home itinerary requires a home building.');
  return { kind: 'building', settlementId: residence.residenceSettlementId, buildingId: residence.homeBuildingId, nodeId: null };
}

function isHome(location, residence) {
  return location.kind === 'building' && location.settlementId === residence.residenceSettlementId
    && location.buildingId === residence.homeBuildingId;
}

function optionalLocation(value) {
  if (value == null) return null;
  const location = normalizeNpcLocation(value);
  if (!location) throw new TypeError('Malformed canonical itinerary location.');
  return location;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) throw new TypeError(`${label} is required.`);
  return value;
}

function optionalId(value) {
  return value == null ? null : requiredId(value, 'identifier');
}

function positiveDuration(value, legId) {
  const duration = nonNegativeDuration(value, legId);
  if (duration <= 0) throw new TypeError(`Movement leg ${legId} requires positive durationSeconds.`);
  return duration;
}

function nonNegativeDuration(value, legId) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) throw new TypeError(`Leg ${legId} has invalid durationSeconds.`);
  return duration;
}

function finiteNonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${label} must be finite and non-negative.`);
  return number;
}

function incrementRevision(state) {
  state.revision = Math.max(0, Math.floor(Number(state.revision) || 0)) + 1;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
