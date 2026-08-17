import { chooseArrivalStation } from './interregionalticket.mjs';

export const TRANSIT_SCHEMA_VERSION = 1;
export const TRANSIT_PHASES = Object.freeze([
  'idle', 'summoned', 'boarding', 'boarded', 'departing', 'transition', 'arriving', 'complete', 'cancelled',
]);
const NEXT = Object.freeze({
  idle: ['summoned', 'cancelled'],
  summoned: ['boarding', 'cancelled'],
  boarding: ['boarded', 'cancelled'],
  boarded: ['departing', 'cancelled'],
  departing: ['transition', 'cancelled'],
  transition: ['arriving', 'cancelled'],
  arriving: ['complete', 'cancelled'],
  complete: [],
  cancelled: [],
});

export function createTransitPlan({
  transitId = `interregional-${Date.now().toString(36)}`,
  ticketId,
  originRegionId,
  destinationRegionId,
  originStation,
  destinationStations,
  hostPosition,
  routeDistance = 1,
  createdAt = Date.now(),
} = {}) {
  const arrival = chooseArrivalStation(destinationStations, hostPosition);
  if (!ticketId || !originRegionId || !destinationRegionId || !originStation || !arrival) {
    throw new Error('Transit needs both regions and a valid origin/destination station');
  }
  const distance = Math.max(1, Number(routeDistance) || 1);
  return {
    schemaVersion: TRANSIT_SCHEMA_VERSION,
    transitId: String(transitId),
    ticketId: String(ticketId),
    originRegionId: String(originRegionId),
    destinationRegionId: String(destinationRegionId),
    originStation: normalizeStation(originStation),
    destinationStation: normalizeStation(arrival),
    routeDistance: distance,
    phase: 'idle',
    elapsed: 0,
    duration: Math.max(8, Math.min(90, 8 + distance / 220)),
    trackBlockId: `interregional:${originRegionId}:${destinationRegionId}`,
    createdAt,
    updatedAt: createdAt,
  };
}

export function transitionTransit(plan, phase, at = Date.now()) {
  if (!plan || !TRANSIT_PHASES.includes(plan.phase)) throw new Error('Invalid transit plan');
  if (!TRANSIT_PHASES.includes(phase)) throw new Error(`Unknown transit phase: ${phase}`);
  if (plan.phase !== phase && !NEXT[plan.phase].includes(phase)) throw new Error(`Cannot move transit from ${plan.phase} to ${phase}`);
  return { ...plan, phase, updatedAt: at };
}

export function advanceTransit(plan, deltaSeconds) {
  if (!plan || ['complete', 'cancelled'].includes(plan.phase)) return plan;
  let next = { ...plan, elapsed: Math.max(0, plan.elapsed + Math.max(0, Number(deltaSeconds) || 0)) };
  const progress = next.elapsed / next.duration;
  if (next.phase === 'summoned' && progress >= 0.08) next = transitionTransit(next, 'boarding');
  if (next.phase === 'boarding' && progress >= 0.18) next = transitionTransit(next, 'boarded');
  if (next.phase === 'boarded' && progress >= 0.22) next = transitionTransit(next, 'departing');
  if (next.phase === 'departing' && progress >= 0.3) next = transitionTransit(next, 'transition');
  if (next.phase === 'transition' && progress >= 0.86) next = transitionTransit(next, 'arriving');
  if (next.phase === 'arriving' && progress >= 1) next = transitionTransit(next, 'complete');
  return next;
}

export class TrackBlockArbiter {
  constructor() { this.claims = new Map(); }

  claim(blockId, trainId) {
    if (!blockId || !trainId) return false;
    const current = this.claims.get(blockId);
    if (current && current !== trainId) return false;
    this.claims.set(blockId, trainId);
    return true;
  }

  release(blockId, trainId) {
    if (this.claims.get(blockId) !== trainId) return false;
    this.claims.delete(blockId);
    return true;
  }

  owner(blockId) { return this.claims.get(blockId) || null; }

  snapshot() { return Object.fromEntries(this.claims); }
}

function normalizeStation(station) {
  return {
    id: String(station.id || station.stationId || 'station'),
    name: String(station.name || 'Station').slice(0, 64),
    x: Number(station.x) || 0,
    y: Number(station.y) || 0,
    z: Number(station.z) || 0,
  };
}

