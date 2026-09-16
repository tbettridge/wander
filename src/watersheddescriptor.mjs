// Compact, immutable compatibility descriptors for already accepted water
// plans.  This module does not run a planner and does not ask World for
// terrain.  It deliberately keeps the information that survives in a
// WaterField plan and labels topology that a mesh no longer contains as
// unknown.
import { BASIN_PLAN_VERSION, BASIN_REGION_SIZE, descriptorHash } from './hydrologyformat.mjs';

export const WATERSHED_DESCRIPTOR_VERSION = 1;
export const WATERSHED_REGION_SIZE = BASIN_REGION_SIZE;
export const WATERSHED_DESCRIPTOR_LIMITS = Object.freeze({
  maxBasins: 64,
  maxComponents: 64,
  maxReaches: 256,
  maxJunctions: 256,
  maxGridCells: 262144,
  // The full sparse component is already retained by WaterField.  The
  // compatibility view keeps a bounded water/shore sample set for distant
  // consumers; callers that need more can opt into a larger worker budget.
  maxSamplesPerComponent: 4096,
  maxTerrainSamplesPerBasin: 8192,
  maxContourPoints: 16384,
  maxBoundaryContracts: 1024,
});

export const WATERSHED_DESCRIPTOR_SCHEMA = Object.freeze({
  version: WATERSHED_DESCRIPTOR_VERSION,
  kind: 'watershed',
  fields: Object.freeze([
    'version', 'kind', 'id', 'hash', 'ownerId', 'source', 'region',
    'topology', 'basins', 'rivers', 'components', 'junctions', 'boundaryContracts',
  ]),
  boundaryContractFields: Object.freeze([
    'id', 'featureId', 'featureKind', 'ownerId', 'regionX', 'regionZ',
    'side', 'axis', 'boundaryIndex', 'position', 'level', 'width',
    'tangent', 'bankInfluence', 'flow', 'source', 'topology',
  ]),
});

const EPSILON = 1e-9;
const CONTOUR_EPSILON = 1e-7;
const TRIANGLES = [[0, 1, 2], [3, 2, 1]];
const TRIANGLE_EDGES = [[0, 1], [1, 2], [2, 0]];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonEmpty = value => typeof value === 'string' && value.length > 0;
const numericArray = value => Array.isArray(value) || ArrayBuffer.isView(value);

function finiteVector(value, length) {
  return numericArray(value) && value.length === length && [...value].every(finite);
}

function finiteBounds(value) {
  return isObject(value) && ['minX', 'minZ', 'maxX', 'maxZ'].every(key => finite(value[key]))
    && value.minX <= value.maxX && value.minZ <= value.maxZ;
}

function sortedStrings(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function uniqueStrings(values) {
  return Array.isArray(values) && values.every(nonEmpty) && new Set(values).size === values.length;
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) for (const child of value) freezeDeep(child, seen);
  else for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function normalizeLimits(options = {}) {
  const limits = { ...WATERSHED_DESCRIPTOR_LIMITS };
  for (const key of Object.keys(limits)) {
    if (options[key] === undefined) continue;
    if (!Number.isSafeInteger(options[key]) || options[key] < 1) {
      throw new Error(`Invalid watershed descriptor budget: ${key}`);
    }
    limits[key] = options[key];
  }
  return limits;
}

function sourcePayload(plan) {
  const { diagnostics, hash, ...payload } = plan;
  return payload;
}

function sourcePlanErrors(plan, { verifyHash = false, limits = WATERSHED_DESCRIPTOR_LIMITS } = {}) {
  const errors = [];
  if (!isObject(plan)) return ['source-plan-not-object'];
  if (plan.version !== BASIN_PLAN_VERSION) errors.push('source-plan-version');
  if (![plan.seed, plan.regionX, plan.regionZ].every(Number.isSafeInteger)) errors.push('source-plan-identity');
  if (!Number.isSafeInteger(plan.generationVersion) || plan.generationVersion < 1) errors.push('source-plan-generation');
  if (!nonEmpty(plan.hash)) errors.push('source-plan-hash');
  if (!Array.isArray(plan.basins)) errors.push('source-plan-basins');
  if (plan.basins?.length > limits.maxBasins) errors.push('source-plan-basin-budget');
  if (plan.components !== undefined && !Array.isArray(plan.components)) errors.push('source-plan-components');
  if ((plan.components?.length || 0) > limits.maxComponents) errors.push('source-plan-component-budget');
  if (plan.reaches !== undefined && !Array.isArray(plan.reaches)) errors.push('source-plan-reaches');
  if ((plan.reaches?.length || 0) > limits.maxReaches) errors.push('source-plan-reach-budget');
  if (verifyHash && nonEmpty(plan.hash)) {
    try {
      if (descriptorHash(sourcePayload(plan)) !== plan.hash) errors.push('source-plan-checksum');
    } catch { errors.push('source-plan-checksum'); }
  }
  return errors;
}

export function validateWaterPlanForWatershedDescriptor(plan, options = {}) {
  let limits;
  try { limits = normalizeLimits(options); }
  catch (error) { return { valid: false, errors: [error.message] }; }
  const errors = sourcePlanErrors(plan, { verifyHash: options.verifyHash === true, limits });
  if (!isObject(plan)) return { valid: false, errors };
  if (!Array.isArray(plan.basins)
    || (plan.components !== undefined && !Array.isArray(plan.components))
    || (plan.reaches !== undefined && !Array.isArray(plan.reaches))) {
    return { valid: false, errors };
  }
  const basinIds = new Set(), componentIds = new Set(), reachIds = new Set();
  for (const basin of plan.basins || []) {
    if (!isObject(basin) || !nonEmpty(basin.id)) { errors.push('source-basin-id'); continue; }
    if (basinIds.has(basin.id)) errors.push(`source-duplicate-basin:${basin.id}`);
    basinIds.add(basin.id);
    if (!finite(basin.level) || !finiteBounds(basin.bounds)) errors.push(`source-basin-shape:${basin.id}`);
    const grid = basin.grid, n = grid?.cols * grid?.rows;
    if (!isObject(grid) || !Number.isInteger(grid.cols) || !Number.isInteger(grid.rows)
      || grid.cols < 2 || grid.rows < 2 || !finite(grid.step) || grid.step <= 0
      || !finite(grid.x0) || !finite(grid.z0) || !Number.isSafeInteger(n)
      || n > limits.maxGridCells || !numericArray(grid.floor) || !numericArray(grid.signed)
      || grid.floor.length !== n || grid.signed.length !== n
      || ![...grid.floor, ...grid.signed].every(finite)) {
      errors.push(`source-basin-grid:${basin.id}`);
    }
  }
  for (const component of plan.components || []) {
    if (!isObject(component) || !nonEmpty(component.hash)) { errors.push('source-component-hash'); continue; }
    if (componentIds.has(component.hash)) errors.push(`source-duplicate-component:${component.hash}`);
    componentIds.add(component.hash);
    if (component.status !== 'baked' || ![2, 3].includes(component.version)) errors.push(`source-component-status:${component.hash}`);
    if (!uniqueStrings(component.reachIds)) errors.push(`source-component-reaches:${component.hash}`);
    if (component.basinIds !== undefined && !uniqueStrings(component.basinIds)) errors.push(`source-component-basins:${component.hash}`);
    const grid = component.grid, n = component.version === 3 ? grid?.coords?.length : grid?.cols * grid?.rows;
    if (!isObject(grid) || !Number.isSafeInteger(n) || n < 1 || n > limits.maxGridCells
      || !numericArray(grid.floor) || !numericArray(grid.natural) || !numericArray(grid.head)
      || !numericArray(grid.signed) || !numericArray(grid.flowX) || !numericArray(grid.flowZ)
      || [grid.floor, grid.natural, grid.head, grid.signed, grid.flowX, grid.flowZ].some(values => values.length !== n
        || ![...values].every(finite))) {
      errors.push(`source-component-grid:${component.hash}`);
    }
  }
  for (const reach of plan.reaches || []) {
    if (!isObject(reach) || !nonEmpty(reach.id)) { errors.push('source-reach-id'); continue; }
    if (reachIds.has(reach.id)) errors.push(`source-duplicate-reach:${reach.id}`);
    reachIds.add(reach.id);
    if (reach.status !== 'fitted' || !Array.isArray(reach.points) || reach.points.length < 2) errors.push(`source-reach-shape:${reach.id}`);
  }
  return { valid: errors.length === 0, errors };
}

function invalidSource(label, id, details = []) {
  const suffix = details.length ? `: ${details.join(', ')}` : '';
  throw new Error(`Invalid watershed source ${label}${id ? ` ${id}` : ''}${suffix}`);
}

function validateBasinSource(basin, limits) {
  const errors = [];
  if (!isObject(basin) || !nonEmpty(basin.id)) return ['id'];
  if (!finite(basin.level) || !finiteBounds(basin.bounds)) errors.push('shape');
  const g = basin.grid, n = g?.cols * g?.rows;
  if (!isObject(g) || !Number.isInteger(g.cols) || !Number.isInteger(g.rows) || g.cols < 2 || g.rows < 2
    || !finite(g.x0) || !finite(g.z0) || !finite(g.step) || g.step <= 0 || !Number.isSafeInteger(n)
    || n > limits.maxGridCells || !numericArray(g.floor) || !numericArray(g.signed)
    || g.floor.length !== n || g.signed.length !== n || ![...g.floor, ...g.signed].every(finite)) {
    errors.push('grid');
  }
  return errors;
}

function gridPoint(x, z) { return { x, z }; }

function pointKey(point) {
  return `${Math.round(point.x / CONTOUR_EPSILON)},${Math.round(point.z / CONTOUR_EPSILON)}`;
}

function comparePoints(a, b) { return a.x - b.x || a.z - b.z; }

function addTriangleSegments(segments, corners, values, active = value => value > 0) {
  for (const triangle of TRIANGLES) {
    const intersections = [];
    for (const [edgeA, edgeB] of TRIANGLE_EDGES) {
      const a = triangle[edgeA], b = triangle[edgeB], va = values[a], vb = values[b];
      if (!finite(va) || !finite(vb) || active(va) === active(vb)) continue;
      let point;
      if (!active(va)) {
        if (Math.abs(va) <= EPSILON) point = corners[a];
        else if (Math.abs(vb) <= EPSILON) point = corners[b];
        else {
          const t = va / (va - vb);
          point = gridPoint(corners[a].x + (corners[b].x - corners[a].x) * t,
            corners[a].z + (corners[b].z - corners[a].z) * t);
        }
      } else {
        if (Math.abs(vb) <= EPSILON) point = corners[b];
        else if (Math.abs(va) <= EPSILON) point = corners[a];
        else {
          const t = vb / (vb - va);
          point = gridPoint(corners[b].x + (corners[a].x - corners[b].x) * t,
            corners[b].z + (corners[a].z - corners[b].z) * t);
        }
      }
      const key = pointKey(point);
      if (!intersections.some(other => pointKey(other) === key)) intersections.push(point);
    }
    if (intersections.length === 2 && pointKey(intersections[0]) !== pointKey(intersections[1])) {
      const a = intersections[0], b = intersections[1];
      const key = [pointKey(a), pointKey(b)].sort().join('|');
      if (!segments.some(segment => segment.key === key)) segments.push({ key, a, b });
    }
  }
}

function stitchSegments(segments) {
  const nodes = new Map(), adjacency = new Map();
  const addNode = point => {
    const key = pointKey(point);
    if (!nodes.has(key)) nodes.set(key, point);
    if (!adjacency.has(key)) adjacency.set(key, new Set());
    return key;
  };
  for (const segment of segments) {
    const a = addNode(segment.a), b = addNode(segment.b);
    if (a === b) continue;
    adjacency.get(a).add(b); adjacency.get(b).add(a);
  }
  const visited = new Set(), loops = [];
  let openSegments = 0, branches = 0;
  for (const [start, neighbours] of adjacency) {
    if (neighbours.size !== 2) branches++;
    for (const next of [...neighbours].sort()) {
      const edgeKey = [start, next].sort().join('|');
      if (visited.has(edgeKey)) continue;
      const points = [], local = new Set();
      let previous = null, current = start, closed = false;
      for (let guard = 0; guard <= adjacency.size + 1; guard++) {
        points.push(nodes.get(current));
        const candidates = [...(adjacency.get(current) || [])].filter(candidate => candidate !== previous).sort();
        let candidate = candidates.find(value => !visited.has([current, value].sort().join('|')));
        if (candidate === undefined && current === start) { closed = true; break; }
        if (candidate === undefined) break;
        const edge = [current, candidate].sort().join('|');
        if (local.has(edge)) { openSegments++; break; }
        visited.add(edge); local.add(edge);
        previous = current; current = candidate;
        if (current === start) { closed = true; break; }
      }
      if (closed && points.length >= 3) loops.push(points);
      else if (!closed) openSegments++;
    }
  }
  return { loops, openSegments, branches };
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area / 2;
}

function polygonBounds(points) {
  return {
    minX: Math.min(...points.map(point => point.x)),
    minZ: Math.min(...points.map(point => point.z)),
    maxX: Math.max(...points.map(point => point.x)),
    maxZ: Math.max(...points.map(point => point.z)),
  };
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    const intersects = ((a.z > point.z) !== (b.z > point.z))
      && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function loopRepresentative(points) {
  const mean = points.reduce((sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }), { x: 0, z: 0 });
  mean.x /= points.length; mean.z /= points.length;
  if (pointInPolygon(mean, points)) return mean;
  const first = points[0];
  return gridPoint(first.x * 0.99 + mean.x * 0.01, first.z * 0.99 + mean.z * 0.01);
}

function canonicalLoop(points, role = 'unknown') {
  let result = points.map(point => gridPoint(point.x, point.z));
  let area = polygonArea(result);
  const desired = role === 'hole' ? -1 : 1;
  if (Math.abs(area) > CONTOUR_EPSILON && Math.sign(area) !== desired) {
    result = result.reverse(); area = -area;
  }
  let first = 0;
  for (let i = 1; i < result.length; i++) if (comparePoints(result[i], result[first]) < 0) first = i;
  result = [...result.slice(first), ...result.slice(0, first)];
  return { role, points: result, area, bounds: polygonBounds(result) };
}

function classifyLoops(rawLoops, { sideSample = null } = {}) {
  const classified = [];
  for (const points of rawLoops) {
    if (points.length < 3 || Math.abs(polygonArea(points)) <= CONTOUR_EPSILON) continue;
    let role = 'unknown';
    if (sideSample) {
      const area = polygonArea(points), a = points[0], b = points[1];
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz) || 1;
      const normal = area >= 0 ? { x: -dz / length, z: dx / length } : { x: dz / length, z: -dx / length };
      const mid = gridPoint((a.x + b.x) / 2, (a.z + b.z) / 2);
      const offset = Math.max(1e-4, Math.min(1, length * 0.03));
      const inward = sideSample(mid.x + normal.x * offset, mid.z + normal.z * offset);
      const outward = sideSample(mid.x - normal.x * offset, mid.z - normal.z * offset);
      if (inward > outward + 1e-7) role = 'outer';
      else if (outward > inward + 1e-7) role = 'hole';
    }
    if (role === 'unknown') {
      const representative = loopRepresentative(points);
      let nesting = 0;
      for (const other of rawLoops) if (other !== points && pointInPolygon(representative, other)) nesting++;
      role = nesting % 2 === 0 ? 'outer' : 'hole';
    }
    classified.push(canonicalLoop(points, role));
  }
  const roleOrder = { outer: 0, hole: 1, unknown: 2 };
  return classified.sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || Math.abs(b.area) - Math.abs(a.area)
    || comparePoints(a.points[0], b.points[0]));
}

function makeShoreline(raw, limits) {
  const loops = classifyLoops(raw.loops, raw);
  let total = loops.reduce((count, loop) => count + loop.points.length, 0);
  let truncated = false;
  if (total > limits.maxContourPoints) {
    truncated = true;
    let remaining = limits.maxContourPoints;
    const kept = [];
    for (const loop of loops) {
      // A shortened polygon would silently invent a closing edge.  Preserve
      // complete loops only; consumers can use the explicit partial status to
      // request a higher budget or keep the detailed representation nearby.
      if (loop.points.length > remaining) continue;
      kept.push(loop);
      remaining -= loop.points.length;
      if (remaining < 3) break;
    }
    loops.length = 0; loops.push(...kept);
    total = loops.reduce((count, loop) => count + loop.points.length, 0);
  }
  const outers = loops.filter(loop => loop.role === 'outer');
  const holes = loops.filter(loop => loop.role === 'hole');
  const status = loops.length === 0
    ? (truncated || raw.openSegments > 0 || raw.branches > 0 ? 'partial' : 'unknown')
    : (raw.openSegments === 0 && raw.branches === 0 && !truncated ? 'exact' : 'partial');
  return {
    status,
    loops,
    outer: outers[0]?.points || null,
    outers: outers.map(loop => loop.points),
    holes: holes.map(loop => loop.points),
    openSegments: raw.openSegments,
    branches: raw.branches,
    truncated,
    pointCount: total,
  };
}

function regularContours(grid, positiveValues, limits) {
  const { x0, z0, step, cols, rows } = grid;
  const segments = [];
  const values = positiveValues;
  for (let row = 0; row < rows - 1; row++) for (let col = 0; col < cols - 1; col++) {
    const indexes = [row * cols + col, row * cols + col + 1,
      (row + 1) * cols + col, (row + 1) * cols + col + 1];
    const corners = [
      gridPoint(x0 + col * step, z0 + row * step),
      gridPoint(x0 + (col + 1) * step, z0 + row * step),
      gridPoint(x0 + col * step, z0 + (row + 1) * step),
      gridPoint(x0 + (col + 1) * step, z0 + (row + 1) * step),
    ];
    addTriangleSegments(segments, [corners[0], corners[1], corners[2], corners[3]], indexes.map(index => values[index]));
  }
  const sample = (x, z) => {
    const gx = (x - x0) / step, gz = (z - z0) / step;
    if (gx < 0 || gz < 0 || gx > cols - 1 || gz > rows - 1) return -Infinity;
    const col = Math.min(cols - 2, Math.floor(gx)), row = Math.min(rows - 2, Math.floor(gz));
    const fx = gx - col, fz = gz - row;
    const a = row * cols + col, b = a + 1, c = a + cols, d = c + 1;
    return fx + fz <= 1
      ? values[a] + (values[b] - values[a]) * fx + (values[c] - values[a]) * fz
      : values[d] + (values[c] - values[d]) * (1 - fx) + (values[b] - values[d]) * (1 - fz);
  };
  return makeShoreline({ ...stitchSegments(segments), sideSample: sample }, limits);
}

function sparseContours(grid, values, limits, activeMask = null) {
  const coords = grid.coords, step = grid.step, lookup = new Map();
  for (let i = 0; i < coords.length; i++) lookup.set(`${coords[i][0]},${coords[i][1]}`, i);
  const segments = [], cells = new Set();
  let missing = false;
  for (let i = 0; i < coords.length; i++) {
    const [ix, iz] = coords[i];
    for (const [dx, dz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
      const cx = ix + dx, cz = iz + dz, cellKey = `${cx},${cz}`;
      if (cells.has(cellKey)) continue;
      cells.add(cellKey);
      const a = lookup.get(`${cx},${cz}`), b = lookup.get(`${cx + 1},${cz}`);
      const c = lookup.get(`${cx},${cz + 1}`), d = lookup.get(`${cx + 1},${cz + 1}`);
      if ([a, b, c, d].some(index => index === undefined)) {
        if ([a, b, c, d].some(index => index !== undefined && activeMask ? activeMask[index] : index !== undefined)) missing = true;
        continue;
      }
      const corners = [
        gridPoint(coords[a][0] * step, coords[a][1] * step),
        gridPoint(coords[b][0] * step, coords[b][1] * step),
        gridPoint(coords[c][0] * step, coords[c][1] * step),
        gridPoint(coords[d][0] * step, coords[d][1] * step),
      ];
      const cellValues = [a, b, c, d].map(index => values[index]);
      addTriangleSegments(segments, corners, cellValues);
    }
  }
  const stitched = stitchSegments(segments);
  const shoreline = makeShoreline({ ...stitched, branches: stitched.branches + (missing ? 1 : 0) }, limits);
  if (missing && shoreline.status === 'exact') shoreline.status = 'partial';
  return shoreline;
}

function optional(value) { return finite(value) ? value : null; }

function materialDescriptor(material) {
  if (!isObject(material)) return null;
  const result = {};
  for (const key of ['kind', 'turbidity', 'exposure', 'turbulence', 'estuary']) {
    if (finite(material[key]) || typeof material[key] === 'string') result[key] = material[key];
  }
  return Object.keys(result).length ? result : null;
}

function regionFor(plan) {
  const minX = plan.regionX * WATERSHED_REGION_SIZE, minZ = plan.regionZ * WATERSHED_REGION_SIZE;
  return {
    x: plan.regionX, z: plan.regionZ, size: WATERSHED_REGION_SIZE,
    bounds: { minX, minZ, maxX: minX + WATERSHED_REGION_SIZE, maxZ: minZ + WATERSHED_REGION_SIZE },
  };
}

function regionOwner(plan) {
  return `region:${plan.seed}:${plan.generationVersion}:${plan.regionX}:${plan.regionZ}`;
}

function sourceGridDescriptor(grid) {
  return { x0: grid.x0, z0: grid.z0, cols: grid.cols, rows: grid.rows, step: grid.step };
}

function basinTerrainSamples(basin, limits) {
  const g = basin.grid, values = g.signed, n = g.cols * g.rows, candidates = [];
  const near = Math.max(g.step * 1.5, 2);
  for (let row = 0; row < g.rows; row++) for (let col = 0; col < g.cols; col++) {
    const index = row * g.cols + col, value = values[index];
    let edge = Math.abs(value) <= near;
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const nx = col + dx, nz = row + dz;
      if (nx >= g.cols || nz >= g.rows) continue;
      const other = values[nz * g.cols + nx];
      if ((value > 0) !== (other > 0)) edge = true;
    }
    if (edge) candidates.push([g.x0 + col * g.step, g.z0 + row * g.step, g.floor[index], value]);
  }
  const truncated = candidates.length > limits.maxTerrainSamplesPerBasin;
  const samples = truncated ? candidates.filter((_, index) => index % Math.ceil(candidates.length / limits.maxTerrainSamplesPerBasin) === 0)
    .slice(0, limits.maxTerrainSamplesPerBasin) : candidates;
  return { fields: ['x', 'z', 'floor', 'signed'], samples, truncated, sourceCount: n };
}

function boundaryPoint(point, region) {
  const result = [];
  if (Math.abs(point.x - region.bounds.minX) <= EPSILON) result.push({ axis: 'x', boundary: region.bounds.minX, side: 'west' });
  if (Math.abs(point.x - region.bounds.maxX) <= EPSILON) result.push({ axis: 'x', boundary: region.bounds.maxX, side: 'east' });
  if (Math.abs(point.z - region.bounds.minZ) <= EPSILON) result.push({ axis: 'z', boundary: region.bounds.minZ, side: 'north' });
  if (Math.abs(point.z - region.bounds.maxZ) <= EPSILON) result.push({ axis: 'z', boundary: region.bounds.maxZ, side: 'south' });
  return result;
}

function boundaryIntersections(a, b, region) {
  const intersections = [];
  for (const axis of ['x', 'z']) {
    const av = a[axis], bv = b[axis], delta = bv - av;
    if (Math.abs(delta) <= EPSILON) continue;
    const low = Math.min(av, bv), high = Math.max(av, bv);
    const first = Math.ceil((low - EPSILON) / region.size), last = Math.floor((high + EPSILON) / region.size);
    for (let index = first; index <= last; index++) {
      const boundary = index * region.size;
      if (boundary < low - EPSILON || boundary > high + EPSILON) continue;
      const t = (boundary - av) / delta;
      if (t < -EPSILON || t > 1 + EPSILON) continue;
      const point = gridPoint(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      const side = boundaryPoint(point, region).find(item => item.axis === axis)?.side || 'external';
      intersections.push({ axis, boundary, boundaryIndex: index, t: Math.max(0, Math.min(1, t)), point, side });
    }
  }
  return intersections;
}

function interpolateOptional(a, b, key, t) {
  return a && b && finite(a[key]) && finite(b[key]) ? a[key] + (b[key] - a[key]) * t : null;
}

function contractId(contract) {
  return `boundary:${descriptorHash([
    contract.featureKind, contract.featureId, contract.axis, contract.boundaryIndex,
    contract.position.x, contract.position.z,
  ])}`;
}

function makeContract({ featureId, featureKind, ownerId, region, axis, boundaryIndex, side,
  position, level = null, width = null, tangent = null, bankInfluence = null, flow = null,
  source, topology }) {
  const contract = {
    id: '', featureId, featureKind, ownerId, regionX: region.x, regionZ: region.z,
    side, axis, boundaryIndex, position: { x: position.x, z: position.z },
    level: optional(level), width, tangent, bankInfluence, flow, source, topology,
  };
  contract.id = contractId(contract);
  return contract;
}

function routePointDescriptor(point) {
  const widthValues = { left: optional(point.leftWidth), right: optional(point.rightWidth) };
  const bankValues = {
    left: finite(point.leftBankWidth) && finite(point.leftBlendWidth) ? point.leftBankWidth + point.leftBlendWidth : null,
    right: finite(point.rightBankWidth) && finite(point.rightBlendWidth) ? point.rightBankWidth + point.rightBlendWidth : null,
  };
  const widths = widthValues.left !== null || widthValues.right !== null ? widthValues : null;
  const bankInfluence = bankValues.left !== null || bankValues.right !== null ? bankValues : null;
  const tangent = finite(point.tx) && finite(point.tz) ? { x: point.tx, z: point.tz } : null;
  return {
    id: nonEmpty(point.id) ? point.id : null,
    position: { x: point.x, z: point.z },
    arc: optional(point.arc), level: optional(point.waterY),
    tangent, width: widths, bankInfluence,
    bedDepth: optional(point.depth),
    bankY: { left: optional(point.leftBankY), right: optional(point.rightBankY) },
    shoulder: { left: optional(point.leftShoulder), right: optional(point.rightShoulder) },
  };
}

function routeDescriptor(reach, ownerId, limits) {
  if (!isObject(reach) || !nonEmpty(reach.id) || reach.status !== 'fitted' || !Array.isArray(reach.points)
    || reach.points.length < 2 || reach.points.some(point => !isObject(point) || !finite(point.x) || !finite(point.z))) {
    invalidSource('reach', reach?.id || 'unknown', ['fitted points']);
  }
  if (reach.points.length > limits.maxGridCells) invalidSource('reach', reach.id, ['point budget']);
  const points = reach.points.map(routePointDescriptor);
  const hasLevels = points.every(point => finite(point.level));
  const geometry = {
    status: 'exact', topology: 'exact', centerline: points,
    bounds: finiteBounds(reach.bounds) ? { ...reach.bounds } : {
      minX: Math.min(...points.map(point => point.position.x)), minZ: Math.min(...points.map(point => point.position.z)),
      maxX: Math.max(...points.map(point => point.position.x)), maxZ: Math.max(...points.map(point => point.position.z)),
    },
    levelStatus: hasLevels ? 'exact' : 'unknown',
  };
  return {
    id: reach.id, ownerId: nonEmpty(reach.ownerId) ? reach.ownerId : ownerId,
    source: 'fitted-reach', geometry,
    connections: {
      sourceId: nonEmpty(reach.source) ? reach.source : null,
      outletId: nonEmpty(reach.outlet) ? reach.outlet : null,
      basinIds: uniqueStrings(reach.basinIds) ? sortedStrings(reach.basinIds) : [],
      sourceClosure: typeof reach.sourceClosure === 'boolean' ? reach.sourceClosure : null,
      oceanMouth: typeof reach.oceanMouth === 'boolean' ? reach.oceanMouth : null,
    },
    budgets: {
      maxGrade: optional(reach.maxGrade), maxFill: optional(reach.maxFill), maxCut: optional(reach.maxCut),
    },
  };
}

function componentGridInfo(component, limits) {
  const g = component.grid, version = component.version;
  if (!isObject(g)) invalidSource('component', component.hash, ['grid']);
  if (component.bounds !== undefined && !finiteBounds(component.bounds)) {
    invalidSource('component', component.hash, ['bounds']);
  }
  const n = version === 3 ? g.coords?.length : g.cols * g.rows;
  if (!Number.isSafeInteger(n) || n < 1 || n > limits.maxGridCells) invalidSource('component', component.hash, ['grid budget']);
  if (!finite(g.step) || g.step <= 0) invalidSource('component', component.hash, ['grid step']);
  const fields = ['floor', 'natural', 'head', 'signed', 'flowX', 'flowZ'];
  if (version === 3) fields.push('estuary');
  if (fields.some(key => !numericArray(g[key]) || g[key].length !== n || ![...g[key]].every(finite))) {
    invalidSource('component', component.hash, ['grid fields']);
  }
  if (version === 3) {
    if (!Array.isArray(g.coords) || g.coords.some(point => !Array.isArray(point) || point.length !== 2
      || !point.every(Number.isSafeInteger))) invalidSource('component', component.hash, ['sparse coordinates']);
    if (component.basinIds && (!numericArray(g.lakeKind) || g.lakeKind.length !== n || ![...g.lakeKind].every(value => finite(value)))) {
      invalidSource('component', component.hash, ['lake ownership']);
    }
    const xs = g.coords.map(point => point[0] * g.step), zs = g.coords.map(point => point[1] * g.step);
    return { g, n, version, fields, xs, zs, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  }
  if (![g.x0, g.z0, g.cols, g.rows].every(finite) || !Number.isInteger(g.cols) || !Number.isInteger(g.rows)
    || g.cols < 2 || g.rows < 2) invalidSource('component', component.hash, ['dense coordinates']);
  return {
    g, n, version, fields,
    xs: [g.x0, g.x0 + (g.cols - 1) * g.step], zs: [g.z0, g.z0 + (g.rows - 1) * g.step],
    minX: g.x0, maxX: g.x0 + (g.cols - 1) * g.step,
    minZ: g.z0, maxZ: g.z0 + (g.rows - 1) * g.step,
  };
}

function componentSampleRows(info, limits) {
  const { g, n, version } = info, rows = [], candidates = [];
  const lakeKind = g.lakeKind;
  const valueAt = index => ({
    x: version === 3 ? g.coords[index][0] * g.step : g.x0 + (index % g.cols) * g.step,
    z: version === 3 ? g.coords[index][1] * g.step : g.z0 + Math.floor(index / g.cols) * g.step,
    head: g.head[index], signed: g.signed[index], floor: g.floor[index], natural: g.natural[index],
    flowX: g.flowX[index], flowZ: g.flowZ[index], estuary: version === 3 ? g.estuary[index] : null,
    lakeKind: lakeKind ? lakeKind[index] : null,
  });
  for (let i = 0; i < n; i++) {
    const value = valueAt(i), active = value.signed > 0;
    let collar = Math.abs(value.signed) <= Math.max(1, info.g.step * 1.5) || value.lakeKind > 0;
    if (version === 2) {
      const col = i % g.cols, row = Math.floor(i / g.cols);
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const x = col + dx, z = row + dz;
        if (x < g.cols && z < g.rows && active !== (g.signed[z * g.cols + x] > 0)) collar = true;
      }
    }
    if (active || collar) candidates.push(value);
  }
  const truncated = candidates.length > limits.maxSamplesPerComponent;
  const stride = truncated ? Math.ceil(candidates.length / limits.maxSamplesPerComponent) : 1;
  for (let i = 0; i < candidates.length && rows.length < limits.maxSamplesPerComponent; i += stride) rows.push(candidates[i]);
  return { rows, truncated, sourceCount: n, valueAt };
}

function rowArray(rows, fields) { return rows.map(row => fields.map(field => row[field])); }

function extractComponent(component, ownerId, limits) {
  if (!isObject(component) || component.status !== 'baked' || ![2, 3].includes(component.version)
    || !nonEmpty(component.hash) || !uniqueStrings(component.reachIds)
    || (component.basinIds !== undefined && !uniqueStrings(component.basinIds))) {
    invalidSource('component', component?.hash || 'unknown', ['baked ownership']);
  }
  const info = componentGridInfo(component, limits), { g, version } = info;
  const sampleInfo = componentSampleRows(info, limits), samples = sampleInfo.rows;
  const hasLakeKind = version === 3 && g.lakeKind;
  const contourValues = [...g.signed].map((value, index) => hasLakeKind && g.lakeKind[index] <= 0 ? Math.min(-1e-6, -Math.abs(value)) : value);
  const shoreline = version === 3
    ? sparseContours(g, contourValues, limits, hasLakeKind ? [...g.lakeKind].map(value => value > 0) : null)
    : regularContours(g, contourValues, limits);
  const fields = ['x', 'z', 'head', 'signed', 'floor', 'natural', 'flowX', 'flowZ', 'estuary'];
  if (hasLakeKind) fields.push('lakeKind');
  const surface = {
    kind: 'sampled', coverage: version === 3 ? 'sparse' : 'dense', version,
    step: g.step, bounds: { minX: info.minX, minZ: info.minZ, maxX: info.maxX, maxZ: info.maxZ },
    fields, samples: rowArray(samples, fields), sourceCount: sampleInfo.sourceCount,
    truncated: sampleInfo.truncated, shoreline, flowStatus: 'exact',
  };
  const basinIds = sortedStrings(component.basinIds || []);
  const basinRefs = basinIds.map(id => {
    // A combined sparse mesh carries only a lake-kind channel, not a
    // per-vertex basin ID.  It is safe to recover one basin's surface facts
    // when there is exactly one owner; assigning the same samples to several
    // IDs would invent geography from ownership alone.
    const wet = basinIds.length === 1
      ? samples.filter(row => row.lakeKind > 0 && row.signed > 0)
      : [];
    const levels = wet.map(row => row.head).filter(finite);
    const level = levels.length && levels.every(value => Math.abs(value - levels[0]) <= 1e-7) ? levels[0] : null;
    const points = wet.map(row => ({ x: row.x, z: row.z }));
    const basinShoreline = basinIds.length === 1 ? shoreline : makeShoreline({ loops: [], openSegments: 0, branches: 0 }, limits);
    return {
      id, ownerId: nonEmpty(component.ownerId) ? component.ownerId : ownerId,
      source: 'sparse-component', kind: new Set(wet.map(row => row.lakeKind)).size === 1
        ? (wet[0]?.lakeKind === 1 ? 'pond' : wet[0]?.lakeKind === 2 ? 'lake' : null) : null,
      level, center: points.length ? {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        z: points.reduce((sum, point) => sum + point.z, 0) / points.length,
      } : null,
      bounds: points.length ? {
        minX: Math.min(...points.map(point => point.x)), minZ: Math.min(...points.map(point => point.z)),
        maxX: Math.max(...points.map(point => point.x)), maxZ: Math.max(...points.map(point => point.z)),
      } : null,
      topology: { shoreline: basinShoreline.status, centerline: 'unknown', ownership: 'exact' },
      surface: { kind: 'component-reference', componentId: component.hash },
      shoreline: basinShoreline,
      surfaceRef: component.hash,
    };
  });
  return {
    id: `component:${component.hash}`, sourceHash: component.hash,
    ownerId: nonEmpty(component.ownerId) ? component.ownerId : ownerId,
    source: 'waterfield-component', version, oceanHandoff: component.oceanHandoff === true,
    bounds: finiteBounds(component.bounds) ? { ...component.bounds }
      : { minX: info.minX, minZ: info.minZ, maxX: info.maxX, maxZ: info.maxZ },
    reachIds: sortedStrings(component.reachIds), basinIds,
    ownership: { ownerId: nonEmpty(component.ownerId) ? component.ownerId : ownerId,
      reachIds: sortedStrings(component.reachIds), basinIds },
    topology: { centerline: 'unknown', shoreline: shoreline.status, junctions: 'unknown', ownership: 'exact' },
    surface, basinRefs,
  };
}

function extractBasin(basin, ownerId, region, limits) {
  const errors = validateBasinSource(basin, limits);
  if (errors.length) invalidSource('basin', basin?.id || 'unknown', errors);
  const g = basin.grid, values = [...g.signed];
  const shoreline = regularContours(g, values, limits);
  const terrain = basinTerrainSamples(basin, limits);
  const boundarySamples = [];
  for (let row = 0; row < g.rows; row++) for (let col = 0; col < g.cols; col++) {
    const index = row * g.cols + col, point = gridPoint(g.x0 + col * g.step, g.z0 + row * g.step);
    if (boundaryPoint(point, region).length && finite(values[index])) boundarySamples.push([point.x, point.z, basin.level, values[index]]);
  }
  return {
    id: basin.id, ownerId: nonEmpty(basin.ownerId) ? basin.ownerId : ownerId,
    source: 'basin-grid', kind: nonEmpty(basin.kind) ? basin.kind : 'unknown',
    center: finite(basin.centerX) && finite(basin.centerZ) ? { x: basin.centerX, z: basin.centerZ } : null,
    level: basin.level, spill: optional(basin.spill), area: optional(basin.area),
    length: optional(basin.length), maxDepth: optional(basin.maxDepth), rim: optional(basin.rim),
    bounds: { ...basin.bounds }, material: materialDescriptor(basin.material),
    topology: { shoreline: shoreline.status, holes: shoreline.holes.length ? 'exact' : shoreline.status === 'unknown' ? 'unknown' : 'exact', ownership: 'exact' },
    surface: { kind: 'planar', level: basin.level, sourceGrid: sourceGridDescriptor(g),
      triangleDiagonal: 'a-d', boundarySamples, terrainInfluence: terrain },
    shoreline,
  };
}

function extractJunction(junction, ownerId) {
  if (!isObject(junction) || !nonEmpty(junction.id) || !finite(junction.x) || !finite(junction.z) || !finite(junction.waterY)) {
    invalidSource('junction', junction?.id || 'unknown', ['coordinates/level']);
  }
  return {
    id: junction.id, nodeId: nonEmpty(junction.nodeId) ? junction.nodeId : null,
    ownerId: nonEmpty(junction.ownerId) ? junction.ownerId : ownerId,
    position: { x: junction.x, z: junction.z }, level: junction.waterY,
    incomingReachIds: uniqueStrings(junction.incomingReachIds) ? sortedStrings(junction.incomingReachIds) : [],
    outgoingReachId: nonEmpty(junction.outgoingReachId) ? junction.outgoingReachId : null,
    topology: 'exact',
  };
}

function riverContracts(river, region, limits) {
  const contracts = [];
  const points = river.geometry.centerline;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], pa = a.position, pb = b.position;
    for (const crossing of boundaryIntersections(pa, pb, region)) {
      const widthValues = {
        left: interpolateOptional(a.width, b.width, 'left', crossing.t),
        right: interpolateOptional(a.width, b.width, 'right', crossing.t),
      };
      const bankValues = {
        left: interpolateOptional(a.bankInfluence, b.bankInfluence, 'left', crossing.t),
        right: interpolateOptional(a.bankInfluence, b.bankInfluence, 'right', crossing.t),
      };
      const width = widthValues.left !== null || widthValues.right !== null ? widthValues : null;
      const bankInfluence = bankValues.left !== null || bankValues.right !== null ? bankValues : null;
      const tangent = a.tangent && b.tangent ? {
        x: a.tangent.x + (b.tangent.x - a.tangent.x) * crossing.t,
        z: a.tangent.z + (b.tangent.z - a.tangent.z) * crossing.t,
      } : (() => {
        const dx = pb.x - pa.x, dz = pb.z - pa.z, length = Math.hypot(dx, dz);
        return length > EPSILON ? { x: dx / length, z: dz / length } : null;
      })();
      contracts.push(makeContract({ featureId: river.id, featureKind: 'river', ownerId: river.ownerId,
        region, axis: crossing.axis, boundaryIndex: crossing.boundaryIndex, side: crossing.side,
        position: crossing.point, level: interpolateOptional(a, b, 'level', crossing.t), width,
        tangent, bankInfluence, source: 'centerline', topology: river.geometry.topology }));
    }
  }
  return contracts;
}

function polylineBoundaryContracts(points, feature, region, level, source, topology) {
  const contracts = [];
  for (let i = 1; i < points.length; i++) {
    for (const crossing of boundaryIntersections(points[i - 1], points[i], region)) {
      contracts.push(makeContract({ featureId: feature.id, featureKind: feature.kind, ownerId: feature.ownerId,
        region, axis: crossing.axis, boundaryIndex: crossing.boundaryIndex, side: crossing.side,
        position: crossing.point, level, source, topology }));
    }
  }
  return contracts;
}

function surfaceBoundaryContracts(feature, region, limits) {
  const contracts = [];
  if (feature.source === 'sparse-component') return contracts;
  if (feature.source === 'basin-grid') {
    for (const sample of feature.surface.boundarySamples || []) {
      const point = gridPoint(sample[0], sample[1]);
      for (const edge of boundaryPoint(point, region)) contracts.push(makeContract({
        featureId: feature.id, featureKind: 'basin', ownerId: feature.ownerId, region,
        axis: edge.axis, boundaryIndex: edge.boundary / region.size, side: edge.side,
        position: point, level: sample[2], source: 'surface-sample', topology: feature.topology.shoreline,
      }));
    }
  } else {
    const fields = feature.surface.fields, index = new Map(fields.map((field, i) => [field, i]));
    for (const sample of feature.surface.samples || []) {
      const point = gridPoint(sample[index.get('x')], sample[index.get('z')]);
      for (const edge of boundaryPoint(point, region)) {
        const flow = index.has('flowX') && index.has('flowZ') && finite(sample[index.get('flowX')]) && finite(sample[index.get('flowZ')])
          ? { x: sample[index.get('flowX')], z: sample[index.get('flowZ')] } : null;
        contracts.push(makeContract({ featureId: feature.id, featureKind: 'component', ownerId: feature.ownerId,
          region, axis: edge.axis, boundaryIndex: edge.boundary / region.size, side: edge.side,
          position: point, level: index.has('head') ? sample[index.get('head')] : null,
          flow, source: 'surface-sample', topology: feature.topology.shoreline,
        }));
      }
    }
  }
  return contracts.slice(0, limits.maxBoundaryContracts);
}

function collectBoundaryContracts({ region, basins, rivers, components, limits }) {
  const contracts = [];
  for (const river of rivers) contracts.push(...riverContracts(river, region, limits));
  for (const basin of basins) {
    contracts.push(...surfaceBoundaryContracts(basin, region, limits));
    for (const loop of basin.shoreline.loops || []) contracts.push(...polylineBoundaryContracts(
      loop.points, { id: basin.id, kind: 'basin', ownerId: basin.ownerId }, region,
      basin.level, 'shoreline', basin.topology.shoreline));
  }
  for (const component of components) {
    contracts.push(...surfaceBoundaryContracts(component, region, limits));
    for (const loop of component.surface.shoreline.loops || []) contracts.push(...polylineBoundaryContracts(
      loop.points, { id: component.id, kind: 'component', ownerId: component.ownerId }, region,
      null, 'shoreline', component.topology.shoreline));
  }
  const unique = new Map();
  for (const contract of contracts) {
    const key = `${contract.featureKind}:${contract.featureId}:${contract.axis}:${contract.boundaryIndex}:${contract.position.x.toFixed(7)},${contract.position.z.toFixed(7)}`;
    if (!unique.has(key)) unique.set(key, contract);
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, limits.maxBoundaryContracts);
}

function topologySummary({ basins, rivers, components, boundaryContracts }) {
  const basinStatus = basins.length === 0 ? 'unknown' : basins.every(basin => basin.topology.shoreline === 'exact') ? 'exact' : 'partial';
  const riverStatus = rivers.length === 0 ? (components.length ? 'unknown' : 'unknown')
    : rivers.every(river => river.geometry.topology === 'exact') ? 'exact' : 'unknown';
  const componentStatus = components.length === 0 ? 'unknown'
    : components.every(component => component.topology.shoreline === 'exact') ? 'partial' : 'partial';
  const boundaryStatus = boundaryContracts.length ? 'partial' : 'unknown';
  return {
    overall: [basinStatus, riverStatus, componentStatus].includes('partial') ? 'partial'
      : [basinStatus, riverStatus, componentStatus].every(status => status === 'exact') ? 'exact' : 'unknown',
    basins: basinStatus, rivers: riverStatus, components: componentStatus, boundaries: boundaryStatus,
  };
}

export function watershedDescriptorFromWaterPlan(plan, options = {}) {
  const limits = normalizeLimits(options);
  const sourceErrors = sourcePlanErrors(plan, { verifyHash: options.verifyPlanHash === true, limits });
  if (sourceErrors.length) invalidSource('plan', '', sourceErrors);
  const ownerId = regionOwner(plan), region = regionFor(plan);
  const basins = (plan.basins || []).map(basin => extractBasin(basin, ownerId, region, limits))
    .sort((a, b) => a.id.localeCompare(b.id));
  const components = (plan.components || []).map(component => extractComponent(component, ownerId, limits))
    .sort((a, b) => a.id.localeCompare(b.id));
  const rivers = (plan.reaches || []).map(reach => routeDescriptor(reach, ownerId, limits))
    .sort((a, b) => a.id.localeCompare(b.id));
  const junctions = (plan.junctions || []).map(junction => extractJunction(junction, ownerId))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (junctions.length > limits.maxJunctions) invalidSource('plan', '', ['junction budget']);
  const basinIds = new Set(), componentBasinIds = new Set();
  for (const basin of basins) {
    if (basinIds.has(basin.id)) invalidSource('plan', '', [`duplicate basin ownership ${basin.id}`]);
    basinIds.add(basin.id);
  }
  for (const component of components) for (const id of component.basinIds) {
    if (basinIds.has(id) || componentBasinIds.has(id)) invalidSource('plan', '', [`duplicate basin ownership ${id}`]);
    componentBasinIds.add(id);
  }
  const reachIds = new Set();
  for (const river of rivers) reachIds.add(river.id);
  for (const component of components) for (const id of component.reachIds) {
    if (reachIds.has(id)) invalidSource('plan', '', [`duplicate reach ownership ${id}`]);
    reachIds.add(id);
  }
  const allBasins = [...basins, ...components.flatMap(component => component.basinRefs)];
  const boundaryContracts = collectBoundaryContracts({ region, basins, rivers, components, limits });
  const source = {
    kind: 'water-plan', planHash: plan.hash, hashVerified: options.verifyPlanHash === true,
    version: plan.version, generationVersion: plan.generationVersion, seed: plan.seed,
    regionX: plan.regionX, regionZ: plan.regionZ,
    regional: plan.regional === 1, preview: plan.preview === true,
  };
  const payload = {
    version: WATERSHED_DESCRIPTOR_VERSION, kind: 'watershed',
    id: `watershed:${plan.seed}:${plan.generationVersion}:${plan.regionX}:${plan.regionZ}:${plan.hash}`,
    ownerId, source, region,
    topology: topologySummary({ basins: allBasins, rivers, components, boundaryContracts }),
    basins: allBasins.sort((a, b) => a.id.localeCompare(b.id)), rivers, components, junctions, boundaryContracts,
  };
  const descriptor = { ...payload, hash: descriptorHash(payload) };
  const result = validateWatershedDescriptor(descriptor);
  if (!result.valid) invalidSource('descriptor', '', result.errors);
  return freezeDeep(descriptor);
}

export const createWatershedDescriptor = watershedDescriptorFromWaterPlan;
export const adaptWaterPlanToWatershedDescriptor = watershedDescriptorFromWaterPlan;
export const descriptorFromWaterPlan = watershedDescriptorFromWaterPlan;

function descriptorErrors(descriptor, { verifyHash = true } = {}) {
  const errors = [];
  if (!isObject(descriptor)) return ['descriptor-not-object'];
  if (descriptor.version !== WATERSHED_DESCRIPTOR_VERSION) errors.push('descriptor-version');
  if (descriptor.kind !== 'watershed') errors.push('descriptor-kind');
  if (!nonEmpty(descriptor.id)) errors.push('descriptor-id');
  if (!nonEmpty(descriptor.hash)) errors.push('descriptor-hash');
  if (!nonEmpty(descriptor.ownerId)) errors.push('descriptor-owner');
  if (!isObject(descriptor.source) || !nonEmpty(descriptor.source.planHash)
    || !Number.isSafeInteger(descriptor.source.seed) || !Number.isSafeInteger(descriptor.source.regionX)
    || !Number.isSafeInteger(descriptor.source.regionZ) || !Number.isSafeInteger(descriptor.source.generationVersion)) {
    errors.push('descriptor-source');
  }
  if (!isObject(descriptor.region) || !Number.isSafeInteger(descriptor.region.x) || !Number.isSafeInteger(descriptor.region.z)
    || descriptor.region.size !== WATERSHED_REGION_SIZE || !finiteBounds(descriptor.region.bounds)) errors.push('descriptor-region');
  for (const key of ['basins', 'rivers', 'components', 'junctions', 'boundaryContracts']) if (!Array.isArray(descriptor[key])) errors.push(`descriptor-${key}`);
  const ids = (key, label) => {
    const seen = new Set();
    for (const entry of descriptor[key] || []) {
      if (!isObject(entry) || !nonEmpty(entry.id)) { errors.push(`descriptor-${label}-id`); continue; }
      if (seen.has(entry.id)) errors.push(`descriptor-duplicate-${label}:${entry.id}`);
      seen.add(entry.id);
    }
  };
  ids('basins', 'basin'); ids('rivers', 'river'); ids('components', 'component'); ids('junctions', 'junction');
  const ownedBasins = new Set(), ownedReaches = new Set();
  for (const basin of descriptor.basins || []) {
    const componentReference = basin.source === 'sparse-component';
    if (!nonEmpty(basin.ownerId) || (!finite(basin.level) && !componentReference)
      || (!finiteBounds(basin.bounds) && !(componentReference && basin.bounds === null))
      || !isObject(basin.topology) || !isObject(basin.surface) || !isObject(basin.shoreline)) errors.push(`descriptor-basin:${basin.id || 'unknown'}`);
    if (ownedBasins.has(basin.id)) errors.push(`descriptor-basin-ownership:${basin.id}`);
    ownedBasins.add(basin.id);
    if (!Array.isArray(basin.shoreline.loops) || !Array.isArray(basin.shoreline.holes)) errors.push(`descriptor-basin-shoreline:${basin.id || 'unknown'}`);
    for (const loop of basin.shoreline.loops || []) checkLoop(loop, errors, `descriptor-basin-loop:${basin.id}`);
  }
  for (const river of descriptor.rivers || []) {
    if (!nonEmpty(river.ownerId) || !isObject(river.geometry) || !Array.isArray(river.geometry.centerline)
      || river.geometry.centerline.length < 2) errors.push(`descriptor-river:${river.id || 'unknown'}`);
    if (ownedReaches.has(river.id)) errors.push(`descriptor-reach-ownership:${river.id}`);
    ownedReaches.add(river.id);
    for (const point of river.geometry?.centerline || []) {
      if (!isObject(point) || !isObject(point.position) || !finite(point.position.x) || !finite(point.position.z)
        || !nullablePair(point.width) || !nullablePair(point.bankInfluence)) errors.push(`descriptor-river-point:${river.id || 'unknown'}`);
    }
  }
  for (const component of descriptor.components || []) {
    if (!nonEmpty(component.ownerId) || !Array.isArray(component.reachIds) || !uniqueStrings(component.reachIds)
      || !Array.isArray(component.basinIds) || !uniqueStrings(component.basinIds) || !isObject(component.surface)) {
      errors.push(`descriptor-component:${component.id || 'unknown'}`);
    }
    for (const id of component.reachIds || []) {
      if (ownedReaches.has(id)) errors.push(`descriptor-reach-ownership:${id}`);
      ownedReaches.add(id);
    }
    for (const id of component.basinIds || []) {
      const reference = (descriptor.basins || []).find(basin => basin.id === id);
      if (ownedBasins.has(id) && !(reference?.source === 'sparse-component' && reference.surfaceRef === component.sourceHash)) {
        errors.push(`descriptor-basin-ownership:${id}`);
      }
      ownedBasins.add(id);
    }
    const fields = component.surface?.fields, rows = component.surface?.samples;
    if (!Array.isArray(fields) || !Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== fields.length)) errors.push(`descriptor-component-samples:${component.id || 'unknown'}`);
    for (const loop of component.surface?.shoreline?.loops || []) checkLoop(loop, errors, `descriptor-component-loop:${component.id}`);
  }
  for (const contract of descriptor.boundaryContracts || []) checkContract(contract, errors);
  if (verifyHash && nonEmpty(descriptor.hash)) {
    try {
      const { hash, ...payload } = descriptor;
      if (descriptorHash(payload) !== hash) errors.push('descriptor-checksum');
    } catch { errors.push('descriptor-checksum'); }
  }
  return errors;
}

function checkLoop(loop, errors, label) {
  if (!isObject(loop) || !['outer', 'hole', 'unknown'].includes(loop.role) || !Array.isArray(loop.points) || loop.points.length < 3
    || loop.points.some(point => !isObject(point) || !finite(point.x) || !finite(point.z))) errors.push(label);
}

function nullablePair(value) {
  return value === null || (isObject(value) && ['left', 'right'].every(key => value[key] === null || finite(value[key])));
}

function checkContract(contract, errors) {
  if (!isObject(contract) || !nonEmpty(contract.id) || !nonEmpty(contract.featureId) || !nonEmpty(contract.ownerId)
    || !['river', 'basin', 'component'].includes(contract.featureKind) || !['x', 'z'].includes(contract.axis)
    || !Number.isInteger(contract.boundaryIndex) || !isObject(contract.position)
    || !finite(contract.position.x) || !finite(contract.position.z)
    || (contract.level !== null && !finite(contract.level))) errors.push('descriptor-boundary-contract');
  if (contract.width !== null && (!isObject(contract.width) || !['left', 'right'].every(key => contract.width[key] === null || finite(contract.width[key])))) errors.push('descriptor-boundary-width');
  if (contract.tangent !== null && (!isObject(contract.tangent) || !finite(contract.tangent.x) || !finite(contract.tangent.z))) errors.push('descriptor-boundary-tangent');
  if (contract.flow !== null && (!isObject(contract.flow) || !finite(contract.flow.x) || !finite(contract.flow.z))) errors.push('descriptor-boundary-flow');
}

export function validateWatershedDescriptor(descriptor, options = {}) {
  let errors;
  try { errors = descriptorErrors(descriptor, { verifyHash: options.verifyHash !== false }); }
  catch (error) { errors = [`descriptor-validation:${error.message}`]; }
  return { valid: errors.length === 0, errors };
}

export function assertWatershedDescriptor(descriptor, options = {}) {
  const result = validateWatershedDescriptor(descriptor, options);
  if (!result.valid) throw new Error(`Invalid watershed descriptor: ${result.errors.join(', ')}`);
  return descriptor;
}

export function descriptorBoundaryContracts(descriptor) {
  assertWatershedDescriptor(descriptor);
  return descriptor.boundaryContracts;
}

export const getWatershedBoundaryContracts = descriptorBoundaryContracts;
