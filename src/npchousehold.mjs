import { mulberry32 } from './noise.js';

const FIRST = ['Ada', 'Bram', 'Cora', 'Dain', 'Elsi', 'Finn', 'Gwen', 'Hale', 'Iris', 'Jory', 'Kest', 'Lina'];
const LAST = ['Ash', 'Bell', 'Cobb', 'Dale', 'Elder', 'Fenn', 'Grove', 'Hearth'];

function nameFor(rng) { return `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`; }

export function generateHouseholds(plan, state, { residentsPerDwelling = 2 } = {}) {
  state.households ||= {}; state.entities ||= {}; state.relationships ||= {};
  const dwellings = plan.buildings.filter((building) => building.program === 'dwelling');
  for (let index = 0; index < dwellings.length; index++) {
    const home = dwellings[index], id = `${plan.site.id}:household:${index}`;
    if (state.households[id]) continue;
    const rng = mulberry32(home.seed ^ 0x484f4d45);
    const formRoll = rng();
    const form = formRoll < 0.52 ? 'partners' : formRoll < 0.72 ? 'siblings' : formRoll < 0.88 ? 'lodger' : 'single';
    const count = form === 'single' ? 1 : residentsPerDwelling + (rng() < 0.25 ? 1 : 0);
    const memberIds = [];
    for (let i = 0; i < count; i++) {
      const actorId = `${id}:resident:${i}`; memberIds.push(actorId);
      state.entities[actorId] = { id: actorId, kind: 'npc', name: nameFor(rng), role: i === 0 ? 'householder' : 'resident', homeKey: home.id, householdId: id, locationKey: home.rooms[0].id, tombstone: false };
    }
    state.households[id] = { id, form, homeBuildingId: home.id, memberIds, privateRoomIds: home.rooms.filter((r) => r.purpose === 'sleeping').map((r) => r.id), access: { public: false, guests: 'invited', members: memberIds } };
    for (const ownerId of memberIds) for (const subjectId of memberIds) if (ownerId !== subjectId) {
      const tags = form === 'partners' ? ['family', 'partner'] : form === 'siblings' ? ['family', 'sibling'] : form === 'lodger' ? ['housemate'] : ['family'];
      state.relationships[`${ownerId}->${subjectId}`] = { ownerId, subjectId, familiarity: 1, affinity: 0.65, trust: 0.72, obligation: 0.55, tags };
    }
  }
  return dwellings.map((_, index) => state.households[`${plan.site.id}:household:${index}`]);
}

export function canEnterHouseholdRoom(state, actorId, roomId, { invitedBy = null } = {}) {
  const household = Object.values(state.households || {}).find((item) => item.privateRoomIds?.includes(roomId));
  if (!household) return true;
  return household.memberIds.includes(actorId) || !!(invitedBy && household.memberIds.includes(invitedBy));
}
