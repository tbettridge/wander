import assert from 'node:assert/strict';
import test from 'node:test';
import { createFortifiedOutpostPlan } from '../src/fortifiedoutpost.mjs';
import {
  RUIN_INSPECTION_VERSION,
  inspectFortifiedOutpostTraversal,
} from '../src/ruininspection.mjs';

test('renderer-free traversal inspection clears every tier and catches a blocked route', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 600; seed++) {
    const plan = createFortifiedOutpostPlan(seed);
    const report = inspectFortifiedOutpostTraversal(plan);
    seen.add(report.tier);
    assert.equal(report.version, RUIN_INSPECTION_VERSION);
    assert.ok(report.valid, `seed ${seed} (${report.tier}): ${report.errors.join(', ')}`);
    assert.equal(report.donjonPreserved, true);
    assert.equal(report.undercroftPreserved, report.tier === 'keep');
    // The drum is always solid, so there are always proxies to be clear of.
    assert.ok(report.collisionProxyCount > 0);
  }
  assert.deepEqual([...seen].sort(), ['keep', 'outpost', 'watch']);
});

test('a proxy dropped across the protected route is reported, not tolerated', () => {
  const plan = createFortifiedOutpostPlan(17);
  assert.equal(plan.tier, 'keep');
  // Wall off the walk in from the gate.
  const nodes = new Map(plan.intact.circulation.nodes.map((node) => [node.id, node]));
  const gate = nodes.get('route:gate');
  const inside = plan.intact.circulation.protectedRoute
    .map((id) => nodes.get(id))
    .find((node) => node?.kind === 'courtyard');
  const midX = (gate.x + inside.x) / 2, midZ = (gate.z + inside.z) / 2;
  const alongX = inside.x - gate.x, alongZ = inside.z - gate.z;
  const length = Math.hypot(alongX, alongZ);
  const blocked = {
    ...plan,
    collisionProxies: [...plan.collisionProxies, {
      id: 'test:barricade', sourcePieceId: 'gate:arch',
      ax: midX - (-alongZ / length) * 6, az: midZ - (alongX / length) * 6,
      bx: midX + (-alongZ / length) * 6, bz: midZ + (alongX / length) * 6,
      minY: 0, maxY: 3, thickness: 0.9,
    }],
  };
  const report = inspectFortifiedOutpostTraversal(blocked);
  assert.equal(report.valid, false);
  assert.ok(report.errors.includes('route-collision'));
});

console.log('ruininspection PASS · every tier traversable · a blocked route is a failure');
