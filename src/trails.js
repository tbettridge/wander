// Desire-line trails — deterministic worn paths between neighbouring landmarks.
//
// Phase 1 upgraded edges into prepared, spatially indexed records. Phase 2
// replaces the cardinal neighbour grid with a mutual, top-four sector graph:
// organic angles, a real degree cap, locally connected routes and deterministic
// primary/secondary/faint classes. Phase 3 solves every selected edge through a
// bounded terrain corridor, preferring walkable grades, contour traverses and
// shallow fords while preserving the public wear/profile APIs.

import { mulberry32, smoothstep } from './noise.js';
import { landmarkForCell, LM_CELL } from './landmarks.js';
import { caveAnchorForCell, CAVE_CELL_SIZE } from './cavegen.mjs';

const NEIGHBORHOOD = 2;            // 5×5 landmark-cell window scanned for candidates
const SECTORS = 6;                 // keep the nearest candidate in each angular sector
const MAX_SELECTIONS = 4;          // mutual selection makes this a hard degree cap
const MAX_EDGE_DIST = 2.5 * LM_CELL;
const MAX_EDGE_DIST2 = MAX_EDGE_DIST * MAX_EDGE_DIST;
// Caves join the network as spurs: each valid cave mouth reaches out to its
// single nearest landmark, so desire lines occasionally branch off toward a
// cave the way they thread between landmarks. The reach matches the landmark
// edge scale so a cave trail reads like any other link; caves further than
// this from the network simply stay unmarked (they are the rarer wild ones).
const CAVE_MAX_EDGE_DIST = MAX_EDGE_DIST;
const CAVE_MAX_EDGE_DIST2 = CAVE_MAX_EDGE_DIST * CAVE_MAX_EDGE_DIST;
const CAVE_TRAIL_HALO = 12;         // trail stops this far downslope of the mouth
const TARGET_SEGMENT_LENGTH = 20;  // metres; adaptive, usually 15–25 m
const MIN_SEGMENTS = 8;
const MAX_SEGMENTS = 160;
const SEGMENT_BIN_SIZE = 64;       // local metres; segments are inserted expanded by width
const ROUTE_SLICE_LENGTH = 36;     // solver progress step along the landmark-to-landmark axis
const ROUTE_LANES = 17;            // odd so lane 8 is the direct centreline
const ROUTE_MAX_LANE_STEP = 2;     // allows diagonal contouring / switchback legs
const ROUTE_RELAX_PASSES = 2;
const EDGE_CACHE_LIMIT = 512;
const LM_CACHE_LIMIT = 4096;
const SEL_CACHE_LIMIT = 4096;

// Route classes. width = half-width where wear fades to nothing; wear = peak
// compaction. Primary form the connective backbone (each landmark's nearest
// link), secondary add local loops, faint are thin desire lines that don't
// always exist. Values are [base, +rng].
// Phase 4's continuous surface is independent of terrain vertices, so widths
// can return to believable footpath scale instead of being inflated merely to
// hit a coarse sample. Values remain half-widths: primary 2.5–4 m across,
// secondary 1.5–2.5 m, faint desire lines roughly 0.75–1.45 m.
const CLASS_WIDTH = { primary: [1.25, 0.75], secondary: [0.75, 0.5], faint: [0.38, 0.34] };
const CLASS_WEAR = { primary: [0.78, 0.22], secondary: [0.6, 0.25], faint: [0.42, 0.25] };

const ROUTE_PROFILE = Object.freeze({
  primary: Object.freeze({ targetGrade: 0.065, maxGrade: 0.12, gradeWeight: 8.0, overGradeWeight: 1500,
    waterWeight: 18, corridorScale: 1.0, deviationWeight: 0.10 }),
  secondary: Object.freeze({ targetGrade: 0.09, maxGrade: 0.16, gradeWeight: 5.5, overGradeWeight: 900,
    waterWeight: 13, corridorScale: 0.85, deviationWeight: 0.08 }),
  faint: Object.freeze({ targetGrade: 0.12, maxGrade: 0.21, gradeWeight: 4.0, overGradeWeight: 520,
    waterWeight: 9, corridorScale: 0.68, deviationWeight: 0.06 }),
});

// Module-local in every worker/main realm — no cross-thread mutable state, every
// entry a pure function of (seed, cells). LRU bounds memory; the landmark and
// selection caches let the several systems that query trails per chunk (terrain,
// trees, clutter, grass, understory) share the placement + graph work.
const edgeCache = new Map();
const lmCache = new Map();
const selCache = new Map();
const caveCache = new Map();

function lruGet(map, key) {
  if (!map.has(key)) return undefined;
  const v = map.get(key); map.delete(key); map.set(key, v); return v;
}
function lruSet(map, key, v, limit) {
  map.set(key, v);
  if (map.size > limit) map.delete(map.keys().next().value);
  return v;
}

export function clearTrailCache() {
  edgeCache.clear(); lmCache.clear(); selCache.clear(); caveCache.clear();
}

function cachedLandmark(world, ci, cj, seed) {
  const key = (seed >>> 0) + ':' + ci + ',' + cj;
  const hit = lruGet(lmCache, key);
  if (hit !== undefined) return hit;
  return lruSet(lmCache, key, landmarkForCell(world, ci, cj, seed) || null, LM_CACHE_LIMIT);
}

// A cave mouth as a graph node, or null when the cell hosts no viable cave.
// Only valid anchors (those the cave system would actually open) become trail
// destinations. The 'C' key prefix keeps caves in a disjoint id space from
// landmark cells so canonical edge ids and endpoint junctions never collide.
function cachedCaveNode(world, cx, cz, seed) {
  const key = (seed >>> 0) + ':c:' + cx + ',' + cz;
  const hit = lruGet(caveCache, key);
  if (hit !== undefined) return hit;
  const anchor = caveAnchorForCell(world, cx, cz, seed);
  let node = null;
  if (anchor && anchor.valid) {
    node = {
      key: 'C' + cx + '_' + cz,
      x: anchor.x, z: anchor.z, y: anchor.surfaceY,
      type: 'cave', isCave: true,
      seed: anchor.seed >>> 0,
      halo: CAVE_TRAIL_HALO,
      yaw: anchor.yaw,
      caveKind: anchor.kind || 'cave',
      coastType: anchor.coastType || null,
    };
  }
  return lruSet(caveCache, key, node, LM_CACHE_LIMIT);
}

// Nearest landmark to a point within maxDist — the anchor a cave spur ties into.
// Cell-scan order with a strict improvement test keeps ties deterministic.
function nearestLandmarkNode(world, x, z, seed, maxDist) {
  const i0 = Math.floor((x - maxDist) / LM_CELL), i1 = Math.floor((x + maxDist) / LM_CELL);
  const j0 = Math.floor((z - maxDist) / LM_CELL), j1 = Math.floor((z + maxDist) / LM_CELL);
  let best = null, bd = maxDist * maxDist;
  for (let cj = j0; cj <= j1; cj++) {
    for (let ci = i0; ci <= i1; ci++) {
      const lm = cachedLandmark(world, ci, cj, seed);
      if (!lm) continue;
      const d2 = (lm.x - x) ** 2 + (lm.z - z) ** 2;
      if (d2 < bd) { bd = d2; best = lm; }
    }
  }
  return best;
}

// Route class for a cave spur. Biased toward the more visible classes so a
// cave stays discoverable, but still occasionally only a faint desire line.
function caveSpurClass(cave, landmark, seed) {
  const roll = edgeRng2(cave, landmark, seed)();
  // Sea-cave approaches read as narrow, maintained cliff paths rather than
  // broad inland routes. Keep a few nearly-lost desire lines for mystery.
  if (cave.caveKind === 'sea-cave') return roll < 0.82 ? 'secondary' : 'faint';
  return roll < 0.35 ? 'primary' : roll < 0.85 ? 'secondary' : 'faint';
}

function cellOf(lm) { const u = lm.key.indexOf('_'); return [+lm.key.slice(0, u), +lm.key.slice(u + 1)]; }

function canonicalEdgeId(a, b) {
  return a.key < b.key ? a.key + '~' + b.key : b.key + '~' + a.key;
}

function edgeRng2(owner, other, seed) {
  return mulberry32(((Math.imul(owner.seed, 2654435761) ^ Math.imul(other.seed, 40503)
    ^ Math.imul(seed >>> 0, 19349663)) >>> 0));
}

// The nearest viable landmark in each angular sector of a's 5×5 neighbourhood —
// a locally pruned Yao graph: organic angles without cardinal grid bias. The
// four nearest occupied sectors are retained. An edge is emitted only when the
// choice is mutual, so MAX_SELECTIONS is a real degree bound rather than an
// outgoing-only claim. Sorted nearest first for backbone classification.
function selectionsFor(world, a, seed) {
  const ck = (seed >>> 0) + ':s:' + a.key;
  const hit = lruGet(selCache, ck);
  if (hit !== undefined) return hit;
  const [ci, cj] = cellOf(a);
  const bySector = new Array(SECTORS).fill(null);
  for (let dj = -NEIGHBORHOOD; dj <= NEIGHBORHOOD; dj++) {
    for (let di = -NEIGHBORHOOD; di <= NEIGHBORHOOD; di++) {
      if (!di && !dj) continue;
      const b = cachedLandmark(world, ci + di, cj + dj, seed);
      if (!b) continue;
      const ex = b.x - a.x, ez = b.z - a.z, d2 = ex * ex + ez * ez;
      if (d2 > MAX_EDGE_DIST2) continue;
      let sec = Math.floor((Math.atan2(ez, ex) + Math.PI) / (Math.PI * 2) * SECTORS);
      sec = ((sec % SECTORS) + SECTORS) % SECTORS;
      const cur = bySector[sec];
      if (!cur || d2 < cur.d2) bySector[sec] = { b, d2 };
    }
  }
  const sel = [];
  for (let s = 0; s < SECTORS; s++) if (bySector[s]) sel.push(bySector[s]);
  sel.sort((p, q) => p.d2 - q.d2);
  if (sel.length > MAX_SELECTIONS) sel.length = MAX_SELECTIONS;
  return lruSet(selCache, ck, sel, SEL_CACHE_LIMIT);
}

function prepareSegments(pts, width) {
  const count = pts.length / 2 - 1;
  const ax = new Float32Array(count), az = new Float32Array(count);
  const dx = new Float32Array(count), dz = new Float32Array(count);
  const len = new Float32Array(count), invLen2 = new Float32Array(count);
  const minx = new Float32Array(count), minz = new Float32Array(count);
  const maxx = new Float32Array(count), maxz = new Float32Array(count);
  const arc = new Float32Array(count + 1);
  let edgeMinX = Infinity, edgeMinZ = Infinity, edgeMaxX = -Infinity, edgeMaxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    const p = i * 2;
    const x0 = pts[p], z0 = pts[p + 1], x1 = pts[p + 2], z1 = pts[p + 3];
    const sx = x1 - x0, sz = z1 - z0;
    const l2 = sx * sx + sz * sz;
    const sl = Math.sqrt(l2) || 1;
    ax[i] = x0; az[i] = z0; dx[i] = sx; dz[i] = sz;
    len[i] = sl; invLen2[i] = l2 > 1e-12 ? 1 / l2 : 0;
    minx[i] = Math.min(x0, x1) - width; maxx[i] = Math.max(x0, x1) + width;
    minz[i] = Math.min(z0, z1) - width; maxz[i] = Math.max(z0, z1) + width;
    edgeMinX = Math.min(edgeMinX, minx[i]); edgeMaxX = Math.max(edgeMaxX, maxx[i]);
    edgeMinZ = Math.min(edgeMinZ, minz[i]); edgeMaxZ = Math.max(edgeMaxZ, maxz[i]);
    arc[i + 1] = arc[i] + sl;
  }

  const cols = Math.max(1, Math.ceil((edgeMaxX - edgeMinX) / SEGMENT_BIN_SIZE));
  const rows = Math.max(1, Math.ceil((edgeMaxZ - edgeMinZ) / SEGMENT_BIN_SIZE));
  const bins = new Map();
  for (let i = 0; i < count; i++) {
    const x0 = Math.max(0, Math.floor((minx[i] - edgeMinX) / SEGMENT_BIN_SIZE));
    const x1 = Math.min(cols - 1, Math.floor((maxx[i] - edgeMinX) / SEGMENT_BIN_SIZE));
    const z0 = Math.max(0, Math.floor((minz[i] - edgeMinZ) / SEGMENT_BIN_SIZE));
    const z1 = Math.min(rows - 1, Math.floor((maxz[i] - edgeMinZ) / SEGMENT_BIN_SIZE));
    for (let bz = z0; bz <= z1; bz++) {
      for (let bx = x0; bx <= x1; bx++) {
        const key = bz * cols + bx;
        let list = bins.get(key);
        if (!list) bins.set(key, list = []);
        list.push(i);
      }
    }
  }

  return {
    ax, az, dx, dz, len, invLen2, minx, minz, maxx, maxz, arc,
    bins, cols, rows, binSize: SEGMENT_BIN_SIZE,
    minX: edgeMinX, minZ: edgeMinZ, maxX: edgeMaxX, maxZ: edgeMaxZ,
    arcLength: arc[count], count,
  };
}

function routeSite(world, x, z) {
  const river = { base: 0, ch: 0, floor: 0, head: 0, waterY: 0 };
  const h = world.height(x, z, river);
  const submerge = river.waterY - river.floor;
  const wet = submerge > 0.03 && river.waterY > 0.25 && river.ch > 0.001;
  return {
    x, z, h,
    wet,
    depth: wet ? submerge : 0,
    ocean: h < 0.45,
  };
}

function routeSitePenalty(site, profile) {
  if (site.ocean) return 100000;
  if (!site.wet) return 0;
  // A crossing remains possible, but the solver strongly prefers a short,
  // shallow point. Deep water rapidly becomes more expensive than a detour.
  return profile.waterWeight * (1 + site.depth * site.depth * 18);
}

function routeTransitionCost(a, b, profile, deviation, laneMove) {
  const run = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const grade = Math.abs(b.h - a.h) / run;
  const over = Math.max(0, grade - profile.maxGrade);
  let cost = run * (1 + grade * grade * profile.gradeWeight
    + over * over * profile.overGradeWeight
    + deviation * deviation * profile.deviationWeight);
  cost += run * (routeSitePenalty(a, profile) * 0.25 + routeSitePenalty(b, profile) * 0.55);
  cost += laneMove * 1.5; // suppress nervous lane-to-lane chatter on equal-cost ground
  return cost;
}

function relaxTerrainRoute(world, nodes, profile) {
  let current = nodes;
  for (let pass = 0; pass < ROUTE_RELAX_PASSES; pass++) {
    const next = current.slice();
    for (let i = 1; i < current.length - 1; i++) {
      const p = current[i - 1], c = current[i], n = current[i + 1];
      const x = p.x * 0.22 + c.x * 0.56 + n.x * 0.22;
      const z = p.z * 0.22 + c.z * 0.56 + n.z * 0.22;
      const candidate = routeSite(world, x, z);
      if (candidate.ocean) continue;
      if (!c.wet && candidate.wet && candidate.depth > 0.18) continue;
      const oldGrade = Math.max(
        Math.abs(c.h - p.h) / Math.max(1, Math.hypot(c.x - p.x, c.z - p.z)),
        Math.abs(n.h - c.h) / Math.max(1, Math.hypot(n.x - c.x, n.z - c.z)));
      const newGrade = Math.max(
        Math.abs(candidate.h - p.h) / Math.max(1, Math.hypot(candidate.x - p.x, candidate.z - p.z)),
        Math.abs(n.h - candidate.h) / Math.max(1, Math.hypot(n.x - candidate.x, n.z - candidate.z)));
      if (newGrade > Math.max(profile.maxGrade * 1.7, oldGrade * 1.08)) continue;
      next[i] = candidate;
    }
    current = next;
  }
  return current;
}

function resampleRoute(nodes) {
  const arc = new Float64Array(nodes.length);
  for (let i = 1; i < nodes.length; i++) {
    arc[i] = arc[i - 1] + Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z);
  }
  const total = arc[arc.length - 1];
  const count = Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, Math.ceil(total / TARGET_SEGMENT_LENGTH)));
  const pts = new Float32Array((count + 1) * 2);
  let seg = 1;
  for (let i = 0; i <= count; i++) {
    const d = total * (i / count);
    while (seg < arc.length - 1 && arc[seg] < d) seg++;
    const a = nodes[seg - 1], b = nodes[seg];
    const span = Math.max(1e-6, arc[seg] - arc[seg - 1]);
    const t = Math.max(0, Math.min(1, (d - arc[seg - 1]) / span));
    pts[i * 2] = a.x + (b.x - a.x) * t;
    pts[i * 2 + 1] = a.z + (b.z - a.z) * t;
  }
  return pts;
}

function analyzeTerrainRoute(world, pts) {
  let maxGrade = 0, gradeSum = 0, length = 0, switchbacks = 0;
  let wet = false, ford = null, maxFordDepth = 0;
  const fords = [];
  let prevTx = 0, prevTz = 0;
  for (let i = 0; i < pts.length / 2 - 1; i++) {
    const p = i * 2;
    const x0 = pts[p], z0 = pts[p + 1], x1 = pts[p + 2], z1 = pts[p + 3];
    const run = Math.hypot(x1 - x0, z1 - z0) || 1;
    const h0 = world.height(x0, z0), h1 = world.height(x1, z1);
    const grade = Math.abs(h1 - h0) / run;
    const arcBase = length;
    maxGrade = Math.max(maxGrade, grade); gradeSum += grade * run; length += run;
    const tx = (x1 - x0) / run, tz = (z1 - z0) / run;
    if (i > 0 && tx * prevTx + tz * prevTz < 0.28) switchbacks++;
    prevTx = tx; prevTz = tz;

    const samples = Math.max(1, Math.ceil(run / 8));
    for (let s = 0; s <= samples; s++) {
      const t = s / samples, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      const rv = world.riverAt(x, z);
      if (rv.wet) {
        const arc = arcBase + t * run;
        if (!wet) ford = { x, z, endX: x, endZ: z, arcStart: arc, arcEnd: arc, maxDepth: 0 };
        wet = true;
        ford.endX = x; ford.endZ = z; ford.arcEnd = arc;
        ford.maxDepth = Math.max(ford.maxDepth, rv.depth);
        maxFordDepth = Math.max(maxFordDepth, rv.depth);
      } else if (wet) {
        fords.push(ford); ford = null; wet = false;
      }
    }
  }
  if (wet && ford) fords.push(ford);
  const mergedFords = [];
  for (let i = 0; i < fords.length; i++) {
    const crossing = fords[i];
    const previous = mergedFords[mergedFords.length - 1];
    if (previous && Math.hypot(crossing.x - previous.x, crossing.z - previous.z) < 85) {
      previous.maxDepth = Math.max(previous.maxDepth, crossing.maxDepth);
      previous.endX = crossing.endX; previous.endZ = crossing.endZ;
      previous.arcEnd = crossing.arcEnd;
      continue;
    }
    crossing.kind = crossing.maxDepth <= 0.85 ? 'ford'
      : crossing.maxDepth <= 1.65 ? 'deep-ford' : 'bridge-required';
    mergedFords.push(crossing);
  }
  let bridgeCount = 0;
  for (let i = 0; i < mergedFords.length; i++) {
    const crossing = mergedFords[i];
    crossing.kind = crossing.maxDepth <= 0.85 ? 'ford'
      : crossing.maxDepth <= 1.65 ? 'deep-ford' : 'bridge-required';
    crossing.centerX = (crossing.x + crossing.endX) * 0.5;
    crossing.centerZ = (crossing.z + crossing.endZ) * 0.5;
    crossing.span = Math.max(0.5, Math.hypot(crossing.endX - crossing.x, crossing.endZ - crossing.z));
    crossing.arcPosition = (crossing.arcStart + crossing.arcEnd) * 0.5;
    crossing.tangentX = (crossing.endX - crossing.x) / crossing.span;
    crossing.tangentZ = (crossing.endZ - crossing.z) / crossing.span;
    if (crossing.kind === 'bridge-required') bridgeCount++;
  }
  return {
    maxGrade,
    meanGrade: length > 0 ? gradeSum / length : 0,
    switchbacks,
    fords: mergedFords,
    fordCount: mergedFords.length,
    bridgeCount,
    maxFordDepth,
  };
}

// Bounded forward dynamic programming through a corridor around the direct
// landmark axis. Forward progress is monotonic, but adjacent lane changes can
// lengthen a climb into contouring diagonals and genuine zig-zag switchbacks.
function solveTerrainRoute(world, sx, sz, ex, ez, routeClass) {
  const profile = ROUTE_PROFILE[routeClass];
  const straight = Math.hypot(ex - sx, ez - sz) || 1;
  const ux = (ex - sx) / straight, uz = (ez - sz) / straight;
  const px = -uz, pz = ux;
  const slices = Math.max(4, Math.ceil(straight / ROUTE_SLICE_LENGTH));
  const centre = (ROUTE_LANES - 1) >> 1;
  const halfWidth = Math.min(520, Math.max(130, straight * 0.22)) * profile.corridorScale;
  const rows = new Array(slices + 1);
  rows[0] = new Array(ROUTE_LANES).fill(null);
  rows[0][centre] = routeSite(world, sx, sz);
  rows[slices] = new Array(ROUTE_LANES).fill(null);
  rows[slices][centre] = routeSite(world, ex, ez);

  for (let i = 1; i < slices; i++) {
    const t = i / slices;
    const envelope = Math.pow(Math.sin(Math.PI * t), 0.65);
    const bx = sx + (ex - sx) * t, bz = sz + (ez - sz) * t;
    const row = rows[i] = new Array(ROUTE_LANES);
    for (let lane = 0; lane < ROUTE_LANES; lane++) {
      const offset = ((lane - centre) / centre) * halfWidth * envelope;
      row[lane] = routeSite(world, bx + px * offset, bz + pz * offset);
    }
  }

  let previous = new Float64Array(ROUTE_LANES); previous.fill(Infinity);
  previous[centre] = 0;
  const parents = new Array(slices + 1);
  for (let i = 1; i <= slices; i++) {
    const costs = new Float64Array(ROUTE_LANES); costs.fill(Infinity);
    const parent = parents[i] = new Int16Array(ROUTE_LANES); parent.fill(-1);
    const endRow = i === slices;
    const lane0 = endRow ? centre : 0, lane1 = endRow ? centre : ROUTE_LANES - 1;
    for (let lane = lane0; lane <= lane1; lane++) {
      const node = rows[i][lane];
      const p0 = Math.max(0, lane - ROUTE_MAX_LANE_STEP);
      const p1 = Math.min(ROUTE_LANES - 1, lane + ROUTE_MAX_LANE_STEP);
      for (let prevLane = p0; prevLane <= p1; prevLane++) {
        if (!Number.isFinite(previous[prevLane])) continue;
        const prevNode = rows[i - 1][prevLane];
        if (!prevNode) continue;
        const deviation = Math.abs(lane - centre) / centre;
        const cost = previous[prevLane] + routeTransitionCost(
          prevNode, node, profile, deviation, Math.abs(lane - prevLane));
        if (cost < costs[lane]) { costs[lane] = cost; parent[lane] = prevLane; }
      }
    }
    previous = costs;
  }

  // A pathological all-ocean corridor still yields the least-bad deterministic
  // path rather than dropping a Phase-2 graph edge and breaking connectivity.
  const lanePath = new Int16Array(slices + 1);
  lanePath[slices] = centre;
  for (let i = slices; i > 0; i--) {
    const p = parents[i][lanePath[i]];
    lanePath[i - 1] = p >= 0 ? p : centre;
  }
  let nodes = new Array(slices + 1);
  for (let i = 0; i <= slices; i++) nodes[i] = rows[i][lanePath[i]] || rows[i][centre];
  nodes = relaxTerrainRoute(world, nodes, profile);
  const pts = resampleRoute(nodes);
  const analysis = analyzeTerrainRoute(world, pts);
  const mid = nodes[(nodes.length / 2) | 0];
  return { pts, analysis, controlX: mid.x, controlZ: mid.z, solvedNodeCount: nodes.length };
}

// Build the single canonical edge between two landmarks (owner = lower key, so
// it is emitted once regardless of which chunk/window triggers it). Route class,
// width and wear are pure functions of the endpoints + seed.
function buildEdge(world, owner, other, seed, forcedClass = null) {
  const id = canonicalEdgeId(owner, other);
  const key = (seed >>> 0) + ':' + id;
  const cached = lruGet(edgeCache, key);
  if (cached !== undefined) return cached;

  const rng = edgeRng2(owner, other, seed);
  const dist = Math.hypot(other.x - owner.x, other.z - owner.z) || 1;

  // route class: a nearest link of either endpoint is a primary local route;
  // otherwise a distance-weighted roll picks secondary or faint. Faint edges
  // remain in the graph—their presentation may become intermittent later, but
  // deleting them here can silently sever an otherwise useful local link.
  // forcedClass short-circuits this for cave spurs, whose endpoints are not
  // part of the mutual landmark selection graph selectionsFor() walks.
  let routeClass;
  if (forcedClass) {
    routeClass = forcedClass;
  } else {
    const oSel = selectionsFor(world, owner, seed);
    const pSel = selectionsFor(world, other, seed);
    const backbone = (oSel[0] && oSel[0].b.key === other.key) || (pSel[0] && pSel[0].b.key === owner.key);
    if (backbone) routeClass = 'primary';
    else {
      const roll = rng();
      const near = 1 - smoothstep(LM_CELL * 0.7, MAX_EDGE_DIST, dist);   // 1 short → 0 long
      if (roll < 0.16 + 0.30 * near) routeClass = 'primary';
      else if (roll < 0.72) routeClass = 'secondary';
      else routeClass = 'faint';
    }
  }
  const [wBase, wJit] = CLASS_WIDTH[routeClass];
  const [eBase, eJit] = CLASS_WEAR[routeClass];
  const width = wBase + rng() * wJit;
  const wear = eBase + rng() * eJit;

  // Endpoints meet the landmark clearing halos, then Phase 3 solves the space
  // between them through a deterministic terrain corridor.
  const ux = (other.x - owner.x) / dist, uz = (other.z - owner.z) / dist;
  const sx = owner.x + ux * owner.halo, sz = owner.z + uz * owner.halo;
  const ex = other.x - ux * other.halo, ez = other.z - uz * other.halo;
  const caveNode = owner.isCave ? owner : other.isCave ? other : null;
  const solved = solveTerrainRoute(world, sx, sz, ex, ez, routeClass);
  // Only publish sea-cave routes the player can actually walk. Some mouths sit
  // on sheer isolated faces; those remain mysterious wild caves rather than
  // receiving a misleading ribbon that runs straight over a precipice.
  if (caveNode?.caveKind === 'sea-cave' && solved.analysis.maxGrade > 0.26) {
    return lruSet(edgeCache, key, null, EDGE_CACHE_LIMIT);
  }
  const pts = solved.pts;
  const segmentCount = pts.length / 2 - 1;

  const segments = prepareSegments(pts, width);
  return lruSet(edgeCache, key, {
    id,
    owner: owner.key,
    routeClass,
    fromKey: owner.key,
    toKey: other.key,
    // Cave spur metadata: null for ordinary landmark links. caveEnd marks which
    // endpoint is the mouth so navigation/debug can steer to it.
    toCave: caveNode ? {
      key: caveNode.key, x: caveNode.x, z: caveNode.z, y: caveNode.y, yaw: caveNode.yaw,
      kind: caveNode.caveKind, coastType: caveNode.coastType,
    } : null,
    caveEnd: caveNode ? (caveNode === owner ? 'from' : 'to') : null,
    cliffPath: caveNode?.caveKind === 'sea-cave',
    coastType: caveNode?.coastType || null,
    curve: {
      startX: pts[0], startZ: pts[1],
      controlX: solved.controlX, controlZ: solved.controlZ,
      endX: pts[pts.length - 2], endZ: pts[pts.length - 1],
    },
    solver: 'terrain-corridor-v1',
    route: solved.analysis,
    maxGrade: solved.analysis.maxGrade,
    meanGrade: solved.analysis.meanGrade,
    switchbacks: solved.analysis.switchbacks,
    fords: solved.analysis.fords,
    fordCount: solved.analysis.fordCount,
    bridgeCount: solved.analysis.bridgeCount,
    maxFordDepth: solved.analysis.maxFordDepth,
    solvedNodeCount: solved.solvedNodeCount,
    pts,
    points: pts,
    segments,
    segmentCount,
    samplingSpacing: segments.arcLength / segmentCount,
    arcLength: segments.arcLength,
    wear,
    width,
    minx: segments.minX,
    minz: segments.minZ,
    maxx: segments.maxX,
    maxz: segments.maxZ,
  }, EDGE_CACHE_LIMIT);
}

// All prepared trail edges that may touch (px,pz) within `radius`. Any edge
// crossing the area has both endpoints within MAX_EDGE_DIST of it, so scanning
// the query window expanded by that reach visits every possible endpoint.
// Mutual selection keeps degree bounded; canonical IDs prevent duplicates.
export function trailsAround(world, px, pz, seed, radius, out) {
  out.length = 0;
  const reach = radius + MAX_EDGE_DIST;
  const i0 = Math.floor((px - reach) / LM_CELL), i1 = Math.floor((px + reach) / LM_CELL);
  const j0 = Math.floor((pz - reach) / LM_CELL), j1 = Math.floor((pz + reach) / LM_CELL);
  const qMinX = px - radius, qMaxX = px + radius, qMinZ = pz - radius, qMaxZ = pz + radius;
  const seen = new Set();
  for (let cj = j0; cj <= j1; cj++) {
    for (let ci = i0; ci <= i1; ci++) {
      const a = cachedLandmark(world, ci, cj, seed);
      if (!a) continue;
      const sel = selectionsFor(world, a, seed);
      for (let r = 0; r < sel.length; r++) {
        const b = sel[r].b;
        const reverse = selectionsFor(world, b, seed);
        let mutual = false;
        for (let q = 0; q < reverse.length; q++) {
          if (reverse[q].b.key === a.key) { mutual = true; break; }
        }
        if (!mutual) continue;
        const id = canonicalEdgeId(a, b);
        if (seen.has(id)) continue;
        seen.add(id);
        const owner = a.key < b.key ? a : b;
        const other = owner === a ? b : a;
        const edge = buildEdge(world, owner, other, seed);
        if (edge && edge.maxx >= qMinX && edge.minx <= qMaxX && edge.maxz >= qMinZ && edge.minz <= qMaxZ) {
          out.push(edge);
        }
      }
    }
  }

  // Cave spurs. A cave-mouth edge no longer than CAVE_MAX_EDGE_DIST keeps its
  // cave endpoint within (radius + CAVE_MAX_EDGE_DIST) of the centre, so this
  // window sees every cave whose spur could cross the query rect. Each valid
  // cave ties to its nearest landmark (directed — no mutual test — so the path
  // to the cave is guaranteed rather than contingent on the landmark's own
  // top-four). Landmark↔landmark topology above is untouched.
  const caveReach = radius + CAVE_MAX_EDGE_DIST;
  const cx0 = Math.floor((px - caveReach) / CAVE_CELL_SIZE);
  const cx1 = Math.floor((px + caveReach) / CAVE_CELL_SIZE);
  const cz0 = Math.floor((pz - caveReach) / CAVE_CELL_SIZE);
  const cz1 = Math.floor((pz + caveReach) / CAVE_CELL_SIZE);
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const cave = cachedCaveNode(world, cx, cz, seed);
      if (!cave) continue;
      const lm = nearestLandmarkNode(world, cave.x, cave.z, seed, CAVE_MAX_EDGE_DIST);
      if (!lm) continue;
      const id = canonicalEdgeId(cave, lm);
      if (seen.has(id)) continue;
      seen.add(id);
      const owner = cave.key < lm.key ? cave : lm;
      const other = owner === cave ? lm : cave;
      const edge = buildEdge(world, owner, other, seed, caveSpurClass(cave, lm, seed));
      if (edge && edge.maxx >= qMinX && edge.minx <= qMaxX && edge.maxz >= qMinZ && edge.minz <= qMaxZ) {
        out.push(edge);
      }
    }
  }
  return out;
}

const edgeSample = { segment: -1, t: 0, distanceSq: Infinity, qx: 0, qz: 0 };

function sampleEdge(edge, x, z, out) {
  const s = edge.segments;
  const bx = Math.max(0, Math.min(s.cols - 1, Math.floor((x - s.minX) / s.binSize)));
  const bz = Math.max(0, Math.min(s.rows - 1, Math.floor((z - s.minZ) / s.binSize)));
  const candidates = s.bins.get(bz * s.cols + bx);
  out.segment = -1;
  out.distanceSq = Infinity;
  if (!candidates) return out;

  for (let k = 0; k < candidates.length; k++) {
    const i = candidates[k];
    if (x < s.minx[i] || x > s.maxx[i] || z < s.minz[i] || z > s.maxz[i]) continue;
    let t = ((x - s.ax[i]) * s.dx[i] + (z - s.az[i]) * s.dz[i]) * s.invLen2[i];
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = s.ax[i] + t * s.dx[i], qz = s.az[i] + t * s.dz[i];
    const ox = x - qx, oz = z - qz;
    const d2 = ox * ox + oz * oz;
    if (d2 < out.distanceSq) {
      out.segment = i; out.t = t; out.distanceSq = d2; out.qx = qx; out.qz = qz;
    }
  }
  return out;
}

function wearForEdge(edge, x, z, sample) {
  sampleEdge(edge, x, z, sample);
  if (sample.segment < 0 || sample.distanceSq >= edge.width * edge.width) return 0;
  const distance = Math.sqrt(sample.distanceSq);
  return edge.wear * (1 - smoothstep(edge.width * 0.35, edge.width, distance));
}

// Compatibility scalar used by all existing terrain and vegetation systems.
/**
 * A point and frame at a distance along an edge. Shared so a structure carried
 * BY a trail — a bridge deck, most of all — can be laid along the path itself
 * rather than along a straight line between its ends.
 */
export function trailFrameAtArc(edge, arc, out = {}) {
  const s = edge.segments;
  const d = Math.max(0, Math.min(edge.arcLength, arc));
  let i = 0;
  while (i < s.count - 1 && s.arc[i + 1] < d) i++;
  const sl = s.len[i] || 1;
  const t = Math.max(0, Math.min(1, (d - s.arc[i]) / sl));
  out.x = s.ax[i] + s.dx[i] * t; out.z = s.az[i] + s.dz[i] * t;
  out.tangentX = s.dx[i] / sl; out.tangentZ = s.dz[i] / sl;
  out.perpX = -out.tangentZ; out.perpZ = out.tangentX;
  out.arc = d; out.segment = i;
  return out;
}

export function trailWearAt(list, x, z) {
  let wear = 0;
  for (let k = 0; k < list.length; k++) {
    const edge = list[k];
    if (x < edge.minx || x > edge.maxx || z < edge.minz || z > edge.maxz) continue;
    const value = wearForEdge(edge, x, z, edgeSample);
    if (value > wear) wear = value;
  }
  return wear;
}

// Rich nearest-active-trail query. `out` is optional so hot callers can reuse
// one record; overlapping trails retain the strongest wear for compatibility.
export function trailProfileAt(list, x, z, out = {}) {
  out.wear = 0;
  out.distance = Infinity;
  out.signedDistance = Infinity;
  out.tangentX = 0;
  out.tangentZ = 0;
  out.width = 0;
  out.routeClass = null;
  out.edgeId = null;
  out.arcPosition = 0;
  out.arcLength = 0;

  for (let k = 0; k < list.length; k++) {
    const edge = list[k];
    if (x < edge.minx || x > edge.maxx || z < edge.minz || z > edge.maxz) continue;
    const value = wearForEdge(edge, x, z, edgeSample);
    if (value <= out.wear || edgeSample.segment < 0) continue;
    const i = edgeSample.segment;
    const s = edge.segments;
    const sl = s.len[i] || 1;
    const tx = s.dx[i] / sl, tz = s.dz[i] / sl;
    const ox = x - edgeSample.qx, oz = z - edgeSample.qz;
    const distance = Math.sqrt(edgeSample.distanceSq);
    out.wear = value;
    out.distance = distance;
    out.signedDistance = (tx * oz - tz * ox) < 0 ? -distance : distance;
    out.tangentX = tx;
    out.tangentZ = tz;
    out.width = edge.width;
    out.routeClass = edge.routeClass;
    out.edgeId = edge.id;
    out.arcPosition = s.arc[i] + edgeSample.t * sl;
    out.arcLength = edge.arcLength;
  }
  return out;
}

// Unbounded nearest-centreline query for spawn/debug/navigation helpers. Hot
// terrain consumers should use the spatially indexed wear/profile APIs above.
export function nearestTrailPoint(list, x, z, out = {}) {
  out.distance = Infinity;
  out.signedDistance = Infinity;
  out.x = x; out.z = z;
  out.tangentX = 0; out.tangentZ = -1;
  out.width = 0; out.peakWear = 0;
  out.arcPosition = 0; out.arcLength = 0;
  out.edgeId = null; out.routeClass = null;
  for (let k = 0; k < list.length; k++) {
    const edge = list[k], s = edge.segments;
    for (let i = 0; i < s.count; i++) {
      let t = ((x - s.ax[i]) * s.dx[i] + (z - s.az[i]) * s.dz[i]) * s.invLen2[i];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = s.ax[i] + t * s.dx[i], qz = s.az[i] + t * s.dz[i];
      const distance = Math.hypot(x - qx, z - qz);
      if (distance >= out.distance) continue;
      const sl = s.len[i] || 1;
      out.distance = distance;
      out.x = qx; out.z = qz;
      out.tangentX = s.dx[i] / sl; out.tangentZ = s.dz[i] / sl;
      const ox = x - qx, oz = z - qz;
      out.signedDistance = (out.tangentX * oz - out.tangentZ * ox) < 0 ? -distance : distance;
      out.width = edge.width; out.peakWear = edge.wear;
      out.arcPosition = s.arc[i] + t * sl; out.arcLength = edge.arcLength;
      out.edgeId = edge.id; out.routeClass = edge.routeClass;
    }
  }
  return out;
}

// Phase-5 ecology profile, deliberately extending beyond the rendered surface
// into inner/outer verges. It is based on signed centreline distance, so both
// sides can receive deterministic but asymmetric roots, flowers and bypasses.
const ECOLOGY_PROFILE = Object.freeze({
  primary: Object.freeze({ core: 0.70, inner: 0.40, outer: 5.0,
    coreGrass: 0.0, coreHeight: 0.28, innerGrass: 0.0, innerHeight: 0.38,
    corePlants: 0.0, innerPlants: 0.18, outerPlants: 1.32 }),
  secondary: Object.freeze({ core: 0.65, inner: 0.35, outer: 3.8,
    coreGrass: 0.0, coreHeight: 0.30, innerGrass: 0.0, innerHeight: 0.42,
    corePlants: 0.0, innerPlants: 0.22, outerPlants: 1.22 }),
  faint: Object.freeze({ core: 0.58, inner: 0.28, outer: 2.5,
    coreGrass: 0.0, coreHeight: 0.34, innerGrass: 0.0, innerHeight: 0.48,
    corePlants: 0.0, innerPlants: 0.28, outerPlants: 1.10 }),
});

// Shared by the analytical CPU vegetation and the rasterized GPU grass mask.
// `bare` is the grass-free tread; `full` is where ordinary grass has completely
// returned beyond the softly encroaching shoulder.
export function trailGrassBands(edge, out = {}) {
  const profile = ECOLOGY_PROFILE[edge.routeClass] || ECOLOGY_PROFILE.faint;
  out.bare = edge.width * profile.core;
  out.full = edge.width + profile.inner;
  return out;
}

// Rasterize analytical trail capsules into a normalized grass-coverage mask.
// This is deliberately THREE-free so the same deterministic profile can be
// regression-tested and consumed by the GPU grass field without importing its
// renderer. Overlapping paths retain the strongest (lowest) suppression.
export function rasterizeTrailGrassMask(trails, minX, minZ, cover, size, out) {
  out.fill(255);
  const texel = cover / (size - 1);
  const bands = {};
  for (const edge of trails) {
    trailGrassBands(edge, bands);
    const outer = bands.full;
    const transition = Math.max(0.08, bands.full - bands.bare);
    const segments = edge.segments;
    for (let segment = 0; segment < segments.count; segment++) {
      const ax = segments.ax[segment], az = segments.az[segment];
      const dx = segments.dx[segment], dz = segments.dz[segment];
      const invLen2 = segments.invLen2[segment];
      const bx = ax + dx, bz = az + dz;
      const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - outer - minX) / texel));
      const ix1 = Math.min(size - 1, Math.ceil((Math.max(ax, bx) + outer - minX) / texel));
      const iz0 = Math.max(0, Math.floor((Math.min(az, bz) - outer - minZ) / texel));
      const iz1 = Math.min(size - 1, Math.ceil((Math.max(az, bz) + outer - minZ) / texel));
      if (ix1 < ix0 || iz1 < iz0) continue;
      for (let iz = iz0; iz <= iz1; iz++) {
        const z = minZ + iz * texel;
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = minX + ix * texel;
          let t = ((x - ax) * dx + (z - az) * dz) * invLen2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const distance = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
          if (distance >= bands.full) continue;
          const raw = Math.max(0, Math.min(1, (distance - bands.bare) / transition));
          const coverage = raw * raw * (3 - 2 * raw);
          const value = Math.round(coverage * 255);
          const index = iz * size + ix;
          if (value < out[index]) out[index] = value;
        }
      }
    }
  }
  return out;
}

export function trailEcologyAt(list, x, z, out = {}) {
  nearestTrailPoint(list, x, z, out);
  out.zone = 'none';
  out.grassDensity = 1; out.grassHeight = 1; out.plantDensity = 1;
  out.coreRadius = 0; out.innerRadius = 0; out.outerRadius = 0;
  if (!out.edgeId) return out;
  const p = ECOLOGY_PROFILE[out.routeClass] || ECOLOGY_PROFILE.faint;
  const d = out.distance;
  const core = out.width * p.core;
  const inner = out.width + p.inner;
  const outer = out.width + p.outer;
  out.coreRadius = core; out.innerRadius = inner; out.outerRadius = outer;
  if (d > outer) return out;
  if (d <= core) {
    const t = core > 0.01 ? d / core : 1;
    out.zone = 'core';
    out.grassDensity = p.coreGrass;
    out.grassHeight = p.coreHeight + t * (p.innerHeight - p.coreHeight) * 0.25;
    out.plantDensity = p.corePlants;
  } else if (d <= inner) {
    const t = smoothstep(core, inner, d);
    out.zone = 'inner';
    out.grassDensity = p.innerGrass + t * (1 - p.innerGrass);
    out.grassHeight = p.innerHeight + t * (0.9 - p.innerHeight);
    out.plantDensity = p.innerPlants + t * (0.9 - p.innerPlants);
  } else {
    const t = smoothstep(inner, outer, d);
    out.zone = 'outer';
    out.grassDensity = 1 + (1 - t) * 0.08;
    out.grassHeight = 0.9 + t * 0.1;
    out.plantDensity = p.outerPlants + t * (1 - p.outerPlants);
  }
  return out;
}
