import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILY_FRONTAGE_ASSET_METADATA_SCHEMA,
  FAMILY_FRONTAGE_CHANNELS,
  FAMILY_FRONTAGE_PLACEHOLDER_IDS,
  FAMILY_FRONTAGE_VERSION,
  FAMILY_OWNED_PROGRAMS,
  buildingFamilyFrontageId,
  createBuildingFamilyFrontage,
  createFamilyFrontageProfile,
  familyFrontageProfileId,
  validateFamilyFrontagePlan,
} from '../src/familyfrontage.mjs';
import { duplicateSurnamePlan } from './fixtures/familyfrontage.mjs';

function contractFixture() {
  const homes = duplicateSurnamePlan.buildings.filter((building) => building.program === 'dwelling');
  const profiles = homes.map((home) => {
    const ownedBuildingIds = duplicateSurnamePlan.buildings
      .filter((building) => building.ownerHouseholdId === home.ownerHouseholdId)
      .map((building) => building.id);
    return createFamilyFrontageProfile({
      householdId: home.ownerHouseholdId,
      surname: home.ownerSurname,
      homeBuildingId: home.id,
      ownedBuildingIds,
      seed: home.seed,
    });
  });
  const frontages = duplicateSurnamePlan.buildings
    .filter((building) => building.ownerHouseholdId)
    .map((building) => createBuildingFamilyFrontage({
      buildingId: building.id,
      householdId: building.ownerHouseholdId,
      profileId: familyFrontageProfileId(building.ownerHouseholdId),
      program: building.program,
    }));
  return { familyFrontageProfiles: profiles, familyFrontages: frontages };
}

test('WP0 freezes the pure frontage contract with semantic placeholders only', () => {
  const plan = contractFixture();
  const result = validateFamilyFrontagePlan(plan);
  assert.equal(result.valid, true, result.errors.join(', '));
  assert.equal(FAMILY_FRONTAGE_VERSION, 1);
  assert.ok(FAMILY_OWNED_PROGRAMS.includes('dwelling'));
  assert.ok(!FAMILY_OWNED_PROGRAMS.includes('hall'));
  assert.ok(Object.isFrozen(FAMILY_FRONTAGE_CHANNELS));
  assert.ok(Object.isFrozen(FAMILY_FRONTAGE_ASSET_METADATA_SCHEMA.fields));
  for (const id of Object.values(FAMILY_FRONTAGE_PLACEHOLDER_IDS)) assert.match(id, /^placeholder:/);
  assert.ok(plan.familyFrontages.every((frontage) => frontage.attachments.length === 0));
  assert.ok(plan.familyFrontages.every((frontage) => frontage.yardElements.length === 0));
  assert.equal(plan.familyFrontages.some((frontage) => frontage.program === 'hall'), false);
});

test('same surname does not merge household-keyed profile IDs', () => {
  const profiles = contractFixture().familyFrontageProfiles;
  assert.equal(profiles[0].surname, profiles[1].surname);
  assert.notEqual(profiles[0].householdId, profiles[1].householdId);
  assert.notEqual(profiles[0].id, profiles[1].id);
  assert.equal(profiles[0].id, familyFrontageProfileId(profiles[0].householdId));
  assert.match(buildingFamilyFrontageId(profiles[0].homeBuildingId), /:family-frontage:v1$/);
});

// These are intentionally pending pure tests for Sol/WP2. They keep the
// deterministic selection/placement contract visible without implementing it
// or inventing a visual catalog in WP0.
test.todo('future planner is byte-stable and channel-independent (WP2 implements named-channel planner)');
test.todo('future planner omits unsafe yard elements and returns only catalog IDs (WP2 implements safe placement)');
