// Pure planar rock construction. A box-like convex volume is clipped by seeded
// planes, retaining large polygonal faces until final triangulation.

export const ROCK_ARCHETYPES = [
  'block', 'wedge', 'slab', 'shoulder',
  'angular', 'monolith', 'split', 'weathered',
];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normal(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function box(hx, hy, hz) {
  const p = (x, y, z) => [x, y, z];
  return [
    [p(-hx, -hy, -hz), p(-hx, -hy, hz), p(-hx, hy, hz), p(-hx, hy, -hz)],
    [p(hx, -hy, -hz), p(hx, hy, -hz), p(hx, hy, hz), p(hx, -hy, hz)],
    [p(-hx, -hy, -hz), p(hx, -hy, -hz), p(hx, -hy, hz), p(-hx, -hy, hz)],
    [p(-hx, hy, -hz), p(-hx, hy, hz), p(hx, hy, hz), p(hx, hy, -hz)],
    [p(-hx, -hy, -hz), p(-hx, hy, -hz), p(hx, hy, -hz), p(hx, -hy, -hz)],
    [p(-hx, -hy, hz), p(hx, -hy, hz), p(hx, hy, hz), p(-hx, hy, hz)],
  ];
}

function clipFaces(faces, planeNormal, offset) {
  const keptFaces = [];
  const capPoints = [];
  const epsilon = 1e-6;
  for (const face of faces) {
    const clipped = [];
    for (let i = 0; i < face.length; i++) {
      const current = face[i], next = face[(i + 1) % face.length];
      const dc = dot(planeNormal, current) - offset;
      const dn = dot(planeNormal, next) - offset;
      const currentInside = dc <= epsilon, nextInside = dn <= epsilon;
      if (currentInside) clipped.push(current);
      if (currentInside !== nextInside) {
        const t = dc / (dc - dn);
        const point = [
          current[0] + (next[0] - current[0]) * t,
          current[1] + (next[1] - current[1]) * t,
          current[2] + (next[2] - current[2]) * t,
        ];
        clipped.push(point);
        capPoints.push(point);
      }
    }
    if (clipped.length >= 3) keptFaces.push(clipped);
  }

  const unique = [];
  for (const point of capPoints) {
    if (!unique.some((other) => Math.hypot(
      point[0] - other[0], point[1] - other[1], point[2] - other[2],
    ) < 1e-5)) unique.push(point);
  }
  if (unique.length >= 3) {
    const center = unique.reduce((sum, point) => [
      sum[0] + point[0], sum[1] + point[1], sum[2] + point[2],
    ], [0, 0, 0]).map((value) => value / unique.length);
    const axis = Math.abs(planeNormal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normal(cross(axis, planeNormal));
    const v = cross(planeNormal, u);
    unique.sort((a, b) => {
      const da = sub(a, center), db = sub(b, center);
      return Math.atan2(dot(da, v), dot(da, u)) - Math.atan2(dot(db, v), dot(db, u));
    });
    keptFaces.push(unique);
  }
  return keptFaces;
}

function sliceCorner(faces, planeNormal, depth) {
  let minimum = Infinity, maximum = -Infinity;
  for (const face of faces) for (const point of face) {
    const distance = dot(planeNormal, point);
    minimum = Math.min(minimum, distance);
    maximum = Math.max(maximum, distance);
  }
  return clipFaces(faces, planeNormal, maximum - (maximum - minimum) * depth);
}

function pointKey(point) {
  return point.map((value) => Math.round(value * 1e6)).join(',');
}

function orientOutward(face) {
  if (face.length < 3) return face;
  const faceNormal = cross(sub(face[1], face[0]), sub(face[2], face[0]));
  const center = face.reduce((sum, point) => [
    sum[0] + point[0], sum[1] + point[1], sum[2] + point[2],
  ], [0, 0, 0]).map((value) => value / face.length);
  return dot(faceNormal, center) >= 0 ? face : [...face].reverse();
}

// Inset each original polygon, bridge adjacent inset edges with a narrow quad,
// and cap each former corner. This is a real chamfer rather than smooth shading:
// broad planes remain planar while only their outer few percent soften.
function bevelFaces(faces, amount) {
  const insetFaces = [];
  const edges = new Map();
  const vertices = new Map();
  for (const face of faces) {
    const center = face.reduce((sum, point) => [
      sum[0] + point[0], sum[1] + point[1], sum[2] + point[2],
    ], [0, 0, 0]).map((value) => value / face.length);
    const inset = face.map((point) => [
      point[0] + (center[0] - point[0]) * amount,
      point[1] + (center[1] - point[1]) * amount,
      point[2] + (center[2] - point[2]) * amount,
    ]);
    insetFaces.push(inset);
    for (let i = 0; i < face.length; i++) {
      const next = (i + 1) % face.length;
      const a = pointKey(face[i]), b = pointKey(face[next]);
      const edgeKey = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!edges.has(edgeKey)) edges.set(edgeKey, []);
      edges.get(edgeKey).push({ insetA: inset[i], insetB: inset[next] });
      if (!vertices.has(a)) vertices.set(a, { source: face[i], points: [] });
      vertices.get(a).points.push(inset[i]);
    }
  }

  const bevels = [];
  for (const records of edges.values()) {
    if (records.length !== 2) continue;
    bevels.push(orientOutward([
      records[0].insetA,
      records[0].insetB,
      records[1].insetA,
      records[1].insetB,
    ]));
  }
  for (const { source, points } of vertices.values()) {
    if (points.length < 3) continue;
    const center = points.reduce((sum, point) => [
      sum[0] + point[0], sum[1] + point[1], sum[2] + point[2],
    ], [0, 0, 0]).map((value) => value / points.length);
    const axisNormal = normal(source);
    const reference = Math.abs(axisNormal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normal(cross(reference, axisNormal));
    const v = cross(axisNormal, u);
    points.sort((a, b) => {
      const da = sub(a, center), db = sub(b, center);
      return Math.atan2(dot(da, v), dot(da, u)) - Math.atan2(dot(db, v), dot(db, u));
    });
    bevels.push(orientOutward(points));
  }
  return [...insetFaces, ...bevels];
}

function triangulate(faces) {
  const positions = [], normals = [], faceSizes = [];
  for (const face of faces) {
    const faceNormal = normal(cross(sub(face[1], face[0]), sub(face[2], face[0])));
    const firstTriangle = positions.length / 9;
    for (let i = 1; i < face.length - 1; i++) {
      for (const point of [face[0], face[i], face[i + 1]]) {
        positions.push(point[0], point[1], point[2]);
        normals.push(faceNormal[0], faceNormal[1], faceNormal[2]);
      }
    }
    faceSizes.push({ triangle: firstTriangle, count: face.length - 2 });
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    faceSizes,
  };
}

export function makePlanarRockMesh(rng, archetype = 'block', boulder = false) {
  let hx = 0.82 + rng() * 0.24;
  let hy = 0.66 + rng() * 0.20;
  let hz = 0.78 + rng() * 0.28;
  if (archetype === 'slab') { hx *= 1.18; hy *= 0.55; hz *= 1.22; }
  else if (archetype === 'monolith') { hx *= 0.70; hy *= 1.48; hz *= 0.72; }
  else if (archetype === 'wedge') { hx *= 1.12; hz *= 1.08; }
  else if (archetype === 'shoulder') { hx *= 1.18; hy *= 1.08; }
  else if (archetype === 'split') { hz *= 1.18; }
  if (boulder) { hx *= 1.08; hy *= 0.96; hz *= 1.08; }

  let faces = box(hx, hy, hz);
  const topLeanX = (rng() - 0.5) * (archetype === 'wedge' ? 0.95 : 0.34);
  const topLeanZ = (rng() - 0.5) * (archetype === 'wedge' ? 0.70 : 0.34);
  faces = sliceCorner(
    faces,
    normal([topLeanX, 1, topLeanZ]),
    archetype === 'slab' ? 0.08 + rng() * 0.06 : 0.13 + rng() * 0.09,
  );

  const cuts = archetype === 'angular' || archetype === 'split' ? 7
    : archetype === 'weathered' ? 6 : 4 + (rng() * 2 | 0);
  for (let i = 0; i < cuts; i++) {
    const sx = rng() < 0.5 ? -1 : 1;
    const sy = rng() < (archetype === 'slab' ? 0.72 : 0.52) ? 1 : -1;
    const sz = rng() < 0.5 ? -1 : 1;
    const vertical = archetype === 'shoulder' ? 0.25 + rng() * 0.45 : 0.45 + rng() * 0.75;
    const planeNormal = normal([
      sx * (0.65 + rng() * 0.55), sy * vertical, sz * (0.65 + rng() * 0.55),
    ]);
    const baseDepth = archetype === 'weathered' ? 0.07 : archetype === 'angular' ? 0.16 : 0.10;
    faces = sliceCorner(faces, planeNormal, baseDepth + rng() * 0.09);
  }
  const bevel = archetype === 'angular' || archetype === 'split' ? 0.035
    : archetype === 'weathered' ? 0.060 : 0.047;
  faces = bevelFaces(faces, bevel);
  return triangulate(faces);
}
