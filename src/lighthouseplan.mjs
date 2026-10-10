import { createBuildingPlan, buildingWorldPoint } from './buildingplan.mjs';
import { collisionSegmentsForBuilding } from './structurecollision.mjs';
import { interiorFurnitureSegments } from './interiorplan.mjs';

const TAU = Math.PI * 2;
const angleDistance = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
export function lighthouseWorldPoint(plan, x, y, z) {
  const c = Math.cos(plan.yaw), s = Math.sin(plan.yaw);
  return { x: plan.x + x * c + z * s, y: plan.y + y, z: plan.z - x * s + z * c };
}
export function lighthouseLocalPoint(plan, point) {
  const dx = point.x - plan.x, dz = point.z - plan.z, c = Math.cos(plan.yaw), s = Math.sin(plan.yaw);
  return { x: dx * c - dz * s, y: point.y - plan.y, z: dx * s + dz * c };
}
export function lighthouseRadiusAt(plan, y) {
  const t = Math.max(0, Math.min(1, (y - plan.shaftY) / plan.height));
  return plan.baseRadius + (plan.topRadius - plan.baseRadius) * t;
}
export function lighthouseGalleryContains(plan, x, z) {
  const r = Math.hypot(x, z), angle = Math.atan2(z, x);
  if (r > plan.galleryRadius || r < plan.lampRadius) return false;
  const back = ((plan.stairEndAngle - angle) % TAU + TAU) % TAU;
  return r > plan.stairs.at(-1).outerR + 0.12 || back > plan.galleryHoleAngle;
}

// The old foundation sampling and lamp dimensions deliberately remain exact.
// Architecture gets its own width/clearance; the beacon keeps its old anchor.
export function createLighthousePlan(lm, ground = () => 0) {
  const height = lm.towerH || 26, legacyBaseRadius = Math.max(2.9, height * 0.13);
  const legacyTopRadius = legacyBaseRadius * 0.6;
  let gmin = ground(0, 0);
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * TAU;
    gmin = Math.min(gmin, ground(Math.cos(a) * (legacyBaseRadius + 1.4), Math.sin(a) * (legacyBaseRadius + 1.4)));
  }
  const baseY = gmin - 1.3, shaftY = baseY + 2.6;
  const topRadius = Math.max(2.65, legacyTopRadius + 0.75), baseRadius = Math.max(legacyBaseRadius + 0.75, topRadius + 0.6);
  const houseX = -(baseRadius + 5 - 0.24), houseWidth = 8.4, houseDepth = 10;
  let floorY = shaftY + 0.02;
  for (const x of [-1, -.5, 0, .5, 1]) for (const z of [-1, -.5, 0, .5, 1]) {
    floorY = Math.max(floorY, ground(houseX + x * houseDepth / 2, z * houseWidth / 2) + 0.2);
  }
  for (const x of [-baseRadius, -baseRadius / 2, 0, baseRadius / 2, baseRadius])
    for (const z of [-baseRadius / 2, 0, baseRadius / 2]) floorY = Math.max(floorY, ground(x, z) + 0.2);
  const rawHouse = createBuildingPlan({ id: `${lm.key}:keeper-house`, program: 'dwelling', seed: lm.seed,
    x: houseX, y: floorY - 0.16, z: 0, yaw: -Math.PI / 2,
    form: { width: houseWidth, depth: houseDepth, floorCount: 1, wall: 'stone', roofMaterial: 'slate',
      roofKind: 'gable', backDoor: { x: 0 }, style: { porch: false, extension: false, chimney: true, timberFrame: false } } });
  const house = { ...rawHouse, masses: rawHouse.masses.filter(m => m.role === 'core'),
    portals: rawHouse.portals.map(p => ['back-door', 'exterior-door'].includes(p.kind) ? { ...p, width: 1.45 } : p) };
  house.interior = { ...house.interior, portals: house.portals };
  const galleryY = shaftY + height + 0.55, pitch = 3.3;
  const steps = Math.max(24, Math.ceil((galleryY - floorY) / 0.16));
  const rise = (galleryY - floorY) / steps, stepAngle = rise / pitch * TAU, startAngle = Math.PI;
  const stairs = Array.from({ length: steps }, (_, i) => {
    const y = floorY + rise * (i + 1), a0 = startAngle + i * stepAngle;
    return { id: `${lm.key}:stair:${i}`, y, a0, a1: a0 + stepAngle, innerR: 0.6,
      outerR: Math.min(baseRadius - 0.32, lighthouseRadiusAt({ height, shaftY, baseRadius, topRadius }, y) - 0.32) };
  });
  const frontX = houseX - houseDepth / 2, rampLength = Math.max(4, (floorY - ground(frontX - 1, 0)) * 4 + 1);
  const ramp = { x0: frontX - rampLength, x1: frontX + 0.18, width: 1.65,
    y0: ground(frontX - rampLength, 0) + 0.04, y1: floorY };
  const plan = { id: lm.key, seed: lm.seed, x: lm.x || 0, y: lm.y || 0, z: lm.z || 0, yaw: lm.yaw || 0,
    height, legacyBaseRadius, legacyTopRadius, baseY, shaftY, baseRadius, topRadius, floorY, galleryY,
    galleryRadius: topRadius + 0.85, lampY: galleryY + 1, lampRadius: legacyTopRadius * 0.62,
    stairs, rise, pitch, stepAngle, stairEndAngle: stairs.at(-1).a1, galleryHoleAngle: 2.55 / pitch * TAU,
    house, ramp, doorWidth: 1.65, doorHeight: 2.35 };
  const hp = lighthouseWorldPoint(plan, house.x, house.y, house.z);
  plan.worldHouse = { ...house, ...hp, yaw: plan.yaw + house.yaw };
  plan.site = { id: lm.key };
  plan.buildings = [plan.worldHouse];
  return plan;
}

export function lighthouseWalkableClaims(plan) {
  const claim = (id, y, contains, kind = 'floor') => ({ id: `${plan.id}:${id}`, y: plan.y + y, kind,
    contains(x, z) { const p = lighthouseLocalPoint(plan, { x, y: 0, z }); return contains(p.x, p.z); } });
  const h = plan.house;
  const claims = [claim('ground-floor', plan.floorY, (x, z) =>
    Math.hypot(x, z) <= plan.baseRadius - 0.14 || Math.abs(x - h.x) <= h.depth / 2 + 0.2 && Math.abs(z) <= h.width / 2 + 0.12),
  claim('gallery', plan.galleryY, (x, z) => lighthouseGalleryContains(plan, x, z))];
  for (const [i, step] of plan.stairs.entries()) claims.push(claim(`tread:${i}`, step.y, (x, z) => {
    const a = angleDistance(Math.atan2(z, x), (step.a0 + step.a1) / 2), r = Math.hypot(x, z);
    return Math.abs(a) <= plan.stepAngle / 2 + 0.003 && r >= step.innerR && r <= step.outerR;
  }, 'steps'));
  const r = plan.ramp, a = lighthouseWorldPoint(plan, r.x0, r.y0, 0), b = lighthouseWorldPoint(plan, r.x1, r.y1, 0);
  claims.push({ id: `${plan.id}:entrance-ramp`, kind: 'steps', mode: 'ramp', ax: a.x, az: a.z, ay: a.y,
    bx: b.x, bz: b.z, by: b.y, width: r.width });
  return claims;
}

export function lighthouseCollisionSegments(plan) {
  const out = [...collisionSegmentsForBuilding(plan.worldHouse), ...interiorFurnitureSegments(plan.worldHouse)];
  const add = (id, ax, az, bx, bz, minY, maxY, thickness = 0.08) => {
    const a = lighthouseWorldPoint(plan, ax, minY, az), b = lighthouseWorldPoint(plan, bx, maxY, bz);
    out.push({ id: `${plan.id}:${id}`, ax: a.x, az: a.z, bx: b.x, bz: b.z, minY: a.y, maxY: b.y, thickness });
  };
  const circle = (id, r, minY, maxY, thickness, skip = () => false) => {
    for (let i = 0; i < 64; i++) {
      const a0 = i / 64 * TAU, a1 = (i + 1) / 64 * TAU;
      if (!skip((a0 + a1) / 2)) add(`${id}:${i}`, Math.cos(a0) * r, Math.sin(a0) * r,
        Math.cos(a1) * r, Math.sin(a1) * r, minY, maxY, thickness);
    }
  };
  // Height slices follow the taper rather than blocking the staircase with a
  // single full-height cylinder of the wider ground-floor radius.
  const levels = [plan.shaftY, plan.floorY, plan.floorY + plan.doorHeight, plan.shaftY + plan.height];
  for (let y = plan.shaftY; y < plan.shaftY + plan.height; y += 0.8) levels.push(y);
  const ys = [...new Set(levels)].sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) {
    const y0 = ys[i - 1], y1 = ys[i], maxY = y1 <= plan.floorY ? Math.min(y1, plan.floorY - .22) : y1;
    if (maxY <= y0) continue;
    const r = lighthouseRadiusAt(plan, (y0 + y1) / 2) - 0.12;
    circle(`wall:${i}`, r, y0, maxY, 0.24, a => y0 >= plan.floorY - .001 && y1 <= plan.floorY + plan.doorHeight + .001
      && Math.abs(angleDistance(a, Math.PI)) < Math.asin(plan.doorWidth / (2 * r)) + TAU / 128);
  }
  circle('gallery-rail', plan.galleryRadius - 0.07, plan.galleryY - 0.08, plan.galleryY + 1.1, 0.08);
  circle('lamp-guard', plan.lampRadius + 0.06, plan.galleryY - 0.05, plan.lampY + 1, 0.08);
  circle('newel', .19, plan.floorY, plan.galleryY, .1);
  for (const [i, step] of plan.stairs.entries()) {
    for (const [side, r] of [['inner', step.innerR], ['outer', step.outerR]]) {
      if (side === 'outer' && i < 2) continue; // land-side entry into the first treads
      add(`stair-rail:${side}:${i}`, Math.cos(step.a0) * r, Math.sin(step.a0) * r,
        Math.cos(step.a1) * r, Math.sin(step.a1) * r, step.y - .12, step.y + 1.0, .055);
    }
  }
  const last = plan.stairs.at(-1), holeStart = plan.stairEndAngle - plan.galleryHoleAngle;
  const n = Math.ceil(plan.galleryHoleAngle / .1);
  for (let i = 0; i < n; i++) {
    const a = holeStart + i / n * plan.galleryHoleAngle, b = holeStart + (i + 1) / n * plan.galleryHoleAngle, r = last.outerR + .12;
    add(`stairwell-guard:${i}`, Math.cos(a) * r, Math.sin(a) * r, Math.cos(b) * r, Math.sin(b) * r,
      plan.galleryY - .08, plan.galleryY + 1, .055);
  }
  add('stairwell-end-guard', Math.cos(holeStart) * last.innerR, Math.sin(holeStart) * last.innerR,
    Math.cos(holeStart) * (last.outerR + .12), Math.sin(holeStart) * (last.outerR + .12), plan.galleryY - .08, plan.galleryY + 1, .055);
  return out;
}

export function lighthouseLightingSources(plan) {
  const sources = [];
  for (const room of plan.worldHouse.rooms) {
    const p = buildingWorldPoint(plan.worldHouse, room.bounds.maxX - .35, (room.bounds.minZ + room.bounds.maxZ) / 2);
    sources.push({ x: p.x, y: plan.y + plan.floorY + 1.45, z: p.z });
  }
  for (let y = plan.floorY + 1.5; y < plan.galleryY - 1; y += plan.pitch) {
    const r = lighthouseRadiusAt(plan, y) - .4, a = -Math.PI / 2 + (y - plan.floorY - 1.5) / plan.pitch * TAU;
    sources.push(lighthouseWorldPoint(plan, Math.cos(a) * r, y, Math.sin(a) * r));
  }
  return sources;
}
