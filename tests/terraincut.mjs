import assert from 'node:assert/strict';
import {
  DEFAULT_CAVE_CUT,
  buildTerrainCutPatch,
  caveCutContainsLocal,
  caveCutContainsWorld,
  caveCutFrame,
  caveCutHalfWidth,
  caveCutProfile,
  splitQuadValue,
} from '../src/terraincut.mjs';

const EPSILON = 2e-6;

function near(actual, expected, message, tolerance = EPSILON) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, received ${actual}`,
  );
}

function makeTerrainFixture() {
  const res = 4;
  const chunkSize = 4;
  const n = res + 1;
  const positions = [];
  const normals = [];
  const colors = [];
  const sourceIndices = [];

  for (let z = 0; z <= res; z++) {
    for (let x = 0; x <= res; x++) {
      const height = x * 0.31 + z * 0.17 + ((x + z) % 2) * 0.23;
      positions.push(x, height, z);
      normals.push(0, 1, 0);
      colors.push(0.12 + x * 0.07, 0.24 + z * 0.06, 0.36 + (x + z) * 0.025);
    }
  }

  for (let z = 0; z < res; z++) {
    for (let x = 0; x < res; x++) {
      const a = z * n + x;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      sourceIndices.push(a, c, b, b, c, d);
    }
  }

  const collarWeightAt = (x, z) => {
    if (x <= 1 || x >= 3 || z <= 1 || z >= 3) return 0;
    return Math.min(1, (x - 1) * 2, (3 - x) * 2, (z - 1) * 2, (3 - z) * 2);
  };
  const sampleProcedural = (x, z) => ({
    height: 8 + Math.sin(x * 0.7) + Math.cos(z * 0.4),
    normal: [0.21, 0.95, -0.23],
    color: [0.82, 0.73, 0.61],
  });

  return {
    res,
    chunkSize,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    sourceIndices: new Uint32Array(sourceIndices),
    collarWeightAt,
    sampleProcedural,
  };
}

function buildPatch(fixture, cutValueAt = () => 1, targetSpacing = 0.5) {
  return buildTerrainCutPatch({
    ...fixture,
    cx: 0,
    cz: 0,
    cutValueAt,
    targetSpacing,
  });
}

function coarseSample(fixture, x, z, componentArray) {
  const step = fixture.chunkSize / fixture.res;
  const cellX = Math.min(fixture.res - 1, Math.max(0, Math.floor(x / step)));
  const cellZ = Math.min(fixture.res - 1, Math.max(0, Math.floor(z / step)));
  const fx = x / step - cellX;
  const fz = z / step - cellZ;
  const n = fixture.res + 1;
  const a = cellZ * n + cellX;
  const b = a + 1;
  const c = a + n;
  const d = c + 1;
  const read = (index) => componentArray[index * 3 + 1];
  return splitQuadValue(read(a), read(b), read(c), read(d), fx, fz);
}

function coarseColor(fixture, x, z, channel) {
  const step = fixture.chunkSize / fixture.res;
  const cellX = Math.min(fixture.res - 1, Math.max(0, Math.floor(x / step)));
  const cellZ = Math.min(fixture.res - 1, Math.max(0, Math.floor(z / step)));
  const fx = x / step - cellX;
  const fz = z / step - cellZ;
  const n = fixture.res + 1;
  const a = cellZ * n + cellX;
  const b = a + 1;
  const c = a + n;
  const d = c + 1;
  const read = (index) => fixture.colors[index * 3 + channel];
  return splitQuadValue(read(a), read(b), read(c), read(d), fx, fz);
}

function validateIndexedMesh(mesh, label) {
  assert.equal(mesh.positions.length % 3, 0, `${label} position attribute is malformed`);
  assert.equal(mesh.normals.length, mesh.positions.length, `${label} normal attribute mismatch`);
  assert.equal(mesh.colors.length, mesh.positions.length, `${label} color attribute mismatch`);
  assert.equal(mesh.indices.length % 3, 0, `${label} index buffer is not triangular`);
  const vertexCount = mesh.positions.length / 3;
  for (const index of mesh.indices) {
    assert.ok(Number.isInteger(index) && index >= 0 && index < vertexCount, `${label} has invalid index ${index}`);
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ia = mesh.indices[i] * 3;
    const ib = mesh.indices[i + 1] * 3;
    const ic = mesh.indices[i + 2] * 3;
    const ax = mesh.positions[ia], ay = mesh.positions[ia + 1], az = mesh.positions[ia + 2];
    const ux = mesh.positions[ib] - ax, uy = mesh.positions[ib + 1] - ay, uz = mesh.positions[ib + 2] - az;
    const vx = mesh.positions[ic] - ax, vy = mesh.positions[ic + 1] - ay, vz = mesh.positions[ic + 2] - az;
    const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    assert.ok(area2 > 1e-8, `${label} contains a degenerate triangle`);
  }
}

function edgeUseCounts(mesh) {
  const counts = new Map();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    for (const [a, b] of [[mesh.indices[i], mesh.indices[i + 1]], [mesh.indices[i + 1], mesh.indices[i + 2]], [mesh.indices[i + 2], mesh.indices[i]]]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

const fixture = makeTerrainFixture();
const uncut = buildPatch(fixture);
const rebuilt = buildPatch(fixture);

assert.deepEqual(uncut.keptIndices, rebuilt.keptIndices, 'kept terrain indices are not deterministic');
assert.deepEqual(uncut.collar.positions, rebuilt.collar.positions, 'collar positions are not deterministic');
assert.deepEqual(uncut.collar.normals, rebuilt.collar.normals, 'collar normals are not deterministic');
assert.deepEqual(uncut.collar.colors, rebuilt.collar.colors, 'collar colors are not deterministic');
assert.deepEqual(uncut.collar.indices, rebuilt.collar.indices, 'collar indices are not deterministic');
assert.equal(uncut.keptIndices.length, 12 * 6, 'the four supported cells were not replaced exactly');
assert.equal(uncut.replacedCells, 4, 'replacement count does not match the selected cells');
validateIndexedMesh(uncut.collar, 'uncut collar');

// Four independently tessellated cells should weld into one 5x5 vertex grid.
assert.equal(uncut.collar.positions.length / 3, 25, 'adjacent replacement cells did not share vertices');
assert.equal(uncut.collar.indices.length, 32 * 3, 'unexpected replacement triangle count');
const positionKeys = new Set();
const vertexByXZ = new Map();
for (let i = 0; i < uncut.collar.positions.length; i += 3) {
  const x = uncut.collar.positions[i];
  const y = uncut.collar.positions[i + 1];
  const z = uncut.collar.positions[i + 2];
  const xyzKey = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
  assert.ok(!positionKeys.has(xyzKey), `duplicate welded vertex at ${xyzKey}`);
  positionKeys.add(xyzKey);
  vertexByXZ.set(`${x.toFixed(2)},${z.toFixed(2)}`, i / 3);
}

const seamEdges = edgeUseCounts(uncut.collar);
for (const axis of ['x', 'z']) {
  for (let segment = 0; segment < 4; segment++) {
    const lo = 1 + segment * 0.5;
    const hi = lo + 0.5;
    const aKey = axis === 'x' ? `2.00,${lo.toFixed(2)}` : `${lo.toFixed(2)},2.00`;
    const bKey = axis === 'x' ? `2.00,${hi.toFixed(2)}` : `${hi.toFixed(2)},2.00`;
    const a = vertexByXZ.get(aKey), b = vertexByXZ.get(bKey);
    assert.notEqual(a, undefined, `missing ${axis}-seam vertex ${aKey}`);
    assert.notEqual(b, undefined, `missing ${axis}-seam vertex ${bKey}`);
    const edgeKey = a < b ? `${a}:${b}` : `${b}:${a}`;
    assert.equal(seamEdges.get(edgeKey), 2, `${axis}-seam edge ${aKey}/${bKey} is not shared exactly twice`);
  }
}

// At weight zero, every dense perimeter point must lie on the original coarse
// triangle and preserve its attributes, even though the interior is displaced.
let perimeterVertices = 0;
for (let i = 0; i < uncut.collar.positions.length; i += 3) {
  const x = uncut.collar.positions[i];
  const y = uncut.collar.positions[i + 1];
  const z = uncut.collar.positions[i + 2];
  if (x !== 1 && x !== 3 && z !== 1 && z !== 3) continue;
  perimeterVertices++;
  near(y, coarseSample(fixture, x, z, fixture.positions), `perimeter height at ${x},${z}`);
  near(uncut.collar.normals[i], 0, `perimeter nx at ${x},${z}`);
  near(uncut.collar.normals[i + 1], 1, `perimeter ny at ${x},${z}`);
  near(uncut.collar.normals[i + 2], 0, `perimeter nz at ${x},${z}`);
  for (let channel = 0; channel < 3; channel++) {
    near(uncut.collar.colors[i + channel], coarseColor(fixture, x, z, channel), `perimeter color ${channel} at ${x},${z}`);
  }
}
assert.equal(perimeterVertices, 16, 'the dense collar perimeter is incomplete');

// A varying collar weight changes the final height even when both endpoint
// normals are vertical. The generated normal must include that weight gradient
// instead of merely blending the endpoint normals.
{
  const res = 1, chunkSize = 2;
  const blendFixture = {
    res,
    chunkSize,
    positions: new Float32Array([
      0, 0, 0, 2, 0, 0,
      0, 0, 2, 2, 0, 2,
    ]),
    normals: new Float32Array([
      0, 1, 0, 0, 1, 0,
      0, 1, 0, 0, 1, 0,
    ]),
    colors: new Float32Array([
      0.2, 0.3, 0.4, 0.2, 0.3, 0.4,
      0.2, 0.3, 0.4, 0.2, 0.3, 0.4,
    ]),
    sourceIndices: new Uint32Array([0, 2, 1, 1, 2, 3]),
    collarWeightAt: (x, z) => Math.max(0, 1 - Math.abs(x - 1)) * Math.max(0, 1 - Math.abs(z - 1)),
    sampleProcedural: () => ({ height: 2, normal: [0, 1, 0], color: [0.5, 0.6, 0.7] }),
  };
  const blended = buildPatch(blendFixture, () => 1, 0.25);
  validateIndexedMesh(blended.collar, 'weight-gradient collar');
  let target = -1;
  for (let i = 0; i < blended.collar.positions.length; i += 3) {
    if (Math.abs(blended.collar.positions[i] - 0.5) < EPSILON
      && Math.abs(blended.collar.positions[i + 2] - 1) < EPSILON) {
      target = i;
      break;
    }
  }
  assert.notEqual(target, -1, 'weight-gradient normal sample is missing');
  const expectedLength = Math.hypot(2, 1);
  near(blended.collar.normals[target], -2 / expectedLength, 'weight-gradient nx', 2e-5);
  near(blended.collar.normals[target + 1], 1 / expectedLength, 'weight-gradient ny', 2e-5);
  near(blended.collar.normals[target + 2], 0, 'weight-gradient nz', 2e-5);
}

// Skirt rejection is vertex-based, not centroid-based. Both affected skirt
// triangles below have centroids outside the tiny support/cut regions, while a
// single endpoint lies inside. A distant control triangle remains intact.
{
  const base = makeTerrainFixture();
  const positions = Array.from(base.positions);
  const normals = Array.from(base.normals);
  const colors = Array.from(base.colors);
  const addVertex = (x, y, z) => {
    const index = positions.length / 3;
    positions.push(x, y, z);
    normals.push(0, 1, 0);
    colors.push(0.2, 0.3, 0.4);
    return index;
  };
  const supportTop = addVertex(0, 0, 0);
  const supportBottom = addVertex(0, -5, 0);
  const supportFarBottom = addVertex(4, -5, 0);
  const supportFarTop = addVertex(4, 0, 0);
  const cutTop = addVertex(4, 0, 4);
  const cutBottom = addVertex(4, -5, 4);
  const cutFarBottom = addVertex(0, -5, 4);
  const safeA = addVertex(3, 0, 3);
  const safeB = addVertex(3, -5, 3);
  const safeC = addVertex(3.5, -5, 3.5);
  const sourceIndices = new Uint32Array([
    ...base.sourceIndices,
    supportTop, supportBottom, supportFarBottom,
    supportTop, supportFarBottom, supportFarTop,
    cutTop, cutBottom, cutFarBottom,
    safeA, safeB, safeC,
  ]);
  const collarWeightAt = (x, z) => (x < 0.05 && z < 0.05 ? 1 : 0);
  const cutValueAt = (x, z) => (x > 3.95 && z > 3.95 ? -1 : 1);
  const skirted = buildPatch({
    ...base,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    sourceIndices,
    collarWeightAt,
  }, cutValueAt);
  const retainedSkirt = Array.from(skirted.keptIndices).slice(-3);
  assert.deepEqual(retainedSkirt, [safeA, safeB, safeC], 'safe skirt control triangle was not retained');
  const retained = new Set(skirted.keptIndices);
  for (const rejected of [supportTop, supportBottom, supportFarBottom, supportFarTop, cutTop, cutBottom, cutFarBottom]) {
    assert.ok(!retained.has(rejected), `entrance-intersecting skirt vertex ${rejected} leaked into kept indices`);
  }
}

// A linear strip gives an exact clipping oracle: every emitted vertex must be
// outside or on the interpolated aperture boundary.
const stripCut = (x) => Math.abs(x - 2) - 0.4;
const clipped = buildPatch(fixture, stripCut, 0.25);
validateIndexedMesh(clipped.collar, 'clipped collar');
let boundaryVertices = 0;
for (let i = 0; i < clipped.collar.positions.length; i += 3) {
  const value = stripCut(clipped.collar.positions[i], clipped.collar.positions[i + 2]);
  assert.ok(value >= -2e-6, `clipping retained an inside vertex (cut=${value})`);
  if (Math.abs(value) <= 2e-6) boundaryVertices++;
}
assert.ok(boundaryVertices >= 4, 'clipping emitted no explicit aperture boundary');
assert.ok(clipped.collar.indices.length < 4 * 4 * 4 * 2 * 3, 'clipping did not remove any microtriangles');

// A curved signed field needs root refinement along each clipped micro-edge;
// simple interpolation of endpoint values does not land on its true boundary.
const curvedCut = (x) => (x - 2) ** 2 - 0.173;
const curved = buildPatch(fixture, curvedCut, 0.25);
let curvedBoundaryVertices = 0;
for (let i = 0; i < curved.collar.positions.length; i += 3) {
  const residual = Math.abs(curvedCut(curved.collar.positions[i]));
  if (residual <= 2e-5) curvedBoundaryVertices++;
}
assert.ok(curvedBoundaryVertices >= 4, 'curved aperture vertices were not refined onto the shared field');

// The fallback footprint remains available before a canonical signed field is
// attached, including normalized orientation and per-anchor profile overrides.
assert.deepEqual(caveCutProfile(), DEFAULT_CAVE_CUT, 'default fallback profile changed unexpectedly');
const overridden = { cut: { minAlong: -6, maxAlong: 2.5, middleHalfWidth: 3.1 } };
assert.equal(caveCutProfile(overridden).minAlong, -6, 'profile minAlong override was ignored');
assert.equal(caveCutProfile(overridden).outerHalfWidth, DEFAULT_CAVE_CUT.outerHalfWidth, 'profile defaults were not merged');
near(caveCutHalfWidth(DEFAULT_CAVE_CUT.minAlong), DEFAULT_CAVE_CUT.outerHalfWidth, 'outer fallback width');
near(caveCutHalfWidth(DEFAULT_CAVE_CUT.maxAlong), DEFAULT_CAVE_CUT.innerHalfWidth, 'inner fallback width');

const fallbackSpec = { x: 10, z: 20, inwardX: 0, inwardZ: 5 };
assert.deepEqual(caveCutFrame(11.25, 18, fallbackSpec), { along: -2, side: 1.25 }, 'fallback frame orientation is wrong');
assert.ok(caveCutContainsLocal(0, -1, fallbackSpec), 'local fallback rejected its centerline');
assert.ok(caveCutContainsWorld(10.5, 19, fallbackSpec), 'world fallback rejected a valid point');
assert.ok(!caveCutContainsWorld(14, 19, fallbackSpec), 'world fallback accepted a point beyond its width');
assert.ok(!caveCutContainsWorld(10, 30, fallbackSpec), 'world fallback accepted a point beyond its along range');

const canonicalSpec = { ...fallbackSpec, cutValueAt: () => -1 };
assert.ok(caveCutContainsWorld(100, 100, canonicalSpec), 'canonical signed field was not used at zero inset');
assert.ok(!caveCutContainsWorld(100, 100, canonicalSpec, 0.1), 'inset query did not fall back to the bounded profile');

console.log(`terraincut PASS · ${uncut.collar.positions.length / 3} welded verts · ${boundaryVertices} cut-boundary verts · exact perimeter`);
