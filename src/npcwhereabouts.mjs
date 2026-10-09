// A speaker's daily knowledge is fallible and directional. Store the decision
// rather than rolling on each question or letting a new relationship reroll it.
export const NPC_WHEREABOUTS_CHANCE = Object.freeze({ connected: 0.8, unconnected: 0.3 });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const finitePoint = value => Number.isFinite(value?.x) && Number.isFinite(value?.z);
const dayAt = state => Math.floor(Math.max(0, Number(state?.clock?.worldHours) || 0) / 24);

export function npcPeopleConnected(state, speakerId, subjectId) {
  const a = state.entities?.[speakerId], b = state.entities?.[subjectId];
  if (!a || !b) return false;
  if (a.householdId && a.householdId === b.householdId) return true;
  if (a.workplaceId && a.workplaceId === b.workplaceId) return true;
  return [`${speakerId}->${subjectId}`, `${subjectId}->${speakerId}`].some(key => {
    const edge = state.relationships?.[key];
    return edge && (edge.familiarity > 0 || (edge.tags || []).length > 0);
  });
}

function dailyRoll(seed, day, speakerId, subjectId) {
  let hash = 2166136261;
  for (const c of `${seed}:whereabouts:${day}:${speakerId}:${subjectId}`) {
    hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

export function dailyNpcWhereaboutsDecision(state, speakerId, subjectId) {
  const day = dayAt(state);
  if (state.npcWhereabouts?.day !== day || !plain(state.npcWhereabouts?.decisions)) {
    state.npcWhereabouts = { day, decisions: {} };
  }
  const key = JSON.stringify([speakerId, subjectId]);
  const previous = state.npcWhereabouts.decisions[key];
  if (typeof previous?.known === 'boolean' && typeof previous.connected === 'boolean') return previous;
  const connected = npcPeopleConnected(state, speakerId, subjectId);
  const chance = connected ? NPC_WHEREABOUTS_CHANCE.connected : NPC_WHEREABOUTS_CHANCE.unconnected;
  const decision = { connected, known: dailyRoll(state.worldSeed || 1, day, speakerId, subjectId) < chance };
  state.npcWhereabouts.decisions[key] = decision;
  state.revision = (Number(state.revision) || 0) + 1;
  return decision;
}

function plansFor(input) {
  const values = input instanceof Map ? [...input.values()] : Array.isArray(input) ? input : Object.values(input || {});
  return new Map(values.map(value => value?.plan || value).filter(value => value?.site?.id)
    .map(plan => [plan.site.id, plan]));
}
const buildingAt = (plans, settlementId, buildingId) => plans.get(settlementId)?.buildings?.find(b => b.id === buildingId);

function expectedPlace(state, entity, plans) {
  const location = entity.location;
  // A place reported by the canonical routine/visit is an uncertain lead, not
  // a tracking beam attached to a moving avatar. Never guess a home shift for
  // someone who is away on a regional trip.
  if (location?.kind === 'building') {
    const building = buildingAt(plans, location.settlementId, location.buildingId);
    if (finitePoint(building)) return { building, settlementId: location.settlementId,
      kind: location.buildingId === entity.residence?.homeBuildingId ? 'home'
        : location.buildingId === entity.workplaceId ? 'work' : 'visit' };
  }
  if (entity.itineraryId || entity.inTransit || ['train-seat', 'train-carriage', 'regional-edge', 'regional-node'].includes(location?.kind)) return null;
  const routine = Object.values(state.routines || {}).find(value => value.actorId === entity.id && value.kind === 'work');
  const hour = (Number(state.clock?.worldHours) || 0) % 24, day = dayAt(state);
  const onShift = routine && (routine.days || [0, 1, 2, 3, 4, 5, 6]).includes(day % 7)
    && hour >= routine.startHour && hour < routine.endHour && !(routine.suspendedThroughDay >= day);
  if (onShift) {
    const work = state.workplaces?.[routine.workplaceId];
    const building = buildingAt(plans, work?.settlementId, work?.buildingId);
    if (finitePoint(building)) return { building, settlementId: work.settlementId, kind: 'work' };
  }
  const home = entity.residence;
  const building = buildingAt(plans, home?.residenceSettlementId, home?.homeBuildingId);
  return finitePoint(building) ? { building, settlementId: home.residenceSettlementId, kind: 'home' } : null;
}

/** Enrich the read-only community directory; only daily decisions mutate state. */
export function npcWhereaboutsContext({ state, community, speakerId, settlementPlans, origin }) {
  const plans = plansFor(settlementPlans), candidates = new Map();
  for (const resident of community.homeCommunity?.residents || []) candidates.set(resident.id, resident);
  for (const edge of Object.values(state.relationships || {})) {
    const id = edge.ownerId === speakerId ? edge.subjectId : edge.subjectId === speakerId ? edge.ownerId : null;
    const entity = state.entities?.[id];
    if (entity?.kind === 'npc' && !entity.tombstone && npcPeopleConnected(state, speakerId, id)) {
      candidates.set(id, candidates.get(id) || { id, name: entity.name, role: entity.role });
    }
  }
  const personWhereabouts = [];
  for (const resident of [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (resident.id === speakerId) continue;
    const entity = state.entities?.[resident.id];
    if (!entity || entity.tombstone || !entity.name) continue;
    const decision = dailyNpcWhereaboutsDecision(state, speakerId, entity.id);
    const expected = expectedPlace(state, entity, plans);
    if (decision.known && (!expected || !finitePoint(origin))) {
      decision.known = false; state.revision = (Number(state.revision) || 0) + 1;
    }
    const entry = { subjectId: entity.id, name: entity.name, day: dayAt(state), known: decision.known };
    if (decision.known) {
      const { building, settlementId, kind } = expected;
      const label = building.displayName || `the ${building.program === 'dwelling' ? 'house' : building.program || 'building'}`;
      entry.place = { id: `person-location:${entity.id}`, name: label, kind, settlementId,
        worldX: building.x, worldZ: building.z, distanceM: Math.round(Math.hypot(building.x - origin.x, building.z - origin.z)) };
      entry.line = kind === 'work' ? `${entity.name} should be at ${label} right now, where they work. Over there—you should check there.`
        : kind === 'home' ? `${entity.name} should be at home right now, at ${label}. Over there—you should check there.`
          : `I think ${entity.name} might be at ${label} today. You should check there.`;
    } else entry.line = `I'm not sure where ${entity.name} is today.`;
    personWhereabouts.push(entry);
  }
  const byId = new Map(personWhereabouts.map(entry => [entry.subjectId, entry]));
  // Exact live status must not leak through the ordinary directory and defeat
  // a failed daily roll. Home addresses and occupations remain durable facts.
  const residents = (community.homeCommunity?.residents || []).map(resident => resident.id === speakerId ? resident : {
    ...resident, status: { kind: 'unknown' }, whereabouts: { known: byId.get(resident.id)?.known === true, day: dayAt(state) },
  });
  return { ...community, homeCommunity: community.homeCommunity ? { ...community.homeCommunity, residents } : null, personWhereabouts };
}

function mentions(text, name) {
  const bare = String(name || '').toLowerCase().trim();
  if (!bare) return false;
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(text);
}

export function mentionedNpcWhereabouts(context, text) {
  const haystack = String(text || '').toLowerCase();
  const entries = context?.personWhereabouts || [];
  const full = entries.filter(entry => mentions(haystack, entry.name));
  if (full.length) return full;
  return entries.filter(entry => mentions(haystack, entry.name.split(/\s+/)[0]));
}

export function npcWhereaboutsReply(context, text, { response = false } = {}) {
  const haystack = String(text || '').toLowerCase();
  const locating = /\b(?:where|find|look for|looking|ask|over|there|at|by|near|should|might|today|now)\b/.test(haystack);
  // A home address or permanent occupation is different from today's lead.
  if (!locating) return null;
  if (/\b(?:live|lives|house|address|work|works|workplace)\b|['’]s\s+home\b/.test(haystack)
    && !/\b(?:now|today|currently|find|looking|look for|should|might)\b/.test(haystack)) return null;
  if (response && /\b(?:yesterday|last week|used to|remember|years ago)\b/.test(haystack)
    && !/\b(?:now|today|currently)\b/.test(haystack)) return null;
  if (!response && !/\b(?:where|find|look for|looking|ask|speak|talk|meet|see)\b/.test(haystack)) return null;
  const matches = mentionedNpcWhereabouts(context, text);
  if (!matches.length) return null;
  if (matches.length > 1) return { text: `Do you mean ${matches.map(entry => entry.name).join(' or ')}?` };
  const entry = matches[0];
  return { text: `${entry.known && entry.place ? '<gesture:point> ' : ''}${entry.line}`,
    ...(entry.known && entry.place ? { targetId: entry.place.id } : {}), personId: entry.subjectId };
}

export function npcPersonPoint(context, text) {
  if (/\b(?:live|lives|house|address|works|workplace)\b|['’]s\s+home\b/i.test(String(text || ''))
    && !/\b(?:now|today|currently|find|should|might)\b/i.test(String(text || ''))) return null;
  if (!/\b(?:where|find|ask|over|there|at|by|near|should|might|today|now)\b/i.test(String(text || ''))) return null;
  const matches = mentionedNpcWhereabouts(context, text);
  if (!matches.length) return null;
  const entry = matches.length === 1 ? matches[0] : null;
  return { mentioned: true, place: entry?.known ? entry.place : null };
}

export function npcPersonPointPlaces(context) {
  return (context?.personWhereabouts || []).filter(entry => entry.known && entry.place).map(entry => ({
    ...entry.place, personId: entry.subjectId, aliases: [entry.name],
  }));
}
