// A renderer-free contract for a persistent person's trip.
//
// This module deliberately does not choose routes, advance clocks, move meshes,
// or change a person's residence. It only records which already-planned leg is
// authoritative now. The same transitions can therefore be driven by visible
// movement or an off-screen scheduler without producing different outcomes.

import { normalizeNpcResidence } from './npclocation.mjs';

export const ITINERARY_VERSION = 1;

export const ITINERARY_STATUS = Object.freeze({
  planned: 'planned',
  active: 'active',
  blocked: 'blocked',
  completed: 'completed',
  failed: 'failed',
});

export const ITINERARY_LEG_STATUS = Object.freeze({
  pending: 'pending',
  active: 'active',
  blocked: 'blocked',
  completed: 'completed',
  failed: 'failed',
});

export const ITINERARY_LEG_KIND = Object.freeze({
  localWalk: 'local-walk',
  regionalWalk: 'regional-walk',
  stationWait: 'station-wait',
  boardTrain: 'board-train',
  trainRide: 'train-ride',
  alightTrain: 'alight-train',
  destinationActivity: 'destination-activity',
});

export const ITINERARY_ACTIVITY_KIND = Object.freeze({
  visit: 'visit',
  quest: 'quest',
  leisure: 'leisure',
});

export const ITINERARY_LEG_DIRECTION = Object.freeze({
  outbound: 'outbound',
  activity: 'activity',
  returning: 'return',
});

const DIRECTIONS = ITINERARY_LEG_DIRECTION;

const STATUS_VALUES = new Set(Object.values(ITINERARY_STATUS));
const LEG_STATUS_VALUES = new Set(Object.values(ITINERARY_LEG_STATUS));
const LEG_KIND_VALUES = new Set(Object.values(ITINERARY_LEG_KIND));
const ACTIVITY_VALUES = new Set(Object.values(ITINERARY_ACTIVITY_KIND));
const DIRECTION_VALUES = new Set(Object.values(DIRECTIONS));

/**
 * Build a deterministic round trip from route legs supplied by another module.
 * The destination activity is inserted between the outward and return routes.
 */
export function createItinerary(input) {
  if (!input?.id || !input?.actorId) {
    throw new TypeError('An itinerary requires id and actorId.');
  }
  const residence = normalizeNpcResidence(input.residence);
  if (!residence) throw new TypeError('An itinerary requires a canonical NPC residence.');
  if (!input.origin?.key || !input.destination?.key) {
    throw new TypeError('An itinerary requires concrete origin and destination references.');
  }
  const activity = input.activity || {};
  if (!ACTIVITY_VALUES.has(activity.kind)) {
    throw new TypeError(`Unknown destination activity kind: ${activity.kind}`);
  }
  const outbound = normalizeRoute(input.outboundLegs, DIRECTIONS.outbound, 'outbound');
  const returning = normalizeRoute(input.returnLegs, DIRECTIONS.returning, 'return');
  if (!outbound.length || !returning.length) {
    throw new TypeError('A round-trip itinerary requires outward and return travel legs.');
  }

  const activityLeg = normalizeLeg({
    id: activity.id || 'activity',
    kind: ITINERARY_LEG_KIND.destinationActivity,
    data: { ...plain(activity.data), activityKind: activity.kind },
  }, DIRECTIONS.activity, outbound.length);
  const legs = [...outbound, activityLeg, ...returning];
  ensureUniqueLegIds(legs);

  const itinerary = {
    version: ITINERARY_VERSION,
    id: String(input.id),
    actorId: String(input.actorId),
    // Residence is identity context, not current position. No transition below
    // writes it; even a completed visit remains a visit rather than migration.
    residence,
    origin: plain(input.origin),
    destination: plain(input.destination),
    purpose: plain(input.purpose || { kind: activity.kind }),
    status: ITINERARY_STATUS.planned,
    legIndex: 0,
    legs,
    returnPlan: {
      required: true,
      home: residence,
      legIndex: outbound.length + 1,
      status: ITINERARY_STATUS.planned,
    },
    receiptSequence: 0,
    receipts: [],
    failure: null,
  };
  validateItinerary(itinerary);
  return itinerary;
}

/** Throw when an itinerary cannot be advanced without contradicting itself. */
export function validateItinerary(itinerary) {
  if (!itinerary || itinerary.version !== ITINERARY_VERSION) {
    throw new TypeError(`Unsupported itinerary version: ${itinerary?.version ?? 'missing'}`);
  }
  const canonicalResidence = normalizeNpcResidence(itinerary.residence);
  if (!itinerary.id || !itinerary.actorId || !canonicalResidence
      || !itinerary.origin?.key || !itinerary.destination?.key) {
    throw new TypeError('Itinerary identity, residence, origin, or destination is incomplete.');
  }
  if (!STATUS_VALUES.has(itinerary.status)) throw new TypeError('Invalid itinerary status.');
  if (!Array.isArray(itinerary.legs) || itinerary.legs.length < 3) {
    throw new TypeError('An itinerary requires outward, activity, and return legs.');
  }
  ensureUniqueLegIds(itinerary.legs);
  let activityCount = 0;
  let sawReturn = false;
  for (const [index, leg] of itinerary.legs.entries()) {
    if (!leg?.id || !LEG_KIND_VALUES.has(leg.kind) || !LEG_STATUS_VALUES.has(leg.status)
        || !DIRECTION_VALUES.has(leg.direction)) {
      throw new TypeError(`Malformed itinerary leg at index ${index}.`);
    }
    if (leg.direction === DIRECTIONS.activity) {
      activityCount++;
      if (leg.kind !== ITINERARY_LEG_KIND.destinationActivity
          || !ACTIVITY_VALUES.has(leg.data?.activityKind) || sawReturn) {
        throw new TypeError('The destination activity leg is malformed or out of order.');
      }
    } else if (leg.direction === DIRECTIONS.returning) {
      sawReturn = true;
      if (leg.kind === ITINERARY_LEG_KIND.destinationActivity) {
        throw new TypeError('A destination activity cannot be a return travel leg.');
      }
    } else if (activityCount || sawReturn || leg.kind === ITINERARY_LEG_KIND.destinationActivity) {
      throw new TypeError('Outbound legs must precede the destination activity and return legs.');
    }
  }
  if (activityCount !== 1 || !sawReturn) {
    throw new TypeError('An itinerary requires exactly one destination activity and a return route.');
  }
  if (!itinerary.returnPlan?.required
      || itinerary.returnPlan.legIndex !== itinerary.legs.findIndex((leg) => leg.direction === DIRECTIONS.returning)
      || !sameResidence(itinerary.returnPlan.home, canonicalResidence)
      || !STATUS_VALUES.has(itinerary.returnPlan.status)) {
    throw new TypeError('The explicit return-home plan is missing or inconsistent.');
  }
  if (!Number.isInteger(itinerary.legIndex) || itinerary.legIndex < 0
      || itinerary.legIndex > itinerary.legs.length) {
    throw new TypeError('Invalid current itinerary leg index.');
  }
  validateRuntimeConsistency(itinerary);
  validateReceipts(itinerary);
  return true;
}

export function currentItineraryLeg(itinerary) {
  return itinerary?.legs?.[itinerary.legIndex] || null;
}

export function startItineraryLeg(itinerary, legId = currentItineraryLeg(itinerary)?.id, details = {}) {
  assertMutableItinerary(itinerary);
  const leg = requireCurrentLeg(itinerary, legId);
  if (leg.status === ITINERARY_LEG_STATUS.active) return priorReceipt(itinerary, leg.id, 'leg.started');
  if (leg.status !== ITINERARY_LEG_STATUS.pending) {
    throw new Error(`Cannot start ${leg.id} from ${leg.status}.`);
  }
  leg.status = ITINERARY_LEG_STATUS.active;
  itinerary.status = ITINERARY_STATUS.active;
  if (leg.direction === DIRECTIONS.returning) itinerary.returnPlan.status = ITINERARY_STATUS.active;
  return recordReceipt(itinerary, leg, 'leg.started', details);
}

export function completeItineraryLeg(itinerary, legId = currentItineraryLeg(itinerary)?.id, details = {}) {
  if (!itinerary) throw new TypeError('Missing itinerary.');
  const existing = itinerary.legs?.find((leg) => leg.id === String(legId));
  if (existing?.status === ITINERARY_LEG_STATUS.completed) {
    return priorReceipt(itinerary, existing.id, 'leg.completed');
  }
  assertMutableItinerary(itinerary);
  const leg = requireCurrentLeg(itinerary, legId);
  if (leg.status !== ITINERARY_LEG_STATUS.active) {
    throw new Error(`Cannot complete ${leg.id} from ${leg.status}.`);
  }
  leg.status = ITINERARY_LEG_STATUS.completed;
  leg.outcome = plain(details.outcome);
  const receipt = recordReceipt(itinerary, leg, 'leg.completed', details);
  itinerary.legIndex++;
  if (itinerary.legIndex >= itinerary.legs.length) {
    itinerary.status = ITINERARY_STATUS.completed;
    itinerary.returnPlan.status = ITINERARY_STATUS.completed;
  } else {
    itinerary.status = ITINERARY_STATUS.active;
  }
  return receipt;
}

export function blockItineraryLeg(itinerary, legId = currentItineraryLeg(itinerary)?.id, details = {}) {
  assertMutableItinerary(itinerary);
  const leg = requireCurrentLeg(itinerary, legId);
  if (leg.status === ITINERARY_LEG_STATUS.blocked) return priorReceipt(itinerary, leg.id, 'leg.blocked');
  if (leg.status !== ITINERARY_LEG_STATUS.active) {
    throw new Error(`Cannot block ${leg.id} from ${leg.status}.`);
  }
  leg.status = ITINERARY_LEG_STATUS.blocked;
  leg.blocked = {
    code: String(details.code || 'blocked'),
    data: plain(details.data),
  };
  itinerary.status = ITINERARY_STATUS.blocked;
  return recordReceipt(itinerary, leg, 'leg.blocked', details);
}

export function resumeItineraryLeg(itinerary, legId = currentItineraryLeg(itinerary)?.id, details = {}) {
  assertMutableItinerary(itinerary, { allowBlocked: true });
  const leg = requireCurrentLeg(itinerary, legId);
  if (leg.status === ITINERARY_LEG_STATUS.active) return priorReceipt(itinerary, leg.id, 'leg.resumed');
  if (leg.status !== ITINERARY_LEG_STATUS.blocked) {
    throw new Error(`Cannot resume ${leg.id} from ${leg.status}.`);
  }
  leg.status = ITINERARY_LEG_STATUS.active;
  leg.blocked = null;
  itinerary.status = ITINERARY_STATUS.active;
  return recordReceipt(itinerary, leg, 'leg.resumed', details);
}

export function failItineraryLeg(itinerary, legId = currentItineraryLeg(itinerary)?.id, details = {}) {
  assertMutableItinerary(itinerary, { allowBlocked: true });
  const leg = requireCurrentLeg(itinerary, legId);
  if (![ITINERARY_LEG_STATUS.pending, ITINERARY_LEG_STATUS.active,
    ITINERARY_LEG_STATUS.blocked].includes(leg.status)) {
    throw new Error(`Cannot fail ${leg.id} from ${leg.status}.`);
  }
  leg.status = ITINERARY_LEG_STATUS.failed;
  leg.blocked = null;
  itinerary.status = ITINERARY_STATUS.failed;
  itinerary.failure = {
    legId: leg.id,
    code: String(details.code || 'failed'),
    data: plain(details.data),
  };
  if (leg.direction === DIRECTIONS.returning) itinerary.returnPlan.status = ITINERARY_STATUS.failed;
  return recordReceipt(itinerary, leg, 'leg.failed', details);
}

/** Compact, JSON-safe persistence form. */
export function itinerarySnapshot(itinerary) {
  validateItinerary(itinerary);
  return {
    v: itinerary.version,
    id: itinerary.id,
    a: itinerary.actorId,
    r: plain(itinerary.residence),
    o: plain(itinerary.origin),
    d: plain(itinerary.destination),
    p: plain(itinerary.purpose),
    s: itinerary.status,
    i: itinerary.legIndex,
    l: itinerary.legs.map((leg) => [
      leg.id, leg.kind, leg.direction, leg.status, plain(leg.data),
      plain(leg.blocked), plain(leg.outcome),
    ]),
    h: [itinerary.returnPlan.required, plain(itinerary.returnPlan.home),
      itinerary.returnPlan.legIndex, itinerary.returnPlan.status],
    q: itinerary.receiptSequence,
    x: itinerary.receipts.map((receipt) => [
      receipt.id, receipt.sequence, receipt.type, receipt.legId, receipt.legIndex,
      plain(receipt.details),
    ]),
    f: plain(itinerary.failure),
  };
}

export function restoreItinerarySnapshot(snapshot) {
  if (!snapshot || snapshot.v !== ITINERARY_VERSION || !Array.isArray(snapshot.l)
      || !Array.isArray(snapshot.h) || !Array.isArray(snapshot.x)) {
    throw new TypeError('Malformed itinerary snapshot.');
  }
  const residence = normalizeNpcResidence(snapshot.r);
  const returnHome = normalizeNpcResidence(snapshot.h[1]);
  if (!residence || !returnHome || !sameResidence(residence, returnHome)) {
    throw new TypeError('Malformed itinerary snapshot residence.');
  }
  const itinerary = {
    version: snapshot.v,
    id: String(snapshot.id || ''),
    actorId: String(snapshot.a || ''),
    residence,
    origin: plain(snapshot.o),
    destination: plain(snapshot.d),
    purpose: plain(snapshot.p),
    status: snapshot.s,
    legIndex: snapshot.i,
    legs: snapshot.l.map((leg, index) => {
      if (!Array.isArray(leg) || leg.length !== 7) {
        throw new TypeError(`Malformed itinerary snapshot leg at index ${index}.`);
      }
      return {
        id: String(leg[0] || ''), kind: leg[1], direction: leg[2], status: leg[3],
        data: plain(leg[4]), blocked: plain(leg[5]), outcome: plain(leg[6]),
      };
    }),
    returnPlan: {
      required: snapshot.h[0], home: residence,
      legIndex: snapshot.h[2], status: snapshot.h[3],
    },
    receiptSequence: snapshot.q,
    receipts: snapshot.x.map((receipt, index) => {
      if (!Array.isArray(receipt) || receipt.length !== 6) {
        throw new TypeError(`Malformed itinerary snapshot receipt at index ${index}.`);
      }
      return {
        id: String(receipt[0] || ''), sequence: receipt[1], type: receipt[2],
        legId: receipt[3], legIndex: receipt[4], details: plain(receipt[5]),
      };
    }),
    failure: plain(snapshot.f),
  };
  validateItinerary(itinerary);
  return itinerary;
}

function normalizeRoute(route, direction, label) {
  if (!Array.isArray(route)) throw new TypeError(`${label} legs must be an array.`);
  return route.map((leg, index) => normalizeLeg(leg, direction, index));
}

function normalizeLeg(input, direction, index) {
  if (!LEG_KIND_VALUES.has(input?.kind) || input.kind === ITINERARY_LEG_KIND.destinationActivity) {
    if (direction !== DIRECTIONS.activity || input?.kind !== ITINERARY_LEG_KIND.destinationActivity) {
      throw new TypeError(`Unknown or misplaced itinerary leg kind: ${input?.kind}`);
    }
  }
  return {
    id: String(input.id || `${direction}:${index}`),
    kind: input.kind,
    direction,
    status: ITINERARY_LEG_STATUS.pending,
    data: plain(input.data),
    blocked: null,
    outcome: null,
  };
}

function requireCurrentLeg(itinerary, legId) {
  const leg = currentItineraryLeg(itinerary);
  if (!leg) throw new Error('The itinerary has no current leg.');
  if (leg.id !== String(legId || '')) {
    throw new Error(`Leg ${legId || 'missing'} is not current; expected ${leg.id}.`);
  }
  return leg;
}

function assertMutableItinerary(itinerary, { allowBlocked = false } = {}) {
  validateItinerary(itinerary);
  if ([ITINERARY_STATUS.completed, ITINERARY_STATUS.failed].includes(itinerary.status)
      || (!allowBlocked && itinerary.status === ITINERARY_STATUS.blocked)) {
    throw new Error(`Cannot advance an itinerary in ${itinerary.status} state.`);
  }
}

function recordReceipt(itinerary, leg, type, details) {
  const duplicate = priorReceipt(itinerary, leg.id, type);
  if (duplicate) return duplicate;
  const sequence = ++itinerary.receiptSequence;
  const receipt = {
    id: `${itinerary.id}:leg-transition:${sequence}`,
    sequence,
    type,
    legId: leg.id,
    legIndex: itinerary.legs.indexOf(leg),
    details: plain(details),
  };
  itinerary.receipts.push(receipt);
  return receipt;
}

function priorReceipt(itinerary, legId, type) {
  return itinerary?.receipts?.find((receipt) => receipt.legId === legId && receipt.type === type) || null;
}

function ensureUniqueLegIds(legs) {
  const ids = new Set();
  for (const leg of legs) {
    if (!leg?.id || ids.has(leg.id)) throw new TypeError(`Duplicate or missing itinerary leg id: ${leg?.id}`);
    ids.add(leg.id);
  }
}

function validateRuntimeConsistency(itinerary) {
  const completedBefore = itinerary.legs.slice(0, itinerary.legIndex);
  if (completedBefore.some((leg) => leg.status !== ITINERARY_LEG_STATUS.completed)) {
    throw new TypeError('A leg before the current index is not completed.');
  }
  const current = currentItineraryLeg(itinerary);
  if (itinerary.status === ITINERARY_STATUS.completed) {
    if (itinerary.legIndex !== itinerary.legs.length
        || itinerary.legs.some((leg) => leg.status !== ITINERARY_LEG_STATUS.completed)
        || itinerary.returnPlan.status !== ITINERARY_STATUS.completed) {
      throw new TypeError('Completed itinerary state is inconsistent.');
    }
  } else if (!current) {
    throw new TypeError('A non-completed itinerary has no current leg.');
  }
  if (itinerary.status === ITINERARY_STATUS.blocked && current?.status !== ITINERARY_LEG_STATUS.blocked) {
    throw new TypeError('Blocked itinerary has no blocked current leg.');
  }
  if (itinerary.status === ITINERARY_STATUS.failed && current?.status !== ITINERARY_LEG_STATUS.failed) {
    throw new TypeError('Failed itinerary has no failed current leg.');
  }
  const later = itinerary.legs.slice(itinerary.legIndex + 1);
  if (later.some((leg) => leg.status !== ITINERARY_LEG_STATUS.pending)) {
    throw new TypeError('A future itinerary leg is not pending.');
  }
}

function validateReceipts(itinerary) {
  if (!Number.isInteger(itinerary.receiptSequence) || itinerary.receiptSequence < 0
      || !Array.isArray(itinerary.receipts)) {
    throw new TypeError('Invalid itinerary receipt sequence.');
  }
  const ids = new Set();
  const transitions = new Set();
  let last = 0;
  for (const receipt of itinerary.receipts) {
    if (!receipt?.id || !Number.isInteger(receipt.sequence) || receipt.sequence <= last
        || receipt.sequence > itinerary.receiptSequence
        || !itinerary.legs.some((leg) => leg.id === receipt.legId)
        || !Number.isInteger(receipt.legIndex)
        || itinerary.legs[receipt.legIndex]?.id !== receipt.legId
        || ids.has(receipt.id) || transitions.has(`${receipt.legId}:${receipt.type}`)) {
      throw new TypeError('Malformed or duplicate itinerary transition receipt.');
    }
    ids.add(receipt.id);
    transitions.add(`${receipt.legId}:${receipt.type}`);
    last = receipt.sequence;
  }
  if (last !== itinerary.receiptSequence) {
    throw new TypeError('Itinerary receipt sequence does not match its receipts.');
  }
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

// Canonical JSON data makes snapshot strings stable even when callers build
// metadata objects with different insertion order. Undefined values are simply
// absent, matching JSON semantics rather than leaking runtime-only values.
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
  if (['string', 'number', 'boolean'].includes(typeof value) && Number.isFinite(value)) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  throw new TypeError('Itinerary data must be finite JSON values.');
}
