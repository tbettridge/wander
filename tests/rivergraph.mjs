import test from 'node:test';
import assert from 'node:assert/strict';
import { solveRiverGraph, mergeRiverRoutes, segmentRiverGraph } from '../src/rivergraph.mjs';

const node = (id, minY, maxY, preferredY = maxY) => ({ id, minY, maxY, preferredY });
const edge = (from, to, length = 100) => ({ id: `${from}>${to}`, from, to, length });

test('confluence levels propagate through both tributaries and are independent of input order', () => {
  const nodes = [node('a', 4, 6), node('b', 2, 4), node('join', 1, 5), node('sea', 0, 0)];
  const edges = [edge('a', 'join'), edge('b', 'join'), edge('join', 'sea')];
  const solved = solveRiverGraph(nodes, edges);
  assert.equal(solved.status, 'accepted');
  assert.deepEqual(solveRiverGraph([...nodes].reverse(), [...edges].reverse()), solved);
  for (const { from, to, length } of edges) {
    assert.ok(solved.levels[from] >= solved.levels[to]);
    assert.ok(solved.levels[from] - solved.levels[to] <= length * 0.025);
  }
  assert.equal(solved.levels.join, 2.5);
  assert.equal(solved.levels.sea, 0);
});

test('an incompatible fixed tributary rejects the whole connected component', () => {
  const nodes = [node('high-crossing', 10, 10), node('low-crossing', 1, 1), node('join', 0, 12)];
  const edges = [edge('high-crossing', 'join'), edge('low-crossing', 'join')];
  const solved = solveRiverGraph(nodes, edges);
  assert.equal(solved.status, 'retain-legacy');
  assert.equal(solved.reason, 'incompatible-junction-levels');
  assert.equal(solved.levels, undefined);
  assert.equal(solveRiverGraph(nodes, edges.map(e => ({ ...e, fall: true }))).status, 'accepted');
  assert.equal(solveRiverGraph([node('a', 0, 1), node('b', 0, 1)], [edge('a', 'b'), edge('b', 'a')]).reason, 'drainage-cycle');
});

test('route merging has one downstream owner and one shared junction identity', () => {
  const point = (id, x, z, waterY) => ({ id, x, z, waterY, minY: waterY - 1, maxY: waterY + 1 });
  const join = point('join', 0, 100, 1), sea = { ...point('sea', 0, 200, 0), minY: 0, maxY: 0 };
  const routes = [{ status: 'candidate', source: 'a', points: [point('a', -100, 0, 3), join, sea] },
    { status: 'candidate', source: 'b', points: [point('b', 100, 0, 3), join, sea] }];
  const graph = mergeRiverRoutes(routes);
  assert.equal(graph.status, 'candidate');
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 3);
  assert.deepEqual(mergeRiverRoutes([...routes].reverse()), graph);
  assert.equal(solveRiverGraph(graph.nodes, graph.edges).status, 'accepted');
  const fork = { status: 'candidate', source: 'join', points: [join, point('other-sea', 100, 200, 0)] };
  assert.equal(mergeRiverRoutes([...routes, fork]).reason, 'ambiguous-downstream-owner');
  assert.equal(mergeRiverRoutes([...routes, { status: 'retain-legacy' }]).reason, 'unresolved-component-route');
});

test('solved confluences become edge-disjoint reaches with one junction owner', () => {
  const nodes = [
    { ...node('a', 4, 6), x: -100, z: 0 }, { ...node('b', 2, 4), x: 100, z: 0 },
    { ...node('join', 1, 5), x: 0, z: 100 }, { ...node('middle', 0, 4), x: 0, z: 160 },
    { ...node('sea', 0, 0), x: 0, z: 220 },
  ];
  const edges = [edge('a', 'join'), edge('b', 'join'), edge('join', 'middle'), edge('middle', 'sea')];
  const graph = { status: 'candidate', nodes, edges };
  const solved = solveRiverGraph(nodes, edges);
  assert.equal(solved.status, 'accepted');
  const segmented = segmentRiverGraph(graph, solved.levels);
  assert.equal(segmented.status, 'candidate');
  assert.equal(segmented.reaches.length, 3);
  assert.equal(segmented.junctions.length, 1);
  const junction = segmented.junctions[0];
  assert.equal(junction.nodeId, 'join');
  assert.equal(junction.incomingReachIds.length, 2);
  assert.ok(junction.outgoingReachId);
  assert.equal(junction.waterY, solved.levels.join);
  const assigned = segmented.reaches.flatMap(reach => reach.edgeIds);
  assert.deepEqual([...assigned].sort(), edges.map(item => item.id).sort());
  assert.equal(new Set(assigned).size, edges.length);
  const downstream = segmented.reaches.find(reach => reach.source === 'join');
  assert.equal(downstream.sourceClosure, false);
  assert.equal(downstream.oceanMouth, true);
  assert.equal(segmented.reaches.find(reach => reach.source === 'a').oceanMouth, false);
  assert.deepEqual(segmentRiverGraph(graph, solved.levels), segmented);
  assert.throws(() => segmentRiverGraph(graph, { ...solved.levels, join: NaN }), /Missing/);
});
