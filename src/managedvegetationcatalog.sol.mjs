// Managed domestic vegetation catalog.
//
// These records own fit, clearance and collision only. Their visuals are
// strategic arrangements of archetypes from vegetation.js; no separate
// domestic foliage geometry or material vocabulary exists.

export const MANAGED_VEGETATION_CATALOG_VERSION = 'managed-vegetation-assets/2.0.0';

export const MANAGED_VEGETATION_LOCAL_FRAME = Object.freeze({
  handedness: 'right', acrossAxis: '+x', upAxis: '+y', forwardAxis: '+z',
  origin: 'footprint-centre-at-ground', units: 'metres',
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const bounds = (minX, minY, minZ, maxX, maxY, maxZ) =>
  deepFreeze({ min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });
const clearance = (left, right, front, back, above) =>
  deepFreeze({ left, right, front, back, above });
const noCollision = () => deepFreeze({ mode: 'none', blocksMovement: false, localOnly: true });
const circleCollision = (circles) => deepFreeze({
  mode: 'circles', blocksMovement: true, localOnly: true, circles,
});
const groundCover = () => deepFreeze({
  mode: 'none', localBounds: null, materialId: null, visualOnly: false,
  mutatesTerrain: false, suppressesAmbientScatter: false,
});
const surfaceFit = (maxSlopeDegrees, maxReliefMeters) => deepFreeze({
  maxSlopeDegrees, maxReliefMeters,
  evaluationOwner: 'descriptor-placer', builderDeformsToTerrain: false,
});
const capabilities = () => deepFreeze({
  descriptorDriven: true, deterministicRecipe: true,
  sharedNaturalFoliage: true, instanced: true, staticMerge: false,
  yawRotation: true, mirrorX: true, fixedScaleRecommended: true,
  terrainConforming: false, interactive: false, animated: true,
  particleBased: false,
});
const lod = (farDistance = 54, cullDistance = 105) => deepFreeze({
  defaultLevel: 'near',
  levels: [
    { id: 'near', maxDistanceMeters: farDistance, castsShadow: true },
    { id: 'far', maxDistanceMeters: cullDistance, castsShadow: false },
  ],
  beyondCullDistance: 'omit',
});
const asset = (id, category, spec) => deepFreeze({
  version: MANAGED_VEGETATION_CATALOG_VERSION, id, category, ...spec,
  draw: { mode: 'shared-natural-instancing', geometryOwner: 'vegetation-library' },
});

export const MANAGED_VEGETATION_CATEGORIES = Object.freeze([
  'orchard-unit', 'kitchen-garden', 'herb-garden', 'coppice-vegetation',
]);

export const MANAGED_VEGETATION_ASSET_SCHEMA = deepFreeze({
  id: 'managed-vegetation-asset-metadata',
  version: MANAGED_VEGETATION_CATALOG_VERSION,
  requiredFields: [
    'version', 'id', 'category', 'builder', 'foliageTypes', 'localBounds',
    'clearance', 'collision', 'groundCover', 'surfaceFit', 'capabilities',
    'lod', 'draw',
  ],
});

export const MANAGED_VEGETATION_DESCRIPTOR_SCHEMA = deepFreeze({
  id: 'managed-vegetation-visual-descriptor',
  version: MANAGED_VEGETATION_CATALOG_VERSION,
  requiredFields: ['assetId'], optionalFields: ['lodId'],
  assetIdSource: 'MANAGED_VEGETATION_ASSET_IDS', lodIdSource: 'asset.lod.levels',
  transformOwner: 'caller',
});

export const MANAGED_VEGETATION_ASSETS = deepFreeze({
  'managed-veg.orchard.pair': asset('managed-veg.orchard.pair', 'orchard-unit', {
    builder: 'natural-orchard-pair', foliageTypes: ['apple'],
    localBounds: bounds(-2.75, -0.1, -1.35, 2.75, 3.55, 1.35),
    clearance: clearance(0.8, 0.8, 0.75, 0.75, 0.5),
    collision: circleCollision([[-1.4, 0, 0.24], [1.4, 0, 0.24]]),
    groundCover: groundCover(), surfaceFit: surfaceFit(8, 0.18), lod: lod(64, 124),
    capabilities: capabilities(),
  }),
  'managed-veg.garden.kitchen-cluster': asset('managed-veg.garden.kitchen-cluster', 'kitchen-garden', {
    builder: 'natural-shrub-garden', foliageTypes: ['shrub'],
    localBounds: bounds(-1.7, -0.1, -1.25, 1.7, 1.05, 1.25),
    clearance: clearance(0.35, 0.35, 0.4, 0.4, 0.3),
    collision: noCollision(), groundCover: groundCover(),
    surfaceFit: surfaceFit(8, 0.16), lod: lod(48, 96), capabilities: capabilities(),
  }),
  'managed-veg.garden.herb-cluster': asset('managed-veg.garden.herb-cluster', 'herb-garden', {
    builder: 'natural-shrub-herbs', foliageTypes: ['shrub'],
    localBounds: bounds(-1.25, -0.1, -1.05, 1.25, 0.9, 1.05),
    clearance: clearance(0.3, 0.3, 0.35, 0.35, 0.25),
    collision: noCollision(), groundCover: groundCover(),
    surfaceFit: surfaceFit(9, 0.18), lod: lod(44, 88), capabilities: capabilities(),
  }),
  'managed-veg.coppice.low-cluster': asset('managed-veg.coppice.low-cluster', 'coppice-vegetation', {
    builder: 'natural-shrub-coppice', foliageTypes: ['shrub'],
    localBounds: bounds(-1.65, -0.1, -1.4, 1.65, 1.7, 1.4),
    clearance: clearance(0.45, 0.45, 0.45, 0.45, 0.3),
    collision: noCollision(), groundCover: groundCover(),
    surfaceFit: surfaceFit(10, 0.2), lod: lod(50, 100), capabilities: capabilities(),
  }),
});

export const MANAGED_VEGETATION_ASSET_IDS = Object.freeze(Object.keys(MANAGED_VEGETATION_ASSETS));

export function managedVegetationAssetMetadata(assetId) {
  return MANAGED_VEGETATION_ASSETS[assetId] || null;
}

export function managedVegetationAssetsFor({ category = null } = {}) {
  return Object.freeze(MANAGED_VEGETATION_ASSET_IDS
    .map((id) => MANAGED_VEGETATION_ASSETS[id])
    .filter((entry) => !category || entry.category === category));
}

function validBounds(value) {
  return value && value.min?.length === 3 && value.max?.length === 3
    && [...value.min, ...value.max].every(Number.isFinite)
    && value.min.every((minimum, axis) => minimum < value.max[axis]);
}

export function validateManagedVegetationCatalog() {
  const errors = [];
  const categories = new Set(MANAGED_VEGETATION_CATEGORIES);
  for (const [id, entry] of Object.entries(MANAGED_VEGETATION_ASSETS)) {
    if (entry.id !== id) errors.push(`asset-id:${id}`);
    if (entry.version !== MANAGED_VEGETATION_CATALOG_VERSION) errors.push(`asset-version:${id}`);
    if (!categories.has(entry.category)) errors.push(`asset-category:${id}`);
    for (const field of MANAGED_VEGETATION_ASSET_SCHEMA.requiredFields) {
      if (!Object.hasOwn(entry, field)) errors.push(`asset-field:${id}:${field}`);
    }
    if (!validBounds(entry.localBounds)) errors.push(`asset-bounds:${id}`);
    if (!entry.foliageTypes?.length || entry.foliageTypes.some((type) => !['shrub', 'apple'].includes(type))) {
      errors.push(`asset-foliage:${id}`);
    }
    if (!['none', 'circles'].includes(entry.collision.mode)) errors.push(`asset-collision:${id}`);
    if (entry.collision.localOnly !== true || typeof entry.collision.blocksMovement !== 'boolean') {
      errors.push(`asset-collision-contract:${id}`);
    }
    if (entry.groundCover.mode !== 'none' || entry.groundCover.mutatesTerrain
      || entry.groundCover.suppressesAmbientScatter) errors.push(`asset-ground-cover:${id}`);
    if (!entry.capabilities.sharedNaturalFoliage || !entry.capabilities.instanced
      || entry.capabilities.staticMerge || !entry.capabilities.animated
      || entry.capabilities.particleBased) errors.push(`asset-capabilities:${id}`);
    if (entry.draw.mode !== 'shared-natural-instancing'
      || entry.draw.geometryOwner !== 'vegetation-library') errors.push(`asset-draw:${id}`);
    if (entry.lod.defaultLevel !== 'near' || entry.lod.levels.length !== 2
      || entry.lod.levels[0].id !== 'near' || entry.lod.levels[1].id !== 'far'
      || entry.lod.levels[0].maxDistanceMeters >= entry.lod.levels[1].maxDistanceMeters) {
      errors.push(`asset-lod:${id}`);
    }
  }
  for (const category of MANAGED_VEGETATION_CATEGORIES) {
    if (!MANAGED_VEGETATION_ASSET_IDS.some((id) => MANAGED_VEGETATION_ASSETS[id].category === category)) {
      errors.push(`missing-category:${category}`);
    }
  }
  return deepFreeze({ valid: errors.length === 0, errors });
}

export const MANAGED_VEGETATION_CATALOG_VALIDATION = validateManagedVegetationCatalog();
if (!MANAGED_VEGETATION_CATALOG_VALIDATION.valid) {
  throw new Error(`Invalid managed vegetation catalog: ${MANAGED_VEGETATION_CATALOG_VALIDATION.errors.join(', ')}`);
}
