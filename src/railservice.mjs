// Pure, THREE-free passenger-service logic for the regional railway: the train
// stopping/dwell state machine and procedural station naming. Keeping this out
// of the renderer lets the schedule math and names run in Node tests, and lets
// a worker drive the timetable later without a graphics context.

import { createServiceRunId } from './railpassengers.mjs';

const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Same integer hash the planner uses, so service seeds stay stable and match
// the deterministic feel of the rest of the railway.
function hash01(seed, a, b = 0) {
  let n = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 11, 0x85ebca77)) >>> 0;
  n ^= n >>> 16;
  n = Math.imul(n, 0x7feb352d) >>> 0;
  n ^= n >>> 15;
  n = Math.imul(n, 0x846ca68b) >>> 0;
  n ^= n >>> 16;
  // The final XOR yields a signed int32; force unsigned so the result is a
  // clean [0, 1) fraction (an out-of-range pick would otherwise return undefined).
  return (n >>> 0) / 4294967296;
}

function pick(list, value) {
  return list[Math.min(list.length - 1, Math.floor(value * list.length))];
}

/** Forward arc-length from `a` to `b` on a closed route of `length`. The train
 * only ever travels in the direction of increasing distance, so the gap to the
 * next stop is always this wrapped forward difference. */
export function forwardGap(a, b, length) {
  if (!(length > 0)) return 0;
  let g = (b - a) % length;
  if (g < 0) g += length;
  return g;
}

/** Offset a moving VR seat's tracking origin so the headset's current tracked
 * eye position lands exactly on the authored seat eye anchor. Later headset
 * motion remains relative to that seated origin instead of adding a second
 * standing-height translation above the carriage. */
export function xrSeatOriginOffset(headPosition, yaw = 0, out = {}) {
  const x = Number(headPosition?.x || 0);
  const y = Number(headPosition?.y || 0);
  const z = Number(headPosition?.z || 0);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // Object3D composes translation before rotation, so cancel the already
  // yaw-rotated tracking pose in the seat parent's coordinate system.
  out.x = -(c * x + s * z);
  out.y = -y;
  out.z = -(-s * x + c * z);
  return out;
}

/** Illumination for a carriage sconce. Only the carriage currently occupied by
 * the player may light, and it eases in across dusk instead of snapping on at
 * an arbitrary clock time. `nightAmount` is the sky's existing 0..1 night mix. */
export function occupiedCarriageLanternLevel(nightAmount, carriageIndex, ridingCarriage) {
  if (carriageIndex !== ridingCarriage || ridingCarriage < 0) return 0;
  const t = clamp((Number(nightAmount) - 0.12) / 0.76, 0, 1);
  return t * t * (3 - 2 * t);
}

// Passenger controls are onboarding, not a permanent obstruction to the
// scenery. Re-show them briefly when a fresh decision is useful.
export const PASSENGER_HINT_SECONDS = Object.freeze({
  boarding: 7,
  arrival: 6,
  seatSwitch: 3,
});

export function stepPassengerHintTimer(current, dt) {
  return Math.max(0, Number(current) - Math.max(0, Number(dt) || 0));
}

export const TRAIN_PHASE = Object.freeze({
  dwelling: 'dwelling',
  departing: 'departing',
  cruising: 'cruising',
  approaching: 'approaching',
});

export const TRAIN_SCHEDULE_SNAPSHOT_VERSION = 1;

function serviceIdPart(value) {
  const id = String(value ?? '').trim();
  if (!id) throw new Error('TrainScheduleModel serviceId is required');
  return encodeURIComponent(id);
}

function positiveFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`TrainScheduleModel ${label} must be positive and finite`);
  }
  return number;
}

function nonNegativeFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`TrainScheduleModel ${label} must be non-negative and finite`);
  }
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`TrainScheduleModel ${label} must be a non-negative integer`);
  }
  return number;
}

function routeEpochHash(value, seed) {
  let hash = seed >>> 0;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
    hash ^= hash >>> 13;
  }
  return hash >>> 0;
}

/**
 * Stable identity for one physical alignment, including station identity.
 * Passenger manifests use it to avoid surviving onto a different regenerated
 * route that happens to share the same service/day/run counters.
 */
export function createRailServiceEpoch(routeLength, stops) {
  const length = positiveFinite(routeLength, 'route length');
  if (!Array.isArray(stops) || stops.length < 2) {
    throw new Error('TrainScheduleModel route epoch needs at least two stops');
  }
  const normalized = stops.map((stop, index) => {
    const distance = Number(typeof stop === 'number' ? stop : stop?.distance);
    if (!Number.isFinite(distance)) throw new Error(`Invalid route-epoch stop ${index}`);
    const stationId = typeof stop === 'object' && stop?.stationId != null
      ? String(stop.stationId).trim()
      : `stop:${typeof stop === 'object' && Number.isInteger(stop?.index) ? stop.index : index}`;
    if (!stationId) throw new Error(`Invalid route-epoch station ${index}`);
    const wrapped = ((distance % length) + length) % length;
    return `${Math.round(wrapped * 1000)}@${encodeURIComponent(stationId)}`;
  }).sort();
  const signature = `${Math.round(length * 1000)}|${normalized.join('|')}`;
  const first = routeEpochHash(signature, 2166136261).toString(36);
  const second = routeEpochHash(signature, 0x9e3779b9).toString(36);
  return `route-v1-${first}-${second}`;
}

/**
 * A forgiving (not simulation-heavy) timetable model. The train cruises, brakes
 * so it can always stop cleanly at the next station, dwells with the doors open,
 * then accelerates away to the following stop. It is deterministic given the same
 * step sequence, and exposes everything the renderer/HUD needs: which station is
 * next, distance and rough ETA, whether the doors should be open, and the dwell
 * progress used to animate them.
 */
export class TrainScheduleModel {
  constructor(routeLength, stopDistances, {
    cruiseSpeed = 16,
    accel = 0.7,
    decel = 0.95,
    dwell = 16,
    stopEpsilon = 0.75,
    arriveSpeed = 0.5,
    startIndex = 0,
    serviceId = 'regional',
    serviceEpoch = null,
    serviceDay = 0,
  } = {}) {
    const length = positiveFinite(routeLength, 'route length');
    if (!Array.isArray(stopDistances) || stopDistances.length < 2) {
      throw new Error('TrainScheduleModel needs a positive length and at least two stops');
    }
    const normalizedDistances = stopDistances.map((distance, index) => {
      const number = Number(distance);
      if (!Number.isFinite(number)) throw new Error(`Invalid train stop distance ${index}`);
      return number;
    });
    this.length = length;
    // Store stops with their original plan index so the HUD can map back to the
    // named stations even though the train visits them in route order.
    this.stops = normalizedDistances
      .map((distance, index) => ({ distance: ((distance % length) + length) % length, index }))
      .sort((a, b) => a.distance - b.distance);
    this.stopCount = this.stops.length;
    this.cruiseSpeed = positiveFinite(cruiseSpeed, 'cruiseSpeed');
    this.accel = positiveFinite(accel, 'accel');
    this.decel = positiveFinite(decel, 'decel');
    this.dwell = positiveFinite(dwell, 'dwell');
    this.stopEpsilon = positiveFinite(stopEpsilon, 'stopEpsilon');
    this.arriveSpeed = nonNegativeFinite(arriveSpeed, 'arriveSpeed');
    this.serviceId = String(serviceId ?? '').trim();
    serviceIdPart(this.serviceId);
    this.serviceEpoch = serviceEpoch == null
      ? createRailServiceEpoch(length, normalizedDistances)
      : String(serviceEpoch).trim();
    serviceIdPart(this.serviceEpoch);
    this.serviceDay = nonNegativeInteger(serviceDay, 'serviceDay');
    this.reset(nonNegativeInteger(startIndex, 'startIndex'));
  }

  reset(startIndex = 0) {
    const target = ((startIndex % this.stopCount) + this.stopCount) % this.stopCount;
    this.targetStop = target;
    this.distance = this.stops[target].distance;
    this.velocity = 0;
    this.phase = TRAIN_PHASE.dwelling;
    this.dwellRemaining = this.dwell;
    this.doorFactor = 0;
    this.justArrived = false;
    this.justDeparted = false;
    this.serviceSeconds = 0;
    this.arrivalSequence = 0;
    this.departureSequence = 0;
    this.circuitSequence = 0;
    this.runSequence = 0;
    this.startTargetStop = target;
    this.arrivalEvent = null;
    this.departureEvent = null;
  }

  /** Stable identity of the circuit currently being operated. */
  get serviceRunId() {
    return createServiceRunId({
      serviceId: this.serviceId,
      serviceEpoch: this.serviceEpoch,
      serviceDay: this.serviceDay,
      sequence: this.runSequence,
    });
  }

  _event(type, sequence, stationIndex, routeStopIndex, extra = {}) {
    return Object.freeze({
      eventId: `rail-service:${this.serviceRunId}:${type}:${sequence}:stop:${stationIndex}`,
      type,
      serviceId: this.serviceId,
      serviceEpoch: this.serviceEpoch,
      serviceDay: this.serviceDay,
      serviceRunId: this.serviceRunId,
      runSequence: this.runSequence,
      circuitSequence: this.circuitSequence,
      sequence,
      stationIndex,
      routeStopIndex,
      serviceSeconds: this.serviceSeconds,
      ...extra,
    });
  }

  /** The plan-station index the train is heading toward (or stopped at). */
  get nextStationIndex() {
    return this.stops[this.targetStop].index;
  }

  get distanceToNext() {
    return forwardGap(this.distance, this.stops[this.targetStop].distance, this.length);
  }

  get atStation() {
    return this.phase === TRAIN_PHASE.dwelling;
  }

  /** The plan-station index the train is dwelling at, or -1 while moving. */
  get currentStationIndex() {
    return this.atStation ? this.stops[this.targetStop].index : -1;
  }

  /** Rough seconds until the next station opens its doors — deliberately loose;
   * used only for the "next station" display. */
  get etaSeconds() {
    if (this.atStation) return 0;
    const gap = this.distanceToNext;
    const speed = Math.max(this.velocity, this.cruiseSpeed * 0.6, 1);
    return gap / speed;
  }

  step(dt) {
    this.justArrived = false;
    this.justDeparted = false;
    this.arrivalEvent = null;
    this.departureEvent = null;
    if (!(dt > 0)) return this;
    this.serviceSeconds += dt;

    if (this.phase === TRAIN_PHASE.dwelling) {
      this.velocity = 0;
      this.dwellRemaining -= dt;
      // Doors ease open over the first ~2s and shut over the last ~2s of dwell.
      const openTime = this.dwell - this.dwellRemaining;
      const closing = this.dwellRemaining;
      this.doorFactor = clamp(Math.min(openTime / 2, closing / 2), 0, 1);
      if (this.dwellRemaining <= 0) {
        const departedRouteStop = this.targetStop;
        const departedStation = this.stops[departedRouteStop].index;
        // Returning to the configured starting stop completes a run. The
        // arrival still belongs to the previous run; its following departure
        // opens the next one.
        if (departedRouteStop === this.startTargetStop
          && this.arrivalSequence > 0
          && this.arrivalSequence % this.stopCount === 0) {
          this.circuitSequence++;
          this.runSequence++;
        }
        this.targetStop = (this.targetStop + 1) % this.stopCount;
        this.phase = TRAIN_PHASE.departing;
        this.dwellRemaining = 0;
        this.doorFactor = 0;
        this.justDeparted = true;
        this.departureSequence++;
        this.departureEvent = this._event(
          'departure', this.departureSequence, departedStation, departedRouteStop,
          { nextStationIndex: this.stops[this.targetStop].index },
        );
      }
      return this;
    }

    const gap = this.distanceToNext;
    // Highest speed from which the train can still brake to rest by the stop.
    const brakeSpeed = Math.sqrt(2 * this.decel * Math.max(0, gap - this.stopEpsilon));
    const targetSpeed = Math.min(this.cruiseSpeed, brakeSpeed);

    if (this.velocity < targetSpeed) {
      this.velocity = Math.min(targetSpeed, this.velocity + this.accel * dt);
      this.phase = this.velocity < this.cruiseSpeed - 0.05
        ? TRAIN_PHASE.departing : TRAIN_PHASE.cruising;
    } else {
      this.velocity = Math.max(targetSpeed, this.velocity - this.decel * dt);
      this.phase = TRAIN_PHASE.approaching;
    }

    const travel = this.velocity * dt;
    // Arrival is normally the gentle epsilon/speed case. The crossing guard is
    // essential at uneven VR cadences: a long frame can otherwise step from one
    // side of the stop marker to the other, after which the wrapped gap makes
    // the same station appear to be an entire circuit away.
    const reachesPlatform = travel >= gap;
    if ((gap <= this.stopEpsilon && this.velocity <= this.arriveSpeed) || reachesPlatform) {
      this.distance = this.stops[this.targetStop].distance;
      this.velocity = 0;
      this.phase = TRAIN_PHASE.dwelling;
      this.dwellRemaining = this.dwell;
      this.doorFactor = 0;
      this.justArrived = true;
      this.arrivalSequence++;
      this.arrivalEvent = this._event(
        'arrival', this.arrivalSequence, this.stops[this.targetStop].index, this.targetStop,
      );
      return this;
    }

    this.distance = (this.distance + travel) % this.length;
    return this;
  }

  /** Plain JSON schedule state. Geometry and rendering remain outside it. */
  snapshot() {
    return {
      version: TRAIN_SCHEDULE_SNAPSHOT_VERSION,
      serviceId: this.serviceId,
      serviceEpoch: this.serviceEpoch,
      serviceDay: this.serviceDay,
      length: this.length,
      stops: this.stops.map((stop) => ({ ...stop })),
      cruiseSpeed: this.cruiseSpeed,
      accel: this.accel,
      decel: this.decel,
      dwell: this.dwell,
      stopEpsilon: this.stopEpsilon,
      arriveSpeed: this.arriveSpeed,
      targetStop: this.targetStop,
      startTargetStop: this.startTargetStop,
      distance: this.distance,
      velocity: this.velocity,
      phase: this.phase,
      dwellRemaining: this.dwellRemaining,
      doorFactor: this.doorFactor,
      justArrived: this.justArrived,
      justDeparted: this.justDeparted,
      serviceSeconds: this.serviceSeconds,
      arrivalSequence: this.arrivalSequence,
      departureSequence: this.departureSequence,
      circuitSequence: this.circuitSequence,
      runSequence: this.runSequence,
      arrivalEvent: this.arrivalEvent ? { ...this.arrivalEvent } : null,
      departureEvent: this.departureEvent ? { ...this.departureEvent } : null,
    };
  }

  static restore(snapshot) {
    if (!snapshot || snapshot.version !== TRAIN_SCHEDULE_SNAPSHOT_VERSION) {
      throw new Error('Unsupported train schedule snapshot');
    }
    if (!(snapshot.length > 0) || !Array.isArray(snapshot.stops) || snapshot.stops.length < 2) {
      throw new Error('Invalid train schedule snapshot route');
    }
    const model = new TrainScheduleModel(
      snapshot.length,
      snapshot.stops.map((stop) => stop.distance),
      {
        cruiseSpeed: snapshot.cruiseSpeed,
        accel: snapshot.accel,
        decel: snapshot.decel,
        dwell: snapshot.dwell,
        stopEpsilon: snapshot.stopEpsilon,
        arriveSpeed: snapshot.arriveSpeed,
        startIndex: snapshot.startTargetStop,
        serviceId: snapshot.serviceId,
        serviceEpoch: snapshot.serviceEpoch ?? createRailServiceEpoch(
          snapshot.length, snapshot.stops,
        ),
        serviceDay: snapshot.serviceDay ?? 0,
      },
    );
    const stops = snapshot.stops.map((stop, index) => {
      const distance = Number(stop?.distance);
      const planIndex = Number(stop?.index);
      if (!Number.isFinite(distance) || distance < 0 || distance >= model.length
        || !Number.isInteger(planIndex) || planIndex < 0 || planIndex >= snapshot.stops.length) {
        throw new Error(`Invalid train schedule snapshot stop ${index}`);
      }
      return { distance, index: planIndex };
    });
    if (new Set(stops.map((stop) => stop.index)).size !== stops.length
      || stops.some((stop, index) => index > 0 && stop.distance <= stops[index - 1].distance)) {
      throw new Error('Invalid train schedule snapshot stop ordering');
    }
    model.stops = stops;

    model.targetStop = nonNegativeInteger(snapshot.targetStop, 'snapshot targetStop');
    model.startTargetStop = nonNegativeInteger(snapshot.startTargetStop, 'snapshot startTargetStop');
    model.distance = nonNegativeFinite(snapshot.distance, 'snapshot distance');
    model.velocity = nonNegativeFinite(snapshot.velocity, 'snapshot velocity');
    model.dwellRemaining = nonNegativeFinite(snapshot.dwellRemaining, 'snapshot dwellRemaining');
    model.doorFactor = nonNegativeFinite(snapshot.doorFactor, 'snapshot doorFactor');
    model.serviceSeconds = nonNegativeFinite(snapshot.serviceSeconds, 'snapshot serviceSeconds');
    model.arrivalSequence = nonNegativeInteger(snapshot.arrivalSequence, 'snapshot arrivalSequence');
    model.departureSequence = nonNegativeInteger(snapshot.departureSequence, 'snapshot departureSequence');
    model.circuitSequence = nonNegativeInteger(snapshot.circuitSequence, 'snapshot circuitSequence');
    model.runSequence = nonNegativeInteger(snapshot.runSequence, 'snapshot runSequence');
    if (!Object.values(TRAIN_PHASE).includes(snapshot.phase)) {
      throw new Error(`Invalid train schedule phase ${snapshot.phase}`);
    }
    if (model.targetStop < 0 || model.targetStop >= model.stopCount
      || model.startTargetStop < 0 || model.startTargetStop >= model.stopCount) {
      throw new Error('Invalid train schedule stop cursor');
    }
    if (model.distance >= model.length || model.velocity > model.cruiseSpeed + 1e-6
      || model.dwellRemaining > model.dwell || model.doorFactor > 1
      || model.runSequence !== model.circuitSequence) {
      throw new Error('Invalid train schedule snapshot bounds');
    }
    model.phase = snapshot.phase;
    model.justArrived = Boolean(snapshot.justArrived);
    model.justDeparted = Boolean(snapshot.justDeparted);
    const targetDistance = model.stops[model.targetStop].distance;
    if (model.phase === TRAIN_PHASE.dwelling) {
      if (Math.abs(model.distance - targetDistance) > 1e-6 || model.velocity !== 0) {
        throw new Error('Invalid dwelling train schedule snapshot');
      }
    } else if (model.doorFactor !== 0 || model.dwellRemaining !== 0) {
      throw new Error('Invalid moving train schedule snapshot');
    }
    if ((model.justArrived && model.phase !== TRAIN_PHASE.dwelling)
      || (model.justDeparted && model.phase !== TRAIN_PHASE.departing)) {
      throw new Error('Invalid train schedule event phase');
    }
    if (model.justArrived && model.justDeparted) {
      throw new Error('Invalid train schedule simultaneous events');
    }
    model.arrivalEvent = restoreScheduleEvent(snapshot.arrivalEvent, 'arrival', model);
    model.departureEvent = restoreScheduleEvent(snapshot.departureEvent, 'departure', model);
    if (model.justArrived !== Boolean(model.arrivalEvent)
      || model.justDeparted !== Boolean(model.departureEvent)) {
      throw new Error('Invalid train schedule event flags');
    }
    return model;
  }
}

function restoreScheduleEvent(event, type, model) {
  if (event == null) return null;
  const sequenceField = type === 'arrival' ? 'arrivalSequence' : 'departureSequence';
  const routeStopIndex = Number(event.routeStopIndex);
  const stationIndex = Number(event.stationIndex);
  const sequence = Number(event.sequence);
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || event.type !== type
    || event.serviceId !== model.serviceId
    || event.serviceEpoch !== model.serviceEpoch
    || Number(event.serviceDay) !== model.serviceDay
    || event.serviceRunId !== model.serviceRunId
    || Number(event.runSequence) !== model.runSequence
    || Number(event.circuitSequence) !== model.circuitSequence
    || !Number.isInteger(sequence) || sequence !== model[sequenceField]
    || !Number.isInteger(routeStopIndex) || routeStopIndex < 0 || routeStopIndex >= model.stopCount
    || !Number.isInteger(stationIndex) || stationIndex !== model.stops[routeStopIndex].index
    || Number(event.serviceSeconds) !== model.serviceSeconds
    || event.eventId !== `rail-service:${model.serviceRunId}:${type}:${sequence}:stop:${stationIndex}`) {
    throw new Error(`Invalid train schedule ${type} event`);
  }
  if (type === 'departure') {
    const nextStationIndex = Number(event.nextStationIndex);
    if (!Number.isInteger(nextStationIndex)
      || !model.stops.some((stop) => stop.index === nextStationIndex)) {
      throw new Error('Invalid train schedule departure destination');
    }
  }
  return Object.freeze({ ...event });
}

const BIOME_PREFIXES = Object.freeze({
  grassland: ['Meadow', 'Clover', 'Greenfield', 'Harrow', 'Wold', 'Broadmead', 'Kingsley'],
  savanna: ['Dryfield', 'Acacia', 'Goldgrass', 'Sunmarsh', 'Bramble', 'Longwaite'],
  forest: ['Elm', 'Oakhurst', 'Fernden', 'Thornwood', 'Ashcombe', 'Birchley', 'Hollybrook'],
  taiga: ['Pinewick', 'Frostgale', 'Sprucehollow', 'Cedarfell', 'Northreach'],
  tundra: ['Bleakmoor', 'Rimehill', 'Coldbarrow', 'Windfell', 'Snowmere'],
  jungle: ['Palmreach', 'Verdant', 'Vinegate', 'Emerald', 'Canopy'],
  desert: ['Dustmere', 'Sandgate', 'Redrock', 'Mirage', 'Kiln'],
  beach: ['Shell', 'Saltmarsh', 'Dune', 'Cove', 'Pebble'],
  snow: ['Whitefell', 'Glacier', 'Hoarfrost', 'Icemere'],
});
const DEFAULT_PREFIXES = ['Wander', 'Waypoint', 'Farhaven', 'Milemark', 'Wayside'];

const SUFFIXES = ['Halt', 'Crossing', 'Green', 'Hollow', 'Reach', 'Gate', 'End', 'Fields', 'Bank', 'Moor'];
const COAST_SUFFIXES = ['Bay', 'Strand', 'Cove', 'Harbour', 'Point', 'Sands'];
const RIVER_SUFFIXES = ['Ford', 'Bridge', 'Weir', 'Mill', 'Bourne'];
const RELIEF_SUFFIXES = ['Heights', 'Ridge', 'Fell', 'Bluff', 'Summit'];

// Cheap probe: is there open ocean / a wet channel within ~90m of the station?
function nearbyWater(world, x, z) {
  if (!world?.height) return { coast: false, river: false };
  let coast = false, river = false;
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU;
    for (const r of [45, 90]) {
      const sx = x + Math.cos(a) * r, sz = z + Math.sin(a) * r;
      const wet = world.riverAt ? world.riverAt(sx, sz).wet : false;
      if (wet) river = true;
      else if (world.height(sx, sz) < 0.4) coast = true;
    }
  }
  return { coast, river };
}

/**
 * Name each station, deterministically, mutating `.name` and returning the list.
 *
 * A station is named after the place it serves. That is how railways did it,
 * and it is the fix for a platform sign that disagreed with the village behind
 * it: the line reached an existing village, so the village's name is the older
 * one and the station takes it.
 *
 * `placeName(station)` supplies that name. It is passed IN rather than imported
 * so this module stays the dependency-free leaf it is — reaching the settlement
 * layer from here would drag trails, landmarks and the world model into the
 * train service. Without it (no railway terrain yet, or no village at that
 * stop) the fallback below names the station from its own biome and
 * surroundings, which is what every station used to get.
 *
 * A village whose name is already taken falls back too: two stops with the same
 * name on one departure board is a worse problem than the one this solves.
 */
export function nameRegionalStations(plan, {
  world = null, seed = plan?.seed ?? 1, placeName = null,
} = {}) {
  const stations = plan?.stations ?? [];
  const used = new Set();
  const names = [];
  for (const station of stations) {
    const served = placeName ? placeName(station) : null;
    if (served && !used.has(served)) {
      used.add(served);
      station.name = served;
      names.push(served);
      continue;
    }
    const prefixes = BIOME_PREFIXES[station.biome] || DEFAULT_PREFIXES;
    const prefix = pick(prefixes, hash01(seed, station.index, 3));
    const water = nearbyWater(world, station.x, station.z);
    const relief = (station.localRelief ?? 0) > 9;
    let suffixList = SUFFIXES;
    if (water.coast) suffixList = COAST_SUFFIXES;
    else if (water.river) suffixList = RIVER_SUFFIXES;
    else if (relief) suffixList = RELIEF_SUFFIXES;
    let suffix = pick(suffixList, hash01(seed, station.index, 7));
    let name = `${prefix} ${suffix}`;
    let salt = 11;
    while (used.has(name)) {
      suffix = pick(SUFFIXES, hash01(seed, station.index, salt++));
      name = `${prefix} ${suffix}`;
      if (salt > 40) { name = `${prefix} ${suffix} ${station.index + 1}`; break; }
    }
    used.add(name);
    station.name = name;
    names.push(name);
  }
  return names;
}

export const RAILWAY_SERVICE_DEFAULTS = Object.freeze({
  cruiseSpeed: 16,
  accel: 0.7,
  decel: 0.95,
  dwell: 16,
});
