const DEFAULT_TILE_SIZE = 280;
const TRACK_REACH = 8;
const STRUCTURE_CODE = Object.freeze({ surface: 0, cut: 1, fill: 2, bridge: 3, tunnel: 4 });
const STRUCTURE_NAME = Object.freeze(['surface', 'cut', 'fill', 'bridge', 'tunnel']);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function tileKey(ix, iz) {
  return `${ix},${iz}`;
}

function clipSegmentToBounds(ax, az, bx, bz, bounds) {
  const dx = bx - ax, dz = bz - az;
  let t0 = 0, t1 = 1;
  const clips = [
    [-dx, ax - bounds.minX], [dx, bounds.maxX - ax],
    [-dz, az - bounds.minZ], [dz, bounds.maxZ - az],
  ];
  for (const [p, q] of clips) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return { t0, t1 };
}

function pushQuad(target, a, b, c, d, normal = [0, 1, 0]) {
  const base = target.positions.length / 3;
  for (const point of [a, b, c, d]) target.positions.push(point[0], point[1], point[2]);
  for (let i = 0; i < 4; i++) target.normals.push(normal[0], normal[1], normal[2]);
  target.indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
}

function pushBeam(target, a, b, lateral, width, bottom, top) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz) || 1;
  const rx = dz / length, rz = -dx / length;
  const half = width * 0.5;
  const corners = [];
  for (const point of [a, b]) {
    for (const side of [-1, 1]) {
      corners.push([
        point.x + rx * (lateral + side * half), point.y + bottom,
        point.z + rz * (lateral + side * half),
      ]);
      corners.push([
        point.x + rx * (lateral + side * half), point.y + top,
        point.z + rz * (lateral + side * half),
      ]);
    }
  }
  // End ordering is [left-bottom, left-top, right-bottom, right-top].
  pushQuad(target, corners[1], corners[5], corners[3], corners[7]);
  pushQuad(target, corners[2], corners[6], corners[0], corners[4], [-rx, 0, -rz]);
  pushQuad(target, corners[5], corners[4], corners[7], corners[6], [rx, 0, rz]);
  pushQuad(target, corners[0], corners[2], corners[1], corners[3]);
  pushQuad(target, corners[6], corners[4], corners[7], corners[5]);
}

function pushRibbon(target, a, b, width, vertical = 0) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz) || 1;
  const rx = dz / length * width * 0.5, rz = -dx / length * width * 0.5;
  pushQuad(target,
    [a.x - rx, a.y + vertical, a.z - rz],
    [a.x + rx, a.y + vertical, a.z + rz],
    [b.x - rx, b.y + vertical, b.z - rz],
    [b.x + rx, b.y + vertical, b.z + rz]);
}

function emptyGeometry() {
  return { positions: [], normals: [], indices: [] };
}

function finalizeGeometry(source) {
  if (!source.indices.length) return null;
  return {
    positions: Float32Array.from(source.positions),
    normals: Float32Array.from(source.normals),
    indices: Uint32Array.from(source.indices),
  };
}

export function serializeRailwayTrackPlan(plan, { tileSize = DEFAULT_TILE_SIZE } = {}) {
  if (!plan?.route?.positions?.length || !plan?.points?.length) return null;
  const count = plan.route.sampleCount;
  const segments = new Float64Array(count * 8);
  const kinds = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count, offset = i * 8;
    segments[offset] = plan.route.positions[i * 3];
    segments[offset + 1] = plan.route.positions[i * 3 + 1];
    segments[offset + 2] = plan.route.positions[i * 3 + 2];
    segments[offset + 3] = plan.route.positions[j * 3];
    segments[offset + 4] = plan.route.positions[j * 3 + 1];
    segments[offset + 5] = plan.route.positions[j * 3 + 2];
    segments[offset + 6] = plan.route.arc[i];
    segments[offset + 7] = plan.route.arc[i + 1];
    const a = plan.points[i]?.structure || 'surface';
    const b = plan.points[j]?.structure || a;
    const kind = a === 'bridge' || b === 'bridge' ? 'bridge'
      : a === 'tunnel' || b === 'tunnel' ? 'tunnel' : a;
    kinds[i] = STRUCTURE_CODE[kind] ?? 0;
  }
  const stations = new Float64Array(plan.stations.length * 8);
  for (let i = 0; i < plan.stations.length; i++) {
    const station = plan.stations[i], offset = i * 8;
    stations[offset] = station.x;
    stations[offset + 1] = station.formationY;
    stations[offset + 2] = station.z;
    stations[offset + 3] = station.tangentX;
    stations[offset + 4] = station.tangentZ;
    stations[offset + 5] = station.routeDistance;
    stations[offset + 6] = 52;
    stations[offset + 7] = 2.6;
  }
  return {
    version: 1,
    signature: `track-${plan.seed >>> 0}-${count}-${Math.round(plan.route.length)}`,
    tileSize,
    routeLength: plan.route.length,
    segments,
    kinds,
    stations,
  };
}

export class RailwayTrackIndex {
  constructor(spec) {
    if (!spec || spec.version !== 1) throw new Error('Unsupported railway track specification');
    this.spec = spec;
    this.signature = spec.signature;
    this.tileSize = spec.tileSize || DEFAULT_TILE_SIZE;
    this.routeLength = spec.routeLength;
    this.segments = spec.segments;
    this.kinds = spec.kinds;
    this.stations = spec.stations;
    this.segmentCount = this.kinds.length;
    this.stationCount = this.stations.length / 8;
    this.tiles = new Map();
    this._buildTiles();
  }

  _entry(ix, iz) {
    const key = tileKey(ix, iz);
    let entry = this.tiles.get(key);
    if (!entry) this.tiles.set(key, entry = { ix, iz, segments: [], stations: [] });
    return entry;
  }

  _insertBounds(minX, minZ, maxX, maxZ, field, index) {
    const ix0 = Math.floor(minX / this.tileSize), ix1 = Math.floor(maxX / this.tileSize);
    const iz0 = Math.floor(minZ / this.tileSize), iz1 = Math.floor(maxZ / this.tileSize);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) this._entry(ix, iz)[field].push(index);
    }
  }

  _buildTiles() {
    for (let i = 0; i < this.segmentCount; i++) {
      const o = i * 8;
      this._insertBounds(
        Math.min(this.segments[o], this.segments[o + 3]) - TRACK_REACH,
        Math.min(this.segments[o + 2], this.segments[o + 5]) - TRACK_REACH,
        Math.max(this.segments[o], this.segments[o + 3]) + TRACK_REACH,
        Math.max(this.segments[o + 2], this.segments[o + 5]) + TRACK_REACH,
        'segments', i,
      );
    }
    for (let i = 0; i < this.stationCount; i++) {
      const o = i * 8, reach = this.stations[o + 6] * 0.5 + 8;
      this._insertBounds(
        this.stations[o] - reach, this.stations[o + 2] - reach,
        this.stations[o] + reach, this.stations[o + 2] + reach,
        'stations', i,
      );
    }
  }

  entry(ix, iz) {
    return this.tiles.get(tileKey(ix, iz)) || null;
  }
}

export function buildRailwayTrackTile(index, ix, iz, {
  sleeperSpacing = 1.12,
  groundHeightAt = null,
} = {}) {
  const entry = index.entry(ix, iz);
  if (!entry) return null;
  const size = index.tileSize;
  // A tiny inset gives every point on a shared edge one deterministic owner.
  const bounds = {
    minX: ix * size,
    minZ: iz * size,
    maxX: (ix + 1) * size - 1e-6,
    maxZ: (iz + 1) * size - 1e-6,
  };
  const ballast = emptyGeometry(), rails = emptyGeometry(), bridge = emptyGeometry();
  const sleepers = [], piers = [], structures = { surface: 0, cut: 0, fill: 0, bridge: 0, tunnel: 0 };
  const seen = new Set();
  for (const segmentIndex of entry.segments) {
    if (seen.has(segmentIndex)) continue;
    seen.add(segmentIndex);
    const o = segmentIndex * 8;
    const ax = index.segments[o], ay = index.segments[o + 1], az = index.segments[o + 2];
    const bx = index.segments[o + 3], by = index.segments[o + 4], bz = index.segments[o + 5];
    const clipped = clipSegmentToBounds(ax, az, bx, bz, bounds);
    if (!clipped || clipped.t1 - clipped.t0 < 1e-7) continue;
    const a = {
      x: ax + (bx - ax) * clipped.t0,
      y: ay + (by - ay) * clipped.t0,
      z: az + (bz - az) * clipped.t0,
    };
    const b = {
      x: ax + (bx - ax) * clipped.t1,
      y: ay + (by - ay) * clipped.t1,
      z: az + (bz - az) * clipped.t1,
    };
    const kind = STRUCTURE_NAME[index.kinds[segmentIndex]] || 'surface';
    structures[kind]++;
    if (kind === 'tunnel') continue;
    if (kind === 'bridge') pushBeam(bridge, a, b, 0, 4.15, -0.48, -0.02);
    else {
      pushRibbon(ballast, a, b, 3.8, 0.015);
      pushRibbon(ballast, a, b, 2.85, 0.075);
    }
    pushBeam(rails, a, b, -0.72, 0.105, 0.13, 0.285);
    pushBeam(rails, a, b, 0.72, 0.105, 0.13, 0.285);

    const arc0 = index.segments[o + 6] + (index.segments[o + 7] - index.segments[o + 6]) * clipped.t0;
    const arc1 = index.segments[o + 6] + (index.segments[o + 7] - index.segments[o + 6]) * clipped.t1;
    const first = Math.ceil((arc0 - 1e-7) / sleeperSpacing);
    const last = Math.floor((arc1 - 1e-7) / sleeperSpacing);
    const arcSpan = index.segments[o + 7] - index.segments[o + 6];
    for (let sleeper = first; sleeper <= last; sleeper++) {
      const distance = sleeper * sleeperSpacing;
      const t = clamp((distance - index.segments[o + 6]) / Math.max(1e-9, arcSpan), 0, 1);
      sleepers.push({
        x: ax + (bx - ax) * t,
        y: ay + (by - ay) * t + 0.105,
        z: az + (bz - az) * t,
        tangentX: bx - ax,
        tangentY: by - ay,
        tangentZ: bz - az,
      });
    }

    if (kind === 'bridge' && groundHeightAt) {
      const clippedLength = Math.hypot(b.x - a.x, b.z - a.z);
      const count = Math.floor(clippedLength / 18);
      for (let p = 1; p <= count; p++) {
        const t = p / (count + 1), x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const deckY = a.y + (b.y - a.y) * t - 0.48;
        const groundY = groundHeightAt(x, z);
        if (deckY - groundY > 1.2) piers.push({
          x, z, bottomY: groundY, topY: deckY,
          tangentX: b.x - a.x, tangentY: b.y - a.y, tangentZ: b.z - a.z,
        });
      }
    }
  }

  const stations = [];
  for (const stationIndex of entry.stations) {
    const o = stationIndex * 8;
    const x = index.stations[o], z = index.stations[o + 2];
    if (Math.floor(x / size) !== ix || Math.floor(z / size) !== iz) continue;
    stations.push({
      index: stationIndex, x, y: index.stations[o + 1], z,
      tangentX: index.stations[o + 3], tangentZ: index.stations[o + 4],
      length: index.stations[o + 6], width: index.stations[o + 7],
    });
  }
  return {
    key: tileKey(ix, iz), ix, iz,
    ballast: finalizeGeometry(ballast),
    rails: finalizeGeometry(rails),
    bridge: finalizeGeometry(bridge),
    sleepers, piers, stations, structures,
  };
}

export const RAILWAY_TRACK_DEFAULTS = Object.freeze({
  tileSize: DEFAULT_TILE_SIZE,
  sleeperSpacing: 1.12,
});
