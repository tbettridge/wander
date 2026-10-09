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
  railVehiclePassengerManifest,
  reserveNpcRailPassenger,
  reserveNpcRailParty,
  seatNpcRailPassenger,
  standNpcRailPassenger,
  transitionNpcItinerary,
} from './npcmobility.mjs';
import {
  advanceNpcRailTransfer,
  createNpcRailTransfer,
  NPC_RAIL_PHASE,
  NPC_RAIL_TIMING,
  npcRailDoorPassable,
} from './npcrailtransfer.mjs';
import { sameRailVehicle } from './railpassengers.mjs';

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
  walkDurationFor = null,
} = {}) {
  const dt = finiteNonNegative(deltaSeconds, 'deltaSeconds');
  const hours = finiteNonNegative(worldHours, 'worldHours');
  const descriptors = normalizeServices(railServices);
  const entity = requireActor(state, actorId);
  requireFeatures(state);
  const residenceBefore = JSON.stringify(entity.residence);
  let itinerary = activeNpcItinerary(state, entity.id);
  const services = descriptors.filter((service) => !itinerary?.purpose?.vehicleId
    || sameRailVehicle(service.runId, itinerary.purpose.vehicleId));
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
      state, entity, itinerary, leg, contract, services, remaining, hours, report, walkDurationFor,
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

/**
 * Tick every active NPC in stable identity order.
 *
 * `skipActorIds` holds an actor where they are for this tick without touching
 * their itinerary: the caller uses it for someone the player is speaking to,
 * whose leg boundary would otherwise relocate them mid-sentence. Their journey
 * resumes from the same leg, later, rather than being cancelled.
 */
export function tickAllNpcMobilityItineraries(state, options = {}) {
  const { skipActorIds = [], onError = null, ...tickOptions } = options;
  const held = new Set(Array.isArray(skipActorIds) ? skipActorIds : [skipActorIds]);
  for (const group of Object.values(state.groups || {})) {
    if (group.transport !== 'rail' || group.state === 'dissolved') continue;
    const admitted = group.memberIds.some((id) => ['train-seat', 'train-carriage'].includes(state.entities[id]?.location?.kind)
      || state.entities[id]?.activity?.executor?.railTransfer?.phase === 'crossing-in');
    if (!admitted && group.memberIds.some((id) => held.has(id))) {
      for (const id of group.memberIds) held.add(id);
    } else if (admitted) {
      for (const id of group.memberIds) {
        if (state.entities[id]?.activity?.legKind === 'board-train') held.delete(id);
      }
    }
  }
  return Object.values(state?.entities || {})
    .filter((entity) => entity?.kind === 'npc' && entity.itineraryId && !entity.tombstone)
    // A conversation may hold a waiting traveller, but never freeze a body in
    // a doorway or leave it attached to a train whose clock keeps advancing.
    .filter((entity) => !held.has(entity.id) || ['train-seat', 'train-carriage'].includes(entity.location?.kind)
      || ['crossing-in', 'crossing-out'].includes(entity.activity?.executor?.railTransfer?.phase))
    .sort((a, b) => mobilityTickPriority(state, a) - mobilityTickPriority(state, b)
      || String(a.id).localeCompare(String(b.id)))
    .map((entity) => {
      try { return tickNpcMobilityItinerary(state, entity.id, tickOptions); }
      catch (error) {
        onError?.(error, entity.id);
        return { actorId: entity.id, itineraryId: entity.itineraryId, transitions: [],
          reservations: [], boards: [], alights: [], completed: false, error: String(error.message || error) };
      }
    });
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

function executeTimed({ state, entity, itinerary, leg, contract, remaining, hours, report, walkDurationFor }) {
  startIfPending(state, itinerary.id, leg, report, contract.fromLocation);
  const restored = executorProgress(entity, leg.id);
  const group = itinerary.purpose?.groupId && state.groups?.[itinerary.purpose.groupId];
  if (leg.kind === 'destination-activity' && group?.transport === 'rail'
    && group.memberIds.some((id) => {
      const other = activeNpcItinerary(state, id);
      return other && currentItineraryLeg(other)?.direction === 'outbound';
    })) {
    report.waiting = { reason: 'party-arrival', groupId: group.id };
    return { remaining: 0, advanced: false };
  }
  if (contract.durationHours != null) {
    const startedAtHour = restored?.startedAtHour ?? hours;
    const progress = Math.min(1, Math.max(0, hours - startedAtHour) / Math.max(EPSILON, contract.durationHours));
    publishProgress(state, entity, itinerary.id, leg, {
      elapsedSeconds: (restored?.elapsedSeconds || 0) + remaining,
      startedAtHour, durationHours: contract.durationHours, progress, worldHours: hours,
      fromLocation: contract.fromLocation, toLocation: contract.toLocation,
    }, contract.toLocation);
    if (progress + EPSILON < 1) return { remaining: 0, advanced: false };
    const finished = transitionNpcItinerary(state, itinerary.id, {
      type: NPC_ITINERARY_TRANSITION.complete, legId: leg.id,
      details: { executor: 'deterministic', worldHours: hours }, location: contract.toLocation,
    });
    report.transitions.push(clone(finished.receipt));
    return { remaining: 0, advanced: true };
  }
  const physicalDuration = leg.kind === ITINERARY_LEG_KIND.localWalk && walkDurationFor
    ? positiveDuration(walkDurationFor(contract.fromLocation, contract.toLocation, entity), leg.id) : 0;
  const durationSeconds = Math.max(contract.durationSeconds, restored?.durationSeconds || 0, physicalDuration);
  // Repair old ten-second transfers without rewinding somebody already visible.
  const priorDuration = restored?.durationSeconds || contract.durationSeconds;
  const elapsedBefore = restored && durationSeconds !== priorDuration
    ? Math.max(0, Math.min(1, restored.progress ?? restored.elapsedSeconds / priorDuration)) * durationSeconds
    : restored?.elapsedSeconds ?? 0;
  const spend = Math.min(remaining, Math.max(0, durationSeconds - elapsedBefore));
  const elapsed = Math.min(durationSeconds, elapsedBefore + spend);
  const progress = durationSeconds === 0 ? 1 : elapsed / durationSeconds;
  const location = movementLocation(leg, contract, progress, entity.location);
  publishProgress(state, entity, itinerary.id, leg, {
    elapsedSeconds: elapsed, durationSeconds,
    progress, worldHours: hours,
    fromLocation: contract.fromLocation, toLocation: contract.toLocation,
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
  let persistedTransfer = restoredRailTransfer(entity, leg.id);
  const service = persistedTransfer
    ? services.find((candidate) => sameRailVehicle(candidate.runId, persistedTransfer.runId)) || null
    : matchingDwelling(services, contract, null);
  if (!service) {
    report.waiting = { reason: 'service', stationId: contract.originStationId };
    return { remaining, advanced: false };
  }
  let reservation = persistedTransfer
    ? railPassengerManifest(state, persistedTransfer.runId)?.reservationForPerson(entity.id)
    : null;
  if (reservation?.status === 'cancelled') {
    if (service.phase !== 'dwelling' || service.stationId !== contract.originStationId) {
      report.waiting = { reason: 'service', stationId: contract.originStationId };
      return { remaining: 0, advanced: false };
    }
    reservation = null;
    persistedTransfer = null; // Approach the newly allocated door from the body's current platform position.
  }
  const group = itinerary.purpose?.groupId && state.groups?.[itinerary.purpose.groupId];
  if (!persistedTransfer && group?.transport === 'rail') {
    const members = group.memberIds.map((id) => state.entities?.[id]);
    const ready = members.every((member) => {
      const other = member && activeNpcItinerary(state, member.id);
      const next = other && currentItineraryLeg(other);
      if (['train-seat', 'train-carriage'].includes(member?.location?.kind)
        && sameRailVehicle(member.location.runId, service.runId)) return true;
      return member?.location?.kind === 'station-platform'
        && member.location.stationId === contract.originStationId
        && ['station-wait', 'board-train'].includes(next?.kind);
    });
    if (!ready) {
      report.waiting = { reason: 'party', groupId: group.id };
      return { remaining: 0, advanced: false };
    }
  }
  try {
    if (!reservation && group?.transport === 'rail') {
      const reservations = reserveNpcRailParty(state, {
        runId: service.runId, originStationId: contract.originStationId,
        destinationStationId: contract.destinationStationId,
        members: group.memberIds.map((id) => ({ personId: id,
          accommodation: activeNpcItinerary(state, id)?.purpose?.accommodation || 'seat',
          preferredCarriage: state.entities[id]?.activity?.executor?.railTransfer?.carriageIndex ?? null })),
      });
      reservation = reservations.find((entry) => entry.personId === entity.id);
    }
    reservation ||= reserveNpcRailPassenger(state, {
      runId: service.runId, personId: entity.id,
      originStationId: contract.originStationId,
      destinationStationId: contract.destinationStationId,
      accommodation: itinerary.purpose?.accommodation || 'seat',
      preferredCarriage: entity.activity?.executor?.railTransfer?.carriageIndex ?? null,
    });
  } catch (error) {
    if (!/seat is available|place is available|capacity is full/.test(String(error?.message))) throw error;
    report.waiting = { reason: 'capacity', runId: service.runId };
    return { remaining, advanced: false };
  }
  report.reservations.push(clone(reservation));
  const approach = !persistedTransfer ? service.boardingApproachFor?.(entity, reservation, contract.platformLocation) : null;
  startIfPending(state, itinerary.id, leg, report, contract.platformLocation);
  let transfer = persistedTransfer || createNpcRailTransfer({
    runId: reservation.runId, stationId: contract.originStationId,
    reservationId: reservation.reservationId,
    carriageIndex: reservation.carriageIndex, seatIndex: reservation.seatIndex,
    platformId: contract.platformLocation.platformId,
    side: platformSide(contract.platformLocation.platformId),
    standingIndex: reservation.standingIndex ?? null,
    queueIndex: reservation.seatIndex ?? reservation.standingIndex ?? 0,
    ...(approach || {}),
  });
  let available = remaining;
  let advanced = false;
  for (let guard = 0; guard < 8; guard++) {
    if (transfer.phase === NPC_RAIL_PHASE.platformQueue) {
      if (service.phase !== 'dwelling' || service.stationId !== contract.originStationId) {
        report.waiting = { reason: 'service', stationId: contract.originStationId };
        break;
      }
      const step = advanceNpcRailTransfer(transfer, available,
        transfer.approachDurationSeconds ?? NPC_RAIL_TIMING.platformQueue,
        NPC_RAIL_PHASE.waitingForDoor);
      transfer = step.transfer; available -= step.consumed; advanced ||= step.consumed > 0;
      publishRailProgress(state, entity, itinerary.id, leg, transfer, hours, contract.platformLocation);
      if (!step.complete) break;
      continue;
    }
    if (transfer.phase === NPC_RAIL_PHASE.waitingForDoor) {
      const partyReady = !group || group.transport !== 'rail' || group.memberIds.every((id) => {
        const member = state.entities[id];
        if (['train-seat', 'train-carriage'].includes(member?.location?.kind)) return true;
        const motion = member?.activity?.executor?.railTransfer;
        const currentReservation = railVehiclePassengerManifest(state, transfer.runId).reservationForPerson(id);
        return motion && sameRailVehicle(motion.runId, transfer.runId)
          && motion.reservationId === currentReservation?.reservationId
          && motion.stationId === transfer.stationId && motion.phase !== NPC_RAIL_PHASE.platformQueue;
      });
      const partyStarted = group?.memberIds.some((id) => ['train-seat', 'train-carriage'].includes(state.entities[id]?.location?.kind)
        || state.entities[id]?.activity?.executor?.railTransfer?.phase === NPC_RAIL_PHASE.crossingIn);
      const partyBudget = group?.transport === 'rail' && !partyStarted ? 6 : 3;
      const aboard = railVehiclePassengerManifest(state, transfer.runId).reservations({ includeAlighted: false })
        .filter((r) => r.kind === 'npc' && r.status === 'boarded').length;
      const crossing = Object.values(state.entities || {}).filter((other) => {
        const motion = other.activity?.executor?.railTransfer;
        return other.id !== entity.id && motion?.phase === NPC_RAIL_PHASE.crossingIn
          && sameRailVehicle(motion.runId, transfer.runId);
      }).length;
      // An already admitted family finishes together. An empty quiet service
      // may admit one whole family, but never exceeds six people in total.
      const demandLimit = group?.transport === 'rail' && aboard + crossing === 0
        ? Math.max(service.npcPassengerLimit ?? 6, group.memberIds.length) : (service.npcPassengerLimit ?? 6);
      const partySize = group?.transport === 'rail' ? group.memberIds.length : 1;
      const demandFull = !partyStarted && aboard + crossing + partySize > demandLimit;
      if (service.phase !== 'dwelling' || service.stationId !== contract.originStationId
          || !npcRailDoorPassable(service.doorFactor)
          || !partyReady || demandFull || (service.dwellRemaining != null && service.dwellRemaining < partyBudget)
          || (leg.data?.doorQueue && railDoorBusy(state, transfer, entity.id, true))) {
        report.waiting = { reason: 'door', runId: service.runId };
        publishRailProgress(state, entity, itinerary.id, leg, transfer, hours, contract.platformLocation);
        available = 0;
        break;
      }
      transfer = resetRailPhase(transfer, NPC_RAIL_PHASE.crossingIn);
      publishRailProgress(state, entity, itinerary.id, leg, transfer, hours, contract.platformLocation);
      continue;
    }
    if (transfer.phase === NPC_RAIL_PHASE.crossingIn) {
      const step = advanceNpcRailTransfer(transfer, available, NPC_RAIL_TIMING.crossingIn,
        NPC_RAIL_PHASE.walkingToSeat);
      transfer = step.transfer; available -= step.consumed; advanced ||= step.consumed > 0;
      if (step.complete) {
        const boarded = boardNpcRailPassenger(state, {
          runId: reservation.runId, personId: entity.id,
          stationId: contract.originStationId, serviceTick: service.serviceTick,
        });
        report.boards.push(clone(boarded));
        publishRailProgress(state, entity, itinerary.id, leg, transfer, hours, boarded.location);
        continue;
      }
      publishRailProgress(state, entity, itinerary.id, leg, transfer, hours, contract.platformLocation);
      break;
    }
    if (transfer.phase === NPC_RAIL_PHASE.walkingToSeat) {
      const step = advanceNpcRailTransfer(transfer, available,
        reservation.accommodation === 'standing' ? 3 : NPC_RAIL_TIMING.walkingToSeat,
        reservation.accommodation === 'standing' ? NPC_RAIL_PHASE.ridingStanding : NPC_RAIL_PHASE.sitting);
      transfer = step.transfer; available -= step.consumed; advanced ||= step.consumed > 0;
      publishRailProgress(state, entity, itinerary.id, leg, transfer, hours,
        carriageLocation(reservation.runId, reservation, 'aisle'));
      if (!step.complete) break;
      if (reservation.accommodation === 'standing') {
        const standing = standNpcRailPassenger(state, { runId: reservation.runId,
          personId: entity.id, zoneId: `standing:${reservation.standingIndex}` });
        publishRailProgress(state, entity, itinerary.id, leg, transfer, hours, standing.location);
        const finished = transitionNpcItinerary(state, itinerary.id, {
          type: NPC_ITINERARY_TRANSITION.complete, legId: leg.id,
          details: { runId: reservation.runId, reservationId: reservation.reservationId, worldHours: hours },
          location: standing.location,
        });
        report.transitions.push(clone(finished.receipt));
        return { remaining: available, advanced: true };
      }
      continue;
    }
    if (transfer.phase === NPC_RAIL_PHASE.sitting) {
      const step = advanceNpcRailTransfer(transfer, available, NPC_RAIL_TIMING.sitting,
        NPC_RAIL_PHASE.seated);
      transfer = step.transfer; available -= step.consumed; advanced ||= step.consumed > 0;
      if (!step.complete) {
        publishRailProgress(state, entity, itinerary.id, leg, transfer, hours,
          carriageLocation(reservation.runId, reservation, 'seat-approach'));
        break;
      }
      const seated = seatNpcRailPassenger(state, { runId: reservation.runId, personId: entity.id });
      publishRailProgress(state, entity, itinerary.id, leg, transfer, hours, seated.location);
      const finished = transitionNpcItinerary(state, itinerary.id, {
        type: NPC_ITINERARY_TRANSITION.complete, legId: leg.id,
        details: { runId: reservation.runId, reservationId: reservation.reservationId, worldHours: hours },
        location: seated.location,
      });
      report.transitions.push(clone(finished.receipt));
      return { remaining: available, advanced: true };
    }
    throw new TypeError(`Invalid boarding phase ${transfer.phase}.`);
  }
  return { remaining: available, advanced };
}

function executeRide({ state, entity, itinerary, leg, contract, services, remaining, hours, report }) {
  const aboard = normalizeNpcLocation(entity.location);
  if (!aboard || !['train-seat', 'train-carriage'].includes(aboard.kind)) {
    throw new TypeError('A train-ride leg requires a canonical place aboard the train.');
  }
  const manifest = railPassengerManifest(state, aboard.runId);
  const reservation = manifest?.reservationForPerson(entity.id);
  if (!reservation || reservation.status !== 'boarded'
      || reservation.destinationStationId !== contract.destinationStationId
      || aboard.carriageId !== `carriage:${reservation.carriageIndex}`
      || aboard.seatId !== (reservation.seatIndex == null ? null : `seat:${reservation.seatIndex}`)) {
    throw new TypeError('The train-ride leg does not match the exact reserved seat.');
  }
  startIfPending(state, itinerary.id, leg, report, aboard);
  let transfer = restoredRailTransfer(entity, leg.id) || createNpcRailTransfer({
    runId: aboard.runId, stationId: contract.destinationStationId,
    reservationId: reservation.reservationId,
    carriageIndex: reservation.carriageIndex, seatIndex: reservation.seatIndex,
    standingIndex: reservation.standingIndex ?? null,
    platformId: `platform:${contract.destinationStationId}:main`, side: 1,
    queueIndex: reservation.seatIndex ?? reservation.standingIndex ?? 0,
    phase: reservation.accommodation === 'standing' ? NPC_RAIL_PHASE.ridingStanding : NPC_RAIL_PHASE.seated,
  });
  const service = matchingArrival(services, contract, aboard.runId);
  if (!service) {
    publishRailProgress(state, entity, itinerary.id, leg, transfer, hours, aboard);
    return { remaining: 0, advanced: remaining > 0 };
  }
  let available = remaining;
  let advanced = false;
  if (transfer.phase === NPC_RAIL_PHASE.ridingStanding) {
    transfer = resetRailPhase(transfer, NPC_RAIL_PHASE.walkingToDoor);
  }
  if (transfer.phase === NPC_RAIL_PHASE.seated) {
    transfer = resetRailPhase(transfer, NPC_RAIL_PHASE.standing);
    standNpcRailPassenger(state, { runId: aboard.runId, personId: entity.id, zoneId: 'seat-approach' });
  }
  if (transfer.phase === NPC_RAIL_PHASE.standing) {
    const step = advanceNpcRailTransfer(transfer, available, NPC_RAIL_TIMING.standing,
      NPC_RAIL_PHASE.walkingToDoor);
    transfer = step.transfer; available -= step.consumed; advanced ||= step.consumed > 0;
    publishRailProgress(state, entity, itinerary.id, leg, transfer, hours,
      carriageLocation(aboard.runId, reservation, 'aisle'));
    if (!step.complete) return { remaining: available, advanced };
  }
  if (transfer.phase === NPC_RAIL_PHASE.walkingToDoor) {
    const step = advanceNpcRailTransfer(transfer, available, NPC_RAIL_TIMING.walkingToDoor,
      NPC_RAIL_PHASE.interiorQueue);
    transfer = step.transfer; available -= step.consumed; advanced ||= step.consumed > 0;
    publishRailProgress(state, entity, itinerary.id, leg, transfer, hours,
      carriageLocation(aboard.runId, reservation, 'door-queue'));
    if (!step.complete) return { remaining: available, advanced };
  }
  if (service.phase !== 'dwelling' || service.stationId !== contract.destinationStationId) {
    publishRailProgress(state, entity, itinerary.id, leg, transfer, hours,
      carriageLocation(aboard.runId, reservation, 'door-queue'));
    return { remaining: 0, advanced: advanced || remaining > 0 };
  }
  const finished = transitionNpcItinerary(state, itinerary.id, {
    type: NPC_ITINERARY_TRANSITION.complete, legId: leg.id,
    details: { runId: aboard.runId, stationId: service.stationId, worldHours: hours },
    location: carriageLocation(aboard.runId, reservation, 'door-queue'),
  });
  report.transitions.push(clone(finished.receipt));
  return { remaining: available, advanced: true };
}

function executeAlight({ state, entity, itinerary, leg, contract, services, remaining, hours, report }) {
  const aboard = normalizeNpcLocation(entity.location);
  const persistedTransfer = restoredRailTransfer(entity, leg.id);
  const continuingEgress = aboard?.kind === 'station-platform'
    && persistedTransfer?.phase === NPC_RAIL_PHASE.platformEgress;
  if (!aboard || (aboard.kind !== 'train-carriage' && !continuingEgress)) {
    throw new TypeError('An alight leg requires a canonical position at the train door.');
  }
  const runId = persistedTransfer?.runId || aboard.runId;
  const manifest = railPassengerManifest(state, runId);
  const reservation = manifest?.reservationForPerson(entity.id);
  if (!reservation || !['boarded', 'alighted'].includes(reservation.status)) {
    throw new TypeError('Alighting passenger has no matching rail reservation.');
  }
  startIfPending(state, itinerary.id, leg, report, aboard);
  let transfer = persistedTransfer || createNpcRailTransfer({
    runId, stationId: contract.destinationStationId,
    reservationId: reservation.reservationId,
    carriageIndex: reservation.carriageIndex, seatIndex: reservation.seatIndex,
    standingIndex: reservation.standingIndex ?? null,
    platformId: contract.platformLocation.platformId,
    side: platformSide(contract.platformLocation.platformId),
    queueIndex: reservation.seatIndex ?? reservation.standingIndex ?? 0, phase: NPC_RAIL_PHASE.interiorQueue,
  });
  const service = matchingDwelling(services, contract, runId);
  if (transfer.phase !== NPC_RAIL_PHASE.platformEgress && !service) {
    return { remaining, advanced: false };
  }
  if (transfer.phase !== NPC_RAIL_PHASE.platformEgress
      && !npcRailDoorPassable(service?.doorFactor)) {
    report.waiting = { reason: 'door', runId };
    publishRailProgress(state, entity, itinerary.id, leg, transfer, hours, aboard);
    return { remaining: 0, advanced: remaining > 0 };
  }
  let available = remaining;
  if (transfer.phase === NPC_RAIL_PHASE.interiorQueue) {
    if (leg.data?.doorQueue && railDoorBusy(state, transfer, entity.id, false)) {
      report.waiting = { reason: 'door-queue', runId };
      publishRailProgress(state, entity, itinerary.id, leg, transfer, hours, aboard);
      return { remaining: 0, advanced: false };
    }
    const egress = service.alightingEgressFor?.(entity, reservation, contract.platformLocation);
    if (egress) transfer = { ...transfer, ...egress };
    transfer = resetRailPhase(transfer, NPC_RAIL_PHASE.crossingOut);
  }
  if (transfer.phase === NPC_RAIL_PHASE.crossingOut) {
    const step = advanceNpcRailTransfer(transfer, available, NPC_RAIL_TIMING.crossingOut,
      NPC_RAIL_PHASE.platformEgress);
    transfer = step.transfer; available -= step.consumed;
    if (!step.complete) {
      publishRailProgress(state, entity, itinerary.id, leg, transfer, hours, aboard);
      return { remaining: available, advanced: step.consumed > 0 };
    }
    const alighted = alightNpcRailPassenger(state, {
      runId, personId: entity.id, stationId: contract.destinationStationId,
      platformLocation: contract.platformLocation, serviceTick: service?.serviceTick,
    });
    report.alights.push(clone(alighted));
    publishRailProgress(state, entity, itinerary.id, leg, transfer, hours, alighted.location);
  }
  const step = advanceNpcRailTransfer(transfer, available, transfer.egressDurationSeconds ?? NPC_RAIL_TIMING.platformEgress);
  transfer = step.transfer; available -= step.consumed;
  publishRailProgress(state, entity, itinerary.id, leg, transfer, hours, contract.platformLocation);
  if (!step.complete) return { remaining: available, advanced: step.consumed > 0 };
  const finished = transitionNpcItinerary(state, itinerary.id, {
    type: NPC_ITINERARY_TRANSITION.complete, legId: leg.id,
    details: { runId, stationId: contract.destinationStationId, worldHours: hours },
    location: contract.platformLocation,
  });
  report.transitions.push(clone(finished.receipt));
  return { remaining: available, advanced: true };
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
      ...(data.durationHours == null ? {} : { durationHours: finiteNonNegative(data.durationHours, 'durationHours') }),
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
      if (data.durationHours != null) finiteNonNegative(data.durationHours, 'durationHours');
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

function restoredRailTransfer(entity, legId) {
  const value = executorProgress(entity, legId)?.railTransfer;
  return value ? createNpcRailTransfer(value) : null;
}

function publishRailProgress(state, entity, itineraryId, leg, railTransfer, worldHours, location) {
  publishProgress(state, entity, itineraryId, leg, {
    elapsedSeconds: railTransfer.elapsedSeconds,
    progress: railTransfer.progress,
    worldHours,
    railTransfer: clone(railTransfer),
  }, location);
}

function resetRailPhase(transfer, phase) {
  return { ...transfer, phase, elapsedSeconds: 0, progress: 0 };
}

function carriageLocation(runId, reservation, zoneId) {
  return {
    kind: 'train-carriage', runId,
    carriageId: `carriage:${reservation.carriageIndex}`,
    zoneId, seatId: reservation.seatIndex == null ? null : `seat:${reservation.seatIndex}`,
  };
}

function platformSide(platformId) {
  return /opposite|far|south|west/i.test(String(platformId)) ? -1 : 1;
}

function matchingDwelling(services, contract, runId) {
  return services.find((service) => service.phase === 'dwelling'
    && service.stationId === (contract.originStationId ?? contract.destinationStationId)
    && (!contract.serviceId || service.serviceId === contract.serviceId)
    && (!runId || sameRailVehicle(service.runId, runId))) || null;
}

function matchingArrival(services, contract, runId) {
  const stationId = contract.destinationStationId;
  return services.find((service) => sameRailVehicle(service.runId, runId)
    && (!contract.serviceId || service.serviceId === contract.serviceId)
    && ((service.phase === 'dwelling' && service.stationId === stationId)
      || (service.nextStationId === stationId
        && service.etaSeconds != null
        && service.etaSeconds <= NPC_RAIL_TIMING.prepareToAlightSeconds))) || null;
}

function normalizeServices(values) {
  if (!Array.isArray(values)) throw new TypeError('railServices must be an array.');
  return values.map((value) => {
    if (!value || typeof value !== 'object') throw new TypeError('Malformed rail service descriptor.');
    return {
      serviceId: optionalId(value.serviceId),
      runId: requiredId(value.runId, 'runId'),
      phase: requiredId(value.phase, 'phase'),
      stationId: optionalId(value.stationId ?? value.currentStationId),
      nextStationId: optionalId(value.nextStationId),
      etaSeconds: value.etaSeconds == null ? null : finiteNonNegative(value.etaSeconds, 'etaSeconds'),
      doorFactor: value.doorFactor == null
        ? (value.phase === 'dwelling' ? 1 : 0)
        : Math.max(0, Math.min(1, finiteNonNegative(value.doorFactor, 'doorFactor'))),
      serviceTick: value.serviceTick == null ? null : finiteNonNegative(value.serviceTick, 'serviceTick'),
      dwellRemaining: value.dwellRemaining == null ? null : finiteNonNegative(value.dwellRemaining, 'dwellRemaining'),
      npcPassengerLimit: value.npcPassengerLimit == null ? null : Math.min(6, finiteNonNegative(value.npcPassengerLimit, 'npcPassengerLimit')),
      boardingApproachFor: typeof value.boardingApproachFor === 'function' ? value.boardingApproachFor : null,
      alightingEgressFor: typeof value.alightingEgressFor === 'function' ? value.alightingEgressFor : null,
    };
  });
}

function railDoorBusy(state, transfer, actorId, boarding) {
  for (const other of Object.values(state.entities || {})) {
    if (other.id === actorId) continue;
    const motion = other.activity?.executor?.railTransfer;
    if (motion && sameRailVehicle(motion.runId, transfer.runId)
      && motion.carriageIndex === transfer.carriageIndex && motion.stationId === transfer.stationId
      && ['crossing-in', 'crossing-out'].includes(motion.phase)) return true;
  }
  if (!boarding) return false;
  return railVehiclePassengerManifest(state, transfer.runId).occupantsAtStop(transfer.stationId)
    .alighting.some((entry) => entry.carriageIndex === transfer.carriageIndex && entry.personId !== actorId);
}

function mobilityTickPriority(state, entity) {
  const kind = entity.activity?.legKind;
  if (kind === 'alight-train') return 0;
  if (kind === 'train-ride') return 1;
  if (kind === 'board-train' || kind === 'station-wait') {
    const snapshot = state.itineraries?.[entity.itineraryId];
    return (snapshot?.purpose || snapshot?.p)?.groupId ? 2 : 3;
  }
  return 4;
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
