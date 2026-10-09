// A final physical guard for ground movement, including old saved itineraries.
// Timetables may be missed; they never grant extra movement speed.
export const NPC_MAX_HUMAN_RUN_SPEED = 4.5;
export const NPC_NORMAL_WALK_LIMIT = 1.5;

export function boundNpcGroundMovement(previous, next, deltaSeconds, maximumSpeed = NPC_MAX_HUMAN_RUN_SPEED) {
  if (!previous || next?.supportMatrix || next?.seated) return next;
  const dt = Math.max(0, Number(deltaSeconds) || 0);
  const distance = Math.hypot(next.x - previous.x, next.y - previous.y, next.z - previous.z);
  const allowed = Math.min(NPC_MAX_HUMAN_RUN_SPEED, Math.max(0, maximumSpeed)) * dt;
  if (!(distance > allowed) || !Number.isFinite(distance)) return next;
  const fraction = allowed / distance;
  return { ...next, mode: 'walk', x: previous.x + (next.x - previous.x) * fraction,
    y: previous.y + (next.y - previous.y) * fraction,
    z: previous.z + (next.z - previous.z) * fraction };
}
