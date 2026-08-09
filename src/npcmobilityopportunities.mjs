// Pure catalog adapter for autonomous resident trips.
//
// This module owns neither people nor simulation time. It converts explicit
// settlement, walking, station-access, and closed-loop railway facts into the
// request shape consumed by planResidentTripBatch. Missing geography stays
// missing: it never fabricates a stop, settlement, path, or traveller.

import { planMultimodalRoute } from './npcmultimodalroute.mjs';

export const NPC_MOBILITY_OPPORTUNITY_VERSION = 1;
export const LEISURE_CADENCE_BUCKET_STRIDE = 4;
export const MAX_LEISURE_OPPORTUNITIES_PER_CADENCE = 2;
export const DEFAULT_LEISURE_REASONS = Object.freeze([
  'market-day',
  'personal-visit',
  'country-outing',
]);

/**
 * Build scheduler-ready leisure and authored-quest requests.
 *
 * Catalog contract:
 * - settlements: `{ id, key? }`
 * - stations: `{ id, settlementId }`
 * - walkingConnections: `{ fromSettlementId, toSettlementId, duration, distance? }`
 *   Connections are directional; provide both directions when they differ.
 * - stationAccess: `{ settlementId, stationId, duration, distance? }`
 * - railServices: `{ id, stationIds, segmentDurations, closed: true }`
 *   `segmentDurations[i]` is the duration from station i to station i + 1,
 *   including the wrapped final-to-first segment.
 */
export function buildResidentMobilityOpportunities({
  worldSeed = 1,
  dayIndex = 0,
  cadenceBucket = 0,
  settlements = [],
  stations = [],
  walkingConnections = [],
  stationAccess = [],
  railServices = [],
  departureWaitEstimates = {},
  returnDepartureWaitEstimates = {},
  leisureReasons = DEFAULT_LEISURE_REASONS,
  maxLeisure = 1,
  quests = [],
} = {}) {
  const cadence = {
    dayIndex: nonNegativeInteger(dayIndex, 'dayIndex'),
    cadenceBucket: nonNegativeInteger(cadenceBucket, 'cadenceBucket'),
  };
  const seed = finiteSeed(worldSeed);
  const places = normalizeSettlements(settlements);
  const stops = normalizeStations(stations, places);
  const walks = normalizeWalkingConnections(walkingConnections, places);
  const access = normalizeStationAccess(stationAccess, places, stops);
  const railway = buildClosedRailwayCatalog({ stations: stops, railServices });
  const waits = normalizeWaits(departureWaitEstimates, 'departureWaitEstimates');
  const returnWaits = normalizeWaits(returnDepartureWaitEstimates,
    'returnDepartureWaitEstimates');
  const reasons = normalizeReasons(leisureReasons);
  const result = {
    version: NPC_MOBILITY_OPPORTUNITY_VERSION,
    cadence,
    requests: [],
    rejected: [],
    omitted: [],
  };

  for (const source of canonicalObjects(quests, 'quest', (quest) => requiredId(quest.id,
    'quest id'))) {
    const built = buildQuestRequest(source, {
      places, stops, walks, access, railway, waits, returnWaits,
    });
    if (built.ok) result.requests.push(built.request);
    else result.rejected.push({ requestId: built.requestId, reason: built.reason,
      ...(built.details ? { details: built.details } : {}) });
  }

  const leisureBudget = Math.min(
    nonNegativeInteger(maxLeisure, 'maxLeisure'),
    MAX_LEISURE_OPPORTUNITIES_PER_CADENCE,
  );
  if (!leisureBudget) {
    result.omitted.push({ kind: 'leisure', reason: 'zero-budget' });
  } else if (!isLeisureCadenceActive(cadence.cadenceBucket)) {
    result.omitted.push({ kind: 'leisure', reason: 'cadence-inactive' });
  } else if (places.size < 2) {
    result.omitted.push({ kind: 'leisure', reason: 'destination-shortage' });
  } else {
    const candidates = [];
    const orderedPlaces = [...places.values()].sort(byId);
    for (const origin of orderedPlaces) {
      for (const destination of orderedPlaces) {
        if (origin.id === destination.id) continue;
        const routing = routingFor(origin.id, destination.id, {
          stops, walks, access, railway, waits, returnWaits,
        });
        const viability = planMultimodalRoute({
          origin: endpoint(origin), destination: endpoint(destination),
          purposeKind: 'leisure', includeReturn: true, ...routing,
        });
        if (!viability.ok) {
          result.omitted.push({
            kind: 'leisure', originSettlementId: origin.id,
            destinationSettlementId: destination.id, reason: viability.reason,
          });
          continue;
        }
        const signature = `${seed}|${cadence.dayIndex}|${cadence.cadenceBucket}|${origin.id}|${destination.id}`;
        candidates.push({
          origin, destination, routing,
          rank: hash32(signature), signature,
        });
      }
    }
    candidates.sort((a, b) => a.rank - b.rank || a.signature.localeCompare(b.signature));
    const usedOrigins = new Set();
    const usedDestinations = new Set();
    const usedReasons = new Set();
    for (const candidate of candidates) {
      if (result.requests.filter((request) => request.kind === 'leisure').length >= leisureBudget) break;
      if (usedOrigins.has(candidate.origin.id) || usedDestinations.has(candidate.destination.id)) continue;
      const reasonOffset = hash32(`${candidate.signature}|reason`) % reasons.length;
      let reason = null;
      for (let offset = 0; offset < reasons.length; offset++) {
        const proposed = reasons[(reasonOffset + offset) % reasons.length];
        if (!usedReasons.has(proposed)) { reason = proposed; break; }
      }
      if (!reason) continue;
      result.requests.push({
        id: leisureRequestId(cadence, candidate.origin.id, candidate.destination.id),
        kind: 'leisure',
        originSettlementId: candidate.origin.id,
        origin: endpoint(candidate.origin),
        destination: endpoint(candidate.destination),
        activityData: { reason },
        routing: candidate.routing,
      });
      usedOrigins.add(candidate.origin.id);
      usedDestinations.add(candidate.destination.id);
      usedReasons.add(reason);
    }
    const leisureCount = result.requests.filter((request) => request.kind === 'leisure').length;
    if (!leisureCount) {
      result.omitted.push({ kind: 'leisure', reason: 'no-reachable-destination' });
    } else if (leisureCount < leisureBudget) {
      result.omitted.push({
        kind: 'leisure', reason: 'opportunity-shortage',
        requested: leisureBudget, available: leisureCount,
      });
    }
  }

  result.requests.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id)
    : a.kind === 'quest' ? -1 : 1));
  result.rejected.sort((a, b) => a.requestId.localeCompare(b.requestId));
  result.omitted.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  return result;
}

/** True for one quiet opportunity window in every four caller-owned buckets. */
export function isLeisureCadenceActive(cadenceBucket) {
  return nonNegativeInteger(cadenceBucket, 'cadenceBucket')
    % LEISURE_CADENCE_BUCKET_STRIDE === 0;
}

/** Convert closed ordered services into the graph consumed by the route planner. */
export function buildClosedRailwayCatalog({ stations = [], railServices = [] } = {}) {
  const stationRecords = stations instanceof Map
    ? [...stations.values()]
    : normalizeLooseStations(stations);
  const stationIds = new Set(stationRecords.map((station) => station.id));
  const connections = [];
  for (const service of canonicalObjects(railServices, 'rail service',
    (item) => requiredId(item.id, 'rail service id'))) {
    if (service.closed !== true) {
      throw new TypeError(`Rail service ${service.id} must be a closed ordered service.`);
    }
    if (!Array.isArray(service.stationIds) || service.stationIds.length < 2) {
      throw new TypeError(`Rail service ${service.id} needs at least two ordered stations.`);
    }
    const ordered = service.stationIds.map((id) => requiredId(id, 'rail station id'));
    if (new Set(ordered).size !== ordered.length) {
      throw new TypeError(`Rail service ${service.id} repeats a station.`);
    }
    if (!Array.isArray(service.segmentDurations)
        || service.segmentDurations.length !== ordered.length) {
      throw new TypeError(`Rail service ${service.id} needs one duration per closed segment.`);
    }
    for (const id of ordered) {
      if (!stationIds.has(id)) throw new TypeError(`Rail service ${service.id} references unknown station ${id}.`);
    }
    for (let index = 0; index < ordered.length; index++) {
      connections.push({
        fromStationId: ordered[index],
        toStationId: ordered[(index + 1) % ordered.length],
        serviceId: service.id,
        duration: finiteNonnegative(service.segmentDurations[index],
          `rail service ${service.id} segment ${index} duration`),
      });
    }
  }
  connections.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  return { stations: [...stationIds].sort(), connections };
}

function buildQuestRequest(source, context) {
  const id = requiredId(source.id, 'quest id');
  let actorId;
  try {
    actorId = requiredId(source.actorId, `quest ${id} actorId`);
  } catch {
    return { ok: false, requestId: id, reason: 'missing-actor' };
  }
  const origin = context.places.get(source.originSettlementId);
  const destination = context.places.get(source.destinationSettlementId);
  if (!origin || !destination) return { ok: false, requestId: id, reason: 'unknown-settlement' };
  if (origin.id === destination.id) return { ok: false, requestId: id, reason: 'same-settlement' };
  const deadlineAt = optionalFiniteNonnegative(source.deadlineAt, `quest ${id} deadlineAt`);
  const departAt = optionalFiniteNonnegative(source.departAt, `quest ${id} departAt`);
  const routing = routingFor(origin.id, destination.id, context);
  const viability = planMultimodalRoute({
    origin: endpoint(origin), destination: endpoint(destination),
    purposeKind: 'quest', deadlineAt, departAt, includeReturn: true, ...routing,
  });
  if (!viability.ok) return { ok: false, requestId: id, reason: viability.reason,
    details: viability };
  return {
    ok: true,
    request: {
      id,
      kind: 'quest',
      actorId,
      questId: source.questId || id,
      originSettlementId: origin.id,
      origin: endpoint(origin),
      destination: endpoint(destination),
      ...(departAt == null ? {} : { departAt }),
      ...(deadlineAt == null ? {} : { deadlineAt }),
      facts: plain(source.facts || {}),
      activityData: plain(source.activityData || {}),
      routing,
    },
  };
}

function routingFor(originId, destinationId, context) {
  const outwardWalk = context.walks.get(`${originId}>${destinationId}`) || null;
  const homewardWalk = context.walks.get(`${destinationId}>${originId}`) || null;
  // The scheduler always creates a round trip. Do not let the lower-level
  // route planner assume a symmetric return from only one directional fact.
  const directWalk = outwardWalk && homewardWalk ? outwardWalk : null;
  const returnWalk = outwardWalk && homewardWalk ? homewardWalk : null;
  return {
    directWalk,
    originAccess: linksFor(originId, context),
    destinationEgress: linksFor(destinationId, context),
    railway: context.railway,
    departureWaitEstimates: context.waits,
    returnDepartureWaitEstimates: context.returnWaits,
    returnRoute: {
      directWalk: returnWalk,
      originAccess: linksFor(destinationId, context),
      destinationEgress: linksFor(originId, context),
      departureWaitEstimates: context.returnWaits,
    },
  };
}

function linksFor(settlementId, context) {
  const links = new Map();
  for (const station of context.stops.values()) {
    if (station.settlementId === settlementId) {
      links.set(station.id, { stationId: station.id, duration: 0,
        data: { settlementId, accessKind: 'station-village' } });
    }
  }
  for (const link of context.access.get(settlementId) || []) {
    const prior = links.get(link.stationId);
    if (!prior || link.duration < prior.duration) links.set(link.stationId, link);
  }
  return [...links.values()].sort((a, b) => a.stationId.localeCompare(b.stationId)
    || a.duration - b.duration);
}

function normalizeSettlements(input) {
  const map = new Map();
  for (const source of canonicalObjects(input, 'settlement', (item) => requiredId(item.id,
    'settlement id'))) {
    const id = requiredId(source.id, 'settlement id');
    map.set(id, { id, key: source.key == null ? id : requiredId(source.key, 'settlement key') });
  }
  return map;
}

function normalizeLooseStations(input) {
  if (!Array.isArray(input)) throw new TypeError('stations must be an array.');
  return canonicalObjects(input, 'station', (item) => requiredId(item.id, 'station id'))
    .map((source) => ({ id: requiredId(source.id, 'station id'),
      settlementId: requiredId(source.settlementId, 'station settlementId') }));
}

function normalizeStations(input, places) {
  const map = new Map();
  for (const station of normalizeLooseStations(input)) {
    if (!places.has(station.settlementId)) {
      throw new TypeError(`Station ${station.id} references unknown settlement ${station.settlementId}.`);
    }
    map.set(station.id, station);
  }
  return map;
}

function normalizeWalkingConnections(input, places) {
  const map = new Map();
  for (const source of canonicalObjects(input, 'walking connection', (item) => (
    `${requiredId(item.fromSettlementId, 'walking origin')}>${requiredId(item.toSettlementId,
      'walking destination')}`
  ))) {
    const from = requiredId(source.fromSettlementId, 'walking origin');
    const to = requiredId(source.toSettlementId, 'walking destination');
    if (!places.has(from) || !places.has(to)) throw new TypeError('Walking connection references an unknown settlement.');
    if (from === to) continue;
    const duration = finiteNonnegative(source.duration, 'walking duration');
    map.set(`${from}>${to}`, {
      duration,
      data: { fromSettlementId: from, toSettlementId: to,
        ...(source.distance == null ? {} : {
          distance: finiteNonnegative(source.distance, 'walking distance'),
        }) },
    });
  }
  return map;
}

function normalizeStationAccess(input, places, stops) {
  const bySettlement = new Map();
  for (const source of canonicalObjects(input, 'station access', (item) => (
    `${requiredId(item.settlementId, 'access settlementId')}|${requiredId(item.stationId,
      'access stationId')}`
  ))) {
    const settlementId = requiredId(source.settlementId, 'access settlementId');
    const stationId = requiredId(source.stationId, 'access stationId');
    if (!places.has(settlementId) || !stops.has(stationId)) {
      throw new TypeError('Station access references an unknown settlement or station.');
    }
    const duration = finiteNonnegative(source.duration, 'station access duration');
    const link = { stationId, duration, data: { settlementId,
      ...(source.distance == null ? {} : {
        distance: finiteNonnegative(source.distance, 'station access distance'),
      }) } };
    if (!bySettlement.has(settlementId)) bySettlement.set(settlementId, []);
    bySettlement.get(settlementId).push(link);
  }
  for (const links of bySettlement.values()) links.sort((a, b) => a.stationId.localeCompare(b.stationId));
  return bySettlement;
}

function normalizeWaits(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const result = {};
  for (const key of Object.keys(input).sort()) {
    result[requiredId(key, `${label} key`)] = finiteNonnegative(input[key], `${label}.${key}`);
  }
  return result;
}

function normalizeReasons(input) {
  if (!Array.isArray(input) || !input.length) throw new TypeError('leisureReasons must be non-empty.');
  return [...new Set(input.map((reason) => requiredId(reason, 'leisure reason'))) ].sort();
}

function canonicalObjects(input, label, keyOf) {
  if (!Array.isArray(input)) throw new TypeError(`${label}s must be an array.`);
  const unique = new Map();
  for (const source of input) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new TypeError(`Each ${label} must be an object.`);
    }
    const key = keyOf(source);
    const signature = stableJson(source);
    const prior = unique.get(key);
    if (!prior || signature < prior.signature) unique.set(key, { source, signature });
  }
  return [...unique.values()].sort((a, b) => a.signature.localeCompare(b.signature))
    .map(({ source }) => source);
}

function endpoint(place) {
  return { kind: 'settlement', key: place.key, settlementId: place.id };
}

function leisureRequestId(cadence, originId, destinationId) {
  return `leisure:${cadence.dayIndex}:${cadence.cadenceBucket}:${safeId(originId)}:${safeId(destinationId)}`;
}

function byId(a, b) { return a.id.localeCompare(b.id); }

function optionalFiniteNonnegative(value, label) {
  return value == null ? null : finiteNonnegative(value, label);
}

function finiteNonnegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${label} must be finite and non-negative.`);
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return number;
}

function finiteSeed(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number >>> 0 : 1;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 48);
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
  return value;
}
