import { interiorLocal, interiorBaseY } from './interiorarchitecture.mjs';
export const INTERIOR_STREAM_POLICY = Object.freeze({ preview: 26, prepare: 15, full: 8, lookahead: 1.7,
  retention: 15, maxWarmRooms: 24, maxBytes: 24 * 1024 * 1024, assemblyMs: 1 });
export function interiorInterest(b, player, velocity = { x: 0, z: 0 }) {
  const p = interiorLocal(b, player), inside = Math.abs(p.x) < b.width / 2 && Math.abs(p.z) < b.depth / 2
    && p.y >= -0.2 && p.y < b.floorCount * b.floorHeight + 0.3;
  const distance = Math.hypot(Math.max(0, Math.abs(p.x) - b.width / 2), Math.max(0, Math.abs(p.z) - b.depth / 2));
  const predicted = interiorLocal(b, { x: player.x + velocity.x * INTERIOR_STREAM_POLICY.lookahead,
    z: player.z + velocity.z * INTERIOR_STREAM_POLICY.lookahead, y: player.y });
  let approaching = false;
  for (const door of b.portals.filter(p => p.kind === 'exterior-door' || p.kind === 'back-door')) {
    const now = Math.hypot(p.x - door.x, p.z - door.z), future = Math.hypot(predicted.x - door.x, predicted.z - door.z);
    if (now < INTERIOR_STREAM_POLICY.prepare && future < now - 0.2) approaching = true;
  }
  const floor = b.interior?.levels.reduce((best, l) => Math.abs(l.y - p.y) < Math.abs(best.y - p.y) ? l : best, b.interior.levels[0]).index || 0;
  return { inside, distance, approaching, floor, baseY: interiorBaseY(b),
    tier: inside || distance < INTERIOR_STREAM_POLICY.full ? 'full'
      : approaching || distance < INTERIOR_STREAM_POLICY.preview ? 'preview' : 'cold' };
}
// A dense terrace must not turn a window-preview radius into unlimited rooms.
// The occupied building wins admission, followed by entrance intent and range.
export function desiredInteriorRooms(buildings, player, velocity) {
  const candidates = [];
  for (const building of buildings) {
    if (!building.interior) continue;
    const interest = interiorInterest(building, player, velocity);
    if (interest.tier === 'cold') continue;
    for (const room of building.interior.rooms) candidates.push({ building, room,
      inside: interest.inside,
      full: interest.tier === 'full' && (!interest.inside || room.floor === interest.floor
        || building.interior.levels[room.floor].kind === 'loft'),
      priority: (interest.inside ? -1000 : 0) + interest.distance
        + (room.floor === interest.floor ? 0 : 2) - (interest.approaching ? 5 : 0) });
  }
  return candidates.sort((a, b) => a.priority - b.priority || a.room.id.localeCompare(b.room.id))
    .slice(0, INTERIOR_STREAM_POLICY.maxWarmRooms);
}
