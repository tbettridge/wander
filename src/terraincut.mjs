// Pure helpers for the seamless cave/heightfield boundary. The streamed
// terrain keeps its coarse grid away from an entrance, while affected cells
// are replaced by a dense collar that exactly shares the coarse cell edges and
// is clipped by the same signed aperture field as the implicit cave fold.

function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }
function smoothstep(a, b, value) {
  const t = clamp((value - a) / Math.max(1e-9, b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function mix(a, b, t) { return a + (b - a) * t; }

export const DEFAULT_CAVE_CUT = Object.freeze({
  minAlong: -4.2,
  maxAlong: 1.55,
  outerHalfWidth: 1.80,
  middleHalfWidth: 2.05,
  innerHalfWidth: 1.85,
});

export function caveCutProfile(spec = null) {
  return { ...DEFAULT_CAVE_CUT, ...(spec?.cut || {}) };
}

export function caveCutHalfWidth(along, spec = null) {
  const profile = caveCutProfile(spec);
  const span = Math.max(1e-6, profile.maxAlong - profile.minAlong);
  const t = clamp((along - profile.minAlong) / span, 0, 1);
  let width = mix(profile.outerHalfWidth, profile.middleHalfWidth, smoothstep(0, 0.72, t));
  width = mix(width, profile.innerHalfWidth, smoothstep(0.72, 1, t));
  return width;
}

export function caveCutFrame(worldX, worldZ, spec) {
  const length = Math.hypot(spec?.inwardX || 0, spec?.inwardZ || 0) || 1;
  const inwardX = (spec?.inwardX || 0) / length;
  const inwardZ = (spec?.inwardZ || 0) / length;
  const dx = worldX - (spec?.x || 0), dz = worldZ - (spec?.z || 0);
  return {
    along: dx * inwardX + dz * inwardZ,
    side: dx * inwardZ - dz * inwardX,
  };
}

export function caveCutContainsLocal(side, along, spec = null, inset = 0) {
  const profile = caveCutProfile(spec);
  if (along < profile.minAlong + inset || along > profile.maxAlong - inset) return false;
  return Math.abs(side) < Math.max(0, caveCutHalfWidth(along, spec) - inset);
}

export function caveCutContainsWorld(worldX, worldZ, spec, inset = 0) {
  if (!spec) return false;
  if (typeof spec.cutValueAt === 'function' && inset === 0) return spec.cutValueAt(worldX, worldZ) < 0;
  const frame = caveCutFrame(worldX, worldZ, spec);
  return caveCutContainsLocal(frame.side, frame.along, spec, inset);
}

// Piecewise-linear height on the terrain's fixed diagonal:
//   triangle 1 = a(0,0), c(0,1), b(1,0)
//   triangle 2 = b(1,0), c(0,1), d(1,1)
export function splitQuadWeights(fx, fz) {
  const x = clamp(fx, 0, 1), z = clamp(fz, 0, 1);
  if (x + z <= 1) return [1 - x - z, x, z, 0];
  return [0, 1 - z, 1 - x, x + z - 1];
}

export function splitQuadValue(a, b, c, d, fx, fz) {
  const w = splitQuadWeights(fx, fz);
  return a * w[0] + b * w[1] + c * w[2] + d * w[3];
}

function interpolateVertex(a, b, t) {
  const out = {};
  for (const key of ['x', 'y', 'z', 'nx', 'ny', 'nz', 'r', 'g', 'b']) out[key] = mix(a[key], b[key], t);
  const length = Math.hypot(out.nx, out.ny, out.nz) || 1;
  out.nx /= length; out.ny /= length; out.nz /= length;
  out.cut = 0;
  out.clipped = true;
  return out;
}

// Keep the solid/outside portion (cut >= 0) of a triangle. The signed field is
// linearly interpolated along each micro-edge, yielding an explicit aperture
// boundary instead of a second centroid decision.
function clipOutside(triangle, cutValueAt = null) {
  const output = [];
  for (let i = 0; i < triangle.length; i++) {
    const current = triangle[i], next = triangle[(i + 1) % triangle.length];
    const currentOut = current.cut >= 0, nextOut = next.cut >= 0;
    if (currentOut && nextOut) output.push(next);
    else if (currentOut !== nextOut) {
      let t = clamp(current.cut / (current.cut - next.cut), 0, 1);
      // Linear interpolation is exact for a linear footprint. The production
      // aperture is a smooth implicit field, so refine its root on the dense
      // micro-edge. This leaves every emitted lip vertex on the same signed
      // boundary used by the folded entrance instead of merely near it.
      if (cutValueAt) {
        const sample = (value) => cutValueAt(
          mix(current.x, next.x, value),
          mix(current.z, next.z, value),
        );
        let rootValue = sample(t);
        if (Math.abs(rootValue) > 1e-6) {
          let lo = 0, hi = 1, loValue = current.cut;
          if ((rootValue >= 0) === (loValue >= 0)) {
            lo = t;
            loValue = rootValue;
          } else {
            hi = t;
          }
          for (let iteration = 0; iteration < 16; iteration++) {
            t = (lo + hi) * 0.5;
            rootValue = sample(t);
            if ((rootValue >= 0) === (loValue >= 0)) {
              lo = t;
              loValue = rootValue;
            } else {
              hi = t;
            }
          }
          t = (lo + hi) * 0.5;
        }
      }
      output.push(interpolateVertex(current, next, t));
      if (nextOut) output.push(next);
    }
  }
  return output;
}

function triangleArea2(a, b, c) {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

function weldTriangles(triangles, tolerance = 1e-5) {
  const positions = [], normals = [], colors = [], indices = [];
  const vertices = new Map();
  const inv = 1 / tolerance;
  const indexFor = (vertex) => {
    const key = `${Math.round(vertex.x * inv)},${Math.round(vertex.y * inv)},${Math.round(vertex.z * inv)}`;
    let index = vertices.get(key);
    if (index !== undefined) return index;
    index = positions.length / 3;
    vertices.set(key, index);
    positions.push(vertex.x, vertex.y, vertex.z);
    normals.push(vertex.nx, vertex.ny, vertex.nz);
    colors.push(vertex.r, vertex.g, vertex.b);
    return index;
  };
  for (const triangle of triangles) {
    if (triangleArea2(triangle[0], triangle[1], triangle[2]) < 1e-8) continue;
    indices.push(indexFor(triangle[0]), indexFor(triangle[1]), indexFor(triangle[2]));
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}

// Build a dense replacement for every terrain cell touched by collarWeightAt.
// `sampleProcedural(x,z)` returns the continuous terrain {height,normal,color}
// near the cave. Original grid attributes remain authoritative at weight 0.
export function buildTerrainCutPatch({
  positions,
  normals,
  colors,
  sourceIndices,
  res,
  chunkSize,
  cx,
  cz,
  cutValueAt,
  collarWeightAt,
  sampleProcedural,
  supportBounds = null,
  targetSpacing = 0.30,
}) {
  const n = res + 1;
  const step = chunkSize / res;
  const x0 = cx * chunkSize, z0 = cz * chunkSize;
  const topIndexCount = res * res * 6;
  const kept = [];
  const triangles = [];
  let replacedCells = 0;
  const sampleCache = new Map();
  const attribute = (array, vertex, component) => array[vertex * 3 + component];
  const proceduralAt = (x, z) => {
    const key = `${Math.round(x * 1e5)},${Math.round(z * 1e5)}`;
    let value = sampleCache.get(key);
    if (!value) { value = sampleProcedural(x, z); sampleCache.set(key, value); }
    return value;
  };

  // Sample the original piecewise-linear heightfield with the exact same
  // fixed diagonal used by the source terrain. Keeping this sampler global to
  // the chunk (rather than tied to the cell currently being tessellated) lets
  // finite differences cross replacement-cell boundaries without introducing
  // a shading seam.
  const coarseAt = (x, z) => {
    const gridX = clamp((x - x0) / step, 0, res);
    const gridZ = clamp((z - z0) / step, 0, res);
    const cellX = Math.min(res - 1, Math.floor(gridX));
    const cellZ = Math.min(res - 1, Math.floor(gridZ));
    const fx = gridX - cellX, fz = gridZ - cellZ;
    const a = cellZ * n + cellX, b = a + 1, c = a + n, d = c + 1;
    const ids = [a, b, c, d];
    const weights = splitQuadWeights(fx, fz);
    const result = { height: 0, nx: 0, ny: 0, nz: 0, r: 0, g: 0, b: 0 };
    for (let i = 0; i < 4; i++) {
      const weight = weights[i];
      result.height += attribute(positions, ids[i], 1) * weight;
      result.nx += attribute(normals, ids[i], 0) * weight;
      result.ny += attribute(normals, ids[i], 1) * weight;
      result.nz += attribute(normals, ids[i], 2) * weight;
      result.r += attribute(colors, ids[i], 0) * weight;
      result.g += attribute(colors, ids[i], 1) * weight;
      result.b += attribute(colors, ids[i], 2) * weight;
    }
    return result;
  };

  // This is the actual surface represented by the collar. Normals must be
  // derived from this blended height, not from a blend of endpoint normals:
  // the latter omits d(weight)/dx and d(weight)/dz and produces conspicuous
  // lighting bands around the fold.
  const finalHeightAt = (x, z) => {
    const coarse = coarseAt(x, z);
    const blend = clamp(collarWeightAt(x, z), 0, 1);
    if (blend <= 0) return coarse.height;
    const procedural = proceduralAt(x, z);
    return mix(coarse.height, procedural.height, blend);
  };
  const normalStep = Math.max(1e-4, Math.min(targetSpacing * 0.5, step * 0.2));
  const surfaceNormalAt = (x, z, coarse, blend) => {
    // Weight zero is the exact coarse handoff. Preserve the source normal
    // there so both position and shading meet the untouched terrain exactly.
    if (blend <= 1e-5) {
      const length = Math.hypot(coarse.nx, coarse.ny, coarse.nz) || 1;
      return [coarse.nx / length, coarse.ny / length, coarse.nz / length];
    }
    const left = Math.max(x0, x - normalStep);
    const right = Math.min(x0 + chunkSize, x + normalStep);
    const back = Math.max(z0, z - normalStep);
    const front = Math.min(z0 + chunkSize, z + normalStep);
    const dhdx = right > left ? (finalHeightAt(right, z) - finalHeightAt(left, z)) / (right - left) : 0;
    const dhdz = front > back ? (finalHeightAt(x, front) - finalHeightAt(x, back)) / (front - back) : 0;
    const length = Math.hypot(dhdx, 1, dhdz) || 1;
    return [-dhdx / length, 1 / length, -dhdz / length];
  };

  // The support envelope is deliberately wider than the aperture. Keeping it
  // authoritative also guarantees that its zero-weight perimeter is a closed,
  // exact ring on the original coarse terrain.
  const supportAt = (x, z) => collarWeightAt(x, z) > 1e-5;
  const cellSupported = (cellX, cellZ) => {
    if (supportBounds) {
      const minX = x0 + cellX * step, minZ = z0 + cellZ * step;
      if (minX > supportBounds.maxX || minX + step < supportBounds.minX
        || minZ > supportBounds.maxZ || minZ + step < supportBounds.minZ) return false;
    }
    for (let sz = 0; sz <= 2; sz++) {
      for (let sx = 0; sx <= 2; sx++) {
        if (supportAt(x0 + (cellX + sx * 0.5) * step, z0 + (cellZ + sz * 0.5) * step)) return true;
      }
    }
    return false;
  };

  const cellVertex = (cellX, cellZ, fx, fz) => {
    const x = x0 + (cellX + fx) * step, z = z0 + (cellZ + fz) * step;
    const coarse = coarseAt(x, z);
    const procedural = proceduralAt(x, z);
    const blend = clamp(collarWeightAt(x, z), 0, 1);
    const [nx, ny, nz] = surfaceNormalAt(x, z, coarse, blend);
    return {
      x,
      y: mix(coarse.height, procedural.height, blend),
      z,
      nx, ny, nz,
      r: mix(coarse.r, procedural.color[0], blend),
      g: mix(coarse.g, procedural.color[1], blend),
      b: mix(coarse.b, procedural.color[2], blend),
      cut: cutValueAt(x, z),
    };
  };

  // Clipping introduces vertices between dense samples. Refresh those normals
  // from the same final height function too, rather than retaining a linear
  // interpolation of two already-normalized vectors.
  const refreshSurfaceNormal = (vertex) => {
    const coarse = coarseAt(vertex.x, vertex.z);
    const blend = clamp(collarWeightAt(vertex.x, vertex.z), 0, 1);
    vertex.y = finalHeightAt(vertex.x, vertex.z);
    [vertex.nx, vertex.ny, vertex.nz] = surfaceNormalAt(vertex.x, vertex.z, coarse, blend);
    return vertex;
  };

  for (let cellZ = 0; cellZ < res; cellZ++) {
    for (let cellX = 0; cellX < res; cellX++) {
      const sourceOffset = (cellZ * res + cellX) * 6;
      if (!cellSupported(cellX, cellZ)) {
        for (let i = 0; i < 6; i++) kept.push(sourceIndices[sourceOffset + i]);
        continue;
      }
      replacedCells++;
      const subdivisions = Math.max(2, Math.ceil(step / targetSpacing));
      const grid = new Array((subdivisions + 1) ** 2);
      const at = (x, z) => z * (subdivisions + 1) + x;
      for (let z = 0; z <= subdivisions; z++) {
        for (let x = 0; x <= subdivisions; x++) {
          grid[at(x, z)] = cellVertex(cellX, cellZ, x / subdivisions, z / subdivisions);
        }
      }
      const emit = (triangle) => {
        const polygon = clipOutside(triangle, cutValueAt);
        for (const vertex of polygon) if (vertex.clipped) refreshSurfaceNormal(vertex);
        for (let i = 1; i < polygon.length - 1; i++) triangles.push([polygon[0], polygon[i], polygon[i + 1]]);
      };
      for (let z = 0; z < subdivisions; z++) {
        for (let x = 0; x < subdivisions; x++) {
          const a = grid[at(x, z)], b = grid[at(x + 1, z)];
          const c = grid[at(x, z + 1)], d = grid[at(x + 1, z + 1)];
          emit([a, c, b]);
          emit([b, c, d]);
        }
      }
    }
  }

  // Terrain skirts are only a LOD safety net. Suppress any segment within the
  // collar support so a vertical skirt cannot cross the real aperture when an
  // entrance lies on a chunk boundary.
  for (let i = topIndexCount; i < sourceIndices.length; i += 3) {
    let intersectsEntrance = false;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = sourceIndices[i + corner];
      const x = attribute(positions, vertex, 0);
      const z = attribute(positions, vertex, 2);
      if (supportAt(x, z) || cutValueAt(x, z) < 0) {
        intersectsEntrance = true;
        break;
      }
    }
    if (!intersectsEntrance) kept.push(sourceIndices[i], sourceIndices[i + 1], sourceIndices[i + 2]);
  }

  return {
    keptIndices: new sourceIndices.constructor(kept),
    collar: weldTriangles(triangles),
    replacedCells,
  };
}
