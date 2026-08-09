// Pure binding between geography-free multimodal route choices and the
// canonical locations required by the durable NPC mobility executor.

import { normalizeNpcLocation, normalizeNpcResidence } from './npclocation.mjs';

export const NPC_MOBILITY_ROUTE_BINDING_VERSION = 1;

const WALK_KINDS = new Set(['local-walk', 'regional-walk']);
const RAIL_KINDS = new Set(['station-wait', 'board-train', 'train-ride', 'alight-train']);

/**
 * Bind a successful planMultimodalRoute result to executor-ready itinerary
 * legs. Geography remains caller-owned: this function never invents an edge,
 * platform, anchor, or intermediate walking location.
 */
export function bindNpcMobilityRoute(route, {
  residence,
  originLocation,
  destinationLocation,
  platformLocations = {},
  regionalWalks = {},
  activityDurationSeconds = 0,
} = {}) {
  if (!route?.ok || !Array.isArray(route.outboundLegs) || !Array.isArray(route.returnLegs)
      || !route.outboundLegs.length || !route.returnLegs.length) {
    throw new TypeError('Route binding requires a successful round-trip multimodal route.');
  }
  const canonicalResidence = normalizeNpcResidence(residence);
  const origin = canonicalLocation(originLocation, 'originLocation');
  const destination = canonicalLocation(destinationLocation, 'destinationLocation');
  if (!canonicalResidence?.homeBuildingId) {
    throw new TypeError('Route binding requires a residence with a home building.');
  }
  const home = canonicalLocation({
    kind: 'building',
    settlementId: canonicalResidence.residenceSettlementId,
    buildingId: canonicalResidence.homeBuildingId,
    nodeId: null,
  }, 'residence home');
  if (!sameLocation(origin, home)) {
    throw new TypeError('The outbound origin must be the resident\'s canonical home building.');
  }
  const platforms = platformIndex(platformLocations);
  const walks = regionalWalkIndex(regionalWalks);
  const outboundLegs = bindDirection(route.outboundLegs, {
    start: origin, finish: destination, platforms, walks, finalMustBeHome: false,
  });
  const returnLegs = bindDirection(route.returnLegs, {
    start: destination, finish: home, platforms, walks, finalMustBeHome: true,
  });
  const duration = finiteNonnegative(activityDurationSeconds, 'activityDurationSeconds');
  const result = {
    version: NPC_MOBILITY_ROUTE_BINDING_VERSION,
    outboundLegs,
    returnLegs,
    activityData: { durationSeconds: duration, location: clone(destination) },
  };
  // Exercise JSON conversion here so unsupported caller data fails before an
  // itinerary can be registered or durable state can be mutated.
  JSON.stringify(result);
  return result;
}

function bindDirection(legs, context) {
  let current = context.start;
  return legs.map((leg, index) => {
    if (!leg?.id || typeof leg.id !== 'string' || !leg.kind || !isPlainObject(leg.data || {})) {
      throw new TypeError(`Malformed route leg at index ${index}.`);
    }
    const data = clone(leg.data || {});
    let bound;
    if (WALK_KINDS.has(leg.kind)) {
      const facts = leg.kind === 'regional-walk' ? requiredWalkFacts(context.walks, leg.id) : null;
      const fromLocation = facts?.fromLocation || optionalCanonical(data.fromLocation) || current;
      if (!sameLocation(fromLocation, current)) {
        throw new TypeError(`Walking leg ${leg.id} does not begin at the preceding canonical location.`);
      }
      const toLocation = facts?.toLocation || optionalCanonical(data.toLocation)
        || inferWalkDestination(legs, index, context, leg.id);
      if (!toLocation) {
        throw new TypeError(`Walking leg ${leg.id} requires an explicit or unambiguous destination location.`);
      }
      const durationSeconds = positiveDuration(data.durationSeconds ?? data.duration, leg.id);
      bound = { ...data, durationSeconds, fromLocation: clone(fromLocation), toLocation: clone(toLocation) };
      delete bound.duration;
      if (leg.kind === 'regional-walk') bound.edgeLocation = clone(facts.edgeLocation);
      current = toLocation;
    } else if (leg.kind === 'station-wait') {
      const stationId = requiredId(data.originStationId ?? data.stationId, `${leg.id} stationId`);
      const platformLocation = requiredPlatform(context.platforms, stationId, leg.id);
      requireCurrentPlatform(current, platformLocation, leg.id);
      bound = { ...data, originStationId: stationId, platformLocation: clone(platformLocation) };
      delete bound.stationId;
      bindOptionalDuration(bound, leg.id);
      current = platformLocation;
    } else if (leg.kind === 'board-train') {
      const stationId = requiredId(data.originStationId ?? data.stationId, `${leg.id} stationId`);
      const platformLocation = requiredPlatform(context.platforms, stationId, leg.id);
      requireCurrentPlatform(current, platformLocation, leg.id);
      const ride = legs[index + 1];
      if (ride?.kind !== 'train-ride' || ride.data?.serviceId !== data.serviceId) {
        throw new TypeError(`Board leg ${leg.id} requires its matching train ride immediately after it.`);
      }
      const destinationStationId = requiredId(
        ride.data?.destinationStationId ?? ride.data?.toStationId ?? ride.data?.stationId,
        `${leg.id} destinationStationId`,
      );
      bound = {
        ...data, originStationId: stationId, destinationStationId,
        platformLocation: clone(platformLocation),
      };
      delete bound.stationId;
      bindOptionalDuration(bound, leg.id);
    } else if (leg.kind === 'train-ride') {
      const destinationStationId = requiredId(
        data.destinationStationId ?? data.toStationId ?? data.stationId,
        `${leg.id} destinationStationId`,
      );
      bound = { ...data, destinationStationId };
      delete bound.toStationId;
      delete bound.stationId;
      bindOptionalDuration(bound, leg.id);
      // A canonical seat is assigned by boarding and deliberately cannot be
      // bound in advance. The following alight restores a concrete location.
    } else if (leg.kind === 'alight-train') {
      const stationId = requiredId(
        data.destinationStationId ?? data.toStationId ?? data.stationId,
        `${leg.id} destinationStationId`,
      );
      const platformLocation = requiredPlatform(context.platforms, stationId, leg.id);
      bound = { ...data, destinationStationId: stationId, platformLocation: clone(platformLocation) };
      delete bound.toStationId;
      delete bound.stationId;
      bindOptionalDuration(bound, leg.id);
      current = platformLocation;
    } else {
      throw new TypeError(`Unsupported route leg kind: ${leg.kind}.`);
    }
    assertFiniteJson(bound, `route leg ${leg.id}`);
    return { id: leg.id, kind: leg.kind, data: bound };
  }).map((leg, index, bound) => {
    if (index === bound.length - 1 && !sameLocation(current, context.finish)) {
      throw new TypeError(`${context.finalMustBeHome ? 'Return' : 'Outbound'} route does not end at its canonical destination.`);
    }
    return leg;
  });
}

function inferWalkDestination(legs, index, context, legId) {
  const next = legs[index + 1];
  if (!next) return context.finish;
  if (next.kind === 'station-wait' || next.kind === 'board-train') {
    const stationId = requiredId(next.data?.originStationId ?? next.data?.stationId, `${legId} next stationId`);
    return requiredPlatform(context.platforms, stationId, legId);
  }
  return null;
}

function platformIndex(input) {
  const result = new Map();
  const entries = Array.isArray(input)
    ? input.map((location) => [location?.stationId, location])
    : Object.entries(input || {});
  for (const [key, value] of entries) {
    const location = canonicalLocation(value, `platform ${key || 'unknown'}`);
    if (location.kind !== 'station-platform' || (key && key !== location.stationId)) {
      throw new TypeError(`Platform location ${key || 'unknown'} has inconsistent station identity.`);
    }
    if (result.has(location.stationId)) throw new TypeError(`Ambiguous platform location for ${location.stationId}.`);
    result.set(location.stationId, location);
  }
  return result;
}

function regionalWalkIndex(input) {
  const result = new Map();
  const entries = Array.isArray(input)
    ? input.map((facts) => [facts?.legId, facts])
    : Object.entries(input || {});
  for (const [legId, raw] of entries) {
    if (!legId || result.has(legId) || !isPlainObject(raw)) {
      throw new TypeError(`Missing or ambiguous regional walk facts for ${legId || 'unknown'}.`);
    }
    const edgeLocation = canonicalLocation(raw.edgeLocation ?? raw, `${legId} edgeLocation`);
    if (edgeLocation.kind !== 'regional-edge' || edgeLocation.progress !== 0) {
      throw new TypeError(`Regional walk ${legId} requires a canonical edgeLocation at progress 0.`);
    }
    const fromLocation = raw.edgeLocation == null ? null : optionalCanonical(raw.fromLocation);
    const toLocation = raw.edgeLocation == null ? null : optionalCanonical(raw.toLocation);
    result.set(String(legId), { edgeLocation, fromLocation, toLocation });
  }
  return result;
}

function requiredWalkFacts(index, legId) {
  const value = index.get(legId);
  if (!value) throw new TypeError(`Regional walk ${legId} requires explicit canonical edge facts.`);
  return value;
}

function requiredPlatform(index, stationId, legId) {
  const value = index.get(stationId);
  if (!value) throw new TypeError(`Route leg ${legId} requires a canonical platform for ${stationId}.`);
  return value;
}

function requireCurrentPlatform(current, platform, legId) {
  if (!sameLocation(current, platform)) {
    throw new TypeError(`Route leg ${legId} does not begin at its canonical platform.`);
  }
}

function bindOptionalDuration(data, legId) {
  if (data.durationSeconds == null && data.duration == null) return;
  data.durationSeconds = finiteNonnegative(data.durationSeconds ?? data.duration, `${legId} duration`);
  delete data.duration;
}

function positiveDuration(value, legId) {
  const duration = finiteNonnegative(value, `${legId} duration`);
  if (duration <= 0) throw new TypeError(`Movement leg ${legId} requires a positive duration.`);
  return duration;
}

function finiteNonnegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a finite non-negative number.`);
  return value;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value) throw new TypeError(`Missing ${label}.`);
  return value;
}

function canonicalLocation(value, label) {
  const location = normalizeNpcLocation(value);
  if (!location) throw new TypeError(`Invalid canonical ${label}.`);
  return location;
}

function optionalCanonical(value) {
  return value == null ? null : canonicalLocation(value, 'route location');
}

function sameLocation(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function assertFiniteJson(value, label) {
  try {
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError();
      if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol') throw new TypeError();
      return item;
    });
  } catch {
    throw new TypeError(`${label} must contain finite JSON values.`);
  }
}

function clone(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = clone(value[key]);
    }
    return result;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  throw new TypeError('Route binding data must contain finite JSON values.');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
