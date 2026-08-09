/**
 * Pure contract for settlement-managed vegetation.
 *
 * This module intentionally contains no renderer, terrain, hydrology, or
 * settlement-plan imports. It describes the data that a later planner and
 * worker may consume. Asset IDs remain semantic placeholders until Sol owns
 * the cultivated-planting catalog.
 */

export const MANAGED_VEGETATION_VERSION = 1;

export const MANAGED_VEGETATION_PLACEHOLDER_IDS = Object.freeze({
  cultivatedPlantingAsset: 'placeholder:managed-vegetation:cultivated-planting:v1',
  cultivationHabit: 'placeholder:managed-vegetation:cultivation-habit:v1',
  bedPattern: 'placeholder:managed-vegetation:bed-pattern:v1',
  assetVariant: 'placeholder:managed-vegetation:asset-variant:v1',
});

export const MANAGED_VEGETATION_ASSET_DESCRIPTOR_SCHEMA = Object.freeze({
  version: MANAGED_VEGETATION_VERSION,
  fields: Object.freeze([
    'id', 'version', 'localFrame', 'trueBounds', 'clearance', 'collisionEnvelope',
    'groundCoverEffect', 'capabilityTags', 'slopeLimits', 'reliefLimits',
    'lodBudget', 'shadowBudget', 'drawBudget', 'triangleBudget',
  ]),
  localFrameFields: Object.freeze(['handedness', 'acrossAxis', 'upAxis', 'outwardAxis', 'units', 'origin']),
  trueBoundsFields: Object.freeze(['min', 'max']),
  clearanceFields: Object.freeze(['left', 'right', 'front', 'back', 'above']),
  collisionEnvelopeFields: Object.freeze(['mode', 'blocksMovement', 'bounds']),
  groundCoverEffects: Object.freeze(['none', 'cultivated-bed']),
});

export const MANAGED_VEGETATION_LOCAL_FRAME = Object.freeze({
  handedness: 'right',
  acrossAxis: '+x',
  upAxis: '+y',
  outwardAxis: '+z',
  units: 'metres',
  origin: 'footprint-centre-at-ground',
});

export const RESERVATION_SHAPE_KINDS = Object.freeze([
  'axis-aligned-rectangle', 'oriented-rectangle', 'circle', 'segment',
]);

export const RESERVATION_SOURCES = Object.freeze([
  'building', 'circulation', 'door-approach', 'civic-space',
  'authoritative-world-water', 'family-frontage',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegative(value) {
  return finiteNumber(value) && value >= 0;
}

function nonEmptyId(value) {
  return typeof value === 'string' && value.length > 0;
}

function vector3(value) {
  return Array.isArray(value) && value.length === 3 && value.every(finiteNumber);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function errorsForAssetDescriptor(descriptor) {
  const errors = [];
  if (!isObject(descriptor)) return ['descriptor-not-object'];
  for (const field of MANAGED_VEGETATION_ASSET_DESCRIPTOR_SCHEMA.fields) {
    if (!Object.hasOwn(descriptor, field)) errors.push('descriptor-missing:' + field);
  }
  if (!nonEmptyId(descriptor.id)) errors.push('descriptor-id');
  if (descriptor.version !== MANAGED_VEGETATION_VERSION) errors.push('descriptor-version');

  const frame = descriptor.localFrame;
  if (!isObject(frame)) errors.push('descriptor-local-frame');
  else {
    for (const field of MANAGED_VEGETATION_ASSET_DESCRIPTOR_SCHEMA.localFrameFields) {
      if (typeof frame[field] !== 'string' || !frame[field]) errors.push('descriptor-frame:' + field);
    }
    if (frame.handedness !== 'right') errors.push('descriptor-frame:handedness');
    if (frame.acrossAxis !== '+x' || frame.upAxis !== '+y' || frame.outwardAxis !== '+z') {
      errors.push('descriptor-frame:axes');
    }
    if (frame.units !== 'metres') errors.push('descriptor-frame:units');
  }

  const bounds = descriptor.trueBounds;
  if (!isObject(bounds) || !vector3(bounds.min) || !vector3(bounds.max)) errors.push('descriptor-true-bounds');
  else if (bounds.min.some((value, index) => value > bounds.max[index])) errors.push('descriptor-true-bounds-order');

  const clearance = descriptor.clearance;
  if (!isObject(clearance)) errors.push('descriptor-clearance');
  else for (const field of MANAGED_VEGETATION_ASSET_DESCRIPTOR_SCHEMA.clearanceFields) {
    if (!nonNegative(clearance[field])) errors.push('descriptor-clearance:' + field);
  }

  const collision = descriptor.collisionEnvelope;
  if (!isObject(collision)) errors.push('descriptor-collision-envelope');
  else {
    for (const field of MANAGED_VEGETATION_ASSET_DESCRIPTOR_SCHEMA.collisionEnvelopeFields) {
      if (!Object.hasOwn(collision, field)) errors.push('descriptor-collision:' + field);
    }
    if (!['none', 'footprint'].includes(collision.mode)) errors.push('descriptor-collision:mode');
    if (typeof collision.blocksMovement !== 'boolean') errors.push('descriptor-collision:blocks-movement');
    if (!isObject(collision.bounds) || !vector3(collision.bounds.min) || !vector3(collision.bounds.max)) {
      errors.push('descriptor-collision:bounds');
    } else if (collision.bounds.min.some((value, index) => value > collision.bounds.max[index])) {
      errors.push('descriptor-collision:bounds-order');
    }
    if (collision.mode === 'none' && collision.blocksMovement) errors.push('descriptor-collision:none-blocks');
  }

  if (!MANAGED_VEGETATION_ASSET_DESCRIPTOR_SCHEMA.groundCoverEffects.includes(descriptor.groundCoverEffect)) {
    errors.push('descriptor-ground-cover-effect');
  }
  if (!Array.isArray(descriptor.capabilityTags) || descriptor.capabilityTags.length === 0
    || descriptor.capabilityTags.some((tag) => !nonEmptyId(tag))
    || new Set(descriptor.capabilityTags).size !== descriptor.capabilityTags.length) {
    errors.push('descriptor-capability-tags');
  }

  const slopeLimits = descriptor.slopeLimits;
  if (!isObject(slopeLimits) || !nonNegative(slopeLimits.maxDegrees) || slopeLimits.maxDegrees > 90) {
    errors.push('descriptor-slope-limits');
  }
  const reliefLimits = descriptor.reliefLimits;
  if (!isObject(reliefLimits) || !nonNegative(reliefLimits.maxMetres)) errors.push('descriptor-relief-limits');

  const lod = descriptor.lodBudget;
  if (!isObject(lod) || !Number.isInteger(lod.levels) || lod.levels < 1 || !nonNegative(lod.maxDistance)) {
    errors.push('descriptor-lod-budget');
  }
  const shadow = descriptor.shadowBudget;
  if (!isObject(shadow) || typeof shadow.cast !== 'boolean' || typeof shadow.receive !== 'boolean') {
    errors.push('descriptor-shadow-budget');
  }
  if (!Number.isInteger(descriptor.drawBudget) || descriptor.drawBudget < 1) errors.push('descriptor-draw-budget');
  if (!Number.isInteger(descriptor.triangleBudget) || descriptor.triangleBudget < 0) errors.push('descriptor-triangle-budget');
  return errors;
}

/** Validate the frozen asset seam without requiring a visual catalog. */
export function validateManagedVegetationAssetDescriptor(descriptor) {
  const errors = errorsForAssetDescriptor(descriptor);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

/** Create a serializable, deeply frozen descriptor for fixtures and catalogs. */
export function createManagedVegetationAssetDescriptor(descriptor) {
  const result = validateManagedVegetationAssetDescriptor(descriptor);
  if (!result.valid) throw new TypeError(result.errors.join(', '));
  return deepFreeze({ ...descriptor });
}

const PLACEHOLDER_DESCRIPTOR = createManagedVegetationAssetDescriptor({
  id: MANAGED_VEGETATION_PLACEHOLDER_IDS.cultivatedPlantingAsset,
  version: MANAGED_VEGETATION_VERSION,
  localFrame: MANAGED_VEGETATION_LOCAL_FRAME,
  trueBounds: Object.freeze({ min: [-0.5, 0, -0.5], max: [0.5, 0.8, 0.5] }),
  clearance: Object.freeze({ left: 0.25, right: 0.25, front: 0.25, back: 0.25, above: 0.1 }),
  collisionEnvelope: Object.freeze({
    mode: 'footprint',
    blocksMovement: false,
    bounds: Object.freeze({ min: [-0.5, 0, -0.5], max: [0.5, 0.8, 0.5] }),
  }),
  groundCoverEffect: 'cultivated-bed',
  capabilityTags: Object.freeze(['cultivated-planting', 'placeholder']),
  slopeLimits: Object.freeze({ maxDegrees: 12 }),
  reliefLimits: Object.freeze({ maxMetres: 0.35 }),
  lodBudget: Object.freeze({ levels: 2, maxDistance: 32 }),
  shadowBudget: Object.freeze({ cast: false, receive: true }),
  drawBudget: 1,
  triangleBudget: 0,
});

export const MANAGED_VEGETATION_PLACEHOLDER_ASSETS = Object.freeze({
  cultivatedPlanting: PLACEHOLDER_DESCRIPTOR,
});

function point(value) {
  return isObject(value) && finiteNumber(value.x) && finiteNumber(value.z);
}

function shapeErrors(shape) {
  const errors = [];
  if (!isObject(shape)) return ['shape-not-object'];
  if (!RESERVATION_SHAPE_KINDS.includes(shape.kind)) errors.push('shape-kind');
  if (shape.kind === 'axis-aligned-rectangle' || shape.kind === 'oriented-rectangle') {
    if (!point(shape.center)) errors.push('shape-center');
    if (!isObject(shape.halfExtents) || !nonNegative(shape.halfExtents.x) || !nonNegative(shape.halfExtents.z)
      || shape.halfExtents.x === 0 || shape.halfExtents.z === 0) errors.push('shape-half-extents');
    if (shape.kind === 'oriented-rectangle' && !finiteNumber(shape.yaw)) errors.push('shape-yaw');
  } else if (shape.kind === 'circle') {
    if (!point(shape.center)) errors.push('shape-center');
    if (!finiteNumber(shape.radius) || shape.radius <= 0) errors.push('shape-radius');
  } else if (shape.kind === 'segment') {
    if (!point(shape.from) || !point(shape.to)) errors.push('shape-segment-points');
    if (!finiteNumber(shape.width) || shape.width <= 0) errors.push('shape-width');
    if (point(shape.from) && point(shape.to) && shape.from.x === shape.to.x && shape.from.z === shape.to.z) {
      errors.push('shape-segment-length');
    }
  }
  return errors;
}

export function validateReservationShape(shape) {
  const errors = shapeErrors(shape);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function createReservationShape(shape) {
  const result = validateReservationShape(shape);
  if (!result.valid) throw new TypeError(result.errors.join(', '));
  return deepFreeze({ ...shape });
}

export function createManagedVegetationReservation({ id, source, shape } = {}) {
  if (!nonEmptyId(id)) throw new TypeError('reservation id must be a non-empty ID.');
  if (!RESERVATION_SOURCES.includes(source)) throw new TypeError('unsupported reservation source: ' + source);
  return deepFreeze({ id, source, shape: createReservationShape(shape) });
}

function rotatedRectangleCorners(shape, padding = 0) {
  const hx = shape.halfExtents.x + padding, hz = shape.halfExtents.z + padding;
  const yaw = shape.yaw || 0, c = Math.cos(yaw), s = Math.sin(yaw);
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([x, z]) => ({
    x: shape.center.x + x * c + z * s,
    z: shape.center.z - x * s + z * c,
  }));
}

function shapePolygon(shape, padding = 0) {
  if (shape.kind === 'axis-aligned-rectangle' || shape.kind === 'oriented-rectangle') return rotatedRectangleCorners(shape, padding);
  if (shape.kind === 'circle') {
    const radius = shape.radius + padding;
    return Array.from({ length: 32 }, (_, index) => {
      const angle = (index / 32) * Math.PI * 2;
      return { x: shape.center.x + Math.cos(angle) * radius, z: shape.center.z + Math.sin(angle) * radius };
    });
  }
  const dx = shape.to.x - shape.from.x, dz = shape.to.z - shape.from.z;
  const length = Math.hypot(dx, dz), half = shape.width / 2 + padding;
  const nx = -dz / length * half, nz = dx / length * half;
  return [
    { x: shape.from.x + nx, z: shape.from.z + nz },
    { x: shape.to.x + nx, z: shape.to.z + nz },
    { x: shape.to.x - nx, z: shape.to.z - nz },
    { x: shape.from.x - nx, z: shape.from.z - nz },
  ];
}

function polygonAxes(polygon) {
  return polygon.map((from, index) => {
    const to = polygon[(index + 1) % polygon.length];
    return { x: -(to.z - from.z), z: to.x - from.x };
  });
}

function project(polygon, axis) {
  let min = Infinity, max = -Infinity;
  for (const value of polygon) {
    const projection = value.x * axis.x + value.z * axis.z;
    min = Math.min(min, projection); max = Math.max(max, projection);
  }
  return { min, max };
}

/** True when two reservation footprints overlap, including optional padding. */
export function reservationShapesOverlap(first, second, padding = 0) {
  if (!validateReservationShape(first).valid || !validateReservationShape(second).valid) return false;
  const a = shapePolygon(first, padding), b = shapePolygon(second, padding);
  for (const axis of [...polygonAxes(a), ...polygonAxes(b)]) {
    const pa = project(a, axis), pb = project(b, axis);
    if (pa.max < pb.min || pb.max < pa.min) return false;
  }
  return true;
}

function pointInPolygon(candidate, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index], b = polygon[previous];
    const crosses = (a.z > candidate.z) !== (b.z > candidate.z)
      && candidate.x < ((b.x - a.x) * (candidate.z - a.z)) / (b.z - a.z) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** True when a world x/z point falls inside a reservation shape. */
export function reservationShapeContainsPoint(shape, candidate, padding = 0) {
  if (!point(candidate) || !validateReservationShape(shape).valid) return false;
  return pointInPolygon(candidate, shapePolygon(shape, padding));
}

/** Validate a reservation record while retaining the source for handoff audits. */
export function validateManagedVegetationReservation(reservation) {
  const errors = [];
  if (!isObject(reservation)) return Object.freeze({ valid: false, errors: Object.freeze(['reservation-not-object']) });
  if (!nonEmptyId(reservation.id)) errors.push('reservation-id');
  if (!RESERVATION_SOURCES.includes(reservation.source)) errors.push('reservation-source');
  const shape = validateReservationShape(reservation.shape);
  if (!shape.valid) errors.push(...shape.errors.map((error) => 'reservation-' + error));
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export const MANAGED_VEGETATION_RESERVATION_SCHEMA = Object.freeze({
  fields: Object.freeze(['id', 'source', 'shape']),
  shapeKinds: RESERVATION_SHAPE_KINDS,
  sources: RESERVATION_SOURCES,
});
