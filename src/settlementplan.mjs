import { createBuildingPlan, buildingWorldPoint } from './buildingplan.mjs';
import { mulberry32 } from './noise.js';

const COUNTS = Object.freeze({ farmstead: [2, 4], hamlet: [5, 9], village: [12, 20], town: [24, 40] });
export const BUILDING_FLOOR_SURFACE = 0.16;
const PAD_CLEARANCE = 0.035;
const MAX_DOOR_STEP = 0.18;
const MAX_PAD_RELIEF = 2.50;
const MAX_APPROACH_GRADE = 0.55;

function programAt(kind, index) {
  if (index === 0) return kind === 'farmstead' ? 'dwelling' : 'inn';
  if (index === 1) return kind === 'farmstead' ? 'barn' : 'hall';
  if (index % 7 === 0) return 'workshop';
  return 'dwelling';
}

function worldToLocal(building, x, z) {
  const dx = x - building.x, dz = z - building.z;
  const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

function insideBuilding(building, x, z, padding = 0) {
  const p = worldToLocal(building, x, z);
  return Math.abs(p.x) < building.width / 2 + padding && Math.abs(p.z) < building.depth / 2 + padding;
}

function firstBlockingBuilding(a, b, buildings, padding = 1) {
  const distance = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(2, Math.ceil(distance / 0.45));
  for (let i = 1; i < steps; i++) {
    const t = i / steps, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    const blocked = buildings.find((building) => insideBuilding(building, x, z, padding));
    if (blocked) return blocked;
  }
  return null;
}

function repairRouteCorners(points, buildings, padding = 1.02) {
  const repaired = [points[0]];
  for (let index = 1; index < points.length; index++) {
    const from = repaired[repaired.length - 1], to = points[index];
    const blocker = firstBlockingBuilding(from, to, buildings, padding);
    if (!blocker) { repaired.push(to); continue; }
    const corners = obstacleCorners(blocker, padding + 0.38)
      .sort((a, b) => (Math.hypot(a.x - from.x, a.z - from.z) + Math.hypot(to.x - a.x, to.z - a.z))
        - (Math.hypot(b.x - from.x, b.z - from.z) + Math.hypot(to.x - b.x, to.z - b.z)));
    const single = corners.find((corner) => !firstBlockingBuilding(from, corner, buildings, padding)
      && !firstBlockingBuilding(corner, to, buildings, padding));
    if (single) { repaired.push(single, to); continue; }
    let pair = null, pairDistance = Infinity;
    for (const a of corners) for (const b of corners) {
      if (a === b || firstBlockingBuilding(from, a, buildings, padding)
        || firstBlockingBuilding(a, b, buildings, padding)
        || firstBlockingBuilding(b, to, buildings, padding)) continue;
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
  const w = building.width / 2 + padding, d = building.depth / 2 + padding;
  return [[-w, -d], [w, -d], [w, d], [-w, d]].map(([x, z]) => buildingWorldPoint(building, x, z));
}

function createRoutingGrid(site, buildings) {
  const cell = 2.5, margin = 9;
  const minX = Math.min(site.bounds.minX, site.regionalEntrance.x) - margin;
  const minZ = Math.min(site.bounds.minZ, site.regionalEntrance.z) - margin;
  const maxX = Math.max(site.bounds.maxX, site.regionalEntrance.x) + margin;
  const maxZ = Math.max(site.bounds.maxZ, site.regionalEntrance.z) + margin;
  const cols = Math.ceil((maxX - minX) / cell) + 1, rows = Math.ceil((maxZ - minZ) / cell) + 1;
  const blocked = new Uint8Array(cols * rows);
  for (const building of buildings) {
    const radius = Math.hypot(building.width, building.depth) / 2 + 1.5;
    const x0 = Math.max(0, Math.floor((building.x - radius - minX) / cell));
    const x1 = Math.min(cols - 1, Math.ceil((building.x + radius - minX) / cell));
    const z0 = Math.max(0, Math.floor((building.z - radius - minZ) / cell));
    const z1 = Math.min(rows - 1, Math.ceil((building.z + radius - minZ) / cell));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      if (insideBuilding(building, minX + x * cell, minZ + z * cell, 1.2)) blocked[z * cols + x] = 1;
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

function routeAroundBuildings(from, to, buildings, heightAt, grid) {
  if (!firstBlockingBuilding(from, to, buildings, 1.05)) return [{ ...from }, { ...to }];
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
  if (parent[goalId] < 0) return [{ ...from }, { ...to }];
  const raw = [];
  for (let id = goalId; id !== startId; id = parent[id]) raw.push({ x: minX + (id % cols) * cell, z: minZ + Math.floor(id / cols) * cell });
  raw.push({ ...from }); raw.reverse(); raw[raw.length - 1] = { ...to };
  const smooth = [raw[0]];
  for (let i = 0; i < raw.length - 1;) {
    let next = i + 1;
    for (let j = raw.length - 1; j > i + 1; j--) if (!firstBlockingBuilding(raw[i], raw[j], buildings, 1.02)) { next = j; break; }
    smooth.push(raw[next]); i = next;
  }
  return repairRouteCorners(smooth, buildings).map((point) => ({
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

function terrainFittedCandidate(input, heightAt) {
  let best = null;
  // Turning the doorway toward the high side of a sloping lot usually makes a
  // safe threshold without making every settlement building face one compass
  // direction. Four quarter-turn variants retain the same authored plan.
  for (let quarter = 0; quarter < 4; quarter++) {
    const probe = createBuildingPlan({ ...input, y: 0, yaw: input.yaw + quarter * Math.PI / 2 });
    const fit = terrainFitForBuilding(probe, heightAt);
    if (!best || fit.score < best.fit.score) best = { probe, fit };
  }
  const y = best.fit.floorY - BUILDING_FLOOR_SURFACE;
  const fitted = createBuildingPlan({ ...input, y, yaw: best.probe.yaw });
  return Object.freeze({
    ...fitted,
    terrainFit: Object.freeze({ ...best.fit }),
    foundationDepth: Math.max(0.32, best.fit.floorY - best.fit.minTerrain + 0.12),
  });
}

function createLocalPaths(site, buildings, heightAt) {
  const entrance = { ...site.regionalEntrance, kind: 'entrance' };
  const plaza = { key: `${site.id}:centre`, kind: 'centre', x: site.x, y: (heightAt ? heightAt(site.x, site.z) : site.y) + 0.035, z: site.z };
  const approaches = buildings.map(exteriorApproach).sort((a, b) => Math.atan2(a.z - site.z, a.x - site.x) - Math.atan2(b.z - site.z, b.x - site.x));
  const connected = [entrance, plaza], paths = [], routingGrid = createRoutingGrid(site, buildings);
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
    const routed = routeAroundBuildings(from, routeTarget, buildings, heightAt, routingGrid);
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
  return { entrance, plaza, approaches, paths };
}

export function createSettlementPlan(site, { heightAt = null } = {}) {
  if (!site?.id) throw new TypeError('A settlement summary is required.');
  const rng = mulberry32(site.seed ^ 0x51e771e);
  const range = COUNTS[site.kind] || COUNTS.farmstead;
  const count = range[0] + Math.floor(rng() * (range[1] - range[0] + 1));
  const buildings = [];
  for (let i = 0; i < count; i++) {
    let accepted = null, fallback = null;
    for (let attempt = 0; attempt < 144; attempt++) {
      const spread = Math.sqrt((i + 0.75 + attempt * 0.37) / (count + attempt * 0.4));
      const ring = 16 + spread * Math.max(18, site.radius - 28);
      const angle = site.yaw + i * 2.399963 + attempt * 0.73 + (rng() - 0.5) * 0.35;
      const x = site.x + Math.cos(angle) * ring, z = site.z + Math.sin(angle) * ring;
      const input = {
        id: `${site.id}:building:${i}`, program: programAt(site.kind, i), seed: site.seed + i * 40503,
        x, z, yaw: angle + Math.PI / 2,
      };
      const candidate = heightAt
        ? terrainFittedCandidate(input, heightAt)
        : createBuildingPlan({ ...input, y: site.y });
      const radius = Math.hypot(candidate.width, candidate.depth) * 0.5;
      const clear = buildings.every((building) => Math.hypot(building.x - x, building.z - z)
        > radius + Math.hypot(building.width, building.depth) * 0.5 + 3.2);
      if (clear && (!fallback || (candidate.terrainFit?.score ?? 0) < (fallback.terrainFit?.score ?? 0))) fallback = candidate;
      if (clear && (candidate.terrainFit?.valid ?? true)) { accepted = candidate; break; }
    }
    // Settlement presence was already limited to broadly walkable country, so
    // this is a defensive fallback for synthetic/custom worlds. It is exposed
    // as invalid terrainFit data rather than silently pretending the lot is
    // safe, allowing quality gates to reject hostile terrain.
    accepted ||= fallback;
    if (!accepted) throw new Error(`Could not place ${site.id} building ${i} without overlap.`);
    buildings.push(accepted);
  }
  const circulation = createLocalPaths(site, buildings, heightAt);
  const entrance = site.regionalEntrance;
  const localGraph = {
    nodes: [circulation.entrance, circulation.plaza, ...circulation.approaches],
    edges: circulation.paths.map((path) => ({ id: path.id, from: path.from, to: path.to, kind: path.kind, points: path.points })),
  };
  const claims = buildings.map((b) => ({
    id: `${b.id}:floor`, kind: 'floor', y: b.y + BUILDING_FLOOR_SURFACE, buildingId: b.id,
    contains(x, z) {
      const dx = x - b.x, dz = z - b.z, c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      return Math.abs(lx) <= b.width / 2 && Math.abs(lz) <= b.depth / 2;
    },
  }));
  const groundZones = buildings.map((building) => ({
    id: `${building.id}:apron`, kind: building.program === 'barn' || building.program === 'workshop' ? 'work-yard' : 'dirt-apron',
    buildingId: building.id, x: building.x, y: building.y + 0.02, z: building.z, yaw: building.yaw,
    width: building.width + (building.program === 'barn' ? 7 : 4.5), depth: building.depth + (building.program === 'workshop' ? 7 : 4.5),
  }));
  return { version: 3, id: `${site.id}:plan`, site, buildings, localGraph, paths: circulation.paths, groundZones, claims, planHash: `${site.planHash}:spatial3` };
}

export function portalWorldPoint(building, portal) {
  return buildingWorldPoint(building, portal.x, portal.z);
}
