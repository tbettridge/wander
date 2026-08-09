// Pure WP0 fixtures: no Three objects, colors, meshes, or authored visual
// assets. Duplicate surnames are intentional; household IDs remain distinct.
export const duplicateSurnamePlan = Object.freeze({
  site: Object.freeze({ id: 'settlement:fixture', worldSeed: 20260612, x: 120, z: 900 }),
  buildings: Object.freeze([
    Object.freeze({
      id: 'settlement:fixture:building:0', program: 'dwelling', seed: 101,
      ownerHouseholdId: 'settlement:fixture:household:0', ownerSurname: 'Reed',
    }),
    Object.freeze({
      id: 'settlement:fixture:building:1', program: 'smithy', seed: 102,
      ownerHouseholdId: 'settlement:fixture:household:0', ownerSurname: 'Reed',
    }),
    Object.freeze({
      id: 'settlement:fixture:building:2', program: 'dwelling', seed: 201,
      ownerHouseholdId: 'settlement:fixture:household:1', ownerSurname: 'Reed',
    }),
    Object.freeze({
      id: 'settlement:fixture:building:3', program: 'workshop', seed: 202,
      ownerHouseholdId: 'settlement:fixture:household:1', ownerSurname: 'Reed',
    }),
    Object.freeze({ id: 'settlement:fixture:building:4', program: 'hall', seed: 301 }),
  ]),
});

export function legacyHouseholdFixture({ householdId, homeBuildingId, memberId, workplaceId }) {
  return {
    households: {
      [householdId]: {
        id: householdId,
        form: 'partners',
        surname: 'Oldname',
        homeBuildingId: 'legacy:home',
        memberIds: [memberId],
        privateRoomIds: ['legacy:room'],
        access: { public: true, guests: 'trusted', members: ['visitor:trusted'] },
      },
    },
    entities: {
      [memberId]: {
        id: memberId, kind: 'npc', name: 'Ada Oldname', surname: 'Oldname', role: 'householder',
        homeKey: 'legacy:home', householdId, locationKey: 'legacy:room', tombstone: false,
        workplaceId, workplaceName: 'Old Shop',
      },
    },
    workplaces: {
      [workplaceId]: {
        id: workplaceId, settlementId: 'legacy:settlement', kind: 'workshop', buildingId: 'legacy:building',
        ownerHouseholdId: 'legacy:owner', ownerSurname: 'Oldname', displayName: 'Old Shop',
        inventory: { repairs: 7, tools: 2 }, completedShifts: 4, serviceLevel: 2,
      },
    },
    routines: {
      [`routine:${memberId}:work`]: {
        id: `routine:${memberId}:work`, actorId: memberId, kind: 'work', priority: 35,
        homeKey: 'legacy:home', workplaceId, destinationKey: 'legacy:room',
        startHour: 8, endHour: 16, days: [0, 1, 2, 3, 4, 5],
        lastOccurrenceKey: 'legacy:day:4', state: 'working',
      },
    },
  };
}
