import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planWaterRegionCandidates } from '../src/hydrologyregions.mjs';
import { descriptorHash } from '../src/hydrologyformat.mjs';
import { brooksForCell } from '../src/forestbrooks.mjs';
import { buildBrooks, buildTerrainArrays, sampleRenderedTerrainTriangle } from '../src/chunkgen.js';

let regionalPlan;
const currentPlan = () => regionalPlan ||= planWaterRegionCandidates(42, 0, 0);

// The first creek in a cell scan that drains into a river component.
function findCreekCell(plan, accept) {
  const world = new World(42, { waterPlans: [plan] });
  for (let cj = -1; cj <= 11; cj++) for (let ci = -1; ci <= 11; ci++) {
    const creek = brooksForCell(world, ci, cj).find(b => b.drainage?.receiver.kind === 'river' && accept(b, world));
    if (creek) return { ci, cj, creek };
  }
  return null;
}

function assertCreekConnection(plan, ci, cj, { planned = false, branching = true } = {}) {
  const world = new World(42, { waterPlans: [plan] });
  const creek = brooksForCell(world, ci, cj).find(b => b.drainage?.receiver.kind === 'river' && !!b.planned === planned);
  assert.ok(creek, 'the supported forest spring must retain a real downstream receiver');
  if (!planned) assert.equal(world.biomeAt(creek.pts[0], creek.pts[2]).id, 'forest');
  const receiver = creek.drainage.receiver;
  const network = plan.components.find(c => `component:${c.hash}` === receiver.bodyId);
  assert.ok(network?.oceanHandoff);
  if (branching) assert.ok(network.reachIds.length >= 3, 'creek feeds a tributary in a branching source-to-sea network');
  const end = Array.from(creek.pts.slice(-4));
  const water = world.riverAt(end[0], end[2]);
  assert.ok(water.wet, 'there is no dry gap at the creek mouth');
  assert.ok(Math.abs(water.y - end[1]) < 1e-6);
  assert.ok(creek.pts.at(-1) > creek.pts[3], 'the creek grows rather than fading to a disconnected tip');
  for (let i = 1; i < creek.count; i++) {
    assert.ok(creek.pts[i * 4 + 1] <= creek.pts[i * 4 - 3] + 1e-6);
    assert.ok(creek.pts[i * 4 + 3] > 0 && creek.pts[i * 4 + 3] < (planned ? 4 : 2));
  }
  const cx = Math.floor(receiver.x / 140), cz = Math.floor(receiver.z / 140);
  const built = buildBrooks(world, cx, cz, 140);
  assert.ok(built?.ribbon);
  assert.ok(built.ribbon.positions.every(Number.isFinite));
  assert.ok(built.ribbon.indices.every(i => i < built.ribbon.positions.length / 3));
  // Chunks that draw brooks build their terrain with the brooks' worn beds.
  const terrain = buildTerrainArrays(world, cx, cz, 64, 140, { brooks: true });
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

test('a generated forest creek feeds the regional river at its physical water level', () => {
  const plan = currentPlan();
  const found = findCreekCell(plan, b => !b.planned);
  assert.ok(found, 'a forest spring in the region drains into a planned river');
  assertCreekConnection(plan, found.ci, found.cj, { branching: false });
});

test('the original ordinary tributary spring and drawn handoff remain physically supported', () => {
  // Without the regional river system the original generated spring still
  // feeds its branching local network through a physical drawn handoff.
  const priorPlan = planWaterRegionCandidates(42, 0, 0, { regionalTrunks: false });
  const { creek, ribbon, cx, cz } = assertCreekConnection(priorPlan, 4, 8);
  const spring = new World(42, { waterPlans: [priorPlan] }).biomeAt(creek.pts[0], creek.pts[2]);
  assert.equal(spring.id, 'forest');
  assert.ok(spring.slope >= .012 && spring.slope <= .2 && spring.h >= 2 && spring.h <= 170);
  assert.ok(ribbon.positions.length > 0 && Number.isInteger(cx) && Number.isInteger(cz));
  // The regional river now drains that basin; its creeks still reach water.
  assert.ok(findCreekCell(currentPlan(), () => true), 'the regional landscape keeps connected creeks');
});

test('a real forest creek feeds the main river when no ordinary shore receiver is available', () => {
  const { hash, diagnostics, ...payload } = currentPlan();
  payload.components = payload.components.filter(component => component.regionalTrunk);
  payload.basins = [];
  assert.equal(payload.components.length, 1);
  const plan = { ...payload, hash: descriptorHash(payload) };
  const found = findCreekCell(plan, b => !b.planned);
  assert.ok(found);
  const { creek } = assertCreekConnection(plan, found.ci, found.cj, { branching: false });
  assert.equal(creek.drainage.receiver.bodyId, `component:${payload.components[0].hash}`);
});

test('planned headwater creeks are drawn as brooks that end in their river at its level', () => {
  const plan = currentPlan(), trunk = plan.components.find(component => component.regionalTrunk);
  assert.ok(trunk?.creeks?.length > 0, 'the regional river publishes its headwater creeks');
  for (const piece of trunk.creeks) {
    assert.ok(piece.points.length >= 2 && piece.points.every(p => p.length === 4 && p[2] > 0 && p[2] < 4));
    // Each point carries the creek's water level, which never rises downstream.
    for (let i = 1; i < piece.points.length; i++) assert.ok(piece.points[i][3] <= piece.points[i - 1][3]);
    let length = 0;
    for (let i = 1; i < piece.points.length; i++) {
      length += Math.hypot(piece.points[i][0] - piece.points[i - 1][0], piece.points[i][1] - piece.points[i - 1][1]);
    }
    assert.ok(length <= 700, 'each piece stays within one brook cell reach');
  }
  const found = findCreekCell(plan, b => b.planned);
  assert.ok(found, 'a planned creek materialises as a connected brook');
  const { creek } = assertCreekConnection(plan, found.ci, found.cj, { planned: true, branching: false });
  assert.equal(creek.drainage.receiver.bodyId, `component:${trunk.hash}`);
});
