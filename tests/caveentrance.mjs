import assert from 'node:assert/strict';
import {
  entrancePortalNear,
  entranceShouldRecoverOutdoor,
  entranceThroatEngaged,
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

// Cave-only counterpart used by the runtime to distinguish the aperture from
// ordinary outdoor air above and beside it.
function caveOnlyThroat(x, y, z) {
  const radiusX = 1.65, radiusY = 1.62;
  const centerY = tunnelFloor(z) + radiusY;
  const tunnelCrossSection = (Math.hypot(x / radiusX, (y - centerY) / radiusY) - 1) * radiusY;
  return Math.max(tunnelCrossSection, -z - 0.72);
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

const roofPlayer = { x: 0, y: terrainHeight(7), z: 7 };
const sidePlayer = { x: 2.35, y: terrainHeight(3), z: 3 };
const aperturePlayer = { x: 0, y: tunnelFloor(0.6), z: 0.6 };
assert.equal(entranceThroatEngaged(caveOnlyThroat, roofPlayer), false,
  'walking on the roof must not engage the cave throat');
assert.equal(entranceThroatEngaged(caveOnlyThroat, sidePlayer), false,
  'walking beside the aperture must not engage the cave throat');
assert.equal(entranceThroatEngaged(caveOnlyThroat, aperturePlayer), true,
  'a body centred in the aperture should engage the cave throat');

for (const [label, player] of [['roof', roofPlayer], ['side', sidePlayer]]) {
  const state = entranceTransitionState(bounds, false, player, { ...player, z: player.z + 0.2 }, {
    fromThroat: false,
    targetThroat: false,
  });
  assert.equal(state.targetInFootprint, true, `${label} fixture should cross the old X/Z trigger`);
  assert.equal(state.outdoorAuthoritative, true, `${label} approach lost outdoor authority`);
  assert.equal(state.active, false, `${label} approach incorrectly activated cave collision`);
}

assert.equal(entranceShouldRecoverOutdoor(true, false, roofPlayer.y, terrainHeight(7)), true,
  'a stale inside state on the roof should recover to outdoor movement');
assert.equal(entranceShouldRecoverOutdoor(true, false, roofPlayer.y + 8, terrainHeight(7)), true,
  'a stale inside state above the roof should recover after a debug-position jump');
assert.equal(entranceShouldRecoverOutdoor(true, false, -8, terrainHeight(7)), false,
  'a genuine deep cave occupant must not be released to the surface');
assert.equal(entranceShouldRecoverOutdoor(true, true, roofPlayer.y, terrainHeight(7)), false,
  'an engaged throat must retain cave collision during the handoff');

const entering = entranceTransitionState(
  bounds,
  false,
  { x: 0, z: -1.4 },
  { x: 0, z: -1.0 },
  { fromThroat: false, targetThroat: true },
);
assert.equal(entering.targetInEntrance, true, 'the aperture should opt into entrance collision');
assert.equal(entering.active, true, 'the aperture transition should be collision-active');

// Both reported interior blockers occur after their routes bend back through
// the mouth's Z band while remaining tens of metres to one side.  That must
// not hand movement back to the tiny terrain/entrance collider.
const liveEntranceBounds = {
  minX: -6.35, maxX: 6.35,
  minY: -4.0, maxY: 8.0,
  minZ: -40.9, maxZ: -11.0,
};
for (const [label, from, target] of [
  ['left keyhole fork', { x: 41.08, z: -30.64 }, { x: 41.18, z: -30.74 }],
  ['converging passage', { x: 35.83, z: -34.67 }, { x: 35.93, z: -34.77 }],
]) {
  const state = entranceTransitionState(liveEntranceBounds, true, from, target, {
    fromThroat: false,
    targetThroat: false,
  });
  assert.equal(state.segmentCrossesFootprint, false,
    `${label} should be horizontally remote from the entrance footprint`);
  assert.equal(state.active, false,
    `${label} incorrectly re-activated the entrance collider from Z overlap alone`);
  assert.equal(state.outdoorAuthoritative, false,
    `${label} must remain inside and use the interior cave collider`);
}

const exitingAcrossMouth = entranceTransitionState(
  liveEntranceBounds,
  true,
  { x: 0, z: -11.25 },
  { x: 0, z: -10.95 },
  { fromThroat: true, targetThroat: false },
);
assert.equal(exitingAcrossMouth.segmentCrossesFootprint, true,
  'a genuine mouth crossing should overlap the entrance footprint');
assert.equal(exitingAcrossMouth.active, true,
  'the compact entrance collider must remain active during a genuine exit');

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

// If a representation/floor handoff begins a frame with the capsule slightly
// embedded, movement must recover to the nearest valid point instead of
// leaving every WASD direction permanently blocked.
const embeddedX = 1.44;
const embeddedFloor = implicitFloorHeightNear(entranceField, bounds, embeddedX, wallZ);
assert.notEqual(embeddedFloor, null, 'embedded recovery fixture has no floor');
assert.equal(implicitBodyFits(entranceField, embeddedX, wallZ, embeddedFloor), false,
  'embedded recovery fixture is unexpectedly valid');
const recovered = resolveImplicitHorizontal(
  entranceField, bounds, embeddedX, wallZ, 0.6, wallZ, embeddedFloor,
  { maxSubstep: 0.20, radius: 0.30, height: 1.72, skin: 0.035 },
);
assert.equal(recovered.recovered, true, 'embedded entrance capsule did not depenetrate');
assert.ok(recovered.x < embeddedX - 0.2, 'embedded entrance capsule did not move back into the route');
assert.ok(implicitBodyFits(entranceField, recovered.x, recovered.z, recovered.floorY),
  'entrance depenetration did not end at a valid capsule position');

console.log(`caveentrance PASS · swept 10/20/60Hz · handoff ${maxFloorDelta.toFixed(4)}m · wall ${wallHit.x.toFixed(2)}m · recovery`);
