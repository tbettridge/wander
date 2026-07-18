// Deterministic shallow cave-water planning. Hydrology follows sampled cave
// floors and never participates in collision: it is a visual/auditory layer
// over already-walkable passages, ready for deeper water gameplay later.

export const CAVE_HYDROLOGY_PROFILES = Object.freeze({
  limestone: Object.freeze({ abundance: 0.42, pools: 0.34, color: [0.090, 0.255, 0.255], deep: [0.018, 0.080, 0.095] }),
  cathedral: Object.freeze({ abundance: 0.34, pools: 0.28, color: [0.095, 0.235, 0.290], deep: [0.018, 0.065, 0.100] }),
  boulder: Object.freeze({ abundance: 0.18, pools: 0.12, color: [0.105, 0.190, 0.155], deep: [0.035, 0.065, 0.055] }),
  grotto: Object.freeze({ abundance: 1.00, pools: 0.88, color: [0.070, 0.330, 0.340], deep: [0.010, 0.095, 0.115] }),
  fracture: Object.freeze({ abundance: 0.26, pools: 0.16, color: [0.080, 0.215, 0.300], deep: [0.014, 0.055, 0.105] }),
  ice: Object.freeze({ abundance: 0.48, pools: 0.42, color: [0.290, 0.590, 0.720], deep: [0.055, 0.165, 0.265], frozen: true }),
  volcanic: Object.freeze({ abundance: 0.05, pools: 0.02, color: [0.210, 0.090, 0.035], deep: [0.055, 0.020, 0.014] }),
});

function hash32(value) {
  let h = value >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
function roll(seed, salt) { return hash32((seed >>> 0) ^ Math.imul(salt + 1, 0x9e3779b1)) / 4294967296; }
function mix(a, b, t) { return a + (b - a) * t; }

export function caveHydrologyProfile(geology = 'limestone') {
  return CAVE_HYDROLOGY_PROFILES[geology] || CAVE_HYDROLOGY_PROFILES.limestone;
}

function sampledFloor(field, x, z, guess, radius = 5) {
  return field.floorHeightNear?.(x, z, guess, radius, radius) ?? field.floorHeight?.(x, z) ?? null;
}

function sampledCeiling(field, x, z, floor, maxHeight = 24) {
  let insideY = floor + 0.35;
  if ((field.sdf?.(x, insideY, z) ?? 1) >= 0) return null;
  let outsideY = null;
  for (let y = insideY + 0.5; y <= floor + maxHeight; y += 0.5) {
    if ((field.sdf?.(x, y, z) ?? 1) >= 0) { outsideY = y; break; }
    insideY = y;
  }
  if (outsideY === null) return null;
  for (let step = 0; step < 8; step++) {
    const mid = (insideY + outsideY) * 0.5;
    if (field.sdf(x, mid, z) < 0) insideY = mid;
    else outsideY = mid;
  }
  return (insideY + outsideY) * 0.5;
}

function refreshStreamMetadata(stream) {
  const points = stream.points;
  let distance = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) distance += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    const before = points[Math.max(0, i - 1)], after = points[Math.min(points.length - 1, i + 1)];
    const dx = after.x - before.x, dz = after.z - before.z;
    const length = Math.max(1e-6, Math.hypot(dx, dz));
    points[i].flowDistance = distance;
    points[i].fx = dx / length;
    points[i].fz = dz / length;
  }
  stream.cascades = [];
  for (let i = 1; i < points.length; i++) {
    const drop = points[i - 1].y - points[i].y;
    if (drop > 0.16) stream.cascades.push({ from: i - 1, to: i, drop });
  }
}

function recomputeStreamSurface(stream, startMinimum = -Infinity, endMinimum = -Infinity) {
  const points = stream.points;
  // Work back from the outlet. Every point remains just above its sampled
  // bed and the water surface never rises in the downstream direction.
  for (let i = points.length - 1; i >= 0; i--) {
    points[i].y = Math.max(
      points[i].floorY + 0.032,
      i === points.length - 1 ? endMinimum : -Infinity,
      i < points.length - 1 ? points[i + 1].y : -Infinity,
    );
  }
  points[0].y = Math.max(points[0].y, startMinimum);
  refreshStreamMetadata(stream);
}

function streamForPassage(passage, field, index, seed) {
  const length = Math.hypot(
    passage.b[0] - passage.a[0], passage.b[1] - passage.a[1], passage.b[2] - passage.a[2],
  );
  const count = Math.max(3, Math.ceil(length / 1.35) + 1);
  const halfWidth = Math.max(0.22, Math.min(0.56, (passage.rx || 3.5) * (0.075 + roll(seed, index) * 0.025)));
  const perp = passage.perp || [0, 1];
  const phase = roll(seed, index + 170) * Math.PI * 2;
  const points = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const meander = Math.sin(t * Math.PI * 2.0 + phase) * Math.sin(t * Math.PI)
      * halfWidth * 0.48;
    const x = mix(passage.a[0], passage.b[0], t) + perp[0] * meander;
    const z = mix(passage.a[2], passage.b[2], t) + perp[1] * meander;
    const ry = mix(passage.ryA || passage.ry || 3.5, passage.ryB || passage.ry || 3.5, t);
    const guess = mix(passage.a[1], passage.b[1], t) - ry * 0.78;
    const y = sampledFloor(field, x, z, guess, Math.max(3.5, ry + 1));
    if (y === null) continue;
    const breathingWidth = halfWidth * (0.88 + Math.sin(t * Math.PI * 3 + phase) * 0.12);
    points.push({
      x, y: y + 0.032, floorY: y, z,
      halfWidth: breathingWidth, px: perp[0], pz: perp[1],
    });
  }
  if (points.length < 3) return null;
  // Store every rill in its physical flow direction. The hydraulic surface is
  // the least non-rising envelope that remains above every sampled floor: a
  // downstream rise creates a shallow ponded reach instead of forcing the
  // mesh underground (the old source of visible floor clipping).
  let fromNode = passage.aNode ?? `${passage.id}:a`;
  let toNode = passage.bNode ?? `${passage.id}:b`;
  if (points[0].floorY < points[points.length - 1].floorY) {
    points.reverse();
    [fromNode, toNode] = [toNode, fromNode];
  }
  const stream = { id: passage.id, fromNode, toNode, points, cascades: [] };
  recomputeStreamSurface(stream);
  return stream;
}

function poolForChamber(chamber, field, index, seed, frozen = false) {
  const floor = sampledFloor(field, chamber.c[0], chamber.c[2], chamber.floorY ?? chamber.c[1] - chamber.r[1], chamber.r[1] + 2);
  if (floor === null) return null;
  const y = floor + (frozen ? 0.055 : 0.075);
  const segments = 28;
  const maxRadius = Math.max(1.2, Math.min(chamber.r[0], chamber.r[2]) * (0.27 + roll(seed, index + 91) * 0.17));
  const points = [];
  for (let i = 0; i < segments; i++) {
    const angle = i / segments * Math.PI * 2;
    let lo = 0.55, hi = maxRadius;
    for (let step = 0; step < 7; step++) {
      const radius = (lo + hi) * 0.5;
      const x = chamber.c[0] + Math.cos(angle) * radius;
      const z = chamber.c[2] + Math.sin(angle) * radius;
      const radialFloor = sampledFloor(field, x, z, floor, 3.2);
      const inside = (field.sdf?.(x, y, z) ?? -1) < -0.20;
      // Keep the shoreline slightly above its sampled bed. Allowing the bed
      // to rise through the water plane was the pool equivalent of the old
      // stream clipping regression.
      if (radialFloor !== null && radialFloor <= y - 0.008 && inside) lo = radius;
      else hi = radius;
    }
    const wobble = 0.92 + roll(seed, index * 37 + i) * 0.14;
    points.push({
      x: chamber.c[0] + Math.cos(angle) * lo * wobble,
      y,
      z: chamber.c[2] + Math.sin(angle) * lo * wobble,
    });
  }
  return { id: chamber.id, center: { x: chamber.c[0], y, z: chamber.c[2] }, points, frozen };
}

export function buildCaveHydrologyPlan(graph, field) {
  const profile = caveHydrologyProfile(graph?.geology);
  const seed = graph?.seed >>> 0;
  const streams = [];
  const passages = field?.passages || [];
  for (let i = 0; i < passages.length; i++) {
    const passage = passages[i];
    if (!passage.channel) continue;
    const stream = streamForPassage(passage, field, i, seed);
    if (stream) streams.push(stream);
  }
  const endpointGroups = new Map();
  for (const stream of streams) {
    for (const endpoint of [
      { nodeId: stream.fromNode, stream, index: 0 },
      { nodeId: stream.toNode, stream, index: stream.points.length - 1 },
    ]) {
      if (!endpointGroups.has(endpoint.nodeId)) endpointGroups.set(endpoint.nodeId, []);
      endpointGroups.get(endpoint.nodeId).push(endpoint);
    }
  }
  const junctionGroups = [...endpointGroups].filter(([, endpoints]) => endpoints.length >= 2);
  const junctionLevels = new Map(junctionGroups.map(([nodeId, endpoints]) => [
    nodeId,
    Math.max(...endpoints.map(({ stream, index }) => stream.points[index].floorY + 0.032)),
  ]));
  // Propagate only the height needed to preserve downstream gravity. This is
  // a tiny max-constraint solve over the channel graph: shared endpoints weld
  // exactly, but unrelated reaches retain their own slope instead of being
  // flattened to one network-wide plane.
  for (let pass = 0; pass < streams.length + 2; pass++) {
    for (const stream of streams) recomputeStreamSurface(
      stream,
      junctionLevels.get(stream.fromNode) ?? -Infinity,
      junctionLevels.get(stream.toNode) ?? -Infinity,
    );
    let changed = false;
    for (const [nodeId, endpoints] of junctionGroups) {
      const level = Math.max(...endpoints.map(({ stream, index }) => stream.points[index].y));
      if (level > junctionLevels.get(nodeId) + 1e-9) {
        junctionLevels.set(nodeId, level);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const stream of streams) recomputeStreamSurface(
    stream,
    junctionLevels.get(stream.fromNode) ?? -Infinity,
    junctionLevels.get(stream.toNode) ?? -Infinity,
  );
  const junctions = junctionGroups.map(([nodeId, endpoints]) => {
    const anchor = endpoints[0].stream.points[endpoints[0].index];
    const radius = Math.max(...endpoints.map(({ stream, index }) => stream.points[index].halfWidth * 1.12));
    return {
      nodeId, x: anchor.x, y: junctionLevels.get(nodeId), z: anchor.z,
      radius: Math.max(0.34, radius),
    };
  });
  const mouth = graph?.entrance?.mouth || [0, 0, -1000];
  const chambers = field?.chambers || graph?.chambers || [];
  const candidates = chambers
    .map((chamber, index) => ({ chamber, index }))
    .filter(({ chamber }) => Math.hypot(
      chamber.c[0] - mouth[0], chamber.c[1] - mouth[1], chamber.c[2] - mouth[2],
    ) > 28)
    .sort((a, b) => (a.chamber.floorY ?? a.chamber.c[1]) - (b.chamber.floorY ?? b.chamber.c[1]));
  const pools = [];
  for (const { chamber, index } of candidates) {
    const lowBias = 1 - pools.length / Math.max(1, candidates.length);
    const chance = profile.pools * (0.52 + lowBias * 0.48);
    if (roll(seed, index + 400) > chance) continue;
    const pool = poolForChamber(chamber, field, index, seed, !!profile.frozen);
    if (pool) pools.push(pool);
    const maxPools = graph?.geology === 'grotto' ? 3 : 2;
    if (pools.length >= maxPools) break;
  }
  // A grotto must deliver on its name even if all deterministic rolls miss.
  if (graph?.geology === 'grotto' && !pools.length && candidates.length) {
    const { chamber, index } = candidates[0];
    const pool = poolForChamber(chamber, field, index, seed, false);
    if (pool) pools.push(pool);
  }

  const drips = [];
  for (let index = 0; index < chambers.length; index++) {
    const chamber = chambers[index];
    const count = Math.floor(profile.abundance * 2.2 + roll(seed, index + 610) * 1.8);
    for (let drop = 0; drop < count; drop++) {
      const angle = roll(seed, index * 17 + drop + 620) * Math.PI * 2;
      const radial = (0.12 + roll(seed, index * 23 + drop + 650) * 0.30)
        * Math.min(chamber.r[0], chamber.r[2]);
      const x = chamber.c[0] + Math.cos(angle) * radial;
      const z = chamber.c[2] + Math.sin(angle) * radial;
      const floor = sampledFloor(field, x, z, chamber.floorY ?? chamber.c[1] - chamber.r[1], chamber.r[1] + 2);
      if (floor === null) continue;
      const ceiling = sampledCeiling(field, x, z, floor, chamber.r[1] * 2.4 + 4);
      if (ceiling === null || ceiling - floor < 2.6) continue;
      const depth = Math.hypot(x - mouth[0], chamber.c[1] - mouth[1], z - mouth[2]);
      drips.push({
        x, z, top: ceiling - 0.05, bottom: floor + 0.12,
        phase: roll(seed, index * 29 + drop + 700),
        rate: 0.30 + roll(seed, index * 31 + drop + 730) * 0.38,
        weather: Math.max(0, Math.min(1, 1 - (depth - 24) / 46)),
      });
    }
  }

  const waterfalls = [];
  for (let index = 0; index < chambers.length; index++) {
    const chamber = chambers[index];
    if (!chamber.slab || roll(seed, index + 820) > profile.abundance * 0.19) continue;
    const slab = chamber.slab;
    const x = chamber.c[0] + slab.px * Math.max(0.5, slab.offset - 0.22);
    const z = chamber.c[2] + slab.pz * Math.max(0.5, slab.offset - 0.22);
    const floor = sampledFloor(field, x, z, chamber.floorY ?? chamber.c[1] - chamber.r[1], chamber.r[1] + 2);
    const top = slab.top + 0.04;
    if (floor === null || top - floor < 0.65) continue;
    const mid = (top + floor) * 0.5;
    if ((field.sdf?.(x, mid, z) ?? 1) >= 0) continue;
    waterfalls.push({
      id: `${chamber.id}:fall`, x, z, top, bottom: floor + 0.05,
      px: -slab.pz, pz: slab.px,
      halfWidth: 0.28 + roll(seed, index + 860) * 0.25,
      rare: top - floor > 1.8,
    });
  }
  const mist = [];
  const mistSources = [
    ...waterfalls.map((fall) => ({ x: fall.x, y: fall.bottom, z: fall.z, strength: 1 })),
    ...pools.filter((_, index) => profile.abundance > 0.55 && index < 2)
      .map((pool) => ({ ...pool.center, strength: 0.45 })),
  ];
  for (let sourceIndex = 0; sourceIndex < mistSources.length; sourceIndex++) {
    const source = mistSources[sourceIndex];
    const count = source.strength > 0.8 ? 7 : 3;
    for (let i = 0; i < count; i++) {
      const angle = roll(seed, sourceIndex * 19 + i + 910) * Math.PI * 2;
      const radius = roll(seed, sourceIndex * 23 + i + 940) * (source.strength > 0.8 ? 0.7 : 1.2);
      mist.push({
        x: source.x + Math.cos(angle) * radius,
        y: source.y + 0.06,
        z: source.z + Math.sin(angle) * radius,
        phase: roll(seed, sourceIndex * 29 + i + 970),
        rise: (0.35 + roll(seed, sourceIndex * 31 + i + 1000) * 0.55) * source.strength,
        strength: source.strength,
      });
    }
  }

  const samplePoints = [
    ...streams.flatMap((stream) => stream.points.filter((_, index) => index % 4 === 0)),
    ...pools.map((pool) => pool.center),
    ...waterfalls.map((fall) => ({ x: fall.x, y: fall.bottom, z: fall.z })),
  ];
  return { geology: graph?.geology || 'limestone', profile, streams, junctions, pools, drips, waterfalls, mist, samplePoints };
}

export function caveWaterProximity(plan, local, range = 16) {
  if (!plan || !local) return 0;
  let nearest = Infinity;
  for (const point of plan.samplePoints || []) {
    nearest = Math.min(nearest, Math.hypot(local.x - point.x, local.y - point.y, local.z - point.z));
  }
  if (!Number.isFinite(nearest)) return 0;
  const t = Math.max(0, Math.min(1, 1 - nearest / range));
  return t * t * (3 - 2 * t);
}
