import assert from 'node:assert/strict';
import { mulberry32 } from '../src/noise.js';
import { ROCK_ARCHETYPES, makePlanarRockMesh } from '../src/rockgeometry.mjs';

function bounds(mesh) {
  const out = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let i = 0; i < mesh.positions.length; i += 3) {
    out.minX = Math.min(out.minX, mesh.positions[i]); out.maxX = Math.max(out.maxX, mesh.positions[i]);
    out.minY = Math.min(out.minY, mesh.positions[i + 1]); out.maxY = Math.max(out.maxY, mesh.positions[i + 1]);
    out.minZ = Math.min(out.minZ, mesh.positions[i + 2]); out.maxZ = Math.max(out.maxZ, mesh.positions[i + 2]);
  }
  return out;
}

function validate(mesh, label) {
  assert.equal(mesh.positions.length, mesh.normals.length, `${label} attribute mismatch`);
  assert.equal(mesh.positions.length % 9, 0, `${label} is not a triangle list`);
  const triangleCount = mesh.positions.length / 9;
  assert.ok(triangleCount >= 40 && triangleCount <= 160, `${label} triangle budget ${triangleCount}`);
  assert.ok(mesh.faceSizes.some((face) => face.count >= 2), `${label} has no broad polygonal plane`);

  const edgeCounts = new Map();
  const pointKey = (offset) => [0, 1, 2].map((axis) => Math.round(mesh.positions[offset + axis] * 1e5)).join(',');
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const o = triangle * 9;
    const ax = mesh.positions[o], ay = mesh.positions[o + 1], az = mesh.positions[o + 2];
    const ux = mesh.positions[o + 3] - ax, uy = mesh.positions[o + 4] - ay, uz = mesh.positions[o + 5] - az;
    const vx = mesh.positions[o + 6] - ax, vy = mesh.positions[o + 7] - ay, vz = mesh.positions[o + 8] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const area = Math.hypot(cx, cy, cz);
    assert.ok(area > 1e-7, `${label} contains a degenerate triangle`);
    const nx = mesh.normals[o], ny = mesh.normals[o + 1], nz = mesh.normals[o + 2];
    assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-5, `${label} normal is not unit length`);
    assert.ok(cx * nx + cy * ny + cz * nz > 0, `${label} has a reversed face`);
    const keys = [pointKey(o), pointKey(o + 3), pointKey(o + 6)];
    for (const [a, b] of [[keys[0], keys[1]], [keys[1], keys[2]], [keys[2], keys[0]]]) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    }
  }
  for (const [edge, count] of edgeCounts) {
    assert.equal(count, 2, `${label} is not closed at ${edge}`);
  }
}

let triangleTotal = 0;
for (let index = 0; index < ROCK_ARCHETYPES.length; index++) {
  for (const boulder of [false, true]) {
    const seed = 913 + index * 37 + (boulder ? 1000 : 0);
    const mesh = makePlanarRockMesh(mulberry32(seed), ROCK_ARCHETYPES[index], boulder);
    const repeat = makePlanarRockMesh(mulberry32(seed), ROCK_ARCHETYPES[index], boulder);
    assert.deepEqual(mesh.positions, repeat.positions, `${ROCK_ARCHETYPES[index]} is not deterministic`);
    validate(mesh, `${boulder ? 'boulder' : 'rock'}/${ROCK_ARCHETYPES[index]}`);
    triangleTotal += mesh.positions.length / 9;
  }
}

const slab = bounds(makePlanarRockMesh(mulberry32(222), 'slab', false));
const monolith = bounds(makePlanarRockMesh(mulberry32(222), 'monolith', false));
const slabWidth = Math.max(slab.maxX - slab.minX, slab.maxZ - slab.minZ);
const slabHeight = slab.maxY - slab.minY;
const monolithWidth = Math.max(monolith.maxX - monolith.minX, monolith.maxZ - monolith.minZ);
const monolithHeight = monolith.maxY - monolith.minY;
assert.ok(slabWidth > slabHeight * 2.1, 'slab archetype is not recognisably low and broad');
assert.ok(monolithHeight > monolithWidth * 1.15, 'monolith archetype is not recognisably upright');

console.log(`rockgeometry PASS · ${ROCK_ARCHETYPES.length * 2} meshes · ${triangleTotal} tris · closed planar hulls`);
