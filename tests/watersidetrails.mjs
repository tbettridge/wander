import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/world.js';
import { planWaterRegionCandidates } from '../src/hydrologyregions.mjs';
import { watersideTrailNodes } from '../src/watersidetrails.mjs';
import { trailsAround, clearTrailCache } from '../src/trails.js';
import { solveCrossing } from '../src/trailcrossings.mjs';

test('occasional shoreline destinations stay dry and connect to the real walking network', () => {
  const plan = planWaterRegionCandidates(4242, 1, 0);
  const world = new World(4242, { waterPlans: [plan] });
  const nodes = watersideTrailNodes(world);
  assert.ok(nodes.length > 0 && nodes.length <= 2);
  for (const node of nodes) {
    assert.ok(!world.riverAt(node.x, node.z).wet);
    assert.ok(world.biomeAt(node.x, node.z).slope <= 0.2);
    assert.ok(world.riverAt(node.viewX, node.viewZ).wet);
  }
  const edges = trailsAround(world, 5408, 48, 4242, 2000, []).filter(e => e.waterDestination);
  assert.ok(edges.some(e => e.waterDestination === 'basin:4242:5408:48'));
  for (const edge of edges) {
    assert.ok(edge.route.maxGrade <= 0.26);
    for (const ford of edge.fords) assert.ok(solveCrossing(world, edge, ford));
    const shore = nodes.find(n => n.waterBody === edge.waterDestination);
    assert.ok([edge.fromKey, edge.toKey].includes(shore.key));
  }
  clearTrailCache();
  assert.deepEqual(trailsAround(world, 5408, 48, 4242, 2000, []).filter(e => e.waterDestination), edges);
  assert.deepEqual(watersideTrailNodes(new World(4242)), []);
});
