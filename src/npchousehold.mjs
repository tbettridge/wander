import { mulberry32 } from './noise.js';

// Keep this pool deliberately broad: household surnames are locally shared,
// so a larger deterministic given-name vocabulary avoids same-name collisions
// without changing the household/actor identity model.
const FIRST = [
  'Ada', 'Anwen', 'Bram', 'Cora', 'Dain', 'Elsi', 'Finn', 'Gwen', 'Hale', 'Iris', 'Jory', 'Kest', 'Lina',
  'Maren', 'Nell', 'Orin', 'Pella', 'Quill', 'Rhea', 'Sable', 'Tamsin', 'Una', 'Wren', 'Yarrow', 'Zell',
  'Albin', 'Briony', 'Cald', 'Della', 'Eamon', 'Faye', 'Garran', 'Hester', 'Idris', 'Jon', 'Kara', 'Lorne',
  'Maud', 'Nessa', 'Otho', 'Perrin', 'Rosamund', 'Silas', 'Tilda', 'Ursin', 'Vera', 'Willa', 'Ysabel', 'Zora',
];

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nameFor(rng, surname) {
  return `${FIRST[Math.floor(rng() * FIRST.length)]} ${surname}`;
}

function roomIds(home) {
  return (home.rooms || []).filter((room) => room.purpose === 'sleeping').map((room) => room.id);
}

function householdIdFor(plan, home, index) {
  return home.ownerHouseholdId || `${plan.site.id}:household:${index}`;
}

function surnameFor(home, existing) {
  return home.ownerSurname || existing?.surname || 'Unknown';
}

function generatedFormAndCount(home, residentsPerDwelling) {
  const rng = mulberry32(home.seed ^ 0x484f4d45);
  const formRoll = rng();
  const form = formRoll < 0.52 ? 'partners' : formRoll < 0.72 ? 'siblings' : formRoll < 0.88 ? 'lodger' : 'single';
  const count = form === 'single' ? 1 : residentsPerDwelling + (rng() < 0.25 ? 1 : 0);
  return { rng, form, count };
}

function relationshipTags(form) {
  return form === 'partners' ? ['family', 'partner']
    : form === 'siblings' ? ['family', 'sibling']
      : form === 'lodger' ? ['housemate'] : ['family'];
}

function ensureRelationships(state, household) {
  const tags = relationshipTags(household.form);
  for (const ownerId of household.memberIds) for (const subjectId of household.memberIds) if (ownerId !== subjectId) {
    const key = `${ownerId}->${subjectId}`;
    // Relationships are mutable simulation state. Only create a missing edge;
    // reconciliation must not reset affinity, trust, memories, or obligations.
    state.relationships[key] ||= {
      ownerId, subjectId, familiarity: 1, affinity: 0.65, trust: 0.72, obligation: 0.55, tags,
    };
  }
}

function regeneratedGivenName(entity, home, index) {
  const raw = String(entity?.name || '').trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts.slice(0, -1).join(' ');
  const rng = mulberry32((home.seed ^ hashText(entity?.id || `${home.id}:resident:${index}`) ^ 0x524543) >>> 0);
  return FIRST[Math.floor(rng() * FIRST.length)];
}

function reconcileMember(entity, household, home, index) {
  entity.id ||= household.memberIds[index];
  entity.kind ||= 'npc';
  entity.name = `${regeneratedGivenName(entity, home, index)} ${household.surname}`;
  // These are regenerated identity/address links, not mutable social state.
  entity.surname = household.surname;
  entity.homeKey = home.id;
  entity.householdId = household.id;
  entity.locationKey ||= home.rooms?.[0]?.id;
  entity.tombstone ??= false;
  return entity;
}

function createHousehold(plan, home, index, state, residentsPerDwelling) {
  const id = householdIdFor(plan, home, index);
  const { rng, form, count } = generatedFormAndCount(home, residentsPerDwelling);
  const surname = surnameFor(home);
  const memberIds = [];
  for (let memberIndex = 0; memberIndex < count; memberIndex++) {
    const actorId = `${id}:resident:${memberIndex}`;
    memberIds.push(actorId);
    const existing = state.entities[actorId] || {};
    state.entities[actorId] = {
      // A deterministic actor may have been created by cold travel before its
      // household record was activated. Preserve its canonical away location,
      // itinerary link, and any other mutable identity state.
      ...existing,
      id: actorId,
      kind: existing.kind || 'npc',
      name: existing.name || nameFor(rng, surname),
      surname,
      role: existing.role || (memberIndex === 0 ? 'householder' : 'resident'),
      homeKey: home.id,
      householdId: id,
      locationKey: existing.locationKey || home.rooms?.[0]?.id,
      tombstone: existing.tombstone ?? false,
    };
  }
  state.households[id] = {
    id, surname, form, homeBuildingId: home.id, memberIds,
    privateRoomIds: roomIds(home),
    access: { public: false, guests: 'invited', members: memberIds.slice() },
  };
  ensureRelationships(state, state.households[id]);
  return state.households[id];
}

/**
 * Reconcile the derived side of household identity against a regenerated
 * settlement plan. Household IDs and actor IDs remain authoritative; surnames
 * never match or merge households. Mutable household/relationship state is
 * retained unless a missing default must be created.
 */
export function reconcileHouseholds(plan, state, { residentsPerDwelling = 2 } = {}) {
  if (!plan?.site?.id || !state) throw new TypeError('A settlement plan and living-world state are required.');
  state.households ||= {};
  state.entities ||= {};
  state.relationships ||= {};
  const dwellings = plan.buildings.filter((building) => building.program === 'dwelling');
  const households = [];
  for (let index = 0; index < dwellings.length; index++) {
    const home = dwellings[index];
    const id = householdIdFor(plan, home, index);
    let household = state.households[id];
    if (!household) household = createHousehold(plan, home, index, state, residentsPerDwelling);

    const memberIds = Array.isArray(household.memberIds) && household.memberIds.length
      ? household.memberIds.slice() : [];
    if (!memberIds.length) {
      const generatedState = { ...state, households: {}, entities: {} };
      const generated = createHousehold(plan, home, index, generatedState, residentsPerDwelling);
      // Keep this branch deterministic while preserving the state object and
      // any existing mutable fields on a malformed/legacy empty household.
      household.memberIds = generated.memberIds.slice();
      Object.assign(state.entities, generatedState.entities);
    }
    household.id = id;
    household.surname = surnameFor(home, household);
    household.homeBuildingId = home.id;
    household.privateRoomIds = roomIds(home);
    household.access ||= { public: false, guests: 'invited', members: household.memberIds.slice() };
    if (!Array.isArray(household.access.members)) household.access.members = household.memberIds.slice();
    for (let memberIndex = 0; memberIndex < household.memberIds.length; memberIndex++) {
      const memberId = household.memberIds[memberIndex];
      const entity = state.entities[memberId] ||= { id: memberId, kind: 'npc' };
      reconcileMember(entity, household, home, memberIndex);
    }
    ensureRelationships(state, household);
    households.push(household);
  }
  return households;
}

/**
 * Resolve convenience identity fields from authoritative household/workplace
 * records. Compact entity tuples intentionally omit surname/workplaceName, so
 * activation code must use this resolver after parsing a save.
 */
export function deriveResidentIdentityContext(entity, state) {
  const householdId = entity?.householdId || null;
  const household = householdId ? state?.households?.[householdId] : null;
  const routine = Object.values(state?.routines || {}).find((item) => item.actorId === entity?.id) || null;
  const workplaceId = entity?.workplaceId || routine?.workplaceId || null;
  const workplace = workplaceId ? state?.workplaces?.[workplaceId] : null;
  return {
    householdId,
    surname: household?.surname || entity?.surname || null,
    homeBuildingId: household?.homeBuildingId || entity?.homeKey || null,
    workplaceId,
    workplaceName: workplace?.displayName || entity?.workplaceName || null,
  };
}

export function generateHouseholds(plan, state, options = {}) {
  return reconcileHouseholds(plan, state, options);
}

export function canEnterHouseholdRoom(state, actorId, roomId, { invitedBy = null } = {}) {
  const household = Object.values(state.households || {}).find((item) => item.privateRoomIds?.includes(roomId));
  if (!household) return true;
  return household.memberIds.includes(actorId) || !!(invitedBy && household.memberIds.includes(invitedBy));
}
