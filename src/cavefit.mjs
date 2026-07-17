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
