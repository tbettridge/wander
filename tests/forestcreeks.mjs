import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planWaterRegionCandidates } from '../src/hydrologyregions.mjs';
import { brooksForCell } from '../src/forestbrooks.mjs';
import { buildBrooks, buildTerrainArrays, sampleRenderedTerrainTriangle } from '../src/chunkgen.js';

test('a forest creek feeds a joined river network at its physical water level', () => {
  const plan = planWaterRegionCandidates(42, 0, 0);
  const world = new World(42, { waterPlans: [plan] });
  const creek = brooksForCell(world, 4, 8).find(b => b.drainage?.receiver.kind === 'river');
  assert.ok(creek, 'the supported forest spring must retain a real downstream receiver');
  assert.equal(world.biomeAt(creek.pts[0], creek.pts[2]).id, 'forest');
  const receiver = creek.drainage.receiver;
  const network = plan.components.find(c => `component:${c.hash}` === receiver.bodyId);
  assert.ok(network?.oceanHandoff);
  assert.ok(network.reachIds.length >= 3, 'creek feeds a tributary in a branching source-to-sea network');
  const end = Array.from(creek.pts.slice(-4));
  const water = world.riverAt(end[0], end[2]);
  assert.ok(water.wet, 'there is no dry gap at the creek mouth');
  assert.ok(Math.abs(water.y - end[1]) < 1e-6);
  assert.ok(creek.pts.at(-1) > creek.pts[3], 'the creek grows rather than fading to a disconnected tip');
  for (let i = 1; i < creek.count; i++) {
    assert.ok(creek.pts[i * 4 + 1] <= creek.pts[i * 4 - 3] + 1e-6);
    assert.ok(creek.pts[i * 4 + 3] > 0 && creek.pts[i * 4 + 3] < 2);
  }
  const cx = Math.floor(receiver.x / 140), cz = Math.floor(receiver.z / 140);
  const built = buildBrooks(world, cx, cz, 140);
  assert.ok(built?.ribbon);
  assert.ok(built.ribbon.positions.every(Number.isFinite));
  assert.ok(built.ribbon.indices.every(i => i < built.ribbon.positions.length / 3));
  const terrain = buildTerrainArrays(world, cx, cz, 64, 140);
  const terrainRes = terrain.res;
  const ribbon = built.ribbon;
  let receivingVertices = 0, visibleDryVertices = 0;
  for (let i = 0; i < ribbon.positions.length / 3; i += 2) {
    const x = (ribbon.positions[i * 3] + ribbon.positions[(i + 1) * 3]) / 2;
    const z = (ribbon.positions[i * 3 + 2] + ribbon.positions[(i + 1) * 3 + 2]) / 2;
    if (x < cx * 140 || x >= (cx + 1) * 140 || z < cz * 140 || z >= (cz + 1) * 140) continue;
    const y = ribbon.positions[i * 3 + 1];
    const receiving = world.riverAt(x, z);
    if (ribbon.flow[i * 2 + 1] < 0) {
      assert.ok(receiving.wet && receiving.bodyId === receiver.bodyId,
        'a creek may fade into water only after reaching its real receiving surface');
      receivingVertices++;
    } else if (!receiving.wet) {
      const ground = sampleRenderedTerrainTriangle(terrain.positions, terrainRes, 140, cx * 140, cz * 140, x, z).y;
      assert.ok(y >= ground + 0.025, `the visible creek core must clear the drawn bank triangles at ${x},${z}: water ${y}, ground ${ground}`);
      visibleDryVertices++;
    }
  }
  assert.ok(receivingVertices > 0 && visibleDryVertices > 0,
    'the tested mouth includes both an exposed creek approach and its wet handoff');
  assert.strictEqual(brooksForCell(world, 4, 8).find(b => b.id === creek.id), creek,
    'repeated near-chunk requests reuse the accepted trace');
  world.installWaterPlans([]);
  assert.deepEqual(brooksForCell(world, 4, 8), [], 'a changed landscape cannot keep a stale creek outlet');
});
