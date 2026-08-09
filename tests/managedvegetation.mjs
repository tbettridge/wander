import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANAGED_VEGETATION_ASSET_DESCRIPTOR_SCHEMA,
  MANAGED_VEGETATION_LOCAL_FRAME,
  MANAGED_VEGETATION_PLACEHOLDER_ASSETS,
  MANAGED_VEGETATION_PLACEHOLDER_IDS,
  MANAGED_VEGETATION_RESERVATION_SCHEMA,
  RESERVATION_SHAPE_KINDS,
  createManagedVegetationReservation,
  createReservationShape,
  reservationShapeContainsPoint,
  reservationShapesOverlap,
  validateManagedVegetationAssetDescriptor,
  validateManagedVegetationReservation,
  validateReservationShape,
} from '../src/managedvegetation.mjs';
import {
  MANAGED_VEGETATION_CHANNELS,
  deriveManagedVegetationChannels,
  managedVegetationChannelSeed,
  planManagedVegetationPresentation,
  validateManagedVegetationPlan,
} from '../src/managedvegetationplanner.mjs';
import { MANAGED_VEGETATION_ASSETS, MANAGED_VEGETATION_CATALOG_VERSION } from '../src/managedvegetationcatalog.sol.mjs';
import {
  authoritativeWaterReservations,
  managedVegetationPlanBaseline,
  managedVegetationReservations,
  managedVegetationSettlementFixture,
} from './fixtures/managedvegetation.mjs';

test('asset descriptor contract is frozen, placeholder-only, and schema-valid', () => {
  const descriptor = MANAGED_VEGETATION_PLACEHOLDER_ASSETS.cultivatedPlanting;
  assert.deepEqual(validateManagedVegetationAssetDescriptor(descriptor), { valid: true, errors: [] });
  assert.ok(Object.isFrozen(descriptor));
  assert.ok(Object.isFrozen(descriptor.localFrame));
  assert.deepEqual(Object.keys(descriptor).sort(), [...MANAGED_VEGETATION_ASSET_DESCRIPTOR_SCHEMA.fields].sort());
  assert.deepEqual(descriptor.localFrame, MANAGED_VEGETATION_LOCAL_FRAME);
  assert.match(descriptor.id, /^placeholder:/);
  assert.equal(descriptor.version, 1);
  assert.equal(descriptor.groundCoverEffect, 'cultivated-bed');
  assert.equal(descriptor.collisionEnvelope.blocksMovement, false);
  assert.ok(!Object.hasOwn(descriptor, 'palette'));
  assert.ok(!Object.hasOwn(descriptor, 'material'));
  assert.ok(!Object.hasOwn(descriptor, 'mesh'));
  assert.ok(descriptor.triangleBudget >= 0);
  assert.ok(descriptor.drawBudget > 0);
});

test('descriptor validation rejects incomplete or unsafe schema values', () => {
  const invalid = {
    ...MANAGED_VEGETATION_PLACEHOLDER_ASSETS.cultivatedPlanting,
    version: 99,
    trueBounds: { min: [1, 0, 0], max: [0, 0, 0] },
    capabilityTags: ['duplicate', 'duplicate'],
    collisionEnvelope: { mode: 'none', blocksMovement: true },
  };
  const result = validateManagedVegetationAssetDescriptor(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('descriptor-version'));
  assert.ok(result.errors.includes('descriptor-true-bounds-order'));
  assert.ok(result.errors.includes('descriptor-capability-tags'));
  assert.ok(result.errors.includes('descriptor-collision:none-blocks'));
});

test('reservation shapes validate and provide pure overlap/containment predicates', () => {
  assert.deepEqual(RESERVATION_SHAPE_KINDS, [
    'axis-aligned-rectangle', 'oriented-rectangle', 'circle', 'segment',
  ]);
  assert.deepEqual(MANAGED_VEGETATION_RESERVATION_SCHEMA.fields, ['id', 'source', 'shape']);
  const bed = createReservationShape({
    kind: 'axis-aligned-rectangle',
    center: { x: 0, z: 0 },
    halfExtents: { x: 2, z: 1 },
  });
  const path = createReservationShape({
    kind: 'segment',
    from: { x: -5, z: 0 },
    to: { x: 5, z: 0 },
    width: 1,
  });
  const farCircle = createReservationShape({
    kind: 'circle',
    center: { x: 20, z: 20 },
    radius: 2,
  });
  assert.equal(validateReservationShape(bed).valid, true);
  assert.equal(reservationShapesOverlap(bed, path), true);
  assert.equal(reservationShapesOverlap(bed, farCircle), false);
  assert.equal(reservationShapeContainsPoint(bed, { x: 1.9, z: 0 }), true);
  assert.equal(reservationShapeContainsPoint(bed, { x: 2.1, z: 0 }), false);
  assert.equal(validateReservationShape({ kind: 'circle', center: { x: 0, z: 0 }, radius: 0 }).valid, false);
});

test('reservation records distinguish authoritative world-water facts', () => {
  const water = authoritativeWaterReservations[0];
  assert.equal(validateManagedVegetationReservation(water).valid, true);
  assert.equal(water.source, 'authoritative-world-water');
  assert.match(water.id, /^water:/);
  assert.throws(() => createManagedVegetationReservation({
    id: 'water:invalid',
    source: 'derived-hydrology',
    shape: water.shape,
  }), /unsupported reservation source/);
});

test('named channels are deterministic and independent', () => {
  const first = deriveManagedVegetationChannels({
    seed: 901,
    scope: 'settlement:fixture:household:0',
    choices: {
      'cultivation-habit': ['habit:a', 'habit:b'],
      'bed-pattern': ['pattern:a', 'pattern:b'],
      'asset-variant': ['asset:a', 'asset:b'],
    },
  });
  const second = deriveManagedVegetationChannels({
    seed: 901,
    scope: 'settlement:fixture:household:0',
    choices: {
      'asset-variant': ['asset:a', 'asset:b'],
      'cultivation-habit': ['habit:a', 'habit:b'],
      'bed-pattern': ['pattern:a', 'pattern:b'],
    },
  });
  assert.deepEqual(first, second);
  assert.equal(managedVegetationChannelSeed({ seed: 901, scope: 'x', channel: 'a' }),
    managedVegetationChannelSeed({ seed: 901, scope: 'x', channel: 'a' }));
  const changedPattern = deriveManagedVegetationChannels({
    seed: 901,
    scope: 'settlement:fixture:household:0',
    choices: {
      'cultivation-habit': ['habit:a', 'habit:b'],
      'bed-pattern': ['pattern:x', 'pattern:y'],
      'asset-variant': ['asset:a', 'asset:b'],
    },
  });
  assert.equal(changedPattern['cultivation-habit'], first['cultivation-habit']);
  assert.equal(changedPattern['asset-variant'], first['asset-variant']);
  assert.notEqual(managedVegetationChannelSeed({ seed: 901, scope: 'x', channel: MANAGED_VEGETATION_CHANNELS[0] }),
    managedVegetationChannelSeed({ seed: 901, scope: 'x', channel: MANAGED_VEGETATION_CHANNELS[1] }));
});

test('prepared planner is byte-stable, input-order independent, catalog-backed, and has no placement', () => {
  const plan = planManagedVegetationPresentation({
    ...managedVegetationSettlementFixture,
    reservations: managedVegetationReservations,
    authoritativeWaterReservations,
  });
  const reordered = planManagedVegetationPresentation({
    ...managedVegetationSettlementFixture,
    opportunities: [...managedVegetationSettlementFixture.opportunities].reverse(),
    reservations: [...managedVegetationReservations].reverse(),
    authoritativeWaterReservations: [...authoritativeWaterReservations].reverse(),
  });
  assert.deepEqual(reordered, plan);
  assert.equal(JSON.stringify(reordered), JSON.stringify(plan));
  assert.deepEqual(validateManagedVegetationPlan(plan), { valid: true, errors: [] });
  assert.deepEqual(plan.placements, []);
  assert.equal(plan.placement, 'deferred');
  assert.equal(plan.catalogVersion, MANAGED_VEGETATION_CATALOG_VERSION);
  assert.ok(plan.presentations.every((entry) => MANAGED_VEGETATION_ASSETS[entry.assetId] === entry.descriptor));
  assert.ok(plan.presentations.every((entry) => !entry.assetId.startsWith('placeholder:')));
  assert.ok(plan.presentations.every((entry) => !Object.hasOwn(entry, 'position')));
});

test('planner keeps family-frontage references as opaque composition seams', () => {
  const plan = planManagedVegetationPresentation({
    settlementId: 'settlement:opaque-seam',
    worldSeed: 7,
    opportunities: [{
      id: 'cultivation:opaque',
      buildingId: 'building:opaque',
      householdId: 'household:opaque',
      familyFrontageId: 'frontage:opaque',
      reservationDependencyIds: [],
    }],
    reservations: [],
    authoritativeWaterReservations: [],
  });
  assert.equal(plan.presentations[0].familyFrontageId, 'frontage:opaque');
  assert.deepEqual(plan.reservationDependencyIds, []);
});
