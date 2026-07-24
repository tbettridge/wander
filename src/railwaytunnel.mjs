// Phase 7 railway tunnels. Pure and THREE-free: identifies tunnel runs on the
// planned alignment, builds the bore interior + portal geometry as raw arrays,
// scores how far "inside" a position is (drives lighting/sound), and opens the
// bore mouth through the terrain heightfield by filtering triangles — the same
// selected cave technology (terrain cut + atmosphere factor), scaled down to
// the railway's needs.

// Bore cross-section (relative to rail formation Y). The tube is wider and
// taller than the train envelope (carriage 2.55w × ~3.4h over rail) and, at
// ~1.5m from the carriage windows, is what a passenger sees sliding past.
export const TUNNEL_PROFILE = Object.freeze({
  halfWidth: 2.75,
  floorY: -0.45,
  wallTop: 1.7,
  crownY: 5.0,
  archSamples: 8,
});

// Portal mouth volume used to open the terrain curtain at each portal: a box
// in the portal's local frame (along = track direction, lateral, vertical).
export const PORTAL_MOUTH = Object.freeze({
  halfWidth: 3.05,
  base: -1.0,
  top: 5.4,
  reach: 3.2,
});

// Portal facade: masonry front wall with an arch opening, slightly smaller
// than the bore so the tube rim always hides behind it, plus side/top returns
// running back into the hill so the cut terrain rim is never visible.
export const PORTAL_FACADE = Object.freeze({
  openingHalfWidth: 2.45,
  openingWallTop: 1.5,
  openingCrown: 4.55,
  openingBase: -0.8,
  outerHalfWidth: 5.5,
  outerBase: -0.8,
  outerTop: 8.6,
  returnDepth: 3.6,
});

const RIB_SPACING = 7;
const RIB_WIDTH = 0.3;
const RIB_INSET = 0.12;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(a, b, value) {
  const t = clamp((value - a) / Math.max(1e-9, b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// --- run discovery -----------------------------------------------------------

/**
 * Contiguous tunnel-kind stretches of the closed loop, each with portal
 * positions/directions and a fine-grained centreline (portal collars included
 * so the tube pokes through the facades). plan.points map 1:1 to route arc.
 */
export function collectTunnelRuns(plan, { spacing = 3, collar = 2.4 } = {}) {
  const points = plan?.points;
  const route = plan?.route;
  if (!points?.length || !route) return [];
  const n = points.length;

  // Start scanning at a non-tunnel point so a run straddling index 0 stays whole.
  let scanStart = 0;
  for (let i = 0; i < n; i++) {
    if (points[i].structure !== 'tunnel') { scanStart = i; break; }
  }

  const runs = [];
  let current = null;
  for (let step = 0; step <= n; step++) {
    const i = (scanStart + step) % n;
    const isTunnel = points[i].structure === 'tunnel' && step < n;
    if (isTunnel) {
      if (!current) current = { startIndex: i, count: 0 };
      current.count++;
    } else if (current) {
      const endIndex = (current.startIndex + current.count - 1) % n;
      let arcStart = route.arc[current.startIndex];
      let arcEnd = route.arc[(endIndex + 1) % n === 0 ? n : endIndex + 1];
      if (arcEnd <= arcStart) arcEnd += route.length;
      runs.push(makeRun(route, current.startIndex, endIndex, arcStart, arcEnd, spacing, collar));
      current = null;
    }
  }
  return runs;
}

function makeRun(route, startIndex, endIndex, arcStart, arcEnd, spacing, collar) {
  const length = arcEnd - arcStart;
  const samples = [];
  const from = arcStart - collar;
  const to = arcEnd + collar;
  const count = Math.max(2, Math.ceil((to - from) / spacing));
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  const scratch = {};
  for (let i = 0; i <= count; i++) {
    const arc = from + (to - from) * (i / count);
    const s = route.sampleAtDistance(arc, scratch);
    const hyp = Math.hypot(s.tangentX, s.tangentZ) || 1;
    const tx = s.tangentX / hyp, tz = s.tangentZ / hyp;
    samples.push({
      arc, x: s.x, y: s.y, z: s.z,
      tx, tz, rx: tz, rz: -tx,
    });
    bounds.minX = Math.min(bounds.minX, s.x); bounds.maxX = Math.max(bounds.maxX, s.x);
    bounds.minZ = Math.min(bounds.minZ, s.z); bounds.maxZ = Math.max(bounds.maxZ, s.z);
  }
  const portal = (arc, sign) => {
    const s = route.sampleAtDistance(arc, {});
    const hyp = Math.hypot(s.tangentX, s.tangentZ) || 1;
    return {
      x: s.x, y: s.y, z: s.z,
      // Outward: away from the tunnel interior.
      outX: (s.tangentX / hyp) * sign,
      outZ: (s.tangentZ / hyp) * sign,
    };
  };
  return {
    startIndex, endIndex, arcStart, arcEnd, length,
    portalA: portal(arcStart, -1),
    portalB: portal(arcEnd, 1),
    samples, bounds,
  };
}

// --- geometry ------------------------------------------------------------------

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

function pushQuad(target, a, b, c, d, na, nb, nc, nd) {
  const base = target.positions.length / 3;
  for (const p of [a, b, c, d]) target.positions.push(p[0], p[1], p[2]);
  for (const nrm of [na, nb, nc, nd]) target.normals.push(nrm[0], nrm[1], nrm[2]);
  target.indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
}

/** Closed bore cross-section as [px, py, nx, ny] with inward profile normals.
 * Order: left floor corner, up the left wall, over the arch, down the right
 * wall; the loop closes across the floor. */
function boreProfile(profile = TUNNEL_PROFILE, inset = 0) {
  const w = profile.halfWidth - inset;
  const floor = profile.floorY + inset * 0.5;
  const wall = profile.wallTop;
  const rise = profile.crownY - inset - wall;
  const pts = [];
  pts.push([-w, floor, 1, 0]);
  pts.push([-w, (floor + wall) * 0.5, 1, 0]);
  pts.push([-w, wall, 1, 0]);
  for (let i = 1; i < profile.archSamples; i++) {
    const theta = Math.PI - (i / profile.archSamples) * Math.PI;
    const px = Math.cos(theta) * w;
    const py = wall + Math.sin(theta) * rise;
    const inv = 1 / (Math.hypot(px, py - wall) || 1);
    pts.push([px, py, -px * inv, -(py - wall) * inv]);
  }
  pts.push([w, wall, -1, 0]);
  pts.push([w, (floor + wall) * 0.5, -1, 0]);
  pts.push([w, floor, -1, 0]);
  return pts;
}

function ringVertex(sample, px, py) {
  return [sample.x + sample.rx * px, sample.y + py, sample.z + sample.rz * px];
}

function ringNormal(sample, nx, ny) {
  return [sample.rx * nx, ny, sample.rz * nx];
}

function pushTubeSection(target, a, b, profile) {
  const count = profile.length;
  for (let k = 0; k < count; k++) {
    const p0 = profile[k], p1 = profile[(k + 1) % count];
    pushQuad(target,
      ringVertex(a, p0[0], p0[1]), ringVertex(a, p1[0], p1[1]),
      ringVertex(b, p0[0], p0[1]), ringVertex(b, p1[0], p1[1]),
      ringNormal(a, p0[2], p0[3]), ringNormal(a, p1[2], p1[3]),
      ringNormal(b, p0[2], p0[3]), ringNormal(b, p1[2], p1[3]));
  }
}

/** Arch opening outline in facade space, floor-left up over the arch to
 * floor-right — parameter-matched against the outer rectangle outline. */
function facadeLoops(facade = PORTAL_FACADE) {
  const inner = [];
  const arcN = 9;
  inner.push([-facade.openingHalfWidth, facade.openingBase]);
  inner.push([-facade.openingHalfWidth, facade.openingWallTop * 0.4]);
  inner.push([-facade.openingHalfWidth, facade.openingWallTop]);
  for (let i = 1; i < arcN; i++) {
    const theta = Math.PI - (i / arcN) * Math.PI;
    inner.push([
      Math.cos(theta) * facade.openingHalfWidth,
      facade.openingWallTop + Math.sin(theta) * (facade.openingCrown - facade.openingWallTop),
    ]);
  }
  inner.push([facade.openingHalfWidth, facade.openingWallTop]);
  inner.push([facade.openingHalfWidth, facade.openingWallTop * 0.4]);
  inner.push([facade.openingHalfWidth, facade.openingBase]);

  // Outer rectangle sampled with the same point count, corner-aligned enough
  // for masonry: left edge up, across the top, right edge down.
  const m = inner.length;
  const outer = [];
  const leftCount = Math.floor(m / 3), rightCount = leftCount;
  const topCount = m - leftCount - rightCount;
  for (let i = 0; i < leftCount; i++) {
    outer.push([-facade.outerHalfWidth,
      facade.outerBase + (facade.outerTop - facade.outerBase) * (i / (leftCount - 1 || 1))]);
  }
  for (let i = 1; i <= topCount; i++) {
    outer.push([
      -facade.outerHalfWidth + 2 * facade.outerHalfWidth * (i / (topCount + 1)),
      facade.outerTop,
    ]);
  }
  for (let i = 0; i < rightCount; i++) {
    outer.push([facade.outerHalfWidth,
      facade.outerTop - (facade.outerTop - facade.outerBase) * (i / (rightCount - 1 || 1))]);
  }
  return { inner, outer };
}

function facadeVertex(portal, rightX, rightZ, px, py, alongOut = 0) {
  return [
    portal.x + rightX * px + portal.outX * alongOut,
    portal.y + py,
    portal.z + rightZ * px + portal.outZ * alongOut,
  ];
}

function pushPortalFacade(target, portal, facade = PORTAL_FACADE) {
  const rightX = portal.outZ, rightZ = -portal.outX;
  const { inner, outer } = facadeLoops(facade);
  const faceNormal = [portal.outX, 0, portal.outZ];
  const lift = 0.15; // stand slightly proud of the terrain face
  for (let k = 0; k < inner.length - 1; k++) {
    pushQuad(target,
      facadeVertex(portal, rightX, rightZ, inner[k][0], inner[k][1], lift),
      facadeVertex(portal, rightX, rightZ, outer[k][0], outer[k][1], lift),
      facadeVertex(portal, rightX, rightZ, inner[k + 1][0], inner[k + 1][1], lift),
      facadeVertex(portal, rightX, rightZ, outer[k + 1][0], outer[k + 1][1], lift),
      faceNormal, faceNormal, faceNormal, faceNormal);
  }
  // Side and top returns run back into the hill so the terrain-cut rim can
  // never be seen around the facade edge.
  const depth = -facade.returnDepth;
  for (let k = 0; k < outer.length - 1; k++) {
    const p0 = outer[k], p1 = outer[k + 1];
    const edgeNormal = [rightX * Math.sign(p0[0] || 1), 0.35, rightZ * Math.sign(p0[0] || 1)];
    pushQuad(target,
      facadeVertex(portal, rightX, rightZ, p0[0], p0[1], lift),
      facadeVertex(portal, rightX, rightZ, p1[0], p1[1], lift),
      facadeVertex(portal, rightX, rightZ, p0[0], p0[1], depth),
      facadeVertex(portal, rightX, rightZ, p1[0], p1[1], depth),
      edgeNormal, edgeNormal, edgeNormal, edgeNormal);
  }
}

/**
 * Full geometry for one tunnel run: the interior lining tube, masonry rib
 * rings (the passing rhythm a passenger sees out the window), and the two
 * portal facades. Arrays are raw; the renderer owns materials.
 */
export function buildTunnelRunGeometry(run) {
  const lining = emptyGeometry();
  const ribs = emptyGeometry();
  const portals = emptyGeometry();
  const profile = boreProfile();
  const ribProfile = boreProfile(TUNNEL_PROFILE, RIB_INSET);

  for (let i = 0; i < run.samples.length - 1; i++) {
    pushTubeSection(lining, run.samples[i], run.samples[i + 1], profile);
  }

  // Rib rings between (not in) the collars.
  let nextRib = run.arcStart + RIB_SPACING * 0.5;
  const scratchA = {}, scratchB = {};
  while (nextRib < run.arcEnd - RIB_SPACING * 0.25) {
    const a = interpolateRunSample(run, nextRib - RIB_WIDTH * 0.5, scratchA);
    const b = interpolateRunSample(run, nextRib + RIB_WIDTH * 0.5, scratchB);
    if (a && b) pushTubeSection(ribs, a, b, ribProfile);
    nextRib += RIB_SPACING;
  }

  pushPortalFacade(portals, run.portalA);
  pushPortalFacade(portals, run.portalB);

  return {
    key: `tunnel-${run.startIndex}-${run.endIndex}`,
    lining: finalizeGeometry(lining),
    ribs: finalizeGeometry(ribs),
    portals: finalizeGeometry(portals),
  };
}

function interpolateRunSample(run, arc, out = {}) {
  const samples = run.samples;
  if (arc < samples[0].arc || arc > samples[samples.length - 1].arc) return null;
  let low = 0, high = samples.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (samples[mid].arc <= arc) low = mid;
    else high = mid;
  }
  const a = samples[low], b = samples[high];
  const t = clamp((arc - a.arc) / Math.max(1e-9, b.arc - a.arc), 0, 1);
  out.arc = arc;
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.tx = a.tx + (b.tx - a.tx) * t;
  out.tz = a.tz + (b.tz - a.tz) * t;
  const hyp = Math.hypot(out.tx, out.tz) || 1;
  out.tx /= hyp; out.tz /= hyp;
  out.rx = out.tz; out.rz = -out.tx;
  return out;
}

// --- presence / immersion -------------------------------------------------------

/**
 * How far inside a tunnel the position is, 0..1, plus the data a walking
 * environment needs (floor height, lateral frame). Factor ramps up through the
 * portal and saturates ~13m in, mirroring the cave atmosphere's depth policy.
 */
export function tunnelImmersion(runs, x, y, z, out = {}) {
  out.factor = 0;
  out.engaged = false;
  out.depth = -Infinity;
  out.floorY = 0;
  out.lateral = 0;
  out.sample = null;
  if (!runs?.length) return out;
  for (const run of runs) {
    if (x < run.bounds.minX - 30 || x > run.bounds.maxX + 30
      || z < run.bounds.minZ - 30 || z > run.bounds.maxZ + 30) continue;
    let nearest = null, best = Infinity;
    for (const sample of run.samples) {
      const d = (sample.x - x) ** 2 + (sample.z - z) ** 2;
      if (d < best) { best = d; nearest = sample; }
    }
    if (!nearest) continue;
    const horizontal = Math.sqrt(best);
    const vertical = y - nearest.y;
    if (horizontal > 5.5 || vertical < -2.5 || vertical > 6.5) continue;
    const depth = Math.min(nearest.arc - run.arcStart, run.arcEnd - nearest.arc);
    const factor = smoothstep(-2, 13, depth) * (1 - smoothstep(3.4, 5.2, horizontal));
    if (factor >= out.factor) {
      out.factor = factor;
      out.depth = depth;
      out.floorY = nearest.y;
      out.lateral = (x - nearest.x) * nearest.rx + (z - nearest.z) * nearest.rz;
      out.sample = nearest;
      out.engaged = horizontal < 3.2 && vertical > -2 && vertical < 5 && depth > -7;
    }
  }
  return out;
}

// --- terrain curtain cut ---------------------------------------------------------

/**
 * Open the bore mouth through a terrain chunk: drop triangles that either
 * cross the portal plane inside the mouth silhouette (the heightfield
 * "curtain") or sit wholly within the mouth box. The jagged rim this leaves is
 * enclosed by the portal facade and its returns. Returns a filtered index
 * array, or null when nothing near a portal was removed.
 */
export function filterTerrainIndexForPortals(positions, indices, portals, mouth = PORTAL_MOUTH) {
  if (!portals?.length) return null;
  const kept = [];
  let removed = 0;
  const ax = [0, 0, 0], ay = [0, 0, 0], al = [0, 0, 0];
  for (let t = 0; t < indices.length; t += 3) {
    let drop = false;
    for (const portal of portals) {
      const rightX = portal.outZ, rightZ = -portal.outX;
      for (let v = 0; v < 3; v++) {
        const i = indices[t + v] * 3;
        const dx = positions[i] - portal.x;
        const dz = positions[i + 2] - portal.z;
        ax[v] = dx * portal.outX + dz * portal.outZ;   // along, + = outside
        al[v] = dx * rightX + dz * rightZ;             // lateral
        ay[v] = positions[i + 1] - portal.y;           // vertical vs formation
      }
      // Edge-cross: an edge passing through the portal plane inside the mouth.
      for (let e = 0; e < 3 && !drop; e++) {
        const j = (e + 1) % 3;
        if (ax[e] * ax[j] < 0) {
          const s = ax[e] / (ax[e] - ax[j]);
          const lat = al[e] + (al[j] - al[e]) * s;
          const vy = ay[e] + (ay[j] - ay[e]) * s;
          if (Math.abs(lat) < mouth.halfWidth && vy > mouth.base && vy < mouth.top) drop = true;
        }
      }
      // Whole-triangle: centroid inside the mouth box.
      if (!drop) {
        const ca = (ax[0] + ax[1] + ax[2]) / 3;
        const cl = (al[0] + al[1] + al[2]) / 3;
        const cy = (ay[0] + ay[1] + ay[2]) / 3;
        if (Math.abs(ca) < mouth.reach && Math.abs(cl) < mouth.halfWidth
          && cy > mouth.base && cy < mouth.top) drop = true;
      }
      if (drop) break;
    }
    if (drop) removed++;
    else kept.push(indices[t], indices[t + 1], indices[t + 2]);
  }
  if (!removed) return null;
  return Uint32Array.from(kept);
}

/** Flat portal list for terrain specs: both portals of every run. */
export function collectTunnelPortals(runs) {
  const portals = [];
  for (const run of runs) {
    portals.push(run.portalA, run.portalB);
  }
  return portals;
}
