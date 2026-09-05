/**
 * Public, host-authoritative simulation state.
 *
 * The living-world ledger contains private memories, relationships and player
 * holdings. Those fields stay on the host. This module defines the small read
 * model that can cross the peer connection: clock/weather/transport plus the
 * public pose and action state needed to make another browser look at the same
 * world.
 */

export const SHARED_WORLD_SCHEMA_VERSION = 1;
export const SHARED_WORLD_ENTITY_LIMIT = 768;
// A projected entity carries its public appearance as well as its pose. Keep
// the per-visitor list below the snapshot budget even when a region has many
// residents; the closest entities are the ones a player can actually inspect.
export const SHARED_WORLD_PROJECTED_ENTITY_LIMIT = 256;
export const SHARED_WORLD_ANIMAL_LIMIT = 64;
export const SHARED_WORLD_SETTLEMENT_LIMIT = 64;

export function createSharedWorldState({
  worldSeed = 0,
  simTick = 0,
  observedAt = Date.now(),
  generation = {},
  clock = {},
  weather = {},
  rail = {},
  entities = {},
  animals = {},
  settlements = {},
  interactions = {},
} = {}) {
  return normalizeSharedWorldState({
    schemaVersion: SHARED_WORLD_SCHEMA_VERSION,
    worldSeed,
    simTick,
    observedAt,
    generation,
    clock,
    weather,
    rail,
    entities,
    animals,
    settlements,
    interactions,
  });
}

/**
 * Validate and bound a public simulation snapshot before it enters the
 * authority. Network data is treated as untrusted even when it came from the
 * host's own renderer: a malformed or unexpectedly large value must degrade
 * to a rejected update rather than poison a guest replica.
 */
export function normalizeSharedWorldState(value, {
  worldSeed = value?.worldSeed ?? 0,
  simTick = value?.simTick ?? 0,
  observedAt = value?.observedAt ?? Date.now(),
} = {}) {
  const source = isRecord(value) ? value : {};
  const normalized = {
    schemaVersion: SHARED_WORLD_SCHEMA_VERSION,
    worldSeed: finiteInt(source.worldSeed, worldSeed),
    simTick: finiteInt(source.simTick, simTick),
    observedAt: finiteNumber(source.observedAt, observedAt),
    generation: normalizeGeneration(source.generation),
    clock: normalizeClock(source.clock),
    weather: normalizeRecord(source.weather, 8 * 1024),
    rail: normalizeRail(source.rail),
    entities: boundedRecord(source.entities, SHARED_WORLD_ENTITY_LIMIT, normalizeEntity),
    animals: boundedRecord(source.animals, SHARED_WORLD_ANIMAL_LIMIT, normalizeAnimal),
    settlements: boundedRecord(source.settlements, SHARED_WORLD_SETTLEMENT_LIMIT, normalizeSettlement),
    interactions: normalizeInteractions(source.interactions),
  };
  return normalized;
}

export function sharedWorldEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeClock(value) {
  const source = isRecord(value) ? value : {};
  return {
    dayIndex: Math.max(0, finiteInt(source.dayIndex, 0)),
    time: wrap01(source.time),
    worldHours: Math.max(0, finiteNumber(source.worldHours, 0)),
    activeSeconds: Math.max(0, finiteNumber(source.activeSeconds, 0)),
    rate: Math.max(0, Math.min(8, finiteNumber(source.rate, 1))),
    paused: !!source.paused,
  };
}

function normalizeEntity(value) {
  if (!isRecord(value) || !value.id) return null;
  const pose = normalizePose(value.pose || value.position || value);
  const identity = isRecord(value.identity) ? {
    seed: finiteInt(value.identity.seed, 0),
    name: text(value.identity.name || value.name, 80),
    role: text(value.identity.role || value.role, 80),
    family: text(value.identity.family, 40),
    activity: text(value.identity.activity, 40),
    stationId: value.identity.stationId ? text(value.identity.stationId, 120) : null,
    stationName: text(value.identity.stationName, 120),
    age: text(value.identity.age, 24),
    presentation: finiteNumber(value.identity.presentation, 0.5),
    accessory: text(value.identity.accessory, 40),
    palette: cloneValue(value.identity.palette || null),
    proportions: cloneValue(value.identity.proportions || null),
    posture: cloneValue(value.identity.posture || null),
    appearance: cloneValue(value.identity.appearance || null),
    animation: cloneValue(value.identity.animation || null),
    wardrobe: cloneValue(value.identity.wardrobe || null),
  } : null;
  return {
    id: text(value.id, 120),
    kind: text(value.kind || 'npc', 40),
    name: text(value.name || identity?.name, 80),
    role: text(value.role || identity?.role, 80),
    stationId: value.stationId ? text(value.stationId, 120) : null,
    settlementId: value.settlementId ? text(value.settlementId, 120) : null,
    pose,
    state: text(value.state, 40),
    action: text(value.action, 80),
    moving: !!value.moving,
    roaming: !!value.roaming,
    identity,
    publicState: cloneValue(value.publicState || null),
  };
}

function normalizeAnimal(value) {
  if (!isRecord(value) || !value.id) return null;
  const pose = normalizePose(value.pose || value.position || value);
  return {
    id: text(value.id, 120),
    species: text(value.species || 'animal', 40),
    pose,
    state: text(value.state, 40),
    speed: Math.max(0, Math.min(100, finiteNumber(value.speed, 0))),
    alertness: Math.max(0, Math.min(1, finiteNumber(value.alertness, 0))),
    groupId: value.groupId ? text(value.groupId, 120) : null,
    member: Math.max(0, finiteInt(value.member, 0)),
    phenotype: cloneValue(value.phenotype || null),
    publicState: cloneValue(value.publicState || null),
  };
}

function normalizeSettlement(value) {
  if (!isRecord(value) || !value.id) return null;
  return {
    id: text(value.id, 120),
    kind: text(value.kind, 40),
    x: finiteNumber(value.x, 0),
    y: finiteNumber(value.y, 0),
    z: finiteNumber(value.z, 0),
    radius: Math.max(0, finiteNumber(value.radius, 0)),
    yaw: finiteNumber(value.yaw, 0),
    generationVersion: Math.max(0, finiteInt(value.generationVersion, 0)),
    planHash: text(value.planHash, 120),
    residents: boundedRecord(value.residents, 128, normalizeResidentPose),
    publicState: cloneValue(value.publicState || null),
  };
}

function normalizeResidentPose(value) {
  if (!isRecord(value)) return null;
  return {
    pose: normalizePose(value.pose || value.position || value),
    moving: !!value.moving,
    state: text(value.state, 40),
    action: text(value.action, 80),
  };
}

function normalizePose(value) {
  const source = isRecord(value) ? value : {};
  return {
    x: finiteNumber(source.x, 0),
    y: finiteNumber(source.y, 0),
    z: finiteNumber(source.z, 0),
    yaw: finiteNumber(source.yaw ?? source.heading, 0),
    pitch: finiteNumber(source.pitch, 0),
  };
}

function boundedRecord(value, limit, mapper) {
  const source = isRecord(value) ? value : {};
  const result = {};
  for (const [id, raw] of Object.entries(source)
    .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)) {
    const normalized = mapper(raw);
    if (normalized) result[text(normalized.id || id, 120)] = normalized;
  }
  return result;
}

function normalizeRecord(value, maxBytes = 32 * 1024) {
  if (!isRecord(value)) return {};
  const cloned = cloneValue(value, maxBytes);
  return isRecord(cloned) ? cloned : {};
}

function normalizeRail(value) {
  const source = isRecord(value) ? value : {};
  const normalized = {};
  if (source.schedule) normalized.schedule = cloneValue(source.schedule, 24 * 1024);
  if (source.dutyRosters) {
    normalized.dutyRosters = boundedRecord(source.dutyRosters, 64, normalizePublicValue);
  }
  return normalized;
}

function normalizeInteractions(value) {
  const source = isRecord(value) ? value : {};
  const normalized = {};
  for (const key of Object.keys(source).sort().slice(0, 16)) {
    const branch = source[key];
    if (['portals', 'settlementDeltas', 'evolution'].includes(key) && isRecord(branch)) {
      normalized[key] = boundedRecord(branch, 512, normalizePublicValue);
    } else {
      const entry = normalizePublicValue(branch);
      if (entry !== null) normalized[key] = entry;
    }
  }
  return normalized;
}

function normalizeGeneration(value) {
  const source = isRecord(value) ? value : {};
  return Object.fromEntries(Object.entries(source)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 16)
    .map(([key, entry]) => [text(key, 40), typeof entry === 'boolean' ? entry : finiteInt(entry, 0)]));
}

function normalizePublicValue(value) {
  return cloneValue(value, 8 * 1024);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback) || 0;
}

function finiteInt(value, fallback = 0) {
  return Math.trunc(finiteNumber(value, fallback));
}

function wrap01(value) {
  const number = finiteNumber(value, 0);
  return ((number % 1) + 1) % 1;
}

function text(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value, maxBytes = 8 * 1024) {
  if (value == null) return value;
  try {
    const cloned = structuredClone(value);
    return JSON.stringify(cloned).length <= maxBytes ? cloned : null;
  } catch {
    try {
      const cloned = JSON.parse(JSON.stringify(value));
      return JSON.stringify(cloned).length <= maxBytes ? cloned : null;
    } catch {
      return null;
    }
  }
}
