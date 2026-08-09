// Pure, renderer-free reconciliation for the visible occupants of a passenger
// train. The living-world manifest remains the authority; this module only
// describes which presentation objects a renderer should create, move or
// remove to mirror its current boarded-NPC view.

export const RAIL_PASSENGER_PRESENTATION_VERSION = 1;

function requiredId(value, label) {
  const id = String(value ?? '').trim();
  if (!id) throw new Error(`${label} is required`);
  return id;
}

function seatIndex(value, label) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return index;
}

export function railPassengerPresentationKey(runId, reservationId) {
  return `${requiredId(runId, 'runId')}::${requiredId(reservationId, 'reservationId')}`;
}

function presentationRecord(runId, reservation) {
  return Object.freeze({
    key: railPassengerPresentationKey(runId, reservation.reservationId),
    runId,
    reservationId: requiredId(reservation.reservationId, 'reservationId'),
    personId: requiredId(reservation.personId, 'personId'),
    carriageIndex: seatIndex(reservation.carriageIndex, 'carriageIndex'),
    seatIndex: seatIndex(reservation.seatIndex, 'seatIndex'),
  });
}

function compareRecords(a, b) {
  return a.carriageIndex - b.carriageIndex
    || a.seatIndex - b.seatIndex
    || a.key.localeCompare(b.key);
}

function recordsDiffer(a, b) {
  return a.runId !== b.runId
    || a.reservationId !== b.reservationId
    || a.personId !== b.personId
    || a.carriageIndex !== b.carriageIndex
    || a.seatIndex !== b.seatIndex;
}

/**
 * Return deterministic create/update/remove operations for boarded NPCs.
 * Reserved (not yet aboard), alighted and player records intentionally have no
 * train interior presentation. Duplicate people or seats reject the entire
 * view so a corrupt authority cannot render two bodies in one place.
 */
export function planRailPassengerPresentations(previous = [], {
  runId,
  reservations = [],
} = {}) {
  const canonicalRunId = requiredId(runId, 'runId');
  if (!Array.isArray(reservations)) throw new Error('reservations must be an array');

  const previousByKey = new Map();
  for (const record of previous ?? []) {
    if (!record || typeof record !== 'object') throw new Error('previous record is invalid');
    const key = requiredId(record.key, 'previous key');
    if (previousByKey.has(key)) throw new Error(`Duplicate previous presentation ${key}`);
    previousByKey.set(key, Object.freeze({ ...record, key }));
  }

  const desired = [];
  const people = new Set();
  const seats = new Set();
  for (const reservation of reservations) {
    if (!reservation || reservation.kind !== 'npc' || reservation.status !== 'boarded') continue;
    const record = presentationRecord(canonicalRunId, reservation);
    if (reservation.runId != null && reservation.runId !== canonicalRunId) {
      throw new Error(`Reservation ${record.reservationId} belongs to another run`);
    }
    if (people.has(record.personId)) throw new Error(`Duplicate boarded passenger ${record.personId}`);
    const seat = `${record.carriageIndex}:${record.seatIndex}`;
    if (seats.has(seat)) throw new Error(`Duplicate boarded passenger seat ${seat}`);
    people.add(record.personId);
    seats.add(seat);
    desired.push(record);
  }
  desired.sort(compareRecords);

  const desiredByKey = new Map(desired.map((record) => [record.key, record]));
  const operations = [];
  for (const record of [...previousByKey.values()].sort(compareRecords)) {
    if (!desiredByKey.has(record.key)) operations.push(Object.freeze({ type: 'remove', record }));
  }
  for (const record of desired) {
    const prior = previousByKey.get(record.key);
    if (!prior) operations.push(Object.freeze({ type: 'create', record }));
    else if (recordsDiffer(prior, record)) {
      operations.push(Object.freeze({ type: 'update', previous: prior, record }));
    }
  }

  return Object.freeze({
    version: RAIL_PASSENGER_PRESENTATION_VERSION,
    records: Object.freeze(desired),
    operations: Object.freeze(operations),
  });
}
