import test from 'node:test';
import assert from 'node:assert/strict';
import { planWaterRegionCandidates } from '../src/hydrologyregions.mjs';
import { descriptorHash } from '../src/hydrologyformat.mjs';
import {
  WATERSHED_DESCRIPTOR_VERSION,
  descriptorBoundaryContracts,
  validateWaterPlanForWatershedDescriptor,
  validateWatershedDescriptor,
  watershedDescriptorFromWaterPlan,
} from '../src/watersheddescriptor.mjs';

function plan(payload) { return { ...payload, hash: descriptorHash(payload) }; }

function basinFixture() {
  const cols = 7, rows = 7, level = 10, floor = [], signed = [];
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    const wet = x > 0 && x < cols - 1 && z > 0 && z < rows - 1 && !(x === 3 && z === 3);
    const depth = wet ? 2 : -1;
    signed.push(depth); floor.push(level - depth);
  }
  return {
    id: 'basin:fixture:103:103', kind: 'lake', centerX: 103, centerZ: 103, level,
    spill: 12, area: 12, length: 4, maxDepth: 2,
    bounds: { minX: 100, minZ: 100, maxX: 106, maxZ: 106 },
    grid: { x0: 100, z0: 100, cols, rows, step: 1, floor, signed },
    material: { kind: 2, turbidity: 0.2, exposure: 0.1, turbulence: 0, estuary: 0 },
  };
}

function basePayload(extra = {}) {
  return { version: 1, generationVersion: 3, preview: true, regional: 1,
    seed: 7, regionX: 0, regionZ: 0, basins: [], components: [], ...extra };
}

function fittedPoint(id, x, z, waterY = 7) {
  return { id, x, z, tx: 1, tz: 0, arc: Math.abs(x - 4000), waterY, depth: 1,
    leftWidth: 3, rightWidth: 4, leftBankWidth: 5, rightBankWidth: 6,
    leftBlendWidth: 8, rightBlendWidth: 9, leftBankY: 8, rightBankY: 8,
    leftInner: 0.5, rightInner: 0.5, leftShoulder: 0.3, rightShoulder: 0.3 };
}

function sparseComponent() {
  const grid = {
    step: 2,
    coords: [[2047, 0], [2048, 0], [2047, 1], [2048, 1]],
    floor: [0, 0, 0, 0], natural: [0, 0, 0, 0], head: [2, 2, 2, 2],
    signed: [2, 2, 2, 2], flowX: [1, 1, 1, 1], flowZ: [0, 0, 0, 0], estuary: [0, 0, 0, 0],
  };
  const payload = { version: 3, seed: 7, reachIds: ['reach:mesh-only'], oceanHandoff: false,
    bounds: { minX: 4094, maxX: 4096, minZ: 0, maxZ: 2 }, grid };
  return { status: 'baked', ...payload, hash: descriptorHash(payload), activationReady: false };
}

test('adapter preserves triangle shoreline topology, holes and basin ownership', () => {
  const descriptor = watershedDescriptorFromWaterPlan(plan(basePayload({ basins: [basinFixture()] })));
  const basin = descriptor.basins[0];
  assert.equal(descriptor.version, WATERSHED_DESCRIPTOR_VERSION);
  assert.equal(basin.id, 'basin:fixture:103:103');
  assert.equal(basin.ownerId, 'region:7:3:0:0');
  assert.equal(basin.topology.shoreline, 'exact');
  assert.equal(basin.shoreline.outers.length, 1);
  assert.equal(basin.shoreline.holes.length, 1);
  assert.equal(basin.shoreline.loops.filter(loop => loop.role === 'hole').length, 1);
  assert.equal(basin.surface.triangleDiagonal, 'a-d');
  assert.ok(basin.surface.terrainInfluence.samples.length > 0);
  assert.equal(validateWatershedDescriptor(descriptor).valid, true);
  assert.ok(Object.isFrozen(descriptor));
  assert.ok(Object.isFrozen(basin.shoreline.holes[0]));
});

test('fitted routes expose exact centerlines and canonical level/width boundary contracts', () => {
  const reaches = [{
    status: 'fitted', id: 'reach:crossing', source: 'source:fixture', outlet: 'outlet:fixture',
    sourceClosure: true, oceanMouth: false, maxGrade: 0.025, maxFill: 2, maxCut: 6,
    bounds: { minX: 3900, minZ: 200, maxX: 4200, maxZ: 200 },
    points: [fittedPoint('p0', 4000, 200), fittedPoint('p1', 4200, 200, 6)],
  }];
  const descriptor = watershedDescriptorFromWaterPlan(plan(basePayload({ reaches })));
  const river = descriptor.rivers[0];
  assert.equal(river.geometry.topology, 'exact');
  assert.deepEqual(river.connections.basinIds, []);
  assert.equal(river.geometry.centerline[0].width.left, 3);
  const contracts = descriptorBoundaryContracts(descriptor).filter(contract => contract.featureId === 'reach:crossing');
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0].axis, 'x');
  assert.equal(contracts[0].boundaryIndex, 1);
  assert.equal(contracts[0].position.x, 4096);
  assert.equal(contracts[0].level, 6.52);
  assert.equal(contracts[0].width.left, 3);
  assert.equal(contracts[0].width.right, 4);
  assert.equal(contracts[0].bankInfluence.left, 13);
  assert.deepEqual(contracts[0].tangent, { x: 1, z: 0 });
});

test('sparse component keeps retained samples and marks missing route topology unknown', () => {
  const descriptor = watershedDescriptorFromWaterPlan(plan(basePayload({ components: [sparseComponent()] })));
  const component = descriptor.components[0];
  assert.deepEqual(component.reachIds, ['reach:mesh-only']);
  assert.equal(component.topology.centerline, 'unknown');
  assert.equal(component.topology.ownership, 'exact');
  assert.ok(component.surface.samples.length > 0);
  assert.ok(component.surface.fields.includes('flowX'));
  const contracts = descriptor.boundaryContracts.filter(contract => contract.featureId === component.id);
  assert.ok(contracts.length > 0);
  assert.equal(contracts[0].width, null);
  assert.equal(contracts[0].tangent, null);
  assert.deepEqual(contracts[0].flow, { x: 1, z: 0 });
  assert.equal(validateWatershedDescriptor(descriptor).valid, true);
});

test('adapter is deterministic, immutable and compact on an actual regional accepted plan', () => {
  const accepted = planWaterRegionCandidates(4242, 1, 0);
  const first = watershedDescriptorFromWaterPlan(accepted);
  const second = watershedDescriptorFromWaterPlan(accepted);
  assert.deepEqual(first, second);
  assert.equal(validateWatershedDescriptor(first).valid, true);
  assert.equal(first.source.planHash, accepted.hash);
  assert.ok(first.components.length > 0);
  assert.ok(JSON.stringify(first).length < JSON.stringify(accepted).length);
  assert.ok(first.components.every(component => component.surface.samples.length <= 65536));
  assert.ok(first.components.every(component => component.topology.centerline === 'unknown'));
});

test('source and descriptor validation reject corruption without fabricating a fallback', () => {
  const valid = plan(basePayload({ basins: [basinFixture()] }));
  const corrupt = structuredClone(valid);
  corrupt.basins[0].grid.signed[0] = Number.NaN;
  const sourceResult = validateWaterPlanForWatershedDescriptor(corrupt);
  assert.equal(sourceResult.valid, false);
  assert.ok(sourceResult.errors.some(error => error.startsWith('source-basin-grid')));
  assert.throws(() => watershedDescriptorFromWaterPlan(corrupt), /Invalid watershed source/);

  const tampered = { ...valid, hash: 'tampered' };
  assert.equal(validateWaterPlanForWatershedDescriptor(tampered).valid, true, 'default path trusts upstream plan validation');
  assert.equal(validateWaterPlanForWatershedDescriptor(tampered, { verifyHash: true }).valid, false);
  assert.throws(() => watershedDescriptorFromWaterPlan(tampered, { verifyPlanHash: true }), /checksum/);

  const descriptor = watershedDescriptorFromWaterPlan(valid);
  const changed = structuredClone(descriptor);
  changed.basins[0].level += 1;
  assert.ok(validateWatershedDescriptor(changed).errors.includes('descriptor-checksum'));
});
