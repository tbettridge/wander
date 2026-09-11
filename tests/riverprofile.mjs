import test from 'node:test';
import assert from 'node:assert/strict';
import { solveRiverProfile, drainageOrder } from '../src/riverprofile.mjs';

test('river profiles satisfy fixed crossing levels, downhill flow and ordinary grade limits', () => {
  const sections = Array.from({ length: 41 }, (_, i) => ({
    arc: i * 10, minY: 3, maxY: 12, preferredY: 10 - i * 0.1 + Math.sin(i) * 0.3,
  }));
  sections[10] = { ...sections[10], id: 'preserved-plank-bridge', minY: 8.9, maxY: 8.9 };
  sections[40] = { ...sections[40], id: 'lake-inlet', minY: 6, maxY: 6 };
  const result = solveRiverProfile(sections);
  assert.equal(result.status, 'accepted');
  assert.equal(result.levels[10], 8.9); assert.equal(result.levels[40], 6);
  for (let i = 1; i < result.levels.length; i++) {
    const drop = result.levels[i - 1] - result.levels[i];
    assert.ok(drop >= -1e-9 && drop <= 0.25 + 1e-9);
    assert.ok(result.levels[i] >= sections[i].minY && result.levels[i] <= sections[i].maxY);
  }
  assert.equal(result.falls.length, 0);
});

test('impossible legacy crossings are reported rather than moved or hidden in water deformation', () => {
  const impossible = [
    { id: 'upstream-stones', arc: 0, minY: 4, maxY: 4, preferredY: 4 },
    { id: 'downstream-log', arc: 100, minY: 5, maxY: 5, preferredY: 5 },
  ];
  const snapshot = structuredClone(impossible);
  assert.equal(solveRiverProfile(impossible).status, 'retain-legacy');
  assert.deepEqual(impossible, snapshot);
  const steep = [
    { arc: 0, minY: 8, maxY: 8, preferredY: 8 },
    { arc: 10, minY: 3, maxY: 3, preferredY: 3 },
  ];
  assert.equal(solveRiverProfile(steep).status, 'retain-legacy');
  steep[0].fall = true;
  const explicit = solveRiverProfile(steep);
  assert.equal(explicit.status, 'accepted');
  assert.deepEqual(explicit.falls, [{ from: 0, to: 1, lipY: 8, poolY: 3 }]);
});

test('river ownership graphs are deterministic and cannot silently contain cycles or missing endpoints', () => {
  const nodes = [{ id: 'source-a' }, { id: 'source-b' }, { id: 'confluence' }, { id: 'lake', closed: true }];
  const edges = [{ from: 'source-b', to: 'confluence' }, { from: 'source-a', to: 'confluence' },
    { from: 'confluence', to: 'lake' }];
  assert.deepEqual(drainageOrder(nodes, edges), drainageOrder([...nodes].reverse(), [...edges].reverse()));
  assert.equal(drainageOrder(nodes.slice(0, 3), [edges[0], edges[1], { from: 'confluence', to: 'source-a' }]).status,
    'retain-legacy');
  assert.throws(() => drainageOrder(nodes, [...edges, { from: 'lake', to: 'source-a' }]), /Closed basin/);
  assert.throws(() => drainageOrder(nodes, [{ from: 'unknown', to: 'lake' }]), /Unresolved/);
});
