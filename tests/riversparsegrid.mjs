import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { fitRiverReach } from '../src/riverterrain.mjs';
import { fitRiverComponent } from '../src/rivercomponent.mjs';
import { bakeSparseRiverComponent, SparseRiverComponentField } from '../src/riversparsemesh.mjs';
import { BASIN_PLAN_VERSION, descriptorHash } from '../src/hydrologyformat.mjs';
import { buildTerrainArrays, buildRiver, sampleRenderedTerrainTriangle } from '../src/chunkgen.js';
import { watershedDescriptorFromWaterPlan, validateWatershedDescriptor } from '../src/watersheddescriptor.mjs';

const natural = { seed: 123, _naturalHeight: x => 24 - x * 0.002 };
function corridor(curved = true, length = 1000, zOffset = 0) {
  const points = Array.from({ length: length / 10 + 1 }, (_, index) => {
    const x = index * 10;
    return { id: `section:${index}`, x, z: zOffset + (curved ? 80 * Math.sin(x / 180) : 0),
      waterY: 23 - x * 0.002 };
  });
  const reach = fitRiverReach(natural, { status: 'candidate', source: 'spring', points }, {
    sourceClosure: false, oceanMouth: false,
    channelProfile: { id: 'regional-trunk', halfWidth: 40, startHalfWidth: 40, endHalfWidth: 48,
      depth: 1.8, morphology: true, regionalTrunk: true },
  });
  assert.equal(reach.status, 'fitted', reach.reason);
  const widths = reach.points.map(point => point.leftWidth + point.rightWidth);
  assert.ok(Math.min(...widths) > 50 && Math.max(...widths) > 100);
  return { status: 'fitted', reaches: [reach], junctions: [] };
}

function rehash(mesh) {
  const { status, activationReady, hash, ...payload } = mesh;
  mesh.hash = descriptorHash(payload);
  return mesh;
}

test('4m sparse corridors retain containment with roughly one quarter of the vertices', () => {
  for (const curved of [false, true]) {
    const component = corridor(curved);
    const original = bakeSparseRiverComponent(natural, component);
    const explicit = bakeSparseRiverComponent(natural, component, { gridStep: 2 });
    const coarse = bakeSparseRiverComponent(natural, component, { gridStep: 4 });
    assert.equal(original.status, 'baked', original.reason);
    assert.deepEqual(original, explicit, 'the default 2m descriptor remains byte stable');
    assert.equal(coarse.status, 'baked', coarse.reason);
    assert.equal(coarse.grid.step, 4);
    const ratio = coarse.grid.coords.length / original.grid.coords.length;
    assert.ok(ratio > 0.24 && ratio < 0.32, `vertex ratio ${ratio}`);
    const field = new SparseRiverComponentField(JSON.parse(JSON.stringify(coarse)));
    for (const point of component.reaches[0].points) {
      if (point.arc < 32 || point.arc > component.reaches[0].points.at(-1).arc - 32) continue;
      const sample = {};
      assert.ok(field.sample(point.x, point.z, natural._naturalHeight(point.x, point.z), sample));
      assert.ok(sample.signedDepth > 0.1, 'the centre stays continuously wet');
      assert.ok(Math.abs(sample.signedDepth - (sample.waterY - sample.floor)) < 1e-8);
      assert.ok(sample.floor <= sample.base + 1e-7);
      assert.ok(sample.base - sample.floor <= component.reaches[0].maxCut + 1e-7);
    }
    assert.equal(field.gridStep(280, 0, 420, 140), 4);
    assert.equal(field.gridStep(2000, 2000, 2140, 2140), null);
    assert.equal(bakeSparseRiverComponent(natural, component, {
      gridStep: 4, maxCells: coarse.grid.coords.length - 1,
    }).reason, 'component-mesh-budget');
    assert.equal(bakeSparseRiverComponent(natural, component, {
      gridStep: 4, maxCells: coarse.grid.coords.length,
    }).status, 'baked');
    assert.equal(bakeSparseRiverComponent(natural, component, {
      gridStep: 4, terrainOnly: true,
    }).status, 'terrain-checked');
  }
});

test('4m and 8m water fields agree with 4m production terrain subdivision and clipped shores', () => {
  for (const gridStep of [4, 8]) {
    const mesh = bakeSparseRiverComponent(natural, corridor(), { gridStep });
    assert.equal(mesh.status, 'baked', mesh.reason);
    const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, seed: natural.seed,
      preview: true, regionX: 0, regionZ: 0, basins: [], components: [mesh] };
    const plan = { ...payload, hash: descriptorHash(payload) };
    const descriptor = watershedDescriptorFromWaterPlan(plan);
    assert.equal(validateWatershedDescriptor(descriptor).valid, true);
    assert.equal(descriptor.components[0].surface.step, gridStep);
    const world = new World(natural.seed, { waterPlans: [plan], generationVersion: 3 });
    const originalNatural = world._naturalHeight.bind(world);
    world._naturalHeight = (x, z, out) => {
      const h = natural._naturalHeight(x, z);
      if (out) { originalNatural(x, z, out); out.h = out.base = h; }
      return h;
    };
    assert.equal(world.waterField.gridStep(280, 0, 420, 140), 4);
    const terrain = buildTerrainArrays(world, 2, 0, 16, 140);
    assert.equal(terrain.res, 35);
    const river = buildRiver(2, 0, 16, 140, terrain.river);
    let contacts = 0;
    for (let index = 0; index < river.wet.length; index++) {
      if (river.wet[index] > 1e-6) continue;
      const [x, y, z] = river.positions.slice(index * 3, index * 3 + 3);
      const ground = sampleRenderedTerrainTriangle(terrain.positions, terrain.res, 140, 280, 0, x, z).y;
      assert.ok(Math.abs(y - ground) < 0.002, 'shore water intersects its actual rendered ground');
      contacts++;
    }
    assert.ok(contacts > 20);
    const high = buildTerrainArrays(world, 2, 0, 96, 140);
    assert.deepEqual(high.positions, terrain.positions);
    assert.deepEqual(buildRiver(2, 0, 96, 140, high.river), river);
  }
});

test('8m regional fields contain a physical 6km broad trunk within 25000 vertices and 3MB', () => {
  const component = corridor(true, 6000);
  assert.equal(bakeSparseRiverComponent(natural, component, { gridStep: 4, maxCells: 25000 }).reason,
    'component-mesh-budget');
  const mesh = bakeSparseRiverComponent(natural, component, { gridStep: 8, maxCells: 25000 });
  assert.equal(mesh.status, 'baked', mesh.reason);
  assert.ok(mesh.grid.coords.length <= 25000);
  assert.ok(JSON.stringify(mesh).length < 3000000);
  const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, seed: natural.seed,
    preview: true, regionX: 0, regionZ: 0, basins: [], components: [mesh] };
  const descriptor = watershedDescriptorFromWaterPlan({ ...payload, hash: descriptorHash(payload) });
  assert.equal(validateWatershedDescriptor(descriptor).valid, true);
  assert.equal(descriptor.components[0].surface.step, 8);
  const field = new SparseRiverComponentField(JSON.parse(JSON.stringify(mesh)));
  for (const section of component.reaches[0].points) {
    if (section.arc < 32 || section.arc > component.reaches[0].points.at(-1).arc - 16) continue;
    const sample = {};
    assert.ok(field.sample(section.x, section.z, natural._naturalHeight(section.x), sample));
    assert.ok(sample.signedDepth > 0.1);
    assert.ok(Math.abs(sample.signedDepth - (sample.waterY - sample.floor)) < 1e-8);
  }
  assert.equal(field.gridStep(280, 0, 420, 140), 8);
  assert.equal(bakeSparseRiverComponent(natural, component, {
    gridStep: 8, maxCells: mesh.grid.coords.length - 1,
  }).reason, 'component-mesh-budget');
});

test('mixed broad and fine water owners retain 2m terrain wherever the fine owner intersects', () => {
  const broad = bakeSparseRiverComponent(natural, corridor(false, 1000, -80), { gridStep: 8 });
  const reach = fitRiverReach(natural, { status: 'candidate', source: 'fine-spring', points: [
    { x: 0, z: 90, waterY: 23 }, { x: 1000, z: 90, waterY: 21 },
  ] }, { id: 'fine-reach', sourceClosure: true, oceanMouth: false });
  assert.equal(reach.status, 'fitted', reach.reason);
  const fine = bakeSparseRiverComponent(natural, { status: 'fitted', reaches: [reach], junctions: [] });
  assert.equal(fine.status, 'baked', fine.reason);
  const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, seed: natural.seed,
    preview: true, regionX: 0, regionZ: 0, basins: [], components: [broad, fine] };
  const world = new World(natural.seed, { waterPlans: [{ ...payload, hash: descriptorHash(payload) }],
    generationVersion: 3 });
  assert.equal(world.waterField.gridStep(280, -140, 420, 0), 4);
  assert.equal(world.waterField.gridStep(280, 0, 420, 140), 2);
});

test('4m regional trunks retain a 3km broad channel within the unchanged sparse budget', () => {
  const component = corridor(true, 3000);
  assert.equal(bakeSparseRiverComponent(natural, component).reason, 'component-mesh-budget');
  const coarse = bakeSparseRiverComponent(natural, component, { gridStep: 4 });
  assert.equal(coarse.status, 'baked', coarse.reason);
  assert.ok(coarse.grid.coords.length < 40000);
  assert.throws(() => bakeSparseRiverComponent(natural, component, { gridStep: 4, maxCells: 65537 }), /budget/);
});

test('4m and 8m broad components keep a narrow tributary continuously connected at its solved junction', () => {
  const valley = { seed: 123, _naturalHeight: () => 12 };
  const point = (id, x, z) => ({ id, x, z, waterY: 11 });
  const join = point('join', 0, 0);
  const route = (id, points, sourceClosure) => ({ id, status: 'candidate', points,
    sourceClosure, oceanMouth: false });
  const profile = (id, halfWidth, regionalTrunk = false) => ({ id, halfWidth, depth: 1.2,
    morphology: true, ...(regionalTrunk ? { regionalTrunk: true } : {}) });
  const component = fitRiverComponent(valley, {
    status: 'candidate', reaches: [
      route('upper', [point('spring', -600, 0), join], true),
      route('tributary', [point('branch-spring', -400, 400), join], true),
      route('lower', [join, point('downstream', 900, 0)], false),
    ], junctions: [{ id: 'junction:join', nodeId: 'join', x: 0, z: 0 }],
  }, { junctionLength: 256, channelProfiles: {
    upper: profile('upper', 40, true), tributary: profile('tributary', 8), lower: profile('lower', 48, true),
  } });
  assert.equal(component.status, 'fitted', component.reason);
  for (const gridStep of [4, 8]) {
    const mesh = bakeSparseRiverComponent(valley, component, { gridStep });
    assert.equal(mesh.status, 'baked', mesh.reason);
    assert.ok(mesh.grid.coords.length <= 25000);
    const field = new SparseRiverComponentField(JSON.parse(JSON.stringify(mesh)));
    for (const reach of component.reaches) for (const section of reach.points) {
      if (reach.sourceClosure && section.arc < 32) continue;
      if (section.arc > reach.points.at(-1).arc - 8) continue;
      const sample = {};
      assert.ok(field.sample(section.x, section.z, 12, sample));
      assert.ok(sample.signedDepth > 0, `${reach.id} remains continuously wet`);
      assert.ok(Math.abs(sample.waterY - section.waterY) < 1e-8);
    }
    const sample = {};
    assert.ok(field.sample(join.x, join.z, 12, sample));
    assert.ok(sample.signedDepth > 1);
    assert.equal(sample.waterY, component.junctions[0].waterY);
  }
});

test('4m descriptors reject malformed step, terrain, bounds and collars', () => {
  const mesh = bakeSparseRiverComponent(natural, corridor(), { gridStep: 4 });
  const field = new SparseRiverComponentField(mesh);
  for (const gridStep of [0, 1, 3, 6, 16, NaN, '4']) {
    assert.throws(() => bakeSparseRiverComponent(natural, corridor(), { gridStep }), /grid step/);
    const altered = structuredClone(mesh);
    altered.grid.step = gridStep;
    assert.throws(() => new SparseRiverComponentField(rehash(altered)), /Malformed|Non-finite/);
  }
  const brokenSigned = structuredClone(mesh);
  brokenSigned.grid.signed[10] += 0.1;
  assert.throws(() => new SparseRiverComponentField(rehash(brokenSigned)), /Inconsistent/);
  const brokenBounds = structuredClone(mesh);
  brokenBounds.bounds.maxX += 4;
  assert.throws(() => new SparseRiverComponentField(rehash(brokenBounds)), /bounds/);
  const boundary = field.distance.findIndex(distance => distance === 0);
  const brokenCollar = structuredClone(mesh);
  brokenCollar.grid.floor[boundary] -= 0.1;
  brokenCollar.grid.signed[boundary] = brokenCollar.grid.head[boundary] - brokenCollar.grid.floor[boundary];
  assert.throws(() => new SparseRiverComponentField(rehash(brokenCollar)), /collar/);
});
