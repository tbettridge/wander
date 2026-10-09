import { applyLivingWorldEventOnce } from './livingworldstate.mjs';

const WORK_PROGRAMS = new Set(['barn', 'workshop', 'inn', 'hall', 'smithy', 'granary']);
const WORK_ROLES = Object.freeze({ barn: 'farmer', workshop: 'craftsperson', inn: 'innkeeper', hall: 'clerk', smithy: 'smith', granary: 'miller' });

export function assignWorkplacesAndRoutines(plan, state) {
  state.workplaces ||= {}; state.routines ||= {};
  const workplaces = plan.buildings.filter((b) => WORK_PROGRAMS.has(b.program));
  for (const building of workplaces) {
    const workplace = state.workplaces[building.id] ||= {
      id: building.id, settlementId: plan.site.id, kind: building.program, buildingId: building.id,
      inventory: building.program === 'inn' ? { meals: 8, beds: 4 } : building.program === 'workshop' ? { repairs: 0, tools: 4 } : {},
      serviceLevel: 1,
    };
    // Deterministic plan fields also upgrade an older persisted workplace.
    workplace.id = building.id;
    workplace.settlementId = plan.site.id;
    workplace.kind = building.program;
    workplace.buildingId = building.id;
    workplace.ownerHouseholdId = building.ownerHouseholdId;
    workplace.ownerSurname = building.ownerSurname;
    workplace.displayName = building.displayName;
    workplace.inventory ||= {};
    workplace.serviceLevel ??= 1;
  }
  const householdIds = new Set(plan.buildings
    .filter((building) => building.program === 'dwelling')
    .map((building, index) => building.ownerHouseholdId || `${plan.site.id}:household:${index}`));
  const actors = Object.values(state.entities || {}).filter((entity) => householdIds.has(entity.householdId));
  const assigned = new Set();
  for (const workplace of workplaces) {
    const actor = actors.find((candidate) => candidate.householdId === workplace.ownerHouseholdId && !assigned.has(candidate.id));
    if (!actor) continue;
    assigned.add(actor.id);
    actor.role = WORK_ROLES[workplace.program] || actor.role;
    actor.workplaceName = workplace.displayName;
    actor.workplaceId = workplace.id;
  }
  actors.forEach((actor, index) => {
    const owned = workplaces.find((workplace) => workplace.ownerHouseholdId === actor.householdId);
    const workplace = owned || workplaces[index % Math.max(1, workplaces.length)];
    if (!workplace) return;
    const id = `routine:${actor.id}:work`;
    const building = workplaces.find((entry) => entry.id === workplace.id);
    const routine = state.routines[id] ||= {
      id, actorId: actor.id, kind: 'work', priority: 35, homeKey: actor.homeKey,
      workplaceId: workplace.id, destinationKey: building?.rooms?.[0]?.id,
      startHour: 8 + (index % 3), endHour: 16 + (index % 2),
      days: [0, 1, 2, 3, 4, 5], lastOccurrenceKey: null, state: 'scheduled',
    };
    // These links are regenerated plan data. Keep mutable schedule/outcome
    // fields (state, lastOccurrenceKey, completed shifts and inventory) intact.
    //
    // Shift times are per person and fractional. Three shared start hours sent
    // a village's whole workforce down the same street in the same minute,
    // which is where the big walking crowds came from.
    const shift = shiftFor(actor.id, workplace.kind);
    routine.startHour = shift.start;
    routine.endHour = shift.end;
    routine.actorId = actor.id;
    routine.homeKey = actor.homeKey;
    routine.workplaceId = workplace.id;
    routine.destinationKey = building?.rooms?.[0]?.id;
    actor.workplaceId = workplace.id;
    actor.workplaceName = workplace.displayName;
  });
  return Object.values(state.routines).filter((routine) => routine.id.includes(plan.site.id));
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

// When each kind of work keeps its hours. An inn opens late and closes late; a
// smith and a farmer are at it early.
const SHIFT_BY_KIND = Object.freeze({
  inn: [10.5, 22.5], smithy: [7, 16.5], barn: [6, 15], granary: [7, 15.5],
  workshop: [8, 17], hall: [9, 16.5],
});

/** A person's own start and end: their trade's hours, give or take. */
export function shiftFor(actorId, kind) {
  const [start, end] = SHIFT_BY_KIND[kind] || [8, 17];
  const h = hashText(`${actorId}:shift`);
  const jitterStart = ((h & 0xff) / 255 - 0.5) * 1.6;
  const jitterEnd = (((h >>> 8) & 0xff) / 255 - 0.5) * 1.6;
  return { start: start + jitterStart, end: end + jitterEnd };
}

function occurrenceKey(routine, day) { return `${routine.id}:day:${day}`; }

export function advanceWorkRoutines(state, nowHour, { blockedActorIds = new Set() } = {}) {
  const day = Math.floor(nowHour / 24), hour = ((nowHour % 24) + 24) % 24;
  const outcomes = [];
  for (const routine of Object.values(state.routines || {})) {
    if (!routine.days.includes(day % 7) || blockedActorIds.has(routine.actorId)) continue;
    const actor = state.entities[routine.actorId]; if (!actor) continue;
    // A travel day suspends the home shift. There is no late-shift catch-up,
    // invented work outcome, or demand to rush home while this trip continues.
    const key = occurrenceKey(routine, day);
    if (actor.itineraryId || actor.inTransit) {
      routine.suspendedThroughDay = day;
      routine.lastOccurrenceKey = key;
      routine.state = 'travelling';
      continue;
    }
    if (routine.suspendedThroughDay >= day) { routine.state = 'home'; continue; }
    if (hour >= routine.startHour && hour < routine.endHour) {
      routine.state = 'working'; actor.locationKey = routine.destinationKey; actor.inTransit = false;
    } else if (hour >= routine.endHour && routine.lastOccurrenceKey !== key) {
      const event = { id: key, type: 'routine-outcome', actorId: routine.actorId, placeKey: routine.workplaceId, atHour: nowHour, payload: { routineId: routine.id } };
      const applied = applyLivingWorldEventOnce(state, event, (draft) => {
        const workplace = draft.workplaces[routine.workplaceId];
        workplace.completedShifts = (workplace.completedShifts || 0) + 1;
        if (workplace.kind === 'inn') workplace.inventory.meals = Math.min(12, (workplace.inventory.meals || 0) + 2);
        if (workplace.kind === 'workshop') workplace.inventory.repairs = (workplace.inventory.repairs || 0) + 1;
        draft.metrics.routineOutcomes = (draft.metrics.routineOutcomes || 0) + 1;
        return { workplaceId: workplace.id, kind: workplace.kind };
      });
      const liveRoutine = state.routines[routine.id];
      const liveActor = state.entities[routine.actorId];
      liveRoutine.lastOccurrenceKey = key; liveRoutine.state = 'home'; liveActor.locationKey = liveRoutine.homeKey; outcomes.push(applied);
    } else { routine.state = 'home'; actor.locationKey = routine.homeKey; }
  }
  return outcomes;
}
