import assert from 'node:assert/strict';
import {
  CAVE_ARCHETYPES,
  CAVE_GRAPH_VERSION,
  caveAnchorsAround,
  caveGraphSignature,
  deriveCaveVolume,
  generateCaveGraph,
  validateCaveGraph,
} from '../src/cavegen.mjs';

const signatures = new Set();
const archetypes = Object.fromEntries(CAVE_ARCHETYPES.map((name) => [name, 0]));
const routeLengths = [], reliefs = [];
let looped = 0, branched = 0, maxAttempts = 0;
const SAMPLE_COUNT = 1024;
for (let seed = 0; seed < SAMPLE_COUNT; seed++) {
  const a = generateCaveGraph(seed);
  const b = generateCaveGraph(seed);
  const validation = validateCaveGraph(a);
  assert.ok(validation.valid, `seed ${seed}: ${validation.errors.join(', ')}`);
  assert.equal(caveGraphSignature(a), caveGraphSignature(b), `seed ${seed} is not deterministic`);
  if (seed < 32) assert.deepEqual(a, b, `seed ${seed} graph object is not deterministic`);
  assert.equal(a.version, CAVE_GRAPH_VERSION, `seed ${seed} schema version`);
  assert.ok(CAVE_ARCHETYPES.includes(a.archetype), `seed ${seed} archetype`);
  assert.ok(validation.reachable === a.nodes.length, `seed ${seed} is disconnected`);
  assert.ok(a.nodes.length >= 8 && a.nodes.length <= 18, `seed ${seed} node count`);
  assert.ok(validation.chambers >= 4 && validation.chambers <= 7, `seed ${seed} chamber count`);
  assert.ok(validation.loops <= 1, `seed ${seed} loop count`);
  assert.ok(validation.maxGrade <= 0.180001, `seed ${seed} grade`);
  assert.ok(validation.minClearance >= 5.1, `seed ${seed} clearance`);
  assert.ok(validation.mainLength >= 70 && validation.mainLength <= 180, `seed ${seed} main route`);
  assert.ok(validation.farthestRoute >= 70 && validation.farthestRoute <= 180, `seed ${seed} farthest route`);
  assert.ok(validation.verticalRelief >= 8, `seed ${seed} vertical relief`);
  assert.ok(a.entrance && a.entrance.rootNodeId === a.entranceNodeId, `seed ${seed} entrance contract`);
  assert.deepEqual(a.nodes[0].p, [0, 2, -27.5], `seed ${seed} root contract`);
  assert.deepEqual(a.entrance.mouth, [0, 2.15, -36], `seed ${seed} mouth contract`);
  assert.deepEqual(a.entrance.outward, [0, 0, -1], `seed ${seed} outward contract`);
  assert.equal(a.entrance.rx, 4.15, `seed ${seed} entrance rx`);
  assert.equal(a.entrance.ry, 3.15, `seed ${seed} entrance ry`);
  assert.equal(a.mainPath[0], a.entranceNodeId, `seed ${seed} main path root`);
  assert.equal(a.mainPath.at(-1), a.goalNodeId, `seed ${seed} main path goal`);
  assert.equal(new Set(a.mainPath).size, a.mainPath.length, `seed ${seed} main path repeats`);

  const heroes = a.chambers.filter((chamber) => chamber.role === 'hero');
  assert.equal(heroes.length, 1, `seed ${seed} hero count`);
  assert.equal(heroes[0].nodeId, a.goalNodeId, `seed ${seed} hero goal`);
  for (const chamber of a.chambers) {
    assert.ok(Number.isFinite(chamber.yaw), `seed ${seed} chamber yaw`);
    assert.ok(chamber.floorY > chamber.c[1] - chamber.r[1] && chamber.floorY < chamber.c[1], `seed ${seed} chamber shelf`);
    assert.ok(chamber.floorBlend >= 0.25 && chamber.floorBlend <= 1, `seed ${seed} chamber shelf blend`);
    assert.ok(chamber.floorLift >= 0.5 && chamber.floorLift <= 2, `seed ${seed} chamber shelf lift`);
    assert.ok(Math.abs(chamber.connectorRy - (chamber.c[1] - chamber.floorY + chamber.floorLift)) < 0.000002,
      `seed ${seed} chamber connector floor drift`);
  }
  for (const edge of a.edges) {
    assert.ok(['tight', 'standard', 'broad'].includes(edge.widthClass), `seed ${seed} width class`);
    assert.ok(['rxA', 'rxB', 'ryA', 'ryB', 'rx0', 'rx1', 'ry0', 'ry1'].every((key) => Number.isFinite(edge[key]) && edge[key] > 0), `seed ${seed} endpoint taper`);
    assert.deepEqual(
      [edge.rxA, edge.rxB, edge.ryA, edge.ryB],
      [edge.rx0, edge.rx1, edge.ry0, edge.ry1],
      `seed ${seed} taper aliases drift`,
    );
  }
  for (const node of a.nodes) {
    const floorRadii = a.edges.flatMap((edge) => edge.a === node.id ? [edge.ryA] : (edge.b === node.id ? [edge.ryB] : []));
    if (floorRadii.length) assert.ok(Math.max(...floorRadii) - Math.min(...floorRadii) < 0.000002,
      `seed ${seed} node ${node.id} passage floor discontinuity`);
  }

  const beforeVolume = JSON.stringify(a);
  assert.deepEqual(a.volume, deriveCaveVolume(a), `seed ${seed} derived volume`);
  assert.equal(JSON.stringify(a), beforeVolume, `seed ${seed} volume helper mutated graph`);
  assert.deepEqual(a.bounds, a.volume.bounds, `seed ${seed} bounds alias`);
  for (const axis of [0, 1, 2]) {
    assert.equal(Math.abs(a.volume.min[axis] % a.volume.alignment), 0, `seed ${seed} min alignment`);
    assert.equal(Math.abs(a.volume.max[axis] % a.volume.alignment), 0, `seed ${seed} max alignment`);
    assert.ok(a.volume.max[axis] - a.volume.min[axis] <= 256, `seed ${seed} volume budget`);
  }

  if (a.archetype === 'circuit') assert.equal(validation.loops, 1, `seed ${seed} circuit loop`);
  else assert.equal(validation.loops, 0, `seed ${seed} non-circuit loop`);
  if (a.archetype === 'branching') assert.ok(validation.branches >= 2, `seed ${seed} branching choices`);
  if (a.archetype === 'descent') assert.ok(validation.verticalRelief >= 18, `seed ${seed} descent relief`);

  signatures.add(caveGraphSignature(a));
  archetypes[a.archetype]++;
  routeLengths.push(validation.mainLength);
  reliefs.push(validation.verticalRelief);
  if (validation.loops) looped++;
  if (validation.branches) branched++;
  maxAttempts = Math.max(maxAttempts, a.attempt);
}
assert.ok(signatures.size >= SAMPLE_COUNT * 0.995, `insufficient graph diversity: ${signatures.size}/${SAMPLE_COUNT}`);
for (const [name, count] of Object.entries(archetypes)) {
  assert.ok(count >= SAMPLE_COUNT * 0.15 && count <= SAMPLE_COUNT * 0.35, `${name} distribution ${count}/${SAMPLE_COUNT}`);
}
assert.ok(looped >= SAMPLE_COUNT * 0.15, `circuit archetype too rare: ${looped}/${SAMPLE_COUNT}`);
assert.ok(branched >= SAMPLE_COUNT * 0.75, `meaningful choices too rare: ${branched}/${SAMPLE_COUNT}`);
assert.ok(routeLengths.reduce((sum, value) => sum + value, 0) / SAMPLE_COUNT > 110, 'caves did not become materially longer');
assert.ok(reliefs.reduce((sum, value) => sum + value, 0) / SAMPLE_COUNT > 12, 'caves did not gain meaningful verticality');

// The canonical signature deliberately covers every behavior-changing schema
// field, while diagnostic validation output remains outside the cache key.
const signatureBase = generateCaveGraph(0xdecafbad);
const signature = caveGraphSignature(signatureBase);
for (const mutate of [
  (graph) => { graph.archetype = graph.archetype === 'gallery' ? 'descent' : 'gallery'; },
  (graph) => { graph.volume.min[0] -= 8; graph.volume.bounds.minX -= 8; graph.bounds.minX -= 8; },
  (graph) => { graph.edges[0].rxA += 0.01; },
  (graph) => { graph.edges[0].taper.fromRx += 0.01; },
  (graph) => { graph.chambers[0].yaw += 0.01; },
  (graph) => { graph.chambers[0].floorY -= 0.01; },
  (graph) => { graph.chambers[0].role = 'altered-role'; },
  (graph) => { graph.budget.targetMainLength += 0.01; },
]) {
  const changed = structuredClone(signatureBase);
  mutate(changed);
  assert.notEqual(caveGraphSignature(changed), signature, 'signature omitted behavior-changing metadata');
}
const diagnosticOnly = structuredClone(signatureBase);
diagnosticOnly.validation.errors.push('diagnostic-only');
assert.equal(caveGraphSignature(diagnosticOnly), signature, 'validation diagnostics polluted graph signature');

const shifted = structuredClone(signatureBase);
for (const node of shifted.nodes) node.p[1] -= 12;
for (const chamber of shifted.chambers) { chamber.c[1] -= 12; chamber.floorY -= 12; }
const shiftedVolume = deriveCaveVolume(shifted);
assert.notDeepEqual(shiftedVolume.min, signatureBase.volume.min, 'volume did not respond to finalized elevations');

const stubWorld = {
  height(x, z) {
    return 135 + Math.sin(x * 0.006) * 22 + Math.cos(z * 0.005) * 18;
  },
  biomeAt(x, z) {
    return { h: this.height(x, z), slope: 0.12, id: 'tundra', t: -1, m: 0.45 };
  },
  riverAt() { return { wet: false }; },
};
const anchorsA = caveAnchorsAround(stubWorld, 0, 0, 20260612, 12000, []);
const anchorsB = caveAnchorsAround(stubWorld, 0, 0, 20260612, 12000, []);
assert.ok(anchorsA.length > 0, 'placement grammar found no valid anchors');
assert.deepEqual(anchorsA, anchorsB, 'anchor placement is not deterministic');
assert.equal(new Set(anchorsA.map((anchor) => anchor.id)).size, anchorsA.length, 'duplicate canonical anchor id');

console.log(
  `cavegen PASS · ${signatures.size} unique V${CAVE_GRAPH_VERSION} graphs`
  + ` · ${Object.entries(archetypes).map(([name, count]) => `${name} ${count}`).join(' / ')}`
  + ` · ${looped} looped · ${branched} with choices · attempts <=${maxAttempts}`
  + ` · ${anchorsA.length} anchors`,
);
