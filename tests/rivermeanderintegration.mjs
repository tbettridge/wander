import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRiverNetwork } from '../src/rivernetwork.mjs';
import { fitRiverComponent } from '../src/rivercomponent.mjs';
import { fitRiverMeanders, validatedMeanderMesh, meanderFootprintsSeparated } from '../src/rivermeanderfit.mjs';
import { bakeSparseRiverComponent } from '../src/riversparsemesh.mjs';
import { channelProfileAt } from '../src/rivercharacter.mjs';
import { BASIN_PLAN_VERSION, descriptorHash } from '../src/hydrologyformat.mjs';
import { buildTerrainArrays, buildRiver } from '../src/chunkgen.js';

const sources = [
  { x: 2958.222222222222, z: 2958.222222222222 },
  { x: 2958.222222222222, z: 3413.3333333333335 },
  { x: 3413.3333333333335, z: 3413.3333333333335 },
];

const endpointSignature = component => component.reaches.map(reach => {
  const start = reach.points[0], end = reach.points.at(-1);
  return {
    id: reach.id,
    start: start.nodeId ?? start.id,
    end: end.nodeId ?? end.id,
    startX: start.x,
    startZ: start.z,
    endX: end.x,
    endZ: end.z,
  };
});

test('actual three-source meanders preserve network topology and sparse terrain safety', () => {
  const world = new World(20260612, { generationVersion: 3 });
  const options = { riverCharacter: true, mouthLength: 64, riverMeanders: true };
  const baseline = planRiverNetwork(world, sources, { ...options, riverMeanders: false });
  const meandered = planRiverNetwork(world, [...sources].reverse(), options);
  assert.deepEqual(meandered, planRiverNetwork(world, sources, options));
  assert.equal(baseline.components.length, 1);
  assert.equal(meandered.components.length, 1);

  const before = baseline.components[0], after = meandered.components[0];
  assert.deepEqual(after.graph, before.graph);
  assert.deepEqual(after.routes, before.routes);
  assert.deepEqual(endpointSignature(after), endpointSignature(before));
  assert.equal(after.reaches.length, before.reaches.length);
  assert.equal(after.meanders.status, 'accepted');
  assert.ok(after.meanders.changedReaches > 0);
  assert.ok(after.meanders.maxExcursion > 10, 'accepted preview must move a centreline visibly');

  const phasePairs = [];
  for (const junction of after.junctions) {
    const incoming = after.reaches.filter(reach => reach.points.at(-1).nodeId === junction.nodeId);
    const outgoing = after.reaches.filter(reach => reach.points[0].nodeId === junction.nodeId);
    for (const enteringReach of incoming) for (const leavingReach of outgoing) {
      const enteringProfile = enteringReach.channelProfile;
      const leavingProfile = leavingReach.channelProfile;
      if (!enteringProfile || !leavingProfile || enteringProfile.id !== leavingProfile.id) continue;
      // A widening transition can finish before the next junction; its trend
      // interval is not the reach's canonical noise/identity distance.
      const enteringLength = after.hierarchy.channelProfiles[enteringReach.id].samples.at(-1).arc;
      const leavingLength = after.hierarchy.channelProfiles[leavingReach.id].samples.at(-1).arc;
      const entering = channelProfileAt(enteringProfile, enteringLength, enteringLength);
      const leaving = channelProfileAt(leavingProfile, 0, leavingLength);
      assert.equal(leaving.globalArc, entering.globalArc, `global profile arc at ${junction.nodeId}`);
      assert.equal(leaving.widthVariation, entering.widthVariation, `width phase at ${junction.nodeId}`);
      assert.equal(leaving.depthVariation, entering.depthVariation, `depth phase at ${junction.nodeId}`);
      assert.ok(Math.abs(enteringReach.points.at(-1).depth - entering.depth) < 1e-9,
        'fitted depth must sample the canonical downstream phase');
      assert.ok(Math.abs(leavingReach.points[0].depth - leaving.depth) < 1e-9);
      phasePairs.push(junction.nodeId);
    }
  }
  assert.ok(phasePairs.length >= 2, 'shared source profiles should cross both tested joins');

  const mesh = validatedMeanderMesh(after) || bakeSparseRiverComponent(world, after);
  assert.equal(mesh.status, 'baked', JSON.stringify(mesh));
  assert.equal(mesh.oceanHandoff, true);
  const { coords, floor, natural, head, signed, estuary } = mesh.grid;
  assert.equal(coords.length, floor.length);
  assert.equal(coords.length, natural.length);
  assert.equal(coords.length, head.length);
  assert.equal(coords.length, signed.length);
  const gridIndex = new Map(coords.map((point, index) => [point.join(','), index]));
  let wet = 0, dry = 0, shorelineEdges = 0;
  for (let i = 0; i < coords.length; i++) {
    assert.ok(Number.isFinite(head[i]));
    assert.ok(floor[i] <= natural[i] + 1e-7, 'sparse mesh must not fill terrain');
    assert.ok(natural[i] - floor[i] <= 6 + 1e-7, 'sparse mesh cut must stay within budget');
    assert.ok(Math.abs(signed[i] - (head[i] - floor[i])) <= 1e-7);
    if (signed[i] > 1e-7) wet++; else dry++;
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const j = gridIndex.get(`${coords[i][0] + dx},${coords[i][1] + dz}`);
      if (j !== undefined && (signed[i] > 1e-7) !== (signed[j] > 1e-7)) shorelineEdges++;
    }
  }
  assert.ok(wet > 0 && dry > 0, 'mesh must contain water and a dry shore');
  assert.ok(shorelineEdges > 0, 'mesh must expose a wet/dry shoreline');

  const mouthReach = after.reaches.find(reach => reach.oceanMouth);
  const mouth = mouthReach.points.at(-1);
  const mouthIndex = gridIndex.get(`${Math.round(mouth.x / 2)},${Math.round(mouth.z / 2)}`);
  assert.notEqual(mouthIndex, undefined);
  assert.equal(head[mouthIndex], 0);
  assert.equal(estuary[mouthIndex], 1);
  assert.ok(natural[mouthIndex] < -0.25);
  assert.ok(Math.abs(floor[mouthIndex] - natural[mouthIndex]) < 1e-9);

  const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, seed: world.seed,
    regionX: 0, regionZ: 0, preview: true, basins: [], components: [mesh] };
  const installed = new World(world.seed, { waterPlans: [{ ...payload, hash: descriptorHash(payload) }] });
  const cx = Math.floor(after.meanders.target.x / 140), cz = Math.floor(after.meanders.target.z / 140);
  const low = buildTerrainArrays(installed, cx, cz, 16, 140);
  const water = buildRiver(cx, cz, 16, 140, low.river);
  assert.ok(water?.indices.length > 0, 'accepted bends must render visible water');
  const high = buildTerrainArrays(installed, cx, cz, 96, 140);
  assert.deepEqual(high.positions, low.positions);
  assert.deepEqual(buildRiver(cx, cz, 96, 140, high.river), water);
});

test('short synthetic reaches retain their fitted baseline when meanders have no bend span', () => {
  const world = { seed: 17, _naturalHeight: () => 8 };
  const segmented = {
    status: 'candidate',
    reaches: [{
      id: 'short-reach', source: 'synthetic', status: 'candidate',
      sourceClosure: false, oceanMouth: false,
      points: [
        { id: 'synthetic:start', x: 0, z: 0, waterY: 4 },
        { id: 'synthetic:end', x: 0, z: 240, waterY: 3 },
      ],
    }],
    junctions: [],
  };
  const baseline = fitRiverComponent(world, segmented, { junctionLength: 0, mouthLength: 0 });
  assert.equal(baseline.status, 'fitted');
  const retained = fitRiverMeanders(world, segmented, baseline, { junctionLength: 0, mouthLength: 0 });
  assert.equal(retained.meanders.status, 'retained-baseline');
  assert.deepEqual(retained.reaches, baseline.reaches);
  assert.equal(retained.meanders.attempts.length, 3);
});

test('final curved footprints reject distant bank overlap as well as centreline crossings', () => {
  const reach = points => ({ points: points.map(([x, z], i) => ({ x, z, arc: i * 100,
    leftWidth: 2, rightWidth: 2, leftBankWidth: 6, rightBankWidth: 6,
    leftBlendWidth: 8, rightBlendWidth: 8 })) });
  assert.equal(meanderFootprintsSeparated([reach([[0, 0], [100, 0], [160, 80], [100, 160], [0, 160]])]), true);
  assert.equal(meanderFootprintsSeparated([reach([[0, 0], [100, 0], [160, 80], [100, 20], [0, 20]])]), false);
  assert.equal(meanderFootprintsSeparated([reach([[0, 0], [100, 100], [0, 100], [100, 0]])]), false);
});
