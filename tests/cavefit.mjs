import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import {
  caveAnchorForCell,
  caveAnchorsAround,
  caveReliefAt,
  caveGraphSignature,
  generateCaveGraph,
  validateCaveGraph,
} from '../src/cavegen.mjs';
import {
  CAVE_PLAYER_CROUCH_HEIGHT,
  CAVE_PLAYER_HEIGHT,
  CAVE_PLAYER_RADIUS,
  CAVE_PLAYER_SKIN,
  createCaveField,
} from '../src/cavefield.mjs';
import { caveCoverReport, fitCaveToTerrain } from '../src/cavefit.mjs';
import { createCaveChunkPlan, createCaveVisualFieldSampler } from '../src/cavemesh.mjs';

const runtimeCapsule = {
  maxSubstep: 0.20,
  radius: CAVE_PLAYER_RADIUS,
  height: CAVE_PLAYER_HEIGHT,
  skin: CAVE_PLAYER_SKIN,
  maxStep: 0.50,
  maxDrop: 1.05,
};

const world = new World(20260612);
const anchors = caveAnchorsAround(world, -4129, -809, world.seed, 22000, []);

function fittingContext(anchor, generationOptions = {}) {
  const graph = generateCaveGraph(anchor.seed, generationOptions);
  const field = createCaveField(graph);
  const mouth = graph.entrance.mouth;
  const cos = Math.cos(anchor.yaw), sin = Math.sin(anchor.yaw);
  const mouthWorldX = cos * mouth[0] + sin * mouth[2];
  const mouthWorldZ = -sin * mouth[0] + cos * mouth[2];
  const mouthFloor = field.floorHeight(mouth[0], mouth[2]);
  const inset = Math.max(1.8, Math.min(3.2, anchor.coverRise * 0.18 + anchor.slope * 2));
  const origin = {
    x: anchor.x - mouthWorldX,
    y: anchor.surfaceY - inset - mouthFloor,
    z: anchor.z - mouthWorldZ,
  };
  const surfaceYAt = (x, z) => world.height(
    origin.x + cos * x + sin * z,
    origin.z - sin * x + cos * z,
  ) - origin.y;
  return { graph, field, origin, surfaceYAt };
}

const steepAnchor = anchors.find((anchor) => anchor.id === 'cave:-5:-9');
assert.ok(steepAnchor, 'expected steep showcase cave anchor');
const steep = fittingContext(steepAnchor);
const rawCover = caveCoverReport(steep.graph, steep.surfaceYAt);
assert.ok(rawCover.minCover < 0, 'cover regression fixture no longer exposes an unfitted cave');

const fittedA = fitCaveToTerrain(steep.graph, steep.surfaceYAt);
const fittedB = fitCaveToTerrain(steep.graph, steep.surfaceYAt);
assert.equal(caveGraphSignature(fittedA), caveGraphSignature(fittedB), 'terrain fit is not deterministic');
assert.deepEqual(fittedA, fittedB, 'terrain fit graph object is not deterministic');
assert.deepEqual(fittedA.entrance, steep.graph.entrance, 'terrain fit changed the approved entrance');
assert.deepEqual(fittedA.nodes.slice(0, 2), steep.graph.nodes.slice(0, 2), 'terrain fit changed the first passage');
assert.ok(fittedA.terrainFit.achieved, 'terrain fit did not achieve its cover target');
assert.ok(fittedA.terrainFit.minCover >= fittedA.terrainFit.targetCover, 'terrain fit cover metadata');
assert.ok(validateCaveGraph(fittedA).valid, 'terrain-fitted graph is invalid');
assert.ok(createCaveChunkPlan(fittedA, 48).length < 256, 'terrain fit exceeded sparse streaming cap');

const fittedField = createCaveField(fittedA);
const nodes = new Map(fittedA.nodes.map((node) => [node.id, node]));
for (const edge of fittedA.edges) {
  for (const reverse of [false, true]) {
    const from = nodes.get(reverse ? edge.b : edge.a);
    const to = nodes.get(reverse ? edge.a : edge.b);
    const endpointRy = reverse ? edge.ryB : edge.ryA;
    const floor = fittedField.floorHeightNear(from.p[0], from.p[2], from.p[1] - endpointRy, 5, 5);
    assert.notEqual(floor, null, `fitted edge ${edge.id} has no floor`);
    const resolved = fittedField.resolveHorizontal(
      from.p[0], from.p[2], to.p[0], to.p[2], floor,
      runtimeCapsule,
    );
    const remaining = Math.hypot(resolved.x - to.p[0], resolved.z - to.p[2]);
    assert.ok(remaining < 0.45, `fitted edge ${edge.id}${reverse ? ' reverse' : ''} blocked`);
  }
}

// Multi-level graphs: sweep the real capsule along every edge in both
// directions — the acceptance contract that helix connectors and stacked
// sections are walkable without jumping (tight authored profiles may duck).
function walkAllEdges(graph, label) {
  const walkField = createCaveField(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    for (const reverse of [false, true]) {
      const from = byId.get(reverse ? edge.b : edge.a);
      const to = byId.get(reverse ? edge.a : edge.b);
      const endpointRy = reverse ? edge.ryB : edge.ryA;
      const floor = walkField.floorHeightNear(from.p[0], from.p[2], from.p[1] - endpointRy, 5, 5);
      assert.notEqual(floor, null, `${label} edge ${edge.id} has no floor`);
      const resolved = walkField.resolveHorizontal(
        from.p[0], from.p[2], to.p[0], to.p[2], floor,
        runtimeCapsule,
      );
      const remaining = Math.hypot(resolved.x - to.p[0], resolved.z - to.p[2]);
      assert.ok(remaining < 0.45, `${label} edge ${edge.id}${reverse ? ' reverse' : ''} blocked (${remaining.toFixed(2)}m short)`);
    }
  }
}

// The first cave exposed by "approach seamless entrance" is a permanent QA
// fixture.  Exercise the exact runtime graph (including biome/hill-class
// grammar and terrain fit) through every chamber handoff so a blocked first
// chamber cannot hide behind the broader random-graph coverage below.
const firstDebugAnchor = caveAnchorForCell(world, -2, -1, world.seed);
assert.ok(firstDebugAnchor?.valid, 'first debug cave anchor is no longer valid');
const firstDebugContext = fittingContext(firstDebugAnchor, {
  biome: firstDebugAnchor.biome,
  hillClass: caveReliefAt(world, firstDebugAnchor.x, firstDebugAnchor.z) < 26 ? 'low' : 'high',
});
const firstDebugGraph = fitCaveToTerrain(firstDebugContext.graph, firstDebugContext.surfaceYAt);
walkAllEdges(firstDebugGraph, 'first debug cave');

// Exact off-centre first-cave convergence reported in playtesting. One
// direction needs adaptive keyhole headroom; the reverse direction loses its
// upper chamber shelf and must continue onto the lower route floor. Simulate
// frame-sized held-forward input so route centering and floor continuity are
// exercised the same way as PlayerControls, not as a single endpoint jump.
{
  const field = createCaveField(firstDebugGraph);
  const chamber = firstDebugGraph.chambers.find((candidate) => candidate.id === 'c2');
  const edge = firstDebugGraph.edges.find((candidate) => candidate.id === 'e4');
  assert.ok(chamber && edge?.profile === 'keyhole', 'first-cave convergence fixture drifted');
  const nodes = new Map(firstDebugGraph.nodes.map((node) => [node.id, node]));
  const other = nodes.get(edge.a === chamber.nodeId ? edge.b : edge.a);
  const dx = other.p[0] - chamber.c[0], dz = other.p[2] - chamber.c[2];
  const length = Math.hypot(dx, dz) || 1;
  const ux = dx / length, uz = dz / length;
  const px = -uz, pz = ux;
  const chamberSide = {
    x: chamber.c[0] + px * -1.4,
    z: chamber.c[2] + pz * -1.4,
  };
  const passageSide = {
    x: chamberSide.x + dx * 0.55,
    z: chamberSide.z + dz * 0.55,
  };
  const holdForward = (start, dirX, dirZ, referenceY, frames = 100) => {
    let x = start.x, z = start.z;
    let floor = field.floorHeightNear(x, z, referenceY, 5, 5);
    assert.notEqual(floor, null, 'first-cave convergence has no initial floor');
    const initialFloor = floor;
    let ducked = false, accepted = 0;
    for (let frame = 0; frame < frames; frame++) {
      const result = field.resolveHorizontal(
        x, z, x + dirX * 0.1, z + dirZ * 0.1, floor, runtimeCapsule,
      );
      x = result.x; z = result.z; floor = result.floorY;
      accepted += result.acceptedDistance;
      ducked ||= result.crouched;
    }
    return { x, z, floor, initialFloor, ducked, accepted };
  };
  const intoPassage = holdForward(chamberSide, ux, uz, chamber.floorY);
  assert.ok(intoPassage.accepted > 9.2,
    `first-cave keyhole remained sticky (${intoPassage.accepted.toFixed(2)}m/10m)`);
  assert.equal(intoPassage.ducked, true, 'first-cave keyhole never selected a lowered stance');

  const intoChamber = holdForward(passageSide, -ux, -uz, other.p[1]);
  assert.ok(intoChamber.accepted > 9.2,
    `first-cave floor handoff remained sticky (${intoChamber.accepted.toFixed(2)}m/10m)`);
  assert.ok(intoChamber.initialFloor - intoChamber.floor > 2,
    'first-cave convergence did not retain its lower route-floor handoff');
}

// Exact natural held-forward paths reported in the two debug caves. These are
// deliberately not isolated edge sweeps: each line cuts across a smooth-union
// junction as a player aiming at the visible doorway does, preserving the
// off-axis floor/body state from one 6cm frame to the next.
{
  const pointOnEdge = (graph, edgeId, t, offset = 0) => {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const edge = graph.edges.find((candidate) => candidate.id === edgeId);
    assert.ok(edge, `missing held-forward edge ${edgeId}`);
    const a = nodes.get(edge.a).p, b = nodes.get(edge.b).p;
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const length = Math.hypot(dx, dz) || 1;
    const ryA = edge.ryA ?? edge.ry, ryB = edge.ryB ?? edge.ry;
    return {
      x: a[0] + dx * t - dz / length * offset,
      z: a[2] + dz * t + dx / length * offset,
      referenceY: a[1] + (b[1] - a[1]) * t - (ryA + (ryB - ryA) * t),
    };
  };
  const holdToward = (graph, start, target) => {
    const field = createCaveField(graph);
    const visualField = createCaveVisualFieldSampler(field, 48);
    let x = start.x, z = start.z;
    let floor = field.floorHeightNear(x, z, start.referenceY, 6, 6);
    assert.notEqual(floor, null, 'held-forward fixture has no initial floor');
    const initialFloor = floor;
    let accepted = 0, frames = 0, zeroFrames = 0;
    let ducked = false, assisted = false;
    while (Math.hypot(target.x - x, target.z - z) > 0.15 && frames++ < 600) {
      const remaining = Math.hypot(target.x - x, target.z - z);
      const result = field.resolveHorizontal(
        x,
        z,
        x + (target.x - x) / remaining * 0.06,
        z + (target.z - z) / remaining * 0.06,
        floor,
        {
          ...runtimeCapsule,
          crouchHeight: CAVE_PLAYER_CROUCH_HEIGHT,
          cameraField: visualField,
        },
      );
      x = result.x; z = result.z; floor = result.floorY;
      accepted += result.acceptedDistance;
      zeroFrames = result.acceptedDistance < 1e-5 ? zeroFrames + 1 : 0;
      ducked ||= result.crouched;
      assisted ||= result.forgiving;
      assert.ok(zeroFrames < 12,
        `held-forward fixture stuck at ${x.toFixed(3)}, ${z.toFixed(3)} (${result.blockReason})`);
    }
    return {
      x, z, floor, initialFloor, accepted, frames, ducked, assisted,
      remaining: Math.hypot(target.x - x, target.z - z),
    };
  };

  // First debug cave: the player's left doorway is e11, not the neighboring
  // e4 keyhole covered above. An overlapping upper crossing ends just before
  // the lower e11 floor, requiring an authored-floor handoff.
  const leftFork = firstDebugGraph.edges.find((edge) => edge.id === 'e11');
  assert.equal(leftFork?.profile, 'keyhole', 'first-cave left-fork fixture drifted');
  const leftResult = holdToward(
    firstDebugGraph,
    pointOnEdge(firstDebugGraph, 'e3', 0.72),
    pointOnEdge(firstDebugGraph, 'e11', 0.75),
  );
  assert.ok(leftResult.remaining < 0.15,
    `first-cave left fork remained blocked (${leftResult.remaining.toFixed(2)}m short)`);
  assert.ok(leftResult.initialFloor - leftResult.floor > 2,
    'first-cave left fork did not transfer to its lower authored floor');
  assert.equal(leftResult.ducked, true, 'first-cave left fork never adapted its stance');

  // Second debug cave: the circuit's e2/e16 split runs nearly parallel and
  // creates a visible medial pocket well outside the magnetic 1.55m band.
  const secondDebugAnchor = caveAnchorForCell(world, -1, -6, world.seed);
  assert.ok(secondDebugAnchor?.valid, 'second debug cave anchor is no longer valid');
  const secondDebugContext = fittingContext(secondDebugAnchor, {
    biome: secondDebugAnchor.biome,
    hillClass: caveReliefAt(world, secondDebugAnchor.x, secondDebugAnchor.z) < 26 ? 'low' : 'high',
  });
  const secondDebugGraph = fitCaveToTerrain(
    secondDebugContext.graph,
    secondDebugContext.surfaceYAt,
  );
  assert.ok(secondDebugGraph.edges.some((edge) => edge.id === 'e16'),
    'second-cave circuit overlap fixture drifted');
  const overlapResult = holdToward(
    secondDebugGraph,
    pointOnEdge(secondDebugGraph, 'e2', 0.38, -2),
    pointOnEdge(secondDebugGraph, 'e3', 0.35, -2),
  );
  assert.ok(overlapResult.remaining < 0.15,
    `second-cave overlap remained blocked (${overlapResult.remaining.toFixed(2)}m short)`);
  assert.equal(overlapResult.assisted, true,
    'second-cave overlap no longer exercises compact envelope collision');
}

let walkedTwoLevel = null, walkedThreeLevel = null;
for (let seed = 0; seed < 2000 && (!walkedTwoLevel || !walkedThreeLevel); seed++) {
  const candidate = generateCaveGraph(seed);
  if (!walkedTwoLevel && candidate.budget.targetLevels === 2) {
    walkAllEdges(candidate, `2-level seed ${seed}`);
    walkedTwoLevel = seed;
  } else if (!walkedThreeLevel && candidate.budget.targetLevels === 3) {
    walkAllEdges(candidate, `3-level seed ${seed}`);
    walkedThreeLevel = seed;
  }
}
assert.notEqual(walkedTwoLevel, null, 'no 2-level graph found to walk');
assert.notEqual(walkedThreeLevel, null, 'no 3-level graph found to walk');

// Shape-language acceptance: every geology's profiles, chamber forms,
// breakdown piles, and stream channels must leave the route walkable.
const walkedGeologies = [];
{
  const pending = new Set(['limestone', 'cathedral', 'boulder', 'grotto', 'fracture']);
  for (let seed = 0; seed < 2000 && pending.size; seed++) {
    const candidate = generateCaveGraph(seed);
    if (!pending.has(candidate.geology)) continue;
    pending.delete(candidate.geology);
    walkAllEdges(candidate, `${candidate.geology} seed ${seed}`);
    walkedGeologies.push(candidate.geology);
  }
  assert.equal(pending.size, 0, `geologies never generated: ${[...pending].join(', ')}`);
  for (const [biome, geology] of [['snow', 'ice'], ['desert', 'volcanic']]) {
    let walked = false;
    for (let seed = 0; seed < 400 && !walked; seed++) {
      const candidate = generateCaveGraph(seed, { biome });
      if (candidate.geology !== geology) continue;
      walkAllEdges(candidate, `${geology} seed ${seed} (${biome})`);
      walkedGeologies.push(geology);
      walked = true;
    }
    assert.ok(walked, `no ${geology} cave generated under ${biome} biome`);
  }
}

const coveredAnchor = anchors.find((anchor) => anchor.id === 'cave:-12:2');
assert.ok(coveredAnchor, 'expected covered showcase cave anchor');
const covered = fittingContext(coveredAnchor);
const unchanged = fitCaveToTerrain(covered.graph, covered.surfaceYAt);
assert.equal(unchanged.terrainFit.angleDegrees, 0, 'already-covered cave should not bend');
assert.equal(unchanged.terrainFit.drop, 0, 'already-covered cave should not deepen');

console.log(`cavefit PASS · cover ${rawCover.minCover.toFixed(1)}→${fittedA.terrainFit.minCover.toFixed(1)}m · bend ${fittedA.terrainFit.angleDegrees.toFixed(0)}° · drop ${fittedA.terrainFit.drop.toFixed(1)}m`
  + ` · walked 2-level seed ${walkedTwoLevel} + 3-level seed ${walkedThreeLevel} · geologies ${walkedGeologies.join('/')}`);
