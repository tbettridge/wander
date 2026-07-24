import { STRUCTURE_FAMILY, STRUCTURE_FAMILY_NAME } from './railwaystructures.mjs';

const DEFAULT_TILE_SIZE = 280;
const TRACK_REACH = 8;
const STRUCTURE_CODE = Object.freeze({ surface: 0, cut: 1, fill: 2, bridge: 3, tunnel: 4 });
const STRUCTURE_NAME = Object.freeze(['surface', 'cut', 'fill', 'bridge', 'tunnel']);

// Phase 6 structure geometry thresholds.
const PARAPET_HALF = 2.05;      // lateral offset of a deck-edge parapet / railing
const RETAIN_LATERAL = 2.35;    // lateral offset of an earthwork retaining wall
const RETAIN_FILL = 3.0;        // embankment taller than this gains retaining walls
const RETAIN_CUT = 3.0;         // cutting deeper than this gains retaining walls
const GUARDRAIL_FILL = 3.2;     // a high embankment gains a parapet guardrail
const CULVERT_ABUTMENT = 1.55;  // half-gap between culvert barrel walls

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

function railRight(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  return { rx: dz / len, rz: -dx / len };
}

// A solid wall running along the segment at a lateral offset, from a per-end
// base height up to a per-end top. Used for retaining walls, culvert barrel
// walls and headwalls; `thickness` grows inward toward the track centre.
function pushWall(target, a, b, lateral, baseA, baseB, topA, topB, thickness = 0.55) {
  const { rx, rz } = railRight(a, b);
  const s = Math.sign(lateral) || 1;
  const oLat = lateral, iLat = lateral - s * thickness;
  const aOx = a.x + rx * oLat, aOz = a.z + rz * oLat;
  const aIx = a.x + rx * iLat, aIz = a.z + rz * iLat;
  const bOx = b.x + rx * oLat, bOz = b.z + rz * oLat;
  const bIx = b.x + rx * iLat, bIz = b.z + rz * iLat;
  pushQuad(target,
    [aOx, baseA, aOz], [aOx, topA, aOz], [bOx, baseB, bOz], [bOx, topB, bOz], [rx * s, 0, rz * s]);
  pushQuad(target,
    [aIx, topA, aIz], [aIx, baseA, aIz], [bIx, topB, bIz], [bIx, baseB, bIz], [-rx * s, 0, -rz * s]);
  pushQuad(target,
    [aIx, topA, aIz], [aOx, topA, aOz], [bIx, topB, bIz], [bOx, topB, bOz]);
}

// A raised trapezoidal ballast bed: a flat crown just under the sleepers with
// sloped shoulders falling to a toe below the settled subgrade, so the track
// always stands proud of the ground. Must out-reach RAILWAY_TRACKBED_DROP.
function pushBallastBed(target, a, b) {
  const { rx, rz } = railRight(a, b);
  const corner = (pt, lat, y) => [pt.x + rx * lat, pt.y + y, pt.z + rz * lat];
  const top = 0.05, toe = -0.44, topHalf = 1.55, toeHalf = 2.8;
  const aTL = corner(a, -topHalf, top), aTR = corner(a, topHalf, top);
  const aOL = corner(a, -toeHalf, toe), aOR = corner(a, toeHalf, toe);
  const bTL = corner(b, -topHalf, top), bTR = corner(b, topHalf, top);
  const bOL = corner(b, -toeHalf, toe), bOR = corner(b, toeHalf, toe);
  pushQuad(target, aTL, aTR, bTL, bTR, [0, 1, 0]);        // crown
  pushQuad(target, aOL, aTL, bOL, bTL, [-rx, 0.5, -rz]);  // left shoulder
  pushQuad(target, aTR, aOR, bTR, bOR, [rx, 0.5, rz]);    // right shoulder
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
  const families = new Uint8Array(count);
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
    const pa = plan.points[i], pb = plan.points[j];
    const a = pa?.structure || 'surface';
    const b = pb?.structure || a;
    // Bridges own boundary segments (abutments); tunnels must not, so the
    // surface track and its earthworks run right up to the portal plane.
    const kind = a === 'bridge' || b === 'bridge' ? 'bridge' : a;
    kinds[i] = STRUCTURE_CODE[kind] ?? 0;
    // Take the family from whichever endpoint owns the chosen kind, so a bridge
    // segment that straddles a surface point still reads as its structure.
    const familyPoint = (kind === 'bridge' && a !== 'bridge') ? pb
      : (kind === 'tunnel' && a !== 'tunnel') ? pb : pa;
    families[i] = STRUCTURE_FAMILY[familyPoint?.family] ?? 0;
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
    families,
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
    this.families = spec.families || null;
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
  const masonry = emptyGeometry(), timber = emptyGeometry();
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
    const family = index.families ? STRUCTURE_FAMILY_NAME[index.families[segmentIndex]] : 'surface';
    const timberFamily = family === 'timber';
    structures[kind]++;
    // Tunnel segments keep their track: the bore interior (railwaytunnel.mjs)
    // encloses it, and passengers see it through the carriage windows. They
    // take the plain ballast-bed branch — no retaining walls underground.

    const groundA = groundHeightAt ? groundHeightAt(a.x, a.z) : a.y;
    const groundB = groundHeightAt ? groundHeightAt(b.x, b.z) : b.y;
    const offA = a.y - groundA, offB = b.y - groundB;
    const offMean = (offA + offB) * 0.5;

    if (kind === 'bridge') {
      pushBeam(bridge, a, b, 0, 4.15, -0.48, -0.02);
      if (timberFamily) {
        // Timber trestle: plank deck and open twin-rail railings.
        pushRibbon(timber, a, b, 3.5, -0.03);
        for (const side of [-PARAPET_HALF, PARAPET_HALF]) {
          pushBeam(timber, a, b, side, 0.09, 0.34, 0.44);
          pushBeam(timber, a, b, side, 0.09, 0.72, 0.82);
        }
      } else {
        // Masonry deck: solid stone parapets both sides.
        for (const side of [-PARAPET_HALF, PARAPET_HALF]) {
          pushBeam(masonry, a, b, side, 0.34, 0.02, 0.74);
        }
        if (family === 'viaduct') pushBeam(masonry, a, b, 0, 3.7, -0.98, -0.5);
        if (family === 'culvert' && groundHeightAt) {
          // Box-culvert barrel walls flank the stream; terrain is never raised
          // over a bridge kind, so the watercourse still runs through the gap.
          for (const side of [-CULVERT_ABUTMENT, CULVERT_ABUTMENT]) {
            pushWall(masonry, a, b, side, groundA - 0.3, groundB - 0.3, a.y - 0.42, b.y - 0.42, 0.5);
          }
        }
      }
    } else {
      pushBallastBed(ballast, a, b);
      if (groundHeightAt && kind === 'fill' && offMean > RETAIN_FILL) {
        // Steep embankment shoulders held by retaining walls, plus a parapet
        // guardrail once the drop is tall enough to matter.
        for (const side of [-RETAIN_LATERAL, RETAIN_LATERAL]) {
          pushWall(masonry, a, b, side, groundA - 0.3, groundB - 0.3, a.y + 0.08, b.y + 0.08, 0.5);
        }
        if (offMean > GUARDRAIL_FILL) {
          for (const side of [-PARAPET_HALF, PARAPET_HALF]) {
            pushBeam(masonry, a, b, side, 0.24, 0.34, 0.78);
          }
        }
      } else if (groundHeightAt && kind === 'cut' && -offMean > RETAIN_CUT) {
        // Cutting faces retained so the excavated walls stay clean, not raw slope.
        for (const side of [-RETAIN_LATERAL, RETAIN_LATERAL]) {
          pushWall(masonry, a, b, side, a.y - 0.1, b.y - 0.1, groundA + 0.15, groundB + 0.15, 0.5);
        }
      }
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

    // Culverts sit low and carry no piers; every other bridge family drops
    // ground-seated supports (timber bents in timber country, else stone).
    if (kind === 'bridge' && family !== 'culvert' && groundHeightAt) {
      const clippedLength = Math.hypot(b.x - a.x, b.z - a.z);
      const spacing = family === 'viaduct' ? 22 : 18;
      const count = Math.floor(clippedLength / spacing);
      for (let p = 1; p <= count; p++) {
        const t = p / (count + 1), x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const deckY = a.y + (b.y - a.y) * t - 0.48;
        const groundY = groundHeightAt(x, z);
        if (deckY - groundY > 1.2) piers.push({
          x, z, bottomY: groundY, topY: deckY, family: timberFamily ? 1 : 0,
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
    masonry: finalizeGeometry(masonry),
    timber: finalizeGeometry(timber),
    sleepers, piers, stations, structures,
  };
}

export const RAILWAY_TRACK_DEFAULTS = Object.freeze({
  tileSize: DEFAULT_TILE_SIZE,
  sleeperSpacing: 1.12,
});
