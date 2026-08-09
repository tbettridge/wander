import test from 'node:test';
import assert from 'node:assert/strict';
import { settlementForCell } from '../src/settlementplacement.mjs';
import { createSettlementPlan } from '../src/settlementplan.mjs';
import { MANAGED_VEGETATION_ASSETS, MANAGED_VEGETATION_CATALOG_VERSION } from '../src/managedvegetationcatalog.sol.mjs';
import { validateManagedVegetationPlan } from '../src/managedvegetationplanner.mjs';
import { reservationShapesOverlap } from '../src/managedvegetation.mjs';
import { collisionSegmentsForManagedVegetation, StructureCollisionIndex } from '../src/structurecollision.mjs';
import { settlementGroundAtPlans } from '../src/settlementspatial.mjs';

const world = {
  seed: 77,
  height() { return 18; },
  biomeAt() { return { h: 18, slope: 0.04, m: 0.58, id: 'grassland' }; },
  riverAt() { return { wet: false }; },
};

function firstSite() {
  for (let z = -4; z <= 4; z++) for (let x = -4; x <= 4; x++) {
    const site = settlementForCell(world, x, z, world.seed);
    if (site) return site;
  }
  throw new Error('test corpus produced no settlement');
}

function plan(waterAt = () => false) {
  return createSettlementPlan(firstSite(), {
    heightAt: world.height.bind(world), authoritativeWaterAt: waterAt,
  });
}

function buildingShape(building) {
  const fp = building.footprint || {
    minX: -building.width / 2, maxX: building.width / 2,
    minZ: -building.depth / 2, maxZ: building.depth / 2,
  };
  const localX = (fp.minX + fp.maxX) / 2, localZ = (fp.minZ + fp.maxZ) / 2;
  const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
  return {
    kind: 'oriented-rectangle',
    center: {
      x: building.x + localX * c + localZ * s,
      z: building.z - localX * s + localZ * c,
    },
    halfExtents: {
      x: (fp.maxX - fp.minX) / 2 + 0.55,
      z: (fp.maxZ - fp.minZ) / 2 + 0.55,
    },
    yaw: building.yaw,
  };
}

test('final settlement plan owns deterministic catalog-backed safe managed vegetation', () => {
  const first = plan(), second = plan();
  assert.equal(JSON.stringify(first.managedVegetation), JSON.stringify(second.managedVegetation));
  assert.deepEqual(validateManagedVegetationPlan(first.managedVegetation), { valid: true, errors: [] });
  assert.equal(first.managedVegetation.catalogVersion, MANAGED_VEGETATION_CATALOG_VERSION);
  assert.ok(first.managedVegetation.placements.length > 0);
  assert.equal(first.managedVegetation.diagnostics.placed, first.managedVegetation.placements.length);
  assert.ok(first.planHash.endsWith(':frontage1:managedVegetation3'));
  for (const placement of first.managedVegetation.placements) {
    const asset = MANAGED_VEGETATION_ASSETS[placement.assetId];
    const presentation = first.managedVegetation.presentations.find((entry) => entry.id === placement.presentationId);
    const frontage = first.familyFrontages.find((entry) => entry.id === placement.familyFrontageId);
    assert.equal(presentation.descriptor, asset);
    assert.equal(frontage.householdId, placement.householdId);
    assert.equal(frontage.buildingId, placement.buildingId);
    assert.equal(placement.catalogVersion, MANAGED_VEGETATION_CATALOG_VERSION);
    assert.equal(placement.surfaceFit.reliefMeters, 0);
    assert.equal(placement.surfaceFit.slopeDegrees, 0);
    assert.ok(first.buildings.every((building) => !reservationShapesOverlap(placement.footprint, buildingShape(building))));
    assert.ok(placement.reservationDependencyIds.some((id) => id.endsWith(':authoritative-world-water')));
    assert.ok(placement.reservationDependencyIds.some((id) => id.includes(':managed-vegetation:approach')));
    assert.ok(placement.reservationDependencyIds.some((id) => id.includes(':managed-vegetation:frontage-reservation')));
  }
});

test('authoritative world water can veto every candidate without local hydrology fallback', () => {
  const dry = plan(), wet = plan(() => true);
  assert.ok(dry.managedVegetation.placements.length > 0);
  assert.equal(wet.managedVegetation.placements.length, 0);
  assert.equal(wet.managedVegetation.diagnostics.omitted, wet.managedVegetation.diagnostics.opportunities);
  assert.equal(wet.managedVegetation.diagnostics.authoritativeWaterSource, 'world');
});

test('apple trunks join collision while natural foliage leaves ambient cover unchanged', () => {
  const current = plan();
  const blocking = current.managedVegetation.placements.filter((placement) =>
    MANAGED_VEGETATION_ASSETS[placement.assetId].collision.blocksMovement);
  const authored = blocking.flatMap(collisionSegmentsForManagedVegetation);
  assert.ok(authored.length > 0);
  const index = new StructureCollisionIndex(() => ({ portals: {} }));
  const release = index.registerPlan(current);
  assert.ok(authored.every((segment) => index.records.get(current.id).staticSegments.some((entry) => entry.id === segment.id)));
  release();
  assert.equal(index.records.has(current.id), false);

  for (const placement of current.managedVegetation.placements) {
    assert.equal(placement.groundCover.mode, 'none');
    assert.equal(placement.groundCover.suppressesAmbientScatter, false);
    assert.notEqual(settlementGroundAtPlans([current], placement.x, placement.z)?.kind, 'managed-vegetation');
  }
});
