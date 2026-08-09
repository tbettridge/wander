/** Deterministic, renderer-free planning for settlement-managed vegetation. */

import {
  createManagedVegetationReservation,
  reservationShapesOverlap,
  validateManagedVegetationReservation,
} from './managedvegetation.mjs';
import {
  MANAGED_VEGETATION_ASSETS,
  MANAGED_VEGETATION_CATALOG_VERSION,
} from './managedvegetationcatalog.sol.mjs';
import { frontageAssetMetadata } from './settlementfrontagecatalog.mjs';

export const MANAGED_VEGETATION_PLAN_VERSION = 3;
export const MANAGED_VEGETATION_PLAN_HASH = `managedVegetation${MANAGED_VEGETATION_PLAN_VERSION}`;
export const MANAGED_VEGETATION_PLAN_STATUS = 'placed';

export const MANAGED_VEGETATION_CHANNELS = Object.freeze([
  'cultivation-habit', 'bed-pattern', 'asset-variant',
]);

const CULTIVATED_ASSET_IDS = Object.freeze([
  'managed-veg.garden.kitchen-cluster',
  'managed-veg.garden.herb-cluster',
  'managed-veg.orchard.pair',
  'managed-veg.coppice.low-cluster',
]);

export const MANAGED_VEGETATION_CHANNEL_VALUES = Object.freeze({
  'cultivation-habit': Object.freeze(['kitchen-garden', 'herb-garden', 'orchard', 'coppice']),
  'bed-pattern': Object.freeze(['rear-yard', 'side-yard']),
  'asset-variant': CULTIVATED_ASSET_IDS,
});

export const MANAGED_VEGETATION_PLAN_SCHEMA = Object.freeze({
  version: MANAGED_VEGETATION_PLAN_VERSION,
  fields: Object.freeze([
    'version', 'catalogVersion', 'settlementId', 'worldSeed', 'status', 'placement',
    'placements', 'reservationDependencyIds', 'presentations', 'diagnostics',
  ]),
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isId(value) { return typeof value === 'string' && value.length > 0; }

/** Stable FNV-1a hash, independent of process and locale. */
export function managedVegetationHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function managedVegetationChannelSeed({ seed = 0, scope = '', channel } = {}) {
  if (!isId(channel)) throw new TypeError('channel must be a non-empty ID.');
  return managedVegetationHash(`${seed >>> 0}:managed-vegetation:${scope}:${channel}`);
}

export function managedVegetationChannelIndex({ seed = 0, scope = '', channel, length } = {}) {
  if (!Number.isInteger(length) || length < 1) throw new TypeError('channel length must be a positive integer.');
  return managedVegetationChannelSeed({ seed, scope, channel }) % length;
}

export function pickManagedVegetationChannel({ seed = 0, scope = '', channel, values } = {}) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !isId(value))) {
    throw new TypeError('channel values must be a non-empty array of IDs.');
  }
  return values[managedVegetationChannelIndex({ seed, scope, channel, length: values.length })];
}

export function deriveManagedVegetationChannels({ seed = 0, scope = '', choices = MANAGED_VEGETATION_CHANNEL_VALUES } = {}) {
  return deepFreeze(Object.fromEntries(MANAGED_VEGETATION_CHANNELS.map((channel) => [
    channel, pickManagedVegetationChannel({ seed, scope, channel, values: choices[channel] }),
  ])));
}

function sortedIds(values) { return [...new Set(values)].sort(); }

function reservationIds(reservations, label) {
  if (!Array.isArray(reservations)) throw new TypeError(`${label} must be an array.`);
  return sortedIds(reservations.map((reservation) => {
    const result = validateManagedVegetationReservation(reservation);
    if (!result.valid) throw new TypeError(`${label}: ${result.errors.join(', ')}`);
    return reservation.id;
  }));
}

function footprint(building) {
  return building.footprint || {
    minX: -building.width / 2, maxX: building.width / 2,
    minZ: -building.depth / 2, maxZ: building.depth / 2,
  };
}

function localToWorld(building, localX, localZ) {
  const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
  return { x: building.x + localX * c + localZ * s, z: building.z - localX * s + localZ * c };
}

function assetHalfExtents(asset) {
  return {
    x: Math.max(Math.abs(asset.localBounds.min[0]), Math.abs(asset.localBounds.max[0]))
      + Math.max(asset.clearance.left, asset.clearance.right),
    z: Math.max(Math.abs(asset.localBounds.min[2]), Math.abs(asset.localBounds.max[2]))
      + Math.max(asset.clearance.front, asset.clearance.back),
  };
}

function buildingReservation(building) {
  const fp = footprint(building);
  const centreLocal = { x: (fp.minX + fp.maxX) / 2, z: (fp.minZ + fp.maxZ) / 2 };
  return createManagedVegetationReservation({
    id: `${building.id}:managed-vegetation:building-reservation`, source: 'building',
    shape: {
      kind: 'oriented-rectangle', center: localToWorld(building, centreLocal.x, centreLocal.z),
      halfExtents: { x: (fp.maxX - fp.minX) / 2 + 0.55, z: (fp.maxZ - fp.minZ) / 2 + 0.55 },
      yaw: building.yaw,
    },
  });
}

function pathReservations(plan) {
  const result = [];
  for (const path of plan.paths || []) for (let index = 1; index < path.points.length; index++) {
    const from = path.points[index - 1], to = path.points[index];
    if (from.x === to.x && from.z === to.z) continue;
    result.push(createManagedVegetationReservation({
      id: `${path.id}:managed-vegetation:${index}`, source: 'circulation',
      shape: { kind: 'segment', from: { x: from.x, z: from.z }, to: { x: to.x, z: to.z }, width: (path.width || 1.65) + 0.6 },
    }));
  }
  for (const building of plan.buildings) {
    const door = building.portals?.find((portal) => portal.kind === 'exterior-door');
    if (!door) continue;
    const from = localToWorld(building, door.x, building.depth / 2 + 0.25);
    const to = localToWorld(building, door.x, building.depth / 2 + 4.0);
    result.push(createManagedVegetationReservation({
      id: `${door.id}:managed-vegetation:approach`, source: 'door-approach',
      shape: { kind: 'segment', from, to, width: Math.max(1.4, door.width + 0.5) },
    }));
  }
  for (const street of plan.streets || []) {
    const from = plan.square ? { x: plan.square.x, z: plan.square.z } : { x: street.fromX, z: street.fromZ };
    const to = { x: street.toX, z: street.toZ };
    if (from.x === to.x && from.z === to.z) continue;
    result.push(createManagedVegetationReservation({
      id: `${street.id}:managed-vegetation`, source: 'circulation',
      shape: { kind: 'segment', from, to, width: (street.width || 2.2) + 0.8 },
    }));
  }
  return result;
}

function frontageReservations(plan) {
  const byBuilding = new Map(plan.buildings.map((building) => [building.id, building]));
  const result = [];
  for (const frontage of plan.familyFrontages || []) {
    const building = byBuilding.get(frontage.buildingId);
    if (!building) continue;
    for (const entry of [...(frontage.attachments || []), ...(frontage.yardElements || [])]) {
      const metadata = frontageAssetMetadata(entry.assetId), placement = entry.placement;
      if (!metadata || !placement) continue;
      const halfX = Math.max(Math.abs(metadata.localBounds.min[0]), Math.abs(metadata.localBounds.max[0]))
        + Math.max(metadata.clearance.left, metadata.clearance.right);
      const halfZ = Math.max(Math.abs(metadata.localBounds.min[2]), Math.abs(metadata.localBounds.max[2]))
        + Math.max(metadata.clearance.front, metadata.clearance.back);
      result.push(createManagedVegetationReservation({
        id: `${entry.id}:managed-vegetation:frontage-reservation`, source: 'family-frontage',
        shape: {
          kind: 'oriented-rectangle', center: { x: placement.x, z: placement.z },
          halfExtents: { x: halfX, z: halfZ }, yaw: building.yaw + (placement.yaw || 0),
        },
      }));
    }
  }
  return result;
}

function candidateShape(candidate, asset) {
  return {
    kind: 'oriented-rectangle', center: { x: candidate.x, z: candidate.z },
    halfExtents: assetHalfExtents(asset), yaw: candidate.yaw,
  };
}

function candidateSamples(candidate, asset) {
  const half = assetHalfExtents(asset), c = Math.cos(candidate.yaw), s = Math.sin(candidate.yaw);
  return [[0, 0], [-half.x, -half.z], [half.x, -half.z], [half.x, half.z], [-half.x, half.z]]
    .map(([x, z]) => ({ x: candidate.x + x * c + z * s, z: candidate.z - x * s + z * c }));
}

function fitCandidate(candidate, asset, reservations, { heightAt, authoritativeWaterAt }) {
  const shape = candidateShape(candidate, asset);
  if (reservations.some((reservation) => reservationShapesOverlap(shape, reservation.shape))) return null;
  const samples = candidateSamples(candidate, asset);
  if (authoritativeWaterAt && samples.some((point) => authoritativeWaterAt(point.x, point.z))) return null;
  const heights = heightAt ? samples.map((point) => heightAt(point.x, point.z)) : samples.map(() => candidate.baseY || 0);
  if (heights.some((height) => !Number.isFinite(height))) return null;
  const relief = Math.max(...heights) - Math.min(...heights);
  if (relief > asset.surfaceFit.maxReliefMeters + 1e-6) return null;
  const centreHeight = heights[0];
  let maxSlope = 0;
  for (let index = 1; index < samples.length; index++) {
    const run = Math.hypot(samples[index].x - samples[0].x, samples[index].z - samples[0].z) || 1;
    maxSlope = Math.max(maxSlope, Math.atan(Math.abs(heights[index] - centreHeight) / run) * 180 / Math.PI);
  }
  if (maxSlope > asset.surfaceFit.maxSlopeDegrees + 1e-6) return null;
  return { y: Math.max(...heights) + 0.02, shape, relief, maxSlope };
}

function candidatesFor(building, asset, channel) {
  const fp = footprint(building), half = assetHalfExtents(asset), gap = 0.9;
  const positions = channel === 'side-yard'
    ? [[fp.maxX + gap + half.x, 0, 0], [fp.minX - gap - half.x, 0, 0], [0, fp.minZ - gap - half.z, 0]]
    : [[0, fp.minZ - gap - half.z, 0], [fp.maxX * 0.42, fp.minZ - gap - half.z, 0], [fp.minX * 0.42, fp.minZ - gap - half.z, 0], [fp.maxX + gap + half.x, -fp.maxZ * 0.2, Math.PI / 2]];
  return positions.map(([localX, localZ, yaw]) => {
    const world = localToWorld(building, localX, localZ);
    return { ...world, yaw: building.yaw + yaw, localX, localZ, baseY: building.y };
  });
}

function presentationFor({ settlementId, worldSeed, building, frontage, opportunityId }) {
  const scope = `${settlementId}:${building.id}:${building.ownerHouseholdId}:${opportunityId}`;
  const channels = deriveManagedVegetationChannels({ seed: worldSeed, scope });
  const asset = MANAGED_VEGETATION_ASSETS[channels['asset-variant']];
  return {
    id: `managed-vegetation:${opportunityId}:v${MANAGED_VEGETATION_PLAN_VERSION}`,
    opportunityId, buildingId: building.id, householdId: building.ownerHouseholdId,
    familyFrontageId: frontage.id, assetId: asset.id, assetVersion: asset.version,
    descriptor: asset, channels,
  };
}

/**
 * Plan after buildings, circulation, civic space, and family frontage are final.
 * `authoritativeWaterAt` must be the world's existing water query; this module
 * never infers hydrology from height, terrain colour, or local noise.
 */
export function planManagedVegetationForSettlement(plan, {
  heightAt = null, authoritativeWaterAt = null,
} = {}) {
  if (!plan?.site || !Array.isArray(plan.buildings) || !Array.isArray(plan.familyFrontages)) {
    throw new TypeError('A final settlement plan with family frontage is required.');
  }
  const reservations = [
    ...plan.buildings.map(buildingReservation), ...pathReservations(plan), ...frontageReservations(plan),
  ];
  if (plan.square) reservations.push(createManagedVegetationReservation({
    id: `${plan.square.id}:managed-vegetation`, source: 'civic-space',
    shape: { kind: 'circle', center: { x: plan.square.x, z: plan.square.z }, radius: plan.square.radius + 0.75 },
  }));
  const waterDependency = `${plan.site.id}:authoritative-world-water`;
  const reservationDependencyIds = sortedIds([...reservations.map((entry) => entry.id), waterDependency]);
  const buildings = new Map(plan.buildings.map((building) => [building.id, building]));
  const presentations = [], placements = [], omissions = [];
  for (const frontage of [...plan.familyFrontages].sort((a, b) => a.id.localeCompare(b.id))) {
    if (frontage.role !== 'home') continue;
    const building = buildings.get(frontage.buildingId);
    if (!building?.ownerHouseholdId) continue;
    const opportunityId = `${frontage.id}:cultivated`;
    const presentation = presentationFor({ settlementId: plan.site.id, worldSeed: plan.site.seed, building, frontage, opportunityId });
    presentation.reservationDependencyIds = reservationDependencyIds;
    presentations.push(presentation);
    const asset = presentation.descriptor;
    let accepted = null;
    for (const candidate of candidatesFor(building, asset, presentation.channels['bed-pattern'])) {
      const fit = fitCandidate(candidate, asset, reservations, { heightAt, authoritativeWaterAt });
      if (!fit) continue;
      accepted = {
        id: `${presentation.id}:placement`, presentationId: presentation.id,
        opportunityId, buildingId: building.id, householdId: building.ownerHouseholdId,
        familyFrontageId: frontage.id, assetId: asset.id, catalogVersion: asset.version,
        x: candidate.x, y: fit.y, z: candidate.z, yaw: candidate.yaw, scale: 1,
        lodId: asset.lod.defaultLevel, footprint: fit.shape,
        surfaceFit: { reliefMeters: fit.relief, slopeDegrees: fit.maxSlope },
        collision: asset.collision, groundCover: asset.groundCover,
        reservationDependencyIds,
      };
      break;
    }
    if (accepted) {
      placements.push(accepted);
      reservations.push(createManagedVegetationReservation({
        id: `${accepted.id}:occupied`, source: 'family-frontage', shape: accepted.footprint,
      }));
    } else omissions.push({ opportunityId, reason: 'no-safe-surface-fit' });
  }
  return deepFreeze({
    version: MANAGED_VEGETATION_PLAN_VERSION,
    catalogVersion: MANAGED_VEGETATION_CATALOG_VERSION,
    settlementId: plan.site.id,
    worldSeed: plan.site.seed >>> 0,
    status: MANAGED_VEGETATION_PLAN_STATUS,
    placement: 'final', placements, reservationDependencyIds, presentations,
    diagnostics: {
      opportunities: presentations.length, placed: placements.length, omitted: omissions.length,
      omissions, reservationCount: reservations.length, authoritativeWaterSource: 'world',
    },
  });
}

/** Back-compatible pure handoff for callers which already provide opportunities. */
export function planManagedVegetationPresentation({
  settlementId, worldSeed = 0, opportunities = [], reservations = [], authoritativeWaterReservations = [],
  choices = MANAGED_VEGETATION_CHANNEL_VALUES,
} = {}) {
  if (!isId(settlementId)) throw new TypeError('settlementId must be a non-empty ID.');
  const dependencyIds = sortedIds([
    ...reservationIds(reservations, 'reservations'),
    ...reservationIds(authoritativeWaterReservations, 'authoritativeWaterReservations'),
  ]);
  const seen = new Set();
  const presentations = opportunities.map((opportunity) => {
    if (!isId(opportunity?.id) || !isId(opportunity.buildingId) || !isId(opportunity.householdId)) {
      throw new TypeError('cultivation opportunity requires stable identity.');
    }
    if (seen.has(opportunity.id)) throw new TypeError(`duplicate cultivation opportunity: ${opportunity.id}`);
    seen.add(opportunity.id);
    const scope = `${settlementId}:${opportunity.buildingId}:${opportunity.householdId}:${opportunity.id}`;
    const channels = deriveManagedVegetationChannels({ seed: worldSeed, scope, choices });
    const asset = MANAGED_VEGETATION_ASSETS[channels['asset-variant']];
    if (!asset) throw new RangeError(`Unknown managed vegetation asset: ${channels['asset-variant']}`);
    return {
      id: `managed-vegetation:${opportunity.id}:v${MANAGED_VEGETATION_PLAN_VERSION}`,
      opportunityId: opportunity.id, buildingId: opportunity.buildingId,
      householdId: opportunity.householdId, familyFrontageId: opportunity.familyFrontageId ?? null,
      assetId: asset.id, assetVersion: asset.version, descriptor: asset, channels,
      reservationDependencyIds: sortedIds([...dependencyIds, ...(opportunity.reservationDependencyIds || [])]),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return deepFreeze({
    version: MANAGED_VEGETATION_PLAN_VERSION, catalogVersion: MANAGED_VEGETATION_CATALOG_VERSION,
    settlementId, worldSeed: worldSeed >>> 0, status: 'prepared', placement: 'deferred', placements: [],
    reservationDependencyIds: dependencyIds, presentations,
    diagnostics: { opportunities: presentations.length, placed: 0, omitted: 0 },
  });
}

export const planCultivatedPlantingPresentation = planManagedVegetationPresentation;

export function validateManagedVegetationPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return deepFreeze({ valid: false, errors: ['plan-not-object'] });
  for (const field of MANAGED_VEGETATION_PLAN_SCHEMA.fields) if (!Object.hasOwn(plan, field)) errors.push(`plan-missing:${field}`);
  if (plan.version !== MANAGED_VEGETATION_PLAN_VERSION) errors.push('plan-version');
  if (plan.catalogVersion !== MANAGED_VEGETATION_CATALOG_VERSION) errors.push('plan-catalog-version');
  if (!isId(plan.settlementId) || !Number.isInteger(plan.worldSeed)) errors.push('plan-identity');
  if (!['prepared', MANAGED_VEGETATION_PLAN_STATUS].includes(plan.status)) errors.push('plan-status');
  if (!Array.isArray(plan.placements) || !Array.isArray(plan.presentations)) errors.push('plan-arrays');
  for (const presentation of plan.presentations || []) {
    if (!MANAGED_VEGETATION_ASSETS[presentation.assetId] || presentation.descriptor !== MANAGED_VEGETATION_ASSETS[presentation.assetId]) {
      errors.push(`presentation-descriptor:${presentation.id || 'unknown'}`);
    }
  }
  for (const placement of plan.placements || []) {
    if (![placement.x, placement.y, placement.z, placement.yaw].every(Number.isFinite)) errors.push(`placement-transform:${placement.id}`);
    if (!MANAGED_VEGETATION_ASSETS[placement.assetId]) errors.push(`placement-asset:${placement.id}`);
  }
  return deepFreeze({ valid: errors.length === 0, errors });
}
