// World bearings share the rig convention: +Z north, +X east. Distance is
// measured at the speaker, never copied from an earlier dialogue snapshot.
export const NPC_POINT = Object.freeze({ nearM: 80, farM: 950, minimumM: 0.5 });

export function resolveNpcPointTarget(origin, target) {
  if (![origin?.x, origin?.z, target?.worldX, target?.worldZ].every(Number.isFinite)) return null;
  const dx = target.worldX - origin.x, dz = target.worldZ - origin.z;
  const distance = Math.hypot(dx, dz);
  if (distance < NPC_POINT.minimumM) return null; // "right here" has no direction
  return { bearing: Math.atan2(dx, dz), distance };
}

export function refreshNpcPointTarget(emote, origin) {
  if (!emote?.pointLive || !emote.pointTarget) return;
  const resolved = resolveNpcPointTarget(origin, emote.pointTarget);
  if (!resolved) { emote.pointLive = false; return; }
  emote.pointBearing = resolved.bearing;
  emote.pointDistance = resolved.distance;
}

export function npcPointOptions(emote) {
  return {
    pointBearing: emote.pointBearing, pointDistance: emote.pointDistance,
    pointElapsed: emote.pointT, pointHold: emote.pointHold, pointTarget: emote.pointTarget,
  };
}

const smooth = t => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
export function npcPointMotion(distance = 200, elapsed = 0, hold = 2.6) {
  const style = distance < NPC_POINT.nearM ? 'near' : distance < NPC_POINT.farM ? 'far' : 'farthest';
  // Two compact scoop-and-cast arcs, then hold still. Fit both inside even a
  // short spoken cue; never loop while a long sentence continues.
  const period = Math.min(0.55, Math.max(0.1, (hold - 0.42 - 0.1) / 2));
  const t = Math.max(0, elapsed - 0.42);
  const cycle = Math.floor(t / period), phase = (t % period) / period;
  const paw = style === 'farthest' && cycle < 2 ? Math.sin(Math.PI * phase) ** 2 : 0;
  return {
    style, paw,
    upperPitch: style === 'near' ? -0.95 : style === 'far' ? 0.04 : 0.28 + 0.12 * paw,
    forePitch: style === 'near' ? -0.12 : style === 'far' ? 0.12 : 0.28 + 0.48 * paw,
    palmUp: style === 'near',
  };
}

// Lower the arm while turning through a target behind the back. Once it is
// reachable, the shoulder and wrist aim independently of the remaining turn.
export function npcPointTurnWeight(angle) {
  return 1 - smooth((Math.abs(angle) - Math.PI / 3) / (Math.PI / 4));
}
