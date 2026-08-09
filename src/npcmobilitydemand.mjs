// Deterministic population targets for NPC mobility.
//
// This module does not spawn people or move them. It gives the itinerary
// scheduler a quiet, reproducible demand signal and selects only from the real
// people the caller says are eligible. A shortage therefore stays a shortage;
// presentation code must never invent a nearby traveller to fill a quota.

export const STATION_DAYTIME_HOURS = Object.freeze({ start: 7, end: 20 });
export const STATION_DAYTIME_TARGET = Object.freeze({ min: 2, max: 4 });
export const STATION_NIGHT_TARGET = Object.freeze({ min: 0, max: 1 });
export const CARRIAGE_NPC_TARGET = Object.freeze({ min: 1, max: 3 });

/** Target number of non-player people in one station activity area. */
export function stationPopulationTarget({
  worldSeed = 1,
  stationId,
  dayIndex = 0,
  hour = 12,
} = {}) {
  const station = requiredId(stationId, 'stationId');
  const day = nonNegativeInteger(dayIndex, 'dayIndex');
  const normalizedHour = wrappedHour(hour);
  const daytime = normalizedHour >= STATION_DAYTIME_HOURS.start
    && normalizedHour < STATION_DAYTIME_HOURS.end;
  const range = daytime ? STATION_DAYTIME_TARGET : STATION_NIGHT_TARGET;
  const bucket = Math.floor(normalizedHour * 2); // targets change at most twice per hour
  return {
    stationId: station,
    dayIndex: day,
    hourBucket: bucket,
    daytime,
    target: integerInRange(range, hash32(`${finiteSeed(worldSeed)}|${station}|${day}|${bucket}`)),
  };
}

/** Target ordinary NPC occupancy for one passenger carriage on a service run. */
export function carriagePassengerTarget({
  worldSeed = 1,
  runId,
  carriageIndex,
} = {}) {
  const run = requiredId(runId, 'runId');
  const carriage = nonNegativeInteger(carriageIndex, 'carriageIndex');
  return integerInRange(
    CARRIAGE_NPC_TARGET,
    hash32(`${finiteSeed(worldSeed)}|${run}|carriage|${carriage}`),
  );
}

/**
 * Choose existing eligible people for a future station activity window.
 *
 * Candidates may be IDs or records containing `personId`/`id`. Disabled,
 * tombstoned, already committed, or explicitly excluded people are ignored.
 * Selection is stable regardless of the caller's input order.
 */
export function selectMobilityCandidates(candidates, target, {
  worldSeed = 1,
  demandKey,
  excludedIds = [],
} = {}) {
  const count = nonNegativeInteger(target, 'target');
  const key = requiredId(demandKey, 'demandKey');
  const excluded = new Set((excludedIds || []).map(candidateId).filter(Boolean));
  const unique = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const personId = candidateId(candidate);
    if (!personId || excluded.has(personId)) continue;
    if (candidate && typeof candidate === 'object') {
      if (candidate.eligible === false || candidate.tombstone || candidate.committed) continue;
    }
    const prior = unique.get(personId);
    if (prior === undefined || candidateSignature(candidate) < candidateSignature(prior)) {
      unique.set(personId, candidate);
    }
  }
  return [...unique.entries()]
    .map(([personId, candidate]) => ({
      personId,
      candidate,
      rank: hash32(`${finiteSeed(worldSeed)}|${key}|${personId}`),
    }))
    .sort((a, b) => a.rank - b.rank || a.personId.localeCompare(b.personId))
    .slice(0, count)
    .map(({ candidate }) => candidate);
}

function candidateId(candidate) {
  const value = typeof candidate === 'string'
    ? candidate
    : candidate?.personId ?? candidate?.id;
  return typeof value === 'string' && value.trim() === value && value.length ? value : null;
}

function candidateSignature(candidate) {
  if (typeof candidate === 'string') return `0:${candidate}`;
  return `1:${stableJson(candidate)}`;
}

function stableJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function integerInRange(range, hash) {
  const span = range.max - range.min + 1;
  return range.min + (hash % span);
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return number;
}

function wrappedHour(value) {
  const hour = Number(value);
  if (!Number.isFinite(hour)) throw new TypeError('hour must be finite.');
  return ((hour % 24) + 24) % 24;
}

function finiteSeed(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number >>> 0 : 1;
}

function hash32(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  return hash >>> 0;
}
