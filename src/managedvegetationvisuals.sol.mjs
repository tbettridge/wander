// Deterministic domestic arrangements of the natural foliage archetypes.
// Geometry and materials remain owned by vegetation.js/createVegetationLibrary.

import {
  MANAGED_VEGETATION_ASSETS,
  MANAGED_VEGETATION_ASSET_IDS,
  MANAGED_VEGETATION_CATALOG_VERSION,
} from './managedvegetationcatalog.sol.mjs';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const instance = (id, type, x, z, scale, yaw = 0) => ({
  id, type, position: [x, 0, z], scale, yaw,
});

const BUILDERS = Object.freeze({
  'natural-orchard-pair': (lodId) => [
    instance('apple-left', 'apple', -1.4, 0, lodId === 'near' ? 0.82 : 0.76, -0.08),
    instance('apple-right', 'apple', 1.4, 0, lodId === 'near' ? 0.86 : 0.78, 0.11),
  ],
  'natural-shrub-garden': (lodId) => (lodId === 'near' ? [
    instance('shrub-a', 'shrub', -0.88, -0.55, 0.42, -0.18),
    instance('shrub-b', 'shrub', 0.02, -0.48, 0.36, 0.12),
    instance('shrub-c', 'shrub', 0.88, -0.42, 0.44, 0.2),
    instance('shrub-d', 'shrub', -0.5, 0.48, 0.34, 0.08),
    instance('shrub-e', 'shrub', 0.56, 0.52, 0.38, -0.12),
  ] : [
    instance('shrub-a', 'shrub', -0.7, -0.25, 0.44, -0.18),
    instance('shrub-b', 'shrub', 0.7, 0.25, 0.42, 0.12),
  ]),
  'natural-shrub-herbs': (lodId) => (lodId === 'near' ? [
    instance('shrub-a', 'shrub', -0.52, -0.28, 0.31, -0.16),
    instance('shrub-b', 'shrub', 0.5, -0.2, 0.29, 0.14),
    instance('shrub-c', 'shrub', 0, 0.48, 0.27, 0.04),
  ] : [instance('shrub-a', 'shrub', 0, 0, 0.34)]),
  'natural-shrub-coppice': (lodId) => (lodId === 'near' ? [
    instance('shrub-a', 'shrub', -0.72, -0.3, 0.74, -0.2),
    instance('shrub-b', 'shrub', 0.62, -0.42, 0.82, 0.16),
    instance('shrub-c', 'shrub', 0.08, 0.62, 0.7, 0.04),
  ] : [
    instance('shrub-a', 'shrub', -0.48, -0.22, 0.78, -0.2),
    instance('shrub-b', 'shrub', 0.48, 0.3, 0.76, 0.16),
  ]),
});

function request(assetOrDescriptor, options) {
  if (typeof assetOrDescriptor === 'string') return { assetId: assetOrDescriptor, lodId: options.lodId };
  if (!assetOrDescriptor || typeof assetOrDescriptor !== 'object') {
    throw new TypeError('An asset ID or managed vegetation descriptor is required.');
  }
  return { assetId: assetOrDescriptor.assetId, lodId: options.lodId || assetOrDescriptor.lodId };
}

export function managedVegetationVisualRecipe(assetOrDescriptor, options = {}) {
  const selected = request(assetOrDescriptor, options);
  const asset = MANAGED_VEGETATION_ASSETS[selected.assetId];
  if (!asset) throw new RangeError(`Unknown managed vegetation asset: ${selected.assetId}`);
  const lodId = selected.lodId || asset.lod.defaultLevel;
  if (!asset.lod.levels.some((entry) => entry.id === lodId)) {
    throw new RangeError(`Unknown managed vegetation LOD for ${selected.assetId}: ${lodId}`);
  }
  const builder = BUILDERS[asset.builder];
  if (!builder) throw new Error(`No natural foliage arrangement for ${selected.assetId}`);
  return deepFreeze({
    catalogVersion: MANAGED_VEGETATION_CATALOG_VERSION,
    assetId: asset.id, category: asset.category, lodId,
    geometryOwner: 'vegetation-library', materialOwner: 'vegetation-library',
    instanced: true, instances: builder(lodId),
  });
}

export function managedVegetationVisualStats(assetOrDescriptor, options = {}) {
  const recipe = managedVegetationVisualRecipe(assetOrDescriptor, options);
  return deepFreeze({
    instances: recipe.instances.length,
    types: [...new Set(recipe.instances.map((entry) => entry.type))],
  });
}

export function validateManagedVegetationVisualRecipes() {
  const errors = [];
  for (const assetId of MANAGED_VEGETATION_ASSET_IDS) for (const lodId of ['near', 'far']) {
    const asset = MANAGED_VEGETATION_ASSETS[assetId];
    const recipe = managedVegetationVisualRecipe(assetId, { lodId });
    if (!recipe.instances.length) errors.push(`empty:${assetId}:${lodId}`);
    for (const entry of recipe.instances) {
      if (!asset.foliageTypes.includes(entry.type)) errors.push(`type:${assetId}:${lodId}:${entry.type}`);
      if (![...entry.position, entry.scale, entry.yaw].every(Number.isFinite) || entry.scale <= 0) {
        errors.push(`transform:${assetId}:${lodId}:${entry.id}`);
      }
    }
  }
  return deepFreeze({ valid: errors.length === 0, errors });
}

export const MANAGED_VEGETATION_VISUAL_RECIPE_VALIDATION = validateManagedVegetationVisualRecipes();
if (!MANAGED_VEGETATION_VISUAL_RECIPE_VALIDATION.valid) {
  throw new Error(`Invalid managed vegetation foliage recipes: ${MANAGED_VEGETATION_VISUAL_RECIPE_VALIDATION.errors.join(', ')}`);
}
