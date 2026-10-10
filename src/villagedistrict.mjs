// The village-centre district: what makes the middle of a village packed.
//
// The layout in settlementlayout.mjs gives a station village a square and
// streets, and the plan stands detached houses along them with a few metres of
// open ground between each. That reads as a village from the edge and as a
// field of houses from the middle, because a real village core is not detached
// houses at all: it is terraces sharing their walls, narrow houses fitted into
// the gaps, a second row of plots on lanes behind the streets, and between all
// of them the hedges, walls, gates and clutter that make every plot read as
// somebody's.
//
// This module adds exactly that, AFTER the existing plan is final. Nothing it
// does moves, removes or re-rolls anything the plan already placed: every
// existing building, lane, prop, frontage element and door approach is a
// reservation it has to work around. So a village keeps its civic buildings,
// its streets and its families, and gains a denser middle.
//
// Four techniques, adapted from sakura-crossing's plots.js to this world's era:
//
//   * Plot frames and slot allocation. Every plot gets a frame — along the
//     frontage (u) and out from the door (v) — and its door and gate are
//     reserved first. Props then step outward from their preferred spot until
//     they find a free gap, which is how a frontage carries six to ten things
//     without two of them in the same place.
//   * Shared-wall building types. Terraces of row houses, narrow infill and a
//     community hall: the types that let a core stand shoulder to shoulder.
//   * Full plot boundaries. Hedges built as a solid body with a broken top,
//     dry-stone walls, pales and wattle, with a gate where the door is and
//     stepping stones from one to the other.
//   * Back lanes, alleys and hanging lines. A second row of plots on lanes
//     between the streets, with gutters and posts, and washing lines, bunting
//     and lantern strings strung across all of it.
//
// THREE-free: the plan is asserted in Node and the renderer reads it.

import { createBuildingPlan, buildingWorldPoint } from './buildingplan.mjs';
import { planOpenings } from './buildingopenings.mjs';
import { mulberry32 } from './noise.js';

export const VILLAGE_DISTRICT_VERSION = 1;
export const VILLAGE_DISTRICT_HASH = `district${VILLAGE_DISTRICT_VERSION}`;

// `coreReach` is how far from the square's centre the district extends; the
// rest of the village keeps its open, detached character, which is what makes
// the middle read as the middle.
export const DISTRICT_SPEC = Object.freeze({
  farmstead: Object.freeze({ rural: true, coreReach: 72, squareFront: 8, wellLamps: 1, entranceLamps: 1 }),
  hamlet: Object.freeze({ rural: true, coreReach: 116, squareFront: 10, wellLamps: 2, entranceLamps: 1 }),
  village: Object.freeze({ rural: true, coreReach: 166, squareFront: 11, wellLamps: 3, entranceLamps: 2 }),
  town: Object.freeze({ rural: true, coreReach: 246, squareFront: 11, wellLamps: 4, entranceLamps: 2 }),
  'station-village': Object.freeze({
    coreReach: 86, laneOffset: 30, laneWidth: 3.0, maxRow: 5, streetFront: 4.8, squareFront: 3.4,
  }),
  'station-halt': Object.freeze({
    coreReach: 64, laneOffset: 27, laneWidth: 2.7, maxRow: 4, streetFront: 4.4, squareFront: 3.2,
  }),
});

export function districtSpecFor(kind) {
  return DISTRICT_SPEC[kind] || null;
}

// Programs whose plots get dressed. Civic buildings keep their own frontage:
// a church gets a churchyard wall, but nobody hangs washing outside a school.
const DOMESTIC = new Set(['dwelling', 'row-house', 'infill-house']);
const WORKING = new Set(['inn', 'workshop', 'general-store', 'smithy', 'community-hall']);
const WALLED_CIVIC = new Set(['church', 'school', 'hall']);

// The yard-prop library. `w` runs along the frontage, `d` out from the wall,
// `h` up. `solid` props stop a walker; the rest are stepped round or over, like
// the square's benches. Ages and materials are those of a railway-era village:
// no bins, meters or bicycles — firewood, barrels, carts and drying racks.
export const YARD_PROPS = Object.freeze({
  'water-butt': Object.freeze({ w: 0.62, d: 0.62, h: 1.0, solid: true }),
  bench: Object.freeze({ w: 1.5, d: 0.42, h: 0.48, solid: false }),
  'planter-tub': Object.freeze({ w: 0.62, d: 0.62, h: 0.85, solid: false }),
  pots: Object.freeze({ w: 0.9, d: 0.42, h: 0.55, solid: false }),
  'boot-scraper': Object.freeze({ w: 0.3, d: 0.2, h: 0.3, solid: false }),
  'flower-bed': Object.freeze({ w: 2.2, d: 0.55, h: 0.4, solid: false }),
  'lamp-post': Object.freeze({ w: 0.3, d: 0.3, h: 2.6, solid: true }),
  skep: Object.freeze({ w: 0.62, d: 0.62, h: 1.0, solid: false }),
  barrel: Object.freeze({ w: 0.66, d: 0.66, h: 0.95, solid: true }),
  'barrel-pair': Object.freeze({ w: 1.4, d: 0.7, h: 0.95, solid: true }),
  firewood: Object.freeze({ w: 1.9, d: 0.7, h: 1.15, solid: true }),
  'chopping-block': Object.freeze({ w: 0.9, d: 0.6, h: 0.85, solid: false }),
  handcart: Object.freeze({ w: 2.1, d: 1.15, h: 1.0, solid: true }),
  wheelbarrow: Object.freeze({ w: 1.5, d: 0.62, h: 0.62, solid: false }),
  'drying-rack': Object.freeze({ w: 2.0, d: 0.9, h: 1.7, solid: true }),
  crates: Object.freeze({ w: 1.1, d: 0.62, h: 0.9, solid: true }),
  sacks: Object.freeze({ w: 1.0, d: 0.6, h: 0.55, solid: false }),
  'milk-churns': Object.freeze({ w: 0.9, d: 0.45, h: 0.75, solid: false }),
  washtub: Object.freeze({ w: 1.2, d: 0.7, h: 1.05, solid: false }),
  ladder: Object.freeze({ w: 0.6, d: 0.45, h: 3.2, solid: false }),
  broom: Object.freeze({ w: 0.35, d: 0.3, h: 1.4, solid: false }),
  privy: Object.freeze({ w: 1.25, d: 1.25, h: 2.2, solid: true }),
  'hen-coop': Object.freeze({ w: 1.6, d: 1.0, h: 1.1, solid: true }),
  'veg-rows': Object.freeze({ w: 3.0, d: 2.2, h: 0.5, solid: false }),
  'hay-rick': Object.freeze({ w: 1.6, d: 1.6, h: 1.9, solid: true }),
  'notice-board': Object.freeze({ w: 1.4, d: 0.3, h: 2.0, solid: true }),
});

export const BOUNDARY_KINDS = Object.freeze(['hedge', 'stone-wall', 'pales', 'wattle', 'rail']);

// Low at the front, where a boundary marks a garden; higher at the back, where
// it screens a yard.
const BOUNDARY_HEIGHT = Object.freeze({
  hedge: [0.95, 1.45], 'stone-wall': [0.85, 1.15], pales: [0.9, 1.15], wattle: [0.95, 1.25], rail: [1.0, 1.1],
});
const BOUNDARY_THICKNESS = Object.freeze({
  hedge: 0.62, 'stone-wall': 0.48, pales: 0.12, wattle: 0.16, rail: 0.12,
});

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// --- geometry ---------------------------------------------------------------

/**
 * An oriented rectangle in world space from a building-local box.
 *
 * Local +x maps to world (cos yaw, -sin yaw) and local +z to (sin yaw, cos yaw)
 * — the convention buildingWorldPoint uses, so a door at local +z is where the
 * plan says it is.
 */
function orientedRect(x, z, yaw, minX, maxX, minZ, maxZ) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const hx = (maxX - minX) / 2, hz = (maxZ - minZ) / 2;
  return {
    x: x + cx * c + cz * s, z: z - cx * s + cz * c,
    ux: c, uz: -s, vx: s, vz: c, hx, hz, r: Math.hypot(hx, hz),
  };
}

function rectsOverlap(a, b, pad) {
  const dx = b.x - a.x, dz = b.z - a.z;
  if (Math.hypot(dx, dz) > a.r + b.r + pad) return false;
  for (const [ax, az] of [[a.ux, a.uz], [a.vx, a.vz], [b.ux, b.uz], [b.vx, b.vz]]) {
    const ra = a.hx * Math.abs(a.ux * ax + a.uz * az) + a.hz * Math.abs(a.vx * ax + a.vz * az);
    const rb = b.hx * Math.abs(b.ux * ax + b.uz * az) + b.hz * Math.abs(b.vx * ax + b.vz * az);
    if (Math.abs(dx * ax + dz * az) >= ra + rb + pad) return false;
  }
  return true;
}

function pointSegmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** Distance from a segment to a rectangle; zero when they touch. */
function segmentRectDistance(seg, rect) {
  const toLocal = (x, z) => {
    const dx = x - rect.x, dz = z - rect.z;
    return [dx * rect.ux + dz * rect.uz, dx * rect.vx + dz * rect.vz];
  };
  const [ax, az] = toLocal(seg.ax, seg.az), [bx, bz] = toLocal(seg.bx, seg.bz);
  // Liang–Barsky against the box: any surviving parameter range is a crossing.
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  let crosses = true;
  for (const [p, q] of [[-dx, ax + rect.hx], [dx, rect.hx - ax], [-dz, az + rect.hz], [dz, rect.hz - az]]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) { crosses = false; break; } continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) { crosses = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { crosses = false; break; } if (r < t1) t1 = r; }
  }
  if (crosses && t0 <= t1) return 0;
  const boxDistance = (x, z) => Math.hypot(Math.max(0, Math.abs(x) - rect.hx), Math.max(0, Math.abs(z) - rect.hz));
  let best = Math.min(boxDistance(ax, az), boxDistance(bx, bz));
  for (const [cx, cz] of [[-rect.hx, -rect.hz], [rect.hx, -rect.hz], [rect.hx, rect.hz], [-rect.hx, rect.hz]]) {
    best = Math.min(best, pointSegmentDistance(cx, cz, ax, az, bx, bz));
  }
  return best;
}

function pointRectDistance(x, z, rect) {
  const dx = x - rect.x, dz = z - rect.z;
  const lx = dx * rect.ux + dz * rect.uz, lz = dx * rect.vx + dz * rect.vz;
  return Math.hypot(Math.max(0, Math.abs(lx) - rect.hx), Math.max(0, Math.abs(lz) - rect.hz));
}

/**
 * Everything already standing, as one queryable set.
 *
 * Rectangles are buildings and solid things, segments are anything you walk
 * along (streets, lanes, door paths, boundaries) with their half-width, and
 * circles are props and frontage elements. Every query takes a `skip` so a
 * plot can test its own yard without colliding with its own house.
 */
class Occupancy {
  constructor() { this.rects = []; this.segs = []; this.circles = []; this.square = null; }

  addRect(rect, tag, kind = 'building') { this.rects.push({ ...rect, tag, kind }); }

  addSegment(ax, az, bx, bz, half, tag, kind = 'road') {
    this.segs.push({
      ax, az, bx, bz, half, tag, kind,
      minX: Math.min(ax, bx) - half, maxX: Math.max(ax, bx) + half,
      minZ: Math.min(az, bz) - half, maxZ: Math.max(az, bz) + half,
    });
  }

  addCircle(x, z, r, tag, kind = 'prop') { this.circles.push({ x, z, r, tag, kind }); }

  /** The first thing `rect` touches with `pad` clear metres, or null. */
  rectHit(rect, { pad = 0, segPad = pad, skip = null, kinds = null } = {}) {
    const take = (item) => (!skip || !skip(item)) && (!kinds || kinds.has(item.kind));
    for (const other of this.rects) {
      if (take(other) && rectsOverlap(rect, other, pad)) return other;
    }
    const reach = rect.r + segPad;
    for (const seg of this.segs) {
      if (rect.x + reach < seg.minX || rect.x - reach > seg.maxX
        || rect.z + reach < seg.minZ || rect.z - reach > seg.maxZ) continue;
      if (take(seg) && segmentRectDistance(seg, rect) < seg.half + segPad) return seg;
    }
    for (const circle of this.circles) {
      if (Math.hypot(circle.x - rect.x, circle.z - rect.z) > rect.r + circle.r + pad) continue;
      if (take(circle) && pointRectDistance(circle.x, circle.z, rect) < circle.r + pad) return circle;
    }
    if (this.square && (!kinds || kinds.has('square')) && (!skip || !skip({ kind: 'square' }))
      && pointRectDistance(this.square.x, this.square.z, rect) < this.square.radius + pad) return { kind: 'square' };
    return null;
  }

  /** The first thing within `radius` of a point, or null. */
  pointHit(x, z, radius, { skip = null, kinds = null } = {}) {
    const take = (item) => (!skip || !skip(item)) && (!kinds || kinds.has(item.kind));
    for (const other of this.rects) {
      if (Math.hypot(other.x - x, other.z - z) > other.r + radius) continue;
      if (take(other) && pointRectDistance(x, z, other) < radius) return other;
    }
    for (const seg of this.segs) {
      if (x + radius < seg.minX || x - radius > seg.maxX || z + radius < seg.minZ || z - radius > seg.maxZ) continue;
      if (take(seg) && pointSegmentDistance(x, z, seg.ax, seg.az, seg.bx, seg.bz) < seg.half + radius) return seg;
    }
    for (const circle of this.circles) {
      if (take(circle) && Math.hypot(circle.x - x, circle.z - z) < circle.r + radius) return circle;
    }
    if (this.square && (!kinds || kinds.has('square')) && (!skip || !skip({ kind: 'square' }))
      && Math.hypot(this.square.x - x, this.square.z - z) < this.square.radius + radius) return { kind: 'square' };
    return null;
  }
}

const FRONT_KINDS = new Set(['building', 'prop', 'frontage', 'street', 'square']);

function footprintOf(building) {
  return building.footprint || {
    minX: -building.width / 2, maxX: building.width / 2,
    minZ: -building.depth / 2, maxZ: building.depth / 2,
  };
}

function buildingRect(building, margin) {
  const fp = footprintOf(building);
  return orientedRect(building.x, building.z, building.yaw,
    fp.minX - margin, fp.maxX + margin, fp.minZ - margin, fp.maxZ + margin);
}

// --- the planner --------------------------------------------------------------

/**
 * Plan the district for a finished settlement plan.
 *
 * `plan` must already carry its buildings, paths, streets, square, props and
 * family frontages. `fit(input)` terrain-fits a building with its facing held
 * (settlementplan's terrainFittedCandidate), `doorstepFor(building)` returns
 * the flight a raised plot needs, and `foundationMargin` is the plinth's
 * oversail — passed in rather than imported, which keeps this module out of an
 * import cycle with the plan that calls it.
 *
 * Returns null for settlements without a square: scattered homesteads have no
 * middle to densify.
 */
export function planVillageDistrict(plan, {
  heightAt = null, blockedAt = null, fit = null, doorstepFor = null,
  foundationMargin = 0.62, floorSurface = 0.16, style = null, frontageMetadata = null,
} = {}) {
  const site = plan.site;
  const spec = districtSpecFor(site.kind);
  if (!spec || !plan.square) return null;
  const square = plan.square;
  const rng = mulberry32((site.seed ^ 0xd157c7) >>> 0);
  const ground = (x, z) => (heightAt ? heightAt(x, z) : site.y);
  const blocked = (x, z) => (blockedAt ? blockedAt(x, z) : false);
  const coreReach = spec.coreReach;
  const inCore = (x, z, slack = 0) => Math.hypot(x - square.x, z - square.z) <= coreReach + slack;
  const occupancy = new Occupancy();
  occupancy.square = { x: square.x, z: square.z, radius: square.radius };

  // --- what is already there ------------------------------------------------
  for (const building of plan.buildings) occupancy.addRect(buildingRect(building, foundationMargin), building.id, 'building');
  for (const street of plan.streets || []) {
    occupancy.addSegment(square.x, square.z, street.toX, street.toZ, street.width / 2 + 0.4, street.id, 'street');
  }
  const ownPath = new Map();
  for (const path of plan.paths || []) {
    if (typeof path.to === 'string' && path.to.endsWith(':approach')) ownPath.set(path.id, path.to.slice(0, -':approach'.length));
    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1], b = path.points[i];
      occupancy.addSegment(a.x, a.z, b.x, b.z, (path.width || 1.65) / 2, path.id, 'path');
    }
  }
  for (const prop of plan.props || []) {
    occupancy.addCircle(prop.x, prop.z, Math.max(prop.radius || 0, Math.hypot(prop.width || 0, prop.depth || 0) / 2, 0.9), prop.id, 'prop');
  }
  for (const planting of plan.managedVegetation?.placements || []) {
    const half = planting.footprint.halfExtents;
    occupancy.addRect(orientedRect(planting.x, planting.z, planting.yaw, -half.x, half.x, -half.z, half.z), planting.id, 'planting');
  }
  const byId = new Map(plan.buildings.map((building) => [building.id, building]));
  for (const frontage of plan.familyFrontages || []) {
    for (const entry of frontage.yardElements || []) {
      const meta = frontageMetadata ? frontageMetadata(entry.assetId) : null;
      const radius = meta ? Math.hypot(meta.halfExtents.x, meta.halfExtents.z) + 0.25 : 1.4;
      occupancy.addCircle(entry.placement.x, entry.placement.z, radius, frontage.buildingId, 'frontage');
    }
  }
  // Residents walk a ring round their own house. Nothing the district adds may
  // stand in it, or the oldest family on the street wedges itself against a
  // new hedge on its first lap.
  for (const building of plan.buildings) {
    if (building.program !== 'dwelling' || !building.ownerHouseholdId) continue;
    const ex = building.width / 2 + 1.35, ez = building.depth / 2 + 1.35;
    const ring = [[-ex, ez], [-ex, -ez], [0, -ez - 0.5], [ex, -ez], [ex, ez]]
      .map(([x, z]) => buildingWorldPoint(building, x, z));
    for (let i = 1; i < ring.length; i++) {
      occupancy.addSegment(ring[i - 1].x, ring[i - 1].z, ring[i].x, ring[i].z, 0.5, building.id, 'loiter');
    }
  }
  // The ground straight out from every door is a way in; nothing may stand
  // across it, whoever built the door.
  const addDoorway = (building) => {
    const door = building.portals?.find((portal) => portal.kind === 'exterior-door');
    if (!door) return;
    const a = buildingWorldPoint(building, door.x, building.depth / 2 + 0.2);
    const b = buildingWorldPoint(building, door.x, building.depth / 2 + 6.6);
    occupancy.addSegment(a.x, a.z, b.x, b.z, door.width / 2 + 0.45, building.id, 'door');
  };
  for (const building of plan.buildings) addDoorway(building);
  // A raised plot's flight is a way in; nothing may be built across it.
  const flightFor = (building) => (doorstepFor ? doorstepFor(building) : null);
  for (const building of plan.buildings) {
    const flight = flightFor(building);
    if (flight) occupancy.addSegment(flight.ax, flight.az, flight.bx, flight.bz, flight.width / 2 + 0.2, building.id, 'flight');
  }

  const district = {
    version: VILLAGE_DISTRICT_VERSION,
    buildings: [], lanes: [], boundaries: [], posts: [], gates: [], stones: [], gutters: [],
    props: [], windowBoxes: [], lines: [], colliders: [],
    stats: {},
  };
  const newBuildings = district.buildings;
  const footprintBlocked = (building) => {
    const fp = footprintOf(building);
    for (const lx of [fp.minX, 0, fp.maxX]) for (const lz of [fp.minZ, 0, fp.maxZ]) {
      const p = buildingWorldPoint(building, lx, lz);
      if (blocked(p.x, p.z)) return true;
    }
    return false;
  };

  // --- filling a frontage line ------------------------------------------------
  //
  // A line is the FRONT FACE of the buildings it carries: P(t) = O + a·t, with
  // n pointing from the house to the road it fronts. Free stretches are found by
  // sliding a half-metre slab along it; each stretch is then built out as a
  // terrace, a lone infill house, or the community hall.
  const villageStyle = style || {};
  let hallPlaced = false;
  let rowSerial = 0;

  const slabFree = (line, t0, t1, depth) => {
    const a = line, mid = (t0 + t1) / 2;
    const ox = line.ox + a.ax * mid, oz = line.oz + a.az * mid;
    const yaw = Math.atan2(line.nx, line.nz);
    const half = (t1 - t0) / 2;
    // The plot itself, plinth included, plus the strip in front of the door.
    const body = orientedRect(ox, oz, yaw, -half, half, -depth - foundationMargin - 0.6, foundationMargin);
    if (occupancy.rectHit(body, { pad: 0.55, segPad: 0.45 })) return false;
    const front = orientedRect(ox, oz, yaw, -half, half, foundationMargin, foundationMargin + 1.3);
    if (occupancy.rectHit(front, { pad: 0.1, kinds: FRONT_KINDS })) return false;
    for (const [px, pz] of [[0, -depth / 2], [0, 0.4], [0, -depth]]) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      if (blocked(ox + px * c + pz * s, oz - px * s + pz * c)) return false;
    }
    return inCore(ox, oz, 6);
  };

  const freeIntervals = (line, depth) => {
    const step = 0.5, intervals = [];
    let start = null;
    for (let t = line.from; t + step <= line.to + 1e-6; t += step) {
      const free = slabFree(line, t, t + step, depth);
      if (free && start === null) start = t;
      if (!free && start !== null) { intervals.push([start, t]); start = null; }
    }
    if (start !== null) intervals.push([start, line.to]);
    return intervals;
  };

  const fitUnit = (input) => {
    const candidate = fit ? fit(input) : createBuildingPlan({ ...input, y: site.y });
    if (footprintBlocked(candidate)) return null;
    const terrain = candidate.terrainFit;
    // A row tolerates more step than a lone house — a stepped terrace on a
    // hillside is right — but not a door a stride above its own path.
    if (terrain && (terrain.doorStep > 0.42 || terrain.relief > 1.9 || terrain.approachGrade > 0.7)) return null;
    return candidate;
  };

  // A terrace or infill house gets a back door into its yard, beside the
  // outshut, where the ground behind is level with its floor and nothing is
  // built against the back wall. Its yard is then reached through the house,
  // the way people actually go out to the washing line.
  const backDoorFor = (input, y) => {
    if (input.program !== 'row-house' && input.program !== 'infill-house') return null;
    const form = input.form, x = form.doorX || 0;
    const outshut = form.outshut;
    if (outshut && Math.abs(x - outshut.dx) < outshut.width / 2 + 0.75) return null;
    const floor = y + floorSurface;
    const c = Math.cos(input.yaw), s = Math.sin(input.yaw);
    const at = (lz) => ({ x: input.x + x * c + lz * s, z: input.z - x * s + lz * c });
    for (const lz of [-form.depth / 2 - 0.9, -form.depth / 2 - 1.9]) {
      const p = at(lz);
      if (Math.abs(ground(p.x, p.z) - floor) > 0.45) return null;
      if (blocked(p.x, p.z)) return null;
      if (occupancy.pointHit(p.x, p.z, 0.45, { kinds: new Set(['building', 'prop', 'lane', 'street']) })) return null;
    }
    return { x };
  };

  const placeRow = (line, tStart, count, unitWidth, kind, lineRng) => {
    const yaw = Math.atan2(line.nx, line.nz);
    // Which way along the line local +x runs for this facing.
    const localXAlong = Math.sign(line.ax * Math.cos(yaw) - line.az * Math.sin(yaw)) || 1;
    const rowId = `${site.id}:district:row:${rowSerial++}`;
    const program = kind;
    // A square front is shallow: the plots behind it belong to the civic
    // buildings, and a terrace there is a single depth of rooms with no yard.
    const shallow = !!line.shallow;
    const depth = kind === 'row-house' ? (shallow ? 6.3 + lineRng() * 0.6 : 6.6 + lineRng() * 1.2)
      : kind === 'infill-house' ? (shallow ? 6.8 + lineRng() * 0.6 : 7.2 + lineRng() * 1.4) : 7.6 + lineRng() * 0.6;
    // One shared form for the whole row: the wall, roof and storeys a terrace
    // was built with. Rolled from a probe unit so the village's own fabric bias
    // still decides it.
    const probe = createBuildingPlan({
      id: `${rowId}:probe`, program, seed: hashText(rowId), x: 0, y: 0, z: 0, yaw, style: villageStyle,
    });
    const shared = {
      wall: probe.materials.wall, roofMaterial: probe.materials.roof,
      floorCount: kind === 'community-hall' ? 1 : kind === 'infill-house' ? probe.floorCount : 2,
      roofKind: 'gable', pitch: probe.roof.pitch,
      style: {
        timberFrame: probe.style.timberFrame, foundation: probe.style.foundation,
        porch: kind === 'community-hall', chimney: kind !== 'community-hall',
        weathering: probe.style.weathering, windowRhythm: 2.4, extension: false,
      },
    };
    const units = [];
    for (let k = 0; k < count; k++) {
      const tCentre = tStart + unitWidth * (k + 0.5);
      const fx = line.ox + line.ax * tCentre, fz = line.oz + line.az * tCentre;
      const x = fx - line.nx * depth / 2, z = fz - line.nz * depth / 2;
      // Doors in handed pairs: neighbours' doors sit together at the party
      // wall they share, which is how a terrace front is read from the street.
      const handed = kind === 'row-house' ? ((k % 2 === 0) === (localXAlong > 0) ? -1 : 1) : 0;
      const doorX = handed * (unitWidth / 2 - 0.9);
      const outshut = kind === 'row-house' && !shallow && lineRng() < 0.75
        ? { width: unitWidth * 0.52, dx: -handed * unitWidth * 0.22, depth: 2.3 } : null;
      const input = {
        id: `${rowId}:unit:${k}`, program, seed: hashText(`${rowId}:${k}`), x, z, yaw, style: villageStyle,
        form: { ...shared, width: kind === 'community-hall' ? unitWidth : unitWidth, depth, doorX, outshut, district: rowId },
      };
      const fitted = fitUnit(input);
      units.push(fitted ? { input, fitted, tCentre } : null);
    }
    // Split at refused units; each run is a row of its own.
    const runs = [];
    let run = [];
    for (const unit of units) {
      if (unit) run.push(unit); else { if (run.length) runs.push(run); run = []; }
    }
    if (run.length) runs.push(run);
    const placed = [];
    for (const [runIndex, members] of runs.entries()) {
      // Share a floor level where the ground allows. A ridge that steps by four
      // centimetres reads as a mistake; one that steps by a storey on a hill is
      // a terrace that follows its street, so small differences are evened out
      // upward and real ones kept.
      const levels = [];
      let group = [members[0]];
      for (let i = 1; i < members.length; i++) {
        if (Math.abs(members[i].fitted.y - group[0].fitted.y) <= 0.38) group.push(members[i]);
        else { levels.push(group); group = [members[i]]; }
      }
      levels.push(group);
      for (const level of levels) {
        const top = Math.max(...level.map((member) => member.fitted.y));
        for (const member of level) member.y = top;
      }
      const id = runs.length > 1 ? `${rowId}:${runIndex}` : rowId;
      const ordered = members.slice().sort((a, b) => (a.tCentre - b.tCentre) * localXAlong);
      const rise = Math.max(1.3, depth * shared.pitch * 0.34);
      for (const [index, member] of ordered.entries()) {
        const left = ordered[index - 1] || null, right = ordered[index + 1] || null;
        const side = (neighbour) => ({
          shared: !!neighbour,
          // A gable shows wherever this unit stands above its neighbour, or
          // at the end of the row.
          gable: !neighbour || neighbour.y < member.y - 0.02,
          overhang: neighbour ? 0 : 0.45,
        });
        const row = kind === 'row-house' || (kind === 'infill-house' && false)
          ? Object.freeze({
            id, index, count: ordered.length, rise,
            left: Object.freeze(side(left)), right: Object.freeze(side(right)),
          })
          : null;
        const lift = member.y - member.fitted.y;
        const backDoor = backDoorFor(member.input, member.y);
        const planned = (door) => createBuildingPlan({ ...member.input, y: member.y, form: {
          ...member.input.form, ...(row ? { row } : {}), ...(door ? { backDoor: door } : {}),
        } });
        let building = planned(backDoor);
        // A rear wing or outshut built across the doorway closes it again.
        if (backDoor && (building.masses || []).some((mass) => mass.role !== 'core'
          && mass.dz < 0 && Math.abs(backDoor.x - mass.dx) < (mass.width || 0) / 2 + 0.75)) building = planned(null);
        const final = Object.freeze({
          ...building,
          terrainFit: member.fitted.terrainFit,
          padMinTerrain: member.fitted.padMinTerrain,
          foundationDepth: (member.fitted.foundationDepth ?? 0.48) + lift,
        });
        placed.push(final);
      }
    }
    // Commit only units that still clear everything with their real footprint
    // (an outshut reaches further back than the slab test assumed).
    const committed = [];
    for (const building of placed) {
      const rect = buildingRect(building, foundationMargin);
      const mates = new Set(placed.map((b) => b.id));
      if (occupancy.rectHit(rect, { pad: 0.4, segPad: 0.35, skip: (item) => mates.has(item.tag) })) continue;
      committed.push(building);
    }
    // A refused unit in the middle of a row leaves its neighbours claiming a
    // shared wall with nothing; rebuild their row sides from what survived.
    const survivors = new Set(committed.map((b) => b.id));
    const final = committed.map((building) => {
      if (!building.row) return building;
      const mates = committed.filter((b) => b.row?.id === building.row.id)
        .sort((a, b) => a.row.index - b.row.index);
      const at = mates.indexOf(building);
      const left = mates[at - 1], right = mates[at + 1];
      const adjacent = (other) => other && Math.abs(other.row.index - building.row.index) === 1 && survivors.has(other.id);
      const fix = (current, neighbour) => (adjacent(neighbour) ? current
        : Object.freeze({ shared: false, gable: true, overhang: 0.45 }));
      const row = Object.freeze({ ...building.row, left: fix(building.row.left, left), right: fix(building.row.right, right) });
      if (row.left === building.row.left && row.right === building.row.right) return building;
      return Object.freeze({ ...building, row });
    });
    for (const building of final) {
      occupancy.addRect(buildingRect(building, foundationMargin), building.id, 'building');
      const flight = flightFor(building);
      if (flight) occupancy.addSegment(flight.ax, flight.az, flight.bx, flight.bz, flight.width / 2 + 0.2, building.id, 'flight');
      addDoorway(building);
      newBuildings.push(building);
    }
    return final;
  };

  const fillLine = (line, { allowHall = false, maxRow = spec.maxRow } = {}) => {
    const lineRng = mulberry32(hashText(`${site.id}:${line.id}`));
    const placed = [];
    for (const [start, end] of freeIntervals(line, line.shallow ? 7.4 : 9.6)) {
      let t = start + 0.15;
      while (end - t >= 4.8) {
        const remaining = end - t;
        if (allowHall && !hallPlaced && remaining >= 12.4) {
          const width = Math.min(12.6, 11 + lineRng() * 1.6);
          const hall = placeRow(line, t, 1, width, 'community-hall', lineRng);
          if (hall.length) { hallPlaced = true; placed.push(...hall); t += width + 2.2; continue; }
        }
        const unitWidth = 4.8 + lineRng() * 0.7;
        const fits = Math.floor(remaining / unitWidth);
        if (fits >= 2 && lineRng() < 0.86) {
          const target = 2 + Math.floor(lineRng() * (maxRow - 1));
          const count = Math.min(fits, target, maxRow);
          placed.push(...placeRow(line, t, count, unitWidth, 'row-house', lineRng));
          // A ginnel between terraces: the passage through to the yards behind.
          t += count * unitWidth + 1.7 + lineRng() * 0.8;
        } else {
          const width = Math.min(5.8, remaining - 0.1, 4.9 + lineRng() * 0.9);
          if (width < 4.7) break;
          placed.push(...placeRow(line, t, 1, width, 'infill-house', lineRng));
          t += width + 1.6 + lineRng() * 0.9;
        }
      }
    }
    return placed;
  };

  // --- 1. the square ----------------------------------------------------------
  // Straight rows set tangent to the square, facing in. The square keeps its
  // middle: its disc is a reservation, so the rows close it in rather than
  // filling it.
  if (!spec.rural) {
    const radius = square.radius + spec.squareFront;
    const count = Math.max(8, Math.round((Math.PI * 2 * radius) / 15));
    const offset = rng() * Math.PI * 2;
    const order = [...Array(count).keys()];
    // Start the hall's search somewhere seeded, not always at the same bearing.
    const first = Math.floor(rng() * count);
    // Two passes, the second offset by half a line: a free stretch that
    // straddles the join between two straight lines is too short for either,
    // and is picked up whole by the line centred on it.
    for (const i of [...order.map((k) => (k + first) % count), ...order.map((k) => (k + first) % count + 0.5)]) {
      const angle = offset + (i / count) * Math.PI * 2;
      const rx = Math.cos(angle), rz = Math.sin(angle);
      const half = (Math.PI * radius) / count * 1.15;
      fillLine({
        id: `square:${i}`,
        ox: square.x + rx * radius, oz: square.z + rz * radius,
        ax: -rz, az: rx, nx: -rx, nz: -rz,
        from: -half, to: half, shallow: true,
      }, { allowHall: true, maxRow: 3 });
    }
  }

  // --- 2. street infill -----------------------------------------------------
  for (const [s, street] of (spec.rural ? [] : plan.streets || []).entries()) {
    const dirX = Math.cos(street.angle), dirZ = Math.sin(street.angle);
    const normX = -dirZ, normZ = dirX;
    const reach = Math.min(coreReach, Math.hypot(street.toX - square.x, street.toZ - square.z));
    for (const side of [-1, 1]) {
      const offset = street.width / 2 + spec.streetFront;
      fillLine({
        id: `street:${s}:${side}`,
        ox: square.x + normX * side * offset, oz: square.z + normZ * side * offset,
        ax: dirX, az: dirZ, nx: -normX * side, nz: -normZ * side,
        from: square.radius + 2, to: reach,
      });
    }
  }

  // --- 3. back lanes and their row of plots -----------------------------------
  if (!spec.rural) {
    const laneHalf = spec.laneWidth / 2;
    for (const [s, street] of (plan.streets || []).entries()) {
      const dirX = Math.cos(street.angle), dirZ = Math.sin(street.angle);
      const normX = -dirZ, normZ = dirX;
      for (const side of [-1, 1]) {
        const offset = street.width / 2 + spec.laneOffset;
        const at = (t) => ({ x: square.x + dirX * t + normX * side * offset, z: square.z + dirZ * t + normZ * side * offset });
        const ok = [];
        const t0 = square.radius + 6, t1 = coreReach + 8;
        for (let t = t0; t <= t1; t += 2) {
          const p = at(t);
          const free = !blocked(p.x, p.z)
            && !occupancy.pointHit(p.x, p.z, laneHalf + 0.9, {
              kinds: new Set(['building', 'prop', 'frontage', 'street', 'square', 'lane', 'loiter', 'flight']),
            });
          let gentle = true;
          if (free && heightAt) gentle = Math.abs(ground(p.x, p.z) - ground(at(t + 2).x, at(t + 2).z)) / 2 < 0.22;
          ok.push({ t, free: free && gentle });
        }
        // The longest clear run.
        let best = null, startAt = null;
        for (let i = 0; i <= ok.length; i++) {
          if (i < ok.length && ok[i].free) { if (startAt === null) startAt = i; continue; }
          if (startAt !== null) {
            const length = ok[i - 1].t - ok[startAt].t;
            if (!best || length > best.length) best = { from: ok[startAt].t, to: ok[i - 1].t, length };
            startAt = null;
          }
        }
        if (!best || best.length < 24) continue;
        const laneId = `${site.id}:district:lane:${s}:${side > 0 ? 'r' : 'l'}`;
        // A lane needs a way onto the network: an alley through the street's
        // frontage, or its own mouth onto the square.
        const alleys = [];
        const alleyFree = (a, b) => {
          const seg = { ax: a.x, az: a.z, bx: b.x, bz: b.z };
          const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
          const length = Math.hypot(b.x - a.x, b.z - a.z);
          const yaw = Math.atan2(b.x - a.x, b.z - a.z);
          const corridor = orientedRect(mid.x, mid.z, yaw, -1.15, 1.15, -length / 2, length / 2);
          void seg;
          if (occupancy.rectHit(corridor, { pad: 0.3, kinds: new Set(['building', 'prop', 'frontage', 'square', 'flight']) })) return false;
          for (let k = 0; k <= 6; k++) {
            const q = { x: a.x + (b.x - a.x) * k / 6, z: a.z + (b.z - a.z) * k / 6 };
            if (blocked(q.x, q.z)) return false;
          }
          return true;
        };
        for (let t = best.from + 2; t <= best.to - 2 && alleys.length < 2; t += 2) {
          if (alleys.length && t - alleys[0].t < 24) continue;
          const lanePoint = at(t);
          const edge = {
            x: square.x + dirX * t + normX * side * (street.width / 2 + 0.2),
            z: square.z + dirZ * t + normZ * side * (street.width / 2 + 0.2),
          };
          if (alleyFree(lanePoint, edge)) alleys.push({ t, from: lanePoint, to: edge });
        }
        let mouth = null;
        if (best.from <= square.radius + 16) {
          const start = at(best.from);
          const d = Math.hypot(start.x - square.x, start.z - square.z);
          const edge = {
            x: square.x + (start.x - square.x) / d * (square.radius - 0.5),
            z: square.z + (start.z - square.z) / d * (square.radius - 0.5),
          };
          if (alleyFree(start, edge)) mouth = { from: start, to: edge };
        }
        if (!alleys.length && !mouth) continue;
        // Everything from here is provisional: a lane with nothing built on it
        // is a track to nowhere, so if its plots do not take, the lane, its
        // alleys and posts all go with them.
        const mark = {
          lanes: district.lanes.length, gutters: district.gutters.length, posts: district.posts.length,
          buildings: newBuildings.length, rects: occupancy.rects.length, segs: occupancy.segs.length,
          hall: hallPlaced, serial: rowSerial,
        };
        const ends = [at(best.from), at(best.to)];
        const lane = {
          id: laneId, kind: 'back-lane', from: `${laneId}:a`, to: `${laneId}:b`, width: spec.laneWidth,
          points: [], district: true,
        };
        for (let t = best.from; t <= best.to + 1e-6; t += Math.max(2, (best.to - best.from) / Math.ceil((best.to - best.from) / 12))) {
          const p = at(Math.min(t, best.to));
          lane.points.push({ x: p.x, y: ground(p.x, p.z) + 0.035, z: p.z });
        }
        if (lane.points.length < 2) lane.points.push({ x: ends[1].x, y: ground(ends[1].x, ends[1].z) + 0.035, z: ends[1].z });
        district.lanes.push(lane);
        occupancy.addSegment(ends[0].x, ends[0].z, ends[1].x, ends[1].z, laneHalf, laneId, 'lane');
        const connectors = [...alleys.map((alley, k) => ({ ...alley, id: `${laneId}:alley:${k}` })),
          ...(mouth ? [{ ...mouth, id: `${laneId}:mouth` }] : [])];
        for (const alley of connectors) {
          const path = {
            id: alley.id, kind: 'alley', from: `${alley.id}:a`, to: `${alley.id}:b`, width: 1.9, district: true,
            points: [alley.from, alley.to].map((p) => ({ x: p.x, y: ground(p.x, p.z) + 0.035, z: p.z })),
          };
          district.lanes.push(path);
          occupancy.addSegment(alley.from.x, alley.from.z, alley.to.x, alley.to.z, 0.95, alley.id, 'lane');
          // A gutter down the middle of an alley, and a post either side of
          // its mouth to keep carts off the corner.
          district.gutters.push({ id: `${alley.id}:gutter`, width: 0.28, offset: 0, points: path.points });
          const along = { x: alley.to.x - alley.from.x, z: alley.to.z - alley.from.z };
          const len = Math.hypot(along.x, along.z) || 1;
          const px = -along.z / len, pz = along.x / len;
          for (const k of [-1, 1]) {
            const x = alley.to.x + px * k * 1.2 - along.x / len * 0.4, z = alley.to.z + pz * k * 1.2 - along.z / len * 0.4;
            if (!occupancy.pointHit(x, z, 0.25, { kinds: new Set(['building', 'street', 'prop', 'frontage', 'door', 'flight']) })) {
              district.posts.push({ id: `${alley.id}:post:${k}`, kind: 'bollard', x, y: ground(x, z), z, height: 0.95 });
            }
          }
        }
        district.gutters.push({ id: `${laneId}:gutter`, width: 0.34, offset: laneHalf - 0.3, points: lane.points });
        // The second row: plots on the far side of the lane, facing it.
        const front = offset + laneHalf + 3.0;
        const built = fillLine({
          id: `lane:${s}:${side}`,
          ox: square.x + normX * side * front, oz: square.z + normZ * side * front,
          ax: dirX, az: dirZ, nx: -normX * side, nz: -normZ * side,
          from: best.from + 1, to: best.to - 1,
        }, { allowHall: true, maxRow: 4 });
        if (built.length < 2) {
          district.lanes.length = mark.lanes; district.gutters.length = mark.gutters;
          district.posts.length = mark.posts; newBuildings.length = mark.buildings;
          occupancy.rects.length = mark.rects; occupancy.segs.length = mark.segs;
          hallPlaced = mark.hall;
        }
      }
    }
  }

  // --- 4. dressing every plot ---------------------------------------------------
  const allBuildings = [...plan.buildings, ...newBuildings];
  const rowMates = new Map();
  for (const building of newBuildings) {
    if (!building.row) continue;
    const list = rowMates.get(building.row.id) || [];
    list.push(building.id);
    rowMates.set(building.row.id, list);
  }
  const ownSet = (building) => new Set([building.id, ...(building.row ? rowMates.get(building.row.id) : [])]);
  const plots = [];
  for (const building of allBuildings) {
    const dressed = DOMESTIC.has(building.program) || WORKING.has(building.program) || WALLED_CIVIC.has(building.program)
      || spec.rural && ['barn', 'granary'].includes(building.program);
    if (!dressed || !inCore(building.x, building.z, 4)) continue;
    plots.push(building);
  }
  // District plots first: they were planned around the existing ones and their
  // boundaries are the ones that line the new lanes.
  plots.sort((a, b) => Number(!!b.district) - Number(!!a.district) || a.id.localeCompare(b.id));

  const boundaryKindFor = (building) => {
    const key = building.row?.id || building.id;
    const roll = mulberry32(hashText(`${key}:boundary`))();
    if (spec.rural && ['barn', 'granary'].includes(building.program)) return roll < 0.6 ? 'rail' : 'wattle';
    if (WALLED_CIVIC.has(building.program)) return 'stone-wall';
    if (building.materials?.wall === 'stone') return roll < 0.55 ? 'stone-wall' : roll < 0.85 ? 'hedge' : 'wattle';
    return roll < 0.46 ? 'hedge' : roll < 0.7 ? 'pales' : roll < 0.86 ? 'wattle' : roll < 0.95 ? 'stone-wall' : 'rail';
  };

  const stats = { plots: 0, boundaries: 0, props: 0, stones: 0, windowBoxes: 0, lines: 0, frontProps: [] };
  let propSerial = 0;
  for (const building of plots) {
    const own = ownSet(building);
    const isNew = !!building.district;
    const domestic = DOMESTIC.has(building.program);
    const prng = mulberry32(hashText(`${building.id}:plot`));
    const fp = footprintOf(building);
    const door = building.portals.find((portal) => portal.kind === 'exterior-door');
    const yaw = building.yaw;
    const local = (u, v) => buildingWorldPoint(building, u, v);
    const padTop = building.y + floorSurface;
    const margin = foundationMargin;
    // Existing families keep a clear walk round their house.
    const keepOut = building.program === 'dwelling' && building.ownerHouseholdId ? 1.95 : 0;
    const skipOwn = (item) => own.has(item.tag) && (item.kind === 'building' || item.kind === 'loiter' || item.kind === 'flight' || item.kind === 'frontage' || item.kind === 'door')
      || (item.kind === 'path' && ownPath.get(item.tag) === building.id);
    const uMin = building.row?.left?.shared ? fp.minX + 0.05 : fp.minX - (isNew ? 0.9 : 1.6);
    const uMax = building.row?.right?.shared ? fp.maxX - 0.05 : fp.maxX + (isNew ? 0.9 : 1.6);

    // How deep the yard runs before it meets something: a road, a lane, a
    // neighbour, the square.
    const probe = (fromV, direction, max) => {
      for (let v = 0; v < max; v += 0.3) {
        const a = fromV + direction * v, b = a + direction * 0.3;
        const strip = orientedRect(building.x, building.z, yaw, uMin, uMax, Math.min(a, b), Math.max(a, b));
        if (occupancy.rectHit(strip, { pad: 0.05, segPad: 0.05, skip: skipOwn })) return v;
        const mid = local((uMin + uMax) / 2, (a + b) / 2);
        if (blocked(mid.x, mid.z)) return v;
      }
      return max;
    };
    const frontStart = fp.maxZ + margin;
    const backStart = fp.minZ - margin;
    const frontYard = probe(frontStart, 1, isNew ? 4.2 : 4.6);
    const backYard = probe(backStart, -1, 11);
    stats.plots++;

    // --- boundaries ---------------------------------------------------------
    const kind = boundaryKindFor(building);
    const [lowH, highH] = BOUNDARY_HEIGHT[kind];
    const thickness = BOUNDARY_THICKNESS[kind];
    const boundaryHits = (x, z) => occupancy.pointHit(x, z, thickness / 2 + 0.3, {
      skip: (item) => item.tag === building.id && (item.kind === 'building' || item.kind === 'door'),
    }) || blocked(x, z);
    const runBoundary = (u0, v0, u1, v1, height, role, gate = null) => {
      // Sampled along its length and cut wherever it would cross a road, a
      // path, a prop or another building; a run shorter than 0.8 m is a stub,
      // not a boundary, and is dropped.
      const length = Math.hypot(u1 - u0, v1 - v0);
      if (length < 0.8) return;
      const steps = Math.max(2, Math.ceil(length / 0.25));
      let runStart = null;
      const emit = (sa, sb) => {
        const ta = sa / steps, tb = sb / steps;
        const ua = u0 + (u1 - u0) * ta, va = v0 + (v1 - v0) * ta;
        const ub = u0 + (u1 - u0) * tb, vb = v0 + (v1 - v0) * tb;
        if (Math.hypot(ub - ua, vb - va) < 0.8) return;
        const a = local(ua, va), b = local(ub, vb);
        const ya = ground(a.x, a.z), yb = ground(b.x, b.z);
        const record = {
          id: `${building.id}:boundary:${district.boundaries.length}`, kind, role, buildingId: building.id,
          ax: a.x, az: a.z, ay: ya, bx: b.x, bz: b.z, by: yb, height, thickness,
          seed: hashText(`${building.id}:${district.boundaries.length}`),
        };
        district.boundaries.push(record);
        occupancy.addSegment(a.x, a.z, b.x, b.z, thickness / 2 + 0.05, building.id, 'boundary');
        district.colliders.push({
          id: `${record.id}:collision`, ax: a.x, az: a.z, bx: b.x, bz: b.z,
          minY: Math.min(ya, yb) - 0.3, maxY: Math.max(ya, yb) + height, thickness,
        });
        stats.boundaries++;
      };
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const u = u0 + (u1 - u0) * t, v = v0 + (v1 - v0) * t;
        let free = !(gate && Math.abs(u - gate.u) < gate.half && Math.abs(v - gate.v) < 0.5);
        if (free) { const p = local(u, v); free = !boundaryHits(p.x, p.z); }
        if (free && runStart === null) runStart = i;
        if ((!free || i === steps) && runStart !== null) { emit(runStart, free ? i : i - 1); runStart = null; }
      }
    };
    const fronting = frontYard >= 1.4;
    // Wide enough for a walker between the ends of a hedge a body thick.
    const gateHalf = Math.max(0.65, (door?.width || 1) / 2 + 0.15) + thickness / 2 + 0.14;
    const frontLine = frontStart + frontYard - 0.35;
    const civic = WALLED_CIVIC.has(building.program);
    const squareFacing = Math.hypot(local(0, fp.maxZ + 3).x - square.x, local(0, fp.maxZ + 3).z - square.z) < square.radius + spec.squareFront - 1;
    // A row facing the square leaves its fronts open to it: a terrace on a
    // square is a street front, not a garden.
    if (fronting && door && !squareFacing && (prng() < (isNew ? 0.92 : 0.7) || civic)) {
      const gate = { u: door.x, v: frontLine, half: gateHalf };
      runBoundary(uMin, frontLine, uMax, frontLine, lowH, 'front', gate);
      // Gate posts and a leaf standing open into the garden.
      for (const k of [-1, 1]) {
        const p = local(door.x + k * (gateHalf + 0.05), frontLine);
        if (occupancy.pointHit(p.x, p.z, 0.12, { kinds: new Set(['street', 'lane', 'path']) })) continue;
        district.posts.push({
          id: `${building.id}:gatepost:${k}`, kind: kind === 'stone-wall' ? 'pier' : 'gatepost',
          x: p.x, y: ground(p.x, p.z), z: p.z, height: lowH + (kind === 'stone-wall' ? 0.25 : 0.2),
        });
      }
      if (kind !== 'stone-wall' && kind !== 'hedge') {
        const hinge = local(door.x - gateHalf, frontLine);
        district.gates.push({
          id: `${building.id}:gate`, kind, x: hinge.x, y: ground(hinge.x, hinge.z), z: hinge.z,
          yaw: yaw - Math.PI / 2 + 0.55 + prng() * 0.5, width: gateHalf * 2 - 0.1, height: lowH * 0.92,
        });
      }
      // Garden sides, from the front line back to the house.
      if (!building.row || !building.row.left.shared) runBoundary(uMin, frontLine, uMin, frontStart - margin + 0.3, lowH, 'side');
      if (!building.row || !building.row.right.shared) runBoundary(uMax, frontLine, uMax, frontStart - margin + 0.3, lowH, 'side');
      // Between the gardens of a terrace: a short low divider at each party wall.
      if (building.row?.right?.shared && prng() < 0.6) runBoundary(fp.maxX, frontStart, fp.maxX, frontLine, lowH * 0.82, 'divider');
      // Stepping stones from the gate to the door, where nothing else paves it.
      const flight = flightFor(building);
      const startV = frontLine - 0.25, endV = flight ? null : fp.maxZ + margin + 0.25;
      if (endV !== null && startV - endV >= 1.0 && (isNew || prng() < 0.6)) {
        const count = Math.max(2, Math.round((startV - endV) / 0.62));
        for (let i = 0; i < count; i++) {
          const v = endV + (startV - endV) * (i + 0.5) / count;
          const u = door.x + (prng() - 0.5) * 0.24;
          const p = local(u, v);
          district.stones.push({ x: p.x, y: ground(p.x, p.z), z: p.z, r: 0.24 + prng() * 0.07, yaw: prng() * Math.PI });
          stats.stones++;
        }
      }
    }
    if (civic) continue;
    // Back and sides: higher, closing the yard.
    if (backYard >= 2.2) {
      const backLine = backStart - backYard + 0.35;
      const backGate = backYard < 10.5 && prng() < 0.7 ? { u: (prng() - 0.5) * (fp.maxX - fp.minX) * 0.5, v: backLine, half: 0.62 + thickness / 2 + 0.12 } : null;
      runBoundary(uMin, backLine, uMax, backLine, highH, 'back', backGate);
      if (!building.row || !building.row.left.shared) runBoundary(uMin, backLine, uMin, backStart + margin - 0.3, highH, 'side');
      if (!building.row || !building.row.right.shared) runBoundary(uMax, backLine, uMax, backStart + margin - 0.3, highH, 'side');
      if (building.row?.right?.shared) runBoundary(fp.maxX, backStart, fp.maxX, backLine, highH * 0.9, 'divider');
    }

    // --- slot allocation ------------------------------------------------------
    //
    // A band is a strip of the plot at a fixed distance from the wall, with its
    // own list of used intervals along u. A prop asks for a half-width and a
    // preferred u, and steps outward 0.3 m at a time both ways until it finds a
    // gap — Sakura's dressPlot — and is then tested in world space against
    // everything else before it is kept.
    const band = (vCentre, depth, u0, u1, onPlinth, facing) => ({ vCentre, depth, u0, u1, used: [], onPlinth, facing });
    const reserve = (b, from, to) => b.used.push([from, to]);
    const doorHalf = door ? door.width / 2 + 0.4 : 0.6;
    const frontWall = band(fp.maxZ + Math.min(0.31, margin / 2), Math.min(0.55, margin - 0.05), fp.minX + 0.2, fp.maxX - 0.2, true, 0);
    const frontYardBand = fronting && frontYard >= 2.0
      ? band(frontStart + frontYard - 0.95, 0.8, uMin + 0.4, uMax - 0.4, false, 0) : null;
    const backWall = band(fp.minZ - Math.min(0.31, margin / 2), Math.min(0.55, margin - 0.05), fp.minX + 0.2, fp.maxX - 0.2, true, Math.PI);
    const backNear = backYard >= 2.6 ? band(backStart - 0.75 - keepOut * 0.6, 1.2, uMin + 0.35, uMax - 0.35, false, Math.PI) : null;
    const backFar = backYard >= 5.2 ? band(backStart - backYard + 1.25, 1.6, uMin + 0.35, uMax - 0.35, false, 0) : null;
    const backMid = backYard >= 7.5 ? band(backStart - backYard / 2 - 0.2, 2.4, uMin + 0.6, uMax - 0.6, false, 0) : null;
    if (door) {
      reserve(frontWall, door.x - doorHalf, door.x + doorHalf);
      if (frontYardBand) reserve(frontYardBand, door.x - gateHalf - 0.35, door.x + gateHalf + 0.35);
    }
    // The outshut stands in the back wall band.
    for (const mass of building.masses || []) {
      if (mass.role === 'core') continue;
      if (mass.dz < 0) {
        for (const b of [backWall, backNear].filter(Boolean)) {
          if (b.vCentre > mass.dz - mass.depth / 2 - 0.4) reserve(b, mass.dx - mass.width / 2 - 0.3, mass.dx + mass.width / 2 + 0.3);
        }
      }
    }
    // The way out of the back door stays clear.
    const backDoor = building.portals.find((portal) => portal.kind === 'back-door');
    if (backDoor) {
      if (backWall) reserve(backWall, backDoor.x - backDoor.width / 2 - 0.3, backDoor.x + backDoor.width / 2 + 0.3);
      if (backNear) reserve(backNear, backDoor.x - backDoor.width / 2 - 0.15, backDoor.x + backDoor.width / 2 + 0.15);
    }
    const free = (b, u, half) => u - half >= b.u0 - 1e-6 && u + half <= b.u1 + 1e-6
      && !b.used.some(([from, to]) => u + half > from && u - half < to);
    const place = (b, propKind, prefer, { variant = 0, yawOffset = 0 } = {}) => {
      if (!b) return false;
      const def = YARD_PROPS[propKind];
      if (!def || def.d > b.depth + 0.3) return false;
      const half = def.w / 2;
      const span = Math.max(0, (b.u1 - b.u0));
      for (let step = 0; step <= span / 0.3 + 1; step++) {
        for (const sign of step === 0 ? [0] : [-1, 1]) {
          const u = prefer + sign * step * 0.3;
          if (!free(b, u, half)) continue;
          const v = b.onPlinth ? b.vCentre + (b.facing ? 1 : -1) * (b.depth - def.d) / 2 * 0 : b.vCentre;
          const centre = local(u, v);
          const propYaw = yaw + b.facing + yawOffset;
          const rect = orientedRect(centre.x, centre.z, propYaw, -half, half, -def.d / 2, def.d / 2);
          if (occupancy.rectHit(rect, {
            pad: 0.12, segPad: 0.12,
            skip: (item) => (own.has(item.tag) && item.kind === 'building' && b.onPlinth) || (b.onPlinth && item.kind === 'loiter')
              || (item.tag === building.id && item.kind === 'door'),
          })) continue;
          if (blocked(centre.x, centre.z)) continue;
          let y;
          if (b.onPlinth) y = padTop;
          else {
            // Seated low rather than floating: the lowest corner decides.
            const corners = [[-half, -def.d / 2], [half, -def.d / 2], [half, def.d / 2], [-half, def.d / 2]]
              .map(([cu, cv]) => local(u + cu, v + cv));
            const heights = corners.map((p) => ground(p.x, p.z));
            if (Math.max(...heights) - Math.min(...heights) > 0.45) continue;
            y = Math.min(...heights) + 0.01;
          }
          b.used.push([u - half - 0.12, u + half + 0.12]);
          const id = `${building.id}:yard:${propSerial++}`;
          district.props.push({
            id, kind: propKind, buildingId: building.id, x: centre.x, y, z: centre.z, yaw: propYaw,
            w: def.w, d: def.d, h: def.h, variant: variant || (hashText(id) % 5),
          });
          occupancy.addCircle(centre.x, centre.z, Math.hypot(half, def.d / 2) * 0.85, building.id, 'yard');
          // Nothing on the plinth blocks: the ledge round a house is a path,
          // and a water butt you can brush past beats one that walls it.
          if (def.solid && !b.onPlinth) {
            const corners = [[-half, -def.d / 2], [half, -def.d / 2], [half, def.d / 2], [-half, def.d / 2]]
              .map(([lx, lz]) => ({
                x: centre.x + lx * Math.cos(propYaw) + lz * Math.sin(propYaw),
                z: centre.z - lx * Math.sin(propYaw) + lz * Math.cos(propYaw),
              }));
            for (let k = 0; k < 4; k++) {
              const a = corners[k], c = corners[(k + 1) % 4];
              district.colliders.push({ id: `${id}:collision:${k}`, ax: a.x, az: a.z, bx: c.x, bz: c.z, minY: y - 0.2, maxY: y + def.h });
            }
          }
          stats.props++;
          return true;
        }
      }
      return false;
    };

    const side = prng() < 0.5 ? -1 : 1;
    const doorU = door ? door.x : 0;
    const wallSpan = fp.maxX - fp.minX;
    let front = 0;
    // Against the front wall, on the plinth.
    if (door && domestic) {
      if (place(frontWall, prng() < 0.55 ? 'bench' : 'planter-tub', doorU + side * (doorHalf + 0.8))) front++;
      if (place(frontWall, prng() < 0.6 ? 'pots' : 'planter-tub', doorU - side * (doorHalf + 0.5))) front++;
      if (prng() < 0.45 && place(frontWall, 'boot-scraper', doorU + side * (doorHalf + 0.15))) front++;
      if (prng() < 0.55 && place(frontWall, 'water-butt', side > 0 ? fp.minX + 0.4 : fp.maxX - 0.4)) front++;
    } else if (door && building.program === 'community-hall') {
      if (place(frontWall, 'notice-board', doorU + side * (doorHalf + 1.0))) front++;
      if (place(frontWall, 'bench', doorU - side * (doorHalf + 1.3))) front++;
      if (place(frontWall, 'bench', doorU + side * (doorHalf + 3.0))) front++;
    } else if (door) {
      const work = building.program === 'inn' ? ['barrel-pair', 'bench', 'planter-tub'] : ['crates', 'barrel', 'sacks'];
      for (const [k, item] of work.entries()) if (place(frontWall, item, doorU + (k % 2 ? -1 : 1) * (doorHalf + 0.9 + k * 0.6))) front++;
    }
    // In the front garden.
    if (frontYardBand && (domestic || building.program === 'community-hall')) {
      if (place(frontYardBand, 'flower-bed', doorU - side * (wallSpan * 0.3))) front++;
      if (wallSpan > 6 && place(frontYardBand, 'flower-bed', doorU + side * (wallSpan * 0.32))) front++;
      if (prng() < 0.2 && place(frontYardBand, 'skep', doorU + side * (gateHalf + 1.6))) front++;
      if (!spec.rural && prng() < (isNew ? 0.3 : 0.15) && place(frontYardBand, 'lamp-post', doorU + side * (gateHalf + 0.55))) front++;
    }
    // Window boxes under the ground-floor sashes.
    if (domestic || building.program === 'inn') {
      const openings = planOpenings(building, building.width)
        .filter((opening) => opening.glazed !== false && opening.bottom < building.floorHeight && opening.bottom > 0.4)
        .filter((opening) => !door || Math.abs(opening.x - door.x) > (opening.width + door.width) / 2 + 0.12);
      for (const opening of openings) {
        if (prng() > (isNew ? 0.75 : 0.45)) continue;
        const p = local(opening.x, building.depth / 2 + 0.24);
        const lift = (building.masses || []).find((m) => m.role === 'core')?.baseY || 0;
        district.windowBoxes.push({
          id: `${building.id}:windowbox:${district.windowBoxes.length}`,
          x: p.x, y: building.y + lift + opening.bottom - 0.13, z: p.z, yaw, width: opening.width + 0.12,
          seed: hashText(`${building.id}:${opening.x}`),
        });
        stats.windowBoxes++;
        front++;
      }
    }
    stats.frontProps.push(front);

    // The back: the working half of a plot.
    if (domestic) {
      place(backWall, prng() < 0.5 ? 'ladder' : 'broom', fp.minX + wallSpan * (0.25 + prng() * 0.5));
      if (prng() < 0.55) place(backWall, 'washtub', doorU - side * 1.2);
      place(backNear, 'firewood', side * wallSpan * 0.3);
      place(backNear, prng() < 0.5 ? 'chopping-block' : 'barrel', -side * wallSpan * 0.25);
      if (prng() < 0.4) place(backNear, prng() < 0.5 ? 'wheelbarrow' : 'handcart', 0);
      if (backFar) {
        place(backFar, prng() < 0.6 ? 'privy' : 'hen-coop', side * (uMax - uMin) * 0.36);
        if (prng() < 0.5) place(backFar, prng() < 0.5 ? 'skep' : 'drying-rack', -side * (uMax - uMin) * 0.28);
      }
      if (backMid && prng() < 0.75) place(backMid, 'veg-rows', -side * 0.4);
    } else if (building.program === 'inn') {
      place(backNear, 'barrel-pair', -wallSpan * 0.25);
      place(backNear, 'crates', wallSpan * 0.2);
      place(backFar, 'handcart', 0);
      place(backFar, 'hay-rick', wallSpan * 0.3);
    } else if (building.program === 'workshop' || building.program === 'smithy' || building.program === 'general-store') {
      place(backNear, 'firewood', -wallSpan * 0.25);
      place(backNear, 'crates', wallSpan * 0.25);
      place(backFar, 'handcart', 0);
      place(backFar, 'sacks', wallSpan * 0.3);
      if (prng() < 0.5) place(backMid, 'drying-rack', 0);
    } else if (spec.rural && ['barn', 'granary'].includes(building.program)) {
      place(backNear, 'sacks', -wallSpan * 0.25);
      place(backNear, 'barrel', wallSpan * 0.25);
      place(backFar, 'hay-rick', side * wallSpan * 0.25);
      place(backFar, 'handcart', -side * wallSpan * 0.25);
      if (backMid) place(backMid, 'drying-rack', 0);
    }

    // --- the washing line ------------------------------------------------------
    if (domestic && backYard >= 4.4 && prng() < (isNew ? 0.8 : 0.55)) {
      const vNear = backStart - Math.max(1.6, keepOut + 0.3), vFar = backStart - backYard + 0.8;
      let a = null, b = null;
      if (building.row || wallSpan < 6.2) {
        // Down the length of a narrow yard, on the side the outshut does not take.
        const outshut = (building.masses || []).find((m) => m.role === 'lean-to');
        const u = outshut ? (outshut.dx > 0 ? fp.minX + 0.7 : fp.maxX - 0.7) : (side > 0 ? fp.maxX - 0.7 : fp.minX + 0.7);
        const near = outshut ? Math.min(vNear, outshut.dz - outshut.depth / 2 - 1.0) : vNear;
        if (near - vFar >= 2.8) { a = { u, v: near }; b = { u, v: vFar }; }
      } else {
        const v = backStart - Math.min(backYard * 0.55, 4.5);
        if (v - (backStart - backYard) > 1.0) { a = { u: fp.minX + 0.4, v }; b = { u: fp.maxX - 0.4, v }; }
      }
      if (a && b) {
        const pa = local(a.u, a.v), pb = local(b.u, b.v);
        const postFree = (p) => !occupancy.pointHit(p.x, p.z, 0.22, { skip: (item) => item.kind === 'boundary' && item.tag === building.id || (item.kind === 'yard' && false) })
          && !blocked(p.x, p.z);
        if (postFree(pa) && postFree(pb)) {
          const ya = ground(pa.x, pa.z), yb = ground(pb.x, pb.z);
          for (const [k, p, y] of [[0, pa, ya], [1, pb, yb]]) {
            district.posts.push({ id: `${building.id}:linepost:${k}`, kind: 'line-post', x: p.x, y, z: p.z, height: 2.3 });
            occupancy.addCircle(p.x, p.z, 0.2, building.id, 'yard');
          }
          district.lines.push({
            id: `${building.id}:washing`, kind: 'washing',
            ax: pa.x, ay: ya + 2.12, az: pa.z, bx: pb.x, by: yb + 2.12, bz: pb.z,
            sag: 0.22 + Math.hypot(pb.x - pa.x, pb.z - pa.z) * 0.025, seed: hashText(`${building.id}:washing`),
          });
          stats.lines++;
        }
      }
    }
  }

  // --- 5. hanging lines over the streets and round the square ---------------------
  //
  // Bunting across the streets nearest the square, strung eave to eave between
  // houses that face each other; lantern strings round the square on posts.
  // Every one of them is merged into a single draw by the renderer.
  if (!spec.rural) {
    const eave = (building) => building.y + ((building.masses || []).find((m) => m.role === 'core')?.baseY || 0)
      + building.floorCount * building.floorHeight - 0.35;
    for (const [s, street] of (plan.streets || []).entries()) {
      const dirX = Math.cos(street.angle), dirZ = Math.sin(street.angle);
      const normX = -dirZ, normZ = dirX;
      const facing = [];
      for (const building of allBuildings) {
        const dx = building.x - square.x, dz = building.z - square.z;
        const t = dx * dirX + dz * dirZ, across = dx * normX + dz * normZ;
        if (t < square.radius || t > coreReach || Math.abs(across) > street.width / 2 + 16) continue;
        // Facing the street: its door direction points back across it.
        const doorDirX = Math.sin(building.yaw), doorDirZ = Math.cos(building.yaw);
        if ((doorDirX * normX + doorDirZ * normZ) * Math.sign(across) > -0.8) continue;
        facing.push({ building, t, side: Math.sign(across) });
      }
      const left = facing.filter((f) => f.side < 0), right = facing.filter((f) => f.side > 0);
      let last = -Infinity, count = 0;
      for (const l of left.sort((a, b) => a.t - b.t)) {
        if (count >= 3 || l.t - last < 11) continue;
        const r = right.filter((candidate) => Math.abs(candidate.t - l.t) < 4.5)
          .sort((a, b) => Math.abs(a.t - l.t) - Math.abs(b.t - l.t))[0];
        if (!r) continue;
        const t = (l.t + r.t) / 2;
        const anchorOn = (entry) => {
          const b = entry.building;
          // The point on its front face nearest this span's line across the road.
          const target = { x: square.x + dirX * t, z: square.z + dirZ * t };
          const dx = target.x - b.x, dz = target.z - b.z;
          const lx = Math.max(-b.width / 2 + 0.3, Math.min(b.width / 2 - 0.3, dx * Math.cos(b.yaw) - dz * Math.sin(b.yaw)));
          const p = buildingWorldPoint(b, lx, b.depth / 2 + 0.12);
          return { x: p.x, y: eave(b), z: p.z };
        };
        const a = anchorOn(l), b = anchorOn(r);
        const span = Math.hypot(b.x - a.x, b.z - a.z);
        if (span < 6 || span > 32) continue;
        district.lines.push({
          id: `${site.id}:district:bunting:${s}:${count}`, kind: 'bunting',
          ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z,
          sag: 0.5 + span * 0.035, seed: hashText(`${site.id}:bunting:${s}:${count}`),
        });
        stats.lines++;
        last = l.t; count++;
      }
    }

    // Lantern posts just inside the square's edge, clear of the street mouths
    // and of the market.
    const postRadius = square.radius - 1.1;
    const n = Math.max(8, Math.round((Math.PI * 2 * postRadius) / 11));
    const posts = [];
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 + 0.13;
      const x = square.x + Math.cos(angle) * postRadius, z = square.z + Math.sin(angle) * postRadius;
      const nearStreet = (plan.streets || []).some((street) => {
        const delta = Math.abs(Math.atan2(Math.sin(angle - street.angle), Math.cos(angle - street.angle)));
        return delta * postRadius < street.width / 2 + 1.8;
      });
      const nearProp = (plan.props || []).some((prop) => Math.hypot(prop.x - x, prop.z - z) < (prop.radius || 1.2) + 1.6);
      const onPath = occupancy.pointHit(x, z, 0.4, { kinds: new Set(['path', 'lane', 'door', 'flight', 'building']) });
      if (nearStreet || nearProp || onPath || blocked(x, z)) { posts.push(null); continue; }
      const post = { id: `${site.id}:district:lantern-post:${i}`, kind: 'lantern-post', x, y: ground(x, z), z, height: 3.9 };
      district.posts.push(post);
      posts.push(post);
    }
    for (let i = 0; i < n; i++) {
      const a = posts[i], b = posts[(i + 1) % n];
      if (!a || !b) continue;
      district.lines.push({
        id: `${site.id}:district:lanterns:${i}`, kind: 'lanterns',
        ax: a.x, ay: a.y + 3.7, az: a.z, bx: b.x, by: b.y + 3.7, bz: b.z,
        sag: 0.35 + Math.hypot(b.x - a.x, b.z - a.z) * 0.03, seed: hashText(`${site.id}:lanterns:${i}`),
      });
      stats.lines++;
    }
  }

  // Rural lighting is useful and sparse: a few low lamps at the well, plus
  // entrances to the store/inn or farmhouse. These use the normal lantern
  // geometry, bake and capped actor light pool, without festival strings.
  if (spec.rural) {
    const addLamp = (x, z, id) => {
      if (blocked(x, z) || occupancy.pointHit(x, z, 1.0, { skip: item => item.kind === 'square' })) return false;
      if ((plan.props || []).some(prop => Math.hypot(prop.x - x, prop.z - z)
        < Math.max(prop.radius || 0, Math.hypot(prop.width || 0, prop.depth || 0) / 2) + 1.0)) return false;
      district.posts.push({ id, kind: 'lantern-post', x, y: ground(x, z), z, height: 2.8 });
      occupancy.addCircle(x, z, 1.0, id, 'prop');
      return true;
    };
    const radius = square.radius * 0.75;
    for (let lamp = 0; lamp < spec.wellLamps; lamp++) {
      for (let step = 0; step < 48; step++) {
        const angle = site.yaw + (lamp / spec.wellLamps + step / 48) * Math.PI * 2;
        if (addLamp(square.x + Math.cos(angle) * radius, square.z + Math.sin(angle) * radius,
          `${site.id}:district:well-lamp:${lamp}`)) break;
      }
    }
    const entrances = allBuildings.filter(b => ['general-store', 'inn', 'dwelling'].includes(b.program))
      .sort((a, b) => Number(b.program === 'general-store') - Number(a.program === 'general-store')
        || Number(b.program === 'inn') - Number(a.program === 'inn') || a.id.localeCompare(b.id));
    let count = 0;
    for (const building of entrances) {
      if (count >= spec.entranceLamps) break;
      const fp = footprintOf(building);
      let placed = false;
      for (const out of [3.4, 4.8, 6.2]) {
        for (const side of [-1, 1]) {
          const p = buildingWorldPoint(building, side * (building.width / 2 + 1.4), fp.maxZ + out);
          if (addLamp(p.x, p.z, `${building.id}:entrance-lamp`)) { count++; placed = true; break; }
        }
        if (placed) break;
      }
    }
  }

  // Posts are solid, a hand's width each.
  for (const post of district.posts) {
    const r = post.kind === 'pier' ? 0.22 : post.kind === 'bollard' ? 0.16 : 0.1;
    district.colliders.push({
      id: `${post.id}:collision`, ax: post.x - r, az: post.z, bx: post.x + r, bz: post.z,
      minY: post.y - 0.2, maxY: post.y + post.height, thickness: r * 2,
    });
  }

  district.stats = {
    buildings: newBuildings.length,
    rows: new Set(newBuildings.filter((b) => b.row).map((b) => b.row.id)).size,
    infill: newBuildings.filter((b) => b.program === 'infill-house').length,
    halls: newBuildings.filter((b) => b.program === 'community-hall').length,
    lanes: district.lanes.filter((lane) => lane.kind === 'back-lane').length,
    alleys: district.lanes.filter((lane) => lane.kind === 'alley').length,
    ...stats,
    frontProps: undefined,
    meanFrontProps: stats.frontProps.length ? stats.frontProps.reduce((a, b) => a + b, 0) / stats.frontProps.length : 0,
  };
  return district;
}
