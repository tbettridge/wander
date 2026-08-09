// Sol-owned architectural application catalog for family frontage.
//
// This module is deliberately data-only: it imports no Three runtime, owns no
// placement or household selection, and describes only the quiet surface
// treatments that a renderer may apply to an already-planned family building.
// The caller owns the building transform and the opening/door lifecycle.

import { FAMILY_FRONTAGE_VERSION } from './familyfrontage.mjs';
import {
  FRONTAGE_MATERIALS,
  HOUSEHOLD_PALETTE_IDS,
} from './settlementfrontagecatalog.mjs';

export const FRONTAGE_APPLICATION_CATALOG_VERSION = `family-frontage-application/${FAMILY_FRONTAGE_VERSION}.0.0`;

export const FRONTAGE_APPLICATION_CHANNELS = Object.freeze([
  'facade-application', 'trim-target', 'door-treatment', 'element-variant',
]);

export const FRONTAGE_APPLICATION_LOCAL_FRAME = Object.freeze({
  handedness: 'right',
  acrossAxis: '+x',
  upAxis: '+y',
  outwardAxis: '+z',
  staticOrigin: 'building-core-centre-at-floor',
  doorOrigin: 'exterior-door-left-hinge-at-floor',
  units: 'metres',
  transformOwner: 'caller',
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function application(id, channel, builder, {
  materialIds,
  meshBudget,
  triangleBudget = meshBudget * 12,
  surface,
  grayscaleCue,
  coverageMax = 0,
} = {}) {
  return deepFreeze({
    id,
    version: FRONTAGE_APPLICATION_CATALOG_VERSION,
    channel,
    builder,
    materialIds,
    meshBudget,
    triangleBudget,
    surface,
    grayscaleCue,
    coverageMax,
    staticMergeCompatible: channel !== 'door-treatment',
    followsDoorPivot: channel === 'door-treatment',
    collision: 'none',
    identityRole: 'supporting',
  });
}

// These patterns occupy only a small fraction of the wall. They are repairs,
// courses and corner work rather than a household-coloured facade skin.
export const FACADE_TREATMENTS = deepFreeze({
  'facade-application.mended-course': application(
    'facade-application.mended-course', 'facade-application', 'mended-course', {
      materialIds: ['frontage.stone.field', 'frontage.stone.pale'],
      meshBudget: 8,
      surface: 'front-wall',
      grayscaleCue: 'broken-low-masonry-rhythm',
      coverageMax: 0.075,
    },
  ),
  'facade-application.shoulder-stones': application(
    'facade-application.shoulder-stones', 'facade-application', 'shoulder-stones', {
      materialIds: ['frontage.stone.field'],
      meshBudget: 6,
      surface: 'front-wall-corners',
      grayscaleCue: 'paired-vertical-corner-stacks',
      coverageMax: 0.055,
    },
  ),
  'facade-application.lime-pins': application(
    'facade-application.lime-pins', 'facade-application', 'lime-pins', {
      materialIds: ['frontage.mark.lime'],
      meshBudget: 4,
      surface: 'front-wall',
      grayscaleCue: 'four-narrow-upright-patches',
      coverageMax: 0.045,
    },
  ),
});

export const TRIM_TARGETS = deepFreeze({
  'trim-target.door-head': application(
    'trim-target.door-head', 'trim-target', 'door-head', {
      materialIds: ['frontage.wood.weathered'],
      meshBudget: 3,
      surface: 'door-surround-static',
      grayscaleCue: 'capped-lintel',
      coverageMax: 0.03,
    },
  ),
  'trim-target.corner-stops': application(
    'trim-target.corner-stops', 'trim-target', 'corner-stops', {
      materialIds: ['frontage.wood.dark'],
      meshBudget: 4,
      surface: 'front-wall-corners',
      grayscaleCue: 'paired-short-edge-stops',
      coverageMax: 0.04,
    },
  ),
  'trim-target.low-sills': application(
    'trim-target.low-sills', 'trim-target', 'low-sills', {
      materialIds: ['frontage.wood.mid'],
      meshBudget: 2,
      surface: 'front-wall',
      grayscaleCue: 'split-low-horizontal-sills',
      coverageMax: 0.025,
    },
  ),
});

// Door leaf details are shared-material meshes attached below the existing
// dynamic pivot. The application builder itself creates no animation or state.
export const DOOR_TREATMENTS = deepFreeze({
  'door-treatment.vertical-battens': application(
    'door-treatment.vertical-battens', 'door-treatment', 'vertical-battens', {
      materialIds: ['frontage.wood.weathered'],
      meshBudget: 4,
      surface: 'exterior-door-leaf',
      grayscaleCue: 'four-vertical-ribs',
      coverageMax: 0.19,
    },
  ),
  'door-treatment.cross-brace': application(
    'door-treatment.cross-brace', 'door-treatment', 'cross-brace', {
      materialIds: ['frontage.wood.mid'],
      meshBudget: 2,
      surface: 'exterior-door-leaf',
      grayscaleCue: 'opposed-diagonal-braces',
      coverageMax: 0.16,
    },
  ),
  'door-treatment.iron-studs': application(
    'door-treatment.iron-studs', 'door-treatment', 'iron-studs', {
      materialIds: ['frontage.metal.iron'],
      meshBudget: 9,
      triangleBudget: 216,
      surface: 'exterior-door-leaf',
      grayscaleCue: 'three-by-three-stud-grid',
      coverageMax: 0.04,
    },
  ),
});

// Element variants only redistribute material emphasis among materials already
// declared by an asset. They never change placement, bounds or collision.
export const ELEMENT_VARIANTS = deepFreeze({
  'element-variant.even': {
    id: 'element-variant.even',
    version: FRONTAGE_APPLICATION_CATALOG_VERSION,
    channel: 'element-variant',
    strategy: 'authored',
    stride: 1,
    phase: 0,
    grayscaleCue: 'authored-material-rhythm',
    geometryInvariant: true,
    collisionInvariant: true,
  },
  'element-variant.weathered': {
    id: 'element-variant.weathered',
    version: FRONTAGE_APPLICATION_CATALOG_VERSION,
    channel: 'element-variant',
    strategy: 'pair-forward',
    stride: 2,
    phase: 0,
    grayscaleCue: 'alternating-lighter-repairs',
    geometryInvariant: true,
    collisionInvariant: true,
  },
  'element-variant.mended': {
    id: 'element-variant.mended',
    version: FRONTAGE_APPLICATION_CATALOG_VERSION,
    channel: 'element-variant',
    strategy: 'pair-reverse',
    stride: 3,
    phase: 1,
    grayscaleCue: 'sparse-darker-repairs',
    geometryInvariant: true,
    collisionInvariant: true,
  },
});

export const FRONTAGE_APPLICATION_OPTIONS = deepFreeze({
  facadeTreatmentIds: Object.keys(FACADE_TREATMENTS),
  trimTargetIds: Object.keys(TRIM_TARGETS),
  doorTreatmentIds: Object.keys(DOOR_TREATMENTS),
  elementVariantIds: Object.keys(ELEMENT_VARIANTS),
});

// Identity remains a small-scale reading aid. Family-mark topology and business
// names carry recognition; architectural channels only echo a household across
// its home and workplace. The luminance band is intentionally narrow and dark
// enough to sit with the settlement's wood/stone palette.
export const FRONTAGE_PALETTE_GUIDANCE = deepFreeze({
  householdAccentRelativeLuminance: { min: 0.09, max: 0.18 },
  householdAccentFacadeCoverageMax: 0,
  architecturalFacadeCoverageMax: 0.08,
  preferredContrast: 'shape-and-value-before-hue',
  grayscalePrimaryCue: 'family-mark-topology',
  grayscaleSecondaryCues: ['facade-pattern', 'trim-silhouette', 'door-geometry'],
  prohibited: [
    'whole-facade-household-colour', 'high-chroma-heraldry', 'faction-banding',
    'emissive-identity', 'dynamic-light-identity',
  ],
});

function channelEntries() {
  return [FACADE_TREATMENTS, TRIM_TARGETS, DOOR_TREATMENTS].flatMap((group) => Object.values(group));
}

function relativeLuminance(color) {
  const channels = [color >> 16, (color >> 8) & 0xff, color & 0xff].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function frontageApplicationMetadata(id) {
  return FACADE_TREATMENTS[id] || TRIM_TARGETS[id] || DOOR_TREATMENTS[id] || ELEMENT_VARIANTS[id] || null;
}

const ELEMENT_MATERIAL_PAIRS = Object.freeze([
  Object.freeze(['frontage.wood.dark', 'frontage.wood.weathered']),
  Object.freeze(['frontage.stone.field', 'frontage.stone.pale']),
  Object.freeze(['frontage.metal.iron', 'frontage.metal.dull']),
  Object.freeze(['frontage.plant.leaf', 'frontage.plant.dry']),
]);

/** Resolve a visual-only material variant without changing geometry or bounds. */
export function elementVariantMaterialId(elementVariantId, materialId, allowedMaterialIds, partIndex = 0) {
  const variant = ELEMENT_VARIANTS[elementVariantId];
  if (!variant) throw new RangeError(`Unknown frontage element variant: ${elementVariantId}`);
  if (variant.strategy === 'authored') return materialId;
  const allowed = new Set(allowedMaterialIds || []);
  const pair = ELEMENT_MATERIAL_PAIRS.find((candidate) => candidate.includes(materialId)
    && candidate.every((id) => allowed.has(id)));
  if (!pair || Math.abs(partIndex) % variant.stride !== variant.phase) return materialId;
  if (variant.strategy === 'pair-forward' && materialId === pair[0]) return pair[1];
  if (variant.strategy === 'pair-reverse' && materialId === pair[1]) return pair[0];
  return materialId;
}

export function validateFrontageApplicationCatalog() {
  const errors = [];
  const materials = new Set(Object.keys(FRONTAGE_MATERIALS));
  const ids = new Set();
  for (const entry of channelEntries()) {
    if (ids.has(entry.id)) errors.push(`duplicate-id:${entry.id}`);
    ids.add(entry.id);
    if (entry.version !== FRONTAGE_APPLICATION_CATALOG_VERSION) errors.push(`version:${entry.id}`);
    if (!FRONTAGE_APPLICATION_CHANNELS.includes(entry.channel)) errors.push(`channel:${entry.id}`);
    if (!entry.builder || !entry.surface || !entry.grayscaleCue) errors.push(`incomplete:${entry.id}`);
    if (!entry.materialIds.length || entry.materialIds.some((id) => !materials.has(id))) errors.push(`materials:${entry.id}`);
    if (!Number.isInteger(entry.meshBudget) || entry.meshBudget < 1) errors.push(`mesh-budget:${entry.id}`);
    if (!Number.isInteger(entry.triangleBudget) || entry.triangleBudget < entry.meshBudget * 12) errors.push(`triangle-budget:${entry.id}`);
    if (!(entry.coverageMax > 0 && entry.coverageMax <= 0.2)) errors.push(`coverage:${entry.id}`);
    if (entry.collision !== 'none' || entry.identityRole !== 'supporting') errors.push(`role:${entry.id}`);
  }
  for (const [id, variant] of Object.entries(ELEMENT_VARIANTS)) {
    if (variant.id !== id || variant.channel !== 'element-variant') errors.push(`variant-id:${id}`);
    if (!variant.geometryInvariant || !variant.collisionInvariant || !variant.grayscaleCue) errors.push(`variant-contract:${id}`);
    if (!['authored', 'pair-forward', 'pair-reverse'].includes(variant.strategy)) errors.push(`variant-strategy:${id}`);
  }
  for (const id of HOUSEHOLD_PALETTE_IDS) {
    const luminance = relativeLuminance(FRONTAGE_MATERIALS[id].color);
    const band = FRONTAGE_PALETTE_GUIDANCE.householdAccentRelativeLuminance;
    if (luminance < band.min - 1e-6 || luminance > band.max + 1e-6) errors.push(`household-luminance:${id}:${luminance}`);
  }
  if (FRONTAGE_PALETTE_GUIDANCE.householdAccentFacadeCoverageMax !== 0) errors.push('household-facade-coverage');
  return deepFreeze({ valid: errors.length === 0, errors });
}

export const FRONTAGE_APPLICATION_CATALOG_VALIDATION = validateFrontageApplicationCatalog();
if (!FRONTAGE_APPLICATION_CATALOG_VALIDATION.valid) {
  throw new Error(`Invalid frontage application catalog: ${FRONTAGE_APPLICATION_CATALOG_VALIDATION.errors.join(', ')}`);
}
