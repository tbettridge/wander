import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import {
  caveAnchorsAround,
  caveGraphSignature,
  generateCaveGraph,
  validateCaveGraph,
} from '../src/cavegen.mjs';
import { createCaveField } from '../src/cavefield.mjs';
import { caveCoverReport, fitCaveToTerrain } from '../src/cavefit.mjs';
import { createCaveChunkPlan } from '../src/cavemesh.mjs';

const world = new World(20260612);
const anchors = caveAnchorsAround(world, -4129, -809, world.seed, 22000, []);

function fittingContext(anchor) {
  const graph = generateCaveGraph(anchor.seed);
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

const steepAnchor = anchors.find((anchor) => anchor.id === 'cave:-2:2');
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
      { maxSubstep: 0.20, radius: 0.30, height: 1.72, skin: 0.035, maxStep: 0.50, maxDrop: 1.05 },
    );
    const remaining = Math.hypot(resolved.x - to.p[0], resolved.z - to.p[2]);
    assert.ok(remaining < 0.45, `fitted edge ${edge.id}${reverse ? ' reverse' : ''} blocked`);
  }
}

// Multi-level graphs: sweep the real capsule along every edge in both
// directions — the acceptance contract that helix connectors and stacked
// sections are walkable without jumping or crouching.
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
        { maxSubstep: 0.20, radius: 0.30, height: 1.72, skin: 0.035, maxStep: 0.50, maxDrop: 1.05 },
      );
      const remaining = Math.hypot(resolved.x - to.p[0], resolved.z - to.p[2]);
      assert.ok(remaining < 0.45, `${label} edge ${edge.id}${reverse ? ' reverse' : ''} blocked (${remaining.toFixed(2)}m short)`);
    }
  }
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

const coveredAnchor = anchors.find((anchor) => anchor.id === 'cave:-7:1');
assert.ok(coveredAnchor, 'expected covered showcase cave anchor');
const covered = fittingContext(coveredAnchor);
const unchanged = fitCaveToTerrain(covered.graph, covered.surfaceYAt);
assert.equal(unchanged.terrainFit.angleDegrees, 0, 'already-covered cave should not bend');
assert.equal(unchanged.terrainFit.drop, 0, 'already-covered cave should not deepen');

console.log(`cavefit PASS · cover ${rawCover.minCover.toFixed(1)}→${fittedA.terrainFit.minCover.toFixed(1)}m · bend ${fittedA.terrainFit.angleDegrees.toFixed(0)}° · drop ${fittedA.terrainFit.drop.toFixed(1)}m`
  + ` · walked 2-level seed ${walkedTwoLevel} + 3-level seed ${walkedThreeLevel} · geologies ${walkedGeologies.join('/')}`);
