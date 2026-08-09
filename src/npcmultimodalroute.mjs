// Deterministic, data-only comparison of walking and railway travel.
//
// Callers own geography, timetable generation, and clocks. This module accepts
// their already-computed durations (seconds), chooses a route, and emits leg
// descriptors understood by npcitinerary without depending on its lifecycle.

export const MULTIMODAL_ROUTE_VERSION = 1;
export const STATION_ACCESS_EPSILON_SECONDS = 1;

const LEG = Object.freeze({
  localWalk: 'local-walk',
  regionalWalk: 'regional-walk',
  stationWait: 'station-wait',
  boardTrain: 'board-train',
  trainRide: 'train-ride',
  alightTrain: 'alight-train',
});

/**
 * Compare a direct walk with every viable access-station/rail/egress pairing.
 * Returns both an outward route and a return route by default.
 */
export function planMultimodalRoute(input) {
  if (!input?.origin?.key || !input?.destination?.key) {
    throw new TypeError('Multimodal routing requires concrete origin and destination keys.');
  }
  const railway = normalizeRailway(input.railway);
  const outbound = chooseDirection({
    label: 'outbound',
    from: input.origin,
    to: input.destination,
    directWalk: input.directWalk,
    access: input.originAccess,
    egress: input.destinationEgress,
    railway,
    waits: input.departureWaitEstimates,
  });
  if (!outbound) return unavailable('no-outbound-route');

  if (input.purposeKind === 'quest' && input.deadlineAt != null) {
    const departAt = finiteNonnegative(input.departAt ?? 0, 'departAt');
    const deadlineAt = finiteNonnegative(input.deadlineAt, 'deadlineAt');
    if (departAt + outbound.duration > deadlineAt) {
      return {
        version: MULTIMODAL_ROUTE_VERSION,
        ok: false,
        reason: 'quest-deadline-unreachable',
        fastestOutboundDuration: outbound.duration,
        arrivalAt: departAt + outbound.duration,
        deadlineAt,
      };
    }
  }

  const returnInput = input.returnRoute || {};
  const returning = input.includeReturn === false ? null : chooseDirection({
    label: 'return',
    from: input.destination,
    to: input.origin,
    directWalk: returnInput.directWalk ?? reverseDirectWalk(input.directWalk),
    access: returnInput.originAccess ?? reverseAccess(input.destinationEgress),
    egress: returnInput.destinationEgress ?? reverseAccess(input.originAccess),
    railway,
    waits: returnInput.departureWaitEstimates ?? input.returnDepartureWaitEstimates
      ?? input.departureWaitEstimates,
  });
  if (input.includeReturn !== false && !returning) return unavailable('no-return-route');

  return {
    version: MULTIMODAL_ROUTE_VERSION,
    ok: true,
    origin: plain(input.origin),
    destination: plain(input.destination),
    outbound: publicChoice(outbound),
    returning: returning ? publicChoice(returning) : null,
    outboundLegs: numberLegs(outbound.legs, 'outbound'),
    returnLegs: returning ? numberLegs(returning.legs, 'return') : [],
    returnRequired: input.includeReturn !== false,
    totalTravelDuration: outbound.duration + (returning?.duration || 0),
  };
}

function chooseDirection({ label, from, to, directWalk, access, egress, railway, waits }) {
  const choices = [];
  if (directWalk != null) {
    const duration = durationOf(directWalk, `${label} direct walk`);
    choices.push({
      mode: 'walk', duration,
      signature: `walk:${from.key}>${to.key}`,
      stations: [],
      legs: normalizeSuppliedLegs(directWalk.legs) || [{
        kind: directWalk.kind || LEG.regionalWalk,
        data: { duration, fromKey: from.key, toKey: to.key, ...plain(directWalk.data) },
      }],
    });
  }

  if (railway.connections.length) {
    const accesses = normalizeStationLinks(access, `${label} station access`);
    const egresses = normalizeStationLinks(egress, `${label} station egress`);
    for (const start of accesses) {
      for (const end of egresses) {
        if (start.stationId === end.stationId) continue;
        const rail = findRailPath(railway, start.stationId, end.stationId, waits);
        if (!rail) continue;
        const duration = start.duration + rail.duration + end.duration;
        choices.push({
          mode: 'rail', duration,
          signature: `rail:${start.stationId}:${rail.signature}:${end.stationId}`,
          stations: rail.stationIds,
          legs: [
            ...stationLinkLegs(start, from.key, 'access'),
            ...railLegs(rail),
            ...stationLinkLegs(end, to.key, 'egress'),
          ],
        });
      }
    }
  }
  choices.sort(compareChoices);
  return choices[0] || null;
}

function findRailPath(railway, fromStationId, toStationId, waitsInput) {
  if (!railway.stations.has(fromStationId) || !railway.stations.has(toStationId)) return null;
  const waits = plain(waitsInput || {});
  const frontier = [{ stationId: fromStationId, serviceId: null, duration: 0, edges: [], signature: '' }];
  const best = new Map();
  while (frontier.length) {
    frontier.sort(compareRailStates);
    const state = frontier.shift();
    const stateKey = `${state.stationId}|${state.serviceId || ''}`;
    const known = best.get(stateKey);
    if (known && compareRailStates(known, state) <= 0) continue;
    best.set(stateKey, state);
    if (state.stationId === toStationId && state.edges.length) return finalizeRailPath(state, waits);

    for (const edge of railway.byOrigin.get(state.stationId) || []) {
      const wait = state.serviceId === edge.serviceId ? 0 : waitFor(waits, edge.fromStationId, edge.serviceId);
      if (!Number.isFinite(wait)) continue;
      frontier.push({
        stationId: edge.toStationId,
        serviceId: edge.serviceId,
        duration: state.duration + wait + edge.duration,
        edges: [...state.edges, { ...edge, wait }],
        signature: `${state.signature}>${edge.serviceId}:${edge.toStationId}`,
      });
    }
  }
  return null;
}

function finalizeRailPath(state) {
  const stationIds = [state.edges[0].fromStationId, ...state.edges.map((edge) => edge.toStationId)];
  return {
    duration: state.duration,
    edges: state.edges,
    stationIds,
    signature: state.signature,
  };
}

function railLegs(path) {
  const result = [];
  let index = 0;
  while (index < path.edges.length) {
    const first = path.edges[index];
    const serviceId = first.serviceId;
    const segment = [first];
    while (path.edges[index + 1]?.serviceId === serviceId) segment.push(path.edges[++index]);
    const last = segment[segment.length - 1];
    result.push({
      kind: LEG.stationWait,
      data: { duration: first.wait, serviceId, stationId: first.fromStationId },
    });
    result.push({
      kind: LEG.boardTrain,
      data: { serviceId, stationId: first.fromStationId },
    });
    result.push({
      kind: LEG.trainRide,
      data: {
        duration: segment.reduce((sum, edge) => sum + edge.duration, 0),
        fromStationId: first.fromStationId,
        serviceId,
        toStationId: last.toStationId,
        viaStationIds: segment.slice(0, -1).map((edge) => edge.toStationId),
      },
    });
    result.push({
      kind: LEG.alightTrain,
      data: { serviceId, stationId: last.toStationId },
    });
    index++;
  }
  return result;
}

function stationLinkLegs(link, endpointKey, role) {
  if (link.duration <= STATION_ACCESS_EPSILON_SECONDS) return [];
  const fromKey = role === 'access' ? endpointKey : link.stationId;
  const toKey = role === 'access' ? link.stationId : endpointKey;
  return normalizeSuppliedLegs(link.legs) || [{
    kind: link.kind || LEG.regionalWalk,
    data: {
      duration: link.duration, fromKey, stationId: link.stationId, toKey, role,
      ...plain(link.data),
    },
  }];
}

function normalizeRailway(input) {
  if (input == null) return { stations: new Set(), connections: [], byOrigin: new Map() };
  if (!Array.isArray(input.connections)) throw new TypeError('Railway connections must be an array.');
  const connections = input.connections.map((edge, index) => {
    if (!edge?.fromStationId || !edge?.toStationId || !edge?.serviceId
        || edge.fromStationId === edge.toStationId) {
      throw new TypeError(`Malformed railway connection at index ${index}.`);
    }
    return {
      fromStationId: String(edge.fromStationId),
      toStationId: String(edge.toStationId),
      serviceId: String(edge.serviceId),
      duration: finiteNonnegative(edge.duration, `railway connection ${index} duration`),
    };
  }).sort((a, b) => connectionSignature(a).localeCompare(connectionSignature(b)));
  const stations = new Set((input.stations || []).map((station) => (
    String(typeof station === 'string' ? station : station?.id || '')
  )).filter(Boolean));
  for (const edge of connections) {
    stations.add(edge.fromStationId);
    stations.add(edge.toStationId);
  }
  const byOrigin = new Map();
  for (const edge of connections) {
    if (!byOrigin.has(edge.fromStationId)) byOrigin.set(edge.fromStationId, []);
    byOrigin.get(edge.fromStationId).push(edge);
  }
  return { stations, connections, byOrigin };
}

function normalizeStationLinks(input, label) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array.`);
  return input.map((link, index) => {
    if (!link?.stationId) throw new TypeError(`Missing station for ${label} ${index}.`);
    return {
      stationId: String(link.stationId),
      duration: durationOf(link, `${label} ${index}`),
      kind: link.kind || LEG.regionalWalk,
      data: plain(link.data),
      legs: link.legs,
    };
  }).sort((a, b) => a.stationId.localeCompare(b.stationId) || a.duration - b.duration);
}

function normalizeSuppliedLegs(legs) {
  if (legs == null) return null;
  if (!Array.isArray(legs) || !legs.length) throw new TypeError('Supplied route legs must be a non-empty array.');
  return legs.map((leg) => {
    if (![LEG.localWalk, LEG.regionalWalk].includes(leg?.kind)) {
      throw new TypeError(`Route access legs must be walking legs, got ${leg?.kind}.`);
    }
    return { kind: leg.kind, data: plain(leg.data) };
  });
}

function reverseDirectWalk(walk) {
  if (walk == null) return null;
  return { duration: durationOf(walk, 'direct walk'), kind: walk.kind, data: plain(walk.returnData || walk.data) };
}

function reverseAccess(links) {
  if (links == null) return [];
  return links.map((link) => ({
    stationId: link.stationId,
    duration: durationOf(link, 'station link'),
    kind: link.kind,
    data: plain(link.returnData || link.data),
  }));
}

function numberLegs(legs, prefix) {
  return legs.map((leg, index) => ({
    id: `${prefix}:${String(index + 1).padStart(2, '0')}:${leg.kind}`,
    kind: leg.kind,
    data: plain(leg.data),
  }));
}

function publicChoice(choice) {
  return { mode: choice.mode, duration: choice.duration, stationIds: [...choice.stations] };
}

function compareChoices(a, b) {
  return a.duration - b.duration
    || (a.mode === b.mode ? 0 : a.mode === 'walk' ? -1 : 1)
    || a.signature.localeCompare(b.signature);
}

function compareRailStates(a, b) {
  return a.duration - b.duration || a.signature.localeCompare(b.signature);
}

function waitFor(waits, stationId, serviceId) {
  const serviceWait = waits[`${stationId}|${serviceId}`];
  const stationWait = waits[stationId];
  const value = serviceWait ?? stationWait;
  return value == null ? Infinity : finiteNonnegative(value, `departure wait ${stationId}`);
}

function durationOf(value, label) {
  return finiteNonnegative(typeof value === 'number' ? value : value?.duration, `${label} duration`);
}

function finiteNonnegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a finite non-negative number.`);
  return value;
}

function connectionSignature(edge) {
  return `${edge.fromStationId}>${edge.toStationId}:${edge.serviceId}:${edge.duration}`;
}

function unavailable(reason) {
  return { version: MULTIMODAL_ROUTE_VERSION, ok: false, reason };
}

function plain(value) {
  if (value == null) return null;
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
  throw new TypeError('Route data must contain finite JSON values.');
}
