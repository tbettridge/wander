import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import {
  buildTerrainArrays,
  buildTrailSurface,
  sampleRenderedTerrainTriangle,
} from '../src/chunkgen.js';
import {
  rasterizeTrailGrassMask,
  trailEcologyAt,
  trailGrassBands,
  trailsAround,
} from '../src/trails.js';

// A saddle quad makes bilinear interpolation visibly disagree with the two
// triangles used by the actual terrain mesh.
const saddle = new Float32Array([
  0, 0, 0,  1, 0, 0,
  0, 0, 1,  1, 2, 1,
]);
const sample = {};
sampleRenderedTerrainTriangle(saddle, 1, 1, 0, 0, 0.25, 0.25, sample);
assert.equal(sample.y, 0, 'lower terrain triangle was sampled bilinearly');
sampleRenderedTerrainTriangle(saddle, 1, 1, 0, 0, 0.75, 0.75, sample);
assert.ok(Math.abs(sample.y - 1) < 1e-8, 'upper terrain triangle interpolation is wrong');
assert.ok(sample.nx < -0.6 && sample.ny > 0.3 && sample.nz < -0.6,
  'terrain triangle normal is wrong');

const world = new World(20260612);
const chunkSize = 140, resolution = 64, cx = 20, cz = -26;
const terrain = buildTerrainArrays(world, cx, cz, resolution, chunkSize);
const trail = buildTrailSurface(world, cx, cz, chunkSize, resolution, terrain.positions);
assert.ok(trail?.positions.length > 0, 'trail drape regression chunk emits no surface');

const minX = cx * chunkSize, minZ = cz * chunkSize;
let minimumClearance = Infinity, maximumClearance = -Infinity, checked = 0;
for (let i = 0; i < trail.positions.length; i += 3) {
  const x = trail.positions[i], y = trail.positions[i + 1], z = trail.positions[i + 2];
  if (x < minX || x > minX + chunkSize || z < minZ || z > minZ + chunkSize) continue;
  sampleRenderedTerrainTriangle(
    terrain.positions, resolution, chunkSize, minX, minZ, x, z, sample,
  );
  const clearance = y - sample.y;
  minimumClearance = Math.min(minimumClearance, clearance);
  maximumClearance = Math.max(maximumClearance, clearance);
  checked++;
}
assert.ok(checked > 100, 'trail drape fixture checked too few vertices');
assert.ok(minimumClearance >= 0.019,
  `trail penetrated rendered terrain (${minimumClearance.toFixed(5)}m)`);
assert.ok(maximumClearance <= 0.06,
  `trail floats too far above rendered terrain (${maximumClearance.toFixed(5)}m)`);

const edges = [];
trailsAround(world, 0, 0, world.seed, 5000, edges);
const edge = edges.find((candidate) => candidate.routeClass === 'faint') || edges[0];
assert.ok(edge, 'trail ecology fixture has no route');
const bands = trailGrassBands(edge, {});
const sx = edge.segments.ax[0], sz = edge.segments.az[0];
const ecology = trailEcologyAt(edges, sx, sz, {});
assert.equal(ecology.zone, 'core', 'trail centre is not classified as core tread');
assert.equal(ecology.grassDensity, 0, 'trail centre still permits grass');
assert.equal(ecology.plantDensity, 0, 'trail centre still permits ordinary plants');
assert.ok(bands.bare >= edge.width * 0.58 && bands.full > edge.width,
  'trail grass shoulder profile is too narrow');

// The distant GPU grass field uses a separate high-resolution mask. Verify
// that it preserves the same bare centre and a soft, grassy edge rather than
// turning a narrow path into an all-or-nothing low-resolution stripe.
const maskSize = 101, maskCover = 10;
const mask = new Uint8Array(maskSize * maskSize);
const syntheticTrail = {
  width: 1,
  routeClass: 'faint',
  segments: {
    count: 1,
    ax: new Float32Array([2]), az: new Float32Array([5]),
    dx: new Float32Array([6]), dz: new Float32Array([0]),
    invLen2: new Float32Array([1 / 36]),
  },
};
rasterizeTrailGrassMask([syntheticTrail], 0, 0, maskCover, maskSize, mask);
const maskAt = (x, z) => mask[Math.round(z * 10) * maskSize + Math.round(x * 10)];
assert.equal(maskAt(5, 5), 0, 'GPU grass mask leaves blades on the trail centre');
assert.equal(maskAt(5, 7), 255, 'GPU grass mask suppresses grass beyond the verge');
assert.ok(maskAt(5, 5.9) > 0 && maskAt(5, 5.9) < 255,
  'GPU grass mask does not form a soft grassy shoulder');

console.log(`trailsurface PASS · ${checked} draped verts · clearance ${minimumClearance.toFixed(3)}–${maximumClearance.toFixed(3)}m · bare ${edge.routeClass} core`);
