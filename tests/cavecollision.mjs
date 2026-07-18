import assert from 'node:assert/strict';
import { generateCaveGraph } from '../src/cavegen.mjs';
import {
  CAVE_PLAYER_HEIGHT,
  CAVE_PLAYER_CROUCH_HEIGHT,
  CAVE_PLAYER_RADIUS,
  CAVE_PLAYER_SKIN,
  CAVE_CAMERA_SKIN,
  cavePortalInside,
  createCaveField,
} from '../src/cavefield.mjs';
import { createCaveVisualFieldSampler } from '../src/cavemesh.mjs';

const runtimeCapsule = {
  maxSubstep: 0.20,
  radius: CAVE_PLAYER_RADIUS,
  height: CAVE_PLAYER_HEIGHT,
  skin: CAVE_PLAYER_SKIN,
  maxStep: 0.50,
  maxDrop: 1.05,
};

const graph = generateCaveGraph(0x51deca7e);
const field = createCaveField(graph);
const mouth = field.entrance.b;

// A real generated keyhole that previously looked open but stopped the fixed
// standing capsule 0.84m before the next chamber. Automatic stance selection
// must lower only as much as needed and complete the same off-centre route.
{
  const keyholeGraph = generateCaveGraph(1);
  const keyholeField = createCaveField(keyholeGraph);
  const visualField = createCaveVisualFieldSampler(keyholeField, 48);
  const edge = keyholeGraph.edges.find((candidate) => candidate.id === 'e2');
  assert.equal(edge?.profile, 'keyhole', 'auto-crouch fixture is no longer a keyhole');
  const nodes = new Map(keyholeGraph.nodes.map((node) => [node.id, node]));
  const a = nodes.get(edge.a), b = nodes.get(edge.b);
  const dx = b.p[0] - a.p[0], dz = b.p[2] - a.p[2];
  const length = Math.hypot(dx, dz) || 1;
  const pointAt = (t) => ({
    x: a.p[0] + dx * t + dz / length * 1.2,
    z: a.p[2] + dz * t - dx / length * 1.2,
    referenceY: a.p[1] + (b.p[1] - a.p[1]) * t
      - (edge.ryA + (edge.ryB - edge.ryA) * t) + 0.2,
  });

  // The ideal analytic surface and medium-quality Float32 tetra lattice do
  // not have an identical zero set. This off-centre eye point is visibly air
  // in the actual mesh but was previously rejected by analytic camera
  // collision, producing a literal invisible wall.
  const meshAir = pointAt(0.25);
  meshAir.x = a.p[0] + dx * 0.25 + dz / length * 1.5;
  meshAir.z = a.p[2] + dz * 0.25 - dx / length * 1.5;
  const meshAirFloor = keyholeField.floorHeightNear(
    meshAir.x, meshAir.z, meshAir.referenceY, 3, 3,
  );
  const meshAirEyeY = meshAirFloor + 1.70;
  assert.ok(keyholeField.sdf(meshAir.x, meshAirEyeY, meshAir.z) > 0,
    'visual-lattice fixture is no longer analytic rock');
  assert.ok(visualField(meshAir.x, meshAirEyeY, meshAir.z) < -CAVE_CAMERA_SKIN,
    'visual-lattice fixture is no longer visibly open');
  assert.equal(keyholeField.bodyFits(
    meshAir.x, meshAir.z, meshAirFloor,
    CAVE_PLAYER_RADIUS, CAVE_PLAYER_HEIGHT, CAVE_PLAYER_SKIN,
  ), false, 'analytic camera field unexpectedly admits the mismatch fixture');
  assert.equal(keyholeField.bodyFits(
    meshAir.x, meshAir.z, meshAirFloor,
    CAVE_PLAYER_RADIUS, CAVE_PLAYER_HEIGHT, CAVE_PLAYER_SKIN, visualField,
  ), true, 'mesh-consistent camera field still blocks visibly open air');

  const meshSolid = pointAt(0.25);
  meshSolid.x = a.p[0] + dx * 0.25 + dz / length * 1.8;
  meshSolid.z = a.p[2] + dz * 0.25 - dx / length * 1.8;
  const meshSolidFloor = keyholeField.floorHeightNear(
    meshSolid.x, meshSolid.z, meshSolid.referenceY, 3, 3,
  );
  assert.ok(visualField(meshSolid.x, meshSolidFloor + 1.70, meshSolid.z) >= -CAVE_CAMERA_SKIN,
    'visual solid-wall neighbor unexpectedly opened');
  assert.equal(keyholeField.bodyFits(
    meshSolid.x, meshSolid.z, meshSolidFloor,
    CAVE_PLAYER_RADIUS, CAVE_PLAYER_HEIGHT, CAVE_PLAYER_SKIN, visualField,
  ), false, 'mesh-consistent camera field permits a rendered wall');

  const visualStart = pointAt(0.18), visualTarget = pointAt(0.26);
  visualStart.x = a.p[0] + dx * 0.18 + dz / length * 1.5;
  visualStart.z = a.p[2] + dz * 0.18 - dx / length * 1.5;
  visualTarget.x = a.p[0] + dx * 0.26 + dz / length * 1.5;
  visualTarget.z = a.p[2] + dz * 0.26 - dx / length * 1.5;
  const visualStartFloor = keyholeField.floorHeightNear(
    visualStart.x, visualStart.z, visualStart.referenceY, 3, 3,
  );
  const visuallyResolved = keyholeField.resolveHorizontal(
    visualStart.x, visualStart.z, visualTarget.x, visualTarget.z, visualStartFloor,
    { ...runtimeCapsule, crouchHeight: CAVE_PLAYER_HEIGHT, cameraField: visualField },
  );
  assert.ok(Math.hypot(
    visuallyResolved.x - visualTarget.x, visuallyResolved.z - visualTarget.z,
  ) < 0.05, 'mesh-consistent resolver still snags in visibly open keyhole air');
  const tight = pointAt(0.5);
  const tightFloor = keyholeField.floorHeightNear(
    tight.x, tight.z, tight.referenceY, 3, 3,
  );
  assert.notEqual(tightFloor, null, 'keyhole crouch fixture has no floor');
  assert.equal(keyholeField.bodyFits(
    tight.x, tight.z, tightFloor,
    CAVE_PLAYER_RADIUS, CAVE_PLAYER_HEIGHT, CAVE_PLAYER_SKIN,
  ), false, 'keyhole fixture no longer rejects standing height');
  assert.equal(keyholeField.bodyFits(
    tight.x, tight.z, tightFloor,
    CAVE_PLAYER_RADIUS, CAVE_PLAYER_CROUCH_HEIGHT, CAVE_PLAYER_SKIN,
  ), true, 'keyhole fixture does not admit crouched height');

  const start = pointAt(0.35), target = pointAt(0.65);
  const startFloor = keyholeField.floorHeightNear(
    start.x, start.z, start.referenceY, 3, 3,
  );
  const crouched = keyholeField.resolveHorizontal(
    start.x, start.z, target.x, target.z, startFloor, runtimeCapsule,
  );
  assert.ok(Math.hypot(crouched.x - target.x, crouched.z - target.z) < 0.05,
    'automatic crouch did not clear the generated keyhole');
  assert.equal(crouched.crouched, true, 'keyhole traversal did not report a lowered stance');
  assert.ok(crouched.stanceHeight >= CAVE_PLAYER_CROUCH_HEIGHT
    && crouched.stanceHeight < CAVE_PLAYER_HEIGHT,
  'automatic crouch did not choose a safe adaptive stance');
}

// A severe off-centre keyhole shoulder that accepted only 4.4m of a 12.4m
// held-forward walk before route-first centering. Keep this frame-sized: a
// fixed endpoint test cannot model how WASD advances from each accepted pose.
{
  const graph = generateCaveGraph(12);
  const field = createCaveField(graph);
  const visualField = createCaveVisualFieldSampler(field, 48);
  const edge = graph.edges.find((candidate) => candidate.id === 'e5');
  assert.equal(edge?.profile, 'keyhole', 'route-centering fixture is no longer a keyhole');
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const a = nodes.get(edge.a), b = nodes.get(edge.b);
  const dx = b.p[0] - a.p[0], dz = b.p[2] - a.p[2];
  const length = Math.hypot(dx, dz) || 1;
  const ux = dx / length, uz = dz / length;
  const px = -uz, pz = ux;
  const t = 0.08, side = -1.2;
  let x = a.p[0] + dx * t + px * side;
  let z = a.p[2] + dz * t + pz * side;
  const referenceY = a.p[1] + (b.p[1] - a.p[1]) * t
    - (edge.ryA + (edge.ryB - edge.ryA) * t) + 0.2;
  let floor = field.floorHeightNear(x, z, referenceY, 3, 3);
  assert.notEqual(floor, null, 'route-centering fixture has no floor');
  const startX = x, startZ = z;
  const expected = length * 0.84;
  const frames = Math.ceil(expected / 0.1);
  for (let frame = 0; frame < frames; frame++) {
    const resolved = field.resolveHorizontal(
      x, z, x + ux * 0.1, z + uz * 0.1, floor,
      { ...runtimeCapsule, cameraField: visualField },
    );
    x = resolved.x; z = resolved.z; floor = resolved.floorY;
  }
  const progress = (x - startX) * ux + (z - startZ) * uz;
  assert.ok(progress > expected - 0.35,
    `route-centering keyhole stopped ${Math.max(0, expected - progress).toFixed(2)}m short`);
}

// Regression for invisible collision teeth: navigation is explicitly the
// union of the calmer capsule corridor and rendered air, so anything visibly
// open must also be navigable.
{
  const visibleGraph = generateCaveGraph(78);
  const visibleField = createCaveField(visibleGraph);
  const edge = visibleGraph.edges.find((candidate) => candidate.id === 'e5');
  const a = visibleGraph.nodes.find((node) => node.id === edge.a);
  const b = visibleGraph.nodes.find((node) => node.id === edge.b);
  const t = 1 / 12;
  const dx = b.p[0] - a.p[0], dz = b.p[2] - a.p[2];
  const length = Math.hypot(dx, dz) || 1;
  const x = a.p[0] + (b.p[0] - a.p[0]) * t + dz / length * 1.2;
  const y = a.p[1] + (b.p[1] - a.p[1]) * t + 0.34 - (edge.ry ?? 3);
  const z = a.p[2] + (b.p[2] - a.p[2]) * t - dx / length * 1.2;
  const visible = visibleField.sdf(x, y, z);
  assert.ok(visible < -CAVE_PLAYER_SKIN, 'invisible-collision fixture is no longer visibly open');
  assert.ok(visibleField.sdfNavigable(x, y, z) <= visible + 1e-9,
    'navigation protrudes into visibly open cave space');
}

for (const hz of [10, 20, 60]) {
  let x = 0, z = mouth[2] - 1.25;
  let floor = field.floorHeight(x, z);
  let sawBlock = false;
  for (let frame = 0; frame < hz; frame++) {
    const targetX = x + 10.5 / hz;
    const result = field.resolveHorizontal(x, z, targetX, z, floor, runtimeCapsule);
    x = result.x; z = result.z; floor = result.floorY;
    sawBlock ||= result.blocked;
    assert.ok(field.bodyFits(
      x, z, floor, CAVE_PLAYER_RADIUS, CAVE_PLAYER_HEIGHT, CAVE_PLAYER_SKIN,
    ), `${hz}Hz resolver left the capsule outside the cave`);
  }
  assert.ok(sawBlock, `${hz}Hz sprint never contacted the wall`);
  assert.ok(x < field.entrance.rx, `${hz}Hz sprint tunnelled through the entrance wall (${x.toFixed(2)}m)`);
}

const slideZ = mouth[2] - 0.75;
const slideFloor = field.floorHeight(0, slideZ);
const slide = field.resolveHorizontal(0, slideZ, 10, slideZ + 5, slideFloor, runtimeCapsule);
assert.ok(slide.blocked, 'oblique wall approach should make contact');
assert.ok(slide.z > slideZ + 3.0, 'oblique wall contact should retain tangential motion');
assert.ok(slide.x < field.entrance.rx, 'oblique wall slide escaped through the wall');
assert.ok(field.bodyFits(
  slide.x, slide.z, slide.floorY, CAVE_PLAYER_RADIUS, CAVE_PLAYER_HEIGHT, CAVE_PLAYER_SKIN,
), 'wall slide ended without capsule clearance');

// Find the first invalid point just beyond this fixture's walkable side-wall
// boundary. This represents a shallow handoff/numerical penetration, not an
// artificial spawn near the solid wall's centreline.
let embeddedX = null, embeddedFloor = null;
for (let candidateX = 0; candidateX < field.entrance.rx; candidateX += 0.02) {
  const candidateFloor = field.floorHeight(candidateX, slideZ);
  if (candidateFloor === null) continue;
  if (!field.bodyFits(
    candidateX, slideZ, candidateFloor,
    CAVE_PLAYER_RADIUS, CAVE_PLAYER_HEIGHT, CAVE_PLAYER_SKIN,
  )) {
    embeddedX = candidateX;
    embeddedFloor = candidateFloor;
    break;
  }
}
assert.notEqual(embeddedX, null, 'embedded cave recovery fixture has no side-wall boundary');
assert.notEqual(embeddedFloor, null, 'embedded cave recovery fixture has no floor');
assert.equal(field.bodyFits(
  embeddedX, slideZ, embeddedFloor,
  CAVE_PLAYER_RADIUS, CAVE_PLAYER_HEIGHT, CAVE_PLAYER_SKIN,
), false,
  'embedded cave recovery fixture is unexpectedly valid');
const recovered = field.resolveHorizontal(
  embeddedX, slideZ, 0.5, slideZ, embeddedFloor, runtimeCapsule,
);
assert.equal(recovered.recovered, true, 'cave capsule did not recover from an embedded start');
assert.ok(recovered.x < embeddedX - 0.2, 'cave recovery did not return toward open passage');
assert.ok(field.bodyFits(
  recovered.x, recovered.z, recovered.floorY,
  CAVE_PLAYER_RADIUS, CAVE_PLAYER_HEIGHT, CAVE_PLAYER_SKIN,
),
  'cave recovery did not end at a valid capsule position');

const mz = mouth[2];
let inside = false;
inside = cavePortalInside(inside, mz + 0.6, mz, true);
assert.equal(inside, false, 'portal entered before the inward hysteresis threshold');
inside = cavePortalInside(inside, mz + 1.3, mz, false);
assert.equal(inside, false, 'portal entered before entrance chunks were ready');
inside = cavePortalInside(inside, mz + 1.3, mz, true);
assert.equal(inside, true, 'portal did not enter after crossing a ready threshold');
inside = cavePortalInside(inside, mz, mz, true);
assert.equal(inside, true, 'portal flickered while inside the hysteresis band');
inside = cavePortalInside(inside, mz - 0.7, mz, true);
assert.equal(inside, false, 'portal did not return to the surface after crossing outward');

console.log(`cavecollision PASS · swept 10/20/60Hz · slide ${(slide.z - slideZ).toFixed(2)}m · recovery · hysteresis`);
