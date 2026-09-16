// Geometry-only distant landscape products.
//
// A distant tile is sampled from the same accepted water/terrain function as a
// near chunk.  This module intentionally knows nothing about THREE or a
// renderer, which lets the worker and the contract tests exercise the exact
// geometry rules without constructing a browser scene.

export const DISTANT_WATER_VERSION = 1;
export const DEFAULT_DISTANT_RADIUS = 6000;
export const DEFAULT_DISTANT_TILE_SIZE = 512;
export const DEFAULT_DISTANT_SAMPLE_STEP = 32;
export const DEFAULT_DISTANT_MAX_TILES = 640;
export const DEFAULT_DISTANT_MAX_BYTES = 24 * 1024 * 1024;
export const DEFAULT_DISTANT_HINT_SAMPLE_STEP = 8;
export const DISTANT_WATER_EPSILON = 1e-3;

const DEFAULT_TERRAIN_COLOR = Object.freeze([0.24, 0.29, 0.25]);
const DEFAULT_WATER_COLOR = Object.freeze([0.17, 0.38, 0.52]);

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function assertFinite(value, name) {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

function positive(value, name) {
  assertFinite(value, name);
  if (!(value > 0)) throw new RangeError(`${name} must be positive`);
  return value;
}

function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${name} must be an integer`);
  return value;
}

export function distantWaterBounds(center = { x: 0, z: 0 }, radius = DEFAULT_DISTANT_RADIUS) {
  const x = assertFinite(center?.x, 'center.x');
  const z = assertFinite(center?.z, 'center.z');
  radius = positive(radius, 'radius');
  return Object.freeze({ minX: x - radius, minZ: z - radius, maxX: x + radius, maxZ: z + radius,
    centerX: x, centerZ: z, radius });
}

export function validateDistantWaterOptions({
  center = { x: 0, z: 0 },
  radius = DEFAULT_DISTANT_RADIUS,
  tileSize = DEFAULT_DISTANT_TILE_SIZE,
  sampleStep = DEFAULT_DISTANT_SAMPLE_STEP,
  maxTiles = DEFAULT_DISTANT_MAX_TILES,
  maxBytes = DEFAULT_DISTANT_MAX_BYTES,
} = {}) {
  const bounds = distantWaterBounds(center, radius);
  tileSize = positive(tileSize, 'tileSize');
  sampleStep = positive(sampleStep, 'sampleStep');
  if (sampleStep > tileSize) throw new RangeError('sampleStep must not exceed tileSize');
  maxTiles = integer(maxTiles, 'maxTiles', 1);
  maxBytes = integer(maxBytes, 'maxBytes', 1);
  if (maxBytes > 256 * 1024 * 1024) throw new RangeError('maxBytes exceeds distant landscape limit');
  return { bounds, tileSize, sampleStep, maxTiles, maxBytes };
}

// Enumerate bounded tiles without allocating any geometry.  The first and
// last tiles may be partial so the requested geographic bounds remain exact;
// all tile edges still use one global coordinate and therefore weld in X/Z.
export function enumerateDistantWaterTiles(options = {}) {
  // buildDistantWaterStage passes the already validated options object. Keep
  // this helper convenient for direct callers as well as avoiding a silent
  // fallback to the 6 km default when only `bounds` is present.
  const normalized = options.bounds && options.center === undefined
    ? { ...options, center: { x: options.bounds.centerX, z: options.bounds.centerZ }, radius: options.bounds.radius }
    : options;
  const { bounds, tileSize, maxTiles } = validateDistantWaterOptions(normalized);
  const ix0 = Math.floor(bounds.minX / tileSize), iz0 = Math.floor(bounds.minZ / tileSize);
  const ix1 = Math.ceil(bounds.maxX / tileSize) - 1, iz1 = Math.ceil(bounds.maxZ / tileSize) - 1;
  const count = Math.max(0, ix1 - ix0 + 1) * Math.max(0, iz1 - iz0 + 1);
  if (count > maxTiles) throw new RangeError(`Distant landscape tile budget exceeded (${count} > ${maxTiles})`);
  const tiles = [];
  for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
    const fullMinX = ix * tileSize, fullMaxX = (ix + 1) * tileSize;
    const fullMinZ = iz * tileSize, fullMaxZ = (iz + 1) * tileSize;
    const minX = Math.max(bounds.minX, fullMinX), maxX = Math.min(bounds.maxX, fullMaxX);
    const minZ = Math.max(bounds.minZ, fullMinZ), maxZ = Math.min(bounds.maxZ, fullMaxZ);
    if (!(maxX > minX && maxZ > minZ)) continue;
    tiles.push(Object.freeze({ key: `${ix},${iz}`, ix, iz, x0: minX, z0: minZ,
      width: maxX - minX, height: maxZ - minZ, minX, maxX, minZ, maxZ }));
  }
  return tiles;
}

// Pull deterministic refinement hints from accepted descriptors. Generation-3
// sparse components carry their accepted wet samples in `grid.coords` and
// `grid.signed`; basin grids carry the same information on a dense lattice.
// Hints are only a coverage aid: every emitted vertex is still sampled through
// the authoritative terrain/water callback, so a hint cannot invent a river.
export function collectDistantWaterHints(plans, { maxHints = 100000, spacing = 16 } = {}) {
  if (!Array.isArray(plans) || !plans.length) return [];
  integer(maxHints, 'maxHints', 1); positive(spacing, 'spacing');
  const hints = [], seen = new Set();
  const add = (x, z, radius = 0) => {
    if (![x, z].every(Number.isFinite)) return;
    const key = `${Math.round(x / spacing)},${Math.round(z / spacing)}`;
    if (seen.has(key) || hints.length >= maxHints) return;
    seen.add(key); hints.push({ x, z, radius: finite(radius, 0) });
  };
  const addGrid = (grid, predicate, pointAt) => {
    if (!grid || (!Array.isArray(grid.signed) && !ArrayBuffer.isView(grid.signed))) return;
    const length = grid.signed.length;
    // A dense lake can contain millions of accepted cells. Uniformly sample
    // those cells for tile refinement while always retaining every component
    // grid point when it is within the global cap.
    const stride = Math.max(1, Math.ceil(Math.sqrt(length / Math.max(1, maxHints / Math.max(1, plans.length)))));
    for (let i = 0; i < length; i += stride) if (predicate(grid.signed[i], i)) {
      const point = pointAt(i); if (point) add(point.x, point.z, point.radius);
    }
  };
  for (const plan of plans) {
    for (const basin of plan?.basins || []) {
      const grid = basin.grid;
      if (!grid || !Number.isFinite(grid.x0) || !Number.isFinite(grid.z0)
        || !Number.isInteger(grid.cols) || !Number.isInteger(grid.rows) || !Number.isFinite(grid.step)) continue;
      addGrid(grid, value => value > DISTANT_WATER_EPSILON, index => ({
        x: grid.x0 + (index % grid.cols) * grid.step,
        z: grid.z0 + Math.floor(index / grid.cols) * grid.step,
        radius: grid.step,
      }));
    }
    for (const component of plan?.components || []) {
      const grid = component.grid;
      if (!grid || !Array.isArray(grid.coords) || !Number.isFinite(grid.step)) continue;
      addGrid(grid, value => value > DISTANT_WATER_EPSILON, index => {
        const point = grid.coords[index];
        if (!Array.isArray(point) || point.length < 2) return null;
        return { x: point[0] * grid.step, z: point[1] * grid.step, radius: grid.step };
      });
    }
    // Older accepted regional plans retain fitted centerline sections. Keep
    // those exact locations as hints when present; they are never treated as
    // water without a positive signed sample from the World callback.
    for (const reach of plan?.reaches || []) for (const point of reach.points || []) {
      const radius = Math.max(2, ...['left', 'right'].map(side => finite(point[`${side}Width`], 0)));
      add(point.x, point.z, radius);
    }
  }
  return hints;
}

function tileHints(hints, tile, tileSize, pad = 0) {
  if (!hints?.length) return [];
  const ix = tile.ix, iz = tile.iz, map = new Map();
  // Use the global tile key and its neighbors so a hint exactly on a shared
  // edge refines both products and leaves no half-resolution water seam.
  for (const hint of hints) {
    if (hint.x < tile.minX - pad || hint.x > tile.maxX + pad
      || hint.z < tile.minZ - pad || hint.z > tile.maxZ + pad) continue;
    const key = `${Math.floor(hint.x / tileSize)},${Math.floor(hint.z / tileSize)}`;
    if (!map.has(key)) map.set(key, hint);
  }
  return [...map.values()];
}

function colorOf(value, fallback) {
  const color = value?.color;
  if (Array.isArray(color) || ArrayBuffer.isView(color)) {
    return [finite(color[0], fallback[0]), finite(color[1], fallback[1]), finite(color[2], fallback[2])];
  }
  return [finite(value?.r, fallback[0]), finite(value?.g, fallback[1]), finite(value?.b, fallback[2])];
}

// Normalize the callback contract used by the worker's World and by small
// deterministic test samplers. A numeric return means dry terrain. A sample
// object may use `height` or `floor`, and water must provide the accepted
// signed depth; a body/head alone never floods a dry vertex.
export function normalizeDistantSample(value) {
  if (typeof value === 'number') return {
    height: assertFinite(value, 'terrain height'), naturalHeight: value,
    waterY: NaN, signedDepth: -1, wet: false, color: [...DEFAULT_TERRAIN_COLOR],
  };
  if (!value || typeof value !== 'object') throw new TypeError('Distant terrain sampler returned an invalid sample');
  const height = finite(value.height, finite(value.terrainY, finite(value.floor, NaN)));
  if (!Number.isFinite(height)) throw new TypeError('Distant terrain sample has no finite height');
  const naturalHeight = finite(value.naturalHeight, finite(value.natural, height));
  const waterY = finite(value.waterY, finite(value.head, finite(value.level, NaN)));
  const rawSigned = Number.isFinite(value.signedDepth) ? value.signedDepth
    : Number.isFinite(value.domainDepth) ? value.domainDepth
      : value.wet === true && Number.isFinite(waterY) ? waterY - height : -1;
  const supportDepth = Number.isFinite(waterY) ? waterY - height : -Infinity;
  const signedDepth = Math.min(rawSigned, supportDepth);
  const wet = value.wet === true || (signedDepth > DISTANT_WATER_EPSILON
    && Number.isFinite(waterY));
  return {
    height, naturalHeight, waterY, signedDepth, wet,
    bodyId: value.bodyId ?? null, bodyKind: value.bodyKind ?? null,
    flowX: finite(value.flowX, 0), flowZ: finite(value.flowZ, 0),
    color: colorOf(value, DEFAULT_TERRAIN_COLOR),
  };
}

function readSample(sampleAt, x, z) {
  // Passing an output object avoids an allocation in the World sampler. The
  // returned object is normalized immediately and never retained by the
  // callback.
  return normalizeDistantSample(sampleAt(x, z, {}));
}

function pushPosition(array, x, y, z) {
  array.push(x, y, z);
  return array.length / 3 - 1;
}

function appendWaterTriangle(waterPositions, waterNormals, waterIndices, polygon) {
  if (polygon.length < 3) return 0;
  const first = polygon[0];
  let triangles = 0;
  for (let i = 1; i < polygon.length - 1; i++) {
    const a = first, b = polygon[i], c = polygon[i + 1];
    const area = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    if (Math.abs(area) < 1e-7) continue;
    const ia = pushPosition(waterPositions, a.x, a.waterY, a.z);
    const ib = pushPosition(waterPositions, b.x, b.waterY, b.z);
    const ic = pushPosition(waterPositions, c.x, c.waterY, c.z);
    waterNormals.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
    waterIndices.push(ia, ib, ic);
    // Accumulate the exact triangle normal. This preserves the accepted
    // river slope as geometry; no vertex shader bends a flat distant plane.
    const abx = b.x - a.x, aby = b.waterY - a.waterY, abz = b.z - a.z;
    const acx = c.x - a.x, acy = c.waterY - a.waterY, acz = c.z - a.z;
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    for (const index of [ia, ib, ic]) {
      waterNormals[index * 3] += nx;
      waterNormals[index * 3 + 1] += ny;
      waterNormals[index * 3 + 2] += nz;
    }
    triangles++;
  }
  return triangles;
}

function clipWetTriangle(vertices, epsilon = DISTANT_WATER_EPSILON) {
  const output = [];
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    const aWet = a.signedDepth > epsilon, bWet = b.signedDepth > epsilon;
    if (aWet) output.push(a);
    if (aWet !== bWet) {
      const denominator = b.signedDepth - a.signedDepth;
      const t = Math.max(0, Math.min(1, denominator ? (epsilon - a.signedDepth) / denominator : 0.5));
      output.push({
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        waterY: a.waterY + (b.waterY - a.waterY) * t,
        signedDepth: epsilon,
      });
    }
  }
  return output;
}

function bytesOf(tile) {
  const seen = new Set(), visit = value => {
    if (!value || typeof value !== 'object') return 0;
    if (ArrayBuffer.isView(value)) {
      if (seen.has(value.buffer)) return 0;
      seen.add(value.buffer); return value.byteLength;
    }
    return Object.values(value).reduce((n, child) => n + visit(child), 0);
  };
  return visit(tile);
}

export function buildDistantWaterTile({
  tile,
  sampleAt,
  sampleStep = DEFAULT_DISTANT_SAMPLE_STEP,
  bounds = null,
  waterEpsilon = DISTANT_WATER_EPSILON,
} = {}) {
  if (!tile || ![tile.x0, tile.z0, tile.width, tile.height].every(Number.isFinite)) {
    throw new TypeError('Invalid distant water tile');
  }
  if (typeof sampleAt !== 'function') throw new TypeError('Distant tile requires a terrain sampler');
  sampleStep = positive(sampleStep, 'sampleStep');
  const cols = Math.max(2, Math.ceil(tile.width / sampleStep) + 1);
  const rows = Math.max(2, Math.ceil(tile.height / sampleStep) + 1);
  const dx = tile.width / (cols - 1), dz = tile.height / (rows - 1), count = cols * rows;
  const samples = new Array(count);
  const heights = new Float32Array(count), signedDepths = new Float32Array(count);
  const wet = new Uint8Array(count), waterLevels = new Float32Array(count);
  waterLevels.fill(NaN);
  const terrainPositions = new Float32Array(count * 3);
  const terrainNormals = new Float32Array(count * 3);
  const terrainColors = new Float32Array(count * 3);
  let wetSamples = 0, unsupportedWaterSamples = 0;
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const i = row * cols + col, x = tile.x0 + col * dx, z = tile.z0 + row * dz;
    const sample = readSample(sampleAt, x, z);
    samples[i] = sample; heights[i] = sample.height;
    terrainPositions[i * 3] = x; terrainPositions[i * 3 + 1] = sample.height; terrainPositions[i * 3 + 2] = z;
    terrainColors.set(sample.color, i * 3);
    if (Number.isFinite(sample.waterY)) waterLevels[i] = sample.waterY;
    const inBounds = !bounds || Math.hypot(x - bounds.centerX, z - bounds.centerZ) <= bounds.radius + sampleStep;
    const supported = sample.signedDepth > waterEpsilon && sample.waterY - sample.height > waterEpsilon;
    if (sample.wet && !supported) unsupportedWaterSamples++;
    // Preserve the authoritative signed depth for clipping. Replacing every
    // dry sample with -1 made a high bank with signed depth -100 look almost
    // as close to water as a one-metre shore and pulled the polygon over it.
    signedDepths[i] = inBounds ? sample.signedDepth : -1e6;
    if (supported && inBounds) { wet[i] = 1; wetSamples++; }
  }
  const terrainIndices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let ti = 0;
  for (let row = 0; row < rows - 1; row++) for (let col = 0; col < cols - 1; col++) {
    const a = row * cols + col, b = a + 1, c = a + cols, d = c + 1;
    // Three.js uses a right-handed Y-up world. Winding a,b,c would face the
    // ground downward (the X/Z cross product points toward -Y), making the
    // support surface disappear when viewed from the overlook.
    terrainIndices[ti++] = a; terrainIndices[ti++] = c; terrainIndices[ti++] = b;
    terrainIndices[ti++] = b; terrainIndices[ti++] = c; terrainIndices[ti++] = d;
  }
  // Normals are from the very same coarse terrain surface that receives the
  // water. One-sided differences at tile edges keep the boundary finite.
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const i = row * cols + col;
    const left = heights[row * cols + Math.max(0, col - 1)], right = heights[row * cols + Math.min(cols - 1, col + 1)];
    const down = heights[Math.max(0, row - 1) * cols + col], up = heights[Math.min(rows - 1, row + 1) * cols + col];
    const sx = (col === 0 || col === cols - 1 ? dx : 2 * dx), sz = (row === 0 || row === rows - 1 ? dz : 2 * dz);
    let nx = (left - right) / sx, ny = 1, nz = (down - up) / sz;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length; ny /= length; nz /= length;
    terrainNormals[i * 3] = nx; terrainNormals[i * 3 + 1] = ny; terrainNormals[i * 3 + 2] = nz;
  }
  const waterPositions = [], waterNormals = [], waterIndices = [];
  let waterTriangles = 0, waterArea = 0;
  for (let row = 0; row < rows - 1; row++) for (let col = 0; col < cols - 1; col++) {
    const a = row * cols + col, b = a + 1, c = a + cols, d = c + 1;
    // Match the terrain's fixed diagonal. Clipping each triangle separately
    // retains disconnected lake holes and peninsulas in the coarse view.
    for (const ids of [[a, c, b], [b, c, d]]) {
      // A dry numeric-only terrain sample has no water level to interpolate.
      // Borrow the accepted level from this triangle's wet corner so a
      // shoreline never lerps toward an invented global plane.
      const levels = ids.map(i => waterLevels[i]).filter(Number.isFinite);
      const levelHint = levels.length ? levels.reduce((sum, level) => sum + level, 0) / levels.length : NaN;
      const point = i => ({ x: tile.x0 + (i % cols) * dx, z: tile.z0 + Math.floor(i / cols) * dz,
        waterY: Number.isFinite(waterLevels[i]) ? waterLevels[i] : levelHint,
        signedDepth: signedDepths[i] });
      const polygon = clipWetTriangle(ids.map(point), waterEpsilon);
      const made = appendWaterTriangle(waterPositions, waterNormals, waterIndices, polygon);
      waterTriangles += made;
      for (let i = 1; i < polygon.length - 1; i++) {
        const p = polygon[0], q = polygon[i], r = polygon[i + 1];
        waterArea += Math.abs((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x)) * 0.5;
      }
    }
  }
  const waterPositionArray = new Float32Array(waterPositions);
  const waterNormalArray = new Float32Array(waterNormals);
  for (let i = 0; i < waterNormalArray.length; i += 3) {
    const length = Math.hypot(waterNormalArray[i], waterNormalArray[i + 1], waterNormalArray[i + 2]) || 1;
    waterNormalArray[i] /= length; waterNormalArray[i + 1] /= length; waterNormalArray[i + 2] /= length;
  }
  const tileResult = {
    version: DISTANT_WATER_VERSION,
    key: tile.key, ix: tile.ix, iz: tile.iz, x0: tile.x0, z0: tile.z0,
    width: tile.width, height: tile.height, cols, rows, stepX: dx, stepZ: dz,
    terrain: { positions: terrainPositions, normals: terrainNormals, colors: terrainColors, indices: terrainIndices },
    water: { positions: waterPositionArray, normals: waterNormalArray, indices: new Uint32Array(waterIndices) },
    // Keep this compact grid available to diagnostics and contract tests. It
    // is also the exact wet/level source from which the water polygons came.
    samples: { wet, waterLevels, signedDepths },
    stats: { wetSamples, unsupportedWaterSamples, waterTriangles,
      waterVertices: waterPositionArray.length / 3, waterArea },
  };
  tileResult.bytes = bytesOf(tileResult);
  return tileResult;
}

export function buildDistantWaterStage({
  plans = null,
  waterHints = null,
  sampleAt,
  center = { x: 0, z: 0 },
  radius = DEFAULT_DISTANT_RADIUS,
  tileSize = DEFAULT_DISTANT_TILE_SIZE,
  sampleStep = DEFAULT_DISTANT_SAMPLE_STEP,
  hintSampleStep = DEFAULT_DISTANT_HINT_SAMPLE_STEP,
  maxTiles = DEFAULT_DISTANT_MAX_TILES,
  maxBytes = DEFAULT_DISTANT_MAX_BYTES,
  signal = null,
  onTile = null,
} = {}) {
  if (typeof sampleAt !== 'function') throw new TypeError('Distant stage requires a terrain sampler');
  const options = validateDistantWaterOptions({ center, radius, tileSize, sampleStep, maxTiles, maxBytes });
  hintSampleStep = positive(hintSampleStep, 'hintSampleStep');
  if (hintSampleStep > sampleStep) hintSampleStep = sampleStep;
  const tiles = enumerateDistantWaterTiles(options), products = [];
  const hints = waterHints || collectDistantWaterHints(plans, { maxHints: Math.min(100000, maxTiles * 2048) });
  let bytes = 0, waterTiles = 0, wetSamples = 0, waterTriangles = 0, waterArea = 0, unsupported = 0;
  let hintedTiles = 0, refinedTiles = 0;
  for (let index = 0; index < tiles.length; index++) {
    if (signal?.aborted) throw new Error('Distant landscape preparation cancelled');
    const hinted = tileHints(hints, tiles[index], tileSize, sampleStep);
    const tileSampleStep = hinted.length ? hintSampleStep : sampleStep;
    if (hinted.length) hintedTiles++;
    if (tileSampleStep < sampleStep) refinedTiles++;
    const tile = buildDistantWaterTile({ tile: tiles[index], sampleAt, sampleStep: tileSampleStep, bounds: options.bounds });
    bytes += tile.bytes;
    if (bytes > maxBytes) throw new RangeError(`Distant landscape memory budget exceeded (${bytes} > ${maxBytes})`);
    if (tile.stats.waterTriangles) waterTiles++;
    wetSamples += tile.stats.wetSamples; waterTriangles += tile.stats.waterTriangles;
    waterArea += tile.stats.waterArea; unsupported += tile.stats.unsupportedWaterSamples;
    products.push(tile);
    onTile?.(tile, index + 1, tiles.length);
  }
  return {
    version: DISTANT_WATER_VERSION,
    bounds: options.bounds,
    tileSize, sampleStep, hintSampleStep,
    tiles: products,
    stats: { tileCount: products.length, waterTiles, bytes, wetSamples, waterTriangles, waterArea,
      unsupportedWaterSamples: unsupported, hintedTiles, refinedTiles },
  };
}
