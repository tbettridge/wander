import assert from 'node:assert/strict';
import { generateCaveGraph } from '../src/cavegen.mjs';
import { CAVE_HALF_EXTENT, createCaveField } from '../src/cavefield.mjs';

const graph = generateCaveGraph(0xdecafbad);
const field = createCaveField(graph);

for (const chamber of field.chambers) {
  assert.ok(field.sdf(...chamber.c) < 0, `chamber ${chamber.id} should be air`);
}
for (const passage of field.passages) {
  const mid = passage.a.map((value, axis) => (value + passage.b[axis]) * 0.5);
  assert.ok(field.sdf(...mid) < 0, `passage ${passage.id} should be air`);
}

// Phase 2 no longer seals caves inside the legacy ±40m cube. The graph volume
// follows its finite primitives, and should return to solid rock beyond every
// side except the deliberately infinite outward entrance ray.
const center = field.volume.min.map((value, axis) => (value + field.volume.max[axis]) * 0.5);
for (const p of [
  [field.volume.min[0] - 3, center[1], center[2]],
  [field.volume.max[0] + 3, center[1], center[2]],
  [center[0], field.volume.min[1] - 3, center[2]],
  [center[0], field.volume.max[1] + 3, center[2]],
  [center[0], center[1], field.volume.max[2] + 3],
]) assert.ok(field.sdf(...p) > 0, `outside graph volume ${p.join(',')} should be solid`);

// Spatial acceleration must remain representation-identical anywhere a cave
// primitive can affect the visible zero surface.
for (const passage of field.passages) {
  const mid = passage.a.map((value, axis) => (value + passage.b[axis]) * 0.5);
  assert.ok(Math.abs(field.sdf(...mid) - field.sdfFull(...mid)) < 1e-9,
    `accelerated passage field drifted at ${passage.id}`);
}
for (const chamber of field.chambers) {
  assert.ok(Math.abs(field.sdf(...chamber.c) - field.sdfFull(...chamber.c)) < 1e-9,
    `accelerated chamber field drifted at ${chamber.id}`);
  const floor = field.floorHeightNear(chamber.c[0], chamber.c[2], chamber.floorY + 0.1, 3, 3);
  assert.notEqual(floor, null, `chamber ${chamber.id} has no floor shelf`);
  assert.ok(field.bodyFits(chamber.c[0], chamber.c[2], floor), `chamber ${chamber.id} floor lacks standing clearance`);
}

const entrance = field.entrance;
assert.ok(entrance, 'generated field should expose its entrance contract');
assert.ok(field.sdf(entrance.b[0], entrance.b[1], -CAVE_HALF_EXTENT) < 0,
  'entrance ray should open through the -Z boundary');
assert.ok(field.sdf(entrance.rx + 3.0, entrance.b[1], -CAVE_HALF_EXTENT) > 0,
  'the -Z boundary should remain solid outside the entrance aperture');
const mouthFloor = field.floorHeight(entrance.b[0], entrance.b[2]);
assert.notEqual(mouthFloor, null, 'entrance mouth should have a floor');
assert.ok(field.bodyFits(entrance.b[0], entrance.b[2], mouthFloor), 'entrance mouth should fit the player capsule');

let previousEntranceFloor = field.floorHeight(0, -CAVE_HALF_EXTENT + 0.5);
for (let z = -CAVE_HALF_EXTENT + 1; z <= graph.nodes[0].p[2]; z += 0.5) {
  const floor = field.floorHeightNear(0, z, previousEntranceFloor, 0.5, 1.0);
  assert.notEqual(floor, null, `entrance continuity failed at z=${z}`);
  assert.ok(field.bodyFits(0, z, floor), `entrance capsule clearance failed at z=${z}`);
  previousEntranceFloor = floor;
}

const slideStartZ = entrance.b[2] - 1;
const slideStartFloor = field.floorHeight(0, slideStartZ);
const wallHit = field.resolveHorizontal(0, slideStartZ, 12, slideStartZ, slideStartFloor, { maxSubstep: 0.2 });
assert.ok(wallHit.blocked, 'swept collision should report a wall hit');
assert.ok(wallHit.x < entrance.rx, 'swept collision should prevent tunnelling through the entrance wall');
assert.ok(wallHit.acceptedDistance > 0, 'wall collision should retain accepted motion up to contact');

const spawn = field.spawnLocal;
const spawnFloor = field.floorHeight(spawn.x, spawn.z);
assert.notEqual(spawnFloor, null, 'generated entrance should have an implicit floor');
assert.ok(field.bodyFits(spawn.x, spawn.z, spawnFloor), 'generated entrance should have standing clearance');

for (let seed = 0; seed < 96; seed++) {
  const generated = createCaveField(generateCaveGraph(seed));
  const floor = generated.floorHeight(generated.spawnLocal.x, generated.spawnLocal.z);
  assert.notEqual(floor, null, `seed ${seed} has no spawn floor`);
  assert.ok(generated.bodyFits(generated.spawnLocal.x, generated.spawnLocal.z, floor), `seed ${seed} has no spawn clearance`);
  const generatedMouth = generated.entrance.b;
  const generatedMouthFloor = generated.floorHeight(generatedMouth[0], generatedMouth[2]);
  assert.notEqual(generatedMouthFloor, null, `seed ${seed} has no entrance floor`);
  assert.ok(generated.bodyFits(generatedMouth[0], generatedMouth[2], generatedMouthFloor), `seed ${seed} has no entrance clearance`);
}

// Exercise the generated main route through the exact runtime capsule solver,
// including descending room shelves and passage-to-passage handoffs. A mesh
// can be watertight while an undercut floor still makes a room unreachable.
for (const seed of [...Array.from({ length: 128 }, (_, index) => index), 365, 639, 804, 930]) {
  const routeGraph = generateCaveGraph(seed);
  const routeField = createCaveField(routeGraph);
  const nodes = new Map(routeGraph.nodes.map((node) => [node.id, node]));
  let current = nodes.get(routeGraph.mainPath[0]);
  let floor = routeField.floorHeightNear(current.p[0], current.p[2], current.p[1] - 3, 5, 5);
  assert.notEqual(floor, null, `seed ${seed} main route has no initial floor`);
  for (let index = 1; index < routeGraph.mainPath.length; index++) {
    const next = nodes.get(routeGraph.mainPath[index]);
    const resolved = routeField.resolveHorizontal(
      current.p[0], current.p[2], next.p[0], next.p[2], floor,
      { maxSubstep: 0.20, radius: 0.30, height: 1.72, skin: 0.035, maxStep: 0.50, maxDrop: 1.05 },
    );
    const remaining = Math.hypot(resolved.x - next.p[0], resolved.z - next.p[2]);
    assert.ok(remaining < 0.45,
      `seed ${seed} ${routeGraph.archetype} route blocked at ${current.id}→${next.id} (${remaining.toFixed(2)}m short)`);
    current = next;
    floor = resolved.floorY;
  }
  if (seed < 32) {
    for (const edge of routeGraph.edges) {
      for (const reverse of [false, true]) {
        const from = nodes.get(reverse ? edge.b : edge.a);
        const to = nodes.get(reverse ? edge.a : edge.b);
        const endpointRy = reverse ? edge.ryB : edge.ryA;
        const edgeFloor = routeField.floorHeightNear(
          from.p[0], from.p[2], from.p[1] - endpointRy, 5, 5,
        );
        assert.notEqual(edgeFloor, null, `seed ${seed} edge ${edge.id} has no endpoint floor`);
        const resolved = routeField.resolveHorizontal(
          from.p[0], from.p[2], to.p[0], to.p[2], edgeFloor,
          { maxSubstep: 0.20, radius: 0.30, height: 1.72, skin: 0.035, maxStep: 0.50, maxDrop: 1.05 },
        );
        const remaining = Math.hypot(resolved.x - to.p[0], resolved.z - to.p[2]);
        assert.ok(remaining < 0.45,
          `seed ${seed} edge ${edge.id}${reverse ? ' reverse' : ''} blocked (${remaining.toFixed(2)}m short)`);
      }
    }
  }
}

const signature = field.hashField(32);
assert.equal(signature, field.hashField(32), 'field generation should be deterministic');
console.log(`cavefield PASS · mouth ${mouthFloor.toFixed(2)}m · floor ${spawnFloor.toFixed(2)}m · signature ${signature}`);
