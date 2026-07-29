// Pure, THREE-free passenger-service logic for the regional railway: the train
// stopping/dwell state machine and procedural station naming. Keeping this out
// of the renderer lets the schedule math and names run in Node tests, and lets
// a worker drive the timetable later without a graphics context.

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
  } = {}) {
    if (!(routeLength > 0) || !stopDistances || stopDistances.length < 2) {
      throw new Error('TrainScheduleModel needs a positive length and at least two stops');
    }
    this.length = routeLength;
    // Store stops with their original plan index so the HUD can map back to the
    // named stations even though the train visits them in route order.
    this.stops = stopDistances
      .map((distance, index) => ({ distance: ((distance % routeLength) + routeLength) % routeLength, index }))
      .sort((a, b) => a.distance - b.distance);
    this.stopCount = this.stops.length;
    this.cruiseSpeed = cruiseSpeed;
    this.accel = accel;
    this.decel = decel;
    this.dwell = dwell;
    this.stopEpsilon = stopEpsilon;
    this.arriveSpeed = arriveSpeed;
    this.reset(startIndex);
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
    if (!(dt > 0)) return this;

    if (this.phase === TRAIN_PHASE.dwelling) {
      this.velocity = 0;
      this.dwellRemaining -= dt;
      // Doors ease open over the first ~2s and shut over the last ~2s of dwell.
      const openTime = this.dwell - this.dwellRemaining;
      const closing = this.dwellRemaining;
      this.doorFactor = clamp(Math.min(openTime / 2, closing / 2), 0, 1);
      if (this.dwellRemaining <= 0) {
        this.targetStop = (this.targetStop + 1) % this.stopCount;
        this.phase = TRAIN_PHASE.departing;
        this.doorFactor = 0;
        this.justDeparted = true;
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
      return this;
    }

    this.distance = (this.distance + travel) % this.length;
    return this;
  }
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
 * Name each station from its biome and immediate surroundings, deterministically
 * from the plan seed. Coastal and riverside sites take water-themed suffixes;
 * high-relief sites take upland ones. Mutates each station with a `.name` and
 * returns the array of names. Duplicate names are nudged to a fallback suffix.
 */
export function nameRegionalStations(plan, { world = null, seed = plan?.seed ?? 1 } = {}) {
  const stations = plan?.stations ?? [];
  const used = new Set();
  const names = [];
  for (const station of stations) {
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
