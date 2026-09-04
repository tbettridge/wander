import { createBuildingPlan, buildingWorldPoint } from './buildingplan.mjs';
import { layoutSpecFor, planSettlementLayout } from './settlementlayout.mjs';
import { createSettlementProps, propCollisionRadius } from './settlementprops.mjs';
import { mulberry32 } from './noise.js';
import { buildingDisplayName, householdSurname } from './settlementnames.mjs';
import { planFamilyFrontages, FAMILY_FRONTAGE_PLAN_HASH } from './familyfrontageplanner.mjs';
import {
  MANAGED_VEGETATION_PLAN_HASH,
  planManagedVegetationForSettlement,
} from './managedvegetationplanner.mjs';

// Station settlements are deliberately denser than a grid village of similar
// size: a village of 20 buildings spread over a 230 m disc reads as scattered
// homesteads, and the whole point of a place the railway made is that it is
// built up. Roughly 1 building per 6,000 m² against a grid village's 1 per
// 10,000.
const COUNTS = Object.freeze({
  farmstead: [2, 4], hamlet: [5, 9], village: [12, 20], town: [24, 40],
  'station-village': [30, 42], 'station-halt': [14, 20],
});
export const BUILDING_FLOOR_SURFACE = 0.16;
// How far the foundation pad oversails the building it carries. The renderer,
// the walkable claim and the collision walls all read this, so the plinth you
// see, the plinth you stand on and the plinth you bump into are one object.
export const FOUNDATION_MARGIN = 0.5;
// A plinth lower than this is a step up; higher and it is a wall. Below the
// threshold the walkable claim carries the player onto the plot, above it the
// foundation gets sides so they cannot walk into the earth it is made of.
export const FOUNDATION_STEP_UP = 0.65;
// Buried depth beyond whatever the terrain demands. Terrain is sampled, not
// continuous, so a dip between samples can still undercut a pad that only just
// reached the lowest sample.
const FOUNDATION_BURIAL = 0.45;
const PAD_CLEARANCE = 0.035;
const MAX_DOOR_STEP = 0.18;
const MAX_PAD_RELIEF = 2.50;
const MAX_APPROACH_GRADE = 0.55;

// What a station settlement is built out of, in the order it gets built. The
// civic buildings come first so a village always has its church and its school
// even when hostile ground costs it a dozen lots at the end of the list.
//
// Phase 1 sited these on the same phyllotaxis ring as everything else; giving
// them a square to face is Phase 3's job, not this list's.
const STATION_PROGRAMS = Object.freeze([
  'inn', 'church', 'hall', 'school', 'market-hall', 'station-house', 'smithy', 'granary', 'workshop',
]);
const HALT_PROGRAMS = Object.freeze(['inn', 'church', 'hall', 'smithy', 'granary']);

// What a founding reason does to the roster. Substitutions WITHIN the existing
// programs only — no new geometry — but enough that a pilgrim village and a
// quarry village are not built out of the same list in the same order.
//
// `promote` moves a program up the roster; `swap` trades one for another. A
// shrine village keeps two inns because pilgrims have to sleep somewhere, and
// loses the market hall it never needed.
//
// Promotion stops SHORT of the head. The roster is also the order lots are
// offered in, and square frontage runs out on a village with awkward ground —
// so promoting a workshop to first cost one village its church on the square
// entirely. The inn and the church keep the two best lots in every village;
// what the founding reason earns is the next one.
const ORIGIN_ROSTER = Object.freeze({
  shrine: { promote: 'church', swap: ['market-hall', 'inn'] },
  crossroads: { promote: 'inn', swap: ['school', 'inn'] },
  harbour: { promote: 'granary', swap: ['school', 'granary'] },
  quarry: { promote: 'smithy', swap: ['school', 'workshop'] },
  ford: { promote: 'workshop', swap: [null, null] },
  railway: { promote: 'station-house', swap: [null, null] },
  knoll: { promote: 'hall', swap: [null, null] },
  spring: { promote: null, swap: [null, null] },
});

function rosterFor(kind, originKind) {
  const base = kind === 'station-village' ? STATION_PROGRAMS : HALT_PROGRAMS;
  const rule = ORIGIN_ROSTER[originKind];
  if (!rule) return base;
  let roster = base.slice();
  const [from, to] = rule.swap;
  if (from && to) {
    const at = roster.indexOf(from);
    if (at >= 0) roster[at] = to;
  }
  if (rule.promote) {
    const at = roster.indexOf(rule.promote);
    const to = Math.min(2, roster.length - 1);
    if (at > to) {
      const rest = roster.slice(0, at).concat(roster.slice(at + 1));
      roster = [...rest.slice(0, to), rule.promote, ...rest.slice(to)];
    }
  }
  return roster;
}

function programAt(kind, index, originKind = null) {
  if (kind === 'station-village' || kind === 'station-halt') {
    const roster = rosterFor(kind, originKind);
    if (index < roster.length) return roster[index];
    // Past the civic core it is houses, with a workshop every so often so the
    // place still looks like somewhere people work.
    return (index - roster.length) % 9 === 8 ? 'workshop' : 'dwelling';
  }
  if (index === 0) return kind === 'farmstead' ? 'dwelling' : 'inn';
  if (index === 1) return kind === 'farmstead' ? 'barn' : 'hall';
  if (index % 7 === 0) return 'workshop';
  return 'dwelling';
}

/**
 * The half-extents a building actually occupies, wings and towers included.
 *
 * `width`/`depth` are the core — the room you walk into — and stay that way so
 * the interior, its partitions and its floor claim keep working off one
 * rectangle. Everything spatial wants the whole shape instead, which is what
 * this returns. Falls back to the core for plans built before massing existed.
 */
// How tightly a settlement packs.
//
// `reach` is the share of the halo radius that lots actually spread across, and
// `gap` the clear metres demanded between two buildings. A grid village spreads
// to fill its disc because a scatter of homesteads is what it is. A station
// village should not: it grew around a railway, so it wants a built-up middle
// and a short walk from one end to the other, which means a smaller reach and a
// tighter gap rather than simply more buildings.
// `packing` decides how two lots are tested for room. 'loose' compares bounding
// circles — cheap, and hugely conservative for a rectangle: two 9×7 m houses
// need ~18 m between centres before their circles clear, which is why a village
// of forty buildings still read as scattered. 'tight' separates the actual
// oriented rectangles, so `gap` becomes real metres between walls and houses
// can stand along a street the way they do in a place that grew.
//
// Grid settlements stay 'loose' on purpose: they are scattered homesteads, and
// re-spacing every existing one is not what was asked for.
// The reach values are measured rather than guessed: tightening them costs no
// buildings at all — every lot still places — while density more than doubles.
// The radial placer spreads lots evenly over whatever disc it is given, so the
// disc is what decides how built-up the place reads.
const DENSITY = Object.freeze({
  'station-village': { reach: 0.38, gap: 3.5, inner: 9, packing: 'tight' },
  'station-halt': { reach: 0.44, gap: 3.8, inner: 8, packing: 'tight' },
  default: { reach: 0.92, gap: 3.2, inner: 16, packing: 'loose' },
});

function densityFor(kind) {
  return DENSITY[kind] || DENSITY.default;
}

/**
 * Do two buildings leave `gap` clear metres between them?
 *
 * Separating-axis test over the two footprints as oriented rectangles. Four
 * axes suffice for two boxes: if any one of them separates the pair, they do
 * not touch. The gap is applied as half to each side, so it reads as the space
 * a person would walk through rather than a fudge factor.
 */
function lotsClear(a, b, gap) {
  const pad = gap / 2;
  const boxOf = (building) => {
    const fp = halfExtents(building);
    const centre = buildingWorldPoint(building, (fp.minX + fp.maxX) / 2, (fp.minZ + fp.maxZ) / 2);
    const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
    return {
      x: centre.x, z: centre.z,
      hx: (fp.maxX - fp.minX) / 2 + pad, hz: (fp.maxZ - fp.minZ) / 2 + pad,
      ux: { x: c, z: -s }, uz: { x: s, z: c },
    };
  };
  const boxA = boxOf(a), boxB = boxOf(b);
  const extent = (box, axis) =>
    Math.abs((box.ux.x * axis.x + box.ux.z * axis.z)) * box.hx
    + Math.abs((box.uz.x * axis.x + box.uz.z * axis.z)) * box.hz;
  for (const axis of [boxA.ux, boxA.uz, boxB.ux, boxB.uz]) {
    const separation = Math.abs((boxB.x - boxA.x) * axis.x + (boxB.z - boxA.z) * axis.z);
    if (separation > extent(boxA, axis) + extent(boxB, axis)) return true;   // this axis separates them
  }
  return false;
}

function halfExtents(building) {
  const footprint = building.footprint;
  if (footprint) return footprint;
  return {
    minX: -building.width / 2, maxX: building.width / 2,
    minZ: -building.depth / 2, maxZ: building.depth / 2,
    halfWidth: building.width / 2, halfDepth: building.depth / 2,
  };
}

function worldToLocal(building, x, z) {
  const dx = x - building.x, dz = z - building.z;
  const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

function insideBuilding(building, x, z, padding = 0) {
  const p = worldToLocal(building, x, z);
  const fp = halfExtents(building);
  return p.x > fp.minX - padding && p.x < fp.maxX + padding
    && p.z > fp.minZ - padding && p.z < fp.maxZ + padding;
}

/**
 * Is this point inside the building's footprint, padded by `clearance`?
 *
 * Exported for anything that has to keep out of the houses — siting the
 * village's horses, most of all, which would otherwise stand in a front room.
 */
export function pointInsideBuilding(building, x, z, clearance = 0) {
  return insideBuilding(building, x, z, clearance);
}

/** How far the building reaches from its own origin, wings included. */
export function buildingSpan(building) {
  const fp = halfExtents(building);
  return Math.max(
    Math.hypot(fp.minX, fp.minZ), Math.hypot(fp.maxX, fp.minZ),
    Math.hypot(fp.minX, fp.maxZ), Math.hypot(fp.maxX, fp.maxZ),
  );
}

function firstBlockingBuilding(a, b, blockers, padding = 1) {
  const distance = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(2, Math.ceil(distance / 0.45));
  for (let i = 1; i < steps; i++) {
    const t = i / steps, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    const blocked = blockers.find((blocker) => blocker.inside(x, z, padding));
    if (blocked) return blocked;
  }
  return null;
}

function repairRouteCorners(points, blockers, padding = 1.02) {
  const repaired = [points[0]];
  for (let index = 1; index < points.length; index++) {
    const from = repaired[repaired.length - 1], to = points[index];
    const blocker = firstBlockingBuilding(from, to, blockers, padding);
    if (!blocker) { repaired.push(to); continue; }
    const corners = blocker.corners(padding + 0.38)
      .sort((a, b) => (Math.hypot(a.x - from.x, a.z - from.z) + Math.hypot(to.x - a.x, to.z - a.z))
        - (Math.hypot(b.x - from.x, b.z - from.z) + Math.hypot(to.x - b.x, to.z - b.z)));
    const single = corners.find((corner) => !firstBlockingBuilding(from, corner, blockers, padding)
      && !firstBlockingBuilding(corner, to, blockers, padding));
    if (single) { repaired.push(single, to); continue; }
    let pair = null, pairDistance = Infinity;
    for (const a of corners) for (const b of corners) {
      if (a === b || firstBlockingBuilding(from, a, blockers, padding)
        || firstBlockingBuilding(a, b, blockers, padding)
        || firstBlockingBuilding(b, to, blockers, padding)) continue;
      const distance = Math.hypot(a.x - from.x, a.z - from.z)
        + Math.hypot(b.x - a.x, b.z - a.z) + Math.hypot(to.x - b.x, to.z - b.z);
      if (distance < pairDistance) { pair = [a, b]; pairDistance = distance; }
    }
    if (pair) repaired.push(...pair);
    repaired.push(to);
  }
  return repaired;
}

function obstacleCorners(building, padding) {
  const fp = halfExtents(building);
  const x0 = fp.minX - padding, x1 = fp.maxX + padding;
  const z0 = fp.minZ - padding, z1 = fp.maxZ + padding;
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => buildingWorldPoint(building, x, z));
}

/**
 * Everything a lane has to keep out of, as one list.
 *
 * The collision index that actually stops a resident blocks the square's
 * furniture as well as the houses, so a planner that only knew about footprints
 * would route a lane straight through the wellhead — and the resident sent down
 * it grinds against something its route says is not there. The prop geometry
 * here mirrors propSegments() in structurecollision.mjs; the two have to agree
 * about what is solid or the mismatch simply moves rather than closing.
 */
function routeBlockers(buildings, props = []) {
  const blockers = buildings.map((building) => {
    const fp = halfExtents(building);
    return {
      x: building.x, z: building.z,
      reach: Math.hypot(fp.halfWidth, fp.halfDepth),
      inside: (x, z, padding) => insideBuilding(building, x, z, padding),
      corners: (padding) => obstacleCorners(building, padding),
    };
  });
  for (const prop of props) {
    const radius = propCollisionRadius(prop);
    if (!radius) continue;                       // benches stay steppable
    const hx = prop.width ? prop.width / 2 : radius;
    const hz = prop.depth ? prop.depth / 2 : radius;
    const c = Math.cos(prop.yaw), s = Math.sin(prop.yaw);
    const toWorld = (lx, lz) => ({ x: prop.x + lx * c + lz * s, z: prop.z - lx * s + lz * c });
    blockers.push({
      x: prop.x, z: prop.z,
      reach: Math.hypot(hx, hz),
      inside: (x, z, padding) => {
        const dx = x - prop.x, dz = z - prop.z;
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        return Math.abs(lx) < hx + padding && Math.abs(lz) < hz + padding;
      },
      corners: (padding) => [
        [-hx - padding, -hz - padding], [hx + padding, -hz - padding],
        [hx + padding, hz + padding], [-hx - padding, hz + padding],
      ].map(([lx, lz]) => toWorld(lx, lz)),
    });
  }
  return blockers;
}

function createRoutingGrid(site, blockers) {
  const cell = 2.5, margin = 9;
  const minX = Math.min(site.bounds.minX, site.regionalEntrance.x) - margin;
  const minZ = Math.min(site.bounds.minZ, site.regionalEntrance.z) - margin;
  const maxX = Math.max(site.bounds.maxX, site.regionalEntrance.x) + margin;
  const maxZ = Math.max(site.bounds.maxZ, site.regionalEntrance.z) + margin;
  const cols = Math.ceil((maxX - minX) / cell) + 1, rows = Math.ceil((maxZ - minZ) / cell) + 1;
  const blocked = new Uint8Array(cols * rows);
  for (const blocker of blockers) {
    const radius = blocker.reach + 1.5;
    const x0 = Math.max(0, Math.floor((blocker.x - radius - minX) / cell));
    const x1 = Math.min(cols - 1, Math.ceil((blocker.x + radius - minX) / cell));
    const z0 = Math.max(0, Math.floor((blocker.z - radius - minZ) / cell));
    const z1 = Math.min(rows - 1, Math.ceil((blocker.z + radius - minZ) / cell));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      if (blocker.inside(minX + x * cell, minZ + z * cell, 1.2)) blocked[z * cols + x] = 1;
    }
  }
  return { cell, minX, minZ, cols, rows, blocked };
}

function heapPush(heap, item) {
  heap.push(item); let i = heap.length - 1;
  while (i) { const p = (i - 1) >> 1; if (heap[p].f <= item.f) break; heap[i] = heap[p]; i = p; }
  heap[i] = item;
}

function heapPop(heap) {
  const root = heap[0], tail = heap.pop();
  if (heap.length) {
    let i = 0;
    while (true) {
      let child = i * 2 + 1; if (child >= heap.length) break;
      if (child + 1 < heap.length && heap[child + 1].f < heap[child].f) child++;
      if (heap[child].f >= tail.f) break; heap[i] = heap[child]; i = child;
    }
    heap[i] = tail;
  }
  return root;
}

function routeAroundBuildings(from, to, blockers, heightAt, grid) {
  if (!firstBlockingBuilding(from, to, blockers, 1.05)) return [{ ...from }, { ...to }];
  const { cell, minX, minZ, cols, rows, blocked } = grid;
  const cellAt = (point) => ({ x: Math.max(0, Math.min(cols - 1, Math.round((point.x - minX) / cell))), z: Math.max(0, Math.min(rows - 1, Math.round((point.z - minZ) / cell))) });
  const start = cellAt(from), goal = cellAt(to), startId = start.z * cols + start.x, goalId = goal.z * cols + goal.x;
  const g = new Float64Array(cols * rows); g.fill(Infinity); g[startId] = 0;
  const parent = new Int32Array(cols * rows); parent.fill(-1);
  const closed = new Uint8Array(cols * rows), open = [];
  heapPush(open, { id: startId, x: start.x, z: start.z, f: Math.hypot(goal.x - start.x, goal.z - start.z) });
  const directions = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (open.length) {
    const current = heapPop(open); if (closed[current.id]) continue; closed[current.id] = 1;
    if (current.id === goalId) break;
    for (const [dx, dz, cost] of directions) {
      const x = current.x + dx, z = current.z + dz;
      if (x < 0 || z < 0 || x >= cols || z >= rows) continue;
      const id = z * cols + x;
      if ((blocked[id] && id !== goalId) || closed[id]) continue;
      if (dx && dz && ((blocked[current.z * cols + x] && current.z * cols + x !== goalId)
        || (blocked[z * cols + current.x] && z * cols + current.x !== goalId))) continue;
      const ng = g[current.id] + cost;
      if (ng >= g[id]) continue;
      g[id] = ng; parent[id] = current.id;
      heapPush(open, { id, x, z, f: ng + Math.hypot(goal.x - x, goal.z - z) });
    }
  }
  // A grid that cannot connect the two ends is not licence to draw a straight
  // line through whatever stands between them — that is the route a resident
  // then walks face-first into. The corner repair still gets around a single
  // obstruction, and returns the straight line only when nothing is in the way.
  if (parent[goalId] < 0) {
    return repairRouteCorners([{ ...from }, { ...to }], blockers).map((point) => ({
      ...point, y: Number.isFinite(point.y) ? point.y : (heightAt ? heightAt(point.x, point.z) + 0.035 : from.y),
    }));
  }
  const raw = [];
  for (let id = goalId; id !== startId; id = parent[id]) raw.push({ x: minX + (id % cols) * cell, z: minZ + Math.floor(id / cols) * cell });
  raw.push({ ...from }); raw.reverse(); raw[raw.length - 1] = { ...to };
  const smooth = [raw[0]];
  for (let i = 0; i < raw.length - 1;) {
    let next = i + 1;
    for (let j = raw.length - 1; j > i + 1; j--) if (!firstBlockingBuilding(raw[i], raw[j], blockers, 1.02)) { next = j; break; }
    smooth.push(raw[next]); i = next;
  }
  return repairRouteCorners(smooth, blockers).map((point) => ({
    ...point, y: Number.isFinite(point.y) ? point.y : (heightAt ? heightAt(point.x, point.z) + 0.035 : from.y),
  }));
}

function exteriorApproach(building) {
  const portal = building.portals.find((entry) => entry.kind === 'exterior-door');
  const outside = buildingWorldPoint(building, portal.x, building.depth / 2 + 2.1);
  return { key: `${building.id}:approach`, kind: 'door-approach', buildingId: building.id, portalId: portal.id, x: outside.x, y: building.y + BUILDING_FLOOR_SURFACE, z: outside.z };
}

function terrainFitForBuilding(building, heightAt) {
  if (!heightAt) return {
    valid: true, floorY: building.y + BUILDING_FLOOR_SURFACE,
    minTerrain: building.y, maxTerrain: building.y, relief: 0,
    doorStep: BUILDING_FLOOR_SURFACE, approachGrade: 0,
  };
  const heights = [];
  // A five-by-five pad catches the small ridges and gullies that a centre-only
  // sample missed by several metres in the real world seed.
  for (const nz of [-0.48, -0.24, 0, 0.24, 0.48]) {
    for (const nx of [-0.48, -0.24, 0, 0.24, 0.48]) {
      const point = buildingWorldPoint(building, nx * building.width, nz * building.depth);
      heights.push(heightAt(point.x, point.z));
    }
  }
  const portal = building.portals.find((entry) => entry.kind === 'exterior-door');
  const approachHeights = [];
  for (const distance of [0.18, 0.45, 0.8, 1.25, 1.7, 2.1]) {
    const point = buildingWorldPoint(building, portal.x, building.depth / 2 + distance);
    approachHeights.push(heightAt(point.x, point.z));
  }
  const minTerrain = Math.min(...heights);
  // The pad must cover every interior sample and the immediate threshold; raw
  // terrain can then never win back authority inside the room.
  const maxTerrain = Math.max(...heights, approachHeights[0]);
  const floorY = maxTerrain + PAD_CLEARANCE;
  const doorStep = floorY - approachHeights[0];
  let approachGrade = 0;
  for (let i = 1; i < approachHeights.length; i++) {
    const run = [0.27, 0.35, 0.45, 0.45, 0.4][i - 1];
    approachGrade = Math.max(approachGrade,
      Math.abs(approachHeights[i] - approachHeights[i - 1]) / run);
  }
  const relief = maxTerrain - minTerrain;
  return {
    valid: doorStep <= MAX_DOOR_STEP && relief <= MAX_PAD_RELIEF
      && approachGrade <= MAX_APPROACH_GRADE,
    floorY, minTerrain, maxTerrain, relief, doorStep, approachGrade,
    score: doorStep * 5 + relief * 0.55 + approachGrade * 1.5,
  };
}

/**
 * Does any of this building's footprint stand on ground it may not have?
 *
 * Sampled at the centre, the corners and the edge midpoints rather than the
 * centre alone: a station village is placed hard against its own railway, and
 * the lot that matters is the one whose corner clips the running line while its
 * centre sits comfortably clear.
 */
function footprintBlocked(building, blockedAt) {
  if (!blockedAt) return false;
  if (blockedAt(building.x, building.z)) return true;
  // The whole footprint, wings included. Sampling the core alone let a wing
  // hang out over a river: the room was on dry land and the rest of the
  // building was in the water.
  const fp = halfExtents(building);
  const xs = [fp.minX, (fp.minX + fp.maxX) / 2, fp.maxX];
  const zs = [fp.minZ, (fp.minZ + fp.maxZ) / 2, fp.maxZ];
  for (const lx of xs) for (const lz of zs) {
    const point = buildingWorldPoint(building, lx, lz);
    if (blockedAt(point.x, point.z)) return true;
  }
  return false;
}

function terrainFittedCandidate(input, heightAt, { fixedYaw = false } = {}) {
  let best = null;
  // Turning the doorway toward the high side of a sloping lot usually makes a
  // safe threshold without making every settlement building face one compass
  // direction. Four quarter-turn variants retain the same authored plan.
  //
  // A street lot is the exception: its facing is the whole point, and spinning
  // the house a quarter turn to save a step puts its door into a neighbour's
  // wall. There the yaw is held and a lot that will not take the building is
  // simply passed over for the next one.
  const quarters = fixedYaw ? 1 : 4;
  for (let quarter = 0; quarter < quarters; quarter++) {
    const probe = createBuildingPlan({ ...input, y: 0, yaw: input.yaw + quarter * Math.PI / 2 });
    const fit = terrainFitForBuilding(probe, heightAt);
    if (!best || fit.score < best.fit.score) best = { probe, fit };
  }
  const y = best.fit.floorY - BUILDING_FLOOR_SURFACE;
  const fitted = createBuildingPlan({ ...input, y, yaw: best.probe.yaw });
  const pad = padGroundFor(fitted, heightAt);
  return Object.freeze({
    ...fitted,
    terrainFit: Object.freeze({ ...best.fit }),
    // The lowest ground the pad actually covers. Distinct from terrainFit's
    // minTerrain, which is the CORE's — the fit rejects lots whose core is
    // uneven, so that number is always small and says nothing about how far the
    // pad's downhill rim stands proud. Everything about the plinth, its depth
    // and whether it needs sides, is measured against this instead.
    padMinTerrain: pad,
    foundationDepth: Math.max(0.32, best.fit.floorY - pad + FOUNDATION_BURIAL),
  });
}

/**
 * The lowest ground anywhere under a building's pad.
 *
 * The terrain fit samples a five-by-five grid over the CORE, because that is
 * the floor whose doorstep and relief decide whether the lot is usable at all.
 * The plinth is a different and larger thing: it carries the whole footprint
 * plus its margin, so ground under a wing — or just outside the core, where a
 * slope keeps falling — sits below anything the fit ever looked at.
 *
 * Sizing the foundation from the core's lowest sample is what left raised plots
 * hanging over open air on their downhill side.
 */
function padGroundFor(building, heightAt) {
  if (!heightAt) return building.y;
  const fp = building.footprint;
  const x0 = fp.minX - FOUNDATION_MARGIN, x1 = fp.maxX + FOUNDATION_MARGIN;
  const z0 = fp.minZ - FOUNDATION_MARGIN, z1 = fp.maxZ + FOUNDATION_MARGIN;
  let lowest = Infinity;
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const lx = x0 + (x1 - x0) * t, lz = z0 + (z1 - z0) * t;
    // The four edges and the diagonals through them: a plinth is undercut at
    // its rim long before it is undercut in the middle.
    for (const [px, pz] of [[lx, z0], [lx, z1], [x0, lz], [x1, lz], [lx, lz]]) {
      const point = buildingWorldPoint(building, px, pz);
      const height = heightAt(point.x, point.z);
      if (height < lowest) lowest = height;
    }
  }
  return Number.isFinite(lowest) ? lowest : building.y;
}

function createLocalPaths(site, buildings, heightAt, layout = null, props = []) {
  const entrance = { ...site.regionalEntrance, kind: 'entrance' };
  const plaza = { key: `${site.id}:centre`, kind: 'centre', x: site.x, y: (heightAt ? heightAt(site.x, site.z) : site.y) + 0.035, z: site.z };
  const approaches = buildings.map(exteriorApproach).sort((a, b) => Math.atan2(a.z - site.z, a.x - site.x) - Math.atan2(b.z - site.z, b.x - site.x));
  const blockers = routeBlockers(buildings, props);
  const connected = [entrance, plaza], paths = [], routingGrid = createRoutingGrid(site, blockers);
  const groundY = (x, z) => (heightAt ? heightAt(x, z) : site.y) + 0.035;

  // The square's centre is the wellhead, and the wellhead is solid.
  //
  // Every street and every lane meets at the plaza node, so leaving it at the
  // centre puts the one point the whole village routes through inside the one
  // thing standing there — and no amount of routing saves a path whose own
  // endpoint is unwalkable. The well keeps the middle of the square, which is
  // where it belongs and why the square is here; it is the junction that steps
  // aside, out along the line the entrance road already arrives on.
  const plazaBlocker = blockers.find((blocker) => blocker.inside(plaza.x, plaza.z, 0.45));
  if (plazaBlocker) {
    const dx = entrance.x - plaza.x, dz = entrance.z - plaza.z;
    const length = Math.hypot(dx, dz) || 1;
    const clearance = plazaBlocker.reach + 1.1;
    plaza.x += dx / length * clearance;
    plaza.z += dz / length * clearance;
    plaza.y = groundY(plaza.x, plaza.z);
  }

  // The streets themselves, laid before anything connects to them.
  //
  // The layout keeps every lot clear of the carriageway by construction, so a
  // street stays a straight run past the houses — the routing call below costs
  // one line test and returns the two original points. What it does catch is
  // the square's own furniture: the well stands dead centre, which is exactly
  // where every street run begins, so without this each one starts inside the
  // wellhead and the first resident down it wedges against the rim. Adding
  // their nodes to `connected` first is what makes a house join the road it
  // stands on rather than striking out across the village to whatever happened
  // to be built before it.
  const streetNodes = [];
  if (layout) {
    for (const street of layout.streets) {
      const length = Math.hypot(street.toX - street.fromX, street.toZ - street.fromZ);
      const steps = Math.max(2, Math.round(length / 18));
      const points = [{ x: plaza.x, y: plaza.y, z: plaza.z }];
      let previous = plaza;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = street.fromX + (street.toX - street.fromX) * t;
        const z = street.fromZ + (street.toZ - street.fromZ) * t;
        const node = { key: `${street.id}:node:${i}`, kind: 'street', x, y: groundY(x, z), z, streetId: street.id };
        points.push({ x, y: node.y, z });
        const run = routeAroundBuildings(
          { x: previous.x, y: previous.y, z: previous.z }, { x, y: node.y, z },
          blockers, heightAt, routingGrid,
        );
        paths.push({
          id: `${street.id}:run:${i}`, from: previous.key, to: node.key, kind: 'main',
          width: street.width,
          points: run.map((point) => ({
            ...point, y: Number.isFinite(point.y) ? point.y : groundY(point.x, point.z),
          })),
        });
        streetNodes.push(node);
        connected.push(node);
        previous = node;
      }
      void points;
    }
  }
  const addPath = (from, to, kind = 'lane') => {
    let routeTarget = to;
    if (to.kind === 'door-approach') {
      const building = buildings.find((entry) => entry.id === to.buildingId);
      const portal = building?.portals.find((entry) => entry.id === to.portalId);
      if (building && portal) {
        const staging = buildingWorldPoint(building, portal.x, building.depth / 2 + 3.8);
        routeTarget = { ...staging, key: `${to.key}:alignment`, kind: 'door-alignment' };
      }
    }
    const routed = routeAroundBuildings(from, routeTarget, blockers, heightAt, routingGrid);
    if (routeTarget !== to) routed.push({ ...to });
    const points = routed.map((point) => ({
      ...point, y: Number.isFinite(point.y) ? point.y : (heightAt ? heightAt(point.x, point.z) + 0.035 : site.y),
    }));
    paths.push({ id: `${site.id}:path:${paths.length}`, from: from.key, to: to.key, kind, width: kind === 'main' ? 2.8 : kind === 'yard' ? 2.2 : 1.65, points });
  };
  addPath(entrance, plaza, 'main');
  for (let index = 0; index < approaches.length; index++) {
    const approach = approaches[index];
    const ranked = connected.slice().sort((a, b) => Math.hypot(a.x - approach.x, a.z - approach.z) - Math.hypot(b.x - approach.x, b.z - approach.z));
    const building = buildings.find((entry) => entry.id === approach.buildingId);
    addPath(ranked[0], approach, building?.program === 'barn' || building?.program === 'workshop' ? 'yard' : 'lane');
    if (index > 3 && index % 6 === 0 && ranked[1]) addPath(ranked[1], approach, 'lane');
    connected.push(approach);
  }
  return { entrance, plaza, approaches, paths, streetNodes };
}

/**
 * A settlement's own taste in building.
 *
 * Every building in one place is planned with the same style, so a village
 * comes out predominantly slate and stone while the next is thatch and
 * plaster. Without it, per-building randomness averages out and every
 * settlement is the same even mix — which is exactly why they all looked alike
 * however much the individual buildings varied.
 */
/**
 * A threshold that lands near one end or the other, never in the middle.
 * `floor` is how committed the least committed village is, and `spread` how
 * much further the most committed one goes.
 */
function sided(rng, floor, spread) {
  const strength = floor + rng() * spread;
  return rng() < 0.5 ? 1 - strength : strength;
}

function settlementStyle(site) {
  const rng = mulberry32((site.seed ^ 0x5719ed) >>> 0);
  const grand = site.kind === 'station-village' || site.kind === 'town';
  return Object.freeze({
    massingComplexity: (grand ? 0.4 : 0.2) + rng() * 0.55,
    // A village chooses a fabric and then how strictly it keeps to it.
    //
    // These were drawn uniformly across 0.2-0.85, and widening that range did
    // not help, because most of a uniform range IS the middle: the typical
    // village came out a coin flip and read as a speckle of every material at
    // once. Real settlements are not spread evenly along that axis. The quarry
    // that is close is close for everyone, and the roofer who works the valley
    // roofs all of it, so places mostly commit. Picking a side first and a
    // strength second puts the mass of villages at the ends where they belong
    // and leaves the middle to the few places that genuinely are mixed.
    //
    // Hierarchy between programs is carried separately, in buildingplan's
    // FABRIC_BY_PROGRAM, so a committed village still builds its church of
    // something better than its barns.
    roofBias: sided(rng, 0.52, 0.45),
    wallBias: sided(rng, 0.55, 0.42),
    hipBias: 0.1 + rng() * 0.42,
    timberBias: 0.12 + rng() * 0.6,
    trimHue: rng(),
  });
}

/**
 * `origin` is the settlement's founding reason from settlementorigin.mjs, or
 * null. Passed in rather than derived here so this stays a pure function of its
 * arguments with no world to query — callers that have a world supply it, and
 * one that does not gets the placeless layout this always produced.
 */
export function createSettlementPlan(site, {
  heightAt = null, blockedAt = null, origin = null, authoritativeWaterAt = null,
} = {}) {
  if (!site?.id) throw new TypeError('A settlement summary is required.');
  const style = settlementStyle(site);
  const density = densityFor(site.kind);
  const rng = mulberry32(site.seed ^ 0x51e771e);
  const range = COUNTS[site.kind] || COUNTS.farmstead;
  const count = range[0] + Math.floor(rng() * (range[1] - range[0] + 1));
  let buildings = [];
  // A station settlement is laid out along streets around a square; everything
  // else keeps the radial scatter that suits scattered homesteads. `lots` being
  // null is what selects between them.
  const layoutSpec = layoutSpecFor(site.kind);
  const layout = layoutSpec ? planSettlementLayout(site, layoutSpec, origin) : null;
  const lots = layout ? layout.lots : null;
  // A lot is claimed only by the building that actually takes it.
  //
  // A cursor was tried first and is subtly wrong: when the church rejects
  // twenty lots before finding ground it likes, those twenty are not bad lots —
  // they are lots too small for a church. Advancing past them threw away the
  // frontage every cottage after it would have used, and villages came out at a
  // third of their size. Rejection is per building; only acceptance consumes.
  const claimed = lots ? new Array(lots.length).fill(false) : null;
  // Each building rescans from the front, so early lots that its neighbours
  // already crowd out burn budget before the scan reaches open frontage further
  // along the street. The budget has to be generous enough to get past them —
  // and can be, because holding the yaw dropped the cost of evaluating a lot to
  // a quarter of what it was.
  const LOT_EVALUATION_BUDGET = 55;
  for (let i = 0; i < count; i++) {
    let accepted = null, fallback = null, acceptedAt = -1, fallbackAt = -1;
    const attempts = lots ? lots.length : 144;
    let evaluated = 0;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let x, z, yaw;
      if (lots) {
        if (claimed[attempt]) continue;
        // Lots are offered in order, so the civic programs at the head of the
        // roster take the square frontage offered first.
        const lot = lots[attempt];
        x = lot.x; z = lot.z; yaw = lot.yaw;
        // Reject the obviously crowded before building anything.
        //
        // Lots are spaced closer than a building is wide, so most of them are
        // already covered by a neighbour, and finding that out by planning a
        // building and fitting it to the terrain is by far the most expensive
        // way to learn it. 2 m is under the smallest half-footprint any program
        // has, so this can never refuse a lot that would in fact have fitted.
        let crowded = false;
        for (const building of buildings) {
          const other = halfExtents(building);
          if (Math.hypot(building.x - x, building.z - z)
            < Math.hypot(other.halfWidth, other.halfDepth) + 2) { crowded = true; break; }
        }
        if (crowded) continue;
        if (++evaluated > LOT_EVALUATION_BUDGET) break;
      } else {
        const spread = Math.sqrt((i + 0.75 + attempt * 0.37) / (count + attempt * 0.4));
        const ring = density.inner + spread * Math.max(18, site.radius * density.reach - density.inner);
        const angle = site.yaw + i * 2.399963 + attempt * 0.73 + (rng() - 0.5) * 0.35;
        x = site.x + Math.cos(angle) * ring; z = site.z + Math.sin(angle) * ring;
        yaw = angle + Math.PI / 2;
      }
      const input = {
        id: `${site.id}:building:${i}`, program: programAt(site.kind, i, origin?.kind), seed: site.seed + i * 40503,
        x, z, yaw, style,
      };
      const candidate = heightAt
        ? terrainFittedCandidate(input, heightAt, { fixedYaw: !!lots })
        : createBuildingPlan({ ...input, y: site.y });
      const extents = halfExtents(candidate);
      const radius = Math.hypot(extents.halfWidth, extents.halfDepth);
      const clear = density.packing === 'tight'
        ? buildings.every((building) => lotsClear(candidate, building, density.gap))
        : buildings.every((building) => {
          const other = halfExtents(building);
          return Math.hypot(building.x - x, building.z - z)
            > radius + Math.hypot(other.halfWidth, other.halfDepth) + density.gap;
        });
      // Blocked ground is refused outright, never taken as a fallback. A lot on
      // the running line is not a compromise worth making — better to place
      // fewer buildings than to put one where the train goes.
      if (!clear || footprintBlocked(candidate, blockedAt)) continue;
      if (!fallback || (candidate.terrainFit?.score ?? 0) < (fallback.terrainFit?.score ?? 0)) {
        fallback = candidate; fallbackAt = attempt;
      }
      if (candidate.terrainFit?.valid ?? true) { accepted = candidate; acceptedAt = attempt; break; }
    }
    // Settlement presence was already limited to broadly walkable country, so
    // this is a defensive fallback for synthetic/custom worlds. It is exposed
    // as invalid terrainFit data rather than silently pretending the lot is
    // safe, allowing quality gates to reject hostile terrain.
    accepted ||= fallback;
    // Where ground is withheld the count is a target, not a promise: a village
    // wrapped around a railway has lots that genuinely have nowhere to go, and
    // a smaller village is the right answer. Without a blocker the old
    // guarantee stands, so a grid settlement failing to place still shouts.
    // A laid-out village has a fixed set of lots, so its building count is a
    // target too: when the street frontage is used up or the remaining lots are
    // on bad ground, a smaller village is the correct answer rather than an
    // error. The radial placer keeps its guarantee, since it can always invent
    // another position.
    if (!accepted && (blockedAt || lots)) continue;
    if (!accepted) throw new Error(`Could not place ${site.id} building ${i} without overlap.`);
    // Only now is the lot spent — and the one spent is whichever candidate was
    // actually kept, which may be the fallback rather than the accepted fit.
    if (lots) {
      const taken = acceptedAt >= 0 ? acceptedAt : fallbackAt;
      if (taken >= 0) claimed[taken] = true;
    }
    buildings.push(accepted);
  }
  // Household identity is plan data, not mutable simulation state. This makes
  // a sign and a resident generated in different streaming passes still agree.
  const dwellings = buildings.filter((building) => building.program === 'dwelling');
  const families = dwellings.map((home, index) => ({
    id: `${site.id}:household:${index}`,
    surname: householdSurname(site, home.seed, index),
  }));
  const familyOwned = new Set(['dwelling', 'barn', 'workshop', 'inn', 'smithy', 'granary']);
  let businessIndex = 0;
  buildings = buildings.map((building) => {
    let family = null;
    if (building.program === 'dwelling') family = families[dwellings.indexOf(building)] || null;
    else if (familyOwned.has(building.program) && families.length) family = families[businessIndex++ % families.length];
    const owned = { ...building, ownerHouseholdId: family?.id || null, ownerSurname: family?.surname || null };
    return Object.freeze({ ...owned, displayName: buildingDisplayName(owned) });
  });
  // Props before paths: the square's furniture is solid to a walking resident,
  // so the lanes have to be able to see it. It only depends on the layout, not
  // on the circulation, so nothing is lost by siting it first.
  const props = createSettlementProps(site, layout, { heightAt, origin, blockedAt });
  const circulation = createLocalPaths(site, buildings, heightAt, layout, props);
  const frontage = planFamilyFrontages({ site, buildings, paths: circulation.paths, streets: layout ? layout.streets : [], square: layout ? layout.square : null }, { heightAt, blockedAt });
  const entrance = site.regionalEntrance;
  const localGraph = {
    nodes: [circulation.entrance, circulation.plaza, ...circulation.streetNodes, ...circulation.approaches],
    edges: circulation.paths.map((path) => ({ id: path.id, from: path.from, to: path.to, kind: path.kind, points: path.points })),
  };
  // The floor you stand on is the whole plinth, not just the room.
  //
  // The claim used to cover the core rectangle alone, while the renderer drew a
  // pad over the entire footprint plus its margin. Everywhere those disagreed —
  // the strip around the walls, the ground beside a wing — the player saw stone
  // underfoot and got terrain height instead, which on a raised plot means
  // dropping through it.
  const claims = buildings.map((b) => {
    // The floor you stand on follows the core up. A granary's is a stride off
    // the ground, and a claim left at terrain height would drop the player
    // through a floor they can see.
    const lift = (b.masses || []).find((item) => item.role === 'core')?.baseY || 0;
    const fp = halfExtents(b);
    const x0 = fp.minX - FOUNDATION_MARGIN, x1 = fp.maxX + FOUNDATION_MARGIN;
    const z0 = fp.minZ - FOUNDATION_MARGIN, z1 = fp.maxZ + FOUNDATION_MARGIN;
    return {
      id: `${b.id}:floor`, kind: 'floor', y: b.y + lift + BUILDING_FLOOR_SURFACE, buildingId: b.id,
      contains(x, z) {
        const dx = x - b.x, dz = z - b.z, c = Math.cos(b.yaw), s = Math.sin(b.yaw);
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        return lx >= x0 && lx <= x1 && lz >= z0 && lz <= z1;
      },
    };
  });
  // No per-building plots.
  //
  // Every building used to carry a rectangle of "swept ground" 6.5m wider than
  // itself, drawn as an opaque slab. Whatever colour such a slab is tinted, a
  // hard-edged opaque rectangle reads as asphalt, and thirty of them turned a
  // village into a car park. The ground a village really wears bare is its
  // square and its streets, which are surfaced as alpha-blended dirt in
  // settlementsurface.mjs; the ring immediately around a building is now a
  // grass mask with no geometry at all, so blades still cannot grow through a
  // wall or out of a plinth.
  const groundZones = [];
  if (layout) {
    groundZones.push({
      id: layout.square.id, kind: 'square', buildingId: null, radius: layout.square.radius,
      x: layout.square.x, y: (heightAt ? heightAt(layout.square.x, layout.square.z) : site.y) + 0.02,
      z: layout.square.z, yaw: layout.square.yaw,
      width: layout.square.radius * 2, depth: layout.square.radius * 2,
    });
  }
  const finalPlan = {
    version: 5, id: `${site.id}:plan`, site, buildings, localGraph, paths: circulation.paths,
    groundZones, claims, props,
    square: layout ? layout.square : null,
    streets: layout ? layout.streets : [],
    familyFrontageProfiles: frontage.familyFrontageProfiles,
    familyFrontages: frontage.familyFrontages,
    familyFrontageDiagnostics: frontage.familyFrontageDiagnostics,
    planHash: `${site.planHash}:spatial6:${FAMILY_FRONTAGE_PLAN_HASH}:${MANAGED_VEGETATION_PLAN_HASH}`,
  };
  // Managed planting is deliberately last. It consumes the authoritative
  // ownership/frontage IDs and every final building, door, path, street, civic,
  // frontage, surface, and world-water reservation without influencing them.
  finalPlan.managedVegetation = planManagedVegetationForSettlement(finalPlan, {
    heightAt, authoritativeWaterAt,
  });
  return finalPlan;
}

export function portalWorldPoint(building, portal) {
  return buildingWorldPoint(building, portal.x, portal.z);
}
