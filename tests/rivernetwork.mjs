import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { RiverRoutePlanner } from '../src/riverroute.mjs';
import { planRiverNetwork } from '../src/rivernetwork.mjs';
import { prepareRiverJunctions } from '../src/riverjunctions.mjs';
import { prepareNetworkRegion } from '../src/hydrologyworker.js';

const sources = [
  { x: 2958.222222222222, z: 2958.222222222222 },
  { x: 2958.222222222222, z: 3413.3333333333335 },
  { x: 3413.3333333333335, z: 3413.3333333333335 },
];

test('routing can stop at an inland channel without imposing a sea-level endpoint', () => {
  const world = { _naturalHeight: () => 5 };
  const planner = new RiverRoutePlanner(world, { maxVisited: 64 });
  const target = { ...planner.node(2, 0), minY: 2, maxY: 4, waterY: 3 };
  const downstream = new Map([[target.id, target]]);
  const route = planner.route({ x: 0, z: 0 }, { downstream });
  assert.equal(route.status, 'candidate');
  assert.equal(route.joins, target.id);
  assert.equal(route.points.at(-1).waterY, 3);
  assert.equal(route.points.at(-1).minY, 2);
  assert.equal(route.points.at(-1).maxY, 4);
  assert.equal(planner.route(target, { downstream }).reason, 'source-on-existing-river');
  assert.throws(() => planner.route({ x: 0, z: 0 }, {
    downstream: new Map([[target.id, { ...target, x: target.x + 1 }]]),
  }), /Conflicting downstream/);
  assert.equal(new RiverRoutePlanner(world, { maxVisited: 1 }).route({ x: 0, z: 0 }, { downstream }).reason,
    'outlet-search-budget');
});

test('real terrain builds one deterministic source-to-sea network with two inland confluences', () => {
  const world = new World(20260612, { generationVersion: 3 });
  const network = planRiverNetwork(world, sources);
  assert.deepEqual(network, planRiverNetwork(world, [...sources].reverse()));
  assert.equal(network.activationReady, false);
  assert.deepEqual(network.diagnostics, { sources: 3, joinedSources: 2, rejected: [] });
  assert.equal(network.components.length, 1);
  const component = network.components[0];
  assert.equal(component.reaches.length, 5);
  assert.equal(component.junctions.length, 2);
  assert.equal(prepareRiverJunctions(component).status, 'prepared');
  assert.ok(component.junctions.every(j => j.waterY > 1 && j.levelLength > 64));
  const outgoing = new Map();
  for (const edge of component.graph.edges) {
    assert.equal(outgoing.has(edge.from), false, 'one downstream owner per node');
    outgoing.set(edge.from, edge.to);
  }
  const nodes = new Map(component.graph.nodes.map(p => [p.id, p]));
  const mouths = new Set();
  for (const source of component.sources) {
    let id = source;
    const seen = new Set();
    while (outgoing.has(id)) {
      assert.equal(seen.has(id), false, 'no drainage cycle');
      seen.add(id); id = outgoing.get(id);
    }
    mouths.add(id);
    const mouth = nodes.get(id);
    assert.ok(world._naturalHeight(mouth.x, mouth.z) < -0.25);
  }
  assert.equal(mouths.size, 1);
  assert.equal(component.reaches.filter(r => r.oceanMouth).length, 1);
  for (const reach of component.reaches) for (let i = 1; i < reach.points.length; i++) {
    const a = reach.points[i - 1], b = reach.points[i];
    assert.ok(b.waterY <= a.waterY + 1e-9);
    assert.ok(a.waterY - b.waterY <= (b.arc - a.arc) * reach.maxGrade + 1e-9);
  }
});

test('network input and route budgets reject without inventing boundary outlets', () => {
  const world = { _naturalHeight: () => 5 };
  const network = planRiverNetwork(world, [{ x: 0, z: 0 }], { maxVisited: 1 });
  assert.equal(network.components.length, 0);
  assert.equal(network.diagnostics.rejected[0].reason, 'outlet-search-budget');
  assert.throws(() => planRiverNetwork(world, sources, { maxSources: 2 }), /budget/);
  assert.throws(() => planRiverNetwork(world, [sources[0], { ...sources[0], id: 'duplicate-place' }]), /Duplicate/);
  assert.throws(() => planRiverNetwork(world, [{ x: NaN, z: 0 }]), /budget/);
  assert.throws(() => planRiverNetwork(world, sources, { maxVisited: 8193 }), /budget/);
});

test('required river connections cannot substitute a nearer ocean outlet', () => {
  const world = { _naturalHeight: (x, z) => x > 64 ? -1 : 5 };
  const planner = new RiverRoutePlanner(world, { maxVisited: 512 });
  const target = { ...planner.node(-4, 0), minY: 3, maxY: 3, waterY: 3 };
  const downstream = new Map([[target.id, target]]);
  const ordinary = planner.route({ x: 0, z: 0 }, { downstream });
  assert.equal(ordinary.joins, undefined);
  const required = planner.route({ x: 0, z: 0 }, { downstream, requireDownstream: true });
  assert.equal(required.status, 'candidate');
  assert.equal(required.joins, target.id);
  assert.equal(required.points.at(-1).waterY, 3);
  assert.throws(() => planner.route({ x: 0, z: 0 }, { requireDownstream: true }), /required downstream/);
});

test('an incompatible later tributary leaves the accepted downstream network intact', () => {
  const world = new World(20260612, { generationVersion: 3 });
  const original = planRiverNetwork(world, sources);
  const rejected = planRiverNetwork(world, [...sources, { x: 2720, z: 3400 }]);
  assert.deepEqual(rejected.components, original.components);
  assert.deepEqual(rejected.diagnostics.rejected, [{ source: 'source:2720,3400', reason: 'incompatible-junction-levels' }]);
});

test('planning worker returns network readiness without installing an incomplete water plan', async () => {
  const request = { type: 'plan-network', id: 17, seed: 20260612, regionX: 0, regionZ: 0 };
  const expected = prepareNetworkRegion(request);
  assert.equal(expected.network.diagnostics.joinedSources, 2);
  const joined = expected.network.meshReadiness.find(c => c.sources.length === 3);
  assert.equal(joined.status, 'baked');
  assert.equal(joined.reason, null);
  const previousSelf = globalThis.self;
  let reply;
  try {
    globalThis.self = { postMessage: message => { reply = structuredClone(message); } };
    await import('../src/hydrologyworker.js?network-worker-test');
    self.onmessage({ data: request });
    assert.equal(reply.type, 'network-planned');
    assert.equal(reply.id, 17);
    assert.equal(reply.plan, undefined);
    assert.equal(reply.network.activationReady, false);
    assert.deepEqual(reply.network, expected.network);
  } finally {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});
