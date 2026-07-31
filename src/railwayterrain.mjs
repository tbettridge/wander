import { collectTunnelRuns, collectTunnelPortals } from './railwaytunnel.mjs';

const BIN_SIZE = 180;
const MAX_CORRIDOR_REACH = 36;
const PORTAL_CLEAR_REACH = 16;
const TYPE_CODE = Object.freeze({ surface: 0, cut: 1, fill: 2, bridge: 3, tunnel: 4 });
const DEFORMS_TERRAIN = new Set([TYPE_CODE.surface, TYPE_CODE.cut, TYPE_CODE.fill]);
const worldStates = new WeakMap();

// The route Y is the rail formation. The subgrade the terrain settles to sits a
// ballast-and-sleeper depth below it, so the track bed always stands proud of
// the ground instead of the sleepers sinking into an interpolated mesh. The
// track builder fills this gap with a raised ballast bed (see railwaystream).
export const RAILWAY_TRACKBED_DROP = 0.36;

// Walking a bridge or viaduct means walking the trackbed between the rails, so
// the surface underfoot is the ballast top rather than the rail head. Half-width
// is the deck, not the formation's earthwork skirt: step off the side of a
// viaduct and you should fall, exactly as you would.
export const RAILWAY_DECK_HALF_WIDTH = 2.6;
export const RAILWAY_DECK_WALK_RISE = 0.10;
export const RAILWAY_DECK_STEP_UP = 0.65;

// Minimum natural cover held above the rail formation along a tunnel bore.
// Classification samples every ~38m, so a ground saddle between two samples
// could otherwise sag into the bore crown (5.0m); where the hill runs shallow
// the terrain is gently mounded up to keep the tube fully underground.
export const RAILWAY_TUNNEL_MIN_COVER = 5.9;

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
    // Bridges own their boundary segments too. Otherwise the final cutting or
    // fill sample immediately before a bridge would pull the river or valley
    // floor up to rail level at the abutment. Tunnels deliberately do NOT get
    // this promotion: the approach cutting must keep deforming right up to the
    // portal plane, so the terrain face (and its curtain cut) lands exactly
    // where the portal facade and bore collar stand (see railwaytunnel.mjs).
    const pair = [a.structure, b.structure];
    const structure = pair.includes('bridge') ? 'bridge' : a.structure;
    kinds[i] = TYPE_CODE[structure] ?? TYPE_CODE.surface;
  }

  // x, z, formation y, tangent x/z, longitudinal grade, half length, half width,
  // blend shoulder. The grade lets the platform shelf follow the track profile.
  const stations = new Float64Array(plan.stations.length * 9);
  for (let i = 0; i < plan.stations.length; i++) {
    const station = plan.stations[i], offset = i * 9;
    const hyp = Math.hypot(station.tangentX, station.tangentZ) || 1;
    stations[offset] = station.x;
    stations[offset + 1] = station.z;
    stations[offset + 2] = station.formationY ?? station.y;
    stations[offset + 3] = station.tangentX;
    stations[offset + 4] = station.tangentZ;
    stations[offset + 5] = (station.tangentY ?? 0) / hyp;   // rise per metre along track
    stations[offset + 6] = 48;
    stations[offset + 7] = 7.5;
    stations[offset + 8] = 10;
  }
  // Tunnel portals: x, y (formation), z, outward x/z. Used for vegetation
  // clearance around the mouths and for the terrain curtain cut at assembly.
  const runs = collectTunnelRuns(plan);
  const portalList = collectTunnelPortals(runs);
  const portals = new Float64Array(portalList.length * 5);
  for (let i = 0; i < portalList.length; i++) {
    const portal = portalList[i], offset = i * 5;
    portals[offset] = portal.x;
    portals[offset + 1] = portal.y;
    portals[offset + 2] = portal.z;
    portals[offset + 3] = portal.outX;
    portals[offset + 4] = portal.outZ;
  }
  return {
    version: 1,
    signature: planSignature(plan),
    binSize: BIN_SIZE,
    segments,
    kinds,
    stations,
    portals,
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
    this.portals = spec.portals || new Float64Array(0);
    this.segmentCount = this.kinds.length;
    this.stationCount = this.stations.length / 9;
    this.portalCount = this.portals.length / 5;
    this.bins = new Map();
    this._distance = { distance: 0, t: 0 };
    this._query = {};
    this._buildBins();
  }

  _bin(ix, iz, create = false) {
    const key = `${ix},${iz}`;
    let bin = this.bins.get(key);
    if (!bin && create) this.bins.set(key, bin = { segments: [], stations: [], portals: [] });
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
      const o = i * 9;
      const x = this.stations[o], z = this.stations[o + 1];
      const reach = this.stations[o + 6] + this.stations[o + 8] + this.stations[o + 7];
      this._insertBounds(x - reach, z - reach, x + reach, z + reach, 'stations', i);
    }
    for (let i = 0; i < this.portalCount; i++) {
      const o = i * 5;
      const x = this.portals[o], z = this.portals[o + 2];
      this._insertBounds(
        x - PORTAL_CLEAR_REACH, z - PORTAL_CLEAR_REACH,
        x + PORTAL_CLEAR_REACH, z + PORTAL_CLEAR_REACH, 'portals', i,
      );
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

    // The nearest segment owns this point's grade — never a distant, deeper
    // earthwork. Winner-take-all by DISTANCE (not by cut/fill depth) stops a
    // neighbouring embankment from dragging the ground up through an adjacent
    // surface stretch and burying the sleepers there.
    let nearestDist = Infinity, nearestKind = -1, nearestT = 0, nearestOffset = -1;
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
      if (distance < nearestDist) {
        nearestDist = distance;
        nearestKind = kind;
        nearestT = this._distance.t;
        nearestOffset = o;
      }
    }

    // The rail formation of the nearest segment defines the local track profile;
    // the trackbed subgrade sits a ballast depth beneath it. Used by both the
    // earthwork deform and the station shelf so they share one continuous grade.
    const railFormation = nearestOffset >= 0
      ? this.segments[nearestOffset + 2]
        + (this.segments[nearestOffset + 5] - this.segments[nearestOffset + 2]) * nearestT
      : null;
    const trackbed = railFormation !== null ? railFormation - RAILWAY_TRACKBED_DROP : null;
    // The formation is the top of the line whether or not the ground was
    // deformed to meet it. Over a bridge or a viaduct it is the only walkable
    // surface there is — the ground below stays natural, so anything relying on
    // world.height() alone walks through the deck and falls into the valley.
    out.formation = railFormation;
    out.formationDistance = nearestDist;
    out.spans = nearestKind === TYPE_CODE.bridge;

    // Over a tunnel bore, hold the hillside at a minimum cover so the tube
    // never breaks the surface between the coarse classification samples. The
    // lift fades laterally, reading as a low cover mound where the hill dips.
    if (railFormation !== null && nearestKind === TYPE_CODE.tunnel) {
      const minCover = railFormation + RAILWAY_TUNNEL_MIN_COVER;
      if (baseHeight < minCover && nearestDist < 7) {
        const weight = 1 - smoothstep(4.0, 7.0, nearestDist);
        out.height = baseHeight + (minCover - baseHeight) * weight;
        out.weight = Math.max(out.weight, weight);
        out.distance = nearestDist;
        out.structure = 'tunnel-cover';
      }
    }

    // Deform only when the closest structure is an earthwork; under a bridge or
    // tunnel the closest segment is that span, so the ground stays natural.
    if (trackbed !== null && DEFORMS_TERRAIN.has(nearestKind)) {
      // Hold the subgrade flat across a wide core so even a coarse mesh cannot
      // interpolate up through the sleepers right beside the line.
      const delta = trackbed - baseHeight;
      const core = 3.4;
      const outer = core + clamp(Math.abs(delta) * 1.55 + 5.5, 6.5, 30);
      const weight = 1 - smoothstep(core, outer, nearestDist);
      out.height = baseHeight + delta * weight;
      out.weight = weight;
      out.distance = nearestDist;
      out.structure = ['surface', 'cut', 'fill'][nearestKind] || 'surface';
    }

    for (const index of bin.stations) {
      const o = index * 9;
      const dx = x - this.stations[o], dz = z - this.stations[o + 1];
      const tx = this.stations[o + 3], tz = this.stations[o + 4];
      const along = dx * tx + dz * tz;
      const across = dx * -tz + dz * tx;
      const signedDistance = boxDistance(
        along, across,
        this.stations[o + 6], this.stations[o + 7],
      );
      const shoulder = this.stations[o + 8];
      if (signedDistance >= shoulder) continue;
      const weight = signedDistance <= 0 ? 1 : 1 - smoothstep(0, shoulder, signedDistance);
      // Sit the platform shelf on the same trackbed the running line uses,
      // following the real (curved) profile of the nearest segment so a graded
      // approach never rises above the sleepers at the shelf ends. Fall back to
      // the stored formation only if no segment is nearby.
      const shelf = trackbed !== null
        ? trackbed
        : this.stations[o + 2] + this.stations[o + 5] * along - RAILWAY_TRACKBED_DROP;
      // Blend from the already-graded ground toward the flat shelf — never back
      // up toward natural ground — so the box shoulder cannot re-bury the track.
      out.height = out.height * (1 - weight) + shelf * weight;
      out.weight = Math.max(out.weight, weight);
      out.distance = Math.min(out.distance, Math.max(0, signedDistance));
      out.structure = 'station';
      out.station = true;
      out.treeClearance = Math.max(out.treeClearance, weight);
      out.plantClearance = Math.max(out.plantClearance, weight);
      out.grassClearance = Math.max(out.grassClearance, weight);
    }

    // Tunnel mouths stay clear of vegetation so portals sit in open cuttings,
    // not behind trees; the bore itself (under the hill) clears nothing.
    for (const index of bin.portals) {
      const o = index * 5;
      const distance = Math.hypot(x - this.portals[o], z - this.portals[o + 2]);
      out.treeClearance = Math.max(out.treeClearance, 1 - smoothstep(9, 15, distance));
      out.plantClearance = Math.max(out.plantClearance, 1 - smoothstep(6.5, 11, distance));
      out.grassClearance = Math.max(out.grassClearance, 1 - smoothstep(4.5, 8, distance));
    }
    return out;
  }

  heightAt(baseHeight, x, z) {
    return this.query(baseHeight, x, z, this._query).height;
  }

  clearanceAt(x, z, out = {}) {
    return this.query(0, x, z, out);
  }

  /**
   * The walkable deck of a bridge or viaduct at this point, or null.
   *
   * Earthworks need nothing here — they are already folded into world.height()
   * — but a span deliberately leaves the ground natural, so its deck has to be
   * offered separately or there is nothing underfoot but the valley floor.
   *
   * `atY` is the walker's height: the deck only counts if they are near its
   * level, so walking through a gorge beneath a viaduct does not lift them onto
   * the track.
   */
  deckAt(baseHeight, x, z, atY = Infinity, halfWidth = RAILWAY_DECK_HALF_WIDTH) {
    const out = this.query(baseHeight, x, z, this._query);
    if (!out.spans || out.formation === null) return null;
    if (out.formationDistance > halfWidth) return null;
    const deck = out.formation - RAILWAY_TRACKBED_DROP + RAILWAY_DECK_WALK_RISE;
    if (atY < deck - RAILWAY_DECK_STEP_UP) return null;
    return deck;
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
