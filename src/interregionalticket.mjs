/**
 * Diegetic interregional travel state. A ticket is a signed-in-memory
 * itinerary, not a currency item: the station keeper issues it after the
 * destination is known and the host approves the visitor.
 */

export const TICKET_SCHEMA_VERSION = 1;
export const TICKET_PHASES = Object.freeze([
  'destination-pinned',
  'keeper-confirmed',
  'admission-requested',
  'host-approved',
  'preflight',
  'issued',
  'summoned',
  'boarded',
  'departing',
  'transition',
  'arriving',
  'visit-active',
  'return-requested',
  'returning',
  'complete',
  'cancelled',
]);

const TRANSITIONS = Object.freeze({
  'destination-pinned': ['keeper-confirmed', 'cancelled'],
  'keeper-confirmed': ['admission-requested', 'cancelled'],
  'admission-requested': ['host-approved', 'cancelled'],
  'host-approved': ['preflight', 'cancelled'],
  preflight: ['issued', 'cancelled'],
  issued: ['summoned', 'cancelled'],
  summoned: ['boarded', 'cancelled'],
  boarded: ['departing', 'cancelled'],
  departing: ['transition', 'cancelled'],
  transition: ['arriving', 'cancelled'],
  arriving: ['visit-active', 'cancelled'],
  'visit-active': ['return-requested', 'cancelled'],
  'return-requested': ['returning', 'cancelled'],
  returning: ['complete', 'cancelled'],
  complete: [],
  cancelled: [],
});

export function createTicket({
  ticketId = `ticket-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  passengerId,
  passengerName = 'Traveller',
  originRegionId,
  destination,
  requestedAt = Date.now(),
  returnHomeOnly = true,
} = {}) {
  if (!passengerId) throw new Error('A ticket needs a passenger id');
  const target = normalizeDestination(destination);
  return {
    schemaVersion: TICKET_SCHEMA_VERSION,
    ticketId: String(ticketId),
    passengerId: String(passengerId),
    passengerName: String(passengerName).slice(0, 28),
    originRegionId: originRegionId ? String(originRegionId) : null,
    destination: target,
    returnHomeOnly: returnHomeOnly !== false,
    phase: 'destination-pinned',
    revision: 0,
    requestedAt,
    updatedAt: requestedAt,
    history: [{ phase: 'destination-pinned', at: requestedAt }],
  };
}

export function transitionTicket(ticket, phase, metadata = {}, at = Date.now()) {
  if (!ticket || !TICKET_PHASES.includes(ticket.phase)) throw new Error('Invalid ticket');
  if (!TICKET_PHASES.includes(phase)) throw new Error(`Unknown ticket phase: ${phase}`);
  if (ticket.phase !== phase && !TRANSITIONS[ticket.phase].includes(phase)) {
    throw new Error(`Cannot move ticket from ${ticket.phase} to ${phase}`);
  }
  const next = {
    ...ticket,
    ...metadata,
    phase,
    revision: (Number(ticket.revision) || 0) + (ticket.phase === phase ? 0 : 1),
    updatedAt: at,
    history: ticket.phase === phase
      ? [...(ticket.history || [])]
      : [...(ticket.history || []), { phase, at }],
  };
  if (next.destination) next.destination = normalizeDestination(next.destination);
  return next;
}

export function canTransitionTicket(ticket, phase) {
  return !!ticket && (ticket.phase === phase || TRANSITIONS[ticket.phase]?.includes(phase));
}

export function ticketPhaseLabel(phase) {
  return {
    'destination-pinned': 'destination pinned',
    'keeper-confirmed': 'station keeper consulted',
    'admission-requested': 'asking the host',
    'host-approved': 'host approved',
    preflight: 'checking the connection',
    issued: 'ticket issued',
    summoned: 'train summoned',
    boarded: 'aboard the red commuter',
    departing: 'departing',
    transition: 'crossing between regions',
    arriving: 'approaching the destination station',
    'visit-active': 'visiting',
    'return-requested': 'returning home',
    returning: 'on the way home',
    complete: 'journey complete',
    cancelled: 'journey cancelled',
  }[phase] || String(phase || 'unknown');
}

export function normalizeDestination(destination) {
  if (!destination || typeof destination !== 'object') throw new Error('A ticket needs a destination');
  if (!destination.regionId || !destination.regionCode || !destination.regionName) {
    throw new Error('Destination needs region id, code, and name');
  }
  return {
    regionId: String(destination.regionId).slice(0, 96),
    regionCode: String(destination.regionCode).slice(0, 16),
    regionName: String(destination.regionName).slice(0, 48),
    ownerName: String(destination.ownerName || 'Traveller').slice(0, 28),
    seed: Number.isFinite(Number(destination.seed)) ? Number(destination.seed) : null,
    arrivalStationId: destination.arrivalStationId ? String(destination.arrivalStationId).slice(0, 96) : null,
    arrivalStationName: destination.arrivalStationName ? String(destination.arrivalStationName).slice(0, 64) : null,
    arrivalStationX: Number.isFinite(Number(destination.arrivalStationX)) ? Number(destination.arrivalStationX) : null,
    arrivalStationY: Number.isFinite(Number(destination.arrivalStationY)) ? Number(destination.arrivalStationY) : null,
    arrivalStationZ: Number.isFinite(Number(destination.arrivalStationZ)) ? Number(destination.arrivalStationZ) : null,
  };
}

export function createAdmissionRequest({ ticket, identity, message = '' } = {}) {
  if (!ticket?.ticketId || !identity?.playerId) throw new Error('Admission needs a ticket and identity');
  return {
    ticketId: ticket.ticketId,
    regionId: ticket.destination.regionId,
    originRegionId: ticket.originRegionId || null,
    playerId: identity.playerId,
    playerName: identity.displayName,
    message: String(message).slice(0, 240),
    requestedAt: Date.now(),
  };
}

export function createAdmissionDecision({ request, approved, hostId, reason = '' } = {}) {
  if (!request?.ticketId || !request?.playerId || !hostId) throw new Error('Admission decision is incomplete');
  return {
    ticketId: request.ticketId,
    playerId: request.playerId,
    hostId: String(hostId),
    approved: !!approved,
    reason: String(reason).slice(0, 240),
    decidedAt: Date.now(),
  };
}

export function chooseArrivalStation(stations, hostPosition) {
  if (!Array.isArray(stations) || !stations.length) return null;
  const hx = Number(hostPosition?.x) || 0;
  const hz = Number(hostPosition?.z) || 0;
  return [...stations]
    .filter((station) => station && Number.isFinite(Number(station.x)) && Number.isFinite(Number(station.z)))
    .sort((a, b) => Math.hypot(a.x - hx, a.z - hz) - Math.hypot(b.x - hx, b.z - hz))[0] || null;
}

export function isTicketBoardable(ticket) {
  return ['issued', 'summoned', 'boarded'].includes(ticket?.phase);
}

export function isTicketActive(ticket) {
  return !!ticket && !['complete', 'cancelled'].includes(ticket.phase);
}
