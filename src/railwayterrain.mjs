const BIN_SIZE = 180;
const MAX_CORRIDOR_REACH = 36;
const TYPE_CODE = Object.freeze({ surface: 0, cut: 1, fill: 2, bridge: 3, tunnel: 4 });
const DEFORMS_TERRAIN = new Set([TYPE_CODE.surface, TYPE_CODE.cut, TYPE_CODE.fill]);
const worldStates = new WeakMap();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(a, b, value) {
  const t = clamp((value - a) / Math.max(1e-9, b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function planSignature(plan) {
  let hash = 2166136261;
  const positions = plan.route?.positions || [];
  const stride = Math.max(3, Math.floor(positions.length / 96 / 3) * 3);
  for (let i = 0; i < positions.length; i += stride) {
    hash = Math.imul(hash ^ Math.round(positions[i] * 10), 16777619);
    hash = Math.imul(hash ^ Math.round(positions[i + 2] * 10), 16777619);
  }
  return `rail-${plan.seed >>> 0}-${plan.stations.length}-${plan.points.length}-${hash >>> 0}`;
}

export function serializeRailwayTerrainPlan(plan) {
  if (!plan?.points?.length || !plan?.stations?.length) return null;
  const count = plan.points.length;
  const segments = new Float64Array(count * 6);
  const kinds = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const a = plan.points[i], b = plan.points[(i + 1) % count];
    const offset = i * 6;
    segments[offset] = a.x;
    segments[offset + 1] = a.z;
    segments[offset + 2] = a.formationY;
    segments[offset + 3] = b.x;
    segments[offset + 4] = b.z;
    segments[offset + 5] = b.formationY;
    // Structural spans own their boundary segments too. Otherwise the final
    // cutting/fill sample immediately before a bridge would pull the river or
    // valley floor up to rail level at the abutment.
    const pair = [a.structure, b.structure];
    const structure = pair.includes('bridge') ? 'bridge'
      : pair.includes('tunnel') ? 'tunnel'
        : a.structure;
    kinds[i] = TYPE_CODE[structure] ?? TYPE_CODE.surface;
  }

  // x, z, formation y, tangent x/z, half length, half width, blend shoulder.
  const stations = new Float64Array(plan.stations.length * 8);
  for (let i = 0; i < plan.stations.length; i++) {
    const station = plan.stations[i], offset = i * 8;
    stations[offset] = station.x;
    stations[offset + 1] = station.z;
    stations[offset + 2] = station.formationY ?? station.y;
    stations[offset + 3] = station.tangentX;
    stations[offset + 4] = station.tangentZ;
    stations[offset + 5] = 48;
    stations[offset + 6] = 7.5;
    stations[offset + 7] = 10;
  }
  return {
    version: 1,
    signature: planSignature(plan),
    binSize: BIN_SIZE,
    segments,
    kinds,
    stations,
  };
}

function segmentDistance(x, z, ax, az, bx, bz, out) {
  const dx = bx - ax, dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 1e-9 ? clamp(((x - ax) * dx + (z - az) * dz) / lengthSq, 0, 1) : 0;
  const px = ax + dx * t, pz = az + dz * t;
  out.distance = Math.hypot(x - px, z - pz);
  out.t = t;
  return out;
}

function boxDistance(along, across, halfLength, halfWidth) {
  const qx = Math.abs(along) - halfLength;
  const qz = Math.abs(across) - halfWidth;
  return Math.hypot(Math.max(0, qx), Math.max(0, qz)) + Math.min(0, Math.max(qx, qz));
}

export class RailwayTerrainIndex {
  constructor(spec) {
    if (!spec || spec.version !== 1) throw new Error('Unsupported railway terrain specification');
    this.spec = spec;
    this.signature = spec.signature;
    this.binSize = spec.binSize || BIN_SIZE;
    this.segments = spec.segments;
    this.kinds = spec.kinds;
    this.stations = spec.stations;
    this.segmentCount = this.kinds.length;
    this.stationCount = this.stations.length / 8;
    this.bins = new Map();
    this._distance = { distance: 0, t: 0 };
    this._query = {};
    this._buildBins();
  }

  _bin(ix, iz, create = false) {
    const key = `${ix},${iz}`;
    let bin = this.bins.get(key);
    if (!bin && create) this.bins.set(key, bin = { segments: [], stations: [] });
    return bin;
  }

  _insertBounds(minX, minZ, maxX, maxZ, kind, index) {
    const ix0 = Math.floor(minX / this.binSize), ix1 = Math.floor(maxX / this.binSize);
    const iz0 = Math.floor(minZ / this.binSize), iz1 = Math.floor(maxZ / this.binSize);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) this._bin(ix, iz, true)[kind].push(index);
    }
  }

  _buildBins() {
    for (let i = 0; i < this.segmentCount; i++) {
      const o = i * 6;
      const ax = this.segments[o], az = this.segments[o + 1];
      const bx = this.segments[o + 3], bz = this.segments[o + 4];
      this._insertBounds(
        Math.min(ax, bx) - MAX_CORRIDOR_REACH,
        Math.min(az, bz) - MAX_CORRIDOR_REACH,
        Math.max(ax, bx) + MAX_CORRIDOR_REACH,
        Math.max(az, bz) + MAX_CORRIDOR_REACH,
        'segments', i,
      );
    }
    for (let i = 0; i < this.stationCount; i++) {
      const o = i * 8;
      const x = this.stations[o], z = this.stations[o + 1];
      const reach = this.stations[o + 5] + this.stations[o + 7] + this.stations[o + 6];
      this._insertBounds(x - reach, z - reach, x + reach, z + reach, 'stations', i);
    }
  }

  intersectsBounds(minX, minZ, maxX, maxZ) {
    const ix0 = Math.floor(minX / this.binSize), ix1 = Math.floor(maxX / this.binSize);
    const iz0 = Math.floor(minZ / this.binSize), iz1 = Math.floor(maxZ / this.binSize);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        if (this._bin(ix, iz)) return true;
      }
    }
    return false;
  }

  query(baseHeight, x, z, out = {}) {
    out.height = baseHeight;
    out.weight = 0;
    out.distance = Infinity;
    out.structure = 'none';
    out.treeClearance = 0;
    out.plantClearance = 0;
    out.grassClearance = 0;
    out.station = false;
    const bin = this._bin(Math.floor(x / this.binSize), Math.floor(z / this.binSize));
    if (!bin) return out;

    let bestStrength = 0;
    for (const index of bin.segments) {
      const o = index * 6;
      segmentDistance(
        x, z,
        this.segments[o], this.segments[o + 1],
        this.segments[o + 3], this.segments[o + 4],
        this._distance,
      );
      const distance = this._distance.distance;
      const kind = this.kinds[index];
      const isTunnel = kind === TYPE_CODE.tunnel;
      if (!isTunnel) {
        out.treeClearance = Math.max(out.treeClearance, 1 - smoothstep(6, 12, distance));
        out.plantClearance = Math.max(out.plantClearance, 1 - smoothstep(4, 8.5, distance));
        out.grassClearance = Math.max(out.grassClearance, 1 - smoothstep(2.8, 6.2, distance));
      }
      if (!DEFORMS_TERRAIN.has(kind)) continue;
      const formation = this.segments[o + 2]
        + (this.segments[o + 5] - this.segments[o + 2]) * this._distance.t;
      const delta = formation - baseHeight;
      const core = 2.7;
      const outer = core + clamp(Math.abs(delta) * 1.55 + 5.5, 6.5, 30);
      const weight = 1 - smoothstep(core, outer, distance);
      const strength = weight * Math.max(0.2, Math.abs(delta));
      if (strength > bestStrength) {
        bestStrength = strength;
        out.height = baseHeight + delta * weight;
        out.weight = weight;
        out.distance = distance;
        out.structure = ['surface', 'cut', 'fill'][kind] || 'surface';
      }
    }

    for (const index of bin.stations) {
      const o = index * 8;
      const dx = x - this.stations[o], dz = z - this.stations[o + 1];
      const tx = this.stations[o + 3], tz = this.stations[o + 4];
      const along = dx * tx + dz * tz;
      const across = dx * -tz + dz * tx;
      const signedDistance = boxDistance(
        along, across,
        this.stations[o + 5], this.stations[o + 6],
      );
      const shoulder = this.stations[o + 7];
      if (signedDistance >= shoulder) continue;
      const weight = signedDistance <= 0 ? 1 : 1 - smoothstep(0, shoulder, signedDistance);
      const formation = this.stations[o + 2];
      const delta = formation - baseHeight;
      out.height = baseHeight + delta * weight;
      out.weight = Math.max(out.weight, weight);
      out.distance = Math.min(out.distance, Math.max(0, signedDistance));
      out.structure = 'station';
      out.station = true;
      out.treeClearance = Math.max(out.treeClearance, weight);
      out.plantClearance = Math.max(out.plantClearance, weight);
      out.grassClearance = Math.max(out.grassClearance, weight);
    }
    return out;
  }

  heightAt(baseHeight, x, z) {
    return this.query(baseHeight, x, z, this._query).height;
  }

  clearanceAt(x, z, out = {}) {
    return this.query(0, x, z, out);
  }
}

/** Install or replace the railway layer on a World instance. All existing
 * callers continue using world.height(), so streamed terrain, collision,
 * vegetation seating and far terrain share the same modified surface. */
export function setWorldRailwayTerrain(world, spec = null) {
  let state = worldStates.get(world);
  if (!state) {
    state = {
      baseHeight: world.height.bind(world),
      index: null,
    };
    worldStates.set(world, state);
  }
  if (!spec) {
    state.index = null;
    world.railwayTerrain = null;
    world.railwayClearanceAt = null;
    world.height = state.baseHeight;
    return null;
  }
  const index = spec instanceof RailwayTerrainIndex ? spec : new RailwayTerrainIndex(spec);
  state.index = index;
  world.railwayTerrain = index;
  world.railwayClearanceAt = (x, z, out) => index.clearanceAt(x, z, out);
  world.height = (x, z, riverInfo) => {
    const base = state.baseHeight(x, z, riverInfo);
    return state.index ? state.index.heightAt(base, x, z) : base;
  };
  return index;
}

export function baseWorldHeight(world, x, z, riverInfo) {
  const state = worldStates.get(world);
  return state ? state.baseHeight(x, z, riverInfo) : world.height(x, z, riverInfo);
}

export const RAILWAY_TERRAIN_TYPES = TYPE_CODE;
