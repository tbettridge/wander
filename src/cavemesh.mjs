// Fixed-resolution cave chunk meshing. This module has no THREE dependency and
// is shared by Web Workers and Node audits. Cubes are subdivided into the same
// six tetrahedra everywhere, so adjacent chunks agree on every shared face.

import { CAVE_HALF_EXTENT } from './cavefield.mjs';

export const CAVE_CHUNK_CELLS = 16;
const TETRAHEDRA = [
  [0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6],
  [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6],
];
const TET_EDGES = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];

function fnvAdd(hash, value) { return Math.imul(hash ^ (value | 0), 16777619); }
function quantize(value) { return Math.round(value * 2048); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function caveChunkGridSize(resolution) {
  if (resolution % CAVE_CHUNK_CELLS !== 0) {
    throw new Error(`Cave resolution ${resolution} must be divisible by ${CAVE_CHUNK_CELLS}`);
  }
  return resolution / CAVE_CHUNK_CELLS;
}

export function caveChunkKey(ix, iy, iz) { return `${ix}_${iy}_${iz}`; }

// Quality is expressed using the legacy 80-metre reference volume so the
// existing 32/48/64 settings retain exactly the same voxel density. Unlike the
// old fixed cube, chunks now continue with signed coordinates for as far as a
// graph extends.
export function caveVoxelSize(resolution) {
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new Error(`Invalid cave resolution ${resolution}`);
  }
  return (CAVE_HALF_EXTENT * 2) / resolution;
}

export function caveChunkWorldSize(resolution) {
  return caveVoxelSize(resolution) * CAVE_CHUNK_CELLS;
}

// Retain the old cube's -40m lattice origin. Existing caves therefore produce
// byte-identical sample positions at every quality, while signed indices allow
// the same lattice to continue in either direction beyond the old boundary.
export const CAVE_CHUNK_ORIGIN = -CAVE_HALF_EXTENT;

export function caveChunkCoordinatesAt(resolution, x, y, z) {
  const chunkSize = caveChunkWorldSize(resolution);
  return {
    ix: Math.floor((x - CAVE_CHUNK_ORIGIN) / chunkSize),
    iy: Math.floor((y - CAVE_CHUNK_ORIGIN) / chunkSize),
    iz: Math.floor((z - CAVE_CHUNK_ORIGIN) / chunkSize),
  };
}

export function caveChunkBounds(resolution, ix, iy, iz) {
  if (![ix, iy, iz].every(Number.isInteger)) {
    throw new Error(`Invalid cave chunk coordinates ${ix},${iy},${iz}`);
  }
  const cellSize = caveVoxelSize(resolution);
  const axisBounds = (index) => ({
    min: CAVE_CHUNK_ORIGIN + index * CAVE_CHUNK_CELLS * cellSize,
    max: CAVE_CHUNK_ORIGIN + (index + 1) * CAVE_CHUNK_CELLS * cellSize,
  });
  const x = axisBounds(ix), y = axisBounds(iy), z = axisBounds(iz);
  return {
    minX: x.min, minY: y.min, minZ: z.min,
    maxX: x.max, maxY: y.max, maxZ: z.max,
  };
}

function boundsIntersect(a, b) {
  return a.maxX >= b.minX && a.minX <= b.maxX
    && a.maxY >= b.minY && a.minY <= b.maxY
    && a.maxZ >= b.minZ && a.minZ <= b.maxZ;
}

function finiteBounds(bounds) {
  return bounds && [
    bounds.minX, bounds.minY, bounds.minZ,
    bounds.maxX, bounds.maxY, bounds.maxZ,
  ].every(Number.isFinite)
    && bounds.minX <= bounds.maxX
    && bounds.minY <= bounds.maxY
    && bounds.minZ <= bounds.maxZ;
}

function normalizeBounds(bounds) {
  if (!bounds) return null;
  if (finiteBounds(bounds)) return { ...bounds };
  if (Array.isArray(bounds.min) && Array.isArray(bounds.max)) {
    const normalized = {
      minX: bounds.min[0], minY: bounds.min[1], minZ: bounds.min[2],
      maxX: bounds.max[0], maxY: bounds.max[1], maxZ: bounds.max[2],
    };
    return finiteBounds(normalized) ? normalized : null;
  }
  return null;
}

function endpointRadius(edge, endpoint, axis) {
  const suffix = endpoint === 0 ? 'A' : 'B';
  const index = endpoint === 0 ? 0 : 1;
  const tuple = endpoint === 0 ? edge.rA : edge.rB;
  return tuple?.[axis === 'x' ? 0 : 1]
    ?? edge[`${axis === 'x' ? 'rx' : 'ry'}${suffix}`]
    ?? edge[`${axis === 'x' ? 'rx' : 'ry'}${index}`]
    ?? edge[axis === 'x' ? 'rx' : 'ry'];
}

function chamberRotation(chamber) {
  const rotation = chamber.rotation;
  if (Array.isArray(rotation)) return rotation;
  if (rotation && typeof rotation === 'object') {
    return [rotation.x || 0, rotation.y || 0, rotation.z || 0];
  }
  return [0, chamber.yaw ?? chamber.rotationY ?? (Number.isFinite(rotation) ? rotation : 0), 0];
}

// Absolute rotation matrix times the ellipsoid radii gives a conservative
// world-axis AABB for arbitrary Euler-rotated chambers. The generator normally
// uses yaw only, but accepting XYZ metadata keeps planning safe as the geology
// grammar grows.
function rotatedEllipsoidExtents(chamber) {
  const [rx, ry, rz] = chamber.r;
  const [x, y, z] = chamberRotation(chamber);
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  // THREE's default Euler order is XYZ: Rz * Ry * Rx for column vectors.
  const m00 = cz * cy;
  const m01 = cz * sy * sx - sz * cx;
  const m02 = cz * sy * cx + sz * sx;
  const m10 = sz * cy;
  const m11 = sz * sy * sx + cz * cx;
  const m12 = sz * sy * cx - cz * sx;
  const m20 = -sy;
  const m21 = cy * sx;
  const m22 = cy * cx;
  return [
    Math.abs(m00) * rx + Math.abs(m01) * ry + Math.abs(m02) * rz,
    Math.abs(m10) * rx + Math.abs(m11) * ry + Math.abs(m12) * rz,
    Math.abs(m20) * rx + Math.abs(m21) * ry + Math.abs(m22) * rz,
  ];
}

function primitiveBoundsForGraph(graph) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const primitiveBounds = [];
  const padding = graph.volume?.primitivePadding ?? graph.fieldPadding ?? 2.2;
  for (const edge of graph.edges) {
    const a = nodeById.get(edge.a)?.p, b = nodeById.get(edge.b)?.p;
    if (!a || !b) continue;
    const rxA = endpointRadius(edge, 0, 'x');
    const rxB = endpointRadius(edge, 1, 'x');
    const ryA = endpointRadius(edge, 0, 'y');
    const ryB = endpointRadius(edge, 1, 'y');
    const marginXZ = Math.max(rxA ?? 0, rxB ?? 0) + padding;
    const marginY = Math.max(ryA ?? 0, ryB ?? 0) + padding;
    primitiveBounds.push({
      kind: 'passage', id: edge.id,
      entrance: false,
      minX: Math.min(a[0], b[0]) - marginXZ, maxX: Math.max(a[0], b[0]) + marginXZ,
      minY: Math.min(a[1], b[1]) - marginY, maxY: Math.max(a[1], b[1]) + marginY,
      minZ: Math.min(a[2], b[2]) - marginXZ, maxZ: Math.max(a[2], b[2]) + marginXZ,
    });
  }
  for (const chamber of graph.chambers) {
    if (!Array.isArray(chamber.c) || !Array.isArray(chamber.r)) continue;
    const [extentX, extentY, extentZ] = rotatedEllipsoidExtents(chamber);
    primitiveBounds.push({
      kind: 'chamber', id: chamber.id,
      entrance: false,
      minX: chamber.c[0] - extentX - padding, maxX: chamber.c[0] + extentX + padding,
      minY: chamber.c[1] - extentY - padding, maxY: chamber.c[1] + extentY + padding,
      minZ: chamber.c[2] - extentZ - padding, maxZ: chamber.c[2] + extentZ + padding,
    });
  }
  if (graph.entrance) {
    const root = nodeById.get(graph.entrance.rootNodeId)?.p;
    const mouth = graph.entrance.mouth;
    if (root && Array.isArray(mouth)) {
      const marginXZ = graph.entrance.rx + padding, marginY = graph.entrance.ry + padding;
      primitiveBounds.push({
        kind: 'entrance', id: 'entrance', entrance: true,
        minX: Math.min(root[0], mouth[0]) - marginXZ,
        maxX: Math.max(root[0], mouth[0]) + marginXZ,
        minY: Math.min(root[1], mouth[1]) - marginY,
        maxY: Math.max(root[1], mouth[1]) + marginY,
        // The analytic portal is an infinite outward ray, but only the approved
        // transition between the -40m boundary, mouth, and root is renderable.
        minZ: Math.min(-CAVE_HALF_EXTENT, mouth[2]),
        maxZ: Math.max(root[2], mouth[2]) + marginXZ,
      });
    }
  }

  const suppliedPrimitiveBounds = graph.volume?.primitiveBounds;
  if (Array.isArray(suppliedPrimitiveBounds)) {
    for (let i = 0; i < suppliedPrimitiveBounds.length; i++) {
      const bounds = normalizeBounds(suppliedPrimitiveBounds[i]);
      if (bounds) primitiveBounds.push({
        ...bounds,
        kind: suppliedPrimitiveBounds[i].kind || 'volume-primitive',
        id: suppliedPrimitiveBounds[i].id || `volume-${i}`,
        entrance: !!suppliedPrimitiveBounds[i].entrance,
      });
    }
  }

  // A volume is a safe fallback for a future field representation that has no
  // explicit graph primitives. It is deliberately not added to an otherwise
  // sparse plan, which would fill every chunk in its bounding box.
  if (primitiveBounds.length === 0) {
    const volume = normalizeBounds(graph.volume?.bounds || graph.volume);
    if (volume) primitiveBounds.push({ ...volume, kind: 'volume', id: 'volume', entrance: false });
  }
  return primitiveBounds.filter(finiteBounds);
}

function chunkIndexRange(min, max, chunkSize) {
  // Chunks are half-open in planning. A primitive whose conservative maximum
  // lies exactly on a boundary does not need the next otherwise-empty chunk.
  const scale = Math.max(1, Math.abs(min), Math.abs(max), chunkSize);
  const epsilon = scale * Number.EPSILON * 8;
  return [
    Math.floor((min - CAVE_CHUNK_ORIGIN) / chunkSize),
    Math.floor((max - epsilon - CAVE_CHUNK_ORIGIN) / chunkSize),
  ];
}

export function createCaveChunkPlan(graph, resolution) {
  const cellSize = caveVoxelSize(resolution);
  const chunkSize = cellSize * CAVE_CHUNK_CELLS;
  const primitiveBounds = primitiveBoundsForGraph(graph);
  const plansByKey = new Map();

  for (let primitiveIndex = 0; primitiveIndex < primitiveBounds.length; primitiveIndex++) {
    const primitive = primitiveBounds[primitiveIndex];
    const [ix0, ix1] = chunkIndexRange(primitive.minX, primitive.maxX, chunkSize);
    const [iy0, iy1] = chunkIndexRange(primitive.minY, primitive.maxY, chunkSize);
    const [iz0, iz1] = chunkIndexRange(primitive.minZ, primitive.maxZ, chunkSize);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const bounds = caveChunkBounds(resolution, ix, iy, iz);
          if (!boundsIntersect(bounds, primitive)) continue;
          const key = caveChunkKey(ix, iy, iz);
          let plan = plansByKey.get(key);
          if (!plan) {
            plan = {
              key, ix, iy, iz, bounds,
              resolution, cellSize, voxelSize: cellSize, chunkSize,
              entrance: false,
              primitiveIndices: [],
            };
            plansByKey.set(key, plan);
          }
          plan.entrance ||= primitive.entrance;
          plan.primitiveIndices.push(primitiveIndex);
        }
      }
    }
  }

  return [...plansByKey.values()].sort((a, b) =>
    a.iz - b.iz || a.iy - b.iy || a.ix - b.ix);
}

function sampleFaceHashes(values, side) {
  const n = side + 1;
  const at = (x, y, z) => values[(z * n + y) * n + x];
  const hashFace = (axis, fixed) => {
    let hash = 2166136261;
    if (axis === 0) {
      for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) hash = fnvAdd(hash, quantize(at(fixed, y, z)));
    } else if (axis === 1) {
      for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) hash = fnvAdd(hash, quantize(at(x, fixed, z)));
    } else {
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) hash = fnvAdd(hash, quantize(at(x, y, fixed)));
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  };
  return {
    xmin: hashFace(0, 0), xmax: hashFace(0, side),
    ymin: hashFace(1, 0), ymax: hashFace(1, side),
    zmin: hashFace(2, 0), zmax: hashFace(2, side),
  };
}

function fieldNormal(sdf, p, epsilon = 0.32) {
  const e = Number.isFinite(epsilon) && epsilon > 0 ? epsilon : 0.32;
  // Negative field values are cave air, so -gradient faces into the cave.
  let x = -(sdf(p[0] + e, p[1], p[2]) - sdf(p[0] - e, p[1], p[2]));
  let y = -(sdf(p[0], p[1] + e, p[2]) - sdf(p[0], p[1] - e, p[2]));
  let z = -(sdf(p[0], p[1], p[2] + e) - sdf(p[0], p[1], p[2] - e));
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length < 1e-9) return [0, 1, 0];
  x /= length; y /= length; z /= length;
  return [x, y, z];
}

// The scalar field is linearly interpolated inside each tetrahedron, so its
// gradient there is constant and can be recovered exactly from the four
// sampled corner values. This is sufficient for polygon ordering/orientation
// and avoids six fresh SDF calls per intersecting tetrahedron. Final rendered
// normals still come from the continuous field at each surface vertex.
function tetraFieldNormal(points, values, fallback) {
  const p0 = points[0];
  const ax = points[1][0] - p0[0], ay = points[1][1] - p0[1], az = points[1][2] - p0[2];
  const bx = points[2][0] - p0[0], by = points[2][1] - p0[1], bz = points[2][2] - p0[2];
  const cx = points[3][0] - p0[0], cy = points[3][1] - p0[1], cz = points[3][2] - p0[2];
  const bcx = by * cz - bz * cy, bcy = bz * cx - bx * cz, bcz = bx * cy - by * cx;
  const cax = cy * az - cz * ay, cay = cz * ax - cx * az, caz = cx * ay - cy * ax;
  const abx = ay * bz - az * by, aby = az * bx - ax * bz, abz = ax * by - ay * bx;
  const determinant = ax * bcx + ay * bcy + az * bcz;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return fallback();
  const d1 = values[1] - values[0], d2 = values[2] - values[0], d3 = values[3] - values[0];
  const gx = (d1 * bcx + d2 * cax + d3 * abx) / determinant;
  const gy = (d1 * bcy + d2 * cay + d3 * aby) / determinant;
  const gz = (d1 * bcz + d2 * caz + d3 * abz) / determinant;
  const length = Math.hypot(gx, gy, gz);
  if (!Number.isFinite(length) || length < 1e-12) return fallback();
  // Negative values are cave air, so face toward -gradient.
  return [-gx / length, -gy / length, -gz / length];
}

function fieldGradient(sdf, p, epsilon) {
  const e = Number.isFinite(epsilon) && epsilon > 0 ? epsilon : 0.32;
  const xp = sdf(p[0] + e, p[1], p[2]);
  const xm = sdf(p[0] - e, p[1], p[2]);
  const yp = sdf(p[0], p[1] + e, p[2]);
  const ym = sdf(p[0], p[1] - e, p[2]);
  const zp = sdf(p[0], p[1], p[2] + e);
  const zm = sdf(p[0], p[1], p[2] - e);
  if (![xp, xm, yp, ym, zp, zm].every(Number.isFinite)) return null;
  const scale = 1 / (2 * e);
  return [(xp - xm) * scale, (yp - ym) * scale, (zp - zm) * scale];
}

function interpolate(a, b, va, vb) {
  const denom = va - vb;
  const t = Math.abs(denom) < 1e-12 ? 0.5 : clamp(va / denom, 0, 1);
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function polygonizeTetra(
  sdf,
  points,
  fieldValues,
  positions,
  normals,
  audit,
  normalEpsilon = 0.32,
  deferVertexAudit = false,
) {
  const intersections = [];
  for (const [ea, eb] of TET_EDGES) {
    const va = fieldValues[ea], vb = fieldValues[eb];
    if ((va < 0) === (vb < 0)) continue;
    const p = interpolate(points[ea], points[eb], va, vb);
    if (!intersections.some((q) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 < 1e-12)) {
      intersections.push(p);
    }
  }
  if (intersections.length < 3) return;

  const centroid = [0, 0, 0];
  for (const p of intersections) { centroid[0] += p[0]; centroid[1] += p[1]; centroid[2] += p[2]; }
  centroid[0] /= intersections.length; centroid[1] /= intersections.length; centroid[2] /= intersections.length;
  const desired = tetraFieldNormal(
    points,
    fieldValues,
    () => fieldNormal(sdf, centroid, normalEpsilon),
  );
  let ux, uy, uz;
  if (Math.abs(desired[1]) < 0.9) {
    ux = -desired[2]; uy = 0; uz = desired[0];
  } else {
    ux = 0; uy = desired[2]; uz = -desired[1];
  }
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const vx = desired[1] * uz - desired[2] * uy;
  const vy = desired[2] * ux - desired[0] * uz;
  const vz = desired[0] * uy - desired[1] * ux;
  intersections.sort((a, b) => {
    const adx = a[0] - centroid[0], ady = a[1] - centroid[1], adz = a[2] - centroid[2];
    const bdx = b[0] - centroid[0], bdy = b[1] - centroid[1], bdz = b[2] - centroid[2];
    return Math.atan2(adx * vx + ady * vy + adz * vz, adx * ux + ady * uy + adz * uz)
      - Math.atan2(bdx * vx + bdy * vy + bdz * vz, bdx * ux + bdy * uy + bdz * uz);
  });

  const a = intersections[0], b = intersections[1], c = intersections[2];
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const cross = [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx];
  if (cross[0] * desired[0] + cross[1] * desired[1] + cross[2] * desired[2] < 0) intersections.reverse();

  // meshImplicitBox projects every welded vertex and regenerates its normal
  // afterward. Avoid doing those expensive field samples once per duplicated
  // triangle-soup vertex on that path; streamed chunks still use the original
  // immediate audit/normal path unchanged.
  const pointNormals = deferVertexAudit
    ? null
    : intersections.map((p) => fieldNormal(sdf, p, normalEpsilon));
  for (let i = 1; i < intersections.length - 1; i++) {
    const tri = [0, i, i + 1];
    const p0 = intersections[tri[0]], p1 = intersections[tri[1]], p2 = intersections[tri[2]];
    const ux2 = p1[0] - p0[0], uy2 = p1[1] - p0[1], uz2 = p1[2] - p0[2];
    const vx2 = p2[0] - p0[0], vy2 = p2[1] - p0[1], vz2 = p2[2] - p0[2];
    const area2 = Math.hypot(uy2 * vz2 - uz2 * vy2, uz2 * vx2 - ux2 * vz2, ux2 * vy2 - uy2 * vx2);
    if (area2 < 1e-8) continue;
    for (const index of tri) {
      const p = intersections[index], n = pointNormals?.[index] || desired;
      positions.push(p[0], p[1], p[2]);
      normals.push(n[0], n[1], n[2]);
      if (!deferVertexAudit) audit.surfaceError += Math.abs(sdf(p[0], p[1], p[2]));
      audit.samples++;
      if (Number.isFinite(p[0] + p[1] + p[2] + n[0] + n[1] + n[2])) audit.finite++;
    }
    audit.triangles++;
  }
}

// Marching tetrahedra emits the same edge intersection from each tetra/cell
// that touches it. Collapse those copies into one deterministic indexed
// vertex. The tolerance is deliberately tiny relative to a grid cell: it
// absorbs floating-point differences from reversed edge interpolation without
// merging nearby folds or separate sheets of the implicit surface.
function weldTriangleSoup(positions, normals, tolerance) {
  const uniquePositions = [];
  const uniqueNormals = [];
  const indices = [];
  const buckets = new Map();
  const toleranceSq = tolerance * tolerance;
  const bucketKey = (x, y, z) => `${x},${y},${z}`;

  for (let offset = 0; offset < positions.length; offset += 3) {
    const px = positions[offset], py = positions[offset + 1], pz = positions[offset + 2];
    const bx = Math.floor(px / tolerance), by = Math.floor(py / tolerance), bz = Math.floor(pz / tolerance);
    let vertexIndex = -1;

    // A point within tolerance can fall in the same or an adjacent bucket.
    // Fixed traversal order plus first-writer ownership keeps indices stable.
    for (let dz = -1; dz <= 1 && vertexIndex < 0; dz++) {
      for (let dy = -1; dy <= 1 && vertexIndex < 0; dy++) {
        for (let dx = -1; dx <= 1 && vertexIndex < 0; dx++) {
          const candidates = buckets.get(bucketKey(bx + dx, by + dy, bz + dz));
          if (!candidates) continue;
          for (const candidate of candidates) {
            const positionOffset = candidate * 3;
            const ex = uniquePositions[positionOffset] - px;
            const ey = uniquePositions[positionOffset + 1] - py;
            const ez = uniquePositions[positionOffset + 2] - pz;
            if (ex * ex + ey * ey + ez * ez <= toleranceSq) {
              vertexIndex = candidate;
              break;
            }
          }
        }
      }
    }

    if (vertexIndex < 0) {
      vertexIndex = uniquePositions.length / 3;
      uniquePositions.push(px, py, pz);
      uniqueNormals.push(normals[offset], normals[offset + 1], normals[offset + 2]);
      const key = bucketKey(bx, by, bz);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(vertexIndex);
      else buckets.set(key, [vertexIndex]);
    }
    indices.push(vertexIndex);
  }

  const vertexCount = uniquePositions.length / 3;
  return {
    positions: new Float32Array(uniquePositions),
    normals: new Float32Array(uniqueNormals),
    indices: vertexCount <= 65536 ? new Uint16Array(indices) : new Uint32Array(indices),
  };
}

// Linear edge interpolation is topologically reliable, but on a curved or
// smoothly combined field it does not necessarily land exactly on sdf=0.
// Project each already-welded vertex once along the numerical gradient, then
// regenerate its field normal at the accepted position. A bounded Newton step
// and deterministic backtracking keep pathological/flat fields from throwing
// vertices across a cell or making a previously good estimate worse.
function projectImplicitVertices(sdf, positions, normalEpsilon, maxStep) {
  const projected = new Float32Array(positions.length);
  const normals = new Float32Array(positions.length);
  const stepLimit = Number.isFinite(maxStep) && maxStep > 0 ? maxStep : Infinity;
  let preErrorSum = 0, preErrorMax = 0, postErrorSum = 0, postErrorMax = 0;
  let errorSamples = 0, finite = true, projectedVertices = 0;

  for (let offset = 0; offset < positions.length; offset += 3) {
    const original = [positions[offset], positions[offset + 1], positions[offset + 2]];
    let accepted = original;
    const initialValue = sdf(original[0], original[1], original[2]);
    const initialError = Math.abs(initialValue);
    if (Number.isFinite(initialError)) {
      preErrorSum += initialError;
      preErrorMax = Math.max(preErrorMax, initialError);

      if (initialError > 1e-8) {
        const gradient = fieldGradient(sdf, original, normalEpsilon);
        const lengthSq = gradient
          ? gradient[0] ** 2 + gradient[1] ** 2 + gradient[2] ** 2
          : 0;
        if (Number.isFinite(lengthSq) && lengthSq > 1e-12) {
          let stepScale = initialValue / lengthSq;
          const stepLength = Math.sqrt(lengthSq) * Math.abs(stepScale);
          if (stepLength > stepLimit) stepScale *= stepLimit / stepLength;

          // The full Newton step normally wins. Half/quarter steps are a
          // finite, fixed fallback for sharp max/smooth-min transition zones.
          for (const fraction of [1, 0.5, 0.25]) {
            const candidate = [
              original[0] - gradient[0] * stepScale * fraction,
              original[1] - gradient[1] * stepScale * fraction,
              original[2] - gradient[2] * stepScale * fraction,
            ];
            if (!candidate.every(Number.isFinite)) continue;
            const candidateValue = sdf(candidate[0], candidate[1], candidate[2]);
            if (Number.isFinite(candidateValue) && Math.abs(candidateValue) < initialError) {
              accepted = candidate;
              projectedVertices++;
              break;
            }
          }
        }
      }
    } else {
      finite = false;
    }

    projected[offset] = accepted[0];
    projected[offset + 1] = accepted[1];
    projected[offset + 2] = accepted[2];
    const stored = [projected[offset], projected[offset + 1], projected[offset + 2]];
    const normal = fieldNormal(sdf, stored, normalEpsilon);
    normals[offset] = normal[0];
    normals[offset + 1] = normal[1];
    normals[offset + 2] = normal[2];

    const storedValue = sdf(stored[0], stored[1], stored[2]);
    if (Number.isFinite(storedValue)) {
      const error = Math.abs(storedValue);
      postErrorSum += error;
      postErrorMax = Math.max(postErrorMax, error);
      errorSamples++;
    } else {
      finite = false;
    }
    if (![...stored, ...normal].every(Number.isFinite)) finite = false;
  }

  const vertexCount = positions.length / 3;
  return {
    positions: projected,
    normals,
    finite,
    projectedVertices,
    preMeanSurfaceError: vertexCount ? preErrorSum / vertexCount : 0,
    preMaxSurfaceError: preErrorMax,
    meanSurfaceError: errorSamples ? postErrorSum / errorSamples : 0,
    maxSurfaceError: postErrorMax,
  };
}

// Meshing entry point for small, non-chunked implicit transition volumes. It
// uses the exact same tetrahedral cases and normal convention as cave chunks,
// allowing a local terrain-minus-cave field to meet the streamed cave without
// introducing a second surface representation.
export function meshImplicitBox(
  sdf,
  bounds,
  { nx = 28, ny = 24, nz = 32, normalEpsilon = null } = {},
) {
  const sx = (bounds.maxX - bounds.minX) / nx;
  const sy = (bounds.maxY - bounds.minY) / ny;
  const sz = (bounds.maxZ - bounds.minZ) / nz;
  const minCellSize = Math.min(Math.abs(sx), Math.abs(sy), Math.abs(sz));
  const resolvedNormalEpsilon = Number.isFinite(normalEpsilon) && normalEpsilon > 0
    ? normalEpsilon
    : Math.max(1e-4, minCellSize * 0.65);
  const gx = nx + 1, gy = ny + 1, gz = nz + 1;
  const values = new Float32Array(gx * gy * gz);
  const index = (x, y, z) => (z * gy + y) * gx + x;
  for (let z = 0; z < gz; z++) {
    for (let y = 0; y < gy; y++) {
      for (let x = 0; x < gx; x++) {
        values[index(x, y, z)] = sdf(
          bounds.minX + x * sx,
          bounds.minY + y * sy,
          bounds.minZ + z * sz,
        );
      }
    }
  }

  const cornerOffsets = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const positions = [], normals = [];
  const audit = { triangles: 0, surfaceError: 0, samples: 0, finite: 0 };
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const cubePoints = cornerOffsets.map(([dx, dy, dz]) => [
          bounds.minX + (x + dx) * sx,
          bounds.minY + (y + dy) * sy,
          bounds.minZ + (z + dz) * sz,
        ]);
        const cubeValues = cornerOffsets.map(([dx, dy, dz]) => values[index(x + dx, y + dy, z + dz)]);
        const mask = cubeValues.reduce((result, value, bit) => result | (value < 0 ? (1 << bit) : 0), 0);
        if (mask === 0 || mask === 255) continue;
        for (const tetra of TETRAHEDRA) {
          polygonizeTetra(
            sdf,
            tetra.map((corner) => cubePoints[corner]),
            tetra.map((corner) => cubeValues[corner]),
            positions,
            normals,
            audit,
            resolvedNormalEpsilon,
            true,
          );
        }
      }
    }
  }
  const welded = weldTriangleSoup(positions, normals, Math.max(1e-9, minCellSize * 1e-5));
  const projected = projectImplicitVertices(
    sdf,
    welded.positions,
    resolvedNormalEpsilon,
    Math.max(1e-4, minCellSize * 0.75),
  );
  return {
    positions: projected.positions,
    normals: projected.normals,
    indices: welded.indices,
    triangles: audit.triangles,
    meanSurfaceError: projected.meanSurfaceError,
    maxSurfaceError: projected.maxSurfaceError,
    preProjectionMeanSurfaceError: projected.preMeanSurfaceError,
    preProjectionMaxSurfaceError: projected.preMaxSurfaceError,
    projectedVertices: projected.projectedVertices,
    finite: audit.finite === audit.samples && projected.finite,
    normalEpsilon: resolvedNormalEpsilon,
    sourceVertices: positions.length / 3,
  };
}

const sparsePlanCache = new WeakMap();

function sparsePlanForGraph(graph, resolution) {
  let byResolution = sparsePlanCache.get(graph);
  if (!byResolution) {
    byResolution = new Map();
    sparsePlanCache.set(graph, byResolution);
  }
  let plans = byResolution.get(resolution);
  if (!plans) {
    plans = new Map(createCaveChunkPlan(graph, resolution).map((plan) => [plan.key, plan]));
    byResolution.set(resolution, plans);
  }
  return plans;
}

function boundsAlmostEqual(a, b) {
  const tolerance = Math.max(
    1,
    ...Object.values(a).map(Math.abs),
    ...Object.values(b).map(Math.abs),
  ) * 1e-10;
  return ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ']
    .every((key) => Math.abs(a[key] - b[key]) <= tolerance);
}

function resolveChunkRequest(field, resolution, ixOrPlan, iy, iz) {
  const explicit = ixOrPlan && typeof ixOrPlan === 'object';
  const ix = explicit ? ixOrPlan.ix : ixOrPlan;
  const resolvedIy = explicit ? ixOrPlan.iy : iy;
  const resolvedIz = explicit ? ixOrPlan.iz : iz;
  if (![ix, resolvedIy, resolvedIz].every(Number.isInteger)) {
    throw new Error(`Invalid cave chunk ${ix},${resolvedIy},${resolvedIz}`);
  }
  if (explicit && ixOrPlan.resolution !== undefined && Number(ixOrPlan.resolution) !== Number(resolution)) {
    throw new Error(`Cave plan resolution ${ixOrPlan.resolution} does not match ${resolution}`);
  }

  const key = caveChunkKey(ix, resolvedIy, resolvedIz);
  const derivedBounds = caveChunkBounds(resolution, ix, resolvedIy, resolvedIz);
  const bounds = explicit && finiteBounds(ixOrPlan.bounds) ? ixOrPlan.bounds : derivedBounds;
  if (!boundsAlmostEqual(bounds, derivedBounds)) {
    throw new Error(`Cave plan ${key} bounds do not match its signed chunk coordinates`);
  }

  // Generated fields expose their source graph. Refuse accidental dense-cube
  // requests outside its sparse plan; synthetic fields without a graph remain
  // useful for standalone mesher tests.
  let sparsePlan = null;
  if (field.graph) {
    sparsePlan = sparsePlanForGraph(field.graph, resolution).get(key);
    if (!sparsePlan) throw new Error(`Cave chunk ${key} is outside the sparse graph plan`);
    if (!boundsAlmostEqual(bounds, sparsePlan.bounds)) {
      throw new Error(`Cave chunk ${key} disagrees with the canonical sparse plan bounds`);
    }
  }
  return {
    ...(sparsePlan || {}),
    ...(explicit ? ixOrPlan : {}),
    key, ix, iy: resolvedIy, iz: resolvedIz, bounds: { ...bounds },
    resolution: Number(resolution),
    cellSize: caveVoxelSize(resolution),
    voxelSize: caveVoxelSize(resolution),
    chunkSize: caveChunkWorldSize(resolution),
  };
}

// `ixOrPlan` accepts either a signed X coordinate (legacy positional API) or
// one of createCaveChunkPlan's explicit plan records. The latter is the worker
// contract for large caves because it carries canonical bounds and metadata.
export function meshCaveChunk(field, resolution, ixOrPlan, iy, iz) {
  const plan = resolveChunkRequest(field, resolution, ixOrPlan, iy, iz);
  const { ix, iy: resolvedIy, iz: resolvedIz } = plan;
  const started = performance.now();
  const side = CAVE_CHUNK_CELLS;
  const samplesPerSide = side + 1;
  const cellSize = plan.cellSize;
  // Address samples by their global signed cell index, not by repeatedly
  // adding to a chunk minimum. Neighboring chunks therefore evaluate their
  // shared face at bit-identical coordinates even far from the origin.
  const sampleX = (x) => CAVE_CHUNK_ORIGIN + (ix * side + x) * cellSize;
  const sampleY = (y) => CAVE_CHUNK_ORIGIN + (resolvedIy * side + y) * cellSize;
  const sampleZ = (z) => CAVE_CHUNK_ORIGIN + (resolvedIz * side + z) * cellSize;
  const sdf = field.sdfForBounds?.(plan.bounds) ?? field.sdf;
  if (typeof sdf !== 'function') throw new Error(`Cave field has no SDF for chunk ${plan.key}`);
  const values = new Float32Array(samplesPerSide ** 3);
  const index = (x, y, z) => (z * samplesPerSide + y) * samplesPerSide + x;
  let hasNegative = false, hasPositive = false;
  for (let z = 0; z <= side; z++) {
    for (let y = 0; y <= side; y++) {
      for (let x = 0; x <= side; x++) {
        const value = sdf(sampleX(x), sampleY(y), sampleZ(z));
        values[index(x, y, z)] = value;
        if (value < 0) hasNegative = true; else hasPositive = true;
      }
    }
  }
  const faceHashes = sampleFaceHashes(values, side);
  const positions = [], normals = [];
  const audit = { triangles: 0, surfaceError: 0, samples: 0, finite: 0 };

  if (hasNegative && hasPositive) {
    const cornerOffsets = [
      [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
      [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
    ];
    for (let z = 0; z < side; z++) {
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          const cubePoints = cornerOffsets.map(([dx, dy, dz]) => [
            sampleX(x + dx),
            sampleY(y + dy),
            sampleZ(z + dz),
          ]);
          const cubeValues = cornerOffsets.map(([dx, dy, dz]) => values[index(x + dx, y + dy, z + dz)]);
          const mask = cubeValues.reduce((result, value, bit) => result | (value < 0 ? (1 << bit) : 0), 0);
          if (mask === 0 || mask === 255) continue;
          for (const tetra of TETRAHEDRA) {
            polygonizeTetra(
              sdf,
              tetra.map((corner) => cubePoints[corner]),
              tetra.map((corner) => cubeValues[corner]),
              positions,
              normals,
              audit,
            );
          }
        }
      }
    }
  }

  const positionArray = new Float32Array(positions);
  const normalArray = new Float32Array(normals);
  return {
    key: plan.key, ix, iy: resolvedIy, iz: resolvedIz, resolution,
    bounds: plan.bounds, cellSize, voxelSize: cellSize, chunkSize: plan.chunkSize,
    positions: positionArray,
    normals: normalArray,
    triangles: audit.triangles,
    faceHashes,
    generationMs: performance.now() - started,
    bytes: positionArray.byteLength + normalArray.byteLength,
    audit: {
      finite: audit.finite === audit.samples,
      meanSurfaceError: audit.samples ? audit.surfaceError / audit.samples : 0,
      samples: audit.samples,
    },
  };
}
