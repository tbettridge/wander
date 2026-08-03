const OPEN_SECONDS = 0.45;

export function ensurePortalState(state, portal, { locked = false } = {}) {
  state.portals ||= {};
  return state.portals[portal.id] ||= {
    id: portal.id, open: false, locked: !!locked, progress: 0, target: 0,
    lastActorId: null, crossings: 0,
  };
}

export function requestPortal(state, portal, actorId, { canUnlock = false } = {}) {
  const record = ensurePortalState(state, portal);
  if (record.locked && !canUnlock) return { accepted: false, reason: 'locked', portal: record };
  if (record.locked) record.locked = false;
  record.target = 1; record.lastActorId = actorId || null; state.revision = (state.revision || 0) + 1;
  return { accepted: true, portal: record };
}

export function closePortal(state, portalId) {
  const record = state.portals?.[portalId];
  if (!record) return false;
  record.target = 0; state.revision = (state.revision || 0) + 1; return true;
}

export function advancePortals(state, dt) {
  for (const record of Object.values(state.portals || {})) {
    const delta = Math.max(0, dt) / OPEN_SECONDS;
    record.progress += Math.sign(record.target - record.progress) * Math.min(Math.abs(record.target - record.progress), delta);
    record.open = record.progress >= 0.98;
  }
}

export function crossPortal(state, portalId, actorId, fromKey, toKey) {
  const record = state.portals?.[portalId];
  if (!record?.open || record.locked) return { crossed: false, reason: record?.locked ? 'locked' : 'closed' };
  record.crossings++; record.lastActorId = actorId;
  state.occupancy ||= {}; state.occupancy[actorId] = { actorId, locationKey: toKey, previousLocationKey: fromKey, portalId };
  state.metrics ||= {}; state.metrics.portalsCrossed = (state.metrics.portalsCrossed || 0) + 1;
  state.revision = (state.revision || 0) + 1;
  return { crossed: true, locationKey: toKey };
}
