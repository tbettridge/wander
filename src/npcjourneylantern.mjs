// Presentation-only rules and a bounded moving-light pool. Journey state stays
// with the existing mobility and legacy traveller simulators.
export const NPC_JOURNEY_LANTERN = Object.freeze({
  desktopLights: 3, xrLights: 1, lightRange: 14, intensity: 8,
  lightViewRange: 110, beaconRange: 800, beaconFadeStart: 550, maxBeacons: 128,
});
const clamp01 = v => Math.max(0, Math.min(1, v));
export function journeyLanternBeaconLevel(distance) {
  const { beaconRange, beaconFadeStart } = NPC_JOURNEY_LANTERN;
  const t = clamp01((distance - beaconFadeStart) / (beaconRange - beaconFadeStart));
  return 1 - t * t * (3 - 2 * t);
}
export function outsideLanternVillages(point, sites = []) {
  return !sites.some(site => Number.isFinite(site?.x) && Number.isFinite(site?.z)
    && Math.hypot(point.x - site.x, point.z - site.z) < Math.max(0, Number(site.radius) || 0));
}
export function interSettlementWalkingEntity(entity) {
  if (entity?.location?.kind === 'regional-edge') return true;
  const executor = entity?.activity?.executor;
  const from = executor?.fromLocation, to = executor?.toLocation;
  return !!from && !!to && (from.kind === 'regional-edge' || to.kind === 'regional-edge'
    || !!from.settlementId && !!to.settlementId && from.settlementId !== to.settlementId);
}
export function walkingLanternTraveller(actor, entity = actor?.remoteState) {
  const pose = actor?.mobilityPose || actor?.remoteState?.publicState?.mobilityPose;
  if (pose) return interSettlementWalkingEntity(entity)
    && pose.mode === 'walk' && !pose.railPhase && !pose.seated && !(pose.seatAmount > 0);
  return !!actor?.roaming && ['travel', 'transfer'].includes(actor.journey?.phase);
}
export function createJourneyLanternPool() {
  return Array.from({ length: NPC_JOURNEY_LANTERN.desktopLights }, () => ({ id: null, source: null, level: 0 }));
}
export function stepJourneyLanternPool(pool, sources, viewer, night, dt, { xr = false, enabled = true } = {}) {
  const budget = xr ? NPC_JOURNEY_LANTERN.xrLights : NPC_JOURNEY_LANTERN.desktopLights;
  const current = new Map(sources.map(source => [source.id, source]));
  const retained = new Set(pool.slice(0, budget).map(slot => slot.id));
  const candidates = enabled && night > .001 ? sources.map(source => ({ source,
    distance: Math.hypot(source.x - viewer.x, source.y - viewer.y, source.z - viewer.z) }))
    .filter(c => c.distance < NPC_JOURNEY_LANTERN.lightViewRange)
    .sort((a, b) => a.distance * (retained.has(a.source.id) ? .8 : 1) - b.distance * (retained.has(b.source.id) ? .8 : 1)
      || a.source.id.localeCompare(b.source.id)).slice(0, budget) : [];
  const wanted = new Map(candidates.map(c => [c.source.id, c.source]));
  const assigned = new Set(pool.map(slot => slot.id));
  const rate = 1 - Math.exp(-8 * Math.max(0, Math.min(.1, Number(dt) || 0)));
  for (let i = 0; i < pool.length; i++) {
    const slot = pool[i];
    if (i >= budget || slot.id && !current.has(slot.id)) { slot.id = null; slot.source = null; slot.level = 0; }
    if (i >= budget) continue;
    if (slot.id) slot.source = current.get(slot.id); // Follow the hand without fading every time it moves.
    const target = wanted.has(slot.id) ? night : 0;
    slot.level += (target - slot.level) * rate;
    if (!target && slot.level < .003) {
      assigned.delete(slot.id); slot.id = null; slot.source = null; slot.level = 0;
      const next = candidates.find(c => !assigned.has(c.source.id));
      if (next) { slot.id = next.source.id; slot.source = next.source; assigned.add(slot.id); }
    }
  }
  return { budget, active: pool.filter(s => s.level > .01).length };
}
