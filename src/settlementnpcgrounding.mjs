/**
 * Resolve a settlement NPC's root against the same authored support as the
 * player. This must run after horizontal collision as well as before it: a
 * steering step can finish on a building plinth even though it began on the
 * surrounding terrain.
 */
export function groundSettlementNpc(position, walkableSurface) {
  position.y = walkableSurface.groundAt(position.x, position.z, position.y + 0.8);
  return position.y;
}
