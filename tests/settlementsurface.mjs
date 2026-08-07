// The village's dirt surface: its square and the streets out of it.
//
// The contract that matters visually is the one the old ground treatment broke:
// the edges must be a gradient, not a cut line, and the square and the streets
// must be the same colour and physically connected. Everything here is checked
// on the arrays the renderer actually uploads.

import assert from 'node:assert/strict';
import {
  DIRT_MIX, SQUARE_ALPHA, SQUARE_RING, STREET_ALPHA, STREET_ACROSS,
  STREET_WIDTH_SCALE, SURFACE_LIFT, settlementSquareSurface, settlementStreetSurface,
  settlementSurfaceMesh,
} from '../src/settlementsurface.mjs';

const world = { height: (x, z) => 12 + Math.sin(x * 0.01) * 0.4 + Math.cos(z * 0.013) * 0.3 };
const square = { id: 's', x: 400, z: -220, radius: 26, yaw: 0 };
const street = {
  id: 'st0', angle: 0, width: 6.5,
  fromX: square.x + 26, fromZ: square.z, toX: square.x + 124, toZ: square.z,
};
// A painter with a recognisable constant tone, so colour claims are checkable.
const TONE = [0.31, 0.21, 0.12];
const paint = (x, z, out) => { out[0] = TONE[0]; out[1] = TONE[1]; out[2] = TONE[2]; return out; };

const alphaOf = (mesh, vertex) => mesh.colors[vertex * 4 + 3];
const vertexCount = (mesh) => mesh.positions.length / 3;

// --- the edges are a gradient, not a cut line -------------------------------------
{
  const mesh = settlementSquareSurface(world, square, paint);
  assert.ok(vertexCount(mesh) > 100, 'the square needs enough vertices to curve');
  assert.equal(alphaOf(mesh, 0), 1, 'the middle of the square is solid dirt');
  // Every vertex on the outermost ring must be fully transparent.
  const outerStart = 1 + (SQUARE_RING.length - 2) * 44;
  for (let i = outerStart; i < vertexCount(mesh); i++) {
    assert.equal(alphaOf(mesh, i), 0, `square rim vertex ${i} is opaque — that is a cut line`);
  }
  // And the alpha must fall monotonically outward, never step back up.
  for (let ring = 1; ring < SQUARE_ALPHA.length; ring++) {
    assert.ok(SQUARE_ALPHA[ring] <= SQUARE_ALPHA[ring - 1], 'square alpha must only fade outward');
  }
}

{
  const mesh = settlementStreetSurface(world, street, square, paint);
  const cols = STREET_ACROSS.length;
  // Both shoulders of every row are transparent.
  for (let row = 0; row * cols < vertexCount(mesh); row++) {
    assert.equal(alphaOf(mesh, row * cols), 0, 'street left shoulder is opaque');
    assert.equal(alphaOf(mesh, row * cols + cols - 1), 0, 'street right shoulder is opaque');
  }
  assert.equal(STREET_ALPHA[0], 0);
  assert.equal(STREET_ALPHA[STREET_ALPHA.length - 1], 0);
  assert.ok(STREET_ALPHA[Math.floor(cols / 2)] === 1, 'the middle of the road is solid');
}

// --- square and streets are one connected surface ------------------------------------
{
  const mesh = settlementStreetSurface(world, street, square, paint);
  // The ribbon must START at the middle of the square, not at its rim: starting
  // at the rim leaves a ring where the square has faded out and the street has
  // not yet faded in, which is a gap exactly where the road is most worn.
  let nearest = Infinity;
  for (let i = 0; i < vertexCount(mesh); i++) {
    const d = Math.hypot(mesh.positions[i * 3] - square.x, mesh.positions[i * 3 + 2] - square.z);
    if (d < nearest) nearest = d;
  }
  assert.ok(nearest < square.radius * 0.5,
    `the street stops ${nearest.toFixed(1)}m short of the square's middle`);
}

// --- the same colour in both ----------------------------------------------------------
{
  const both = settlementSurfaceMesh(world,
    { square, streets: [street], site: { x: square.x, z: square.z } }, paint);
  for (let i = 0; i < vertexCount(both); i++) {
    assert.equal(both.colors[i * 4], TONE[0], 'a vertex drifted off the settlement dirt tone');
    assert.equal(both.colors[i * 4 + 1], TONE[1]);
    assert.equal(both.colors[i * 4 + 2], TONE[2]);
  }
  assert.ok(DIRT_MIX > 0.5 && DIRT_MIX < 1,
    'some of the local ground must show through, or every village has the same soil');
}

// --- it lies ON the terrain, and its triangles are addressable ---------------------------
{
  const mesh = settlementSurfaceMesh(world,
    { square, streets: [street], site: { x: square.x, z: square.z } }, paint);
  const count = vertexCount(mesh);
  for (let i = 0; i < count; i++) {
    const x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
    const lift = y - world.height(x, z);
    assert.ok(Math.abs(lift - SURFACE_LIFT) < 1e-6,
      `vertex ${i} floats ${lift.toFixed(3)}m above the ground instead of ${SURFACE_LIFT}`);
  }
  assert.ok(mesh.indices.length > 0 && mesh.indices.length % 3 === 0);
  for (const index of mesh.indices) {
    assert.ok(index >= 0 && index < count, `index ${index} is outside the buffer`);
  }
  assert.equal(mesh.colors.length, count * 4, 'colours must be RGBA — alpha is the whole point');
}

// --- a street is surfaced wider than its carriageway ---------------------------------------
{
  const mesh = settlementStreetSurface(world, street, square, paint);
  let widest = 0;
  const cols = STREET_ACROSS.length;
  for (let row = 0; (row + 1) * cols <= vertexCount(mesh); row++) {
    const a = row * cols, b = row * cols + cols - 1;
    widest = Math.max(widest, Math.hypot(
      mesh.positions[a * 3] - mesh.positions[b * 3],
      mesh.positions[a * 3 + 2] - mesh.positions[b * 3 + 2]));
  }
  assert.ok(widest > street.width, 'the dirt should reach past the carriageway onto the verge');
  assert.ok(widest <= street.width * STREET_WIDTH_SCALE * 1.2, 'but not swallow the gardens');
}

// --- every face points UP ---------------------------------------------------------------
//
// Winding is not cosmetic here. A ground overlay is only ever seen from above,
// so a back-to-front triangle is not a dark triangle — it is an absent one, and
// the surface simply fails to appear with nothing in the geometry, the colours
// or the material to suggest why. Both builders got this wrong the first time.
{
  const mesh = settlementSurfaceMesh(world,
    { square, streets: [street], site: { x: square.x, z: square.z } }, paint);
  const vertex = (i) => [
    mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2],
  ];
  let up = 0, down = 0, degenerate = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = vertex(mesh.indices[t]), b = vertex(mesh.indices[t + 1]), c = vertex(mesh.indices[t + 2]);
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    // Y component of (ab x ac): positive means the face looks skyward.
    const ny = abz * acx - abx * acz;
    if (Math.abs(ny) < 1e-9) degenerate++;
    else if (ny > 0) up++;
    else down++;
  }
  assert.equal(degenerate, 0, 'the surface has slivers with no area');
  assert.equal(down, 0,
    `${down} of ${up + down} faces point at the ground — those triangles are culled and never draw`);
  assert.ok(up > 1000, 'the surface should be a real mesh');
}

// --- a settlement with no square still surfaces nothing rather than crashing -----------------
{
  const mesh = settlementSurfaceMesh(world, { square: null, streets: [], site: { x: 0, z: 0 } }, paint);
  assert.equal(mesh.indices.length, 0);
  assert.equal(mesh.positions.length, 0);
}

console.log('settlement surface ok · feathered edges · one connected dirt tone');
