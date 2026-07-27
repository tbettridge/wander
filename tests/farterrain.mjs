import assert from 'node:assert/strict';
import {
  FAR_REBUILD_DIST,
  FAR_RIBBON_RADII,
  FAR_SURFACE_RINGS,
  farTerrainTopology,
  fillSurfaceRadii,
} from '../src/farterrainplan.mjs';

const radii = fillSurfaceRadii(980, new Float32Array(FAR_SURFACE_RINGS));
assert.equal(radii.at(-1), FAR_RIBBON_RADII[0]);
for (let i = 1; i < radii.length; i++) {
  assert.ok(radii[i] > radii[i - 1], `surface radii not increasing at ${i}`);
}

assert.deepEqual(FAR_RIBBON_RADII, [3000, 5000, 7500]);
assert.equal(FAR_REBUILD_DIST, 450);

const topology = farTerrainTopology();
assert.equal(topology.ribbonCount, 3);
assert.ok(topology.totalVertices < 60 * 160, 'new horizon did not reduce vertices');
assert.ok(topology.totalTriangles < 59 * 160 * 2, 'new horizon did not reduce triangles');

console.log(
  `farterrain PASS · ${topology.ribbonCount} ribbons · ${topology.totalVertices} verts · ${topology.totalTriangles} tris · ${FAR_REBUILD_DIST}m rebuild`,
);
