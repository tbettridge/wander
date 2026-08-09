// A read-only, renderer-free view of the people a speaker can truthfully know
// as neighbours. Durable residence selects the community; current location is
// reported separately, so travel cannot look like migration (and migration
// immediately changes which directory is authoritative).

import { normalizeNpcLocation, normalizeNpcResidence } from './npclocation.mjs';

const COMPASS = Object.freeze([
  'north', 'north-east', 'east', 'south-east',
  'south', 'south-west', 'west', 'north-west',
]);
const NUMBER_WORDS = Object.freeze([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
]);

/**
 * Build a deterministic, JSON-safe directory for one canonical NPC.
 *
 * `settlementPlans` may be an array, Map, or id-keyed plain object. Each value
 * may be a plan or `{ plan }`. `speakerPosition` is the speaker's current world
 * `{ x, z }` position; `origin` is accepted as a convenient integration alias.
 * Malformed state links are omitted rather than repaired or guessed.
 */
export function buildNpcCommunityContext({
  state,
  speakerId,
  settlementPlans,
  speakerPosition = null,
  origin = null,
} = {}) {
  if (!plain(state) || !plain(state.entities) || !validId(speakerId)) {
    throw new TypeError('Canonical state and a speaker id are required.');
  }
  const speaker = state.entities[speakerId];
  const residence = canonicalResidentResidence(speaker, speakerId);
  if (!residence) throw new TypeError('Speaker is not a canonical resident NPC.');

  const plans = planCatalog(settlementPlans);
  const homePlan = plans.get(residence.residenceSettlementId);
  if (!homePlan) throw new RangeError(`Missing home settlement plan for ${speakerId}.`);
  const from = canonicalPoint(speakerPosition || origin)
    || pointForLocation(speaker.location, plans);
  if (!from) throw new TypeError('A finite speaker position is required.');

  const candidates = collectResidents(state, residence.residenceSettlementId, homePlan);
  const validIds = new Set(candidates.map((candidate) => candidate.entity.id));
  const residents = candidates.map(({ entity, household, memberResidence, home }) => {
    const routine = routineFor(state, entity.id);
    const workplace = workplaceFor(state, entity, routine, plans, from);
    return {
      id: entity.id,
      name: entity.name,
      role: entity.role,
      household: {
        id: household.id,
        surname: validText(household.surname) ? household.surname : null,
        form: validText(household.form) ? household.form : null,
      },
      family: {
        surname: validText(household.surname) ? household.surname : null,
        memberIds: household.memberIds.filter((id) => validIds.has(id)).slice().sort(compareText),
      },
      home: buildingFact(home, from, memberResidence.residenceSettlementId),
      workplace,
      status: statusFor(entity, memberResidence, routine, workplace),
    };
  }).sort((a, b) => compareText(a.id, b.id));

  const context = {
    speakerId,
    homeCommunity: {
      id: residence.residenceSettlementId,
      name: communityName(homePlan),
      residentCount: residents.length,
      residents,
    },
  };
  const currentSettlementId = settlementForLocation(speaker.location);
  if (currentSettlementId && currentSettlementId !== residence.residenceSettlementId) {
    const currentPlan = plans.get(currentSettlementId);
    context.currentCommunity = {
      id: currentSettlementId,
      name: currentPlan ? communityName(currentPlan) : null,
    };
  }
  return deepFreeze(context);
}

/** Alias kept short for dialogue integration call sites. */
export const communityContextForNpc = buildNpcCommunityContext;

function collectResidents(state, settlementId, plan) {
  const memberships = new Map();
  for (const household of Object.values(state.households || {})) {
    if (!plain(household) || !validId(household.id) || !Array.isArray(household.memberIds)) continue;
    for (const id of household.memberIds) {
      if (!validId(id)) continue;
      const list = memberships.get(id) || [];
      list.push(household);
      memberships.set(id, list);
    }
  }
  const buildings = new Map(plan.buildings.map((building) => [building.id, building]));
  const result = [];
  for (const [id, households] of memberships) {
    // Duplicate membership is ambiguous and therefore not canonical.
    if (households.length !== 1) continue;
    const household = households[0];
    const entity = state.entities[id];
    const memberResidence = canonicalResidentResidence(entity, id);
    if (!memberResidence || entity.householdId !== household.id
        || memberResidence.householdId !== household.id
        || memberResidence.residenceSettlementId !== settlementId
        || !validId(household.homeBuildingId)
        || memberResidence.homeBuildingId !== household.homeBuildingId) continue;
    const home = buildings.get(household.homeBuildingId);
    if (!canonicalBuilding(home)
        || (home.ownerHouseholdId != null && home.ownerHouseholdId !== household.id)) continue;
    result.push({ entity, household, memberResidence, home });
  }
  return result;
}

function canonicalResidentResidence(entity, id) {
  if (!plain(entity) || entity.id !== id || entity.kind !== 'npc' || entity.tombstone === true
      || !validText(entity.name) || !validText(entity.role)) return null;
  return normalizeNpcResidence(entity.residence);
}

function routineFor(state, actorId) {
  const routines = Object.values(state.routines || {}).filter((routine) => (
    plain(routine) && routine.actorId === actorId && validId(routine.id)
  )).sort((a, b) => compareText(a.id, b.id));
  return routines.length === 1 ? routines[0] : null;
}

function workplaceFor(state, entity, routine, plans, from) {
  const entityId = entity.workplaceId ?? null;
  const routineId = routine?.workplaceId ?? null;
  if (entityId && routineId && entityId !== routineId) return null;
  const id = entityId || routineId;
  if (!validId(id)) return null;
  const workplace = state.workplaces?.[id];
  if (!plain(workplace) || workplace.id !== id || !validId(workplace.settlementId)
      || !validId(workplace.buildingId)) return null;
  const plan = plans.get(workplace.settlementId);
  const building = plan?.buildings.find((candidate) => candidate.id === workplace.buildingId);
  if (!canonicalBuilding(building)) return null;
  return {
    id,
    settlementId: workplace.settlementId,
    name: validText(workplace.displayName)
      ? workplace.displayName : (validText(entity.workplaceName) ? entity.workplaceName : null),
    kind: validText(workplace.kind) ? workplace.kind : null,
    building: buildingFact(building, from, workplace.settlementId),
  };
}

function statusFor(entity, residence, routine, workplace) {
  const location = normalizeNpcLocation(entity.location);
  const base = {
    kind: 'unknown',
    locationKind: location?.kind ?? null,
    routineState: validText(routine?.state) ? routine.state : null,
  };
  if (!location) return base;
  if (location.kind === 'building') {
    if (location.settlementId === residence.residenceSettlementId
        && location.buildingId === residence.homeBuildingId) return { ...base, kind: 'at-home' };
    if (workplace && location.settlementId === workplace.settlementId
        && location.buildingId === workplace.building.id) {
      return { ...base, kind: routine?.state === 'working' ? 'working' : 'at-work' };
    }
    return {
      ...base,
      kind: location.settlementId === residence.residenceSettlementId ? 'in-community' : 'visiting',
    };
  }
  if (location.kind === 'settlement-node') {
    return { ...base, kind: location.settlementId === residence.residenceSettlementId ? 'in-community' : 'visiting' };
  }
  return { ...base, kind: 'travelling' };
}

function buildingFact(building, from, settlementId) {
  const eastM = roundedOffset(building.x - from.x);
  const northM = roundedOffset(building.z - from.z);
  const distanceM = Math.round(Math.hypot(building.x - from.x, building.z - from.z));
  return {
    id: building.id,
    settlementId,
    name: validText(building.displayName) ? building.displayName : null,
    program: validText(building.program) ? building.program : null,
    eastM,
    northM,
    distanceM,
    distancePhrase: describeDistance(distanceM),
    direction: compassDirection(eastM, northM),
  };
}

function compassDirection(eastM, northM) {
  if (eastM === 0 && northM === 0) return 'here';
  const degrees = (((Math.atan2(eastM, northM) * 180) / Math.PI) % 360 + 360) % 360;
  return COMPASS[Math.round(degrees / 45) % 8];
}

function describeDistance(metres) {
  const value = Math.max(0, Math.round(metres));
  if (value < 80) return 'just over there';
  if (value < 950) return `about ${numberWord(Math.max(1, Math.round(value / 100)))} hundred metres`;
  const kilometres = value / 1000;
  if (kilometres < 10) {
    const halves = Math.max(2, Math.round(kilometres * 2)) / 2;
    const whole = Math.floor(halves);
    const unit = halves === 1 ? 'kilometre' : 'kilometres';
    return halves - whole >= 0.5
      ? `about ${numberWord(whole)} and a half ${unit}`
      : `about ${numberWord(whole)} ${unit}`;
  }
  return `about ${Math.round(kilometres)} kilometres`;
}

function numberWord(value) {
  return NUMBER_WORDS[value] || String(value);
}

function roundedOffset(value) {
  const rounded = Math.round(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

function planCatalog(input) {
  const values = input instanceof Map ? [...input.values()]
    : Array.isArray(input) ? input
      : plain(input) ? Object.values(input) : [];
  const grouped = new Map();
  for (const value of values) {
    const plan = value?.plan || value;
    if (!plain(plan) || !plain(plan.site) || !validId(plan.site.id) || !Array.isArray(plan.buildings)
        || plan.buildings.some((building) => !canonicalBuilding(building))) continue;
    const matches = grouped.get(plan.site.id) || [];
    matches.push(plan);
    grouped.set(plan.site.id, matches);
  }
  // Conflicting duplicate plans are not resolved by input order.
  return new Map([...grouped].filter(([, matches]) => matches.length === 1)
    .map(([id, matches]) => [id, matches[0]]));
}

function pointForLocation(locationValue, plans) {
  const location = normalizeNpcLocation(locationValue);
  if (!location) return null;
  if (location.kind === 'building') {
    const building = plans.get(location.settlementId)?.buildings
      .find((candidate) => candidate.id === location.buildingId);
    return canonicalPoint(building);
  }
  if (location.kind === 'settlement-node') {
    const node = plans.get(location.settlementId)?.localGraph?.nodes
      ?.find((candidate) => candidate.id === location.nodeId);
    return canonicalPoint(node);
  }
  return null;
}

function settlementForLocation(value) {
  const location = normalizeNpcLocation(value);
  return location && (location.kind === 'building' || location.kind === 'settlement-node')
    ? location.settlementId : null;
}

function communityName(plan) {
  return validText(plan.place?.name) ? plan.place.name
    : validText(plan.site.name) ? plan.site.name
      : validText(plan.site.displayName) ? plan.site.displayName : plan.site.id;
}

function canonicalBuilding(value) {
  return plain(value) && validId(value.id) && Number.isFinite(value.x) && Number.isFinite(value.z);
}

function canonicalPoint(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.z)
    ? { x: value.x, z: value.z } : null;
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function validText(value) {
  return validId(value);
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
