import { settlementForCell, SETTLEMENT_CELL } from './settlementplacement.mjs';
import { createSettlementPlan } from './settlementplan.mjs';

const planCache = new Map();

export function cachedSettlementPlan(world, site) {
  const key = `${world.seed}:${site.id}:${site.generationVersion}:spatial3`;
  let plan = planCache.get(key);
  if (!plan) {
    plan = createSettlementPlan(site, { heightAt: (x, z) => world.height(x, z) });
    planCache.set(key, plan);
    if (planCache.size > 256) planCache.delete(planCache.keys().next().value);
  }
  return plan;
}

export function settlementPlansNear(world, x, z, radius = 430, out = []) {
  out.length = 0;
  const i0 = Math.floor((x - radius) / SETTLEMENT_CELL), i1 = Math.floor((x + radius) / SETTLEMENT_CELL);
  const j0 = Math.floor((z - radius) / SETTLEMENT_CELL), j1 = Math.floor((z + radius) / SETTLEMENT_CELL);
  for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) {
    const site = settlementForCell(world, ci, cj, world.seed);
    if (site && Math.hypot(site.x - x, site.z - z) < radius + site.radius) out.push(cachedSettlementPlan(world, site));
  }
  return out;
}

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

export function settlementGroundAtPlans(plans, x, z) {
  let best = null;
  for (const plan of plans) {
    for (let buildingIndex = 0; buildingIndex < plan.buildings.length; buildingIndex++) {
      const building = plan.buildings[buildingIndex];
      const local = buildingLocalPoint(building, x, z);
      const inside = Math.abs(local.x) <= building.width / 2 && Math.abs(local.z) <= building.depth / 2;
      if (inside) return { kind: 'interior', density: 0, buildingId: building.id, settlementId: plan.site.id, dirt: 1 };
      const zone = plan.groundZones[buildingIndex];
      const distance = rectangleDistance(local, zone.width / 2, zone.depth / 2);
      if (distance <= 0.01) {
        const edge = Math.min(1, rectangleDistance(local, building.width / 2, building.depth / 2) / 1.5);
        best = { kind: zone.kind, density: 0, buildingId: building.id, settlementId: plan.site.id, dirt: 0.72 + edge * 0.28 };
      }
    }
    for (const path of plan.paths) for (let i = 1; i < path.points.length; i++) {
      const distance = segmentDistance(x, z, path.points[i - 1], path.points[i]);
      if (distance <= path.width / 2 + 0.8) {
        const core = Math.max(0, 1 - distance / (path.width / 2 + 0.8));
        if (!best || core > best.dirt) best = { kind: 'path', density: 0, pathId: path.id, settlementId: plan.site.id, dirt: core };
      }
    }
  }
  return best;
}

export function settlementGroundAt(world, x, z) {
  return settlementGroundAtPlans(settlementPlansNear(world, x, z, 430, []), x, z);
}

export function clearSettlementSpatialCache() { planCache.clear(); }
