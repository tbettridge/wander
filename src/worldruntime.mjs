/**
 * Replaceable region-runtime boundary.
 *
 * The renderer keeps one app shell, camera, and worker pool while reseeding the
 * active systems in place. This contract keeps that swap explicit: the app
 * shell owns the peer link and camera while a seed-bound region can be
 * suspended, disposed, and replaced. A home seed is assigned once in
 * localStorage; handoffs contain a destination seed only after host approval
 * and are scoped to sessionStorage rather than the public departures board.
 */

export const REGION_RUNTIME_SCHEMA_VERSION = 1;
export const REGION_HANDOFF_STORAGE_KEY = 'wander.multiplayer.pendingHandoff.v1';
export const HOME_WORLD_SEED_SCHEMA_VERSION = 1;
export const HOME_WORLD_SEED_STORAGE_KEY = `wander.homeWorld.seed.v${HOME_WORLD_SEED_SCHEMA_VERSION}`;
export const DEFAULT_WORLD_SEED = 20260612;

function asStorage(storage) {
  if (storage && typeof storage.getItem === 'function') return storage;
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* private browsing or a blocked storage area */ }
  return null;
}

/**
 * Keep seeds in the same unsigned 32-bit domain used by the noise generator.
 * `null` means that a caller supplied a value that cannot be a world seed.
 */
export function normalizeWorldSeed(value) {
  if (value === null || value === undefined || value === '') return null;
  let numeric;
  try { numeric = Number(value); } catch { return null; }
  if (!Number.isFinite(numeric)) return null;
  return Math.trunc(numeric) >>> 0;
}

function optionalCoordinate(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Generate a seed without making an account or contacting a server. Browsers
 * normally provide crypto randomness; the clock/math fallback keeps private
 * browsing and embedded WebViews playable when crypto is unavailable.
 */
export function randomWorldSeed({
  randomValues = globalThis.crypto?.getRandomValues,
  random = Math.random,
  clock = Date.now,
} = {}) {
  try {
    if (typeof randomValues === 'function') {
      const values = new Uint32Array(1);
      const result = randomValues.call(globalThis.crypto, values) || values;
      const candidate = normalizeWorldSeed(result[0]);
      if (candidate !== null && candidate !== 0) return candidate;
    }
  } catch { /* use the local fallback below */ }

  let entropy = 0;
  try {
    const sample = Number(random());
    entropy = Number.isFinite(sample) ? Math.floor(Math.abs(sample) * 0x100000000) : 0;
  } catch { /* leave the entropy term at zero */ }
  const time = normalizeWorldSeed(typeof clock === 'function' ? clock() : Date.now()) || 0;
  const candidate = (entropy ^ time ^ ((time / 0x100000000) | 0)) >>> 0;
  // Zero is valid to the noise functions, but reserving it avoids treating a
  // missing seed like an intentionally assigned home world in diagnostics.
  return candidate || 1;
}

export function loadHomeWorldSeed({
  storage,
  storageKey = HOME_WORLD_SEED_STORAGE_KEY,
} = {}) {
  const store = asStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(storageKey);
    if (raw == null || raw === '') return null;
    let value = raw;
    try { value = JSON.parse(raw); } catch { /* accept the early numeric format */ }
    const seed = normalizeWorldSeed(value?.seed ?? value);
    return seed === null ? null : seed;
  } catch {
    return null;
  }
}

export function saveHomeWorldSeed(seed, {
  storage,
  storageKey = HOME_WORLD_SEED_STORAGE_KEY,
} = {}) {
  const normalized = normalizeWorldSeed(seed);
  if (normalized === null) return null;
  const store = asStorage(storage);
  try {
    store?.setItem(storageKey, JSON.stringify({
      schemaVersion: HOME_WORLD_SEED_SCHEMA_VERSION,
      seed: normalized,
      assignedAt: Date.now(),
    }));
  } catch { /* storage is optional */ }
  return normalized;
}

/** Return the persistent home seed, assigning it exactly once per browser. */
export function persistentHomeWorldSeed({
  storage,
  storageKey = HOME_WORLD_SEED_STORAGE_KEY,
  randomValues,
  random,
  clock,
  fallbackSeed = DEFAULT_WORLD_SEED,
} = {}) {
  const saved = loadHomeWorldSeed({ storage, storageKey });
  if (saved !== null) return saved;
  const generated = randomWorldSeed({ randomValues, random, clock });
  const seed = generated === null ? normalizeWorldSeed(fallbackSeed) : generated;
  return saveHomeWorldSeed(seed === null ? DEFAULT_WORLD_SEED : seed, { storage, storageKey });
}

export function startupSeed({
  location = globalThis.location,
  storage,
  storageKey = HOME_WORLD_SEED_STORAGE_KEY,
  fallbackSeed = DEFAULT_WORLD_SEED,
  randomValues,
  random,
  clock,
} = {}) {
  const search = typeof location?.search === 'string' ? new URLSearchParams(location.search) : null;
  const rawSeed = search?.get('wanderSeed');
  const parsed = rawSeed == null || rawSeed.trim() === '' ? NaN : Number(rawSeed);
  // A URL seed is an explicit, temporary override for debugging/replays. It
  // must not replace the player's persistent home world in local storage.
  if (Number.isFinite(parsed)) return normalizeWorldSeed(parsed);
  return persistentHomeWorldSeed({
    storage, storageKey, randomValues, random, clock, fallbackSeed,
  });
}

export function createRegionHandoff({
  sourceRegionId,
  destinationRegionId,
  destinationSeed,
  destinationName,
  ticketId,
  returnHomeOnly = true,
  arrivalStationId = null,
  arrivalStationName = null,
  arrivalStationX = null,
  arrivalStationY = null,
  arrivalStationZ = null,
  issuedAt = Date.now(),
} = {}) {
  if (!sourceRegionId || !destinationRegionId || !ticketId || !Number.isFinite(Number(destinationSeed))) {
    throw new Error('A region handoff needs two regions, a ticket, and a numeric destination seed');
  }
  return {
    schemaVersion: REGION_RUNTIME_SCHEMA_VERSION,
    sourceRegionId: String(sourceRegionId),
    destinationRegionId: String(destinationRegionId),
    destinationSeed: Number(destinationSeed),
    destinationName: String(destinationName || 'Destination region').slice(0, 64),
    arrivalStationId: arrivalStationId ? String(arrivalStationId) : null,
    arrivalStationName: arrivalStationName ? String(arrivalStationName).slice(0, 96) : null,
    arrivalStationX: optionalCoordinate(arrivalStationX),
    arrivalStationY: optionalCoordinate(arrivalStationY),
    arrivalStationZ: optionalCoordinate(arrivalStationZ),
    ticketId: String(ticketId),
    returnHomeOnly: returnHomeOnly !== false,
    issuedAt,
  };
}

export function saveRegionHandoff(handoff, storage = globalThis.sessionStorage) {
  const value = normalizeRegionHandoff(handoff);
  try { storage?.setItem(REGION_HANDOFF_STORAGE_KEY, JSON.stringify(value)); } catch { /* private browsing */ }
  return value;
}

export function loadRegionHandoff(storage = globalThis.sessionStorage) {
  try {
    const raw = storage?.getItem(REGION_HANDOFF_STORAGE_KEY);
    return raw ? normalizeRegionHandoff(JSON.parse(raw)) : null;
  } catch { return null; }
}

export function consumeRegionHandoff(storage = globalThis.sessionStorage) {
  const value = loadRegionHandoff(storage);
  try { storage?.removeItem(REGION_HANDOFF_STORAGE_KEY); } catch { /* optional */ }
  return value;
}

export function normalizeRegionHandoff(value) {
  if (!value || value.schemaVersion !== REGION_RUNTIME_SCHEMA_VERSION
      || !value.sourceRegionId || !value.destinationRegionId || !value.ticketId
      || !Number.isFinite(Number(value.destinationSeed))) return null;
  return {
    schemaVersion: REGION_RUNTIME_SCHEMA_VERSION,
    sourceRegionId: String(value.sourceRegionId),
    destinationRegionId: String(value.destinationRegionId),
    destinationSeed: Number(value.destinationSeed),
    destinationName: String(value.destinationName || 'Destination region').slice(0, 64),
    arrivalStationId: value.arrivalStationId ? String(value.arrivalStationId) : null,
    arrivalStationName: value.arrivalStationName ? String(value.arrivalStationName).slice(0, 96) : null,
    arrivalStationX: optionalCoordinate(value.arrivalStationX),
    arrivalStationY: optionalCoordinate(value.arrivalStationY),
    arrivalStationZ: optionalCoordinate(value.arrivalStationZ),
    ticketId: String(value.ticketId),
    returnHomeOnly: value.returnHomeOnly !== false,
    issuedAt: Number.isFinite(value.issuedAt) ? value.issuedAt : Date.now(),
  };
}

export class RegionRuntimeBoundary {
  constructor({ regionId, seed, homeRegionId = regionId, homeSeed = seed } = {}) {
    this.current = { regionId: regionId || null, seed: Number(seed) || 0 };
    this.home = { regionId: homeRegionId || regionId || null, seed: Number(homeSeed) || Number(seed) || 0 };
    this.phase = 'active';
    this.pending = null;
  }

  beginTransition(handoff) {
    const value = normalizeRegionHandoff(handoff);
    if (!value || value.sourceRegionId !== this.current.regionId) throw new Error('Handoff does not originate in the active region');
    this.pending = value;
    this.phase = 'transition';
    return value;
  }

  arrive() {
    if (!this.pending) throw new Error('No region handoff is pending');
    this.current = { regionId: this.pending.destinationRegionId, seed: this.pending.destinationSeed };
    this.pending = null;
    this.phase = 'active';
    return this.current;
  }

  requestHome() {
    if (this.current.regionId === this.home.regionId) return null;
    this.phase = 'returning';
    return {
      sourceRegionId: this.current.regionId,
      destinationRegionId: this.home.regionId,
      destinationSeed: this.home.seed,
      returnHomeOnly: true,
    };
  }

  suspend() { this.phase = 'suspended'; }
  dispose() { this.phase = 'disposed'; this.pending = null; }

  get diagnostics() {
    return { current: this.current, home: this.home, phase: this.phase, pending: this.pending };
  }
}
