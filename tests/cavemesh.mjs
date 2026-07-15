import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { caveAnchorsAround, generateCaveGraph } from '../src/cavegen.mjs';
import { CAVE_HALF_EXTENT, createCaveField } from '../src/cavefield.mjs';
import {
  CAVE_CHUNK_CELLS,
  caveChunkBounds,
  caveChunkCoordinatesAt,
  caveChunkKey,
  caveChunkWorldSize,
  caveVoxelSize,
  createCaveChunkPlan,
  meshCaveChunk,
  meshImplicitBox,
} from '../src/cavemesh.mjs';

function hashFloats(array) {
  let hash = 2166136261;
  for (let i = 0; i < array.length; i++) hash = Math.imul(hash ^ Math.round(array[i] * 100000), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function hashIntegers(array) {
  let hash = 2166136261;
  for (let i = 0; i < array.length; i++) hash = Math.imul(hash ^ array[i], 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function smoothMinimum(a, b, radius) {
  const h = clamp(0.5 + 0.5 * (b - a) / radius, 0, 1);
  return b + (a - b) * h - radius * h * (1 - h);
}

const graph = generateCaveGraph(123);
const field = createCaveField(graph);
const plans = createCaveChunkPlan(graph, 48);
assert.ok(plans.length > 0, 'generated graph produced no sparse chunks');
assert.deepEqual(plans, createCaveChunkPlan(graph, 48), 'sparse plan is not deterministic');
assert.equal(caveVoxelSize(48), 80 / 48, 'medium quality changed voxel density');
assert.equal(caveChunkWorldSize(48), CAVE_CHUNK_CELLS * 80 / 48, 'medium chunk size changed');
for (const plan of plans) {
  assert.equal(plan.cellSize, 80 / 48, `${plan.key} changed voxel density`);
  assert.equal(plan.chunkSize, CAVE_CHUNK_CELLS * 80 / 48, `${plan.key} changed chunk size`);
  assert.deepEqual(plan.bounds, caveChunkBounds(48, plan.ix, plan.iy, plan.iz), `${plan.key} has noncanonical bounds`);
}
const entrancePlans = plans.filter((plan) => plan.entrance);
assert.ok(entrancePlans.length > 0, 'sparse plan omitted the entrance throat');
assert.ok(entrancePlans.some((plan) => plan.iz === 0), 'entrance plan does not reach the open -Z boundary');
assert.ok(entrancePlans.every((plan) => plan.bounds.minZ >= -CAVE_HALF_EXTENT),
  'infinite entrance ray leaked into chunks outside the approved -40m boundary');

for (const resolution of [32, 48, 64]) {
  const expectedVoxelSize = 80 / resolution;
  const qualityPlans = createCaveChunkPlan(graph, resolution);
  assert.ok(qualityPlans.length > 0, `quality ${resolution} produced no plans`);
  assert.ok(qualityPlans.every((plan) => plan.cellSize === expectedVoxelSize),
    `quality ${resolution} did not keep fixed voxel density`);
  const sample = qualityPlans[Math.floor(qualityPlans.length / 2)];
  const center = {
    x: (sample.bounds.minX + sample.bounds.maxX) * 0.5,
    y: (sample.bounds.minY + sample.bounds.maxY) * 0.5,
    z: (sample.bounds.minZ + sample.bounds.maxZ) * 0.5,
  };
  assert.deepEqual(
    caveChunkCoordinatesAt(resolution, center.x, center.y, center.z),
    { ix: sample.ix, iy: sample.iy, iz: sample.iz },
    `quality ${resolution} coordinate lookup disagrees with planning`,
  );
}

// A deliberately long, curved graph crosses both sides of the legacy cube.
// Short primitive AABBs should form a sparse signed plan rather than filling
// the graph's complete bounding box.
const longGraph = {
  seed: 0x7a11cafe,
  sourceSeed: 0x7a11cafe,
  attempt: 0,
  entranceNodeId: 'n0',
  entrance: {
    rootNodeId: 'n0', mouth: [0, 2.15, -36], outward: [0, 0, -1], rx: 4.15, ry: 3.15,
  },
  nodes: [
    { id: 'n0', type: 'entrance', p: [0, 2, -27.5] },
    { id: 'n1', type: 'junction', p: [-26, -1, 5] },
    { id: 'n2', type: 'junction', p: [-68, -6, 34] },
    { id: 'n3', type: 'junction', p: [-94, -10, 73] },
    { id: 'n4', type: 'junction', p: [-48, -14, 108] },
    { id: 'n5', type: 'terminal', p: [8, -18, 146] },
  ],
  edges: [
    { id: 'e0', a: 'n0', b: 'n1', rx: 3.8, ry: 3.0, rxA: 3.8, rxB: 4.6, ryA: 3.0, ryB: 3.5 },
    { id: 'e1', a: 'n1', b: 'n2', rx: 4.4, ry: 3.4 },
    { id: 'e2', a: 'n2', b: 'n3', rx: 3.7, ry: 2.9 },
    { id: 'e3', a: 'n3', b: 'n4', rx: 4.8, ry: 3.7 },
    { id: 'e4', a: 'n4', b: 'n5', rx: 4.1, ry: 3.2 },
  ],
  chambers: [
    { id: 'c0', nodeId: 'n2', c: [-68, -6, 34], r: [10, 7, 8], yaw: 0.55 },
    { id: 'c1', nodeId: 'n4', c: [-48, -14, 108], r: [15, 9, 6], rotation: [0.08, -0.72, 0.04] },
    { id: 'c2', nodeId: 'n5', c: [8, -18, 146], r: [11, 7, 12] },
  ],
  spawnLocal: { x: 0, z: -30.5 },
  volume: { primitivePadding: 2.2 },
};
const longPlans = createCaveChunkPlan(longGraph, 48);
assert.deepEqual(longPlans, createCaveChunkPlan(longGraph, 48), 'long signed plan is not deterministic');
assert.ok(longPlans.some((plan) => plan.ix < 0), 'long plan did not produce negative signed chunk keys');
assert.ok(longPlans.some((plan) => plan.bounds.maxZ > CAVE_HALF_EXTENT),
  'long plan did not extend beyond the old +40m boundary');
assert.ok(longPlans.some((plan) => plan.iz > 2), 'long plan retained the old nonnegative cube ceiling');
const longIndexBounds = {
  minX: Math.min(...longPlans.map((plan) => plan.ix)), maxX: Math.max(...longPlans.map((plan) => plan.ix)),
  minY: Math.min(...longPlans.map((plan) => plan.iy)), maxY: Math.max(...longPlans.map((plan) => plan.iy)),
  minZ: Math.min(...longPlans.map((plan) => plan.iz)), maxZ: Math.max(...longPlans.map((plan) => plan.iz)),
};
const denseLongCount = (longIndexBounds.maxX - longIndexBounds.minX + 1)
  * (longIndexBounds.maxY - longIndexBounds.minY + 1)
  * (longIndexBounds.maxZ - longIndexBounds.minZ + 1);
assert.ok(longPlans.length < denseLongCount * 0.72,
  `long plan is not sparse: ${longPlans.length}/${denseLongCount}`);

// Planning honors tapered endpoint widths even before the field grammar begins
// rendering them, and rotated chamber bounds remain conservative.
const taperedGraph = {
  nodes: [{ id: 'n0', p: [0, 0, 0] }, { id: 'n1', p: [30, 0, 0] }],
  edges: [{ id: 'e0', a: 'n0', b: 'n1', rx: 2, ry: 2, rxA: 2, rxB: 18, ryA: 2, ryB: 8 }],
  chambers: [],
};
const taperedPlans = createCaveChunkPlan(taperedGraph, 64);
assert.ok(taperedPlans.some((plan) => plan.iz === 0) && taperedPlans.some((plan) => plan.iz === 3),
  'tapered endpoint radius was omitted from passage bounds');
const rotatedGraph = {
  nodes: [], edges: [],
  chambers: [{ id: 'c0', c: [10, 0, 10], r: [18, 5, 3], yaw: Math.PI * 0.25 }],
};
const rotatedPlans = createCaveChunkPlan(rotatedGraph, 64);
assert.ok(rotatedPlans.some((plan) => plan.iz === 1) && rotatedPlans.some((plan) => plan.iz === 3),
  'rotated chamber extent was omitted from conservative bounds');

const results = new Map();
let triangles = 0, nonempty = 0;
for (const plan of plans) {
  const result = meshCaveChunk(field, 48, plan);
  results.set(result.key, result);
  triangles += result.triangles;
  if (result.triangles) nonempty++;
  assert.equal(result.positions.length, result.normals.length, `${result.key} attribute mismatch`);
  assert.equal(result.positions.length, result.triangles * 9, `${result.key} triangle buffer mismatch`);
  assert.ok(result.audit.finite, `${result.key} contains non-finite geometry`);
  assert.ok(result.audit.meanSurfaceError < 0.05, `${result.key} surface error ${result.audit.meanSurfaceError}`);
  for (let i = 0; i < result.normals.length; i += 3) {
    const length = Math.hypot(result.normals[i], result.normals[i + 1], result.normals[i + 2]);
    assert.ok(Math.abs(length - 1) < 1e-4, `${result.key} non-unit normal`);
  }
}
assert.ok(nonempty >= 2, `expected multiple surface chunks, got ${nonempty}`);
assert.ok(triangles > 1000, `unexpectedly small cave mesh: ${triangles}`);

let seamPairs = 0;
for (const plan of plans) {
  const entry = results.get(plan.key);
  for (const [dx, dy, dz, face, opposite] of [
    [1, 0, 0, 'xmax', 'xmin'], [0, 1, 0, 'ymax', 'ymin'], [0, 0, 1, 'zmax', 'zmin'],
  ]) {
    const neighbor = results.get(caveChunkKey(plan.ix + dx, plan.iy + dy, plan.iz + dz));
    if (!neighbor) continue;
    seamPairs++;
    assert.equal(entry.faceHashes[face], neighbor.faceHashes[opposite], `${plan.key}/${neighbor.key} seam mismatch`);
  }
}
assert.ok(seamPairs > 0, 'no adjacent chunks were available for seam validation');

const firstSurface = [...results.values()].find((result) => result.triangles > 0);
const rebuilt = meshCaveChunk(field, 48, firstSurface.ix, firstSurface.iy, firstSurface.iz);
assert.equal(hashFloats(firstSurface.positions), hashFloats(rebuilt.positions), 'chunk geometry is not deterministic');
assert.deepEqual(firstSurface.faceHashes, rebuilt.faceHashes, 'chunk boundary hashes are not deterministic');
assert.throws(
  () => meshCaveChunk(field, 48, 999, 0, 999),
  /outside the sparse graph plan/,
  'mesher accepted a request outside the sparse graph plan',
);
assert.throws(
  () => meshCaveChunk(field, 48, {
    ...plans[0], bounds: { ...plans[0].bounds, minX: plans[0].bounds.minX + 1 },
  }),
  /bounds do not match/,
  'mesher accepted explicit bounds that disagree with signed coordinates',
);

let selectedBounds = null;
const selectingField = {
  ...field,
  sdfForBounds(bounds) {
    selectedBounds = { ...bounds };
    return field.sdf;
  },
};
const selectorPlan = plans.find((plan) => plan.key === firstSurface.key);
const selectedResult = meshCaveChunk(selectingField, 48, selectorPlan);
assert.deepEqual(selectedBounds, selectorPlan.bounds, 'mesher did not pass canonical plan bounds to sdfForBounds');
assert.equal(hashFloats(selectedResult.positions), hashFloats(firstSurface.positions),
  'bounds-local SDF selection changed full-field geometry');

// A far pair in the expanded graph exercises signed-coordinate meshing and
// shared-face parity beyond the old fixed volume.
const longField = createCaveField(longGraph);
const longPlanByKey = new Map(longPlans.map((plan) => [plan.key, plan]));
let farPair = null;
for (const plan of longPlans.filter((candidate) => candidate.bounds.maxZ > CAVE_HALF_EXTENT)) {
  for (const [dx, dy, dz, face, opposite] of [
    [1, 0, 0, 'xmax', 'xmin'], [0, 1, 0, 'ymax', 'ymin'], [0, 0, 1, 'zmax', 'zmin'],
  ]) {
    const neighbor = longPlanByKey.get(caveChunkKey(plan.ix + dx, plan.iy + dy, plan.iz + dz));
    if (neighbor) { farPair = { plan, neighbor, face, opposite }; break; }
  }
  if (farPair) break;
}
assert.ok(farPair, 'expanded signed plan has no adjacent far chunks for a seam test');
const farA = meshCaveChunk(longField, 48, farPair.plan);
const farB = meshCaveChunk(longField, 48, farPair.neighbor);
assert.equal(farA.faceHashes[farPair.face], farB.faceHashes[farPair.opposite],
  `expanded signed seam mismatch ${farA.key}/${farB.key}`);

// The entrance uses the same mesher on a small rectangular terrain-minus-cave
// field. A sphere is a compact topology/normal/determinism check for that path.
const sphereSdf = (x, y, z) => Math.hypot(x, y, z) - 1;
const implicitBounds = { minX: -1.5, maxX: 1.5, minY: -1.5, maxY: 1.5, minZ: -1.5, maxZ: 1.5 };
const implicit = meshImplicitBox(sphereSdf, implicitBounds, { nx: 14, ny: 14, nz: 14 });
const implicitRebuilt = meshImplicitBox(sphereSdf, implicitBounds, { nx: 14, ny: 14, nz: 14 });
assert.ok(implicit.triangles > 500, `implicit transition mesh too small: ${implicit.triangles}`);
assert.equal(implicit.positions.length, implicit.normals.length, 'implicit transition attributes mismatch');
assert.equal(implicit.indices.length, implicit.triangles * 3, 'implicit transition index count mismatch');
assert.equal(implicit.sourceVertices, implicit.triangles * 3, 'implicit source triangle count mismatch');
assert.ok(implicit.finite, 'implicit transition contains non-finite geometry');
assert.ok(implicit.meanSurfaceError < 0.02, `implicit transition error ${implicit.meanSurfaceError}`);
assert.ok(implicit.maxSurfaceError < 0.02, `implicit transition max error ${implicit.maxSurfaceError}`);
assert.ok(
  implicit.meanSurfaceError < implicit.preProjectionMeanSurfaceError,
  `implicit projection did not improve mean error: ${implicit.preProjectionMeanSurfaceError} -> ${implicit.meanSurfaceError}`,
);
const implicitVertexCount = implicit.positions.length / 3;
assert.ok(
  implicitVertexCount < implicit.sourceVertices * 0.35,
  `implicit weld did not meaningfully reduce vertices: ${implicitVertexCount}/${implicit.sourceVertices}`,
);
let maxImplicitSurfaceError = 0;
for (let i = 0; i < implicit.positions.length; i += 3) {
  const px = implicit.positions[i], py = implicit.positions[i + 1], pz = implicit.positions[i + 2];
  maxImplicitSurfaceError = Math.max(maxImplicitSurfaceError, Math.abs(sphereSdf(px, py, pz)));
  const normalLength = Math.hypot(implicit.normals[i], implicit.normals[i + 1], implicit.normals[i + 2]);
  assert.ok(Math.abs(normalLength - 1) < 1e-4, `implicit transition non-unit normal ${normalLength}`);
}
assert.ok(maxImplicitSurfaceError < 0.02, `implicit transition max surface error ${maxImplicitSurfaceError}`);
for (let i = 0; i < implicit.indices.length; i++) {
  assert.ok(
    Number.isInteger(implicit.indices[i]) && implicit.indices[i] >= 0 && implicit.indices[i] < implicitVertexCount,
    `implicit transition index ${i} out of range: ${implicit.indices[i]}/${implicitVertexCount}`,
  );
}
for (let i = 0; i < implicit.indices.length; i += 3) {
  assert.notEqual(implicit.indices[i], implicit.indices[i + 1], `implicit triangle ${i / 3} repeats an index`);
  assert.notEqual(implicit.indices[i], implicit.indices[i + 2], `implicit triangle ${i / 3} repeats an index`);
  assert.notEqual(implicit.indices[i + 1], implicit.indices[i + 2], `implicit triangle ${i / 3} repeats an index`);
}
const expectedDefaultEpsilon = (3 / 14) * 0.65;
assert.ok(
  Math.abs(implicit.normalEpsilon - expectedDefaultEpsilon) < 1e-12,
  `implicit transition epsilon is not cell-scaled: ${implicit.normalEpsilon}`,
);
assert.equal(hashFloats(implicit.positions), hashFloats(implicitRebuilt.positions), 'implicit transition is not deterministic');
assert.equal(hashFloats(implicit.normals), hashFloats(implicitRebuilt.normals), 'implicit normals are not deterministic');
assert.equal(hashIntegers(implicit.indices), hashIntegers(implicitRebuilt.indices), 'implicit indices are not deterministic');
assert.equal(implicit.indices.constructor, implicitRebuilt.indices.constructor, 'implicit index type is not deterministic');

const customNormalEpsilon = 0.037;
const customEpsilonImplicit = meshImplicitBox(
  sphereSdf,
  implicitBounds,
  { nx: 14, ny: 14, nz: 14, normalEpsilon: customNormalEpsilon },
);
assert.equal(customEpsilonImplicit.normalEpsilon, customNormalEpsilon, 'custom implicit normal epsilon was ignored');
for (let i = 0; i < customEpsilonImplicit.normals.length; i += 3) {
  const length = Math.hypot(
    customEpsilonImplicit.normals[i],
    customEpsilonImplicit.normals[i + 1],
    customEpsilonImplicit.normals[i + 2],
  );
  assert.ok(Math.abs(length - 1) < 1e-4, `custom-epsilon implicit non-unit normal ${length}`);
}

// Exercise the actual terrain-minus-generated-cave field used by the entrance
// facade. Continuous World.height sampling deliberately keeps this independent
// from THREE/chunk streaming while retaining the real non-linear field,
// transform, mouth bound, smoothing radius, bounds, and production resolution.
const entranceWorld = new World(20260612);
const entranceAnchors = [];
caveAnchorsAround(entranceWorld, 0, 0, entranceWorld.seed, 22000, entranceAnchors);
assert.ok(entranceAnchors.length > 0, 'no generated entrance anchor available for implicit accuracy test');
const entranceAnchor = entranceAnchors[0];
const entranceGraph = generateCaveGraph(entranceAnchor.seed);
const entranceField = createCaveField(entranceGraph);
const entranceMouth = entranceGraph.entrance.mouth;
const entranceFloor = entranceField.floorHeight(entranceMouth[0], entranceMouth[2]);
assert.notEqual(entranceFloor, null, 'generated entrance has no floor');
const entranceCos = Math.cos(entranceAnchor.yaw), entranceSin = Math.sin(entranceAnchor.yaw);
const mouthWorldX = entranceCos * entranceMouth[0] + entranceSin * entranceMouth[2];
const mouthWorldZ = -entranceSin * entranceMouth[0] + entranceCos * entranceMouth[2];
const entranceInset = clamp(
  entranceAnchor.coverRise * 0.18 + entranceAnchor.slope * 2.0,
  1.8,
  3.2,
);
const entranceOrigin = {
  x: entranceAnchor.x - mouthWorldX,
  y: entranceAnchor.surfaceY - entranceInset - entranceFloor,
  z: entranceAnchor.z - mouthWorldZ,
};
const entranceLocalToWorldXZ = (x, z) => ({
  x: entranceOrigin.x + entranceCos * x + entranceSin * z,
  z: entranceOrigin.z - entranceSin * x + entranceCos * z,
});
const entranceTerrainLocalY = (x, z) => {
  const worldXZ = entranceLocalToWorldXZ(x, z);
  return entranceWorld.height(worldXZ.x, worldXZ.z) - entranceOrigin.y;
};
const entranceImplicit = (x, y, z) => {
  const along = z - entranceMouth[2];
  const boundedCave = Math.max(entranceField.sdf(x, y, z), -4.2 - along);
  return smoothMinimum(boundedCave, entranceTerrainLocalY(x, z) - y, 0.72);
};
let entranceMaxTerrain = -Infinity;
for (let iz = 0; iz <= 10; iz++) {
  const z = entranceMouth[2] - 4.9 + (iz / 10) * 13.9;
  for (let ix = 0; ix <= 8; ix++) {
    const x = -6.35 + (ix / 8) * 12.7;
    entranceMaxTerrain = Math.max(entranceMaxTerrain, entranceTerrainLocalY(x, z));
  }
}
const entranceBounds = {
  minX: -6.35,
  maxX: 6.35,
  minY: entranceFloor - 1.5,
  maxY: entranceMaxTerrain + 1,
  minZ: entranceMouth[2] - 4.9,
  maxZ: entranceMouth[2] + 9,
};
const entranceImplicitMesh = meshImplicitBox(
  entranceImplicit,
  entranceBounds,
  { nx: 38, ny: 33, nz: 46 },
);
assert.ok(entranceImplicitMesh.finite, 'generated entrance implicit mesh contains non-finite geometry');
assert.ok(
  entranceImplicitMesh.preProjectionMaxSurfaceError > 0.10,
  `generated entrance no longer exercises the projection regression: ${entranceImplicitMesh.preProjectionMaxSurfaceError}`,
);
assert.ok(
  entranceImplicitMesh.maxSurfaceError < 0.10,
  `generated entrance max SDF error ${entranceImplicitMesh.maxSurfaceError}`,
);
assert.ok(
  entranceImplicitMesh.meanSurfaceError < 0.005,
  `generated entrance mean SDF error ${entranceImplicitMesh.meanSurfaceError}`,
);
assert.ok(
  entranceImplicitMesh.maxSurfaceError < entranceImplicitMesh.preProjectionMaxSurfaceError * 0.5,
  `generated entrance projection did not materially improve max error: ${entranceImplicitMesh.preProjectionMaxSurfaceError} -> ${entranceImplicitMesh.maxSurfaceError}`,
);

console.log(
  `cavemesh PASS · ${plans.length} sparse blocks · ${nonempty} surfaces · ${triangles} tris · ${seamPairs} seams`
  + ` · entrance SDF max ${entranceImplicitMesh.preProjectionMaxSurfaceError.toFixed(3)}→${entranceImplicitMesh.maxSurfaceError.toFixed(3)}m`,
);
