// Deterministic startup viewpoints for accepted regional lake water. The
// ownership checks here deliberately use the prepared field's lake identity;
// a nearby wet river is not a valid substitute for a lake shore.

import { BASIN_REGION_SIZE } from './hydrologyformat.mjs';

const DEFAULT_MAX_DISTANCE = 640;
const RAY_COUNT = 16;
const RAY_STEP = 4;
const SHORE_HEIGHT = 0.3;
const SHORE_MAX_SLOPE = 0.2;
const MAX_SHORE_GAP = 32;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function lakeKind(value) {
  return finite(value) && value >= 1.5;
}

function validPoint(x, z) {
  return finite(x) && finite(z);
}

function targetSort(a, b) {
  return Number(b.centerRegion) - Number(a.centerRegion)
    || String(a.id).localeCompare(String(b.id))
    || String(a.bodyId).localeCompare(String(b.bodyId));
}

function denseLakeAnchor(body) {
  const g = body?.grid;
  if (!g || !Number.isInteger(g.cols) || !Number.isInteger(g.rows)
    || !finite(g.step) || g.step <= 0 || !Array.isArray(g.signed)) return null;
  let index = -1;
  for (let i = 0; i < g.signed.length; i++) {
    if (g.signed[i] > 0 && (index < 0 || g.signed[i] > g.signed[index])) index = i;
  }
  if (index < 0 || !finite(g.x0) || !finite(g.z0) || !finite(body.level)) return null;
  return {
    x: g.x0 + (index % g.cols) * g.step,
    z: g.z0 + Math.floor(index / g.cols) * g.step,
    level: body.level,
  };
}

function componentLakeAnchors(mesh) {
  const g = mesh?.grid;
  if (!mesh?.hash || !Array.isArray(mesh.basinIds) || !mesh.basinIds.length
    || !g || !Array.isArray(g.coords) || !Array.isArray(g.lakeKind)
    || !Array.isArray(g.signed) || !Array.isArray(g.head)
    || g.coords.length !== g.lakeKind.length || g.coords.length !== g.signed.length
    || g.coords.length !== g.head.length || !finite(g.step) || g.step <= 0) return [];
  const byLevel = new Map();
  for (let i = 0; i < g.coords.length; i++) {
    const point = g.coords[i];
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)
      || !lakeKind(g.lakeKind[i]) || !(g.signed[i] > 0) || !finite(g.head[i])) continue;
    const key = g.head[i].toFixed(6);
    const current = byLevel.get(key);
    if (!current || g.signed[i] > current.signed) {
      byLevel.set(key, {
        x: point[0] * g.step, z: point[1] * g.step,
        level: g.head[i], signed: g.signed[i],
      });
    }
  }
  return [...byLevel.values()];
}

function componentBodyId(mesh) {
  return `component:${mesh.hash}`;
}

function ownedLakeWater(info, target, allowTransition = false) {
  if (!info?.wet || info.bodyId !== target.bodyId) return false;
  const kind = info.kind || info.bodyKind;
  const waterLevel = finite(info.waterY) ? info.waterY : (finite(info.y) ? info.y : null);
  const sameLevel = waterLevel === null || !finite(target.level)
    || Math.abs(waterLevel - target.level) <= 0.15;
  if (kind === 'lake') return sameLevel;
  // Sparse component interpolation labels the last lake cells as pond before
  // dry terrain (and may then report river as the lakeKind tapers to zero).
  // Accept only the same-owner, same-level pond band; river/outlet reaches
  // remain a hard boundary.
  return allowTransition && kind === 'pond' && sameLevel;
}

function normalizeContains(contains) {
  return typeof contains === 'function' ? contains : () => true;
}

function shoreForTarget(world, target, contains, maxDistance) {
  const anchorInfo = world.riverAt(target.x, target.z);
  if (!ownedLakeWater(anchorInfo, target) || !contains(target.x, target.z, 0)) return null;
  let best = null;
  for (let ray = 0; ray < RAY_COUNT; ray++) {
    const angle = ray * Math.PI * 2 / RAY_COUNT;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    // The anchor was already verified as wet lake ownership. Starting true
    // lets a small lake's first 4m sample land directly on its dry bank.
    let touchedLake = true, lastWetDistance = 0;
    for (let distance = RAY_STEP; distance <= maxDistance; distance += RAY_STEP) {
      const x = target.x + cos * distance, z = target.z + sin * distance;
      const info = world.riverAt(x, z);
      if (ownedLakeWater(info, target, true)) {
        touchedLake = true;
        lastWetDistance = distance;
        continue;
      }
      if (!touchedLake) continue;
      // Stop at a different wet owner. A dry point beyond another river is not
      // a shore of this lake even if the terrain happens to be suitable.
      if (info?.wet) break;
      if (distance - lastWetDistance > MAX_SHORE_GAP) break;
      if (!contains(x, z, 0)) continue;
      const site = world.biomeAt(x, z);
      if (!finite(site?.h) || !finite(site?.slope)
        || site.h <= target.level + SHORE_HEIGHT || site.slope >= SHORE_MAX_SLOPE) continue;
      const distanceToTarget = Math.hypot(target.x - x, target.z - z) || 1;
      const score = distance + site.slope * 80;
      const candidate = {
        x, z,
        tangentX: (target.x - x) / distanceToTarget,
        tangentZ: (target.z - z) / distanceToTarget,
        distance, score,
        anchorX: target.x, anchorZ: target.z, level: target.level,
        lakeId: target.lakeId,
        bodyId: target.bodyId,
        kind: 'lake',
        regionX: target.regionX,
        regionZ: target.regionZ,
      };
      if (!best || candidate.score < best.score
        || (candidate.score === best.score && (candidate.x < best.x
          || (candidate.x === best.x && candidate.z < best.z)))) best = candidate;
      // The first safe dry point after the water is the shore for this ray.
      break;
    }
  }
  return best;
}

/**
 * Find a deterministic, dry, lake-owned shoreline viewpoint.
 *
 * `contains` should be the active HydrologyStream.contains callback when the
 * caller has a streamed window. The callback is checked for both the lake
 * anchor and the returned shore, so a loaded descriptor cannot move startup
 * outside the prepared gameplay window.
 */
export function findLakeShoreSpawn(world, {
  regionX = 0,
  regionZ = 0,
  contains = null,
  maxDistance = DEFAULT_MAX_DISTANCE,
} = {}) {
  const field = world?.waterField;
  if (!field || world.generationVersion !== 3 || !Number.isSafeInteger(regionX)
    || !Number.isSafeInteger(regionZ) || !Number.isFinite(maxDistance)
    || maxDistance < RAY_STEP || maxDistance > 4096) return null;
  const inWindow = normalizeContains(contains);
  const targets = [];
  for (const plan of field.plans || []) {
    if (!plan || plan.regional !== 1 || !Number.isSafeInteger(plan.regionX)
      || !Number.isSafeInteger(plan.regionZ)) continue;
    const centerRegion = plan.regionX === regionX && plan.regionZ === regionZ;
    for (const body of plan.basins || []) {
      if (body?.kind !== 'lake' || !validPoint(body.centerX, body.centerZ)) continue;
      const anchor = denseLakeAnchor(body);
      if (!anchor) continue;
      targets.push({
        id: body.id, lakeId: body.id, bodyId: body.id, ...anchor,
        regionX: plan.regionX, regionZ: plan.regionZ, centerRegion,
      });
    }
    for (const mesh of plan.components || []) {
      if (!mesh?.basinIds?.length) continue;
      const bodyId = componentBodyId(mesh);
      for (const anchor of componentLakeAnchors(mesh)) {
        const levelKey = anchor.level.toFixed(6);
        const lakeId = mesh.basinIds.length === 1
          ? mesh.basinIds[0] : `${mesh.hash}:${levelKey}`;
        targets.push({
          id: `${mesh.hash}:${levelKey}`, lakeId, basinIds: [...mesh.basinIds], bodyId, ...anchor,
          regionX: plan.regionX, regionZ: plan.regionZ, centerRegion,
        });
      }
    }
  }
  targets.sort(targetSort);
  for (const target of targets) {
    const spawn = shoreForTarget(world, target, inWindow, maxDistance);
    if (spawn) return spawn;
  }
  return null;
}

// Recheck the exact selected bank after changing the stream window. Picking a
// different lake after every recenter can otherwise send startup in a loop.
export function validateLakeShoreSpawn(world, spawn, contains = () => true) {
  if (!spawn || !validPoint(spawn.anchorX, spawn.anchorZ)
    || !contains(spawn.x, spawn.z, 256)) return false;
  const target = { bodyId: spawn.bodyId, level: spawn.level };
  if (!ownedLakeWater(world.riverAt(spawn.anchorX, spawn.anchorZ), target)) return false;
  let lastWet = 0;
  for (let distance = RAY_STEP; distance < spawn.distance; distance += RAY_STEP) {
    const info = world.riverAt(spawn.anchorX - spawn.tangentX * distance,
      spawn.anchorZ - spawn.tangentZ * distance);
    if (ownedLakeWater(info, target, true)) lastWet = distance;
    else if (info?.wet) return false;
  }
  const site = world.biomeAt(spawn.x, spawn.z);
  return !world.riverAt(spawn.x, spawn.z)?.wet && spawn.distance - lastWet <= MAX_SHORE_GAP
    && Number.isFinite(site?.h) && site.h > spawn.level + SHORE_HEIGHT
    && Number.isFinite(site?.slope) && site.slope < SHORE_MAX_SLOPE;
}

/** Prepare a lake shore and its walking window before constructing the scene. */
export async function prepareLakeShoreSpawn(world, stream, { onProgress = () => {} } = {}) {
  const originX = stream?.active?.regionX ?? 0, originZ = stream?.active?.regionZ ?? 0;
  const contains = (x, z, margin) => !stream || stream.contains(x, z, margin);
  const install = async (regionX, regionZ) => {
    if (stream.active?.regionX === regionX && stream.active?.regionZ === regionZ) return;
    onProgress('Preparing the terrain around your lake…');
    const window = await stream.initialize(regionX, regionZ);
    stream.commit(window);
    if (window.preparedField) world.installWaterField(window.preparedField);
    else world.installWaterPlans(window.plans);
  };
  // Most starts find a shore in the first nine accepted regions. A bounded
  // outward search also handles ocean-dominated and steep initial windows.
  const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const previousProgress = stream?.onProgress;
  if (stream) stream.onProgress = progress => onProgress(
    `Preparing your lakeshore… ${progress.completed} of ${progress.total} surrounding areas prepared.`);
  try {
    for (const [dx, dz] of offsets) {
      if ((dx || dz) && !stream) break;
      if (dx || dz) await install(originX + dx, originZ + dz);
      const spawn = findLakeShoreSpawn(world, {
        regionX: stream?.active?.regionX ?? originX,
        regionZ: stream?.active?.regionZ ?? originZ, contains,
      });
      if (!spawn) continue;
      const regionX = Math.floor(spawn.x / BASIN_REGION_SIZE);
      const regionZ = Math.floor(spawn.z / BASIN_REGION_SIZE);
      if (stream && (regionX !== stream.active.regionX || regionZ !== stream.active.regionZ)) {
        await install(regionX, regionZ);
      }
      if (validateLakeShoreSpawn(world, spawn, contains)) return spawn;
    }
    throw new Error('No safe lake shore found in the surrounding landscape');
  } finally {
    if (stream) stream.onProgress = previousProgress;
  }
}
