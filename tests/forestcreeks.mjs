import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planWaterRegionCandidates } from '../src/hydrologyregions.mjs';
import { descriptorHash } from '../src/hydrologyformat.mjs';
import { brooksForCell } from '../src/forestbrooks.mjs';
import { buildBrooks, buildTerrainArrays, sampleRenderedTerrainTriangle } from '../src/chunkgen.js';

let regionalPlan;
const currentPlan = () => regionalPlan ||= planWaterRegionCandidates(42, 0, 0);

function assertCreekConnection(plan, ci, cj) {
  const world = new World(42, { waterPlans: [plan] });
  const creek = brooksForCell(world, ci, cj).find(b => b.drainage?.receiver.kind === 'river');
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
  assert.strictEqual(brooksForCell(world, ci, cj).find(b => b.id === creek.id), creek,
    'repeated near-chunk requests reuse the accepted trace');
  world.installWaterPlans([]);
  assert.deepEqual(brooksForCell(world, ci, cj), [], 'a changed landscape cannot keep a stale creek outlet');
  return { creek, ribbon, cx, cz };
}

test('a generated forest creek feeds a joined regional river network at its physical water level', () => {
  assertCreekConnection(currentPlan(), 3, 8);
});

test('the original ordinary tributary spring and drawn handoff remain physically supported', () => {
  // Adding a nearby owner changes random proposal selection. Retain the old
  // generated spring as a physical regression in the actual new landscape.
  const priorPlan = planWaterRegionCandidates(42, 0, 0, { regionalTrunks: false });
  const { creek, ribbon, cx, cz } = assertCreekConnection(priorPlan, 4, 8);
  const plan = currentPlan(), world = new World(42, { waterPlans: [plan] });
  const receiver = creek.drainage.receiver;
  const network = plan.components.find(component => `component:${component.hash}` === receiver.bodyId);
  assert.ok(network?.oceanHandoff && network.reachIds.length >= 3,
    'the original branching tributary receiver survives the regional water budget');
  const spring = world.biomeAt(creek.pts[0], creek.pts[2]);
  assert.equal(spring.id, 'forest');
  assert.ok(spring.slope >= .012 && spring.slope <= .2 && spring.h >= 2 && spring.h <= 170);
  assert.ok(!world.riverAt(creek.pts[0], creek.pts[2]).wet, 'the original source remains dry forest');
  const end = Array.from(creek.pts.slice(-4)), water = world.riverAt(end[0], end[2]);
  assert.ok(water.wet && water.bodyId === receiver.bodyId);
  assert.ok(Math.abs(water.y - end[1]) < 1e-6, 'the original physical handoff retains its actual receiving head');
  const terrain = buildTerrainArrays(world, cx, cz, 64, 140);
  let exposed = 0, receiving = 0;
  for (let i = 0; i < ribbon.positions.length / 3; i += 2) {
    const x = (ribbon.positions[i * 3] + ribbon.positions[(i + 1) * 3]) / 2;
    const z = (ribbon.positions[i * 3 + 2] + ribbon.positions[(i + 1) * 3 + 2]) / 2;
    if (x < cx * 140 || x >= (cx + 1) * 140 || z < cz * 140 || z >= (cz + 1) * 140) continue;
    const surface = world.riverAt(x, z);
    if (ribbon.flow[i * 2 + 1] < 0) {
      assert.ok(surface.wet && surface.bodyId === receiver.bodyId); receiving++;
    } else if (!surface.wet) {
      const ground = sampleRenderedTerrainTriangle(terrain.positions, terrain.res, 140, cx * 140, cz * 140, x, z).y;
      assert.ok(ribbon.positions[i * 3 + 1] >= ground + .025, 'the original exposed creek clears the new drawn bank');
      exposed++;
    }
  }
  assert.ok(exposed > 0 && receiving > 0);
});

test('a real forest creek feeds the main river when no ordinary shore receiver is available', () => {
  const { hash, diagnostics, ...payload } = currentPlan();
  payload.components = payload.components.filter(component => component.regionalTrunk);
  payload.basins = [];
  assert.equal(payload.components.length, 1);
  const plan = { ...payload, hash: descriptorHash(payload) };
  const { creek } = assertCreekConnection(plan, 3, 8);
  assert.equal(creek.drainage.receiver.bodyId, `component:${payload.components[0].hash}`);
});
