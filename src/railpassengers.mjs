// Pure, THREE-free passenger manifests for the regional railway. Timetables
// decide when a run visits a stop; this module only owns capacity, reservations,
// and the exact-once transitions made at those stops.

export const RAIL_PASSENGER_SCHEMA_VERSION = 1;
export const PASSENGER_CARRIAGE_COUNT = 2;
export const PASSENGER_SEATS_PER_CARRIAGE = 4;
export const ORDINARY_NPC_SEATS_PER_CARRIAGE = 3;
export const PLAYER_PREFERRED_SEAT = 3;

export const PASSENGER_STATUS = Object.freeze({
  reserved: 'reserved',
  boarded: 'boarded',
  alighted: 'alighted',
});

function requiredId(value, label) {
  const id = String(value ?? '').trim();
  if (!id) throw new Error(`${label} is required`);
  return id;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return number;
}

function encodeId(value) {
  return encodeURIComponent(String(value));
}

/** A stable identity for one traversal of the regional service. */
export function createServiceRunId({
  serviceId = 'regional', serviceEpoch = null, serviceDay = 0, sequence = 0,
} = {}) {
  const epoch = serviceEpoch == null
    ? ''
    : `:${encodeId(requiredId(serviceEpoch, 'serviceEpoch'))}`;
  return `rail-run:${encodeId(requiredId(serviceId, 'serviceId'))}${epoch}:${nonNegativeInteger(serviceDay, 'serviceDay')}:${nonNegativeInteger(sequence, 'sequence')}`;
}

function copyReceipt(receipt) {
  return receipt ? { ...receipt } : null;
}

function copyReservation(reservation) {
  return {
    ...reservation,
    boardReceipt: copyReceipt(reservation.boardReceipt),
    alightReceipt: copyReceipt(reservation.alightReceipt),
  };
}

function active(reservation) {
  return reservation.status !== PASSENGER_STATUS.alighted;
}

function compareSeats(a, b) {
  return a.carriageIndex - b.carriageIndex
    || a.seatIndex - b.seatIndex
    || a.reservationId.localeCompare(b.reservationId);
}

/**
 * Capacity and lifecycle authority for one service run. The default geometry
 * matches the current renderer: two passenger cars with four authored seats.
 * Ordinary NPC auto-allocation never uses seat 3 and never exceeds three NPCs
 * per car, preserving a seat the player can use without evicting a passenger.
 */
export class RailPassengerManifest {
  constructor({
    runId,
    carriageCount = PASSENGER_CARRIAGE_COUNT,
    seatsPerCarriage = PASSENGER_SEATS_PER_CARRIAGE,
    ordinaryNpcLimit = ORDINARY_NPC_SEATS_PER_CARRIAGE,
  } = {}) {
    this.runId = requiredId(runId, 'runId');
    this.carriageCount = nonNegativeInteger(carriageCount, 'carriageCount');
    this.seatsPerCarriage = nonNegativeInteger(seatsPerCarriage, 'seatsPerCarriage');
    this.ordinaryNpcLimit = nonNegativeInteger(ordinaryNpcLimit, 'ordinaryNpcLimit');
    if (this.carriageCount < 1 || this.seatsPerCarriage < 1) {
      throw new Error('A passenger manifest needs at least one carriage and one seat');
    }
    if (this.ordinaryNpcLimit >= this.seatsPerCarriage) {
      throw new Error('ordinaryNpcLimit must leave at least one player-available seat');
    }
    this._reservations = new Map();
    this._personReservations = new Map();
  }

  get physicalCapacity() {
    return this.carriageCount * this.seatsPerCarriage;
  }

  get ordinaryNpcCapacity() {
    return this.carriageCount * this.ordinaryNpcLimit;
  }

  reservations({ includeAlighted = true } = {}) {
    return [...this._reservations.values()]
      .filter((reservation) => includeAlighted || active(reservation))
      .sort(compareSeats)
      .map(copyReservation);
  }

  reservationForPerson(personId) {
    const reservationId = this._personReservations.get(requiredId(personId, 'personId'));
    const reservation = reservationId ? this._reservations.get(reservationId) : null;
    return reservation ? copyReservation(reservation) : null;
  }

  _seatOccupant(carriageIndex, seatIndex) {
    return [...this._reservations.values()].find((reservation) => (
      active(reservation)
      && reservation.carriageIndex === carriageIndex
      && reservation.seatIndex === seatIndex
    ));
  }

  _npcCount(carriageIndex) {
    let count = 0;
    for (const reservation of this._reservations.values()) {
      if (active(reservation) && reservation.kind === 'npc'
        && reservation.carriageIndex === carriageIndex) count++;
    }
    return count;
  }

  _checkSeat(carriageIndex, seatIndex) {
    const carriage = nonNegativeInteger(carriageIndex, 'carriageIndex');
    const seat = nonNegativeInteger(seatIndex, 'seatIndex');
    if (carriage >= this.carriageCount) throw new Error(`Unknown carriage ${carriage}`);
    if (seat >= this.seatsPerCarriage) throw new Error(`Unknown seat ${seat}`);
    return { carriage, seat };
  }

  _automaticSeat(kind) {
    const candidates = [];
    for (let carriageIndex = 0; carriageIndex < this.carriageCount; carriageIndex++) {
      const npcCount = this._npcCount(carriageIndex);
      if (kind === 'npc' && npcCount >= this.ordinaryNpcLimit) continue;
      const seatOrder = kind === 'player'
        ? [PLAYER_PREFERRED_SEAT, ...Array.from({ length: this.seatsPerCarriage }, (_, i) => i)]
        : Array.from({ length: this.ordinaryNpcLimit }, (_, i) => i);
      for (const seatIndex of seatOrder) {
        if (seatIndex >= this.seatsPerCarriage || this._seatOccupant(carriageIndex, seatIndex)) continue;
        candidates.push({ carriageIndex, seatIndex, npcCount });
        break;
      }
    }
    candidates.sort((a, b) => a.npcCount - b.npcCount
      || a.carriageIndex - b.carriageIndex
      || a.seatIndex - b.seatIndex);
    return candidates[0] ?? null;
  }

  /** Reserve a seat. Repeating an identical reservation is idempotent. */
  reserve({
    personId, originStationId, destinationStationId, kind = 'npc',
    carriageIndex = null, seatIndex = null,
  } = {}) {
    const person = requiredId(personId, 'personId');
    const origin = requiredId(originStationId, 'originStationId');
    const destination = requiredId(destinationStationId, 'destinationStationId');
    if (origin === destination) throw new Error('Passenger origin and destination must differ');
    if (kind !== 'npc' && kind !== 'player') throw new Error(`Unknown passenger kind ${kind}`);

    const existing = this.reservationForPerson(person);
    if (existing && active(existing)) {
      const same = existing.originStationId === origin
        && existing.destinationStationId === destination && existing.kind === kind
        && (carriageIndex == null || existing.carriageIndex === Number(carriageIndex))
        && (seatIndex == null || existing.seatIndex === Number(seatIndex));
      if (same) return existing;
      throw new Error(`Person ${person} already has an active reservation on ${this.runId}`);
    }

    let allocated;
    if (carriageIndex == null && seatIndex == null) {
      allocated = this._automaticSeat(kind);
      if (!allocated) throw new Error(`No ${kind} passenger seat is available on ${this.runId}`);
    } else if (carriageIndex != null && seatIndex != null) {
      const checked = this._checkSeat(carriageIndex, seatIndex);
      allocated = { carriageIndex: checked.carriage, seatIndex: checked.seat };
      if (this._seatOccupant(allocated.carriageIndex, allocated.seatIndex)) {
        throw new Error(`Carriage ${allocated.carriageIndex} seat ${allocated.seatIndex} is occupied`);
      }
      if (kind === 'npc' && (allocated.seatIndex >= this.ordinaryNpcLimit
        || this._npcCount(allocated.carriageIndex) >= this.ordinaryNpcLimit)) {
        throw new Error(`Carriage ${allocated.carriageIndex} ordinary NPC capacity is full`);
      }
    } else {
      throw new Error('carriageIndex and seatIndex must be supplied together');
    }

    const reservationId = `${this.runId}:passenger:${encodeId(person)}`;
    const reservation = {
      reservationId,
      runId: this.runId,
      personId: person,
      originStationId: origin,
      destinationStationId: destination,
      kind,
      carriageIndex: allocated.carriageIndex,
      seatIndex: allocated.seatIndex,
      status: PASSENGER_STATUS.reserved,
      boardReceipt: null,
      alightReceipt: null,
    };
    this._reservations.set(reservationId, reservation);
    this._personReservations.set(person, reservationId);
    return copyReservation(reservation);
  }

  _reservation(reservationOrPersonId) {
    const id = requiredId(reservationOrPersonId, 'reservationOrPersonId');
    const reservation = this._reservations.get(id)
      ?? this._reservations.get(this._personReservations.get(id));
    if (!reservation) throw new Error(`Unknown passenger reservation ${id}`);
    return reservation;
  }

  board(reservationOrPersonId, stationId, { serviceTick = null } = {}) {
    const reservation = this._reservation(reservationOrPersonId);
    if (reservation.boardReceipt) {
      return { applied: false, receipt: copyReceipt(reservation.boardReceipt) };
    }
    const station = requiredId(stationId, 'stationId');
    if (station !== reservation.originStationId) {
      throw new Error(`Passenger ${reservation.personId} cannot board at ${station}`);
    }
    const receipt = {
      receiptId: `${reservation.reservationId}:board`,
      type: 'board',
      runId: this.runId,
      reservationId: reservation.reservationId,
      personId: reservation.personId,
      stationId: station,
      carriageIndex: reservation.carriageIndex,
      seatIndex: reservation.seatIndex,
      serviceTick,
    };
    reservation.status = PASSENGER_STATUS.boarded;
    reservation.boardReceipt = receipt;
    return { applied: true, receipt: copyReceipt(receipt) };
  }

  alight(reservationOrPersonId, stationId, { serviceTick = null } = {}) {
    const reservation = this._reservation(reservationOrPersonId);
    if (reservation.alightReceipt) {
      return { applied: false, receipt: copyReceipt(reservation.alightReceipt) };
    }
    if (!reservation.boardReceipt) throw new Error(`Passenger ${reservation.personId} has not boarded`);
    const station = requiredId(stationId, 'stationId');
    if (station !== reservation.destinationStationId) {
      throw new Error(`Passenger ${reservation.personId} cannot alight at ${station}`);
    }
    const receipt = {
      receiptId: `${reservation.reservationId}:alight`,
      type: 'alight',
      runId: this.runId,
      reservationId: reservation.reservationId,
      personId: reservation.personId,
      stationId: station,
      carriageIndex: reservation.carriageIndex,
      seatIndex: reservation.seatIndex,
      serviceTick,
    };
    reservation.status = PASSENGER_STATUS.alighted;
    reservation.alightReceipt = receipt;
    return { applied: true, receipt: copyReceipt(receipt) };
  }

  /** Passengers physically occupying seats now. */
  occupantsInCarriage(carriageIndex) {
    const carriage = nonNegativeInteger(carriageIndex, 'carriageIndex');
    if (carriage >= this.carriageCount) throw new Error(`Unknown carriage ${carriage}`);
    return [...this._reservations.values()]
      .filter((reservation) => reservation.status === PASSENGER_STATUS.boarded
        && reservation.carriageIndex === carriage)
      .sort(compareSeats)
      .map(copyReservation);
  }

  /** People waiting to board or due to alight during a stop. */
  occupantsAtStop(stationId) {
    const station = requiredId(stationId, 'stationId');
    return {
      boarding: [...this._reservations.values()]
        .filter((reservation) => reservation.status === PASSENGER_STATUS.reserved
          && reservation.originStationId === station)
        .sort(compareSeats).map(copyReservation),
      alighting: [...this._reservations.values()]
        .filter((reservation) => reservation.status === PASSENGER_STATUS.boarded
          && reservation.destinationStationId === station)
        .sort(compareSeats).map(copyReservation),
    };
  }

  /** An unoccupied seat suitable for the player, without mutating the manifest. */
  playerAvailableSeat(preferredCarriage = null) {
    const order = [];
    if (preferredCarriage != null) {
      const checked = nonNegativeInteger(preferredCarriage, 'preferredCarriage');
      if (checked >= this.carriageCount) throw new Error(`Unknown carriage ${checked}`);
      order.push(checked);
    }
    for (let i = 0; i < this.carriageCount; i++) if (!order.includes(i)) order.push(i);
    for (const carriageIndex of order) {
      const seats = [PLAYER_PREFERRED_SEAT, ...Array.from({ length: this.seatsPerCarriage }, (_, i) => i)];
      for (const seatIndex of seats) {
        if (seatIndex < this.seatsPerCarriage && !this._seatOccupant(carriageIndex, seatIndex)) {
          return { carriageIndex, seatIndex };
        }
      }
    }
    return null;
  }

  snapshot() {
    return {
      version: RAIL_PASSENGER_SCHEMA_VERSION,
      runId: this.runId,
      carriageCount: this.carriageCount,
      seatsPerCarriage: this.seatsPerCarriage,
      ordinaryNpcLimit: this.ordinaryNpcLimit,
      reservations: this.reservations(),
    };
  }

  static restore(snapshot) {
    if (!snapshot || snapshot.version !== RAIL_PASSENGER_SCHEMA_VERSION) {
      throw new Error('Unsupported rail passenger snapshot');
    }
    const manifest = new RailPassengerManifest(snapshot);
    for (const stored of snapshot.reservations ?? []) {
      const reservation = copyReservation(stored);
      if (reservation.runId !== manifest.runId) throw new Error('Reservation run does not match manifest');
      if (manifest._personReservations.has(reservation.personId)) throw new Error('Duplicate passenger in snapshot');
      manifest._checkSeat(reservation.carriageIndex, reservation.seatIndex);
      if (active(reservation) && manifest._seatOccupant(reservation.carriageIndex, reservation.seatIndex)) {
        throw new Error('Duplicate active seat in snapshot');
      }
      if (!Object.values(PASSENGER_STATUS).includes(reservation.status)) {
        throw new Error(`Unknown passenger status ${reservation.status}`);
      }
      manifest._reservations.set(reservation.reservationId, reservation);
      manifest._personReservations.set(reservation.personId, reservation.reservationId);
    }
    for (let carriageIndex = 0; carriageIndex < manifest.carriageCount; carriageIndex++) {
      if (manifest._npcCount(carriageIndex) > manifest.ordinaryNpcLimit) {
        throw new Error('Snapshot exceeds ordinary NPC carriage capacity');
      }
    }
    return manifest;
  }
}
