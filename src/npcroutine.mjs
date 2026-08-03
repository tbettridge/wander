import { applyLivingWorldEventOnce } from './livingworldstate.mjs';

const WORK_PROGRAMS = new Set(['barn', 'workshop', 'inn', 'hall']);

export function assignWorkplacesAndRoutines(plan, state) {
  state.workplaces ||= {}; state.routines ||= {};
  const workplaces = plan.buildings.filter((b) => WORK_PROGRAMS.has(b.program));
  for (const building of workplaces) state.workplaces[building.id] ||= {
    id: building.id, settlementId: plan.site.id, kind: building.program, buildingId: building.id,
    inventory: building.program === 'inn' ? { meals: 8, beds: 4 } : building.program === 'workshop' ? { repairs: 0, tools: 4 } : {},
    serviceLevel: 1,
  };
  const actors = Object.values(state.entities || {}).filter((entity) => entity.householdId?.startsWith(plan.site.id));
  actors.forEach((actor, index) => {
    const workplace = workplaces[index % Math.max(1, workplaces.length)];
    if (!workplace) return;
    const id = `routine:${actor.id}:work`;
    state.routines[id] ||= { id, actorId: actor.id, kind: 'work', priority: 35, homeKey: actor.homeKey, workplaceId: workplace.id, destinationKey: workplace.rooms[0].id, startHour: 8 + (index % 3), endHour: 16 + (index % 2), days: [0, 1, 2, 3, 4, 5], lastOccurrenceKey: null, state: 'scheduled' };
    actor.workplaceId = workplace.id;
  });
  return Object.values(state.routines).filter((routine) => routine.id.includes(plan.site.id));
}

function occurrenceKey(routine, day) { return `${routine.id}:day:${day}`; }

export function advanceWorkRoutines(state, nowHour, { blockedActorIds = new Set() } = {}) {
  const day = Math.floor(nowHour / 24), hour = ((nowHour % 24) + 24) % 24;
  const outcomes = [];
  for (const routine of Object.values(state.routines || {})) {
    if (!routine.days.includes(day % 7) || blockedActorIds.has(routine.actorId)) continue;
    const actor = state.entities[routine.actorId]; if (!actor) continue;
    const key = occurrenceKey(routine, day);
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
