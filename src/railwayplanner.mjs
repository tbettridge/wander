import { ClosedRailRoute } from './railwayroute.mjs';

const TAU = Math.PI * 2;
const LANE_COUNT = 17;
const LANE_CENTRE = (LANE_COUNT - 1) >> 1;
const MAX_LANE_STEP = 2;
const SLICE_LENGTH = 150;
const ROUTE_SAMPLE_SPACING = 38;
const CORRIDOR_MIN = 360;
const CORRIDOR_MAX = 820;
const TARGET_GRADE = 0.018;
const MAX_FORMATION_GRADE = 0.032;
const MIN_CURVE_RADIUS = 190;
const STATION_APPROACH_LENGTH = 230;

const BIOME_COST = Object.freeze({
  grassland: 0,
  savanna: 0.02,
  beach: 0.035,
  desert: 0.045,
  forest: 0.08,
  taiga: 0.09,
  tundra: 0.11,
  jungle: 0.16,
  snow: 0.32,
  ocean: 20,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hash01(seed, a, b = 0) {
  let n = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 11, 0x85ebca77)) >>> 0;
  n ^= n >>> 16;
  n = Math.imul(n, 0x7feb352d) >>> 0;
  n ^= n >>> 15;
  n = Math.imul(n, 0x846ca68b) >>> 0;
  n ^= n >>> 16;
  return n / 4294967296;
}

function landmarkPenalty(exclusions, x, z) {
  let penalty = 0;
  for (let i = 0; i < exclusions.length; i++) {
    const item = exclusions[i];
    const clearance = (item.halo || 20) + (item.type === 'giant' ? 75 : 38);
    const distance = Math.hypot(x - item.x, z - item.z);
    if (distance < clearance) penalty += 18000 * (1 - distance / clearance) ** 2;
  }
  return penalty;
}

function surveySite(world, x, z, exclusions = []) {
  const biome = world.biomeAt(x, z);
  const river = world.riverAt(x, z);
  const ocean = biome.h < 0.4 && !river.wet;
  return {
    x,
    z,
    h: biome.h,
    slope: biome.slope,
    biome: biome.id,
    wet: river.wet,
    waterDepth: river.wet ? river.depth : 0,
    ocean,
    exclusionPenalty: landmarkPenalty(exclusions, x, z),
  };
}

function stationScore(world, x, z, exclusions) {
  const site = surveySite(world, x, z, exclusions);
  if (site.ocean || site.wet || site.h < 2.5) return { score: 1e12, site };
  let minH = site.h, maxH = site.h;
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI * 0.5;
    const h = world.height(x + Math.cos(angle) * 32, z + Math.sin(angle) * 32);
    minH = Math.min(minH, h);
    maxH = Math.max(maxH, h);
  }
  const localRelief = maxH - minH;
  const biome = BIOME_COST[site.biome] ?? 0.14;
  const altitudePenalty = Math.max(0, site.h - 130) * 2.2;
  const score = site.slope * 5200 + localRelief * 180 + biome * 1600
    + altitudePenalty + site.exclusionPenalty;
  return { score, site: { ...site, localRelief } };
}

function regionalCenterScore(world, x, z, radius) {
  let score = 0;
  const center = surveySite(world, x, z);
  if (center.ocean) score += 14000;
  for (let i = 0; i < 24; i++) {
    const angle = i / 24 * TAU;
    const radialScale = i % 2 === 0 ? 0.88 : 1.08;
    const site = surveySite(
      world,
      x + Math.cos(angle) * radius * radialScale,
      z + Math.sin(angle) * radius * radialScale,
    );
    if (site.ocean) score += 2400;
    else if (site.wet) score += 700;
    score += site.slope * 420;
    score += Math.max(0, site.h - 170) * 0.8;
  }
  return score;
}

export function selectRegionalRailwayCenter(world, requestedCenter, {
  seed = world.seed ?? 1,
  radius = 3400,
  searchRadius = 9000,
} = {}) {
  let best = null;
  for (let ring = 0; ring <= 4; ring++) {
    const distance = ring / 4 * searchRadius;
    const count = ring === 0 ? 1 : 16;
    for (let i = 0; i < count; i++) {
      const angle = hash01(seed, ring, 701) * TAU + i / count * TAU;
      const x = requestedCenter.x + Math.cos(angle) * distance;
      const z = requestedCenter.z + Math.sin(angle) * distance;
      const score = regionalCenterScore(world, x, z, radius) + distance * 0.035;
      if (!best || score < best.score) best = { x, z, score, offset: distance };
    }
  }
  return best;
}

export function placeRegionalStations(world, {
  center = { x: 0, z: 0 },
  seed = world.seed ?? 1,
  stationCount = 5,
  radius = 3400,
  exclusions = [],
} = {}) {
  const count = clamp(Math.round(stationCount), 4, 6);
  const phase = hash01(seed, 91) * TAU;
  const stations = [];
  for (let i = 0; i < count; i++) {
    const baseAngle = phase + i / count * TAU;
    let best = null;
    for (let attempt = 0; attempt < 72; attempt++) {
      // Coastal or island regions may not offer land on a narrow geometric
      // ring. Search most of each station's sector and a broad radial band,
      // while the score below still favours the intended regional radius.
      const angularJitter = (hash01(seed, i, attempt * 3) - 0.5) * (TAU / count) * 0.68;
      const radialScale = 0.78 + hash01(seed, i, attempt * 3 + 1) * 0.42;
      const angle = baseAngle + angularJitter;
      const candidateRadius = radius * radialScale;
      const x = center.x + Math.cos(angle) * candidateRadius;
      const z = center.z + Math.sin(angle) * candidateRadius;
      const result = stationScore(world, x, z, exclusions);
      // Keep candidates in their intended sector instead of allowing every
      // station to collapse onto the same attractive plain.
      result.score += Math.abs(angularJitter) * 110 + Math.abs(radialScale - 1) * 260;
      if (!best || result.score < best.score) {
        best = { ...result.site, score: result.score, angle, radius: candidateRadius };
      }
    }
    stations.push({
      id: `station-${i + 1}`,
      index: i,
      x: best.x,
      y: best.h,
      z: best.z,
      biome: best.biome,
      slope: best.slope,
      localRelief: best.localRelief ?? 0,
      suitability: best.score,
      tangentX: -Math.sin(best.angle),
      tangentZ: Math.cos(best.angle),
    });
  }
  return stations;
}

function sitePenalty(site) {
  let penalty = (BIOME_COST[site.biome] ?? 0.14) * 34;
  penalty += site.slope * site.slope * 110;
  penalty += site.exclusionPenalty;
  if (site.ocean) penalty += 160000;
  if (site.wet) penalty += 1800 + site.waterDepth * site.waterDepth * 6200;
  return penalty;
}

function transitionCost(a, b, deviation) {
  const run = Math.max(1, Math.hypot(b.x - a.x, b.z - a.z));
  const grade = Math.abs(b.h - a.h) / run;
  const overTarget = Math.max(0, grade - TARGET_GRADE);
  const overMax = Math.max(0, grade - MAX_FORMATION_GRADE);
  const terrain = run * (1
    + grade * grade * 620
    + overTarget * overTarget * 2800
    + overMax * overMax * 48000
    + deviation * deviation * 0.08);
  return terrain + run * (sitePenalty(a) * 0.24 + sitePenalty(b) * 0.62);
}

function turnCost(a, b, c) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const bcx = c.x - b.x, bcz = c.z - b.z;
  const ab = Math.max(1, Math.hypot(abx, abz));
  const bc = Math.max(1, Math.hypot(bcx, bcz));
  const dot = clamp((abx * bcx + abz * bcz) / (ab * bc), -1, 1);
  const angle = Math.acos(dot);
  const radius = angle > 1e-5 ? Math.min(ab, bc) / angle : 1e9;
  const shortfall = Math.max(0, MIN_CURVE_RADIUS - radius) / MIN_CURVE_RADIUS;
  return angle * angle * 240 + shortfall * shortfall * 18000;
}

function makeCorridorRows(world, from, to, exclusions) {
  const straight = Math.max(1, Math.hypot(to.x - from.x, to.z - from.z));
  const ux = (to.x - from.x) / straight, uz = (to.z - from.z) / straight;
  const px = -uz, pz = ux;
  const slices = Math.max(5, Math.ceil(straight / SLICE_LENGTH));
  const halfWidth = clamp(straight * 0.17, CORRIDOR_MIN, CORRIDOR_MAX);
  const rows = new Array(slices + 1);
  for (let i = 0; i <= slices; i++) {
    const t = i / slices;
    const envelope = Math.pow(Math.sin(Math.PI * t), 0.72);
    const bx = from.x + (to.x - from.x) * t;
    const bz = from.z + (to.z - from.z) * t;
    const row = rows[i] = new Array(LANE_COUNT);
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      if ((i === 0 || i === slices) && lane !== LANE_CENTRE) {
        row[lane] = null;
        continue;
      }
      const offset = (lane - LANE_CENTRE) / LANE_CENTRE * halfWidth * envelope;
      row[lane] = surveySite(world, bx + px * offset, bz + pz * offset, exclusions);
    }
  }
  return { rows, slices };
}

function solveStationSegment(world, from, to, exclusions) {
  const departure = surveySite(
    world,
    from.x + from.tangentX * STATION_APPROACH_LENGTH,
    from.z + from.tangentZ * STATION_APPROACH_LENGTH,
    exclusions,
  );
  const arrival = surveySite(
    world,
    to.x - to.tangentX * STATION_APPROACH_LENGTH,
    to.z - to.tangentZ * STATION_APPROACH_LENGTH,
    exclusions,
  );
  const { rows, slices } = makeCorridorRows(world, departure, arrival, exclusions);
  const stateCount = LANE_COUNT * LANE_COUNT;
  let costs = new Float64Array(stateCount); costs.fill(Infinity);
  const parents = new Array(slices + 1);
  parents[1] = new Int16Array(stateCount); parents[1].fill(-1);

  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const node = rows[1][lane];
    if (!node) continue;
    const state = LANE_CENTRE * LANE_COUNT + lane;
    costs[state] = transitionCost(rows[0][LANE_CENTRE], node,
      Math.abs(lane - LANE_CENTRE) / LANE_CENTRE);
  }

  for (let rowIndex = 1; rowIndex < slices; rowIndex++) {
    const nextCosts = new Float64Array(stateCount); nextCosts.fill(Infinity);
    const parent = parents[rowIndex + 1] = new Int16Array(stateCount); parent.fill(-1);
    for (let state = 0; state < stateCount; state++) {
      if (!Number.isFinite(costs[state])) continue;
      const previousLane = Math.floor(state / LANE_COUNT);
      const lane = state % LANE_COUNT;
      const a = rows[rowIndex - 1][previousLane];
      const b = rows[rowIndex][lane];
      if (!a || !b) continue;
      const endRow = rowIndex + 1 === slices;
      const minLane = endRow ? LANE_CENTRE : Math.max(0, lane - MAX_LANE_STEP);
      const maxLane = endRow ? LANE_CENTRE : Math.min(LANE_COUNT - 1, lane + MAX_LANE_STEP);
      for (let nextLane = minLane; nextLane <= maxLane; nextLane++) {
        const c = rows[rowIndex + 1][nextLane];
        if (!c) continue;
        const nextState = lane * LANE_COUNT + nextLane;
        const deviation = Math.abs(nextLane - LANE_CENTRE) / LANE_CENTRE;
        const cost = costs[state] + transitionCost(b, c, deviation) + turnCost(a, b, c);
        if (cost < nextCosts[nextState]) {
          nextCosts[nextState] = cost;
          parent[nextState] = state;
        }
      }
    }
    costs = nextCosts;
  }

  let bestState = -1, bestCost = Infinity;
  for (let previousLane = 0; previousLane < LANE_COUNT; previousLane++) {
    const state = previousLane * LANE_COUNT + LANE_CENTRE;
    if (costs[state] < bestCost) { bestCost = costs[state]; bestState = state; }
  }
  if (bestState < 0) throw new Error(`No railway corridor between ${from.id} and ${to.id}`);

  const lanes = new Int16Array(slices + 1);
  let state = bestState;
  for (let rowIndex = slices; rowIndex >= 1; rowIndex--) {
    lanes[rowIndex] = state % LANE_COUNT;
    lanes[rowIndex - 1] = Math.floor(state / LANE_COUNT);
    state = parents[rowIndex][state];
    if (rowIndex > 1 && state < 0) throw new Error('Railway corridor backtrack failed');
  }
  let nodes = Array.from(lanes, (lane, i) => rows[i][lane]);

  // Conservative planar relaxation removes lane chatter while preserving the
  // surveyed station endpoints and resampling terrain at every accepted node.
  for (let pass = 0; pass < 3; pass++) {
    const next = nodes.slice();
    for (let i = 1; i < nodes.length - 1; i++) {
      const p = nodes[i - 1], c = nodes[i], n = nodes[i + 1];
      const x = p.x * 0.22 + c.x * 0.56 + n.x * 0.22;
      const z = p.z * 0.22 + c.z * 0.56 + n.z * 0.22;
      const candidate = surveySite(world, x, z, exclusions);
      if (candidate.ocean && !c.ocean) continue;
      next[i] = candidate;
    }
    nodes = next;
  }
  nodes.unshift(surveySite(world, from.x, from.z, exclusions));
  nodes.push(surveySite(world, to.x, to.z, exclusions));
  return { nodes, cost: bestCost };
}

function resampleOpenSegment(world, nodes, exclusions) {
  const arc = new Float64Array(nodes.length);
  for (let i = 1; i < nodes.length; i++) {
    arc[i] = arc[i - 1] + Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z);
  }
  const length = arc[arc.length - 1];
  const count = Math.max(2, Math.ceil(length / ROUTE_SAMPLE_SPACING));
  const result = new Array(count + 1);
  let segment = 1;
  for (let i = 0; i <= count; i++) {
    const distance = length * i / count;
    while (segment < arc.length - 1 && arc[segment] < distance) segment++;
    const a = nodes[segment - 1], b = nodes[segment];
    const span = Math.max(1e-6, arc[segment] - arc[segment - 1]);
    const t = clamp((distance - arc[segment - 1]) / span, 0, 1);
    result[i] = surveySite(
      world,
      a.x + (b.x - a.x) * t,
      a.z + (b.z - a.z) * t,
      exclusions,
    );
  }
  return result;
}

function smoothClosedAlignment(world, points, exclusions) {
  let current = points;
  for (let pass = 0; pass < 30; pass++) {
    const next = current.slice();
    for (let i = 0; i < current.length; i++) {
      // Stations remain exact surveyed anchors. Their neighbouring samples are
      // free to move, allowing the independently solved corridors to develop a
      // common tangent instead of meeting in a visible polygonal corner.
      if (current[i].stationIndex !== undefined) continue;
      const previous = current[(i - 1 + current.length) % current.length];
      const point = current[i];
      const following = current[(i + 1) % current.length];
      const x = previous.x * 0.24 + point.x * 0.52 + following.x * 0.24;
      const z = previous.z * 0.24 + point.z * 0.52 + following.z * 0.24;
      const candidate = surveySite(world, x, z, exclusions);
      next[i] = candidate;
    }
    current = next;
  }
  return current;
}

function solveFormation(points) {
  const count = points.length;
  let heights = Float64Array.from(points, (point) => point.h);
  for (let pass = 0; pass < 4; pass++) {
    const next = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      let total = 0, weight = 0;
      for (let k = -5; k <= 5; k++) {
        const w = 6 - Math.abs(k);
        total += heights[(i + k + count) % count] * w;
        weight += w;
      }
      next[i] = total / weight;
    }
    heights = next;
  }
  for (let i = 0; i < count; i++) {
    if (points[i].stationIndex !== undefined) heights[i] = points[i].h;
  }

  // Project the smoothed profile into the maximum-grade envelope in both
  // directions. Repeated circular sweeps remove dependence on the start index.
  for (let pass = 0; pass < 8; pass++) {
    for (let direction = 0; direction < 2; direction++) {
      for (let step = 0; step < count; step++) {
        const i = direction === 0 ? step : count - 1 - step;
        if (points[i].stationIndex !== undefined) {
          heights[i] = points[i].h;
          continue;
        }
        const previous = (i + (direction === 0 ? -1 : 1) + count) % count;
        const run = Math.max(1, Math.hypot(
          points[i].x - points[previous].x,
          points[i].z - points[previous].z,
        ));
        const limit = MAX_FORMATION_GRADE * run;
        heights[i] = clamp(heights[i], heights[previous] - limit, heights[previous] + limit);
      }
      for (let i = 0; i < count; i++) {
        if (points[i].stationIndex !== undefined) heights[i] = points[i].h;
      }
    }
  }
  return heights;
}

function classifyStructure(point, formationY) {
  const offset = formationY - point.h;
  if (point.ocean || point.wet) return 'bridge';
  if (offset > 5.5) return 'bridge';
  if (offset > 1.35) return 'fill';
  if (offset < -5.5) return 'tunnel';
  if (offset < -1.35) return 'cut';
  return 'surface';
}

function analyzePlan(points, heights) {
  let length = 0, maxGrade = 0, groundMaxGrade = 0, minCurveRadius = Infinity;
  const structures = {
    surface: { count: 0, length: 0 },
    cut: { count: 0, length: 0 },
    fill: { count: 0, length: 0 },
    bridge: { count: 0, length: 0 },
    tunnel: { count: 0, length: 0 },
  };
  let previousKind = null;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const previous = (i - 1 + points.length) % points.length;
    const run = Math.max(1, Math.hypot(points[j].x - points[i].x, points[j].z - points[i].z));
    length += run;
    maxGrade = Math.max(maxGrade, Math.abs(heights[j] - heights[i]) / run);
    groundMaxGrade = Math.max(groundMaxGrade, Math.abs(points[j].h - points[i].h) / run);
    const kind = classifyStructure(points[i], heights[i]);
    points[i].formationY = heights[i];
    points[i].structure = kind;
    structures[kind].length += run;
    if (kind !== previousKind) structures[kind].count++;
    previousKind = kind;

    const ax = points[i].x - points[previous].x, az = points[i].z - points[previous].z;
    const bx = points[j].x - points[i].x, bz = points[j].z - points[i].z;
    const al = Math.max(1, Math.hypot(ax, az)), bl = Math.max(1, Math.hypot(bx, bz));
    const angle = Math.acos(clamp((ax * bx + az * bz) / (al * bl), -1, 1));
    if (angle > 1e-4) minCurveRadius = Math.min(minCurveRadius, Math.min(al, bl) / angle);
  }
  return { length, maxGrade, groundMaxGrade, minCurveRadius, structures };
}

function attachStationDistances(stations, route) {
  for (const station of stations) {
    station.routeDistance = route.nearestDistance(station.x, station.z);
    const sample = route.sampleAtDistance(station.routeDistance, {});
    station.formationY = sample.y;
    station.tangentX = sample.tangentX;
    station.tangentZ = sample.tangentZ;
  }
}

export function planRegionalRailway(world, {
  center = { x: 0, z: 0 },
  seed = world.seed ?? 1,
  stationCount = 5,
  radius = 3400,
  exclusions = [],
} = {}) {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const requestedCenter = { x: center.x, z: center.z };
  const selectedCenter = selectRegionalRailwayCenter(world, requestedCenter, { seed, radius });
  const stations = placeRegionalStations(world, {
    center: selectedCenter, seed, stationCount, radius, exclusions,
  });
  const segmentPlans = [];
  const routePoints = [];
  let searchCost = 0;
  for (let i = 0; i < stations.length; i++) {
    const from = stations[i], to = stations[(i + 1) % stations.length];
    const solved = solveStationSegment(world, from, to, exclusions);
    const sampled = resampleOpenSegment(world, solved.nodes, exclusions);
    sampled[0].stationIndex = i;
    sampled[sampled.length - 1].stationIndex = (i + 1) % stations.length;
    if (i > 0) sampled.shift();
    // The final endpoint repeats station zero and is removed from the closed
    // route representation after retaining the segment metadata.
    if (i === stations.length - 1) sampled.pop();
    routePoints.push(...sampled);
    segmentPlans.push({
      id: `${from.id}:${to.id}`,
      from: from.id,
      to: to.id,
      cost: solved.cost,
      nodeCount: solved.nodes.length,
    });
    searchCost += solved.cost;
  }
  const smoothedRoutePoints = smoothClosedAlignment(world, routePoints, exclusions);
  const heights = solveFormation(smoothedRoutePoints);
  const metrics = analyzePlan(smoothedRoutePoints, heights);
  const positions = new Float64Array(smoothedRoutePoints.length * 3);
  for (let i = 0; i < smoothedRoutePoints.length; i++) {
    positions[i * 3] = smoothedRoutePoints[i].x;
    positions[i * 3 + 1] = heights[i];
    positions[i * 3 + 2] = smoothedRoutePoints[i].z;
  }
  const route = new ClosedRailRoute(positions);
  attachStationDistances(stations, route);
  const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    version: 1,
    seed: seed >>> 0,
    requestedCenter,
    center: { x: selectedCenter.x, z: selectedCenter.z },
    centerOffset: selectedCenter.offset,
    stations,
    segments: segmentPlans,
    points: smoothedRoutePoints,
    route,
    metrics: { ...metrics, searchCost, planningMs: finishedAt - startedAt },
  };
}

export const RAILWAY_PLANNER_LIMITS = Object.freeze({
  minStations: 4,
  maxStations: 6,
  targetMinLength: 15000,
  targetMaxLength: 25000,
  targetGrade: TARGET_GRADE,
  maxFormationGrade: MAX_FORMATION_GRADE,
  minCurveRadius: MIN_CURVE_RADIUS,
});
