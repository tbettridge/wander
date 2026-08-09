import { buildingWorldPoint } from './buildingplan.mjs';
import {
  FAMILY_FRONTAGE_PLACEHOLDER_IDS,
  FAMILY_FRONTAGE_VERSION,
  FAMILY_OWNED_PROGRAMS,
  buildingFamilyFrontageId,
  createBuildingFamilyFrontage,
  createFamilyFrontageProfile,
  familyFrontageProfileId,
} from './familyfrontage.mjs';
import {
  FAMILY_FRONTAGE_VISUAL_OPTIONS,
  FRONTAGE_ASSETS,
  FRONTAGE_ZONES,
  frontageAssetMetadata,
} from './settlementfrontagecatalog.mjs';
import { FRONTAGE_APPLICATION_OPTIONS } from './settlementfrontageapplicationcatalog.sol.mjs';

/** Version of the derived planner/rendering seam, separate from Sol's catalog version. */
export const FAMILY_FRONTAGE_PLAN_VERSION = 1;
export const FAMILY_FRONTAGE_PLAN_HASH = `frontage${FAMILY_FRONTAGE_PLAN_VERSION}`;
export const FRONTAGE_NEARBY_REPETITION_RADIUS = 42;
export const FRONTAGE_PLANNER_CONTRACT = Object.freeze({
  version: FAMILY_FRONTAGE_PLAN_VERSION,
  supportedChannels: Object.freeze([
    'palette', 'mark', 'mark-treatment', 'yard-habit', 'boundary-habit',
    'garden-habit', 'material-habit', 'mark-mount', 'service-variant',
    'yard-zone-order', 'facade-application', 'trim-target', 'door-treatment',
    'element-variant',
  ]),
  unavailableChannels: Object.freeze([]),
  unavailableReason: null,
});

const MAX_MESHES_PER_BUILDING = 72;
const MAX_TRIANGLES_PER_BUILDING = 1800;
const EPSILON = 1e-6;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function arrayIds(value) {
  return Array.isArray(value) ? value.slice() : Object.keys(value || {});
}

function profileValue(profile, channel) {
  const key = {
    palette: 'paletteId', mark: 'markId', 'mark-treatment': 'markTreatmentId',
    'yard-habit': 'yardHabitId', 'boundary-habit': 'boundaryHabitId',
    'garden-habit': 'gardenHabitId', 'material-habit': 'materialHabitId',
  }[channel] || channel;
  return profile?.[key];
}

function pickChannel(householdId, channel, values, nearby = []) {
  if (!values.length) return null;
  const start = hashText(`${householdId}:family-frontage:${channel}`) % values.length;
  const repeated = new Set(nearby.map((profile) => profileValue(profile, channel)).filter(Boolean));
  for (let offset = 0; offset < values.length; offset++) {
    const candidate = values[(start + offset) % values.length];
    if (!repeated.has(candidate) || values.length === 1) return candidate;
  }
  return values[start];
}

function profileChannelValues(channel) {
  if (channel === 'palette') return arrayIds(FAMILY_FRONTAGE_VISUAL_OPTIONS.paletteIds);
  if (channel === 'mark') return arrayIds(FAMILY_FRONTAGE_VISUAL_OPTIONS.markIds);
  if (channel === 'mark-treatment') return arrayIds(FAMILY_FRONTAGE_VISUAL_OPTIONS.markTreatmentIds);
  if (channel === 'yard-habit') return Object.keys(FAMILY_FRONTAGE_VISUAL_OPTIONS.yardHabits);
  if (channel === 'boundary-habit') return Object.keys(FAMILY_FRONTAGE_VISUAL_OPTIONS.boundaryHabits);
  if (channel === 'garden-habit') return Object.keys(FAMILY_FRONTAGE_VISUAL_OPTIONS.gardenHabits);
  if (channel === 'material-habit') return Object.keys(FAMILY_FRONTAGE_VISUAL_OPTIONS.materialHabits);
  return [];
}

function profileFor(home, ownedBuildingIds, nearbyProfiles) {
  const householdId = home.ownerHouseholdId;
  const selected = {};
  for (const channel of ['palette', 'mark', 'mark-treatment', 'yard-habit', 'boundary-habit', 'garden-habit', 'material-habit']) {
    selected[channel] = pickChannel(householdId, channel, profileChannelValues(channel), nearbyProfiles);
  }
  return createFamilyFrontageProfile({
    householdId,
    surname: home.ownerSurname || 'Unknown',
    homeBuildingId: home.id,
    ownedBuildingIds,
    seed: hashText(`${householdId}:family-frontage:profile`),
    placeholders: {
      ...FAMILY_FRONTAGE_PLACEHOLDER_IDS,
      paletteId: selected.palette,
      markId: selected.mark,
      markTreatmentId: selected['mark-treatment'],
      yardHabitId: selected['yard-habit'],
      boundaryHabitId: selected['boundary-habit'],
      gardenHabitId: selected['garden-habit'],
      materialHabitId: selected['material-habit'],
    },
  });
}

function buildingFootprint(building) {
  return building.footprint || {
    minX: -building.width / 2, maxX: building.width / 2,
    minZ: -building.depth / 2, maxZ: building.depth / 2,
  };
}

function buildingLocalPoint(building, x, z) {
  const dx = x - building.x, dz = z - building.z;
  const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

function localWorldPoint(building, x, z) {
  return buildingWorldPoint(building, x, z);
}

function localRectCorners(building, minX, maxX, minZ, maxZ) {
  return [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]]
    .map(([x, z]) => localWorldPoint(building, x, z));
}

function candidateCorners(building, localX, localZ, yaw, metadata) {
  const bounds = metadata.localBounds;
  const clearance = metadata.clearance;
  const minX = bounds.min[0] - clearance.left;
  const maxX = bounds.max[0] + clearance.right;
  const minZ = bounds.min[2] - clearance.back;
  const maxZ = bounds.max[2] + clearance.front;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]].map(([x, z]) => localWorldPoint(
    building, localX + x * c + z * s, localZ - x * s + z * c,
  ));
}

function polygonOverlap(a, b) {
  const polygons = [a, b];
  for (const polygon of polygons) for (let i = 0; i < polygon.length; i++) {
    const from = polygon[i], to = polygon[(i + 1) % polygon.length];
    const axis = { x: -(to.z - from.z), z: to.x - from.x };
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const point of a) {
      const value = point.x * axis.x + point.z * axis.z;
      minA = Math.min(minA, value); maxA = Math.max(maxA, value);
    }
    for (const point of b) {
      const value = point.x * axis.x + point.z * axis.z;
      minB = Math.min(minB, value); maxB = Math.max(maxB, value);
    }
    if (maxA < minB - EPSILON || maxB < minA - EPSILON) return false;
  }
  return true;
}

function distanceToSegment(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
}

function candidateRadius(metadata) {
  const bounds = metadata.localBounds;
  const clearance = metadata.clearance;
  return Math.hypot(
    Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0])) + Math.max(clearance.left, clearance.right),
    Math.max(Math.abs(bounds.min[2]), Math.abs(bounds.max[2])) + Math.max(clearance.front, clearance.back),
  );
}

function pathSegments(plan, building) {
  const segments = [];
  for (const path of plan.paths || []) for (let index = 1; index < path.points.length; index++) {
    segments.push({ a: path.points[index - 1], b: path.points[index], width: path.width || 1.65, kind: path.kind || 'path' });
  }
  // The explicit door approach is retained even if a custom caller supplied a
  // plan with no circulation paths. This keeps the safety seam conservative.
  const door = building.portals?.find((portal) => portal.kind === 'exterior-door');
  if (door) {
    const from = localWorldPoint(building, door.x, building.depth / 2 + 0.5);
    const to = localWorldPoint(building, door.x, building.depth / 2 + 3.8);
    segments.push({ a: from, b: to, width: 1.25, kind: 'door-approach' });
  }
  for (const street of plan.streets || []) {
    const from = plan.square ? { x: plan.square.x, z: plan.square.z } : { x: street.fromX, z: street.fromZ };
    segments.push({
      a: from, b: { x: street.toX, z: street.toZ },
      width: street.width || 2.2, kind: 'street',
    });
  }
  return segments;
}

function loiterSegments(building) {
  const fp = buildingFootprint(building), margin = 1.35;
  const corners = localRectCorners(building, fp.minX - margin, fp.maxX + margin, fp.minZ - margin, fp.maxZ + margin);
  return corners.map((a, index) => ({ a, b: corners[(index + 1) % corners.length], width: 0.8, kind: 'npc-loiter' }));
}

function candidateTouchesReserved(candidate, metadata, reservations) {
  const radius = Math.max(0.35, candidateRadius(metadata));
  for (const reservation of reservations.buildings) {
    if (polygonOverlap(candidate, reservation)) return true;
  }
  for (const segment of reservations.segments) {
    const distance = Math.min(...candidate.map((point) => distanceToSegment(point.x, point.z, segment.a, segment.b)));
    if (distance < segment.width / 2 + metadata.placementHints.pathGap + 0.15) return true;
    const centre = candidate.reduce((sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }), { x: 0, z: 0 });
    centre.x /= candidate.length; centre.z /= candidate.length;
    if (distanceToSegment(centre.x, centre.z, segment.a, segment.b) < segment.width / 2 + radius + 0.1) return true;
  }
  if (reservations.square && candidate.some((point) => Math.hypot(point.x - reservations.square.x, point.z - reservations.square.z)
    < reservations.square.radius + 0.35)) return true;
  return false;
}

function candidateGroundSafe(building, localX, localZ, yaw, metadata, {
  heightAt, blockedAt, reservations, placed,
} = {}) {
  const corners = candidateCorners(building, localX, localZ, yaw, metadata);
  if (candidateTouchesReserved(corners, metadata, reservations)) return null;
  const samples = [...corners];
  const centre = localWorldPoint(building, localX, localZ);
  samples.push(centre);
  if (blockedAt && samples.some((point) => blockedAt(point.x, point.z))) return null;
  const existingRadius = Math.hypot(metadata.halfExtents.x, metadata.halfExtents.z);
  for (const prior of placed) {
    const distance = Math.hypot(centre.x - prior.worldX, centre.z - prior.worldZ);
    if (distance < existingRadius + prior.radius + 0.15) return null;
  }
  let groundY = building.y + 0.16;
  if (heightAt) {
    const heights = samples.map((point) => heightAt(point.x, point.z));
    const relief = Math.max(...heights) - Math.min(...heights);
    if (relief > metadata.reliefTolerance + 1e-5) return null;
    let steepest = 0;
    for (let index = 1; index < samples.length; index++) {
      const run = Math.hypot(samples[index].x - centre.x, samples[index].z - centre.z) || 1;
      steepest = Math.max(steepest, Math.abs(heights[index] - heights[heights.length - 1]) / run);
    }
    const slopeDegrees = Math.atan(steepest) * 180 / Math.PI;
    if (slopeDegrees > metadata.slopeTolerance + 1e-5) return null;
    groundY = Math.max(...heights) + 0.02;
  }
  return { corners, worldX: centre.x, worldZ: centre.z, groundY, radius: existingRadius };
}

function candidatePositions(building, metadata) {
  const fp = buildingFootprint(building);
  const hints = metadata.placementHints;
  const gap = Math.max(hints.wallGap?.[0] || 0.5, 0.8);
  const halfX = Math.max(Math.abs(metadata.localBounds.min[0]), Math.abs(metadata.localBounds.max[0]));
  const halfZ = Math.max(Math.abs(metadata.localBounds.min[2]), Math.abs(metadata.localBounds.max[2]));
  const door = building.portals?.find((portal) => portal.kind === 'exterior-door');
  const positions = [];
  const push = (localX, localZ, zone, yaw = 0) => positions.push({ localX, localZ, zone, yaw });
  const sideX = Math.max(Math.abs(fp.minX), Math.abs(fp.maxX));
  const sideZ = Math.max(Math.abs(fp.minZ), Math.abs(fp.maxZ));
  for (const zone of metadata.zones) {
    if (zone === FRONTAGE_ZONES.thresholdEdge || zone === FRONTAGE_ZONES.buildingFront) {
      const x = door?.x || 0;
      const doorHalf = (door?.width || 0) / 2;
      push(x + doorHalf + halfX + 0.7, fp.maxZ + gap + halfZ, zone);
      push(x - doorHalf - halfX - 0.7, fp.maxZ + gap + halfZ, zone);
      push(x, fp.maxZ + gap + halfZ, zone);
    } else if (zone === FRONTAGE_ZONES.buildingSide || zone === FRONTAGE_ZONES.sideYard || zone === FRONTAGE_ZONES.workYard) {
      push(sideX + gap + halfX, sideZ * 0.34, zone);
      push(-sideX - gap - halfX, sideZ * 0.34, zone);
      push(sideX + gap + halfX, -sideZ * 0.34, zone);
      push(-sideX - gap - halfX, -sideZ * 0.34, zone);
    } else if (zone === FRONTAGE_ZONES.rearYard || zone === FRONTAGE_ZONES.gardenEdge) {
      push(0, fp.minZ - gap - halfZ, zone);
      push(sideX * 0.42, fp.minZ - gap - halfZ, zone);
      push(-sideX * 0.42, fp.minZ - gap - halfZ, zone);
    } else {
      push(0, fp.maxZ + gap + halfZ, zone);
    }
  }
  return positions;
}

function compatibleAsset(assetId, program) {
  const metadata = frontageAssetMetadata(assetId);
  return metadata && metadata.version === FAMILY_FRONTAGE_VERSION
    && metadata.programs.includes(program) && metadata.groundCover === 'none';
}

function placementForAsset(building, assetId, channel, reservations, context, placed) {
  const metadata = frontageAssetMetadata(assetId);
  if (!metadata || !compatibleAsset(assetId, building.program)) return { omitted: `${channel}:incompatible-asset:${assetId}` };
  if (metadata.wallAttached) return { omitted: `${channel}:wall-asset-in-ground-placement:${assetId}` };
  for (const candidate of candidatePositions(building, metadata)) {
    const result = candidateGroundSafe(building, candidate.localX, candidate.localZ, candidate.yaw, metadata, {
      ...context, reservations, placed,
    });
    if (!result) continue;
    const placement = {
      localX: candidate.localX, localY: result.groundY - building.y, localZ: candidate.localZ,
      x: result.worldX, y: result.groundY, z: result.worldZ, yaw: candidate.yaw,
      zone: candidate.zone,
    };
    return { assetId, category: metadata.category, channel, placement, worldX: result.worldX, worldZ: result.worldZ, radius: result.radius };
  }
  return { omitted: `${channel}:unsafe-placement:${assetId}` };
}

function markPlacement(building, profile, mountId) {
  const metadata = frontageAssetMetadata(profile.markId);
  const door = building.portals?.find((portal) => portal.kind === 'exterior-door');
  if (!metadata || !door) return { omitted: 'mark:missing-mark-or-door' };
  const preferred = FAMILY_FRONTAGE_VISUAL_OPTIONS.markMounts[mountId]?.preferredHeight || [1.45, 1.9];
  const fp = buildingFootprint(building);
  const half = Math.max(Math.abs(metadata.localBounds.min[0]), Math.abs(metadata.localBounds.max[0]));
  const candidates = [
    { x: door.x + door.width / 2 + half + 0.3, y: (preferred[0] + preferred[1]) / 2 },
    { x: door.x - door.width / 2 - half - 0.3, y: (preferred[0] + preferred[1]) / 2 },
    { x: Math.max(fp.minX + half + 0.25, Math.min(fp.maxX - half - 0.25, door.x)), y: preferred[1] },
  ];
  for (const candidate of candidates) {
    if (candidate.x - half < fp.minX + 0.08 || candidate.x + half > fp.maxX - 0.08) continue;
    if (Math.abs(candidate.x - door.x) < (door.width / 2 + half + 0.2)) continue;
    return {
      assetId: profile.markId, category: 'family-mark', channel: 'mark',
      treatmentId: profile.markTreatmentId, householdMaterialId: profile.paletteId,
      placement: {
        localX: candidate.x, localY: candidate.y, localZ: building.depth / 2 + 0.035,
        x: localWorldPoint(building, candidate.x, building.depth / 2 + 0.035).x,
        y: building.y + candidate.y,
        z: localWorldPoint(building, candidate.x, building.depth / 2 + 0.035).z,
        yaw: 0, zone: FRONTAGE_ZONES.buildingFront,
      },
    };
  }
  return { omitted: 'mark:unsafe-wall-mount' };
}

function addOwnedAsset(frontage, asset, placed, budget) {
  const metadata = frontageAssetMetadata(asset.assetId);
  if (!metadata) return { accepted: false, reason: `missing-catalog-asset:${asset.assetId}` };
  if (budget.meshes + metadata.meshBudget > MAX_MESHES_PER_BUILDING
    || budget.triangles + metadata.triangleBudget > MAX_TRIANGLES_PER_BUILDING) {
    return { accepted: false, reason: `budget:${asset.assetId}` };
  }
  placed.push(asset);
  budget.meshes += metadata.meshBudget;
  budget.triangles += metadata.triangleBudget;
  return { accepted: true };
}

function assetIdsForHabit(group, id) {
  return FAMILY_FRONTAGE_VISUAL_OPTIONS[group]?.[id]?.assetIds?.slice() || [];
}

function buildFrontage(building, profile, reservations, context) {
  const base = createBuildingFamilyFrontage({
    buildingId: building.id,
    householdId: building.ownerHouseholdId,
    profileId: familyFrontageProfileId(building.ownerHouseholdId),
    program: building.program,
    placeholders: {
      ...FAMILY_FRONTAGE_PLACEHOLDER_IDS,
      // These choices remain household-keyed, so a home and its owned business
      // share one quiet architectural vocabulary without changing placement.
      facadeTreatmentId: pickChannel(building.ownerHouseholdId, 'facade-application', FRONTAGE_APPLICATION_OPTIONS.facadeTreatmentIds, []),
      trimTargetId: pickChannel(building.ownerHouseholdId, 'trim-target', FRONTAGE_APPLICATION_OPTIONS.trimTargetIds, []),
      doorTreatmentId: pickChannel(building.ownerHouseholdId, 'door-treatment', FRONTAGE_APPLICATION_OPTIONS.doorTreatmentIds, []),
      elementVariantId: pickChannel(building.ownerHouseholdId, 'element-variant', FRONTAGE_APPLICATION_OPTIONS.elementVariantIds, []),
      markMountId: pickChannel(building.ownerHouseholdId, 'mark-mount', Object.keys(FAMILY_FRONTAGE_VISUAL_OPTIONS.markMounts), []),
      serviceCueId: FAMILY_FRONTAGE_VISUAL_OPTIONS.serviceCueIds[building.program],
    },
  });
  const attachments = [];
  const yardElements = [];
  const omittedReasons = [
    ...FRONTAGE_PLANNER_CONTRACT.unavailableChannels.map((channel) => `${channel}:${FRONTAGE_PLANNER_CONTRACT.unavailableReason}`),
  ];
  const budget = { meshes: 0, triangles: 0 };
  const placed = [];
  const mountId = base.application.markMountId;
  const mark = markPlacement(building, profile, mountId);
  if (mark.omitted) omittedReasons.push(mark.omitted);
  else {
    const result = addOwnedAsset(base, mark, placed, budget);
    if (result.accepted) attachments.push({ ...mark, id: `${base.id}:attachment:mark` });
    else omittedReasons.push(result.reason);
  }

  // The WP0 application deliberately leaves home.serviceCueId null. Sol still
  // authored a bounded threshold cue for dwellings, so it can be placed as a
  // yard element without pretending the application contract has a home
  // service field.
  const serviceId = building.program === 'dwelling'
    ? FAMILY_FRONTAGE_VISUAL_OPTIONS.serviceCueIds.dwelling
    : base.application.serviceCueId;
  const service = placementForAsset(building, serviceId, 'service-variant', reservations, context, placed);
  if (service.omitted) omittedReasons.push(service.omitted);
  else {
    const result = addOwnedAsset(base, service, placed, budget);
    if (result.accepted) yardElements.push({ ...service, id: `${base.id}:yard:service` });
    else omittedReasons.push(result.reason);
  }

  const habit = FAMILY_FRONTAGE_VISUAL_OPTIONS.yardHabits[profile.yardHabitId] || { maxYardElements: 1 };
  const candidates = [
    ...assetIdsForHabit('boundaryHabits', profile.boundaryHabitId),
    ...assetIdsForHabit('gardenHabits', profile.gardenHabitId),
    ...assetIdsForHabit('materialHabits', profile.materialHabitId),
  ];
  const offset = candidates.length ? hashText(`${building.ownerHouseholdId}:element-variant:${building.program}`) % candidates.length : 0;
  const ordered = candidates.slice(offset).concat(candidates.slice(0, offset));
  for (const assetId of ordered.slice(0, habit.maxYardElements)) {
    const element = placementForAsset(building, assetId, 'element-variant', reservations, context, placed);
    if (element.omitted) { omittedReasons.push(element.omitted); continue; }
    const result = addOwnedAsset(base, element, placed, budget);
    if (result.accepted) yardElements.push({ ...element, id: `${base.id}:yard:${element.channel}:${element.assetId}` });
    else omittedReasons.push(result.reason);
  }

  const assetOmissionCount = omittedReasons.filter((reason) => reason.includes(':unsafe-placement:')
    || reason.includes(':incompatible-asset:') || reason.includes(':wall-asset-in-ground-placement:')
    || reason.startsWith('mark:') || reason.startsWith('budget:') || reason.startsWith('missing-catalog-asset:')).length;
  const normalized = {
    ...base,
    paletteId: profile.paletteId,
    markId: profile.markId,
    markTreatmentId: profile.markTreatmentId,
    yardHabitId: profile.yardHabitId,
    attachments: deepFreeze(attachments),
    yardElements: deepFreeze(yardElements),
    omittedReasons: deepFreeze(omittedReasons),
    debug: deepFreeze({
      meshes: budget.meshes, triangles: budget.triangles,
      placedAssets: placed.length, omittedAssets: assetOmissionCount,
      contractWarnings: omittedReasons.length - assetOmissionCount,
      collisionAssets: placed.filter((item) => frontageAssetMetadata(item.assetId)?.collision?.mode !== 'none').length,
    }),
  };
  return Object.freeze(normalized);
}

function reservationsFor(plan, building, profile) {
  const buildings = plan.buildings.map((other) => {
    const fp = buildingFootprint(other);
    const margin = other.id === building.id ? 0.5 : 0.55;
    return localRectCorners(other, fp.minX - margin, fp.maxX + margin, fp.minZ - margin, fp.maxZ + margin);
  });
  const segments = pathSegments(plan, building);
  if (building.id === profile.homeBuildingId) segments.push(...loiterSegments(building));
  return {
    buildings,
    segments,
    square: plan.square ? { x: plan.square.x, z: plan.square.z, radius: plan.square.radius } : null,
  };
}

/**
 * Fill the serializable family-frontage seam after building ownership and
 * circulation are known. This function imports no Three code and never mutates
 * Sol's catalog records.
 */
export function planFamilyFrontages(plan, { heightAt = null, blockedAt = null } = {}) {
  if (!plan?.site || !Array.isArray(plan.buildings)) throw new TypeError('A settlement plan is required.');
  const homes = plan.buildings.filter((building) => building.program === 'dwelling' && building.ownerHouseholdId);
  const households = new Map();
  for (const building of plan.buildings) {
    if (!building.ownerHouseholdId || !FAMILY_OWNED_PROGRAMS.includes(building.program)) continue;
    const owned = households.get(building.ownerHouseholdId) || { home: null, buildings: [] };
    owned.home ||= building.program === 'dwelling' ? building : null;
    owned.buildings.push(building);
    households.set(building.ownerHouseholdId, owned);
  }
  const profiles = [];
  const profileByHousehold = new Map();
  const orderedHomes = homes.slice().sort((a, b) => a.id.localeCompare(b.id));
  for (const home of orderedHomes) {
    const family = households.get(home.ownerHouseholdId);
    const nearby = profiles.filter((profile) => {
      const other = plan.buildings.find((candidate) => candidate.id === profile.homeBuildingId);
      return other && Math.hypot(other.x - home.x, other.z - home.z) <= FRONTAGE_NEARBY_REPETITION_RADIUS;
    });
    const profile = profileFor(home, family?.buildings.map((entry) => entry.id) || [home.id], nearby);
    profiles.push(profile); profileByHousehold.set(profile.householdId, profile);
  }

  const frontages = [];
  const debug = { profiles: profiles.length, frontages: 0, placedAssets: 0, omittedAssets: 0, collisionAssets: 0, meshes: 0, triangles: 0 };
  for (const building of plan.buildings) {
    const profile = building.ownerHouseholdId ? profileByHousehold.get(building.ownerHouseholdId) : null;
    if (!profile || !FAMILY_OWNED_PROGRAMS.includes(building.program)) continue;
    const frontage = buildFrontage(building, profile, reservationsFor(plan, building, profile), { heightAt, blockedAt });
    frontages.push(frontage);
    debug.frontages++;
    debug.placedAssets += frontage.debug.placedAssets;
    debug.omittedAssets += frontage.debug.omittedAssets;
    debug.collisionAssets += frontage.debug.collisionAssets;
    debug.meshes += frontage.debug.meshes;
    debug.triangles += frontage.debug.triangles;
  }
  return {
    familyFrontageProfiles: Object.freeze(profiles),
    familyFrontages: Object.freeze(frontages),
    familyFrontageDiagnostics: deepFreeze({
      version: FAMILY_FRONTAGE_PLAN_VERSION,
      contract: FRONTAGE_PLANNER_CONTRACT,
      unsupportedChannels: FRONTAGE_PLANNER_CONTRACT.unavailableChannels.slice(),
      ...debug,
    }),
  };
}

export function validateFamilyFrontageSourceContract() {
  const errors = [];
  for (const id of FRONTAGE_PLANNER_CONTRACT.supportedChannels) {
    if (id === 'palette' && !FAMILY_FRONTAGE_VISUAL_OPTIONS.paletteIds?.length) errors.push('missing-palette-options');
    if (id === 'mark' && !FAMILY_FRONTAGE_VISUAL_OPTIONS.markIds?.length) errors.push('missing-mark-options');
  }
  for (const [program, assetId] of Object.entries(FAMILY_FRONTAGE_VISUAL_OPTIONS.serviceCueIds || {})) {
    const asset = FRONTAGE_ASSETS[assetId];
    if (!asset || !asset.programs.includes(program)) errors.push(`service-cue-contract:${program}:${assetId}`);
  }
  for (const [channel, ids] of Object.entries({
    'facade-application': FRONTAGE_APPLICATION_OPTIONS.facadeTreatmentIds,
    'trim-target': FRONTAGE_APPLICATION_OPTIONS.trimTargetIds,
    'door-treatment': FRONTAGE_APPLICATION_OPTIONS.doorTreatmentIds,
    'element-variant': FRONTAGE_APPLICATION_OPTIONS.elementVariantIds,
  })) {
    if (!ids?.length) errors.push(`missing-application-options:${channel}`);
  }
  return Object.freeze({ valid: errors.length === 0, errors });
}

export const FAMILY_FRONTAGE_SOURCE_CONTRACT_VALIDATION = validateFamilyFrontageSourceContract();
if (!FAMILY_FRONTAGE_SOURCE_CONTRACT_VALIDATION.valid) {
  throw new Error(`Invalid family frontage source contract: ${FAMILY_FRONTAGE_SOURCE_CONTRACT_VALIDATION.errors.join(', ')}`);
}

export function frontagePlacementBounds(frontage) {
  const entries = [...(frontage?.attachments || []), ...(frontage?.yardElements || [])];
  return entries.map((entry) => ({
    id: entry.id || `${buildingFamilyFrontageId(frontage.buildingId)}:${entry.assetId}`,
    assetId: entry.assetId,
    x: entry.placement?.x,
    y: entry.placement?.y,
    z: entry.placement?.z,
  }));
}
