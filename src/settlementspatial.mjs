import { settlementForCell, SETTLEMENT_CELL, settlementsAround } from './settlementplacement.mjs';
import { stationSettlements } from './stationsettlement.mjs';
import { createSettlementPlan } from './settlementplan.mjs';
import { STREET_WIDTH_SCALE } from './settlementsurface.mjs';
import { WATER_LEVEL } from './world.js';

// Clear of the running line by more than the widest earthwork shoulder the
// terrain layer blends over, so a house never stands on ground the railway is
// still settling.
export const RAILWAY_BUILD_MARGIN = 20;
// Dry land means comfortably above the water, not merely out of it. A lot that
// clears the surface by a handful of centimetres still reads as a house in a
// puddle once the shoreline moves with the channel.
const DRY_MARGIN = 0.9;

/**
 * Ground no building may stand on, whoever is asking.
 *
 * This has to be ONE function because two different systems build the same
 * settlement independently: the streamer builds the plan it renders, and the
 * vegetation layer builds its own copy to decide where to stop growing grass.
 * When only the streamer knew about blocked ground the two disagreed, and the
 * grass was cleared around buildings that had been moved somewhere else.
 *
 * Water applies everywhere. A settlement is sited on dry ground, but its lots
 * spread far enough to reach a lake shore or a river bend, and nothing until
 * now stopped a house being planted in one.
 */
export function settlementBuildBlocker(world, site) {
  const railway = site?.isStationSettlement ? world.railwayTerrain : null;
  const probe = {};
  return (x, z) => {
    if (world.riverAt(x, z).wet) return true;
    if (world.height(x, z) < WATER_LEVEL + DRY_MARGIN) return true;
    if (!railway) return false;
    railway.clearanceAt(x, z, probe);
    if (probe.station) return true;
    return Number.isFinite(probe.formationDistance) && probe.formationDistance < RAILWAY_BUILD_MARGIN;
  };
}

const planCache = new Map();

export function cachedSettlementPlan(world, site) {
  // The railway signature is part of the key because a station village's lots
  // depend on where the line runs; re-planning the railway must not be served a
  // plan built around the old alignment.
  const rail = site.isStationSettlement ? (world.railwayTerrain?.signature || 'norail') : '';
  const key = `${world.seed}:${site.id}:${site.generationVersion}:${rail}:spatial4`;
  let plan = planCache.get(key);
  if (!plan) {
    plan = createSettlementPlan(site, {
      heightAt: (x, z) => world.height(x, z),
      blockedAt: settlementBuildBlocker(world, site),
    });
    planCache.set(key, plan);
    if (planCache.size > 256) planCache.delete(planCache.keys().next().value);
  }
  return plan;
}

/**
 * The settlement plans whose ground could touch this point.
 *
 * Sourced through `settlementsAround` rather than by walking the grid, so
 * station villages are included and suppressed grid settlements are not. Walking
 * cells directly was what left station villages invisible to the vegetation
 * layer, and grass grew through their houses.
 */
export function settlementPlansNear(world, x, z, radius = 430, out = []) {
  out.length = 0;
  const sites = settlementsAround(world, x, z, world.seed, radius, []);
  for (const site of sites) out.push(cachedSettlementPlan(world, site));
  return out;
}

/**
 * Build every station village's plan up front, while the world is still
 * generating.
 *
 * Laying a village out along streets costs real milliseconds, and without this
 * the bill arrives at first touch — which is inside grass refresh on the main
 * thread, where it reads as a hitch as you walk toward a village. The station
 * villages are a small fixed set, known the moment the railway plan exists, so
 * the work can be done then instead: at world generation, where a pause costs
 * nothing because nobody is walking yet.
 *
 * Grid settlements stay lazy. There are unboundedly many of them across an
 * infinite world, and they are cheap enough to build on demand.
 *
 * The terrain worker keeps its own module instance and so its own cache; it
 * pays its own first-touch cost, but off the main thread, where it delays one
 * chunk rather than dropping a frame.
 */
export function warmStationSettlementPlans(world, seed = world?.seed ?? 1) {
  const sites = stationSettlements(world, seed);
  for (const site of sites) cachedSettlementPlan(world, site);
  return sites.length;
}

export { SETTLEMENT_CELL, settlementForCell };

export function buildingLocalPoint(building, x, z) {
  const dx = x - building.x, dz = z - building.z;
  const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

function rectangleDistance(local, halfW, halfD) {
  const dx = Math.max(Math.abs(local.x) - halfW, 0), dz = Math.max(Math.abs(local.z) - halfD, 0);
  return Math.hypot(dx, dz);
}

function segmentDistance(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
  return Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
}

// The bare ring hugging a building. Small on purpose — this replaced a 6.5m
// apron, and its only job now is that no blade grows through a wall or out of
// the plinth the building stands on.
const BUILDING_BARE_MARGIN = 1.15;
// How far the square and the streets take to give their ground back to the
// grass. Matches the alpha ramp the surface is drawn with, so the blades thin
// out exactly where the dirt does instead of stopping on their own line.
const SURFACE_FEATHER = 4.0;

/**
 * What a settlement does to the ground here, or null for untouched ground.
 *
 * `density` is a MULTIPLIER for grass: 0 where nothing may grow, rising back to
 * 1 across the feather so the edge of a street is a gradient rather than a
 * shave line. `dirt` is how strongly the ground reads as worn earth.
 */
export function settlementGroundAtPlans(plans, x, z) {
  let best = null;
  const consider = (candidate) => {
    if (!best || candidate.dirt > best.dirt) best = candidate;
  };
  for (const plan of plans) {
    for (const building of plan.buildings) {
      const local = buildingLocalPoint(building, x, z);
      // The whole footprint, not the core: a wing or a tower is as solid as the
      // room it is attached to, and grass growing out of one is the same bug.
      const fp = building.footprint;
      const half = fp
        ? { w: Math.max(Math.abs(fp.minX), Math.abs(fp.maxX)), d: Math.max(Math.abs(fp.minZ), Math.abs(fp.maxZ)) }
        : { w: building.width / 2, d: building.depth / 2 };
      const inside = fp
        ? local.x >= fp.minX && local.x <= fp.maxX && local.z >= fp.minZ && local.z <= fp.maxZ
        : Math.abs(local.x) <= half.w && Math.abs(local.z) <= half.d;
      if (inside) {
        return { kind: 'interior', density: 0, buildingId: building.id, settlementId: plan.site.id, dirt: 1 };
      }
      const outside = rectangleDistance(local, half.w, half.d);
      if (outside <= BUILDING_BARE_MARGIN) {
        consider({
          kind: 'building-edge', density: 0, buildingId: building.id,
          settlementId: plan.site.id, dirt: 1 - outside / BUILDING_BARE_MARGIN,
        });
      }
    }

    // The square, as the disc the layout has always treated it as.
    if (plan.square) {
      const radius = plan.square.radius;
      const distance = Math.hypot(x - plan.square.x, z - plan.square.z);
      if (distance <= radius + SURFACE_FEATHER) {
        const past = Math.max(0, distance - radius * 0.82);
        const fade = Math.min(1, past / (radius * 0.18 + SURFACE_FEATHER));
        consider({
          kind: 'square', density: fade, settlementId: plan.site.id, dirt: 1 - fade,
        });
      }
    }

    // The streets, measured from the middle of the square so the surface is one
    // connected thing rather than spokes that stop short of it.
    for (const street of plan.streets || []) {
      const from = plan.square
        ? { x: plan.square.x, z: plan.square.z } : { x: street.fromX, z: street.fromZ };
      const half = (street.width * STREET_WIDTH_SCALE) / 2;
      const distance = segmentDistance(x, z, from, { x: street.toX, z: street.toZ });
      if (distance <= half + SURFACE_FEATHER) {
        const fade = Math.min(1, Math.max(0, distance - half * 0.72) / (half * 0.28 + SURFACE_FEATHER));
        consider({
          kind: 'street', density: fade, streetId: street.id,
          settlementId: plan.site.id, dirt: 1 - fade,
        });
      }
    }

    for (const path of plan.paths) for (let i = 1; i < path.points.length; i++) {
      const distance = segmentDistance(x, z, path.points[i - 1], path.points[i]);
      if (distance <= path.width / 2 + 0.8) {
        const core = Math.max(0, 1 - distance / (path.width / 2 + 0.8));
        consider({ kind: 'path', density: 0, pathId: path.id, settlementId: plan.site.id, dirt: core });
      }
    }
  }
  return best;
}

export function settlementGroundAt(world, x, z) {
  return settlementGroundAtPlans(settlementPlansNear(world, x, z, 430, []), x, z);
}

export function clearSettlementSpatialCache() { planCache.clear(); }
