import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRiverRoutes, segmentRiverGraph } from '../src/rivergraph.mjs';
import { channelProfileAt } from '../src/rivercharacter.mjs';
import {
  buildRiverHierarchy,
  accumulateRiverContributions,
  nominalReachProfileAt,
  verifyOceanTerminals,
} from '../src/riverhierarchy.mjs';

const point = (id, x, z, waterY, extras = {}) => ({
  id, x, z, waterY, minY: waterY - 2, maxY: waterY + 2, ...extras,
});

const route = (source, points, extras = {}) => ({
  id: `route:${source}`,
  source,
  status: 'candidate',
  sourceClosure: true,
  oceanMouth: false,
  points,
  ...extras,
});

function confluenceFixture() {
  const a = point('a', -180, 0, 4);
  const b = point('b', 180, 0, 4);
  const c = point('c', 180, 220, 3);
  const joinA = point('join-a', 0, 120, 2.5);
  const joinB = point('join-b', 0, 300, 1.5);
  const sea = point('sea', 0, 500, 0, { terminal: 'ocean' });
  const routes = [
    route('a', [a, joinA, joinB, sea]),
    route('b', [b, joinA, joinB, sea]),
    route('c', [c, joinB, sea]),
  ];
  const graph = mergeRiverRoutes(routes);
  assert.equal(graph.status, 'candidate');
  // mergeRiverRoutes intentionally keeps only canonical node fields. Attach
  // the semantic terminal after merging, as the production network does.
  graph.nodes = graph.nodes.map(node => node.id === 'sea' ? { ...node, terminal: 'ocean' } : node);
  const levels = Object.fromEntries(graph.nodes.map(node => [node.id, node.preferredY]));
  const segmented = segmentRiverGraph(graph, levels);
  assert.equal(segmented.status, 'candidate');
  return { routes, graph, segmented };
}

const options = {
  seed: 20260612,
  sourceContributions: [
    { id: 'a', nodeId: 'a', contribution: 1 },
    { id: 'b', nodeId: 'b', contribution: 2 },
    { id: 'c', nodeId: 'c', contribution: 4 },
  ],
  terminals: [{ nodeId: 'sea', kind: 'ocean', verified: true }],
};

test('accumulation uses actual merged/segmented confluences and counts a shared suffix once', () => {
  const { graph, segmented } = confluenceFixture();
  const result = accumulateRiverContributions(graph, segmented, options);
  assert.equal(result.status, 'accepted');
  const byNode = Object.fromEntries(result.nodeContributions.map(node => [node.nodeId, node.contribution]));
  assert.equal(byNode.a, 1);
  assert.equal(byNode['join-a'], 3);
  assert.equal(byNode['join-b'], 7);
  assert.equal(byNode.sea, 7);
  const shared = result.edgeContributions.find(edge => edge.edgeId === 'join-b>sea');
  assert.equal(shared.contribution, 7, 'the suffix carries the combined flow exactly once');
  assert.deepEqual(shared.sourceContributions.map(source => source.sourceId), ['a', 'b', 'c']);
});

test('hierarchy and channel profiles are stable when route, graph and segment inputs are reordered', () => {
  const first = confluenceFixture();
  const reversedGraph = {
    ...first.graph,
    nodes: [...first.graph.nodes].reverse(),
    edges: [...first.graph.edges].reverse(),
  };
  const reversedSegments = {
    ...first.segmented,
    reaches: [...first.segmented.reaches].reverse(),
    junctions: [...first.segmented.junctions].reverse(),
  };
  const a = buildRiverHierarchy(first.graph, first.segmented, options);
  const b = buildRiverHierarchy(reversedGraph, reversedSegments, options);
  assert.equal(a.status, 'planned');
  assert.equal(a.accepted, true);
  assert.deepEqual(b.channelProfiles, a.channelProfiles);
  assert.deepEqual(b.sourceContributions, a.sourceContributions);
  assert.deepEqual(b.nodeContributions, a.nodeContributions);
  assert.deepEqual(b.edgeContributions, a.edgeContributions);
  assert.deepEqual(b.lakeTransitions, a.lakeTransitions);
  assert.ok(Object.keys(a.channelProfiles).length === 5);
  const trunk = Object.values(a.channelProfiles).find(profile => profile.source === 'join-b');
  assert.ok(trunk, 'the downstream shared reach has a profile');
  assert.ok(trunk.halfWidth > 0);
  assert.equal(trunk.trendStartArc, trunk.arcOffset);
  assert.ok(trunk.trendEndArc > trunk.trendStartArc);
  const sample = nominalReachProfileAt(trunk, (trunk.trendEndArc - trunk.trendStartArc) / 2,
    trunk.trendEndArc - trunk.trendStartArc);
  assert.ok(sample.halfWidth > 0);
  assert.ok(sample.depth > 0);
  const dominant = Object.values(a.channelProfiles).find(profile => profile.source === 'c');
  assert.equal(trunk.id, dominant.id, 'dominant tributary keeps its character identity downstream');
  assert.equal(trunk.variationSeed, dominant.variationSeed);
  const length = dominant.trendEndArc - dominant.trendStartArc;
  assert.equal(trunk.arcOffset, dominant.arcOffset + length);
  const entering = channelProfileAt(dominant, length, length);
  const leaving = channelProfileAt(trunk, 0, trunk.trendEndArc - trunk.trendStartArc);
  assert.equal(leaving.widthVariation, entering.widthVariation, 'the actual terrain sampler retains phase at the join');
  assert.equal(leaving.depthVariation, entering.depthVariation);
  assert.ok(Math.abs(leaving.halfWidth - entering.halfWidth) < 1e-9);
});

test('cycles and missing receivers are rejected before profile generation', () => {
  const cycle = {
    status: 'candidate',
    nodes: [point('a', 0, 0, 2), point('b', 0, 10, 1)],
    edges: [{ id: 'a>b', from: 'a', to: 'b', length: 10 }, { id: 'b>a', from: 'b', to: 'a', length: 10 }],
  };
  assert.equal(buildRiverHierarchy(cycle, null, {}).reason, 'drainage-cycle');
  const missing = {
    status: 'candidate',
    nodes: [point('a', 0, 0, 2)],
    edges: [{ id: 'a>receiver', from: 'a', to: 'receiver', length: 10 }],
  };
  assert.equal(buildRiverHierarchy(missing, null, {}).reason, 'missing-receiver');
});

test('numeric sea height alone does not verify an ocean terminal', () => {
  const fixture = confluenceFixture();
  const noSemantic = { ...fixture.graph, nodes: fixture.graph.nodes.map(node => {
    const copy = { ...node };
    delete copy.terminal;
    return copy;
  }) };
  const report = verifyOceanTerminals(noSemantic, fixture.segmented, {});
  assert.equal(report.status, 'rejected');
  assert.equal(report.reason, 'missing-receiver');
  const explicit = verifyOceanTerminals(noSemantic, fixture.segmented, {
    terminals: [{ nodeId: 'sea', kind: 'ocean', verified: true }],
  });
  assert.equal(explicit.status, 'accepted');
  assert.equal(explicit.oceanConnected, true);
});

test('implicit source values are labeled as a local catchment proxy', () => {
  const { graph, segmented } = confluenceFixture();
  const result = accumulateRiverContributions(graph, segmented, {
    defaultSourceContribution: 1,
  });
  assert.equal(result.status, 'accepted');
  assert.ok(result.sources.every(source => source.mode === 'catchment-proxy'));
  assert.equal(result.catchment.crossRegionComplete, false);
  assert.equal(result.catchment.label, 'proxy-not-cross-region-catchment-completion');
});

test('through-flow lake carries incoming plus local catchment and ignores lake surface area', () => {
  const source = point('source', 0, -100, 4);
  const lake = point('lake-node', 0, 0, 2, {
    kind: 'lake', lakeId: 'lake:fixture', area: 999999, localCatchmentContribution: 3,
  });
  const sea = point('sea', 0, 200, 0, { terminal: 'ocean' });
  const graph = mergeRiverRoutes([route('source', [source, lake, sea])]);
  graph.nodes = graph.nodes.map(node => {
    if (node.id === 'lake-node') return { ...node, kind: 'lake', lakeId: 'lake:fixture', area: 999999, localCatchmentContribution: 3 };
    if (node.id === 'sea') return { ...node, terminal: 'ocean' };
    return node;
  });
  const segmented = segmentRiverGraph(graph, Object.fromEntries(graph.nodes.map(node => [node.id, node.preferredY])));
  const result = buildRiverHierarchy(graph, segmented, {
    seed: 4,
    sourceContributions: [{ id: 'source', nodeId: 'source', contribution: 2 }],
    terminals: [{ nodeId: 'sea', kind: 'ocean', verified: true }],
  });
  assert.equal(result.status, 'planned');
  const lakeNode = result.nodeContributions.find(node => node.nodeId === 'lake-node');
  assert.equal(lakeNode.contribution, 5);
  assert.equal(result.edgeContributions.find(edge => edge.from === 'lake-node').contribution, 5);
  assert.deepEqual(result.lakeTransitions, [{
    nodeId: 'lake-node', lakeId: 'lake:fixture', role: 'through-flow',
    incomingContribution: 2, localCatchmentContribution: 3, outgoingContribution: 5,
    sourceIds: ['lake-local:lake-node', 'source'],
  }]);
});

test('large modeled class stays explicit and unsupported beyond the current half-width cap', () => {
  const source = point('source', 0, 0, 3);
  const sea = point('sea', 0, 100, 0);
  const graph = mergeRiverRoutes([route('source', [source, sea])]);
  graph.nodes = graph.nodes.map(node => node.id === 'sea' ? { ...node, terminal: 'ocean' } : node);
  const segmented = segmentRiverGraph(graph, Object.fromEntries(graph.nodes.map(node => [node.id, node.preferredY])));
  const result = buildRiverHierarchy(graph, segmented, {
    sourceContributions: [{ id: 'source', nodeId: 'source', contribution: 100 }],
    terminals: [{ nodeId: 'sea', kind: 'ocean', verified: true }],
  });
  const profile = Object.values(result.channelProfiles)[0];
  assert.equal(profile.widthClass, 'large-trunk');
  assert.equal(profile.supported, false);
  assert.equal(profile.declaredUnsupported, true);
  assert.ok(profile.requestedTotalWidth >= 50 && profile.requestedTotalWidth <= 100);
  assert.ok(profile.halfWidth > 22.5, 'unsupported dimensions are retained rather than silently shrunk');
  assert.equal(result.unsupportedProfiles.length, 1);
});

test('tiny modeled streams stay explicit when below the current fitter minimum', () => {
  const source = point('source', 0, 0, 2);
  const sea = point('sea', 0, 100, 0);
  const graph = mergeRiverRoutes([route('source', [source, sea])]);
  graph.nodes = graph.nodes.map(node => node.id === 'sea' ? { ...node, terminal: 'ocean' } : node);
  const segmented = segmentRiverGraph(graph, Object.fromEntries(graph.nodes.map(node => [node.id, node.preferredY])));
  const result = buildRiverHierarchy(graph, segmented, {
    sourceContributions: [{ id: 'source', nodeId: 'source', contribution: 0.01 }],
    terminals: [{ nodeId: 'sea', kind: 'ocean', verified: true }],
  });
  const profile = Object.values(result.channelProfiles)[0];
  assert.equal(profile.supported, false);
  assert.equal(profile.unsupportedReason, 'current-fit-min-half-width');
  assert.ok(profile.halfWidth < 1);
  assert.equal(result.unsupportedProfiles[0].declaredUnsupported, true);
});
