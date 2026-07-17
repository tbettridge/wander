// Phase-1 implicit cave field. The topology graph is supplied by cavegen.mjs;
// this module turns it into a sealed, queryable signed-distance volume.

export const CAVE_HALF_EXTENT = 40;
export const CAVE_DEFAULT_RESOLUTION = 48;
export const CAVE_MIN_RESOLUTION = 32;
export const CAVE_MAX_RESOLUTION = 64;

export function caveVolume(graph) {
  const min = graph?.volume?.min, max = graph?.volume?.max;
  if (Array.isArray(min) && min.length === 3 && Array.isArray(max) && max.length === 3) {
    return { min: [...min], max: [...max] };
  }
  return {
    min: [-CAVE_HALF_EXTENT, -CAVE_HALF_EXTENT, -CAVE_HALF_EXTENT],
    max: [CAVE_HALF_EXTENT, CAVE_HALF_EXTENT, CAVE_HALF_EXTENT],
  };
}

// Quality remains a world-space density choice even when topology grows well
// beyond the original 80m cube. A medium cave therefore keeps the original
// 1.67m voxel size and streams more signed chunks instead of becoming blurrier.
export function caveVoxelSize(resolution = CAVE_DEFAULT_RESOLUTION) {
  return (CAVE_HALF_EXTENT * 2) / resolution;
}

export function cavePortalInside(wasInside, localZ, mouthZ, ready = true) {
  if (wasInside) return localZ >= mouthZ - 0.55;
  return ready && localZ > mouthZ + 1.15;
}

function hashLattice(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function mulberry32Local(seed) {
  return () => {
    let t = seed += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function mix(a, b, t) { return a + (b - a) * t; }

export function caveNoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
  const x00 = mix(hashLattice(ix, iy, iz), hashLattice(ix + 1, iy, iz), fx);
  const x10 = mix(hashLattice(ix, iy + 1, iz), hashLattice(ix + 1, iy + 1, iz), fx);
  const x01 = mix(hashLattice(ix, iy, iz + 1), hashLattice(ix + 1, iy, iz + 1), fx);
  const x11 = mix(hashLattice(ix, iy + 1, iz + 1), hashLattice(ix + 1, iy + 1, iz + 1), fx);
  return mix(mix(x00, x10, fy), mix(x01, x11, fy), fz);
}

function smoothMin(a, b, k) {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return mix(b, a, h) - k * h * (1 - h);
}

function smoothMax(a, b, k) { return -smoothMin(-a, -b, k); }

// --- cross-section shape language (V4.2) --------------------------------------
// Passages are evaluated in a local frame: u = radial distance in plan (with
// the along-axis overflow folded in so endcaps stay rounded), signedU = the
// side of the corridor (for asymmetric profiles), v = height off the axis.
function ellipse2(u, v, a, b) {
  return Math.hypot(u, v * (a / Math.max(1e-6, b))) - a;
}

function box2(u, v, halfW, halfH) {
  const du = Math.abs(u) - halfW, dv = Math.abs(v) - halfH;
  return Math.hypot(Math.max(du, 0), Math.max(dv, 0)) + Math.min(Math.max(du, dv), 0);
}

function smoothstep01Local(t) {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

// Profiles express their character in the WALLS and CEILING — keyhole bulb,
// low bedding roof, towering fracture crack, leaning eroded walls — while the
// lower ~2 m blends back to the plain rounded section. The floor band is
// therefore bit-compatible with the original battle-tested envelope: floor
// continuity at junctions, chamber connectors, and capsule clearance all
// inherit V2's guarantees by construction instead of by patchwork.
function profileDistance2(signedU, v, rx, ry, passage) {
  const u = Math.abs(signedU);
  const rounded = ellipse2(u, v, rx, ry);
  let shaped;
  switch (passage.profile) {
    case 'keyhole': {
      // round bulb up top over a narrowing slot — classic phreatic-over-vadose
      const bulb = ellipse2(u, v - ry * 0.30, rx * 0.78, ry * 0.62);
      const slot = box2(u, v + ry * 0.16, rx * 0.32, ry * 0.84);
      shaped = Math.min(bulb, slot);
      break;
    }
    case 'bedding':                       // wide, low bedding-plane slot
      shaped = ellipse2(u, v + ry * 0.34, rx * 1.28, ry * 0.66);
      break;
    case 'fracture':                      // narrow, tall joint passage
      shaped = ellipse2(u, v - ry * 0.19, rx * 0.60, ry * 1.19);
      break;
    case 'eroded': {                      // asymmetric undercut channel
      const lean = passage.lean ?? 1;
      const shifted = Math.abs(signedU - (v / Math.max(1e-6, ry)) * rx * 0.30 * lean);
      shaped = ellipse2(shifted, v + ry * 0.08, rx * 1.06, ry * 0.92);
      break;
    }
    default:
      return rounded;
  }
  const wallBlend = smoothstep01Local((v + ry) / 2.2);
  return rounded + (shaped - rounded) * wallBlend;
}

function passageDistance(x, y, z, passage, forCollision = false) {
  const [ax, ay, az] = passage.a, [bx, by, bz] = passage.b;
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = x - ax, apy = y - ay, apz = z - az;
  const denom = abx * abx + aby * aby + abz * abz;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / denom));
  const dx = x - (ax + abx * t), dy = y - (ay + aby * t), dz = z - (az + abz * t);
  const rx0 = passage.rxA ?? passage.rx0 ?? passage.taper?.fromRx ?? passage.rx;
  const rx1 = passage.rxB ?? passage.rx1 ?? passage.taper?.toRx ?? passage.rx;
  const ry0 = passage.ryA ?? passage.ry0 ?? passage.taper?.fromRy ?? passage.ry;
  const ry1 = passage.ryB ?? passage.ry1 ?? passage.taper?.toRy ?? passage.ry;
  const rx = mix(rx0, rx1, t), ry = mix(ry0, ry1, t);
  const u = Math.hypot(dx, dz);
  let distance;
  if (!passage.profile || passage.profile === 'rounded') {
    // identical to the legacy formula — entrance-adjacent and helix-connector
    // edges rely on this exact envelope
    distance = ellipse2(u, dy, rx, ry);
  } else {
    const lateral = passage.perp ? dx * passage.perp[0] + dz * passage.perp[1] : u;
    const signedU = lateral >= 0 ? u : -u;
    distance = profileDistance2(signedU, dy, rx, ry, passage);
  }
  if (passage.channel && !forCollision) {
    // Grotto stream rill: pure decor carved below the walking surface. The
    // collision field skips it entirely — the capsule walks the rim plane
    // (which is where the Phase-5 water surface will sit), while the render
    // field keeps the groove. It fades at endpoints so junction floors and
    // chamber shelf blends stay clean.
    const endFade = Math.min(1, Math.min(t, 1 - t) * 4);
    distance = smoothMin(distance, Math.hypot(u * 1.6, (dy + ry) * 2.2) - 0.62 + (1 - endFade) * 1.4, 0.35);
  }
  if (passage.bumps) {
    for (const bump of passage.bumps) {
      const bumpDistance = Math.hypot(x - bump.x, (y - bump.y) / 0.62, z - bump.z) - bump.r;
      distance = smoothMax(distance, -bumpDistance, 0.5);
    }
  }
  return distance;
}

// Capsule from the entrance node through the mouth and outward forever.  Only
// the outer end is open; the inner end remains rounded and smooth-unions into
// n0.  This is what turns the formerly sealed implicit volume into a walkable
// portal without adding a representation that could drift from worker meshes.
function entranceDistance(x, y, z, entrance) {
  const [ax, ay, az] = entrance.a, [bx, by, bz] = entrance.b;
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = x - ax, apy = y - ay, apz = z - az;
  const denom = abx * abx + aby * aby + abz * abz;
  const t = Math.max(0, (apx * abx + apy * aby + apz * abz) / denom);
  const dx = x - (ax + abx * t), dy = y - (ay + aby * t), dz = z - (az + abz * t);
  const verticalScale = entrance.rx / entrance.ry;
  return Math.hypot(dx, dy * verticalScale, dz) - entrance.rx;
}

function ellipsoidDistance(x, y, z, chamber) {
  const [cx, cy, cz] = chamber.c, [rx, ry, rz] = chamber.r;
  const yaw = chamber.yaw || 0, cos = Math.cos(yaw), sin = Math.sin(yaw);
  const worldX = x - cx, worldZ = z - cz;
  let px = cos * worldX - sin * worldZ;
  let py = y - cy;
  const pz = sin * worldX + cos * worldZ;
  if (chamber.tilt) {
    // fault form: the whole room shears — the roofline tips along the local
    // x axis while the floor shelf below stays a level, walkable plane
    const tiltCos = Math.cos(chamber.tilt), tiltSin = Math.sin(chamber.tilt);
    const tiltedX = tiltCos * px - tiltSin * py;
    py = tiltSin * px + tiltCos * py;
    px = tiltedX;
  }
  const k0 = Math.hypot(px / rx, py / ry, pz / rz);
  const k1 = Math.hypot(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
  let distance = k1 > 1e-8 ? k0 * (k0 - 1) / k1 : -Math.min(rx, ry, rz);
  // Larger Phase-2 rooms use a shallow rock shelf as their floor instead of
  // the lower half of a deep ellipsoid. It produces a broad navigable room
  // while leaving the ceiling domed and irregular.
  if (Number.isFinite(chamber.floorY)) {
    distance = smoothMax(distance, chamber.floorY - y, chamber.floorBlend ?? 0.52);
  }
  // forms that leave rock standing inside the room — all positioned off the
  // chamber's through-axis so the guaranteed route stays open
  if (chamber.mound) {
    const moundDistance = Math.hypot(x - chamber.mound.x, (y - chamber.mound.y) / 0.55, z - chamber.mound.z) - chamber.mound.r;
    distance = smoothMax(distance, -moundDistance, 0.55);
  }
  if (chamber.slab) {
    const side = (x - cx) * chamber.slab.px + (z - cz) * chamber.slab.pz;
    const slabDistance = Math.max(chamber.slab.offset - side, y - chamber.slab.top);
    distance = smoothMax(distance, -slabDistance, 0.6);
  }
  if (chamber.columns) {
    for (const column of chamber.columns) {
      const columnDistance = Math.hypot(x - column.x, z - column.z) - column.r;
      distance = smoothMax(distance, -columnDistance, 0.5);
    }
  }
  return distance;
}

function passageBounds(passage) {
  const rx = Math.max(
    passage.rxA ?? passage.rx0 ?? passage.taper?.fromRx ?? passage.rx,
    passage.rxB ?? passage.rx1 ?? passage.taper?.toRx ?? passage.rx,
  );
  const ry = Math.max(
    passage.ryA ?? passage.ry0 ?? passage.taper?.fromRy ?? passage.ry,
    passage.ryB ?? passage.ry1 ?? passage.taper?.toRy ?? passage.ry,
  );
  return {
    minX: Math.min(passage.a[0], passage.b[0]) - rx,
    maxX: Math.max(passage.a[0], passage.b[0]) + rx,
    minY: Math.min(passage.a[1], passage.b[1]) - ry,
    maxY: Math.max(passage.a[1], passage.b[1]) + ry,
    minZ: Math.min(passage.a[2], passage.b[2]) - rx,
    maxZ: Math.max(passage.a[2], passage.b[2]) + rx,
  };
}

function chamberBounds(chamber) {
  const yaw = chamber.yaw || 0, cos = Math.cos(yaw), sin = Math.sin(yaw);
  const xRadius = Math.hypot(chamber.r[0] * cos, chamber.r[2] * sin);
  const zRadius = Math.hypot(chamber.r[0] * sin, chamber.r[2] * cos);
  return {
    minX: chamber.c[0] - xRadius, maxX: chamber.c[0] + xRadius,
    minY: Math.min(chamber.c[1] - chamber.r[1], chamber.floorY ?? Infinity),
    maxY: chamber.c[1] + chamber.r[1],
    minZ: chamber.c[2] - zRadius, maxZ: chamber.c[2] + zRadius,
  };
}

function expandedBounds(bounds, amount) {
  return {
    minX: bounds.minX - amount, maxX: bounds.maxX + amount,
    minY: bounds.minY - amount, maxY: bounds.maxY + amount,
    minZ: bounds.minZ - amount, maxZ: bounds.maxZ + amount,
  };
}

export function createCaveField(graph) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const passages = graph.edges.map((edge) => ({
    ...edge,
    a: [...nodeById.get(edge.a).p],
    b: [...nodeById.get(edge.b).p],
  }));
  const chambers = graph.chambers.map((chamber) => ({
    ...chamber,
    c: [...chamber.c],
    r: [...chamber.r],
  }));
  const entrance = graph.entrance ? {
    ...graph.entrance,
    a: [...nodeById.get(graph.entrance.rootNodeId).p],
    b: [...graph.entrance.mouth],
  } : null;

  // Deterministic shape-language params derived once from the graph: the
  // lateral axis of every passage (asymmetric profiles), breakdown boulder
  // positions, and chamber form geometry — all in cave-local world space.
  passages.forEach((passage) => {
    const dirX = passage.b[0] - passage.a[0], dirZ = passage.b[2] - passage.a[2];
    const horizontal = Math.hypot(dirX, dirZ) || 1;
    passage.perp = [-dirZ / horizontal, dirX / horizontal];
  });
  const allSegments = passages.map((passage) => [passage.a, passage.b]);
  const clearanceToRoutes = (x, z) => {
    let best = Infinity;
    for (const [a, b] of allSegments) {
      const abx = b[0] - a[0], abz = b[2] - a[2];
      const denom = abx * abx + abz * abz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * abx + (z - a[2]) * abz) / denom));
      best = Math.min(best, Math.hypot(x - (a[0] + abx * t), z - (a[2] + abz * t)));
    }
    return best;
  };
  passages.forEach((passage, index) => {
    if (passage.breakdown > 0) {
      const rng = mulberry32Local((((graph.seed >>> 0) ^ Math.imul(index + 1, 2654435761)) >>> 0));
      const maxRx = Math.max(passage.rxA ?? passage.rx, passage.rxB ?? passage.rx);
      const maxRy = Math.max(passage.ryA ?? passage.ry, passage.ryB ?? passage.ry);
      passage.bumps = [];
      for (let i = 0; i < passage.breakdown; i++) {
        const t = 0.25 + rng() * 0.5;
        const side = rng() < 0.5 ? -1 : 1;
        const offset = maxRx * 0.62;
        const x = passage.a[0] + (passage.b[0] - passage.a[0]) * t + passage.perp[0] * side * offset;
        const z = passage.a[2] + (passage.b[2] - passage.a[2]) * t + passage.perp[1] * side * offset;
        // the pile must clear EVERY route corridor — its own axis offset is
        // not enough near junctions where a neighbouring passage sweeps past
        const radius = Math.min(0.55 + rng() * 0.5, clearanceToRoutes(x, z) - 2.0);
        if (radius < 0.35) continue;
        passage.bumps.push({
          x,
          y: passage.a[1] + (passage.b[1] - passage.a[1]) * t - maxRy + 0.1,
          z,
          r: radius,
        });
      }
    }
  });
  // Rock features inside rooms must clear EVERY incident corridor, not just a
  // mean through-axis — a junction chamber has exits in three directions and
  // fitting deforms them further. Features shrink against the closest incident
  // passage segment and vanish entirely when no safe size remains.
  const incidentByNode = new Map();
  for (const edge of graph.edges) {
    const a = nodeById.get(edge.a)?.p, b = nodeById.get(edge.b)?.p;
    if (!a || !b) continue;
    for (const nodeId of [edge.a, edge.b]) {
      if (!incidentByNode.has(nodeId)) incidentByNode.set(nodeId, []);
      incidentByNode.get(nodeId).push([a, b]);
    }
  }
  const routeClearance2 = (x, z, segments) => {
    let best = Infinity;
    for (const [a, b] of segments) {
      const abx = b[0] - a[0], abz = b[2] - a[2];
      const denom = abx * abx + abz * abz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * abx + (z - a[2]) * abz) / denom));
      best = Math.min(best, Math.hypot(x - (a[0] + abx * t), z - (a[2] + abz * t)));
    }
    return best;
  };
  chambers.forEach((chamber, index) => {
    const rng = mulberry32Local((chamber.formSeed ?? (((graph.seed >>> 0) ^ Math.imul(index + 41, 968953)) >>> 0)) >>> 0);
    const minRadius = Math.min(chamber.r[0], chamber.r[2]);
    const perpYaw = (chamber.throughYaw ?? 0) + Math.PI / 2;
    const perpX = Math.sin(perpYaw), perpZ = Math.cos(perpYaw);
    const floorY = Number.isFinite(chamber.floorY) ? chamber.floorY : chamber.c[1] - chamber.r[1];
    const incident = incidentByNode.get(chamber.nodeId) || [];
    if (chamber.form === 'fault') {
      // gentler in smaller rooms: the dip must never swing a wall into an
      // exit throat (rng consumed regardless so streams stay aligned)
      const tiltRoll = rng();
      if (minRadius >= 7) chamber.tilt = 0.07 + tiltRoll * 0.05;
    } else if (chamber.form === 'bowl') {
      const side = rng() < 0.5 ? -1 : 1;
      const offset = minRadius * 0.55;
      const x = chamber.c[0] + perpX * side * offset;
      const z = chamber.c[2] + perpZ * side * offset;
      const radius = Math.min(
        minRadius * (0.28 + rng() * 0.10),
        routeClearance2(x, z, incident) - 2.1,
      );
      if (radius >= 0.6) chamber.mound = { x, y: floorY, z, r: radius };
    } else if (chamber.form === 'shelf') {
      const side = rng() < 0.5 ? -1 : 1;
      const px = perpX * side, pz = perpZ * side;
      // the slab may only start beyond every incident corridor's reach into
      // this half of the room
      let maxSide = 0;
      const horizontalReach = Math.max(chamber.r[0], chamber.r[2]) + 1;
      for (const [a, b] of incident) {
        for (let step = 0; step <= 8; step++) {
          const t = step / 8;
          const x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t;
          if (Math.hypot(x - chamber.c[0], z - chamber.c[2]) > horizontalReach) continue;
          maxSide = Math.max(maxSide, (x - chamber.c[0]) * px + (z - chamber.c[2]) * pz);
        }
      }
      const offset = Math.max(2.4, minRadius * 0.34, maxSide + 2.2);
      if (offset <= minRadius * 0.8) {
        chamber.slab = { px, pz, offset, top: floorY + 1.4 + rng() * 0.5 };
      }
    } else if (chamber.form === 'columned') {
      const count = 2 + Math.floor(rng() * 3);
      chamber.columns = [];
      for (let i = 0; i < count; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const angle = perpYaw + (side < 0 ? Math.PI : 0) + (rng() - 0.5) * 0.8;
        const ring = Math.max(minRadius * (0.50 + rng() * 0.15), 3.0);
        const x = chamber.c[0] + Math.sin(angle) * ring;
        const z = chamber.c[2] + Math.cos(angle) * ring;
        const radius = Math.min(0.5 + rng() * 0.4, routeClearance2(x, z, incident) - 2.1);
        if (radius < 0.35) continue;
        chamber.columns.push({ x, z, r: radius });
      }
      if (!chamber.columns.length) delete chamber.columns;
    }
  });
  const noiseOffset = {
    x: ((graph.seed >>> 0) & 1023) * 0.037,
    y: ((graph.seed >>> 10) & 1023) * 0.041,
    z: ((graph.seed >>> 20) & 1023) * 0.043,
  };
  const archetypeNoise = {
    gallery: { broadScale: 0.105, verticalScale: 0.135, broadAmplitude: 0.92, toothScale: 0.26, toothAmplitude: 0.22 },
    branching: { broadScale: 0.118, verticalScale: 0.148, broadAmplitude: 1.08, toothScale: 0.30, toothAmplitude: 0.28 },
    circuit: { broadScale: 0.11, verticalScale: 0.142, broadAmplitude: 1.0, toothScale: 0.275, toothAmplitude: 0.25 },
    descent: { broadScale: 0.098, verticalScale: 0.128, broadAmplitude: 0.86, toothScale: 0.245, toothAmplitude: 0.19 },
  };
  // Geology overrides the topology defaults: lava and ice tubes are almost
  // machine-smooth, boulder caves are all tooth, limestone gets horizontal
  // bedding stripes that read as strata ledges on the walls.
  const geologyNoise = {
    limestone: { beddingAmplitude: 0.13, beddingScale: 1.55 },
    cathedral: { broadAmplitude: 1.02, toothAmplitude: 0.20, beddingAmplitude: 0.10, beddingScale: 1.2 },
    boulder: { toothAmplitude: 0.44, toothScale: 0.335, broadAmplitude: 1.12 },
    grotto: { broadAmplitude: 0.95, toothAmplitude: 0.24 },
    fracture: { verticalScale: 0.105, broadAmplitude: 1.16, toothAmplitude: 0.30 },
    ice: { broadAmplitude: 0.42, toothAmplitude: 0.07 },
    volcanic: { broadScale: 0.085, broadAmplitude: 0.50, toothAmplitude: 0.06 },
  };
  const noise = {
    beddingAmplitude: 0,
    beddingScale: 1.5,
    ...(archetypeNoise[graph.archetype] || {
      broadScale: 0.115, verticalScale: 0.145, broadAmplitude: 1.05,
      toothScale: 0.285, toothAmplitude: 0.28,
    }),
    ...(geologyNoise[graph.geology] || {}),
    ...(graph.noise || {}),
  };

  const noiseAt = (x, y, z) => {
    const broad = caveNoise3(
      x * noise.broadScale + noiseOffset.x,
      y * noise.verticalScale + noiseOffset.y,
      z * noise.broadScale + noiseOffset.z,
    ) - 0.5;
    const tooth = caveNoise3(
      x * noise.toothScale - noiseOffset.z,
      y * (noise.toothScale * 1.16) + noiseOffset.x,
      z * noise.toothScale - noiseOffset.y,
    ) - 0.5;
    let value = broad * noise.broadAmplitude + tooth * noise.toothAmplitude;
    if (noise.beddingAmplitude > 0) {
      value += Math.sin(y * noise.beddingScale + noiseOffset.y * 9.7) * noise.beddingAmplitude * 0.5;
    }
    return value;
  };

  const composeSdf = (selectedPassages, selectedChambers, includeEntrance = true) => (x, y, z) => {
    let distance = 1e6;
    if (includeEntrance && entrance) distance = smoothMin(distance, entranceDistance(x, y, z, entrance), 1.25);
    for (const passage of selectedPassages) distance = smoothMin(distance, passageDistance(x, y, z, passage), passage.blend ?? 1.35);
    for (const chamber of selectedChambers) distance = smoothMin(distance, ellipsoidDistance(x, y, z, chamber), chamber.blend ?? 1.65);
    return distance + noiseAt(x, y, z);
  };

  // Negative is navigable cave air; positive is surrounding rock. The scalar
  // sign makes the addon's lighting normals face inward into the void.
  const sdfFull = composeSdf(passages, chambers, true);

  // A long cave may contain dozens of primitives, but only a handful can
  // influence a point near a given wall. Populate deterministic spatial bins
  // with conservatively expanded primitive bounds. Candidate order remains
  // entrance -> edge order -> chamber order, preserving smooth-union behavior.
  const binSize = graph.spatialBinSize || 24;
  const influence = 4.5;
  const primitiveRecords = [];
  if (entrance) {
    const entrancePassage = { ...entrance, rx0: entrance.rx, rx1: entrance.rx, ry0: entrance.ry, ry1: entrance.ry };
    const bounds = passageBounds({
      ...entrancePassage,
      a: [entrance.b[0], entrance.b[1], Math.min(-CAVE_HALF_EXTENT, entrance.b[2] - 4)],
      b: entrance.a,
    });
    primitiveRecords.push({ kind: 'entrance', value: entrance, bounds: expandedBounds(bounds, influence) });
  }
  passages.forEach((passage) => primitiveRecords.push({
    kind: 'passage', value: passage, bounds: expandedBounds(passageBounds(passage), influence),
  }));
  chambers.forEach((chamber) => primitiveRecords.push({
    kind: 'chamber', value: chamber, bounds: expandedBounds(chamberBounds(chamber), influence),
  }));
  const spatialBins = new Map();
  const binKey = (ix, iy, iz) => `${ix},${iy},${iz}`;
  primitiveRecords.forEach((record, primitiveIndex) => {
    const b = record.bounds;
    for (let iz = Math.floor(b.minZ / binSize); iz <= Math.floor(b.maxZ / binSize); iz++) {
      for (let iy = Math.floor(b.minY / binSize); iy <= Math.floor(b.maxY / binSize); iy++) {
        for (let ix = Math.floor(b.minX / binSize); ix <= Math.floor(b.maxX / binSize); ix++) {
          const key = binKey(ix, iy, iz);
          const list = spatialBins.get(key);
          if (list) list.push(primitiveIndex);
          else spatialBins.set(key, [primitiveIndex]);
        }
      }
    }
  });
  const evaluateCandidates = (candidates, x, y, z, forCollision = false) => {
    let distance = 1e6;
    if (candidates) {
      for (const primitiveIndex of candidates) {
        const record = primitiveRecords[primitiveIndex];
        if (record.kind === 'entrance') {
          distance = smoothMin(distance, entranceDistance(x, y, z, record.value), 1.25);
        } else if (record.kind === 'passage') {
          distance = smoothMin(distance, passageDistance(x, y, z, record.value, forCollision), record.value.blend ?? 1.35);
        } else {
          distance = smoothMin(distance, ellipsoidDistance(x, y, z, record.value), record.value.blend ?? 1.65);
        }
      }
    }
    // The collision field feels HALF the surface noise. Geometry (profiles,
    // cores, forms, bumps) is identical in both fields — only the stochastic
    // skin calms down, so V4.2's tighter cross-sections can never lose the
    // guaranteed corridor to a noise spike. In first person the ≤~0.35 m
    // divergence against chunky painterly rock is imperceptible; a blocked
    // route is not.
    const noiseValue = noiseAt(x, y, z);
    return distance + (forCollision ? noiseValue * 0.5 : noiseValue);
  };
  const sdf = (x, y, z) => evaluateCandidates(spatialBins.get(binKey(
    Math.floor(x / binSize), Math.floor(y / binSize), Math.floor(z / binSize),
  )), x, y, z);
  // Collision variant: identical rock, minus sub-floor decor (stream rills).
  // The capsule keeps walking the rim plane instead of tracking every groove.
  const sdfWalk = (x, y, z) => evaluateCandidates(spatialBins.get(binKey(
    Math.floor(x / binSize), Math.floor(y / binSize), Math.floor(z / binSize),
  )), x, y, z, true);

  // A chunk asks for a bounds-local evaluator, but shared-face samples must
  // use the identical point-local candidate set on both sides of a seam.
  // The spatially accelerated global evaluator provides that invariant.
  const sdfForBounds = () => sdf;

  // The natural entrance and collision transition only need the first inward
  // beat. Keeping a canonical local subset prevents a 150m graph from making
  // the approved Phase-1 lip proportionally more expensive to evaluate.
  const entranceLimitZ = (entrance?.b?.[2] ?? -36) + 25;
  const entrancePassages = passages.filter((passage) => Math.min(passage.a[2], passage.b[2]) <= entranceLimitZ);
  const entranceChambers = chambers.filter((chamber) => chamber.c[2] - Math.max(chamber.r[0], chamber.r[2]) <= entranceLimitZ);
  const entranceSdf = composeSdf(entrancePassages, entranceChambers, true);

  const volume = caveVolume(graph);
  let floorMin = Infinity, floorMax = -Infinity;
  const includeVertical = (center, radius) => {
    floorMin = Math.min(floorMin, center - radius - 2.5);
    floorMax = Math.max(floorMax, center + radius + 2.5);
  };
  if (entrance) {
    includeVertical(entrance.a[1], entrance.ry);
    includeVertical(entrance.b[1], entrance.ry);
  }
  for (const passage of passages) {
    const ryA = passage.ryA ?? passage.ry0 ?? passage.taper?.fromRy ?? passage.ry;
    const ryB = passage.ryB ?? passage.ry1 ?? passage.taper?.toRy ?? passage.ry;
    includeVertical(passage.a[1], Math.max(ryA, ryB));
    includeVertical(passage.b[1], Math.max(ryA, ryB));
  }
  for (const chamber of chambers) {
    floorMin = Math.min(floorMin, (Number.isFinite(chamber.floorY) ? chamber.floorY : chamber.c[1] - chamber.r[1]) - 2.5);
    floorMax = Math.max(floorMax, chamber.c[1] + chamber.r[1] + 2.5);
  }
  if (!Number.isFinite(floorMin + floorMax)) { floorMin = volume.min[1]; floorMax = volume.max[1]; }
  const floorBounds = {
    min: Math.min(floorMin, volume.min[1]),
    max: Math.max(floorMax, volume.max[1]),
  };

  const floorCrossings = (
    x,
    z,
    bottom = floorBounds.min,
    top = floorBounds.max,
    steps = Math.max(24, Math.ceil((top - bottom) / 0.28)),
    out = [],
  ) => {
    out.length = 0;
    let lastY = bottom, lastD = sdfWalk(x, lastY, z);
    for (let i = 1; i <= steps; i++) {
      const y = mix(bottom, top, i / steps), d = sdfWalk(x, y, z);
      if (lastD >= 0 && d < 0) {
        let lo = lastY, hi = y;
        for (let j = 0; j < 10; j++) {
          const mid = (lo + hi) * 0.5;
          if (sdfWalk(x, mid, z) >= 0) lo = mid;
          else hi = mid;
        }
        out.push(hi + 0.08);
      }
      lastY = y;
      lastD = d;
    }
    return out;
  };

  const crossingScratch = [];
  const floorHeight = (x, z) => floorCrossings(x, z, floorBounds.min, floorBounds.max, undefined, crossingScratch)[0] ?? null;

  // Select the floor that belongs to the player's current level instead of
  // always snapping to the lowest projected passage.  A generous first-call
  // range supports chamber floors while subsequent movement stays local.
  const floorHeightNear = (x, z, referenceY = null, maxStep = 0.48, maxDrop = 1.0) => {
    const localBottom = Number.isFinite(referenceY)
      ? Math.max(floorBounds.min, referenceY - maxDrop - 1.35)
      : floorBounds.min;
    const localTop = Number.isFinite(referenceY)
      ? Math.min(floorBounds.max, referenceY + maxStep + 1.55)
      : floorBounds.max;
    const crossings = floorCrossings(
      x,
      z,
      localBottom,
      localTop,
      Math.max(20, Math.ceil((localTop - localBottom) / 0.16)),
      [],
    );
    if (crossings.length === 0) return null;
    if (!Number.isFinite(referenceY)) return crossings[0];
    let best = null, bestDistance = Infinity;
    for (const floor of crossings) {
      const delta = floor - referenceY;
      if (delta > maxStep || delta < -maxDrop) continue;
      const distance = Math.abs(delta);
      if (distance < bestDistance) { best = floor; bestDistance = distance; }
    }
    return best;
  };

  const bodyFits = (x, z, floorY = floorHeight(x, z), radius = 0.30, height = 1.72, skin = 0.035) => {
    if (floorY === null) return false;
    const offsets = [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]];
    const levels = [0.34, Math.max(0.86, height * 0.55), height];
    for (const [ox, oz] of offsets) {
      for (const level of levels) if (sdfWalk(x + ox, floorY + level, z + oz) >= -skin) return false;
    }
    return true;
  };

  // Swept horizontal collision with short substeps and axis retries.  Axis
  // retries provide a stable, inexpensive wall slide for the walking speeds in
  // this project while the substeps prevent sprint tunnelling after frame
  // stalls.  Returned distance is the only distance controls should count.
  const resolveHorizontal = (fromX, fromZ, toX, toZ, referenceY, options = {}) => {
    const maxSubstep = options.maxSubstep ?? 0.22;
    const radius = options.radius ?? 0.30;
    const height = options.height ?? 1.72;
    const skin = options.skin ?? 0.035;
    const maxStep = options.maxStep ?? 0.48;
    const maxDrop = options.maxDrop ?? 1.0;
    const dx = toX - fromX, dz = toZ - fromZ;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / maxSubstep));
    const sx = dx / steps, sz = dz / steps;
    let x = fromX, z = fromZ, floorY = referenceY;
    let acceptedDistance = 0, blocked = false;
    const tryPoint = (nx, nz) => {
      const nextFloor = floorHeightNear(nx, nz, floorY, maxStep, maxDrop);
      if (nextFloor === null || !bodyFits(nx, nz, nextFloor, radius, height, skin)) return false;
      acceptedDistance += Math.hypot(nx - x, nz - z);
      x = nx; z = nz; floorY = nextFloor;
      return true;
    };
    for (let i = 0; i < steps; i++) {
      const startX = x, startZ = z;
      if (tryPoint(startX + sx, startZ + sz)) continue;
      blocked = true;
      // Prefer the larger component first, then try the other component from
      // the accepted partial position.  This avoids sticky diagonal contacts.
      if (Math.abs(sx) >= Math.abs(sz)) {
        tryPoint(startX + sx, startZ);
        tryPoint(x, z + sz);
      } else {
        tryPoint(startX, startZ + sz);
        tryPoint(x + sx, z);
      }
    }
    return { x, z, floorY, acceptedDistance, blocked };
  };

  const hashField = (resolution = CAVE_DEFAULT_RESOLUTION) => {
    let hash = 2166136261;
    for (let z = 0; z < resolution; z++) {
      const pz = mix(volume.min[2], volume.max[2], (z + 0.5) / resolution);
      for (let y = 0; y < resolution; y++) {
        const py = mix(volume.min[1], volume.max[1], (y + 0.5) / resolution);
        for (let x = 0; x < resolution; x++) {
          const px = mix(volume.min[0], volume.max[0], (x + 0.5) / resolution);
          hash = Math.imul(hash ^ Math.round(sdf(px, py, pz) * 2048), 16777619);
        }
      }
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  };

  return {
    graph,
    passages,
    chambers,
    entrance,
    entranceSdf,
    entrancePassages,
    entranceChambers,
    volume,
    floorBounds,
    noise,
    sdfFull,
    sdfForBounds,
    spatialBins,
    spawnLocal: { ...graph.spawnLocal },
    sdf,
    sdfWalk,
    floorHeight,
    floorHeightNear,
    bodyFits,
    resolveHorizontal,
    hashField,
  };
}
