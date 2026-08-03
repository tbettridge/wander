export const ACTION_ANCHOR_KINDS = Object.freeze(['shelter', 'stream', 'map-point', 'repair-site', 'trail-marker', 'platform']);

export function registerActionAnchor(state, anchor) {
  if (!anchor?.id || !ACTION_ANCHOR_KINDS.includes(anchor.kind)) throw new TypeError('Action anchor needs stable id and kind.');
  const value = { id: String(anchor.id), kind: anchor.kind, x: Number(anchor.x) || 0, z: Number(anchor.z) || 0,
    locationKey: anchor.locationKey || null, capacity: Math.max(1, Number(anchor.capacity) || 1), enabled: anchor.enabled !== false };
  state.actionAnchors[value.id] = value;
  state.revision++;
  return value;
}

export function nearestActionAnchor(state, kind, position, { maxDistance = Infinity } = {}) {
  let best = null;
  for (const anchor of Object.values(state?.actionAnchors || {})) {
    if (!anchor.enabled || anchor.kind !== kind) continue;
    const distance = Math.hypot(anchor.x - position.x, anchor.z - position.z);
    if (distance <= maxDistance && (!best || distance < best.distance)) best = { anchor, distance };
  }
  return best;
}

export function actionAnchorSignature(state) {
  return Object.values(state?.actionAnchors || {}).sort((a, b) => a.id.localeCompare(b.id))
    .map((anchor) => `${anchor.id}|${anchor.kind}|${anchor.x.toFixed(2)}|${anchor.z.toFixed(2)}|${anchor.capacity}|${anchor.enabled ? 1 : 0}`)
    .join('\n');
}
