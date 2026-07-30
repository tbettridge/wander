import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCaveField } from '../src/cavefield.mjs';
import { caveGraphSignature, generateCaveGraph } from '../src/cavegen.mjs';
import {
  createCaveFacadeWorkerProtocol,
  meshCaveEntranceFacade,
  sampledTerrainHeight,
} from '../src/cavefacadeworker-protocol.mjs';

const bilinearSurface = {
  minX: -1,
  maxX: 1,
  minZ: -2,
  maxZ: 2,
  nx: 2,
  nz: 2,
  heights: new Float32Array([0, 2, 4, 6]),
};
assert.equal(sampledTerrainHeight(bilinearSurface, -1, -2), 0);
assert.equal(sampledTerrainHeight(bilinearSurface, 1, 2), 6);
assert.equal(sampledTerrainHeight(bilinearSurface, 0, 0), 3);

const graph = generateCaveGraph(0x51deca7e);
const graphHash = caveGraphSignature(graph);
const messages = [];
let calls = 0;
const protocol = createCaveFacadeWorkerProtocol({
  postMessage(message, transferables) { messages.push({ message, transferables }); },
  meshFacade(job) {
    calls++;
    assert.equal(job.graph.entrance.cutMinAlong, -4.2);
    assert.equal(job.entranceFloorLocal, -2.5);
    return {
      positions: new Float32Array([1, 2, 3]),
      normals: new Float32Array([0, 1, 0]),
      colors: new Float32Array([0.2, 0.3, 0.1]),
      indices: new Uint16Array([0, 0, 0]),
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      handoff: { fadeStartAlong: 24.5, fadeEndAlong: 28.5 },
      meshMs: 12,
      workerMs: 15,
    };
  },
});
const validJob = {
  type: 'entrance-facade',
  requestId: 4,
  epoch: 9,
  graph,
  graphHash,
  terrainSignature: '7,4:96',
  entranceFloorLocal: -2.5,
  cutMinAlong: -4.2,
  render: {
    worldSeed: 20260612,
    origin: [0, 0, 0],
    yaw: 0,
    supportLocalBounds: { minX: -7.2, maxX: 7.2, minZ: -42, maxZ: 16 },
  },
  surface: bilinearSurface,
};
const valid = protocol.handleJob(validJob);
assert.equal(valid.type, 'entrance-facade-result');
assert.equal(valid.requestId, 4);
assert.equal(valid.epoch, 9);
assert.equal(valid.graphHash, graphHash);
assert.equal(valid.terrainSignature, '7,4:96');
assert.equal(calls, 1);
assert.equal(messages[0].transferables.length, 4);

const changedGraph = structuredClone(graph);
changedGraph.chambers[0].r[0] += 0.25;
const mismatch = protocol.handleJob({ ...validJob, requestId: 5, graph: changedGraph });
assert.equal(mismatch.type, 'entrance-facade-error');
assert.match(mismatch.message, /graph hash mismatch/i);
assert.equal(calls, 1, 'hash-mismatched graph reached the facade mesher');
assert.equal(protocol.handleJob({ type: 'noop' }), null);

// Exercise the production mesher once. A sloping sampled heightfield verifies
// the worker can reconstruct the terrain-minus-cave implicit volume without
// any browser or Three.js dependency.
const field = createCaveField(graph);
const mouth = graph.entrance.mouth;
const floor = field.floorHeightNear(mouth[0], mouth[2], mouth[1], 4, 14) ?? mouth[1];
const minX = -16.35, maxX = 16.35;
const minZ = mouth[2] - 4.9, maxZ = mouth[2] + 50.5;
const nx = 132, nz = 223;
const heights = new Float32Array(nx * nz);
for (let iz = 0; iz < nz; iz++) {
  for (let ix = 0; ix < nx; ix++) {
    const x = minX + ix / (nx - 1) * (maxX - minX);
    const z = minZ + iz / (nz - 1) * (maxZ - minZ);
    heights[iz * nx + ix] = floor + 3.2 + 0.16 * (z - mouth[2]) + 0.03 * x;
  }
}
const actualGraph = structuredClone(graph);
actualGraph.entrance.cutMinAlong = -4.2;
const actual = meshCaveEntranceFacade({
  graph: actualGraph,
  surface: { heights, nx, nz, minX, maxX, minZ, maxZ },
  entranceFloorLocal: floor,
  cutMinAlong: -4.2,
  render: {
    worldSeed: 20260612,
    origin: [0, 0, 0],
    yaw: 0.3,
    supportLocalBounds: {
      minX: -7.2, maxX: 7.2,
      minZ: mouth[2] - 5.6, maxZ: mouth[2] + 52,
    },
  },
});
assert.ok(actual.positions.length > 0, 'production facade mesher returned no surface');
assert.ok(actual.indices.length > 0, 'production facade mesher returned no triangles');
assert.equal(actual.positions.length, actual.normals.length);
assert.equal(actual.positions.length, actual.colors.length);
assert.ok(actual.workerMs >= actual.meshMs);
assert.ok(actual.handoff.fadeStartAlong >= 24.5);
assert.ok(actual.bounds.minX >= minX && actual.bounds.maxX <= maxX);

// r185 regression: the collision fold survived, but cloning terrainMaterial's
// nested onBeforeCompile chain produced no visible program for this derived
// mesh. Keep the critical bridge on its dedicated lit material, and retain the
// full terrain attribute contract so an explicit future XR route is safe.
const caveSource = await readFile(new URL('../src/cave.js', import.meta.url), 'utf8');
const facadeStart = caveSource.indexOf('finishEntranceFacadeBuild(build, raw)');
const facadeEnd = caveSource.indexOf('\n  entranceSurfaceAtLocal(', facadeStart);
const facadeSource = caveSource.slice(facadeStart, facadeEnd);
assert.match(facadeSource, /setAttribute\(\s*'aXRShade'/,
  'cave entrance fold must supply the XR terrain shade attribute');
assert.match(facadeSource, /new THREE\.MeshStandardMaterial\(\{/,
  'cave entrance fold must use the r185-safe dedicated material');
assert.doesNotMatch(facadeSource, /createTerrainPatchMaterial\(/,
  'cave entrance fold must not restore the incompatible cloned terrain shader chain');
assert.match(facadeSource, /terrain-cave-collar-handoff-v5/,
  'cave entrance fold must retain its buried handoff shader');

console.log(`cavefacadeworker PASS · ${actual.positions.length / 3} verts · ${actual.indices.length / 3} tris · ${actual.meshMs.toFixed(0)} ms off-thread mesh`);
