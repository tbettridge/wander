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
const ARCH_FAMILIES = new Set(['culvert', 'stone', 'viaduct']);
const ARCH_SPAN = Object.freeze({ culvert: 34, stone: 18, viaduct: 22 });
const ARCH_HALF_WIDTH = 1.92;
const RETAINING_BAY = 13.5;

export const RAILWAY_MASONRY_PROFILES = Object.freeze({
  'desktop-potato': Object.freeze({ key: 'desktop-potato', archSegments: 8, trimLevel: 0, colorVariation: 0.025, receiveShadow: false, frontSide: false }),
  'desktop-low': Object.freeze({ key: 'desktop-low', archSegments: 10, trimLevel: 0, colorVariation: 0.035, receiveShadow: false, frontSide: false }),
  'desktop-medium': Object.freeze({ key: 'desktop-medium', archSegments: 12, trimLevel: 1, colorVariation: 0.045, receiveShadow: true, frontSide: false }),
  'desktop-high': Object.freeze({ key: 'desktop-high', archSegments: 14, trimLevel: 2, colorVariation: 0.060, receiveShadow: true, frontSide: false }),
  'desktop-ultra': Object.freeze({ key: 'desktop-ultra', archSegments: 16, trimLevel: 2, colorVariation: 0.070, receiveShadow: true, frontSide: false }),
  'xr-painterly': Object.freeze({ key: 'xr-painterly', archSegments: 10, trimLevel: 0, colorVariation: 0.040, receiveShadow: false, frontSide: true }),
  'xr-survival': Object.freeze({ key: 'xr-survival', archSegments: 8, trimLevel: 0, colorVariation: 0.030, receiveShadow: false, frontSide: true }),
});

export function railwayMasonryProfile({ xr = false, tier = 'high' } = {}) {
  const key = `${xr ? 'xr' : 'desktop'}-${tier}`;
  return RAILWAY_MASONRY_PROFILES[key]
    || RAILWAY_MASONRY_PROFILES[xr ? 'xr-painterly' : 'desktop-high'];
}

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
  if (target.colors) {
    const color = target.color || [1, 1, 1];
    for (let i = 0; i < 4; i++) target.colors.push(color[0], color[1], color[2]);
  }
  if (target.orientFaces) {
    const points = [a, b, c, d];
    const pushOriented = (i0, i1, i2) => {
      const p0 = points[i0], p1 = points[i1], p2 = points[i2];
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      if (nx * normal[0] + ny * normal[1] + nz * normal[2] < 0) {
        target.indices.push(base + i0, base + i2, base + i1);
      } else target.indices.push(base + i0, base + i1, base + i2);
    };
    pushOriented(0, 2, 1);
    pushOriented(2, 3, 1);
  } else {
    target.indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
  }
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

function emptyGeometry(withColors = false) {
  const geometry = { positions: [], normals: [], indices: [] };
  if (withColors) {
    geometry.colors = [];
    geometry.color = [1, 1, 1];
    geometry.orientFaces = true;
  }
  return geometry;
}

function finalizeGeometry(source) {
  if (!source.indices.length) return null;
  const geometry = {
    positions: Float32Array.from(source.positions),
    normals: Float32Array.from(source.normals),
    indices: Uint32Array.from(source.indices),
  };
  if (source.colors?.length) geometry.colors = Float32Array.from(source.colors);
  return geometry;
}

function masonryTone(target, salt, variation, shade = 0) {
  const hash = Math.sin(salt * 12.9898 + 78.233) * 43758.5453;
  const centred = (hash - Math.floor(hash) - 0.5) * 2;
  const value = 1 + centred * variation + shade;
  // A tiny warm/cool drift groups spans without becoming visible speckle.
  target.color = [value * (1 + centred * 0.012), value, value * (1 - centred * 0.018)];
}

function resetMasonryTone(target) {
  target.color = [1, 1, 1];
}

// Sample the serialized alignment by global route distance. Distances may run
// past routeLength for a bridge run that wraps the closed loop; modulo keeps
// the span phase continuous without special-casing the seam.
function sampleRouteAtArc(index, distance) {
  const length = Math.max(1e-9, index.routeLength);
  let arc = distance % length;
  if (arc < 0) arc += length;
  // The exact loop endpoint belongs to the first segment.
  if (arc >= length) arc = 0;
  let lo = 0, hi = index.segmentCount - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index.segments[mid * 8 + 7] <= arc) lo = mid + 1;
    else hi = mid;
  }
  const o = lo * 8;
  const arc0 = index.segments[o + 6], arc1 = index.segments[o + 7];
  const t = clamp((arc - arc0) / Math.max(1e-9, arc1 - arc0), 0, 1);
  const tangentX = index.segments[o + 3] - index.segments[o];
  const tangentY = index.segments[o + 4] - index.segments[o + 1];
  const tangentZ = index.segments[o + 5] - index.segments[o + 2];
  return {
    x: index.segments[o] + tangentX * t,
    y: index.segments[o + 1] + tangentY * t,
    z: index.segments[o + 2] + tangentZ * t,
    tangentX, tangentY, tangentZ,
  };
}

function archFamilyAt(index, segmentIndex) {
  if (STRUCTURE_NAME[index.kinds[segmentIndex]] !== 'bridge') return null;
  const family = index.families ? STRUCTURE_FAMILY_NAME[index.families[segmentIndex]] : null;
  return ARCH_FAMILIES.has(family) ? family : null;
}

// Plan whole masonry runs before they are divided into stream tiles. Every
// arch and support consequently has one route-distance phase and one owning
// tile, preventing duplicated piers or a rhythm reset on a 280 m boundary.
function planMasonryArches(index) {
  const n = index.segmentCount;
  if (!n || !index.families) return { spans: [], supports: [] };
  let boundary = -1;
  for (let i = 0; i < n; i++) {
    const current = archFamilyAt(index, i);
    const next = archFamilyAt(index, (i + 1) % n);
    if (current !== next) { boundary = i; break; }
  }
  const startAt = boundary >= 0 ? (boundary + 1) % n : 0;
  const runs = [];
  let run = null;
  for (let step = 0; step <= n; step++) {
    const i = (startAt + step) % n;
    const family = step < n ? archFamilyAt(index, i) : null;
    if (family && (!run || run.family === family)) {
      if (!run) run = { family, members: [] };
      run.members.push(i);
    } else {
      if (run) runs.push(run);
      run = family ? { family, members: [i] } : null;
    }
  }

  const spans = [], supports = [];
  for (const item of runs) {
    const first = item.members[0], last = item.members[item.members.length - 1];
    let arc0 = index.segments[first * 8 + 6];
    let arc1 = index.segments[last * 8 + 7];
    if (arc1 <= arc0) arc1 += index.routeLength;
    const runLength = arc1 - arc0;
    if (runLength < 7) continue;
    const count = Math.max(1, Math.round(runLength / ARCH_SPAN[item.family]));
    const spanLength = runLength / count;
    const supportStart = supports.length;
    for (let i = 0; i <= count; i++) {
      supports.push({
        arc: arc0 + spanLength * i,
        family: item.family,
        abutment: i === 0 || i === count,
        spans: [],
      });
    }
    for (let i = 0; i < count; i++) {
      const spanIndex = spans.length;
      spans.push({
        arc0: arc0 + spanLength * i,
        arc1: arc0 + spanLength * (i + 1),
        family: item.family,
        support0: supportStart + i,
        support1: supportStart + i + 1,
      });
      supports[supportStart + i].spans.push(spanIndex);
      supports[supportStart + i + 1].spans.push(spanIndex);
    }
  }
  return { spans, supports };
}

function retainingFamilyAt(index, segmentIndex) {
  if (STRUCTURE_NAME[index.kinds[segmentIndex]] !== 'fill') return null;
  const family = index.families ? STRUCTURE_FAMILY_NAME[index.families[segmentIndex]] : null;
  return family === 'embankment' ? family : null;
}

// Elevated fills remain solid terrain. Their masonry is planned in the same
// global route-distance space as bridge arches, but the openings are shallow,
// recessed blind bays backed by solid wall rather than holes through the bank.
function planRetainingArcades(index) {
  const n = index.segmentCount;
  if (!n || !index.families) return { spans: [], supports: [] };
  let boundary = -1;
  for (let i = 0; i < n; i++) {
    if (retainingFamilyAt(index, i) !== retainingFamilyAt(index, (i + 1) % n)) {
      boundary = i;
      break;
    }
  }
  const startAt = boundary >= 0 ? (boundary + 1) % n : 0;
  const runs = [];
  let members = [];
  for (let step = 0; step <= n; step++) {
    const i = (startAt + step) % n;
    if (step < n && retainingFamilyAt(index, i)) members.push(i);
    else if (members.length) {
      runs.push(members);
      members = [];
    }
  }
  const spans = [], supports = [];
  for (const run of runs) {
    const first = run[0], last = run[run.length - 1];
    let arc0 = index.segments[first * 8 + 6];
    let arc1 = index.segments[last * 8 + 7];
    if (arc1 <= arc0) arc1 += index.routeLength;
    const length = arc1 - arc0;
    if (length < 5) continue;
    const count = Math.max(1, Math.round(length / RETAINING_BAY));
    const bayLength = length / count;
    const supportStart = supports.length;
    for (let i = 0; i <= count; i++) supports.push({ arc: arc0 + bayLength * i });
    for (let i = 0; i < count; i++) spans.push({
      arc0: arc0 + bayLength * i,
      arc1: arc0 + bayLength * (i + 1),
      support0: supportStart + i,
      support1: supportStart + i + 1,
    });
  }
  return { spans, supports };
}

function pointAtLateral(sample, lateral, y) {
  const length = Math.hypot(sample.tangentX, sample.tangentZ) || 1;
  const rx = sample.tangentZ / length, rz = -sample.tangentX / length;
  return [sample.x + rx * lateral, y, sample.z + rz * lateral];
}

function pointAtTrackOffset(sample, along, lateral, y) {
  const length = Math.hypot(sample.tangentX, sample.tangentZ) || 1;
  const tx = sample.tangentX / length, tz = sample.tangentZ / length;
  const rx = sample.tangentZ / length, rz = -sample.tangentX / length;
  return [sample.x + tx * along + rx * lateral, y, sample.z + tz * along + rz * lateral];
}

function pushArchRing(target, samples, trimLevel) {
  if (trimLevel < 1) return;
  const band = trimLevel >= 2 ? 0.34 : 0.24;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    for (const side of [-1, 1]) {
      const normalLength = Math.hypot(a.tangentX, a.tangentZ) || 1;
      const normal = [
        a.tangentZ / normalLength * side, 0, -a.tangentX / normalLength * side,
      ];
      const lateral = side * (ARCH_HALF_WIDTH + 0.035);
      pushQuad(target,
        pointAtLateral(a, lateral, a.archY + 0.02),
        pointAtLateral(a, lateral, Math.min(a.topY - 0.04, a.archY + band)),
        pointAtLateral(b, lateral, b.archY + 0.02),
        pointAtLateral(b, lateral, Math.min(b.topY - 0.04, b.archY + band)),
        normal);
    }
  }
}

function pushArchKeystones(target, samples, trimLevel) {
  if (trimLevel < 2) return;
  const crown = samples[Math.floor(samples.length * 0.5)];
  const bottom = crown.archY + 0.02;
  const top = Math.min(crown.topY - 0.04, bottom + 0.62);
  if (top - bottom < 0.18) return;
  for (const side of [-1, 1]) {
    const inner = side * (ARCH_HALF_WIDTH + 0.03);
    const outer = side * (ARCH_HALF_WIDTH + 0.18);
    const halfBottom = 0.30, halfTop = 0.42;
    const bil = pointAtTrackOffset(crown, -halfBottom, inner, bottom);
    const bir = pointAtTrackOffset(crown, halfBottom, inner, bottom);
    const bol = pointAtTrackOffset(crown, -halfBottom, outer, bottom);
    const bor = pointAtTrackOffset(crown, halfBottom, outer, bottom);
    const til = pointAtTrackOffset(crown, -halfTop, inner, top);
    const tir = pointAtTrackOffset(crown, halfTop, inner, top);
    const tol = pointAtTrackOffset(crown, -halfTop, outer, top);
    const tor = pointAtTrackOffset(crown, halfTop, outer, top);
    const tangentLength = Math.hypot(crown.tangentX, crown.tangentZ) || 1;
    const tx = crown.tangentX / tangentLength, tz = crown.tangentZ / tangentLength;
    const rx = crown.tangentZ / tangentLength, rz = -crown.tangentX / tangentLength;
    pushQuad(target, bol, tol, bor, tor, [rx * side, 0, rz * side]);
    pushQuad(target, bil, bol, til, tol, [-tx, 0, -tz]);
    pushQuad(target, bir, tir, bor, tor, [tx, 0, tz]);
    pushQuad(target, til, tir, tol, tor, [0, 1, 0]);
  }
}

function masonryArchProfile(index, span, groundHeightAt, segments) {
  if (!groundHeightAt) return false;
  const samples = [];
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const sample = sampleRouteAtArc(index, span.arc0 + (span.arc1 - span.arc0) * u);
    sample.u = u;
    sample.groundY = groundHeightAt(sample.x, sample.z);
    sample.topY = sample.y - 0.50;
    samples.push(sample);
  }
  const interior = samples.slice(1, -1);
  const springY = Math.max(...(interior.length ? interior : samples).map((s) => s.groundY)) + 0.18;
  const available = Math.min(...samples.map((s) => s.topY - springY));
  const spanLength = span.arc1 - span.arc0;
  const riseRatio = span.family === 'viaduct' ? 0.46 : span.family === 'culvert' ? 0.32 : 0.39;
  const desiredRise = spanLength * riseRatio;
  const rise = Math.min(desiredRise, available - 0.38);
  if (rise < (span.family === 'culvert' ? 0.55 : 1.15)) return null;

  for (const sample of samples) {
    const ellipse = Math.sin(Math.PI * sample.u);
    sample.archY = Math.max(springY + rise * ellipse, sample.groundY + 0.12);
  }
  return samples;
}

function pushMasonryArchSpan(target, span, samples, trimLevel = 0) {
  if (!samples) return false;
  const segments = samples.length - 1;
  for (let i = 0; i < segments; i++) {
    const a = samples[i], b = samples[i + 1];
    for (const side of [-1, 1]) {
      const normalLength = Math.hypot(a.tangentX, a.tangentZ) || 1;
      const nx = a.tangentZ / normalLength * side;
      const nz = -a.tangentX / normalLength * side;
      pushQuad(target,
        pointAtLateral(a, side * ARCH_HALF_WIDTH, a.archY),
        pointAtLateral(a, side * ARCH_HALF_WIDTH, a.topY),
        pointAtLateral(b, side * ARCH_HALF_WIDTH, b.archY),
        pointAtLateral(b, side * ARCH_HALF_WIDTH, b.topY),
        [nx, 0, nz]);
    }
    // The arch soffit closes the opening across the whole bridge width, so the
    // silhouette remains convincing when viewed from beneath or from water.
    pushQuad(target,
      pointAtLateral(a, -ARCH_HALF_WIDTH, a.archY),
      pointAtLateral(a, ARCH_HALF_WIDTH, a.archY),
      pointAtLateral(b, -ARCH_HALF_WIDTH, b.archY),
      pointAtLateral(b, ARCH_HALF_WIDTH, b.archY),
      [0, -1, 0]);
  }
  pushArchRing(target, samples, trimLevel);
  pushArchKeystones(target, samples, trimLevel);
  return true;
}

function pushTaperedMasonrySupport(target, index, support, groundHeightAt, trimLevel = 0) {
  if (!groundHeightAt) return false;
  const sample = sampleRouteAtArc(index, support.arc);
  const topY = sample.y - 0.48;
  const bottomY = groundHeightAt(sample.x, sample.z) - 0.18;
  if (topY - bottomY < 0.8) return false;
  const tangentLength = Math.hypot(sample.tangentX, sample.tangentZ) || 1;
  const tx = sample.tangentX / tangentLength, tz = sample.tangentZ / tangentLength;
  const rx = sample.tangentZ / tangentLength, rz = -sample.tangentX / tangentLength;
  const slim = support.family === 'viaduct';
  const culvert = support.family === 'culvert';
  const topAlong = support.abutment ? (culvert ? 2.05 : 2.35) : (slim ? 1.35 : 1.55);
  const bottomAlong = support.abutment ? (culvert ? 2.55 : 3.0) : (slim ? 1.82 : 2.05);
  const topAcross = support.abutment ? (culvert ? 2.25 : 2.45) : (slim ? 1.92 : 2.05);
  const bottomAcross = support.abutment ? (culvert ? 2.75 : 3.0) : (slim ? 2.38 : 2.55);
  const corner = (along, across, y) => [
    sample.x + tx * along + rx * across,
    y,
    sample.z + tz * along + rz * across,
  ];
  const bl = corner(-bottomAlong, -bottomAcross, bottomY);
  const br = corner(-bottomAlong, bottomAcross, bottomY);
  const bf = corner(bottomAlong, -bottomAcross, bottomY);
  const bb = corner(bottomAlong, bottomAcross, bottomY);
  const tl = corner(-topAlong, -topAcross, topY);
  const tr = corner(-topAlong, topAcross, topY);
  const tf = corner(topAlong, -topAcross, topY);
  const tb = corner(topAlong, topAcross, topY);
  pushQuad(target, bl, tl, bf, tf, [-rx, 0, -rz]);
  pushQuad(target, br, bb, tr, tb, [rx, 0, rz]);
  pushQuad(target, bl, br, tl, tr, [-tx, 0, -tz]);
  pushQuad(target, bf, tf, bb, tb, [tx, 0, tz]);
  pushQuad(target, tl, tr, tf, tb, [0, 1, 0]);
  if (trimLevel >= 1) {
    const capHalf = topAlong + 0.24;
    const capA = {
      x: sample.x - tx * capHalf, y: sample.y, z: sample.z - tz * capHalf,
    };
    const capB = {
      x: sample.x + tx * capHalf, y: sample.y, z: sample.z + tz * capHalf,
    };
    pushBeam(target, capA, capB, 0, topAcross * 2 + 0.34, -0.55, -0.30);
  }
  return true;
}

function pushSolidRetainingBay(target, samples) {
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    for (const side of [-RETAIN_LATERAL, RETAIN_LATERAL]) {
      pushWall(target, a, b, side,
        a.groundY - 0.3, b.groundY - 0.3, a.y + 0.08, b.y + 0.08, 0.5);
    }
  }
}

function pushBlindRetainingBay(target, index, span, groundHeightAt, segments) {
  if (!groundHeightAt) return false;
  const samples = [];
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const sample = sampleRouteAtArc(index, span.arc0 + (span.arc1 - span.arc0) * u);
    sample.u = u;
    sample.groundY = groundHeightAt(sample.x, sample.z);
    sample.topY = sample.y + 0.08;
    samples.push(sample);
  }
  const centre = samples[Math.floor(samples.length * 0.5)];
  const maxHeight = Math.max(...samples.map((sample) => sample.topY - sample.groundY));
  if (maxHeight <= RETAIN_FILL) return false;
  const springY = Math.max(...samples.map((sample) => sample.groundY)) + 0.30;
  const available = Math.min(...samples.map((sample) => sample.topY - springY));
  const rise = Math.min((span.arc1 - span.arc0) * 0.23, available - 0.42);
  if (centre.topY - centre.groundY <= RETAIN_FILL || rise < 0.65) {
    pushSolidRetainingBay(target, samples);
    return true;
  }
  for (const sample of samples) {
    sample.archY = Math.max(
      springY + rise * Math.sin(Math.PI * sample.u),
      sample.groundY + 0.20,
    );
  }
  for (let i = 0; i < segments; i++) {
    const a = samples[i], b = samples[i + 1];
    for (const side of [-1, 1]) {
      const normalLength = Math.hypot(a.tangentX, a.tangentZ) || 1;
      const normal = [
        a.tangentZ / normalLength * side,
        0,
        -a.tangentX / normalLength * side,
      ];
      const outer = side * RETAIN_LATERAL;
      const inset = side * (RETAIN_LATERAL - 0.18);
      // Upper facade, recessed solid backing, and the short reveal between
      // them. Terrain remains packed behind the backing: this is a blind bay.
      pushQuad(target,
        pointAtLateral(a, outer, a.archY), pointAtLateral(a, outer, a.topY),
        pointAtLateral(b, outer, b.archY), pointAtLateral(b, outer, b.topY), normal);
      pushQuad(target,
        pointAtLateral(a, inset, a.groundY - 0.18), pointAtLateral(a, inset, a.archY - 0.08),
        pointAtLateral(b, inset, b.groundY - 0.18), pointAtLateral(b, inset, b.archY - 0.08), normal);
      pushQuad(target,
        pointAtLateral(a, outer, a.archY), pointAtLateral(a, inset, a.archY - 0.08),
        pointAtLateral(b, outer, b.archY), pointAtLateral(b, inset, b.archY - 0.08),
        [0, -1, 0]);
    }
  }
  return true;
}

function pushRetainingButtress(target, index, support, groundHeightAt) {
  if (!groundHeightAt) return false;
  const sample = sampleRouteAtArc(index, support.arc);
  const topY = sample.y + 0.08;
  const bottomY = groundHeightAt(sample.x, sample.z) - 0.30;
  if (topY - bottomY <= RETAIN_FILL) return false;
  const tangentLength = Math.hypot(sample.tangentX, sample.tangentZ) || 1;
  const tx = sample.tangentX / tangentLength, tz = sample.tangentZ / tangentLength;
  const rx = sample.tangentZ / tangentLength, rz = -sample.tangentX / tangentLength;
  const corner = (along, lateral, y) => [
    sample.x + tx * along + rx * lateral,
    y,
    sample.z + tz * along + rz * lateral,
  ];
  for (const side of [-1, 1]) {
    const bottomHalf = 0.62, topHalf = 0.40;
    const wall = side * (RETAIN_LATERAL - 0.05);
    const bottomOuter = side * (RETAIN_LATERAL + 0.70);
    const topOuter = side * (RETAIN_LATERAL + 0.36);
    const bil = corner(-bottomHalf, wall, bottomY);
    const bir = corner(bottomHalf, wall, bottomY);
    const bol = corner(-bottomHalf, bottomOuter, bottomY);
    const bor = corner(bottomHalf, bottomOuter, bottomY);
    const til = corner(-topHalf, wall, topY);
    const tir = corner(topHalf, wall, topY);
    const tol = corner(-topHalf, topOuter, topY);
    const tor = corner(topHalf, topOuter, topY);
    pushQuad(target, bol, tol, bor, tor, [rx * side, 0, rz * side]);
    pushQuad(target, bil, bol, til, tol, [-tx, 0, -tz]);
    pushQuad(target, bir, tir, bor, tor, [tx, 0, tz]);
    pushQuad(target, til, tir, tol, tor, [0, 1, 0]);
  }
  return true;
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
    const masonryPlan = planMasonryArches(this);
    this.masonryArchSpans = masonryPlan.spans;
    this.masonryArchSupports = masonryPlan.supports;
    const retainingPlan = planRetainingArcades(this);
    this.retainingSpans = retainingPlan.spans;
    this.retainingSupports = retainingPlan.supports;
    this._indexMasonryArches();
  }

  _entry(ix, iz) {
    const key = tileKey(ix, iz);
    let entry = this.tiles.get(key);
    if (!entry) this.tiles.set(key, entry = {
      ix, iz, segments: [], stations: [],
      masonryArchSpans: [], masonryArchSupports: [], retainingSpans: [], retainingSupports: [],
    });
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

  _indexMasonryArches() {
    for (let i = 0; i < this.masonryArchSpans.length; i++) {
      const span = this.masonryArchSpans[i];
      const sample = sampleRouteAtArc(this, (span.arc0 + span.arc1) * 0.5);
      this._entry(Math.floor(sample.x / this.tileSize), Math.floor(sample.z / this.tileSize))
        .masonryArchSpans.push(i);
    }
    for (let i = 0; i < this.masonryArchSupports.length; i++) {
      const support = this.masonryArchSupports[i];
      const sample = sampleRouteAtArc(this, support.arc);
      this._entry(Math.floor(sample.x / this.tileSize), Math.floor(sample.z / this.tileSize))
        .masonryArchSupports.push(i);
    }
    for (let i = 0; i < this.retainingSpans.length; i++) {
      const span = this.retainingSpans[i];
      const sample = sampleRouteAtArc(this, (span.arc0 + span.arc1) * 0.5);
      this._entry(Math.floor(sample.x / this.tileSize), Math.floor(sample.z / this.tileSize))
        .retainingSpans.push(i);
    }
    for (let i = 0; i < this.retainingSupports.length; i++) {
      const support = this.retainingSupports[i];
      const sample = sampleRouteAtArc(this, support.arc);
      this._entry(Math.floor(sample.x / this.tileSize), Math.floor(sample.z / this.tileSize))
        .retainingSupports.push(i);
    }
  }

  entry(ix, iz) {
    return this.tiles.get(tileKey(ix, iz)) || null;
  }
}

export function buildRailwayTrackTile(index, ix, iz, {
  sleeperSpacing = 1.12,
  groundHeightAt = null,
  masonryArches = true,
  masonryArchSegments = 10,
  masonryTrimLevel = 0,
  masonryColorVariation = 0.04,
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
  const masonry = emptyGeometry(true), timber = emptyGeometry();
  const sleepers = [], piers = [], structures = { surface: 0, cut: 0, fill: 0, bridge: 0, tunnel: 0 };
  const arches = { spans: 0, supports: 0, culverts: 0, retainingBays: 0, retainingSupports: 0 };
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
          if (masonryTrimLevel >= 1) {
            pushBeam(masonry, a, b, side, 0.46, 0.74, 0.86);
            pushBeam(masonry, a, b, side, 0.44, -0.66, -0.43);
          }
        }
        if (family === 'viaduct') pushBeam(masonry, a, b, 0, 3.7, -0.98, -0.5);
        if (family === 'culvert' && (!masonryArches || !ARCH_FAMILIES.has(family)) && groundHeightAt) {
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
        if (!masonryArches) {
          for (const side of [-RETAIN_LATERAL, RETAIN_LATERAL]) {
            pushWall(masonry, a, b, side, groundA - 0.3, groundB - 0.3, a.y + 0.08, b.y + 0.08, 0.5);
          }
        }
        if (offMean > GUARDRAIL_FILL) {
          for (const side of [-PARAPET_HALF, PARAPET_HALF]) {
            pushBeam(masonry, a, b, side, 0.24, 0.34, 0.78);
            if (masonryTrimLevel >= 1) pushBeam(masonry, a, b, side, 0.34, 0.78, 0.88);
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
    const archFamily = masonryArches && ARCH_FAMILIES.has(family);
    if (kind === 'bridge' && family !== 'culvert' && !archFamily && groundHeightAt) {
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


  if (masonryArches) {
    const segments = Math.max(6, Math.min(24, Math.round(masonryArchSegments)));
    const archProfiles = new Map();
    const profileFor = (spanIndex) => {
      if (!archProfiles.has(spanIndex)) {
        archProfiles.set(spanIndex, masonryArchProfile(
          index, index.masonryArchSpans[spanIndex], groundHeightAt, segments,
        ));
      }
      return archProfiles.get(spanIndex);
    };
    for (const spanIndex of entry.masonryArchSpans || []) {
      const span = index.masonryArchSpans[spanIndex];
      masonryTone(masonry, (span.arc0 + span.arc1) * 0.5, masonryColorVariation);
      if (pushMasonryArchSpan(
        masonry, span, profileFor(spanIndex), masonryTrimLevel,
      )) {
        arches.spans++;
        if (span.family === 'culvert') arches.culverts++;
      }
      resetMasonryTone(masonry);
    }
    for (const supportIndex of entry.masonryArchSupports || []) {
      const support = index.masonryArchSupports[supportIndex];
      if (!support.spans.some((spanIndex) => profileFor(spanIndex))) continue;
      masonryTone(masonry, support.arc + 17.3, masonryColorVariation, -0.025);
      if (pushTaperedMasonrySupport(
        masonry, index, support, groundHeightAt, masonryTrimLevel,
      )) arches.supports++;
      resetMasonryTone(masonry);
    }
    for (const spanIndex of entry.retainingSpans || []) {
      const span = index.retainingSpans[spanIndex];
      masonryTone(masonry, (span.arc0 + span.arc1) * 0.5 + 31.7, masonryColorVariation * 0.75);
      if (pushBlindRetainingBay(
        masonry, index, span, groundHeightAt, segments,
      )) arches.retainingBays++;
      resetMasonryTone(masonry);
    }
    for (const supportIndex of entry.retainingSupports || []) {
      const support = index.retainingSupports[supportIndex];
      masonryTone(masonry, support.arc + 49.1, masonryColorVariation * 0.75, -0.018);
      if (pushRetainingButtress(
        masonry, index, support, groundHeightAt,
      )) arches.retainingSupports++;
      resetMasonryTone(masonry);
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
    sleepers, piers, stations, structures, arches,
  };
}

export const RAILWAY_TRACK_DEFAULTS = Object.freeze({
  tileSize: DEFAULT_TILE_SIZE,
  sleeperSpacing: 1.12,
  masonryArchSegments: 10,
  masonryTrimLevel: 0,
});
