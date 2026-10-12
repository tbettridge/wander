import test from 'node:test';
import assert from 'node:assert/strict';
import { World, groundColor } from '../src/world.js';
import { waterPlanningTerrain } from '../src/waterplanningterrain.mjs';
import { surveyDrainage, drainageMouths, drainageTree, surveyX, surveyZ, DRAINAGE_KIND } from '../src/regionaldrainage.mjs';
import { planRegionalRiver, regionalBasinCandidates, channelProfile } from '../src/regionalrivers.mjs';
import { attachBranch, fairCentreline, polylineArcs, riverHalfWidth } from '../src/regionalrivershape.mjs';
import { prepareRiverJunctions } from '../src/riverjunctions.mjs';
import { SparseRiverComponentField, bakeSparseRiverComponent } from '../src/riversparsemesh.mjs';
import { waterObjectsOverlap } from '../src/waterfootprint.mjs';
import { BASIN_PLAN_VERSION, descriptorHash } from '../src/hydrologyformat.mjs';

const SEED = 20260612;
const outerOf = (rx, rz) => ({ minX: rx * 4096 - 1024, minZ: rz * 4096 - 1024,
  maxX: (rx + 1) * 4096 + 1024, maxZ: (rz + 1) * 4096 + 1024 });
const plans = new Map();
// A World with one regional river mesh installed as its whole water plan.
function installed(mesh, rx, rz) {
  const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, preview: true, regional: 1,
    seed: SEED, regionX: rx, regionZ: rz, basins: [], components: [{ ...mesh, regionalTrunk: true }] };
  const { status, hash, activationReady, ...meshPayload } = payload.components[0];
  payload.components[0] = { status, ...meshPayload, hash: descriptorHash(meshPayload), activationReady };
  return new World(SEED, { generationVersion: 3, waterPlans: [{ ...payload, hash: descriptorHash(payload) }] });
}
function planned(rx, rz) {
  const key = `${rx},${rz}`;
  if (!plans.has(key)) {
    const world = new World(SEED, { generationVersion: 3 });
    plans.set(key, { world, river: planRegionalRiver(world, rx, rz, { outer: outerOf(rx, rz) }) });
  }
  return plans.get(key);
}

test('the drainage survey routes every land cell to the open sea or the survey edge', () => {
  const world = waterPlanningTerrain(new World(SEED, { generationVersion: 3 }));
  const survey = surveyDrainage(world, { minX: 0, minZ: 0, maxX: 4096, maxZ: 4096, cell: 32 });
  const { kind, receiver, area, filled } = survey;
  let land = 0;
  for (let k = 0; k < kind.length; k++) {
    if (kind[k] !== DRAINAGE_KIND.LAND) continue;
    land++;
    assert.ok(receiver[k] >= 0, 'land cells always drain');
    assert.ok(filled[receiver[k]] < filled[k], 'flow descends the filled surface');
    assert.ok(area[k] >= 32 * 32);
  }
  assert.ok(land > 1000);
  // Small hollows below the tide inland are depressions, not sea.
  for (let k = 0; k < kind.length; k++) if (kind[k] === DRAINAGE_KIND.OCEAN) assert.ok(survey.height[k] < -0.25);
  const mouths = drainageMouths(survey, 200000);
  assert.ok(mouths.length > 0);
  for (const mouth of mouths) assert.equal(kind[receiver[mouth]], DRAINAGE_KIND.OCEAN);
  const tree = drainageTree(survey, mouths[0]);
  assert.equal(tree[0].parent, -1);
  for (const branch of tree.slice(1)) {
    const parent = tree[branch.parent];
    assert.ok(parent.id < branch.id, 'parents precede their feeders');
    assert.equal(branch.cells.at(-1), parent.cells[branch.joinIndex], 'a feeder ends on its receiving stem');
    for (let i = 1; i < branch.cells.length; i++) assert.equal(receiver[branch.cells[i - 1]], branch.cells[i]);
  }
});

test('the default branching river rises in the hills and descends to the sea through its feeders', () => {
  const { world, river } = planned(0, 0);
  assert.equal(river.status, 'baked', JSON.stringify(river.diagnostics?.attempts?.slice(-3)));
  const { component, network, mesh } = river;
  const trunk = network.routes[0];
  const trunkLength = polylineArcs(trunk.points).at(-1);
  assert.ok(trunkLength > 3000, `main river length ${trunkLength}`);
  assert.ok(trunk.levels[0] > 15, 'the main river rises well above the sea');
  assert.equal(trunk.levels.at(-1), 0);
  const feeders = network.routes.filter(route => route.order > 0 && !route.distributary);
  assert.ok(feeders.length >= 4, 'a tree of feeders joins the main river');
  assert.ok(feeders.some(route => route.order === 2), 'feeders have feeders of their own');
  // Every reach falls, and junctions are shared at one level.
  for (const reach of component.reaches) {
    for (let i = 1; i < reach.points.length; i++) {
      const a = reach.points[i - 1], b = reach.points[i];
      assert.ok(b.waterY <= a.waterY + 1e-9, `${reach.id} never climbs`);
      assert.ok(a.waterY - b.waterY <= (b.arc - a.arc) * reach.maxGrade + 1e-9);
    }
  }
  assert.ok(component.junctions.length >= feeders.length);
  for (const junction of component.junctions) {
    const ends = component.reaches.flatMap(reach => [reach.points[0], reach.points.at(-1)])
      .filter(point => point.nodeId === junction.nodeId);
    assert.ok(ends.length >= 3);
    assert.ok(ends.every(point => point.x === junction.x && point.z === junction.z && point.waterY === junction.waterY));
  }
  assert.equal(prepareRiverJunctions(component).status, 'prepared');
  // Width follows the drained area: the river widens toward the sea.
  const mouthWidth = trunk.points.at(-12).hw, sourceWidth = trunk.points[4].hw;
  assert.ok(mouthWidth > sourceWidth * 4, `${sourceWidth} -> ${mouthWidth}`);
  assert.ok(JSON.stringify(mesh).length <= 2100000);
  assert.equal(mesh.grid.step, 4);
  assert.ok(mesh.creeks.length > 10, 'headwater creeks continue the tree above the channels');
  const field = new SparseRiverComponentField(JSON.parse(JSON.stringify(mesh))), sample = {};
  for (const reach of component.reaches) for (const point of reach.points) {
    if ((reach.sourceClosure && point.arc < 48) || reach.points.at(-1).arc - point.arc < 12 || point.depth < 0.3) continue;
    assert.ok(field.sample(point.x, point.z, world._naturalHeight(point.x, point.z), sample));
    assert.ok(sample.signedDepth > 0.03, `dry centreline in ${reach.id} at ${point.arc}`);
  }
});

test('regional river planning is deterministic and stays inside its region', () => {
  const { river } = planned(0, 0);
  const again = planRegionalRiver(new World(SEED, { generationVersion: 3 }), 0, 0, { outer: outerOf(0, 0) });
  assert.equal(again.mesh.hash, river.mesh.hash);
  const outer = outerOf(0, 0), b = river.mesh.bounds;
  assert.ok(b.minX >= outer.minX && b.maxX <= outer.maxX && b.minZ >= outer.minZ && b.maxZ <= outer.maxZ);
  for (const creek of river.mesh.creeks) for (const [x, z] of creek.points) {
    assert.ok(x >= outer.minX && x <= outer.maxX && z >= outer.minZ && z <= outer.maxZ);
  }
});

test('a coastal river splits into distributaries that reach the sea at separate mouths', () => {
  const { world, river } = planned(0, -1);
  assert.equal(river.status, 'baked');
  assert.ok(river.delta?.arms >= 2, 'the delta forks before the shore');
  const mouths = river.component.reaches.filter(reach => reach.oceanMouth);
  assert.equal(mouths.length, river.delta.arms);
  for (const reach of mouths) {
    const end = reach.points.at(-1);
    assert.equal(end.waterY, 0);
    assert.ok(world._naturalHeight(end.x, end.z) < -0.25);
  }
  for (let i = 0; i < mouths.length; i++) for (let k = i + 1; k < mouths.length; k++) {
    const a = mouths[i].points.at(-1), b = mouths[k].points.at(-1);
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 120, 'each arm opens at its own mouth');
  }
  const fork = river.component.junctions.find(j => j.outgoingReachIds?.length >= 2);
  assert.ok(fork, 'the fork is one shared junction');
  assert.ok(fork.waterY <= 1.6);
  // Feeders come first: the river forks below every confluence on its trunk.
  const feeders = river.network.routes.filter(route => route.order === 1 && !route.distributary);
  assert.ok(feeders.length > 0);
  for (const feeder of feeders) assert.ok(feeder.joinStation < river.network.delta.apex, `${feeder.id} joins above the fork`);
  // Every arm reaches the coast the main channel enters, not another bay.
  const main = river.network.routes[0].points, heading = line => {
    const a = line.at(-10), b = line.at(-1), length = Math.hypot(b.x - a.x, b.z - a.z);
    return [(b.x - a.x) / length, (b.z - a.z) / length];
  };
  for (const arm of river.network.routes.filter(route => route.distributary)) {
    const [ax, az] = heading(arm.points), [mx, mz] = heading(main);
    assert.ok(ax * mx + az * mz > 0.3, `${arm.id} opens onto the main channel's coast`);
  }
});

test('a delta publishes its channels so the terrain can dress its marsh plain', () => {
  const { river } = planned(0, -1);
  const channels = river.mesh.delta?.channels;
  assert.equal(channels?.length, river.delta.arms, 'the main channel and every arm');
  const world = installed(river.mesh, 0, -1);
  const apex = river.network.routes[0].points[river.network.delta.apex];
  assert.ok(world.waterField.deltaPlain(apex.x, apex.z) > 0.99, 'the fork stands in its plain');
  assert.equal(world.waterField.deltaPlain(apex.x + 3000, apex.z), 0);
  for (const line of channels) {
    const [x, z] = line[Math.floor(line.length / 2)];
    assert.ok(world.waterField.deltaPlain(x + 120, z) > 0.5, 'the plain spreads beside each channel');
  }
  // Low shore ground on the plain is reed marsh and mud, not pale dune sand.
  const sand = [0, 0, 0], marsh = [0, 0, 0];
  groundColor(world, apex.x, apex.z, 1.6, 0.02, 12, 0.4, sand);
  groundColor(world, apex.x, apex.z, 1.6, 0.02, 12, 0.4, marsh, 0, 0, 0, 0, 1);
  assert.ok(marsh[0] + marsh[1] + marsh[2] < sand[0] + sand[1] + sand[2] - 0.4, 'darker than sand');
  assert.ok(marsh[1] > marsh[2] * 1.4, 'green-brown rather than grey');
  // A malformed plain is refused with the rest of the plan.
  const { status, hash, activationReady, ...payload } = river.mesh;
  const broken = { status, ...payload, delta: { channels: [[[apex.x, apex.z]]] } };
  assert.throws(() => installed({ ...broken, hash: descriptorHash({ ...payload, delta: broken.delta }), activationReady }, 0, -1),
    /Malformed delta plain/);
});

test('mountain creeks never run uphill and touch other creeks only where they join', () => {
  for (const [rx, rz] of [[-1, -1], [0, 0]]) {
    const { river } = planned(rx, rz);
    const world = installed(river.mesh, rx, rz), pieces = river.mesh.creeks, info = {};
    assert.ok(pieces.length > 8, `region ${rx},${rz} keeps its creeks`);
    for (const piece of pieces) {
      for (let i = 1; i < piece.points.length; i++) {
        const a = piece.points[i - 1], b = piece.points[i];
        assert.ok(b[3] <= a[3], `${piece.id} holds a falling water level`);
        // The ground the creek has worn never stands above its water.
        for (let k = 0; k < 4; k++) {
          const t = k / 4, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
          const ground = world.height(x, z, info);
          if (info.signedDepth > 0) continue;
          assert.ok(ground <= a[3] + (b[3] - a[3]) * t + 0.05, `${piece.id} climbs at ${x.toFixed(0)},${z.toFixed(0)}`);
        }
      }
    }
    // Different creeks meet only at a junction: within a few metres of an end.
    const ends = pieces.flatMap(piece => [piece.points[0], piece.points.at(-1)]);
    const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const creekOf = piece => piece.id.replace(/:\d+$/, '');
    for (let m = 0; m < pieces.length; m++) for (let n = m + 1; n < pieces.length; n++) {
      if (creekOf(pieces[m]) === creekOf(pieces[n])) continue;
      const A = pieces[m].points, B = pieces[n].points;
      for (let i = 1; i < A.length; i++) for (let j = 1; j < B.length; j++) {
        if (cross(A[i - 1], A[i], B[j - 1]) * cross(A[i - 1], A[i], B[j]) >= 0) continue;
        if (cross(B[j - 1], B[j], A[i - 1]) * cross(B[j - 1], B[j], A[i]) >= 0) continue;
        const near = ends.some(e => Math.hypot(e[0] - A[i][0], e[1] - A[i][1]) < 8);
        assert.ok(near, `${pieces[m].id} crosses ${pieces[n].id}`);
      }
    }
  }
});

test('feeders join at a downstream-pointing angle without crossing the receiving river', () => {
  const parent = Array.from({ length: 40 }, (_, i) => ({ x: i * 16, z: 0, area: 1e6 }));
  const child = Array.from({ length: 30 }, (_, i) => ({ x: 140 + i * 8, z: 400 - i * 13, area: 1e5 }));
  const attached = attachBranch(child, parent, { parentFoot: () => 60, parentHalfWidth: () => 20, childFoot: () => 20 });
  assert.ok(attached);
  const end = attached.points.at(-1), before = attached.points.at(-3);
  assert.deepEqual([end.x, end.z], [parent[attached.index].x, parent[attached.index].z]);
  const approach = Math.atan2(end.z - before.z, end.x - before.x) * 180 / Math.PI;
  assert.ok(approach > -90 && approach < -5, `joins with the current (${approach})`);
  assert.ok(attached.points.slice(0, -2).every(p => p.z > 0), 'stays on its own bank');
});

test('fairing opens bends too tight for the expected bank envelope', () => {
  const kinked = Array.from({ length: 40 }, (_, i) => ({ x: i * 16, z: i > 20 ? (i - 20) * 16 : 0, area: 1e6 }));
  const faired = fairCentreline(kinked, () => 40);
  assert.ok(faired);
  assert.deepEqual([faired[0].x, faired[0].z], [0, 0]);
  assert.deepEqual([faired.at(-1).x, faired.at(-1).z], [kinked.at(-1).x, kinked.at(-1).z]);
});

test('channel profiles fall monotonically and start as a surface spring', () => {
  const world = { _naturalHeight: (x) => Math.max(-2, 30 - x * 0.012 + Math.sin(x / 37) * 0.8) };
  const points = Array.from({ length: 160 }, (_, i) => ({ x: i * 16, z: 0, area: 4e5 }));
  const profile = channelProfile(world, points, { endLevel: 0, grade: 0.025, cut: 8 });
  assert.ok(profile);
  for (let i = 1; i < profile.levels.length; i++) assert.ok(profile.levels[i] <= profile.levels[i - 1] + 1e-9);
  assert.equal(profile.levels.at(-1), 0);
  const head = points[profile.start];
  assert.ok(world._naturalHeight(head.x) - profile.levels[0] <= 1.6, 'the spring rises at the surface');
});

test('sparse footprints let separate water own ground inside one bounding box', () => {
  const lattice = (x0, z0, cols, rows) => {
    const coords = [];
    for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) coords.push([x0 + x, z0 + z]);
    return { version: 3, grid: { step: 4, coords }, bounds: { minX: x0 * 4, minZ: z0 * 4,
      maxX: (x0 + cols - 1) * 4, maxZ: (z0 + rows - 1) * 4 } };
  };
  // An L-shaped river: two corridors whose box encloses an empty corner.
  const river = lattice(0, 0, 200, 10);
  river.grid.coords.push(...lattice(190, 10, 10, 190).grid.coords);
  river.bounds = { minX: 0, minZ: 0, maxX: 199 * 4, maxZ: 199 * 4 };
  const lake = { bounds: { minX: 100, minZ: 300, maxX: 300, maxZ: 500 } };
  assert.equal(waterObjectsOverlap(river, lake), false, 'a lake in the empty corner stays');
  assert.equal(waterObjectsOverlap(river, { bounds: { minX: 700, minZ: 300, maxX: 900, maxZ: 400 } }), true);
  assert.equal(waterObjectsOverlap(river, lattice(20, 60, 10, 10)), false);
  assert.equal(waterObjectsOverlap(river, lattice(20, 5, 10, 10)), true);
});

test('quantized meshes keep every vertex on its own side of the waterline', () => {
  const { world, river } = planned(0, 0);
  const exact = bakeSparseRiverComponent(waterPlanningTerrain(world), river.component, { gridStep: 4, maxCells: 60000 });
  const compact = river.mesh;
  assert.equal(exact.grid.coords.length, compact.grid.coords.length);
  for (let i = 0; i < exact.grid.signed.length; i++) {
    assert.equal(exact.grid.signed[i] > 0, compact.grid.signed[i] > 0);
    assert.ok(Math.abs(exact.grid.head[i] - compact.grid.head[i]) <= 0.0025 || exact.grid.signed[i] <= 0);
    assert.ok(compact.grid.floor[i] <= compact.grid.natural[i]);
  }
  assert.ok(JSON.stringify(compact).length < JSON.stringify(exact).length * 0.6);
  const withWater = installed(compact, 0, 0);
  const mouth = river.network.routes[0].points.at(-16);
  assert.ok(withWater.riverAt(mouth.x, mouth.z).wet);
  assert.ok(withWater.waterField.plannedCreeks(-1e6, -1e6, 1e6, 1e6).length === compact.creeks.length);
});

test('basin candidates belong to the region holding the middle of their main stem', () => {
  const world = waterPlanningTerrain(new World(SEED, { generationVersion: 3 }));
  const outer = outerOf(0, 0);
  const survey = surveyDrainage(world, { minX: outer.minX + 192, minZ: outer.minZ + 192,
    maxX: outer.maxX - 192, maxZ: outer.maxZ - 192, cell: 16 });
  const candidates = regionalBasinCandidates(survey, 0, 0);
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    const cells = drainageTree(survey, candidate.mouth, { branchArea: [], maxBranches: 1 })[0].cells;
    const middle = cells[Math.floor(cells.length / 2)];
    assert.ok(surveyX(survey, middle) >= 0 && surveyX(survey, middle) < 4096);
    assert.ok(surveyZ(survey, middle) >= 0 && surveyZ(survey, middle) < 4096);
  }
  assert.ok(riverHalfWidth(4e6) > riverHalfWidth(1e5) * 3);
});
