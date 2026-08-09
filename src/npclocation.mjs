// Durable residence and current position are deliberately different facts.
//
// A person does not stop belonging to a household when they step onto a trail
// or sit on a train.  This small data-only contract keeps those facts apart and
// gives streaming, itinerary and persistence code one canonical shape to share.
// It has no renderer dependency and every accepted value is JSON-safe.

export const NPC_LOCATION_KIND = Object.freeze({
  building: 'building',
  settlementNode: 'settlement-node',
  regionalEdge: 'regional-edge',
  stationPlatform: 'station-platform',
  trainSeat: 'train-seat',
  worldSite: 'world-site',
});

const LOCATION_FIELDS = Object.freeze({
  [NPC_LOCATION_KIND.building]: Object.freeze({
    required: Object.freeze(['settlementId', 'buildingId']),
    optional: Object.freeze(['nodeId']),
  }),
  [NPC_LOCATION_KIND.settlementNode]: Object.freeze({
    required: Object.freeze(['settlementId', 'nodeId']),
    optional: Object.freeze([]),
  }),
  [NPC_LOCATION_KIND.regionalEdge]: Object.freeze({
    required: Object.freeze(['edgeId', 'fromKey', 'toKey', 'progress']),
    optional: Object.freeze([]),
  }),
  [NPC_LOCATION_KIND.stationPlatform]: Object.freeze({
    required: Object.freeze(['stationId', 'platformId', 'waitAnchorId']),
    optional: Object.freeze([]),
  }),
  [NPC_LOCATION_KIND.trainSeat]: Object.freeze({
    required: Object.freeze(['runId', 'carriageId', 'seatId']),
    optional: Object.freeze([]),
  }),
  [NPC_LOCATION_KIND.worldSite]: Object.freeze({
    required: Object.freeze(['siteId']),
    optional: Object.freeze(['nodeId']),
  }),
});

const RESIDENCE_FIELDS = Object.freeze([
  'originSettlementId',
  'residenceSettlementId',
  'householdId',
  'homeBuildingId',
]);

/**
 * Create immutable durable residence data.
 *
 * `originSettlementId` is biographical and does not change.  A later migration
 * may replace `residenceSettlementId`, household or building as one explicit
 * operation, but ordinary movement never touches this object.
 */
export function createNpcResidence(value) {
  const residence = normalizeNpcResidence(value);
  if (!residence) throw new TypeError('Invalid NPC residence.');
  return residence;
}

/** Return a defensive canonical residence, or null for malformed input. */
export function normalizeNpcResidence(value) {
  if (!isPlainObject(value) || hasUnexpectedKeys(value, RESIDENCE_FIELDS)) return null;
  if (!isId(value.originSettlementId) || !isId(value.residenceSettlementId)) return null;
  if (!isOptionalId(value.householdId) || !isOptionalId(value.homeBuildingId)) return null;
  return Object.freeze({
    originSettlementId: value.originSettlementId,
    residenceSettlementId: value.residenceSettlementId,
    householdId: value.householdId ?? null,
    homeBuildingId: value.homeBuildingId ?? null,
  });
}

export function isNpcResidence(value) {
  return normalizeNpcResidence(value) !== null;
}

/** Create one immutable current-location value. */
export function createNpcLocation(kind, fields = {}) {
  const location = normalizeNpcLocation({ ...fields, kind });
  if (!location) throw new TypeError(`Invalid NPC location${kind ? ` (${kind})` : ''}.`);
  return location;
}

/** Return a defensive canonical location, or null for malformed input. */
export function normalizeNpcLocation(value) {
  if (!isPlainObject(value) || !isId(value.kind)) return null;
  const schema = LOCATION_FIELDS[value.kind];
  if (!schema) return null;
  const allowed = ['kind', ...schema.required, ...schema.optional];
  if (hasUnexpectedKeys(value, allowed)) return null;
  for (const field of schema.required) {
    if (field === 'progress') {
      if (!Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1) return null;
    } else if (!isId(value[field])) return null;
  }
  for (const field of schema.optional) {
    if (!isOptionalId(value[field])) return null;
  }
  const location = { kind: value.kind };
  for (const field of schema.required) location[field] = value[field];
  for (const field of schema.optional) location[field] = value[field] ?? null;
  return Object.freeze(location);
}

export function isNpcLocation(value) {
  return normalizeNpcLocation(value) !== null;
}

/**
 * Bind stable residence to a current location without merging their fields.
 * This is the unit itinerary and persistence code should carry for one person.
 */
export function createNpcSpatialState({ residence, location } = {}) {
  const normalizedResidence = normalizeNpcResidence(residence);
  const normalizedLocation = normalizeNpcLocation(location);
  if (!normalizedResidence || !normalizedLocation) throw new TypeError('Invalid NPC spatial state.');
  return Object.freeze({ residence: normalizedResidence, location: normalizedLocation });
}

/** Move a person while retaining the exact durable residence object. */
export function withNpcLocation(spatialState, location) {
  const current = normalizeNpcSpatialState(spatialState);
  const next = normalizeNpcLocation(location);
  if (!current || !next) throw new TypeError('Invalid NPC spatial transition.');
  // States created by this module already contain an immutable canonical
  // residence. Retain that exact object so movement cannot accidentally look
  // like a residence update to identity-based change detection. Untrusted or
  // mutable input still receives the defensive normalized copy.
  const residence = Object.isFrozen(spatialState.residence)
    ? spatialState.residence
    : current.residence;
  return Object.freeze({ residence, location: next });
}

/** Return a defensive canonical spatial state, or null for malformed input. */
export function normalizeNpcSpatialState(value) {
  if (!isPlainObject(value) || hasUnexpectedKeys(value, ['residence', 'location'])) return null;
  const residence = normalizeNpcResidence(value.residence);
  const location = normalizeNpcLocation(value.location);
  return residence && location ? Object.freeze({ residence, location }) : null;
}

/** Exact equality over the canonical fields for a location kind. */
export function sameNpcLocation(a, b) {
  const left = normalizeNpcLocation(a);
  const right = normalizeNpcLocation(b);
  if (!left || !right || left.kind !== right.kind) return false;
  const schema = LOCATION_FIELDS[left.kind];
  return [...schema.required, ...schema.optional]
    .every((field) => left[field] === right[field]);
}

/** Plain, JSON-roundtrippable defensive snapshot. */
export function npcSpatialSnapshot(value) {
  const state = normalizeNpcSpatialState(value);
  if (!state) throw new TypeError('Invalid NPC spatial state.');
  return {
    residence: { ...state.residence },
    location: { ...state.location },
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isOptionalId(value) {
  return value == null || isId(value);
}

function hasUnexpectedKeys(value, allowed) {
  const allowedSet = new Set(allowed);
  return Object.keys(value).some((key) => !allowedSet.has(key));
}
