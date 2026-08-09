import test from 'node:test';
import assert from 'node:assert/strict';
import { settlementForCell } from '../src/settlementplacement.mjs';
import { cachedSettlementPlan, clearSettlementSpatialCache } from '../src/settlementspatial.mjs';
import { createSettlementPlan } from '../src/settlementplan.mjs';
import { validateFamilyFrontagePlan, familyFrontageProfileId } from '../src/familyfrontage.mjs';
import {
  FAMILY_FRONTAGE_SOURCE_CONTRACT_VALIDATION,
  FRONTAGE_PLANNER_CONTRACT,
  planFamilyFrontages,
} from '../src/familyfrontageplanner.mjs';
import { frontageAssetMetadata } from '../src/settlementfrontagecatalog.mjs';
import { collisionSegmentsForFamilyFrontage, StructureCollisionIndex } from '../src/structurecollision.mjs';
import { normalizeLivingWorldState } from '../src/livingworldstate.mjs';

const world = {
  seed: 77,
  height(x, z) { return 18 + Math.sin(x * 0.0003) + Math.cos(z * 0.0002); },
  biomeAt(x, z) { return { h: this.height(x, z), slope: 0.04, m: 0.58, id: 'grassland' }; },
  riverAt() { return { wet: false }; },
};

function firstSite() {
  for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
    const site = settlementForCell(world, i, j, world.seed);
    if (site) return site;
  }
  throw new Error('test corpus produced no settlement');
}

function plan() {
  return createSettlementPlan(firstSite(), { heightAt: world.height.bind(world) });
}

function distanceToSegment(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
}

test('family frontage planning is deterministic, owner-keyed, and source-compatible', () => {
  const a = plan(), b = plan();
  assert.deepEqual(JSON.stringify({ profiles: a.familyFrontageProfiles, frontages: a.familyFrontages }),
    JSON.stringify({ profiles: b.familyFrontageProfiles, frontages: b.familyFrontages }));
  assert.deepEqual(validateFamilyFrontagePlan(a).valid, true);
  assert.deepEqual(FAMILY_FRONTAGE_SOURCE_CONTRACT_VALIDATION, { valid: true, errors: [] });
  assert.equal(a.familyFrontages.every((frontage) => frontage.householdId === a.buildings
    .find((building) => building.id === frontage.buildingId).ownerHouseholdId), true);
  assert.equal(a.familyFrontageProfiles.every((profile) => profile.id === familyFrontageProfileId(profile.householdId)), true);
  assert.equal(FRONTAGE_PLANNER_CONTRACT.unavailableChannels.length, 0);
  assert.deepEqual(a.familyFrontageDiagnostics.unsupportedChannels, []);
  for (const frontage of a.familyFrontages) {
    for (const id of [
      frontage.application.facadeTreatmentId,
      frontage.application.trimTargetId,
      frontage.application.doorTreatmentId,
      frontage.application.elementVariantId,
    ]) assert.doesNotMatch(id, /^placeholder:/);
    const siblings = a.familyFrontages.filter((entry) => entry.householdId === frontage.householdId);
    assert.ok(siblings.every((entry) => entry.application.facadeTreatmentId === frontage.application.facadeTreatmentId));
    assert.ok(siblings.every((entry) => entry.application.trimTargetId === frontage.application.trimTargetId));
    assert.ok(siblings.every((entry) => entry.application.doorTreatmentId === frontage.application.doorTreatmentId));
    assert.ok(siblings.every((entry) => entry.application.elementVariantId === frontage.application.elementVariantId));
  }
});

test('nearby families vary independent channels without civic frontage', () => {
  const current = plan();
  const homes = current.buildings.filter((building) => building.program === 'dwelling' && building.ownerHouseholdId);
  for (const building of current.buildings) {
    const frontage = current.familyFrontages.find((entry) => entry.buildingId === building.id);
    if (!building.ownerHouseholdId) assert.equal(frontage, undefined, `${building.program} received family frontage`);
  }
  for (let i = 0; i < homes.length; i++) for (let j = i + 1; j < homes.length; j++) {
    if (Math.hypot(homes[i].x - homes[j].x, homes[i].z - homes[j].z) > 42) continue;
    const first = current.familyFrontageProfiles.find((profile) => profile.homeBuildingId === homes[i].id);
    const second = current.familyFrontageProfiles.find((profile) => profile.homeBuildingId === homes[j].id);
    assert.notEqual(first.markId, second.markId, 'nearby marks repeated');
    assert.notEqual(first.paletteId, second.paletteId, 'nearby palettes repeated');
  }
});

test('placed assets stay clear of foundations, circulation, square, and blocked terrain', () => {
  const current = plan();
  for (const frontage of current.familyFrontages) {
    const building = current.buildings.find((entry) => entry.id === frontage.buildingId);
    const fp = building.footprint;
    for (const entry of frontage.yardElements) {
      const { x, z } = entry.placement;
      const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
      const localX = (x - building.x) * c - (z - building.z) * s;
      const localZ = (x - building.x) * s + (z - building.z) * c;
      assert.ok(localX < fp.minX - 0.45 || localX > fp.maxX + 0.45
        || localZ < fp.minZ - 0.45 || localZ > fp.maxZ + 0.45,
      `${entry.assetId} overlaps its foundation`);
      assert.ok(!current.square || Math.hypot(x - current.square.x, z - current.square.z) > current.square.radius,
        `${entry.assetId} entered the civic square`);
      for (const path of current.paths) for (let index = 1; index < path.points.length; index++) {
        const distance = distanceToSegment(x, z, path.points[index - 1], path.points[index]);
        const metadata = frontageAssetMetadata(entry.assetId);
        assert.ok(distance >= path.width / 2 + metadata.placementHints.pathGap - 0.001,
          `${entry.assetId} narrowed ${path.id}`);
      }
    }
  }
  const blocked = planFamilyFrontages(current, { heightAt: world.height.bind(world), blockedAt: () => true });
  assert.equal(blocked.familyFrontages.every((frontage) => frontage.yardElements.length === 0), true);
  assert.ok(blocked.familyFrontages.some((frontage) => frontage.omittedReasons.some((reason) => reason.includes('unsafe-placement'))));
});

test('frontage collision records are authored-only and unloadable', () => {
  const current = plan();
  const frontages = new Map(current.familyFrontages.map((frontage) => [frontage.buildingId, frontage]));
  const authored = current.buildings.flatMap((building) => collisionSegmentsForFamilyFrontage(building, frontages.get(building.id)));
  assert.equal(authored.length > 0, current.familyFrontageDiagnostics.collisionAssets > 0);
  assert.equal(authored.every((segment) => segment.portalId === null), true);
  const index = new StructureCollisionIndex(() => ({ portals: {} }));
  const release = index.registerPlan(current);
  assert.ok(index.records.get(current.id).staticSegments.some((segment) => authored.some((entry) => entry.id === segment.id)));
  release();
  assert.equal(index.records.has(current.id), false);
});

test('spatial cache includes the frontage plan seam and feature normalization gates it', () => {
  clearSettlementSpatialCache();
  const site = firstSite();
  const first = cachedSettlementPlan(world, site), second = cachedSettlementPlan(world, site);
  assert.equal(first, second);
  assert.match(first.planHash, /spatial6:frontage1:managedVegetation3$/);
  const state = normalizeLivingWorldState({ features: { familyFrontageEnabled: false } });
  assert.equal(state.features.familyFrontageEnabled, false);
  assert.equal(state.features.managedVegetationEnabled, true);
  assert.equal(normalizeLivingWorldState({ features: { settlementsEnabled: false } }).features.familyFrontageEnabled, false);
  assert.equal(normalizeLivingWorldState({ features: { settlementsEnabled: false } }).features.managedVegetationEnabled, false);
});
