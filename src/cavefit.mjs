// Terrain-aware finalization for Phase-2 cave graphs. Generation remains a
// world-independent grammar; this stage bends and lowers only the distant
// interior so long caves stay under the actual hillside selected at runtime.

import { deriveCaveVolume, refreshCaveRegionBounds, refreshChamberThroughYaw, validateCaveGraph } from './cavegen.mjs';

function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }
function smoothstep01(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}
function round6(value) { return Math.round(value * 1e6) / 1e6; }
function cloneGraph(graph) { return JSON.parse(JSON.stringify(graph)); }

// Measure the shallowest roof cover at one local-Z plane of the entrance.
// Marching down from above the terrain finds the first cave-air crossing, so
// stacked/deeper passages cannot masquerade as the visible entrance roof.
// The result is renderer-independent and can therefore guard both generation
// tests and the streamed-mesh handoff used by CaveExperiment.
export function caveEntranceRoofCover(field, surfaceYAt, entrance, localZ, {
  halfWidth = Math.max(6.0, (entrance?.rx || 4) + 1.6),
  lateralStep = 0.55,
  verticalStep = 0.16,
  maxAbove = Math.max(7.0, (entrance?.ry || 3) + 3.5),
  scanDepth = 9.0,
} = {}) {
  const sdf = field?.entranceSdf || field?.sdf || field;
  if (typeof sdf !== 'function' || typeof surfaceYAt !== 'function') {
    throw new Error('Entrance roof cover requires a cave field and surfaceYAt(x, z)');
  }
  let minCover = Infinity, worstX = 0, roofY = null, samples = 0;
  const lateralSamples = Math.max(2, Math.ceil((halfWidth * 2) / lateralStep));
  for (let index = 0; index <= lateralSamples; index++) {
    const x = -halfWidth + index / lateralSamples * halfWidth * 2;
    const surfaceY = surfaceYAt(x, localZ);
    if (!Number.isFinite(surfaceY)) continue;
    samples++;
    let previousY = surfaceY + maxAbove;
    let previousValue = sdf(x, previousY, localZ);
    let crossing = null;
    if (previousValue < 0) {
      crossing = previousY;
    } else {
      const bottom = surfaceY - scanDepth;
      for (let y = previousY - verticalStep; y >= bottom; y -= verticalStep) {
        const value = sdf(x, y, localZ);
        if (value < 0 && previousValue >= 0) {
          let high = previousY, low = y;
          for (let iteration = 0; iteration < 12; iteration++) {
            const middle = (high + low) * 0.5;
            if (sdf(x, middle, localZ) < 0) low = middle;
            else high = middle;
          }
          crossing = (high + low) * 0.5;
          break;
        }
        previousY = y;
        previousValue = value;
      }
    }
    const cover = crossing === null ? scanDepth : surfaceY - crossing;
    if (cover < minCover) {
      minCover = cover;
      worstX = x;
      roofY = crossing;
    }
  }
  return { localZ, minCover, worstX, roofY, samples };
}

// Pick the first handoff band whose complete entrance cross-section remains
// safely underground for several metres. Fixed Z constants regressed when the
// terrain grammar gained low sea cliffs: the generic passage became visible
// before the terrain had buried it. Keep a conservative old-depth floor, but
// allow deeper collars where the actual fitted terrain requires one.
export function planCaveEntranceHandoff(field, surfaceYAt, entrance, {
  minAlong = 24.5,
  maxAlong = 44.0,
  sampleStep = 0.75,
  requiredCover = 1.35,
  stableLength = 4.5,
  overlap = 0.8,
  fadeLength = 4.0,
  boundaryMargin = 2.5,
} = {}) {
  const mouthZ = entrance?.mouth?.[2] ?? entrance?.b?.[2] ?? -36;
  const profile = [];
  for (let along = minAlong; along <= maxAlong + 1e-6; along += sampleStep) {
    profile.push(caveEntranceRoofCover(field, surfaceYAt, entrance, mouthZ + along));
  }
  const stableSamples = Math.max(1, Math.ceil(stableLength / sampleStep));
  let selected = -1;
  for (let index = 0; index + stableSamples < profile.length; index++) {
    let safe = true;
    for (let offset = 0; offset <= stableSamples; offset++) {
      if (profile[index + offset].minCover < requiredCover) { safe = false; break; }
    }
    if (safe) { selected = index; break; }
  }
  const safe = selected >= 0;
  if (!safe) selected = profile.length - 1;
  const fadeStartAlong = minAlong + selected * sampleStep;
  const fadeEndAlong = fadeStartAlong + fadeLength;
  return {
    safe,
    requiredCover,
    streamStartAlong: Math.max(minAlong, fadeStartAlong - overlap),
    fadeStartAlong,
    fadeEndAlong,
    collarEndAlong: fadeEndAlong + boundaryMargin,
    selectedCover: profile[selected]?.minCover ?? -Infinity,
    profile,
  };
}

// Measure the narrowest band of solid cave rock on one lateral boundary of
// the entrance fold. The heightfield has no volume below its top surface, so a
// cave wall that reaches an X boundary of the non-capped implicit box becomes
// a literal see-through hole. Inspect the fully opaque collar; beyond the
// handoff start the wall is already continuously buried and dithers into the
// overlapping streamed shell, so following a widening interior chamber there
// would inflate the facade without improving the exterior silhouette.
export function caveEntranceLateralClearance(
  field,
  surfaceYAt,
  entrance,
  localX,
  {
    minAlong = -4.9,
    maxAlong = 28.5,
    minY,
    maxY,
    axialStep = 0.45,
    verticalStep = 0.28,
    surfaceInset = 0.08,
  } = {},
) {
  const sdf = field?.entranceSdf || field?.sdf || field;
  if (typeof sdf !== 'function' || typeof surfaceYAt !== 'function'
    || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
    throw new Error('Entrance lateral clearance requires a cave field, surface, and finite Y bounds');
  }
  const mouthZ = entrance?.mouth?.[2] ?? entrance?.b?.[2] ?? -36;
  const axialSamples = Math.max(1, Math.ceil((maxAlong - minAlong) / axialStep));
  let clearance = Infinity, worst = null, samples = 0;
  for (let iz = 0; iz <= axialSamples; iz++) {
    const along = minAlong + iz / axialSamples * (maxAlong - minAlong);
    const localZ = mouthZ + along;
    const surfaceY = surfaceYAt(localX, localZ);
    const top = Math.min(maxY, surfaceY - surfaceInset);
    if (!Number.isFinite(top) || top <= minY) continue;
    const verticalSamples = Math.max(1, Math.ceil((top - minY) / verticalStep));
    for (let iy = 0; iy <= verticalSamples; iy++) {
      const localY = minY + iy / verticalSamples * (top - minY);
      const distance = sdf(localX, localY, localZ);
      samples++;
      if (distance < clearance) {
        clearance = distance;
        worst = { localX, localY, localZ, along, surfaceY };
      }
    }
  }
  return { localX, clearance, worst, samples };
}

// Grow each side independently until the entire visible collar boundary lies
// inside a deterministic safety band of solid cave rock. Asymmetric sizing is
// important: bends should pay only for the side they approach, keeping the
// entrance mesh compact and its sampling density stable.
export function planCaveEntranceLateralBounds(field, surfaceYAt, entrance, handoff, {
  baseHalfWidth = 6.35,
  maxHalfWidth = 16.35,
  expansionStep = 0.5,
  requiredClearance = 0.8,
  minAlong = -4.9,
  maxAlong = handoff?.fadeStartAlong ?? 24.5,
  minY,
  maxY,
  axialStep = 0.45,
  verticalStep = 0.28,
} = {}) {
  const common = { minAlong, maxAlong, minY, maxY, axialStep, verticalStep };
  const choose = (direction) => {
    let extent = baseHalfWidth;
    let report = caveEntranceLateralClearance(
      field, surfaceYAt, entrance, direction * extent, common,
    );
    while (report.clearance < requiredClearance
      && extent + expansionStep <= maxHalfWidth + 1e-9) {
      extent += expansionStep;
      report = caveEntranceLateralClearance(
        field, surfaceYAt, entrance, direction * extent, common,
      );
    }
    return { extent: round6(extent), safe: report.clearance >= requiredClearance, report };
  };
  const negative = choose(-1), positive = choose(1);
  return {
    minX: -negative.extent,
    maxX: positive.extent,
    safe: negative.safe && positive.safe,
    requiredClearance,
    minClearance: Math.min(negative.report.clearance, positive.report.clearance),
    negative,
    positive,
  };
}

function nodeDistances(graph, startNodeId) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    const a = nodeById.get(edge.a), b = nodeById.get(edge.b);
    if (!a || !b) continue;
    const distance = Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]);
    adjacency.get(a.id).push({ id: b.id, distance });
    adjacency.get(b.id).push({ id: a.id, distance });
  }
  const distances = new Map(graph.nodes.map((node) => [node.id, Infinity]));
  distances.set(startNodeId, 0);
  const pending = new Set(distances.keys());
  while (pending.size) {
    let current = null, best = Infinity;
    for (const id of pending) {
      const distance = distances.get(id);
      if (distance < best) { best = distance; current = id; }
    }
    if (current === null) break;
    pending.delete(current);
    for (const neighbor of adjacency.get(current) || []) {
      const candidate = best + neighbor.distance;
      if (candidate < distances.get(neighbor.id)) distances.set(neighbor.id, candidate);
    }
  }
  return distances;
}

// Deformation post-pass: the entrance-anchored blend zone shifts edge
// endpoints by different factors, so compress/lower can locally push a grade
// past the walkability cap even when the uniform zone is safe. Walk edges
// outward from the entrance (BFS discovery order — deterministic) and pull
// each offending edge's far node back to the cap. A few passes propagate the
// correction; loop cycles that still disagree are caught by validation.
function relaxGrades(graph, cap = 0.176) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    adjacency.get(edge.a)?.push({ other: edge.b });
    adjacency.get(edge.b)?.push({ other: edge.a });
  }
  const order = [];
  const seen = new Set([graph.entranceNodeId, graph.mainPath?.[1]].filter(Boolean));
  const queue = [...seen];
  while (queue.length) {
    const id = queue.shift();
    for (const { other } of adjacency.get(id) || []) {
      if (seen.has(other)) continue;
      seen.add(other);
      order.push({ near: id, far: other });
      queue.push(other);
    }
  }
  const fixed = new Set([graph.entranceNodeId, graph.mainPath?.[1]].filter(Boolean));
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const { near, far } of order) {
      if (fixed.has(far)) continue;
      const a = nodeById.get(near), b = nodeById.get(far);
      if (!a || !b) continue;
      const horizontal = Math.max(1e-6, Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]));
      const rise = b.p[1] - a.p[1];
      const limit = horizontal * cap;
      if (Math.abs(rise) > limit) {
        b.p[1] = round6(a.p[1] + Math.sign(rise) * limit);
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const chamber of graph.chambers) {
    const node = nodeById.get(chamber.nodeId);
    if (!node) continue;
    chamber.c = [...node.p];
    chamber.floorY = round6(chamber.c[1] - chamber.connectorRy + chamber.floorLift);
  }
  return graph;
}

function refreshGraphGeometry(graph) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    const a = nodeById.get(edge.a), b = nodeById.get(edge.b);
    const horizontal = Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]);
    edge.length = round6(Math.hypot(horizontal, b.p[1] - a.p[1]));
    edge.grade = round6(Math.abs(b.p[1] - a.p[1]) / Math.max(horizontal, 1e-6));
  }
  const ys = graph.nodes.map((node) => node.p[1]);
  graph.verticalRelief = round6(Math.max(...ys) - Math.min(...ys));
  if (graph.budget) {
    graph.budget.targetMainLength = round6(graph.edges
      .filter((edge) => edge.route === 'main')
      .reduce((sum, edge) => sum + edge.length, 0));
    graph.budget.targetTotalLength = round6(graph.edges
      .reduce((sum, edge) => sum + edge.length, 0));
    const root = nodeById.get(graph.entranceNodeId), goal = nodeById.get(graph.goalNodeId);
    if (root && goal) graph.budget.targetDrop = round6(root.p[1] - goal.p[1]);
  }
  graph.volume = deriveCaveVolume(graph);
  graph.bounds = { ...graph.volume.bounds };
  refreshCaveRegionBounds(graph);   // membership is topology; bounds follow geometry
  refreshChamberThroughYaw(graph);  // form features re-align to the deformed route
  // fitting stages run before terrainFit is attached — pass fitted explicitly
  // so size floors relax the same way they will on the final fitted graph
  graph.validation = validateCaveGraph(graph, { fitted: true });
  return graph;
}

export function bendCaveInterior(graph, angle, bendDistance = 42) {
  if (Math.abs(angle) < 1e-9) return refreshGraphGeometry(cloneGraph(graph));
  const result = cloneGraph(graph);
  const pivotId = result.mainPath[1] || result.entranceNodeId;
  const pivot = result.nodes.find((node) => node.id === pivotId)?.p;
  if (!pivot) return refreshGraphGeometry(result);
  const distances = nodeDistances(result, pivotId);
  const fixedIds = new Set(result.mainPath.slice(0, 2));
  const angleByNode = new Map();
  for (const node of result.nodes) {
    const factor = fixedIds.has(node.id) ? 0 : smoothstep01((distances.get(node.id) || 0) / bendDistance);
    const localAngle = angle * factor;
    angleByNode.set(node.id, localAngle);
    if (factor <= 0) continue;
    const cos = Math.cos(localAngle), sin = Math.sin(localAngle);
    const x = node.p[0] - pivot[0], z = node.p[2] - pivot[2];
    node.p[0] = round6(pivot[0] + cos * x + sin * z);
    node.p[2] = round6(pivot[2] - sin * x + cos * z);
  }
  const nodeById = new Map(result.nodes.map((node) => [node.id, node]));
  for (const chamber of result.chambers) {
    chamber.c = [...nodeById.get(chamber.nodeId).p];
    chamber.yaw = round6((chamber.yaw || 0) + (angleByNode.get(chamber.nodeId) || 0));
  }
  return refreshGraphGeometry(result);
}

// Pull the distant interior horizontally toward the entrance pivot. The V3
// networks spread ~2× the footprint of the caves the bend/lower pair was
// tuned on, and lowering alone cannot fix a tail that clears the far side of
// a hill: grade headroom (0.18 cap minus the base grade) times the ramp
// distance bounds the reachable drop. Compression shrinks the footprint
// instead; grades steepen by 1/factor and validation vetoes what breaks.
export function compressCaveInterior(graph, factor, bendDistance = 42) {
  if (factor >= 0.999999) return refreshGraphGeometry(cloneGraph(graph));
  const result = cloneGraph(graph);
  const pivotId = result.mainPath[1] || result.entranceNodeId;
  const pivot = result.nodes.find((node) => node.id === pivotId)?.p;
  if (!pivot) return refreshGraphGeometry(result);
  // Horizontal-only compression steepens every grade by 1/factor and slams
  // into the 0.18 walkability cap. Co-scale the vertical by as much as the
  // steepest edge's headroom allows (with margin kept for later lowering), so
  // strong squeezes stay walkable while retaining as much depth as legal —
  // depth is what buys terrain cover.
  const maxBaseGrade = Math.max(1e-6, ...result.edges.map((edge) => edge.grade || 0));
  const verticalFactor = Math.min(1, factor * Math.min(1.3, 0.172 / maxBaseGrade));
  const distances = nodeDistances(result, pivotId);
  const fixedIds = new Set(result.mainPath.slice(0, 2));
  for (const node of result.nodes) {
    const w = fixedIds.has(node.id) ? 0 : smoothstep01((distances.get(node.id) || 0) / bendDistance);
    if (w <= 0) continue;
    const localFactor = 1 - (1 - factor) * w;
    const localVertical = 1 - (1 - verticalFactor) * w;
    node.p[0] = round6(pivot[0] + (node.p[0] - pivot[0]) * localFactor);
    node.p[1] = round6(pivot[1] + (node.p[1] - pivot[1]) * localVertical);
    node.p[2] = round6(pivot[2] + (node.p[2] - pivot[2]) * localFactor);
  }
  const nodeById = new Map(result.nodes.map((node) => [node.id, node]));
  for (const chamber of result.chambers) {
    chamber.c = [...nodeById.get(chamber.nodeId).p];
    // keep the exact shelf relation floorY = cY − connectorRy + floorLift
    chamber.floorY = round6(chamber.c[1] - chamber.connectorRy + chamber.floorLift);
  }
  return refreshGraphGeometry(relaxGrades(result));
}

export function lowerCaveInterior(graph, drop, rampDistance = 70) {
  if (drop <= 1e-9) return refreshGraphGeometry(cloneGraph(graph));
  const result = cloneGraph(graph);
  const pivotId = result.mainPath[1] || result.entranceNodeId;
  const distances = nodeDistances(result, pivotId);
  const fixedIds = new Set(result.mainPath.slice(0, 2));
  const shiftByNode = new Map();
  for (const node of result.nodes) {
    const shift = fixedIds.has(node.id) ? 0 : drop * clamp((distances.get(node.id) || 0) / rampDistance, 0, 1);
    shiftByNode.set(node.id, shift);
    node.p[1] = round6(node.p[1] - shift);
  }
  const nodeById = new Map(result.nodes.map((node) => [node.id, node]));
  for (const chamber of result.chambers) {
    const shift = shiftByNode.get(chamber.nodeId) || 0;
    chamber.c = [...nodeById.get(chamber.nodeId).p];
    chamber.floorY = round6(chamber.floorY - shift);
  }
  return refreshGraphGeometry(relaxGrades(result));
}

export function caveCoverReport(graph, surfaceYAt, {
  sampleStep = 2,
  entranceGrace = 18,
  noiseMargin = 0.9,
} = {}) {
  if (typeof surfaceYAt !== 'function') throw new Error('Cave cover report requires surfaceYAt(x, z)');
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const root = nodeById.get(graph.entranceNodeId)?.p || [0, 0, 0];
  let minCover = Infinity, worst = null, samples = 0;
  const include = (x, z, roofY, primitive, t = 0) => {
    if (Math.hypot(x - root[0], z - root[2]) < entranceGrace) return;
    const surfaceY = surfaceYAt(x, z);
    if (!Number.isFinite(surfaceY)) return;
    const cover = surfaceY - roofY;
    samples++;
    if (cover < minCover) { minCover = cover; worst = { x, z, roofY, surfaceY, cover, primitive, t }; }
  };
  for (const edge of graph.edges) {
    const a = nodeById.get(edge.a)?.p, b = nodeById.get(edge.b)?.p;
    if (!a || !b) continue;
    const horizontal = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const steps = Math.max(1, Math.ceil(horizontal / sampleStep));
    for (let index = 0; index <= steps; index++) {
      const t = index / steps;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      const ry = (edge.ryA ?? edge.ry) + ((edge.ryB ?? edge.ry) - (edge.ryA ?? edge.ry)) * t;
      include(x, z, y + ry + noiseMargin, edge.id, t);
    }
  }
  for (const chamber of graph.chambers) {
    include(chamber.c[0], chamber.c[2], chamber.c[1] + chamber.r[1] + noiseMargin, chamber.id, 0);
    const ring = 0.62, roofScale = Math.sqrt(1 - ring * ring);
    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      const localX = Math.cos(angle) * chamber.r[0] * ring;
      const localZ = Math.sin(angle) * chamber.r[2] * ring;
      const yaw = chamber.yaw || 0, cos = Math.cos(yaw), sin = Math.sin(yaw);
      include(
        chamber.c[0] + cos * localX + sin * localZ,
        chamber.c[2] - sin * localX + cos * localZ,
        chamber.c[1] + chamber.r[1] * roofScale + noiseMargin,
        chamber.id,
        ring,
      );
    }
  }
  return { minCover, worst, samples };
}

const DEFAULT_ANGLES = [
  0, -15, 15, -30, 30, -45, 45, -60, 60,
  -75, 75, -90, 90, -105, 105, -120, 120,
].map((degrees) => degrees * Math.PI / 180);

export function fitCaveToTerrain(graph, surfaceYAt, {
  targetCover = 4,
  angles = DEFAULT_ANGLES,
  bendDistance = 42,
  // V3 networks run ~40% longer than the caves this fitter was tuned on, so
  // deeper drops need proportionally longer ramps: added gradient is
  // drop/rampDistance, and it stacks onto the base grade under the 0.18 cap.
  rampDistances = [70, 90, 55, 130, 190, 260],
  maxDrop = 34,
  compressions = [1, 0.85, 0.72, 0.62, 0.52],
} = {}) {
  const candidates = [];
  let bestFallback = null;
  for (const factor of compressions) {
    const squeezed = compressCaveInterior(graph, factor, bendDistance);
    if (!squeezed.validation.valid) continue;
    for (const angle of angles) {
      const bent = bendCaveInterior(squeezed, angle, bendDistance);
      if (!bent.validation.valid) continue;
      const initial = caveCoverReport(bent, surfaceYAt);
      if (!bestFallback || initial.minCover > bestFallback.report.minCover) {
        bestFallback = { graph: bent, angle, factor, drop: 0, rampDistance: 0, report: initial };
      }
      if (initial.minCover >= targetCover) {
        candidates.push({ graph: bent, angle, factor, drop: 0, rampDistance: 0, report: initial });
        continue;
      }
      for (const rampDistance of rampDistances) {
        let drop = Math.max(0, targetCover - initial.minCover + 0.35);
        for (let iteration = 0; iteration < 7 && drop <= maxDrop; iteration++) {
          const lowered = lowerCaveInterior(bent, drop, rampDistance);
          if (!lowered.validation.valid) break;
          const report = caveCoverReport(lowered, surfaceYAt);
          if (!bestFallback || report.minCover > bestFallback.report.minCover) {
            bestFallback = { graph: lowered, angle, factor, drop, rampDistance, report };
          }
          if (report.minCover >= targetCover) {
            candidates.push({ graph: lowered, angle, factor, drop, rampDistance, report });
            break;
          }
          drop += Math.max(0.4, (targetCover - report.minCover) * 1.55);
        }
      }
    }
  }
  const ranked = candidates.sort((a, b) => {
    const costA = Math.abs(a.angle) / (Math.PI * 0.5) + a.drop / 10 + (1 - a.factor) * 2.5;
    const costB = Math.abs(b.angle) / (Math.PI * 0.5) + b.drop / 10 + (1 - b.factor) * 2.5;
    return costA - costB || b.report.minCover - a.report.minCover || a.angle - b.angle;
  });
  const selected = ranked[0] || bestFallback || {
    graph: refreshGraphGeometry(cloneGraph(graph)), angle: 0, factor: 1, drop: 0, rampDistance: 0,
    report: caveCoverReport(graph, surfaceYAt),
  };
  selected.graph.terrainFit = {
    version: 1,
    angle: round6(selected.angle),
    angleDegrees: round6(selected.angle * 180 / Math.PI),
    drop: round6(selected.drop),
    rampDistance: selected.rampDistance,
    compression: round6(selected.factor ?? 1),
    targetCover,
    minCover: round6(selected.report.minCover),
    achieved: selected.report.minCover >= targetCover,
    worst: selected.report.worst ? {
      x: round6(selected.report.worst.x), z: round6(selected.report.worst.z),
      cover: round6(selected.report.worst.cover), primitive: selected.report.worst.primitive,
    } : null,
  };
  return selected.graph;
}
