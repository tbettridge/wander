import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeRiverMeanders, proposeRiverConfluences } from '../src/rivermeanders.mjs';
import { fitRiverReach, riverSectionFloor, RiverReachField } from '../src/riverterrain.mjs';
import { fitRiverComponent } from '../src/rivercomponent.mjs';
import { bakeSparseRiverComponent, SparseRiverComponentField } from '../src/riversparsemesh.mjs';
import { prepareNetworkPreview } from '../src/hydrologyworker.js';
import { World } from '../src/world.js';
import { buildTerrainArrays, buildRiver } from '../src/chunkgen.js';
import { planBasins } from '../src/basinplanner.mjs';
import { planLakeSystem } from '../src/basininlets.mjs';
import { planBasinDrainage } from '../src/basinoutlet.mjs';
import { planRiverNetwork } from '../src/rivernetwork.mjs';
import { waterPlanningTerrain } from '../src/waterplanningterrain.mjs';

const world = { seed: 77, _naturalHeight: () => 8 };
const profile = (id, halfWidth, arcOffset = 0) => ({ id, halfWidth, depth: 1.2, variationSeed: 77, arcOffset });
const route = (id, ax, az, bx, bz, count = 32) => ({
  id, status: 'candidate', sourceClosure: false, oceanMouth: false,
  points: Array.from({ length: count + 1 }, (_, i) => ({
    id: `${id}:${i}`, x: ax + (bx - ax) * i / count, z: az + (bz - az) * i / count,
    waterY: 5, preferredY: 5,
  })),
});

test('long lowland rivers continue alternating irregular bends throughout the valley', () => {
  const input = { status: 'candidate', reaches: [route('long-valley', 0, 0, 0, 2560, 80)], junctions: [] };
  const first = proposeRiverMeanders(world, input);
  assert.deepEqual(first, proposeRiverMeanders(world, input));
  const points = first.reaches[0].points;
  const sides = points.filter(p => Math.abs(p.x) > 3).map(p => Math.sign(p.x));
  const crossings = sides.slice(1).filter((side, i) => side !== sides[i]);
  assert.ok(crossings.length >= 7, 'a long valley must not stretch only a few bends over kilometres');
  assert.ok(first.diagnostics.reaches[0].sinuosity > 1.015);
  assert.ok(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.z)));
  assert.equal(points[0].id, input.reaches[0].points[0].id);
  assert.equal(points[0].x, 0); assert.equal(points[0].z, 0);
  assert.equal(points.at(-1).x, 0);
  assert.equal(points.at(-1).z, 2560);
});

test('a tributary turns into the current while retaining one main stem and a contained wet junction', () => {
  const main = route('main', 0, 0, 0, 640);
  const branch = route('branch', 320, 320, 0, 640, 16);
  const outlet = route('outlet', 0, 640, 0, 1040, 16);
  main.points.at(-1).id = branch.points.at(-1).id = outlet.points[0].id = 'join';
  const input = { status: 'candidate', reaches: [main, branch, outlet], junctions: [{ nodeId: 'join', id: 'join' }] };
  const profiles = { main: profile('main', 4), branch: profile('branch', 2), outlet: profile('main', 5, 640) };
  const options = { channelProfiles: profiles, junctionLength: 128 };
  const shaped = proposeRiverConfluences(world, input, options);
  assert.deepEqual(shaped, proposeRiverConfluences(world, input, options));
  assert.deepEqual(shaped.reaches[0], main, 'main stem stays fixed');
  assert.deepEqual(shaped.reaches[2], outlet, 'downstream reach stays fixed');
  assert.equal(shaped.diagnostics.confluences.length, 1);
  const changed = shaped.reaches[1].points, end = changed.at(-1), before = changed.at(-2);
  assert.deepEqual(end, branch.points.at(-1));
  const alignment = (end.z - before.z) / Math.hypot(end.x - before.x, end.z - before.z);
  assert.ok(alignment > 0.88, 'the tributary enters in the downstream direction');
  const fitted = fitRiverComponent(world, shaped, options);
  assert.equal(fitted.status, 'fitted');
  const mesh = bakeSparseRiverComponent(world, fitted);
  assert.equal(mesh.status, 'baked', mesh.reason);
  assert.ok(mesh.grid.signed.some(d => d > 0));
  assert.ok(mesh.grid.signed.some(d => d < 0));
  assert.deepEqual(input.reaches[1], branch, 'proposal must not mutate routing');
});

test('seeded bank variation stays continuous through a split channel without losing containment', () => {
  const upstream = fitRiverReach(world, route('upper', 0, 0, 0, 480), {
    sourceClosure: false, oceanMouth: false, channelProfile: profile('shared', 4),
  });
  const downstream = fitRiverReach(world, route('lower', 0, 480, 0, 960), {
    sourceClosure: false, oceanMouth: false, channelProfile: profile('shared', 4, 480),
  });
  assert.equal(upstream.status, 'fitted'); assert.equal(downstream.status, 'fitted');
  for (const side of ['left', 'right']) for (const key of ['BankWidth', 'BlendWidth', 'Shoulder']) {
    assert.equal(upstream.points.at(-1)[side + key], downstream.points[0][side + key], `${side}${key} phase`);
  }
  const widths = upstream.points.map(p => p.leftBankWidth);
  assert.ok(Math.max(...widths) - Math.min(...widths) > 0.4);
  assert.ok(upstream.points.some(p => Math.abs(p.leftBankWidth - p.rightBankWidth) > 0.1));
  for (const reach of [upstream, downstream]) for (const p of reach.points) {
    assert.ok(p.waterY <= Math.min(p.leftBankY, p.rightBankY) - 0.2 + 1e-9);
  }
});

test('the complete production river preview retains a publishable joined network after wider bank fitting', () => {
  const preview = prepareNetworkPreview({ seed: 20260612, regionX: 0, regionZ: 0,
    riverCharacter: true, riverMeanders: true, riverMorphology: true });
  assert.ok(preview.sourceCount >= 3);
  assert.ok(preview.junctionCount >= 2);
  assert.ok(preview.plan.components[0].oceanHandoff);
  assert.equal(preview.meanders.status, 'accepted');
  assert.ok(preview.meanders.changedReaches >= 3,
    'the receiving main stem must keep its bend through a densely sampled mouth collar');
  assert.ok(preview.widthRange.max > preview.widthRange.min * 2);
});

test('inner bend shelves are shallower and slower than the outer pool at one shared water level', () => {
  const curved = route('point-bar', 0, 0, 1, 1, 32);
  curved.points = curved.points.map((p, i) => {
    const angle = i / 32 * Math.PI / 2;
    return { ...p, x: 160 * Math.cos(angle), z: 160 * Math.sin(angle) };
  });
  const reach = fitRiverReach(world, curved, { sourceClosure: false, oceanMouth: false,
    channelProfile: { ...profile('bar', 6), morphology: true } });
  assert.equal(reach.status, 'fitted', reach.reason);
  const section = reach.points.reduce((best, p) => Math.max(p.leftBar, p.rightBar)
    > Math.max(best.leftBar, best.rightBar) ? p : best);
  const inner = section.leftBar > section.rightBar ? 'left' : 'right';
  const outer = inner === 'left' ? 'right' : 'left';
  assert.ok(section[`${inner}Bar`] > 0.15, 'exercise a real curved inner shelf');
  const lateral = side => (side === 'left' ? -1 : 1) * section[`${side}Width`] * 0.6;
  const innerFloor = riverSectionFloor(section, lateral(inner), 8);
  const outerFloor = riverSectionFloor(section, lateral(outer), 8);
  assert.ok(innerFloor > outerFloor + 0.05, 'deposition raises the inner bed');
  const field = new RiverReachField(reach), sample = side => {
    const offset = lateral(side), info = {};
    assert.ok(field.sample(section.x - section.tz * offset, section.z + section.tx * offset, 8, info));
    return info;
  };
  const a = sample(inner), b = sample(outer);
  assert.ok(Math.abs(a.waterY - b.waterY) < 1e-7, 'banks share one water surface');
  assert.ok(Math.hypot(a.flowX, a.flowZ) < Math.hypot(b.flowX, b.flowZ) * 0.9,
    'current quietens over the deposited shelf');
  for (const offset of [-8, -4, 0, 4, 8]) {
    const low = riverSectionFloor(section, offset, 8, 0), high = riverSectionFloor(section, offset, 8, 1);
    assert.ok(Math.abs(riverSectionFloor(section, offset, 8, 0.37) - (low + (high - low) * 0.37)) < 1e-9,
      'the earthwork solve remains affine in water level');
  }
});

test('modern pond drainage keeps contained inlets and a wider varied outlet in the same mesh', () => {
  const current = new World(42, { generationVersion: 3 });
  const basin = planBasins(current, 0, 0).basins.find(b => b.id === 'basin:42:4032:960');
  const character = { riverCharacter: true, riverMeanders: true, riverMorphology: true };
  const system = planLakeSystem(current, basin, { inland: false, outlet: character, inlets: character });
  assert.equal(system.status, 'baked', system.reason);
  assert.ok(system.inletCount >= 1);
  const outlet = system.component.reaches.find(reach => !reach.sourceClosure);
  const inlets = system.component.reaches.filter(reach => reach.sourceClosure);
  assert.ok(outlet.oceanMouth);
  assert.ok(system.mesh.oceanHandoff);
  for (const reach of [outlet, ...inlets]) {
    assert.ok(reach.channelProfile.morphology);
    assert.ok(reach.basinIds.includes(basin.id));
  }
  const widths = reach => reach.points.filter(p => p.arc > 24 && p.arc < reach.points.at(-1).arc - 32)
    .map(p => p.leftWidth + p.rightWidth);
  const average = values => values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(average(widths(outlet)) > Math.max(...inlets.map(reach => average(widths(reach)))) * 1.2);
  assert.ok(Math.max(...widths(outlet)) / Math.min(...widths(outlet)) > 1.2);
  const limited = planBasinDrainage(current, basin, { ...character, maxCells: 100 });
  assert.equal(limited.status, 'rejected');
  assert.equal(limited.reason, 'component-mesh-budget', 'meander caching must honor explicit mesh budgets');
});

test('standalone rivers receive organic banks without needing a joining tributary', () => {
  const valley = { seed: 777, _naturalHeight: (x, z) => 4 - x * 0.006
    + Math.min(z * z / 180, (z + x - 100) ** 2 / 360)
    - 3 * Math.exp(-((x + 128) ** 2 + (z - 228) ** 2) / 400) };
  const network = planRiverNetwork(valley, [{ x: -256, z: 0 }], {
    mouthLength: 64, riverCharacter: true, riverMorphology: true,
  });
  assert.equal(network.components.length, 1);
  const component = network.components[0];
  assert.equal(component.sources.length, 1);
  assert.equal(component.junctions.length, 0);
  for (const reach of component.reaches) {
    assert.ok(reach.channelProfile.morphology);
    assert.ok(reach.points.every(point => point.linearShore));
    const banks = reach.points.map(point => point.leftBankWidth);
    assert.ok(Math.max(...banks) - Math.min(...banks) > 0.1);
  }
});

test('lake shore clipping retains the wet material instead of inventing river foam', () => {
  const mesh = buildRiver(0, 0, 1, 2, { res: 1, waterY: [4, 4, 4, 4], headY: [4, 4, 4, 4],
    signed: [0.1, -0.2, -0.2, -0.2], depth: [0.1, 0, 0, 0],
    body: new Float32Array([1, 0.2, 0.65, 0, -1, 0.15, 0.25, 0, -1, 0.15, 0.25, 0, -1, 0.15, 0.25, 0]),
  });
  assert.ok(mesh?.body);
  for (let i = 0; i < mesh.body.length; i += 4) assert.equal(mesh.body[i], 1);
});

test('planning height cache retains rich natural terrain metadata and exact fractional samples', () => {
  const original = new World(42, { generationVersion: 3 });
  const cached = waterPlanningTerrain(original);
  const expected = {}, actual = {};
  original._naturalHeight(140, 280, expected);
  cached._naturalHeight(140, 280);
  cached._naturalHeight(140, 280, actual);
  assert.deepEqual(actual, expected);
  assert.equal(cached.height(140, 280), original.height(140, 280));
  assert.equal(cached._naturalHeight(140.2, 280.7), original._naturalHeight(140.2, 280.7));
});

test('terrain preflight checks the exact cut budget and cannot masquerade as a published mesh', () => {
  const reach = fitRiverReach(world, route('preflight', 0, 0, 0, 320), {
    sourceClosure: false, oceanMouth: false,
  });
  assert.equal(reach.status, 'fitted');
  const component = { status: 'fitted', reaches: [reach], junctions: [] };
  const checked = bakeSparseRiverComponent(world, component, { terrainOnly: true });
  assert.deepEqual(checked, { status: 'terrain-checked' });
  assert.throws(() => new SparseRiverComponentField(checked), /identity/);
  assert.equal(bakeSparseRiverComponent(world, component).status, 'baked');
  const highCut = { seed: 77, _naturalHeight: (x, z) => x === 0 && z === 160 ? 30 : 8 };
  for (const terrainOnly of [true, false]) {
    const rejected = bakeSparseRiverComponent(highCut, component, { terrainOnly });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reason, 'junction-cut-budget');
    assert.deepEqual([rejected.x, rejected.z], [0, 160]);
  }
});

test('low inland river banks carry turf and sediment through the coastal beach height band', () => {
  const preview = prepareNetworkPreview({ seed: 20260612, regionX: 0, regionZ: 0,
    riverCharacter: true, riverMeanders: true, riverMorphology: true });
  const current = new World(20260612, { waterPlans: [preview.plan] });
  const join = preview.channelInspection.views.find(view => view.kind === 'junction');
  const terrain = buildTerrainArrays(current, Math.floor(join.x / 140), Math.floor(join.z / 140), 96, 140);
  let checked = 0;
  for (let i = 0; i < (terrain.res + 1) ** 2; i++) {
    const [x, h, z] = terrain.positions.slice(i * 3, i * 3 + 3), info = {};
    current.height(x, z, info);
    if (info.waterKind !== -1 || info.estuary > 0.01 || info.base - h < 0.2
      || info.waterY - h > -0.2 || info.waterY - h < -1.8 || h >= 2.8) continue;
    const colour = terrain.colors.slice(i * 3, i * 3 + 3);
    assert.ok(colour[0] < 0.42, `carved inland bank became bright coastal sand at ${x}, ${z}`);
    assert.ok(colour[1] > colour[2], 'bank pigment retains the surrounding green/earth palette');
    checked++;
  }
  assert.ok(checked > 20, 'exercise the low carved dry shore, not only underwater vertices');
});
