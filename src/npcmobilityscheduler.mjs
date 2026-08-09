// Deterministic, renderer-free resident trip scheduling.
//
// The scheduler chooses among canonical residents already present in living-
// world state, builds round-trip itineraries through the shared route contract,
// and leaves movement/animation to runtime executors. It never creates people,
// reads wall-clock time, or owns train capacity.

import { createItinerary, ITINERARY_ACTIVITY_KIND } from './npcitinerary.mjs';
import { registerNpcItinerary } from './npcmobility.mjs';
import { selectMobilityCandidates } from './npcmobilitydemand.mjs';
import { planMultimodalRoute } from './npcmultimodalroute.mjs';
import { normalizeNpcLocation, normalizeNpcResidence } from './npclocation.mjs';

export const NPC_MOBILITY_SCHEDULER_VERSION = 1;
export const MAX_RESIDENT_TRIPS_PER_CADENCE = 4;

/**
 * Purely plan a bounded batch of resident round trips.
 *
 * `requests` are deterministic opportunities. Leisure requests select an
 * eligible resident from their origin settlement. Quest requests must name an
 * `actorId`, making authored quest assignment explicit rather than random.
 */
export function planResidentTripBatch(state, {
  worldSeed = state?.worldSeed ?? 1,
  dayIndex = 0,
  cadenceBucket = 0,
  requests = [],
  maxTrips = 1,
} = {}) {
  const cadence = normalizeCadence(dayIndex, cadenceBucket);
  const budget = boundedBudget(maxTrips);
  const result = {
    version: NPC_MOBILITY_SCHEDULER_VERSION,
    cadence,
    budget,
    trips: [],
    rejected: [],
  };
  if (state?.features?.unifiedNpcMobilityEnabled !== true) {
    result.reason = 'feature-disabled';
    return result;
  }

  const entities = state.entities || {};
  const committedActors = committedActorIds(state);
  const scheduledRequests = scheduledRequestIds(state, cadence);
  const remainingBudget = Math.max(0, budget - scheduledRequests.size);
  result.remainingBudget = remainingBudget;
  const assigned = new Set();
  const normalizedRequests = canonicalRequests(requests, worldSeed, cadence);
  for (const request of normalizedRequests) {
    if (result.trips.length >= remainingBudget) break;
    if (scheduledRequests.has(request.id)) {
      reject(result, request.id, 'already-scheduled');
      continue;
    }
    if (request.kind === ITINERARY_ACTIVITY_KIND.leisure
        && state.features?.npcLeisureTravelEnabled !== true) {
      reject(result, request.id, 'leisure-disabled');
      continue;
    }

    const eligible = eligibleResidents(entities, request, committedActors, assigned);
    const actor = selectActor(eligible, request, worldSeed, cadence);
    if (!actor) {
      reject(result, request.id, request.actorId ? 'actor-unavailable' : 'resident-shortage');
      continue;
    }

    const origin = canonicalEndpoint(request.origin || {
      kind: 'building',
      key: actor.residence.homeBuildingId || actor.residence.residenceSettlementId,
    }, 'origin');
    const destination = canonicalEndpoint(request.destination, 'destination');
    const route = planMultimodalRoute({
      ...plain(request.routing || {}),
      origin,
      destination,
      purposeKind: request.kind,
      departAt: request.departAt,
      deadlineAt: request.deadlineAt,
      includeReturn: true,
      // Disabling rail removes it from route choice, allowing a supplied direct
      // walk to win as a safe fallback without ever emitting gated rail legs.
      railway: state.features?.npcRailTravelEnabled === true
        ? request.routing?.railway
        : null,
    });
    if (!route.ok) {
      reject(result, request.id, route.reason, route);
      continue;
    }

    const itineraryId = residentTripItineraryId({
      worldSeed, dayIndex: cadence.dayIndex, cadenceBucket: cadence.cadenceBucket,
      requestId: request.id, actorId: actor.id,
    });
    const itinerary = createItinerary({
      id: itineraryId,
      actorId: actor.id,
      residence: actor.residence,
      origin,
      destination,
      activity: {
        kind: request.kind,
        data: {
          ...plain(request.activityData || {}),
          requestId: request.id,
          ...(request.kind === ITINERARY_ACTIVITY_KIND.quest
            ? { questId: request.questId || request.id, facts: plain(request.facts || {}) }
            : {}),
        },
      },
      purpose: {
        kind: request.kind,
        requestId: request.id,
        cadence: { ...cadence },
        ...(request.kind === ITINERARY_ACTIVITY_KIND.quest ? {
          questId: request.questId || request.id,
          deadlineAt: request.deadlineAt ?? null,
          facts: plain(request.facts || {}),
        } : {}),
      },
      outboundLegs: route.outboundLegs,
      returnLegs: route.returnLegs,
    });
    result.trips.push({ requestId: request.id, actorId: actor.id, route, itinerary });
    assigned.add(actor.id);
  }
  return result;
}

/** Plan and exact-once register a batch in authoritative living-world state. */
export function scheduleResidentTripBatch(state, options = {}) {
  const plan = planResidentTripBatch(state, options);
  const scheduled = [];
  for (const trip of plan.trips) {
    scheduled.push({
      ...trip,
      itinerary: registerNpcItinerary(state, trip.itinerary),
    });
  }
  return { ...plan, trips: scheduled };
}

/** Stable ID shared by planner retries in the same explicit cadence bucket. */
export function residentTripItineraryId({
  worldSeed = 1, dayIndex = 0, cadenceBucket = 0, requestId, actorId,
} = {}) {
  const request = requiredId(requestId, 'requestId');
  const actor = requiredId(actorId, 'actorId');
  const cadence = normalizeCadence(dayIndex, cadenceBucket);
  const signature = `${finiteSeed(worldSeed)}|${cadence.dayIndex}|${cadence.cadenceBucket}|${request}|${actor}`;
  return `itinerary:resident-trip:${hash32(signature).toString(16).padStart(8, '0')}:${safeId(request)}:${safeId(actor)}`;
}

function canonicalRequests(requests, worldSeed, cadence) {
  if (!Array.isArray(requests)) throw new TypeError('requests must be an array.');
  const unique = new Map();
  for (const source of requests) {
    const request = normalizeRequest(source);
    const signature = stableJson(request);
    const prior = unique.get(request.id);
    if (!prior || signature < prior.signature) unique.set(request.id, { request, signature });
  }
  return [...unique.values()].map(({ request }) => request).sort((a, b) => (
    purposePriority(a.kind) - purposePriority(b.kind)
    || hash32(`${finiteSeed(worldSeed)}|${cadence.dayIndex}|${cadence.cadenceBucket}|${a.id}`)
      - hash32(`${finiteSeed(worldSeed)}|${cadence.dayIndex}|${cadence.cadenceBucket}|${b.id}`)
    || a.id.localeCompare(b.id)
  ));
}

function normalizeRequest(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('Each resident trip request must be an object.');
  }
  const id = requiredId(source.id, 'request id');
  const kind = source.kind || ITINERARY_ACTIVITY_KIND.leisure;
  if (![ITINERARY_ACTIVITY_KIND.leisure, ITINERARY_ACTIVITY_KIND.quest].includes(kind)) {
    throw new TypeError(`Unsupported scheduled resident activity: ${kind}.`);
  }
  if (kind === ITINERARY_ACTIVITY_KIND.quest && !source.actorId) {
    throw new TypeError(`Quest request ${id} requires an explicit actorId.`);
  }
  if (!source.destination?.key) throw new TypeError(`Request ${id} requires a destination.`);
  if (!source.originSettlementId && !source.actorId) {
    throw new TypeError(`Leisure request ${id} requires originSettlementId.`);
  }
  if (source.deadlineAt != null && (!Number.isFinite(source.deadlineAt) || source.deadlineAt < 0)) {
    throw new TypeError(`Request ${id} deadlineAt must be finite and non-negative.`);
  }
  if (source.departAt != null && (!Number.isFinite(source.departAt) || source.departAt < 0)) {
    throw new TypeError(`Request ${id} departAt must be finite and non-negative.`);
  }
  return plain({ ...source, id, kind });
}

function eligibleResidents(entities, request, committed, assigned) {
  return Object.values(entities).filter((entity) => {
    if (!entity || entity.kind !== 'npc' || entity.tombstone || assigned.has(entity.id)
        || committed.has(entity.id) || entity.committed || entity.inTransit) return false;
    if (request.actorId && entity.id !== request.actorId) return false;
    const residence = normalizeNpcResidence(entity.residence);
    const location = normalizeNpcLocation(entity.location);
    if (!residence || !location || location.kind !== 'building') return false;
    const originSettlementId = request.originSettlementId || residence.residenceSettlementId;
    if (residence.residenceSettlementId !== originSettlementId
        || location.settlementId !== residence.residenceSettlementId) return false;
    if (residence.homeBuildingId && location.buildingId !== residence.homeBuildingId) return false;
    return !hasOpenActivity(entity.activity);
  });
}

function selectActor(eligible, request, worldSeed, cadence) {
  if (request.actorId) return eligible[0] || null;
  return selectMobilityCandidates(eligible, 1, {
    worldSeed,
    demandKey: `resident-trip|${cadence.dayIndex}|${cadence.cadenceBucket}|${request.id}`,
  })[0] || null;
}

function committedActorIds(state) {
  const committed = new Set();
  for (const entity of Object.values(state.entities || {})) {
    if (entity?.itineraryId) committed.add(entity.id);
  }
  for (const itinerary of Object.values(state.itineraries || {})) {
    const actorId = itinerary?.actorId ?? itinerary?.a;
    const status = itinerary?.status ?? itinerary?.s;
    if (actorId && !['completed', 'failed'].includes(status)) {
      committed.add(actorId);
    }
  }
  return committed;
}

function scheduledRequestIds(state, cadence) {
  const ids = new Set();
  for (const itinerary of Object.values(state.itineraries || {})) {
    const purpose = itinerary?.purpose ?? itinerary?.p;
    if (purpose?.requestId
        && purpose.cadence?.dayIndex === cadence.dayIndex
        && purpose.cadence?.cadenceBucket === cadence.cadenceBucket) {
      ids.add(purpose.requestId);
    }
  }
  return ids;
}

function hasOpenActivity(activity) {
  if (!activity) return false;
  return !['home', 'idle', 'routine'].includes(activity.kind);
}

function canonicalEndpoint(value, label) {
  if (!value?.key) throw new TypeError(`A resident trip requires a concrete ${label}.`);
  return plain(value);
}

function reject(result, requestId, reason, details = null) {
  result.rejected.push({ requestId, reason, ...(details ? { details: plain(details) } : {}) });
}

function boundedBudget(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError('maxTrips must be a non-negative integer.');
  }
  return Math.min(number, MAX_RESIDENT_TRIPS_PER_CADENCE);
}

function normalizeCadence(dayIndex, cadenceBucket) {
  return {
    dayIndex: nonNegativeInteger(dayIndex, 'dayIndex'),
    cadenceBucket: nonNegativeInteger(cadenceBucket, 'cadenceBucket'),
  };
}

function purposePriority(kind) {
  return kind === ITINERARY_ACTIVITY_KIND.quest ? 0 : 1;
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 48);
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return number;
}

function finiteSeed(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number >>> 0 : 1;
}

function hash32(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function stableJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function plain(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = plain(value[key]);
    }
    return result;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  throw new TypeError('Resident trip data must contain finite JSON values.');
}
