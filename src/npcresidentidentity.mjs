// One visual/persona identity for a household resident in every presentation
// zone. A resident keeps the same face, proportions, palette and name at home,
// on station duty, and later while travelling; only their current activity role
// and carried prop may be projected by the owning renderer.

import { deriveResidentIdentityContext } from './npchousehold.mjs';
import { createNpcIdentity, householdAgeBand } from './npcpopulation.mjs';

export function createSettlementResidentIdentity({
  entity,
  state,
  worldSeed = state?.worldSeed ?? 1,
  homeBuildingId = null,
  householdIndex = null,
} = {}) {
  if (!entity?.id || entity.kind !== 'npc') {
    throw new TypeError('A canonical household NPC is required.');
  }
  const residentContext = deriveResidentIdentityContext(entity, state);
  const household = residentContext.householdId
    ? state?.households?.[residentContext.householdId] : null;
  const resolvedHome = homeBuildingId || residentContext.homeBuildingId;
  if (!resolvedHome) throw new TypeError(`NPC ${entity.id} has no canonical home building.`);
  const memberIndex = householdIndex == null
    ? Math.max(0, household?.memberIds?.indexOf(entity.id) ?? 0)
    : Number(householdIndex);
  if (!Number.isInteger(memberIndex) || memberIndex < 0) {
    throw new TypeError('householdIndex must be a non-negative integer.');
  }
  const base = createNpcIdentity({
    worldSeed,
    stationId: resolvedHome,
    stationName: resolvedHome,
    slot: {
      key: `household-resident-${memberIndex}`,
      role: entity.role || 'resident',
      family: 'storybook',
      activity: 'wait',
      accessory: memberIndex % 2 ? 'book' : 'basket',
    },
    // The household names this person and decides roughly how old they are.
    // Both used to be discarded: the body was drawn from a slot key alone, so
    // a Rosamund and a Bram in the same house were built from one distribution
    // and every household was all the same age.
    givenName: String(entity.name || '').trim().split(/\s+/)[0] || null,
    ageBand: householdAgeBand(household?.form, memberIndex,
      household?.memberIds?.length ?? 1, entity.id),
  });
  return Object.freeze({
    ...base,
    id: entity.id,
    name: entity.name,
    role: entity.role || base.role,
    surname: residentContext.surname,
    householdId: residentContext.householdId,
    homeBuildingId: residentContext.homeBuildingId,
    workplaceId: residentContext.workplaceId,
    workplaceName: residentContext.workplaceName,
  });
}
