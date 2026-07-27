import assert from 'node:assert/strict';
import { buildTerrainArrays, buildGrass } from '../src/chunkgen.js';
import { groundMacroPatch, World } from '../src/world.js';

const world = new World(20260612);
const resolution = 16;
const chunkSize = 140;
const terrain = buildTerrainArrays(world, 0, 0, resolution, chunkSize);
const vertexCount = terrain.positions.length / 3;

assert.equal(terrain.macros.length, vertexCount, 'terrain macro attribute length mismatch');
assert.equal(terrain.shades.length, vertexCount, 'XR terrain shade attribute length mismatch');
for (const value of terrain.macros) {
  assert.ok(Number.isFinite(value) && value >= 0 && value <= 1,
    `terrain macro escaped 0..1: ${value}`);
}
let shadeMin = Infinity, shadeMax = -Infinity;
for (const value of terrain.shades) {
  assert.ok(Number.isFinite(value) && value >= 0.74 && value <= 1.08,
    `XR terrain shade escaped its painterly range: ${value}`);
  shadeMin = Math.min(shadeMin, value);
  shadeMax = Math.max(shadeMax, value);
}
assert.ok(shadeMax - shadeMin > 0.02,
  `XR terrain shade has insufficient relief range: ${shadeMin}..${shadeMax}`);

// Interior vertices must contain the exact shared world-space function value.
const n = resolution + 1;
for (const index of [0, 5, n * 7 + 9, n * n - 1]) {
  const x = terrain.positions[index * 3];
  const h = terrain.positions[index * 3 + 1];
  const z = terrain.positions[index * 3 + 2];
  const { t, m } = world.climate(x, z, h);
  assert.ok(Math.abs(terrain.macros[index] - groundMacroPatch(world, x, z, t, m)) < 1e-6,
    `terrain macro drifted from shared function at vertex ${index}`);
}

// Skirts copy their source vertex signal, preventing LOD seams in the wash.
const firstSkirt = n * n;
assert.equal(terrain.macros[firstSkirt], terrain.macros[0], 'first terrain skirt macro mismatch');
assert.equal(terrain.shades[firstSkirt], terrain.shades[0], 'first terrain skirt shade mismatch');

let min = 1, max = 0;
for (let z = 0; z <= 420; z += 21) {
  for (let x = 0; x <= 420; x += 21) {
    const h = world.height(x, z);
    const { t, m } = world.climate(x, z, h);
    const value = groundMacroPatch(world, x, z, t, m);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
}
assert.ok(max - min > 0.18, `macro field has insufficient spatial range: ${min}..${max}`);

// Close patch grass carries one scalar per instance through the worker payload.
let grass = null;
for (let cz = -3; cz <= 3 && !grass; cz++) {
  for (let cx = -3; cx <= 3 && !grass; cx++) {
    grass = buildGrass(world, cx, cz, chunkSize, 3000);
  }
}
assert.ok(grass, 'test region produced no close patch grass');
assert.equal(grass.macros.length, grass.matrices.length / 16, 'grass macro attribute length mismatch');
for (const value of grass.macros) {
  assert.ok(Number.isFinite(value) && value >= 0 && value <= 1,
    `grass macro escaped 0..1: ${value}`);
}

console.log(`groundmacro PASS · terrain ${vertexCount} verts · grass ${grass.macros.length} instances · macro ${min.toFixed(3)}–${max.toFixed(3)} · XR shade ${shadeMin.toFixed(3)}–${shadeMax.toFixed(3)}`);
