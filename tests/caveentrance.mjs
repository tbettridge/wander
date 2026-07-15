import assert from 'node:assert/strict';
import {
  entrancePortalNear,
  entranceTransitionState,
  implicitBodyFits,
  implicitFloorHeightNear,
  resolveImplicitHorizontal,
} from '../src/caveentrance.mjs';

const bounds = { minX: -3, maxX: 3, minY: -2, maxY: 5, minZ: -2, maxZ: 12 };
assert.equal(entrancePortalNear(bounds, { x: 0, z: -1.5 }), true, 'mouth should be portal-near');
assert.equal(entrancePortalNear(bounds, { x: 78, z: -47 }), false,
  'a bent deep chamber must not be classified by the mouth Z plane');

function clamp01(value) { return Math.max(0, Math.min(1, value)); }
function smoothstep(a, b, value) {
  const t = clamp01((value - a) / (b - a));
  return t * t * (3 - 2 * t);
}

// A deterministic terrain-minus-tunnel field. The surface rises over the
// tunnel as it enters the hill, while the tunnel floor begins exactly at the
// outdoor ground plane. Negative is navigable air, matching the live field.
function terrainHeight(z) { return 3.2 * smoothstep(-0.15, 4.25, z); }
function tunnelFloor(z) { return Math.max(0, z) * 0.035; }
function entranceField(x, y, z) {
  const radiusX = 1.65, radiusY = 1.62;
  const centerY = tunnelFloor(z) + radiusY;
  const tunnelCrossSection = (Math.hypot(x / radiusX, (y - centerY) / radiusY) - 1) * radiusY;
  const boundedTunnel = Math.max(tunnelCrossSection, -z - 0.72);
  const terrainAir = terrainHeight(z) - y;
  return Math.min(boundedTunnel, terrainAir);
}

const outside = entranceTransitionState(
  bounds,
  false,
  { x: 4.0, z: -1.5 },
  { x: 4.0, z: 7.0 },
);
assert.equal(outside.outdoorAuthoritative, true,
  'walking over/around the buried entrance should remain outdoor-authoritative');
assert.equal(outside.active, false, 'the entrance collider activated outside its compact transition');
assert.equal(
  implicitFloorHeightNear(entranceField, bounds, 4.0, 7.0, 0, 0.5, 1.05),
  null,
  'the synthetic buried side demonstrates why the outdoor guard is required',
);

const entering = entranceTransitionState(
  bounds,
  false,
  { x: 0, z: -1.4 },
  { x: 0, z: -1.0 },
);
assert.equal(entering.targetInEntrance, true, 'the aperture should opt into entrance collision');
assert.equal(entering.active, true, 'the aperture transition should be collision-active');

let maxFloorDelta = 0;
const finalZByRate = [];
for (const hz of [10, 20, 60]) {
  let x = 0, z = -1.4;
  let floorY = implicitFloorHeightNear(entranceField, bounds, x, z);
  assert.notEqual(floorY, null, `${hz}Hz start has no outdoor floor`);
  let previousFloor = floorY;
  const speed = 4;
  const frames = Math.ceil(10.0 / speed * hz);
  for (let frame = 0; frame < frames; frame++) {
    const targetZ = Math.min(8.6, z + speed / hz);
    const resolved = resolveImplicitHorizontal(
      entranceField, bounds, x, z, x, targetZ, floorY,
      { maxSubstep: 0.20, radius: 0.30, height: 1.72, skin: 0.035, maxStep: 0.50, maxDrop: 1.05 },
    );
    assert.equal(resolved.blocked, false, `${hz}Hz traversal snagged at z=${z.toFixed(3)}`);
    assert.ok(resolved.z > z, `${hz}Hz traversal stopped advancing at z=${z.toFixed(3)}`);
    assert.ok(resolved.z <= targetZ + 1e-9, `${hz}Hz traversal tunnelled past its frame target`);
    assert.ok(implicitBodyFits(entranceField, resolved.x, resolved.z, resolved.floorY),
      `${hz}Hz traversal ended without capsule clearance`);
    maxFloorDelta = Math.max(maxFloorDelta, Math.abs(resolved.floorY - previousFloor));
    x = resolved.x;
    z = resolved.z;
    floorY = resolved.floorY;
    previousFloor = floorY;
  }
  assert.ok(z >= 8.59, `${hz}Hz traversal did not reach the tunnel interior (${z.toFixed(3)}m)`);
  finalZByRate.push(z);
}
assert.ok(maxFloorDelta < 0.025,
  `surface-to-tunnel floor handoff is discontinuous (${maxFloorDelta.toFixed(4)}m/frame)`);
assert.ok(Math.max(...finalZByRate) - Math.min(...finalZByRate) < 1e-8,
  'entrance traversal outcome should not depend on simulation rate');

const wallZ = 6.0;
const wallFloor = implicitFloorHeightNear(entranceField, bounds, 0, wallZ);
assert.notEqual(wallFloor, null, 'wall test has no tunnel floor');
const wallHit = resolveImplicitHorizontal(
  entranceField, bounds, 0, wallZ, 6, wallZ, wallFloor,
  { maxSubstep: 0.20, radius: 0.30, height: 1.72, skin: 0.035 },
);
assert.equal(wallHit.blocked, true, 'side-wall sweep should report contact');
assert.ok(wallHit.x < 1.65, `side-wall sweep tunnelled through the wall (${wallHit.x.toFixed(3)}m)`);
assert.ok(wallHit.acceptedDistance > 0, 'side-wall sweep should retain motion up to contact');
assert.ok(implicitBodyFits(entranceField, wallHit.x, wallHit.z, wallHit.floorY),
  'side-wall sweep ended without capsule clearance');

console.log(`caveentrance PASS · swept 10/20/60Hz · handoff ${maxFloorDelta.toFixed(4)}m · wall ${wallHit.x.toFixed(2)}m`);
