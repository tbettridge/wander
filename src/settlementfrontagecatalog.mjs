// A data-only catalog for the small things that make a settlement frontage
// look inhabited.
//
// This module deliberately has no Three dependency. Planning, workers and
// tests can select an asset from this catalog without importing the renderer.
// The companion settlementfrontagevisuals.mjs turns the selected catalog ID
// into ordinary static Three meshes later.
//
// Local frame (matching buildingplan.mjs): +x runs across the frontage, +y is
// up, and +z points out through the front door. Ground assets use the centre of
// their footprint at y=0. Family marks use their wall-mount centre as origin.

import {
  FAMILY_FRONTAGE_ASSET_METADATA_SCHEMA,
  FAMILY_FRONTAGE_VERSION,
  FAMILY_OWNED_PROGRAMS,
} from './familyfrontage.mjs';

export const FRONTAGE_VISUAL_CATALOG_VERSION = FAMILY_FRONTAGE_VERSION;

export const FRONTAGE_LOCAL_FRAME = Object.freeze({
  handedness: 'right',
  acrossAxis: '+x',
  upAxis: '+y',
  outwardAxis: '+z',
  groundOrigin: 'footprint-centre-at-ground',
  wallOrigin: 'mount-centre',
  units: 'metres',
});

export const FRONTAGE_PROGRAMS = FAMILY_OWNED_PROGRAMS;

export const FRONTAGE_ZONES = Object.freeze({
  buildingFront: 'building-front',
  buildingSide: 'building-side',
  thresholdEdge: 'threshold-edge',
  gardenEdge: 'garden-edge',
  sideYard: 'side-yard',
  rearYard: 'rear-yard',
  workYard: 'work-yard',
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function material(id, color, roughness, metalness = 0, flatShading = false) {
  return deepFreeze({ id, color, roughness, metalness, flatShading });
}

// Restrained earth, wood and work colours. These IDs, rather than raw colour
// values or household IDs, are the renderer's material-sharing keys.
export const FRONTAGE_MATERIALS = deepFreeze({
  'frontage.wood.dark': material('frontage.wood.dark', 0x49392c, 0.96),
  'frontage.wood.mid': material('frontage.wood.mid', 0x675039, 0.94),
  'frontage.wood.weathered': material('frontage.wood.weathered', 0x756b5d, 0.98),
  'frontage.wood.cut': material('frontage.wood.cut', 0x9a7b55, 0.95),
  'frontage.stone.field': material('frontage.stone.field', 0x777267, 1, 0, true),
  'frontage.stone.pale': material('frontage.stone.pale', 0x9b9585, 1, 0, true),
  'frontage.metal.iron': material('frontage.metal.iron', 0x343938, 0.72, 0.42),
  'frontage.metal.dull': material('frontage.metal.dull', 0x545956, 0.82, 0.24),
  'frontage.earth.loam': material('frontage.earth.loam', 0x5d4c3d, 1),
  'frontage.plant.leaf': material('frontage.plant.leaf', 0x596649, 1, 0, true),
  'frontage.plant.dry': material('frontage.plant.dry', 0x837553, 1, 0, true),
  'frontage.clay': material('frontage.clay', 0x805b45, 0.98),
  'frontage.grain': material('frontage.grain', 0x927c50, 1),
  'frontage.mark.soot': material('frontage.mark.soot', 0x313331, 0.98),
  'frontage.mark.lime': material('frontage.mark.lime', 0xb1aa96, 1),

  // Household accents stay low-chroma so a whole street does not turn into a
  // row of heraldic signs. Identity never relies on these hues: the family-mark
  // silhouettes remain distinct when rendered in one grey material.
  'frontage.household.ash': material('frontage.household.ash', 0x7b7468, 0.94),
  'frontage.household.russet': material('frontage.household.russet', 0x7c5142, 0.94),
  'frontage.household.ochre': material('frontage.household.ochre', 0x8d7048, 0.94),
  'frontage.household.moss': material('frontage.household.moss', 0x59634a, 0.94),
  'frontage.household.slate': material('frontage.household.slate', 0x566570, 0.94),
  'frontage.household.plum': material('frontage.household.plum', 0x685258, 0.94),
});

export const HOUSEHOLD_PALETTE_IDS = Object.freeze([
  'frontage.household.ash',
  'frontage.household.russet',
  'frontage.household.ochre',
  'frontage.household.moss',
  'frontage.household.slate',
  'frontage.household.plum',
]);

function stroke(from, to, width = 0.075) {
  return deepFreeze({ from, to, width });
}

// Small relief marks derived from simple cuts and bent battens, not heraldry,
// trade symbols, flags or logos. Their topology is different in greyscale;
// treatment and household colour are secondary presentation choices.
export const FAMILY_MARK_SILHOUETTES = deepFreeze({
  'family-mark.cleft': {
    id: 'family-mark.cleft',
    strokes: [stroke([-0.3, 0.3], [0, -0.28]), stroke([0.3, 0.3], [0, -0.28])],
    pegs: [[0, -0.28]],
  },
  'family-mark.open-arch': {
    id: 'family-mark.open-arch',
    strokes: [stroke([-0.3, -0.3], [-0.3, 0.23]), stroke([-0.3, 0.23], [0, 0.34]),
      stroke([0, 0.34], [0.3, 0.23]), stroke([0.3, 0.23], [0.3, -0.3])],
    pegs: [],
  },
  'family-mark.bent-rung': {
    id: 'family-mark.bent-rung',
    strokes: [stroke([-0.3, 0.28], [0.18, 0.28]), stroke([0.18, 0.28], [0.18, -0.03]),
      stroke([0.18, -0.03], [-0.18, -0.03]), stroke([-0.18, -0.03], [-0.18, -0.3])],
    pegs: [[-0.18, -0.3]],
  },
  'family-mark.three-notch': {
    id: 'family-mark.three-notch',
    strokes: [stroke([-0.22, -0.32], [-0.22, 0.32]), stroke([-0.22, 0.24], [0.3, 0.24]),
      stroke([-0.22, 0], [0.18, 0]), stroke([-0.22, -0.24], [0.3, -0.24])],
    pegs: [],
  },
  'family-mark.stepped': {
    id: 'family-mark.stepped',
    strokes: [stroke([-0.32, -0.26], [-0.08, -0.26]), stroke([-0.08, -0.26], [-0.08, 0]),
      stroke([-0.08, 0], [0.16, 0]), stroke([0.16, 0], [0.16, 0.26]),
      stroke([0.16, 0.26], [0.34, 0.26])],
    pegs: [],
  },
  'family-mark.paired-stems': {
    id: 'family-mark.paired-stems',
    strokes: [stroke([-0.18, -0.32], [-0.18, 0.3]), stroke([0.18, -0.3], [0.18, 0.32]),
      stroke([-0.18, 0.08], [0.18, -0.08])],
    pegs: [[-0.18, -0.32], [0.18, 0.32]],
  },
});

export const FAMILY_MARK_TREATMENTS = deepFreeze({
  'mark-treatment.incised': {
    id: 'mark-treatment.incised', materialId: 'frontage.mark.soot', depth: 0.035, widthScale: 0.88,
  },
  'mark-treatment.limed': {
    id: 'mark-treatment.limed', materialId: 'frontage.mark.lime', depth: 0.045, widthScale: 1,
  },
  'mark-treatment.iron': {
    id: 'mark-treatment.iron', materialId: 'frontage.metal.iron', depth: 0.065, widthScale: 0.82,
  },
  'mark-treatment.washed': {
    id: 'mark-treatment.washed', materialRole: 'household', depth: 0.045, widthScale: 1.05,
  },
});

const allPrograms = FRONTAGE_PROGRAMS;
const groundClearance = deepFreeze({ left: 0.25, right: 0.25, front: 0.45, back: 0.25, above: 0.2 });
const wallClearance = deepFreeze({ left: 0.18, right: 0.18, front: 0.08, back: 0, above: 0.18 });

function bounds(minX, minY, minZ, maxX, maxY, maxZ) {
  return deepFreeze({ min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });
}

function noCollision() {
  return deepFreeze({ mode: 'none', blocksMovement: false });
}

function footprintCollision(minX, minZ, maxX, maxZ) {
  return deepFreeze({ mode: 'footprint', blocksMovement: true, bounds: [minX, minZ, maxX, maxZ] });
}

function segmentCollision(segments) {
  return deepFreeze({ mode: 'segments', blocksMovement: true, segments });
}

function groundHints({ preferredZones, wallGap = [0.55, 2.5], pathGap = 0.55, mirror = true,
  rotationStepDegrees = 5, maxPerBuilding = 1 } = {}) {
  return deepFreeze({
    origin: 'footprint-centre-at-ground', outwardAxis: '+z', preferredZones,
    wallGap, pathGap, doorApproachGap: 1.25, mirrorAllowed: mirror,
    rotationStepDegrees, maxPerBuilding,
  });
}

function asset(id, category, spec) {
  const { min, max } = spec.localBounds;
  const wallAttached = category === 'family-mark';
  // Include Luna's WP0 field names verbatim. The richer aliases remain useful
  // to render/build validation, while WP2 can consume the frozen pure contract
  // without translating metadata names.
  return deepFreeze({
    version: FRONTAGE_VISUAL_CATALOG_VERSION,
    id,
    category,
    ...spec,
    programs: spec.allowedPrograms,
    zones: spec.allowedZones,
    halfExtents: {
      x: Math.max(Math.abs(min[0]), Math.abs(max[0])),
      z: Math.max(Math.abs(min[2]), Math.abs(max[2])),
    },
    height: max[1] - min[1],
    slopeTolerance: spec.slopeToleranceDegrees,
    reliefTolerance: spec.reliefToleranceMeters,
    wallAttached,
    groundSeated: !wallAttached,
    collider: spec.collision,
    groundCover: 'none',
  });
}

const markAssets = Object.fromEntries(Object.keys(FAMILY_MARK_SILHOUETTES).map((id) => [id, asset(id, 'family-mark', {
  builder: 'family-mark', allowedPrograms: allPrograms,
  allowedZones: [FRONTAGE_ZONES.buildingFront, FRONTAGE_ZONES.buildingSide],
  localBounds: bounds(-0.39, -0.39, -0.035, 0.39, 0.39, 0.035),
  clearance: wallClearance, slopeToleranceDegrees: 90, reliefToleranceMeters: 0,
  collision: noCollision(), meshBudget: 8, triangleBudget: 160,
  materialIds: ['frontage.mark.soot', 'frontage.mark.lime', 'frontage.metal.iron', ...HOUSEHOLD_PALETTE_IDS],
  placementHints: {
    origin: 'wall-mount-centre', outwardAxis: '+z', preferredHeight: [1.45, 2.15],
    doorEdgeGap: 0.42, openingEdgeGap: 0.28, mirrorAllowed: false,
    rotationStepDegrees: 0, maxPerBuilding: 1,
  },
})]));

export const FRONTAGE_ASSETS = deepFreeze({
  ...markAssets,

  'fence.wattle-gap': asset('fence.wattle-gap', 'partial-fence', {
    builder: 'wattle-gap', allowedPrograms: allPrograms,
    allowedZones: [FRONTAGE_ZONES.gardenEdge, FRONTAGE_ZONES.sideYard, FRONTAGE_ZONES.rearYard],
    localBounds: bounds(-2.8, 0, -0.16, 2.8, 1.12, 0.16), clearance: groundClearance,
    slopeToleranceDegrees: 9, reliefToleranceMeters: 0.22,
    collision: segmentCollision([[-2.7, 0, -0.72, 0, 0.12], [0.72, 0, 2.7, 0, 0.12]]),
    meshBudget: 24, triangleBudget: 320,
    materialIds: ['frontage.wood.dark', 'frontage.wood.weathered'],
    placementHints: groundHints({ preferredZones: ['garden-boundary', 'yard-boundary'], wallGap: [1.2, 5.5], pathGap: 0.4 }),
  }),
  'fence.split-rail-corner': asset('fence.split-rail-corner', 'partial-fence', {
    builder: 'split-rail-corner', allowedPrograms: allPrograms,
    allowedZones: [FRONTAGE_ZONES.gardenEdge, FRONTAGE_ZONES.sideYard, FRONTAGE_ZONES.rearYard, FRONTAGE_ZONES.workYard],
    localBounds: bounds(-2.45, 0, -0.15, 0.15, 1.18, 2.45), clearance: groundClearance,
    slopeToleranceDegrees: 11, reliefToleranceMeters: 0.28,
    collision: segmentCollision([[-2.35, 0, 0, 0, 0.13], [0, 0, 0, 2.35, 0.13]]),
    meshBudget: 14, triangleBudget: 190,
    materialIds: ['frontage.wood.dark', 'frontage.wood.weathered'],
    placementHints: groundHints({ preferredZones: ['yard-corner', 'work-yard-edge'], wallGap: [1.4, 6], pathGap: 0.45 }),
  }),
  'fence.low-pale-run': asset('fence.low-pale-run', 'partial-fence', {
    builder: 'low-pale-run', allowedPrograms: ['dwelling', 'inn'],
    allowedZones: [FRONTAGE_ZONES.buildingFront, FRONTAGE_ZONES.gardenEdge],
    localBounds: bounds(-2.25, 0, -0.15, 2.25, 0.92, 0.15), clearance: groundClearance,
    slopeToleranceDegrees: 8, reliefToleranceMeters: 0.18,
    collision: segmentCollision([[-2.18, 0, -0.58, 0, 0.11], [0.58, 0, 2.18, 0, 0.11]]),
    meshBudget: 18, triangleBudget: 230,
    materialIds: ['frontage.wood.dark', 'frontage.wood.weathered'],
    placementHints: groundHints({ preferredZones: ['front-garden-edge'], wallGap: [2, 5], pathGap: 0.35 }),
  }),

  'yard.raised-bed-pair': asset('yard.raised-bed-pair', 'garden', {
    builder: 'raised-bed-pair', allowedPrograms: ['dwelling', 'inn'],
    allowedZones: [FRONTAGE_ZONES.sideYard, FRONTAGE_ZONES.rearYard],
    localBounds: bounds(-1.7, 0, -1.15, 1.7, 0.76, 1.15), clearance: groundClearance,
    slopeToleranceDegrees: 6, reliefToleranceMeters: 0.12,
    collision: footprintCollision(-1.65, -1.1, 1.65, 1.1), meshBudget: 34, triangleBudget: 640,
    materialIds: ['frontage.wood.weathered', 'frontage.earth.loam', 'frontage.plant.leaf'],
    placementHints: groundHints({ preferredZones: ['sunny-side-yard', 'rear-garden'], wallGap: [1.5, 5.5], pathGap: 0.6, maxPerBuilding: 1 }),
  }),
  'yard.herb-ring': asset('yard.herb-ring', 'garden', {
    builder: 'herb-ring', allowedPrograms: ['dwelling', 'inn'],
    allowedZones: [FRONTAGE_ZONES.sideYard, FRONTAGE_ZONES.rearYard, FRONTAGE_ZONES.gardenEdge],
    localBounds: bounds(-1.05, -0.04, -1.05, 1.05, 0.68, 1.05), clearance: groundClearance,
    slopeToleranceDegrees: 8, reliefToleranceMeters: 0.16,
    collision: noCollision(), meshBudget: 26, triangleBudget: 720,
    materialIds: ['frontage.stone.field', 'frontage.earth.loam', 'frontage.plant.leaf'],
    placementHints: groundHints({ preferredZones: ['garden-corner', 'yard-edge'], wallGap: [1.2, 4], pathGap: 0.4 }),
  }),
  'yard.climbing-frame': asset('yard.climbing-frame', 'garden', {
    builder: 'climbing-frame', allowedPrograms: ['dwelling', 'inn'],
    allowedZones: [FRONTAGE_ZONES.sideYard, FRONTAGE_ZONES.rearYard, FRONTAGE_ZONES.gardenEdge],
    localBounds: bounds(-1.3, -0.04, -0.48, 1.3, 1.72, 0.48), clearance: groundClearance,
    slopeToleranceDegrees: 8, reliefToleranceMeters: 0.16,
    collision: segmentCollision([[-1.18, 0, 1.18, 0, 0.22]]), meshBudget: 22, triangleBudget: 440,
    materialIds: ['frontage.wood.weathered', 'frontage.plant.leaf', 'frontage.earth.loam'],
    placementHints: groundHints({ preferredZones: ['garden-edge', 'rear-garden'], wallGap: [1.5, 5], pathGap: 0.55 }),
  }),

  'materials.firewood-rick': asset('materials.firewood-rick', 'material-stack', {
    builder: 'firewood-rick', allowedPrograms: allPrograms,
    allowedZones: [FRONTAGE_ZONES.buildingSide, FRONTAGE_ZONES.rearYard, FRONTAGE_ZONES.workYard],
    localBounds: bounds(-1.45, -0.06, -0.48, 1.45, 1.14, 0.48), clearance: groundClearance,
    slopeToleranceDegrees: 10, reliefToleranceMeters: 0.16,
    collision: footprintCollision(-1.4, -0.44, 1.4, 0.44), meshBudget: 24, triangleBudget: 780,
    materialIds: ['frontage.wood.dark', 'frontage.wood.cut'],
    placementHints: groundHints({ preferredZones: ['wall-side', 'dry-yard-edge'], wallGap: [0.35, 1.4], pathGap: 0.45, mirror: false, maxPerBuilding: 2 }),
  }),
  'materials.timber-offcuts': asset('materials.timber-offcuts', 'material-stack', {
    builder: 'timber-offcuts', allowedPrograms: ['barn', 'workshop', 'smithy'],
    allowedZones: [FRONTAGE_ZONES.rearYard, FRONTAGE_ZONES.workYard],
    localBounds: bounds(-1.55, 0, -0.72, 1.55, 0.88, 0.72), clearance: groundClearance,
    slopeToleranceDegrees: 10, reliefToleranceMeters: 0.18,
    collision: footprintCollision(-1.5, -0.68, 1.5, 0.68), meshBudget: 12, triangleBudget: 170,
    materialIds: ['frontage.wood.dark', 'frontage.wood.weathered', 'frontage.wood.cut'],
    placementHints: groundHints({ preferredZones: ['work-yard-edge', 'lean-to-side'], wallGap: [0.8, 3.5], pathGap: 0.7, mirror: false, maxPerBuilding: 2 }),
  }),
  'materials.fieldstone-stack': asset('materials.fieldstone-stack', 'material-stack', {
    builder: 'fieldstone-stack', allowedPrograms: allPrograms,
    allowedZones: [FRONTAGE_ZONES.buildingSide, FRONTAGE_ZONES.rearYard, FRONTAGE_ZONES.workYard],
    localBounds: bounds(-1.15, -0.08, -0.62, 1.15, 0.94, 0.62), clearance: groundClearance,
    slopeToleranceDegrees: 12, reliefToleranceMeters: 0.22,
    collision: footprintCollision(-1.08, -0.58, 1.08, 0.58), meshBudget: 15, triangleBudget: 260,
    materialIds: ['frontage.stone.field', 'frontage.stone.pale'],
    placementHints: groundHints({ preferredZones: ['wall-side', 'work-yard-edge'], wallGap: [0.6, 3], pathGap: 0.55, mirror: false, maxPerBuilding: 2 }),
  }),
  'tools.leaning-rack': asset('tools.leaning-rack', 'tool-stack', {
    builder: 'leaning-rack', allowedPrograms: ['barn', 'workshop', 'smithy'],
    allowedZones: [FRONTAGE_ZONES.buildingSide, FRONTAGE_ZONES.workYard],
    localBounds: bounds(-1.08, 0, -0.38, 1.08, 1.68, 0.38), clearance: groundClearance,
    slopeToleranceDegrees: 12, reliefToleranceMeters: 0.18,
    collision: noCollision(), meshBudget: 14, triangleBudget: 220,
    materialIds: ['frontage.wood.dark', 'frontage.wood.weathered', 'frontage.metal.dull'],
    placementHints: groundHints({ preferredZones: ['wall-side', 'work-yard-edge'], wallGap: [0.25, 1.25], pathGap: 0.45 }),
  }),

  'service.dwelling-threshold': asset('service.dwelling-threshold', 'service-cue', {
    builder: 'dwelling-threshold', allowedPrograms: ['dwelling'],
    allowedZones: [FRONTAGE_ZONES.thresholdEdge, FRONTAGE_ZONES.buildingFront],
    localBounds: bounds(-1.15, 0, -0.48, 1.15, 0.82, 0.48), clearance: groundClearance,
    slopeToleranceDegrees: 8, reliefToleranceMeters: 0.12, collision: noCollision(),
    meshBudget: 12, triangleBudget: 220,
    materialIds: ['frontage.wood.dark', 'frontage.wood.weathered', 'frontage.clay'],
    placementHints: groundHints({ preferredZones: ['beside-threshold'], wallGap: [0.3, 1.2], pathGap: 0.25, maxPerBuilding: 1 }),
  }),
  'service.barn-feed': asset('service.barn-feed', 'service-cue', {
    builder: 'barn-feed', allowedPrograms: ['barn'],
    allowedZones: [FRONTAGE_ZONES.buildingFront, FRONTAGE_ZONES.workYard],
    localBounds: bounds(-1.75, 0, -0.7, 1.75, 1.54, 0.7), clearance: groundClearance,
    slopeToleranceDegrees: 8, reliefToleranceMeters: 0.16,
    collision: footprintCollision(-1.68, -0.62, 1.68, 0.62), meshBudget: 18, triangleBudget: 340,
    materialIds: ['frontage.wood.dark', 'frontage.wood.weathered', 'frontage.plant.dry', 'frontage.metal.dull'],
    placementHints: groundHints({ preferredZones: ['barn-yard-edge', 'beside-wide-entry'], wallGap: [1.1, 3.5], pathGap: 0.75 }),
  }),
  'service.workshop-bench': asset('service.workshop-bench', 'service-cue', {
    builder: 'workshop-bench', allowedPrograms: ['workshop'],
    allowedZones: [FRONTAGE_ZONES.buildingFront, FRONTAGE_ZONES.workYard],
    localBounds: bounds(-1.65, 0, -0.7, 1.65, 1.36, 0.7), clearance: groundClearance,
    slopeToleranceDegrees: 8, reliefToleranceMeters: 0.14,
    collision: footprintCollision(-1.58, -0.62, 1.58, 0.62), meshBudget: 18, triangleBudget: 300,
    materialIds: ['frontage.wood.dark', 'frontage.wood.weathered', 'frontage.wood.cut', 'frontage.metal.dull'],
    placementHints: groundHints({ preferredZones: ['work-yard-edge', 'beside-work-entry'], wallGap: [0.8, 2.8], pathGap: 0.7 }),
  }),
  'service.inn-hitching-rail': asset('service.inn-hitching-rail', 'service-cue', {
    builder: 'inn-hitching-rail', allowedPrograms: ['inn'],
    allowedZones: [FRONTAGE_ZONES.buildingFront, FRONTAGE_ZONES.sideYard],
    localBounds: bounds(-2.05, 0, -0.42, 2.05, 1.34, 0.42), clearance: groundClearance,
    slopeToleranceDegrees: 9, reliefToleranceMeters: 0.18,
    collision: segmentCollision([[-1.9, 0, 1.9, 0, 0.16]]), meshBudget: 14, triangleBudget: 250,
    materialIds: ['frontage.wood.dark', 'frontage.wood.weathered', 'frontage.metal.dull'],
    placementHints: groundHints({ preferredZones: ['street-side', 'inn-side'], wallGap: [2, 5], pathGap: 0.6 }),
  }),
  'service.smithy-quench': asset('service.smithy-quench', 'service-cue', {
    builder: 'smithy-quench', allowedPrograms: ['smithy'],
    allowedZones: [FRONTAGE_ZONES.buildingFront, FRONTAGE_ZONES.workYard],
    localBounds: bounds(-1.6, 0, -1.0, 1.6, 1.08, 0.86), clearance: groundClearance,
    slopeToleranceDegrees: 7, reliefToleranceMeters: 0.14,
    collision: footprintCollision(-1.52, -0.78, 1.52, 0.78), meshBudget: 22, triangleBudget: 520,
    materialIds: ['frontage.wood.dark', 'frontage.stone.field', 'frontage.metal.iron', 'frontage.metal.dull'],
    placementHints: groundHints({ preferredZones: ['forge-yard-edge', 'beside-work-entry'], wallGap: [1.2, 3.4], pathGap: 0.8 }),
  }),
  'service.granary-staging': asset('service.granary-staging', 'service-cue', {
    builder: 'granary-staging', allowedPrograms: ['granary'],
    allowedZones: [FRONTAGE_ZONES.buildingFront, FRONTAGE_ZONES.workYard],
    localBounds: bounds(-1.42, 0, -0.75, 1.42, 1.5, 0.75), clearance: groundClearance,
    slopeToleranceDegrees: 7, reliefToleranceMeters: 0.12,
    collision: footprintCollision(-1.35, -0.68, 1.35, 0.68), meshBudget: 18, triangleBudget: 640,
    materialIds: ['frontage.wood.dark', 'frontage.wood.weathered', 'frontage.grain'],
    placementHints: groundHints({ preferredZones: ['loading-side', 'beside-entry'], wallGap: [1, 3], pathGap: 0.72 }),
  }),
});

export const FRONTAGE_ASSET_IDS = Object.freeze(Object.keys(FRONTAGE_ASSETS));

export const FRONTAGE_BUDGET_LIMITS = Object.freeze({ meshBudget: 40, triangleBudget: 900 });

// Option sets for Luna's named deterministic channels. These are catalog
// choices only: selection, density and placement remain planner-owned.
export const FAMILY_FRONTAGE_VISUAL_OPTIONS = deepFreeze({
  paletteIds: HOUSEHOLD_PALETTE_IDS,
  markIds: Object.keys(FAMILY_MARK_SILHOUETTES),
  markTreatmentIds: Object.keys(FAMILY_MARK_TREATMENTS),
  yardHabits: {
    'yard-habit.spare': { id: 'yard-habit.spare', maxYardElements: 1 },
    'yard-habit.kept': { id: 'yard-habit.kept', maxYardElements: 2 },
    'yard-habit.working': { id: 'yard-habit.working', maxYardElements: 3 },
  },
  boundaryHabits: {
    'boundary-habit.open': { id: 'boundary-habit.open', assetIds: [] },
    'boundary-habit.wattle': { id: 'boundary-habit.wattle', assetIds: ['fence.wattle-gap'] },
    'boundary-habit.split-rail': { id: 'boundary-habit.split-rail', assetIds: ['fence.split-rail-corner'] },
    'boundary-habit.low-pale': { id: 'boundary-habit.low-pale', assetIds: ['fence.low-pale-run'] },
  },
  gardenHabits: {
    'garden-habit.none': { id: 'garden-habit.none', assetIds: [] },
    'garden-habit.beds': { id: 'garden-habit.beds', assetIds: ['yard.raised-bed-pair'] },
    'garden-habit.herbs': { id: 'garden-habit.herbs', assetIds: ['yard.herb-ring'] },
    'garden-habit.climbing': { id: 'garden-habit.climbing', assetIds: ['yard.climbing-frame'] },
  },
  materialHabits: {
    'material-habit.none': { id: 'material-habit.none', assetIds: [] },
    'material-habit.firewood': { id: 'material-habit.firewood', assetIds: ['materials.firewood-rick'] },
    'material-habit.timber': { id: 'material-habit.timber', assetIds: ['materials.timber-offcuts'] },
    'material-habit.fieldstone': { id: 'material-habit.fieldstone', assetIds: ['materials.fieldstone-stack'] },
    'material-habit.tools': { id: 'material-habit.tools', assetIds: ['tools.leaning-rack'] },
  },
  markMounts: {
    'mark-mount.door-side': { id: 'mark-mount.door-side', surface: 'front-wall', preferredHeight: [1.45, 1.9] },
    'mark-mount.lintel-edge': { id: 'mark-mount.lintel-edge', surface: 'front-wall', preferredHeight: [2.05, 2.35] },
    'mark-mount.gable-low': { id: 'mark-mount.gable-low', surface: 'front-wall', preferredHeight: [2.45, 3.25] },
  },
  serviceCueIds: {
    dwelling: 'service.dwelling-threshold',
    barn: 'service.barn-feed',
    workshop: 'service.workshop-bench',
    inn: 'service.inn-hitching-rail',
    smithy: 'service.smithy-quench',
    granary: 'service.granary-staging',
  },
});

export function frontageAssetMetadata(assetId) {
  return FRONTAGE_ASSETS[assetId] || null;
}

export function frontageAssetsFor({ program = null, zone = null, category = null } = {}) {
  return Object.freeze(FRONTAGE_ASSET_IDS
    .map((id) => FRONTAGE_ASSETS[id])
    .filter((entry) => (!program || entry.programs.includes(program))
      && (!zone || entry.zones.includes(zone))
      && (!category || entry.category === category)));
}

export function validateFrontageVisualCatalog() {
  const errors = [];
  const materialIds = new Set(Object.keys(FRONTAGE_MATERIALS));
  const programIds = new Set(FRONTAGE_PROGRAMS);
  const zoneIds = new Set(Object.values(FRONTAGE_ZONES));
  const categories = new Set();
  const servicePrograms = new Set();

  if (FAMILY_FRONTAGE_ASSET_METADATA_SCHEMA.version !== FRONTAGE_VISUAL_CATALOG_VERSION) {
    errors.push('wp0-schema-version-mismatch');
  }

  for (const [id, spec] of Object.entries(FRONTAGE_MATERIALS)) {
    if (spec.id !== id) errors.push(`material-id-mismatch:${id}`);
    if (!Number.isInteger(spec.color) || spec.color < 0 || spec.color > 0xffffff) errors.push(`invalid-material-colour:${id}`);
    if (!(spec.roughness >= 0 && spec.roughness <= 1)) errors.push(`invalid-material-roughness:${id}`);
    if (!(spec.metalness >= 0 && spec.metalness <= 1)) errors.push(`invalid-material-metalness:${id}`);
  }
  for (const id of HOUSEHOLD_PALETTE_IDS) if (!materialIds.has(id)) errors.push(`missing-household-material:${id}`);

  const silhouettes = new Set();
  for (const [id, mark] of Object.entries(FAMILY_MARK_SILHOUETTES)) {
    if (mark.id !== id || !FRONTAGE_ASSETS[id]) errors.push(`orphan-family-mark:${id}`);
    if (!mark.strokes.length) errors.push(`empty-family-mark:${id}`);
    const signature = mark.strokes.map(({ from, to }) => `${from.join(',')}>${to.join(',')}`).join('|')
      + `:${mark.pegs.map((peg) => peg.join(',')).join('|')}`;
    if (silhouettes.has(signature)) errors.push(`duplicate-family-mark:${id}`);
    silhouettes.add(signature);
    for (const { from, to, width } of mark.strokes) {
      if (![...from, ...to, width].every(Number.isFinite)) errors.push(`invalid-family-mark-stroke:${id}`);
      if ([...from, ...to].some((n) => Math.abs(n) > 0.36) || !(width > 0 && width <= 0.12)) errors.push(`family-mark-out-of-frame:${id}`);
    }
  }
  for (const [id, treatment] of Object.entries(FAMILY_MARK_TREATMENTS)) {
    if (treatment.id !== id) errors.push(`treatment-id-mismatch:${id}`);
    if (treatment.materialId && !materialIds.has(treatment.materialId)) errors.push(`unknown-treatment-material:${id}`);
    if (!treatment.materialId && treatment.materialRole !== 'household') errors.push(`unknown-treatment-role:${id}`);
  }

  for (const [id, entry] of Object.entries(FRONTAGE_ASSETS)) {
    categories.add(entry.category);
    if (entry.id !== id) errors.push(`asset-id-mismatch:${id}`);
    if (entry.version !== FRONTAGE_VISUAL_CATALOG_VERSION) errors.push(`asset-version-mismatch:${id}`);
    if (!entry.builder) errors.push(`asset-missing-builder:${id}`);
    if (!entry.allowedPrograms.length || entry.allowedPrograms.some((program) => !programIds.has(program))) errors.push(`asset-invalid-program:${id}`);
    if (!entry.allowedZones.length || entry.allowedZones.some((zone) => !zoneIds.has(zone))) errors.push(`asset-invalid-zone:${id}`);
    const values = [...entry.localBounds.min, ...entry.localBounds.max];
    if (!values.every(Number.isFinite) || entry.localBounds.min.some((min, axis) => min >= entry.localBounds.max[axis])) errors.push(`asset-invalid-bounds:${id}`);
    if (!['left', 'right', 'front', 'back', 'above'].every((key) => Number.isFinite(entry.clearance[key]) && entry.clearance[key] >= 0)) errors.push(`asset-invalid-clearance:${id}`);
    if (!(entry.slopeToleranceDegrees >= 0 && entry.slopeToleranceDegrees <= 90)) errors.push(`asset-invalid-slope:${id}`);
    if (!(entry.reliefToleranceMeters >= 0 && entry.reliefToleranceMeters <= 0.5)) errors.push(`asset-invalid-relief:${id}`);
    if (!['none', 'footprint', 'segments'].includes(entry.collision.mode)) errors.push(`asset-invalid-collision:${id}`);
    if (!Number.isInteger(entry.meshBudget) || entry.meshBudget < 1 || entry.meshBudget > FRONTAGE_BUDGET_LIMITS.meshBudget) errors.push(`asset-invalid-mesh-budget:${id}`);
    if (!Number.isInteger(entry.triangleBudget) || entry.triangleBudget < 12 || entry.triangleBudget > FRONTAGE_BUDGET_LIMITS.triangleBudget) errors.push(`asset-invalid-triangle-budget:${id}`);
    if (!entry.materialIds.length || entry.materialIds.some((materialId) => !materialIds.has(materialId))) errors.push(`asset-invalid-material:${id}`);
    if (!entry.placementHints?.origin || entry.placementHints.outwardAxis !== '+z') errors.push(`asset-invalid-placement-hints:${id}`);
    for (const field of FAMILY_FRONTAGE_ASSET_METADATA_SCHEMA.fields) {
      if (!Object.hasOwn(entry, field)) errors.push(`asset-missing-wp0-field:${id}:${field}`);
    }
    if (entry.programs !== entry.allowedPrograms || entry.zones !== entry.allowedZones) errors.push(`asset-contract-alias:${id}`);
    if (!Number.isFinite(entry.halfExtents.x) || !Number.isFinite(entry.halfExtents.z) || !(entry.height > 0)) errors.push(`asset-contract-extents:${id}`);
    if (entry.groundCover !== 'none') errors.push(`asset-ground-cover:${id}`);
    if (entry.wallAttached === entry.groundSeated) errors.push(`asset-mount-mode:${id}`);
    if (entry.category === 'service-cue') {
      if (entry.allowedPrograms.length !== 1) errors.push(`service-cue-must-have-one-program:${id}`);
      else if (servicePrograms.has(entry.allowedPrograms[0])) errors.push(`duplicate-service-cue:${entry.allowedPrograms[0]}`);
      else servicePrograms.add(entry.allowedPrograms[0]);
    }
  }
  for (const category of ['family-mark', 'partial-fence', 'garden', 'material-stack', 'tool-stack', 'service-cue']) {
    if (!categories.has(category)) errors.push(`missing-asset-category:${category}`);
  }
  for (const program of FRONTAGE_PROGRAMS) if (!servicePrograms.has(program)) errors.push(`missing-service-cue:${program}`);
  for (const group of ['boundaryHabits', 'gardenHabits', 'materialHabits']) {
    for (const [id, option] of Object.entries(FAMILY_FRONTAGE_VISUAL_OPTIONS[group])) {
      if (option.id !== id) errors.push(`option-id-mismatch:${group}:${id}`);
      for (const assetId of option.assetIds) if (!FRONTAGE_ASSETS[assetId]) errors.push(`option-unknown-asset:${group}:${id}:${assetId}`);
    }
  }
  for (const [program, assetId] of Object.entries(FAMILY_FRONTAGE_VISUAL_OPTIONS.serviceCueIds)) {
    if (!FRONTAGE_ASSETS[assetId]?.programs.includes(program)) errors.push(`service-option-mismatch:${program}:${assetId}`);
  }

  return deepFreeze({ valid: errors.length === 0, errors });
}

export const FRONTAGE_VISUAL_CATALOG_VALIDATION = validateFrontageVisualCatalog();
if (!FRONTAGE_VISUAL_CATALOG_VALIDATION.valid) {
  throw new Error(`Invalid settlement frontage catalog: ${FRONTAGE_VISUAL_CATALOG_VALIDATION.errors.join(', ')}`);
}
