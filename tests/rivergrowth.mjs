import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRiverRoutes, segmentRiverGraph } from '../src/rivergraph.mjs';
import { channelProfileAt } from '../src/rivercharacter.mjs';
import { buildRiverHierarchy, nominalReachProfileAt } from '../src/riverhierarchy.mjs';

const point = (id, x, z, waterY, extras = {}) => ({
  id, x, z, waterY, minY: waterY - 2, maxY: waterY + 2, ...extras,
});

const route = (source, points) => ({
  id: `route:${source}`,
  source,
  status: 'candidate',
  sourceClosure: true,
  oceanMouth: false,
  points,
});

function sequentialJoinFixture(routeOrder = ['a', 'b', '0-tributary']) {
  const a = point('a', -160, 0, 4);
  const b = point('b', 160, 0, 4);
  const tributary = point('0-tributary', -120, 150, 3.5);
  const join1 = point('join-1', 0, 40, 3);
  const join2 = point('join-2', 0, 60, 2.5);
  const sea = point('sea', 0, 360, 0, { terminal: 'ocean' });
  const bySource = {
    a: route('a', [a, join1, join2, sea]),
    b: route('b', [b, join1, join2, sea]),
    '0-tributary': route('0-tributary', [tributary, join2, sea]),
  };
  const graph = mergeRiverRoutes(routeOrder.map(source => bySource[source]));
  assert.equal(graph.status, 'candidate');
  // mergeRiverRoutes keeps canonical coordinates and levels, while terminal
  // semantics are attached by the production network after merging.
  graph.nodes = graph.nodes.map(node => node.id === 'sea'
    ? { ...node, terminal: 'ocean' } : node);
  const segmented = segmentRiverGraph(graph,
    Object.fromEntries(graph.nodes.map(node => [node.id, node.preferredY])));
  assert.equal(segmented.status, 'candidate');
  return { graph, segmented };
}

const hierarchyOptions = {
  seed: 97,
  sourceContributions: [
    { id: 'a', nodeId: 'a', contribution: 2 },
    { id: 'b', nodeId: 'b', contribution: 2 },
    { id: '0-tributary', nodeId: '0-tributary', contribution: 3 },
  ],
  terminals: [{ nodeId: 'sea', kind: 'ocean', verified: true }],
};

function buildMorphology(routeOrder) {
  const fixture = sequentialJoinFixture(routeOrder);
  return buildRiverHierarchy(fixture.graph, fixture.segmented, {
    ...hierarchyOptions,
    riverMorphology: true,
  });
}

function profilesBySource(result) {
  return Object.fromEntries(result.profiles.map(profile => [profile.reach.source, profile.channelProfile]));
}

test('morphology bounds each tributary response and holds the wider trunk', () => {
  const result = buildMorphology();
  assert.equal(result.status, 'planned');
  const profiles = profilesBySource(result);
  for (const profile of Object.values(profiles)) {
    assert.equal(profile.morphology, true);
    const routeLength = profile.samples.at(-1).arc;
    const trendLength = profile.trendEndArc - profile.trendStartArc;
    assert.ok(trendLength > 0);
    assert.equal(profile.downstreamSmoothing.globalArcEnd, profile.trendEndArc);
  }

  const trunk = profiles['join-2'];
  const trunkLength = trunk.samples.at(-1).arc;
  const trend = trunk.trendEndArc - trunk.trendStartArc;
  assert.ok(trunkLength > trend, 'the long post-join reach should finish widening early');
  const atTrend = channelProfileAt(trunk, trend, trunkLength);
  const afterTrend = channelProfileAt(trunk, Math.min(trunkLength, trend + 120), trunkLength);
  assert.ok(Math.abs(atTrend.halfWidth / atTrend.widthVariation
    - afterTrend.halfWidth / afterTrend.widthVariation) < 1e-9,
  'the nominal width should hold after the local growth response');

  assert.ok(profiles['join-1'].halfWidth > profiles.b['halfWidth']);
  assert.ok(trunk.halfWidth > profiles['join-1'].halfWidth);
  assert.ok(trunk.halfWidth > profiles['0-tributary'].halfWidth);
});

test('nominal morphology samples follow the bounded channel trend on long and short reaches', () => {
  const result = buildMorphology();
  const profiles = profilesBySource(result);
  for (const source of ['join-1', 'join-2']) {
    const profile = profiles[source];
    const length = profile.samples.at(-1).arc;
    const trendLength = profile.trendEndArc - profile.trendStartArc;
    for (const arc of [0, length * 0.25, length * 0.5, length]) {
      const nominal = nominalReachProfileAt(profile, arc, length);
      const sampled = channelProfileAt(profile, arc, length);
      assert.ok(Math.abs(nominal.halfWidth - sampled.halfWidth / sampled.widthVariation) < 1e-9,
        `${source} nominal width should use its authored trend at ${arc}`);
    }
    if (length > trendLength) {
      const nominalAfterTrend = nominalReachProfileAt(profile, trendLength + 40, length);
      const sampledAfterTrend = channelProfileAt(profile, trendLength + 40, length);
      assert.ok(Math.abs(nominalAfterTrend.halfWidth
        - sampledAfterTrend.halfWidth / sampledAfterTrend.widthVariation) < 1e-9);
    }
  }
});

test('a short reach carries its actual partial growth into the next join', () => {
  const result = buildMorphology();
  const profiles = profilesBySource(result);
  const mainstem = profiles['join-1'];
  const trunk = profiles['join-2'];
  const mainstemLength = mainstem.samples.at(-1).arc;
  const trunkLength = trunk.samples.at(-1).arc;
  const incoming = channelProfileAt(mainstem, mainstemLength, mainstemLength);
  const outgoing = channelProfileAt(trunk, 0, trunkLength);

  assert.equal(mainstemLength, 20);
  assert.ok(mainstem.trendEndArc - mainstem.trendStartArc > mainstemLength,
    'the short reach retains its unfinished response interval');
  const mainstemEndpoint = nominalReachProfileAt(mainstem, mainstemLength, mainstemLength);
  assert.ok(mainstemEndpoint.halfWidth < mainstem.endHalfWidth,
    'the short reach endpoint remains below its eventual target');
  assert.equal(trunk.identityId, mainstem.identityId,
    'the wider existing mainstem owns the downstream character phase');
  assert.equal(outgoing.globalArc, incoming.globalArc);
  assert.ok(Math.abs(outgoing.halfWidth - incoming.halfWidth) < 1e-9,
    'actual sampled width is continuous at the join');
});

test('branch identity follows real incoming drainage, even when a tributary id sorts first', () => {
  const result = buildMorphology(['0-tributary', 'b', 'a']);
  const profiles = profilesBySource(result);
  const mainstem = profiles['join-1'];
  const trunk = profiles['join-2'];
  assert.equal(mainstem.identityId, 'b');
  assert.equal(trunk.identityId, mainstem.identityId);
  assert.equal(trunk.arcOffset, mainstem.arcOffset + mainstem.samples.at(-1).arc);
});

test('morphology hierarchy is deterministic under reordered graph and route inputs', () => {
  const first = buildMorphology(['a', 'b', '0-tributary']);
  const second = buildMorphology(['0-tributary', 'a', 'b']);
  assert.deepEqual(second.channelProfiles, first.channelProfiles);
  assert.deepEqual(second.sourceContributions, first.sourceContributions);
  assert.deepEqual(second.nodeContributions, first.nodeContributions);
  assert.deepEqual(second.edgeContributions, first.edgeContributions);
});

test('morphology is opt in and preserves legacy profile bytes', () => {
  const fixture = sequentialJoinFixture();
  const legacy = buildRiverHierarchy(fixture.graph, fixture.segmented, hierarchyOptions);
  const explicitLegacy = buildRiverHierarchy(fixture.graph, fixture.segmented,
    { ...hierarchyOptions, riverMorphology: false });
  assert.deepEqual(explicitLegacy, legacy);
  assert.ok(Object.values(legacy.channelProfiles).every(profile => !Object.hasOwn(profile, 'morphology')));
});

test('morphology keeps supported widths bounded and declares broad trunks unsupported', () => {
  const source = point('wide-source', 0, 0, 3);
  const sea = point('sea', 0, 300, 0, { terminal: 'ocean' });
  const graph = mergeRiverRoutes([route('wide-source', [source, sea])]);
  graph.nodes = graph.nodes.map(node => node.id === 'sea'
    ? { ...node, terminal: 'ocean' } : node);
  const segmented = segmentRiverGraph(graph,
    Object.fromEntries(graph.nodes.map(node => [node.id, node.preferredY])));
  const broad = buildRiverHierarchy(graph, segmented, {
    seed: 31,
    riverMorphology: true,
    sourceContributions: [{ id: 'wide-source', nodeId: 'wide-source', contribution: 100 }],
    terminals: [{ nodeId: 'sea', kind: 'ocean', verified: true }],
  });
  const broadProfile = Object.values(broad.channelProfiles)[0];
  assert.equal(broadProfile.morphology, true);
  assert.equal(broadProfile.supported, false);
  assert.equal(broadProfile.declaredUnsupported, true);
  assert.ok(broadProfile.requestedTotalWidth >= 50 && broadProfile.requestedTotalWidth <= 100);
  assert.ok(broadProfile.halfWidth > 22.5);

  const supported = buildMorphology();
  for (const profile of Object.values(supported.channelProfiles).filter(item => item.supported)) {
    assert.ok(profile.samples.every(sample => sample.halfWidth >= 1 - 1e-9
      && sample.halfWidth <= 22.5 + 1e-9));
  }
});
