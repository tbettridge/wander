export const ACTIVITY_PRIORITY = Object.freeze({
  ambient: 10,
  situated: 30,
  commitment: 40,
  offer: 50,
  group: 60,
  dialogue: 80,
  safety: 100,
});

export function createActivityArbiter() {
  return { claims: {}, revision: 0 };
}

export function claimActivity(arbiter, actorId, activity, { priority, nowHour = 0 } = {}) {
  if (!actorId || !activity) throw new TypeError('Activity claims require actorId and activity.');
  const rank = Number.isFinite(priority) ? priority : ACTIVITY_PRIORITY[activity] ?? 0;
  const current = arbiter.claims[actorId];
  if (current && current.priority > rank) return { accepted: false, current };
  const claim = { actorId, activity, priority: rank, sinceHour: nowHour };
  arbiter.claims[actorId] = claim;
  arbiter.revision++;
  return { accepted: true, interrupted: current || null, current: claim };
}

export function releaseActivity(arbiter, actorId, activity = null) {
  const current = arbiter.claims[actorId];
  if (!current || (activity && current.activity !== activity)) return false;
  delete arbiter.claims[actorId];
  arbiter.revision++;
  return true;
}

export function activityFor(arbiter, actorId) {
  return arbiter?.claims?.[actorId] || null;
}
