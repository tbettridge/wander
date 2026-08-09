import {
  createLivingWorldClock,
  normalizeLivingWorldClock,
} from './livingworldclock.mjs';

export const LIVING_WORLD_STATE_VERSION = 4;
export const LIVING_WORLD_EVENT_LIMIT = 224;
export const LIVING_WORLD_RESOLVED_COMMITMENTS_PER_NPC = 12;
export const LIVING_WORLD_RUMOR_LOG_LIMIT = 8;

export const DEFAULT_LIVING_WORLD_FEATURES = Object.freeze({
  commitmentsEnabled: true,
  consequencesEnabled: true,
  socialMemoryEnabled: true,
  rumorExchangeEnabled: true,
  intentPropsEnabled: true,
  npcInitiationEnabled: true,
  travelGroupsEnabled: true,
  situatedActionsEnabled: true,
  settlementsEnabled: true,
  familyFrontageEnabled: true,
  managedVegetationEnabled: true,
  enterableBuildingsEnabled: true,
  householdsEnabled: true,
  workRoutinesEnabled: true,
  largeSettlementsEnabled: true,
  settlementEvolutionEnabled: true,
});

const DEFAULT_PREFIX = 'wander.livingWorld.state.v1.';

export function createLivingWorldState({ worldSeed = 1 } = {}) {
  return {
    version: LIVING_WORLD_STATE_VERSION,
    worldSeed: Number(worldSeed) || 1,
    revision: 0,
    clock: createLivingWorldClock(),
    entities: {},
    commitments: {},
    commitmentSequences: {},
    projections: {
      letters: {},
      stationInventory: {},
      meetings: {},
      repairJobs: {},
      assets: {},
      items: {},
      interactionOutcomes: {},
      playerHoldings: {},
    },
    interactions: {},
    interactionSequences: {},
    interactionCooldowns: {},
    groups: {},
    groupSequences: {},
    actions: {},
    actionSequences: {},
    actionCooldowns: {},
    actionAnchors: {},
    relationships: {},
    memories: {},
    conversationSequences: {},
    rumorExchanges: {},
    rumorCooldowns: {},
    rumorLog: [],
    settlementDeltas: {},
    portals: {},
    households: {},
    workplaces: {},
    routines: {},
    occupancy: {},
    settlementEvolution: {},
    effectReceipts: {},
    events: [],
    features: { ...DEFAULT_LIVING_WORLD_FEATURES },
    metrics: {
      effectDedupes: 0,
      memoryEvictions: 0,
      rumorExchanges: 0,
      rumorTransfers: 0,
      saveFailures: 0,
      snapshotBytes: 0,
      simulationMs: 0,
      simulationSamples: 0,
      initiatedOffers: 0,
      acceptedOffers: 0,
      declinedOffers: 0,
      groupsFormed: 0,
      situatedActions: 0,
      activityInterruptions: 0,
      settlementsGenerated: 0,
      portalsCrossed: 0,
      routineOutcomes: 0,
      orphanedSettlementRefs: 0,
      settlementSimulationMs: 0,
      settlementSimulationSamples: 0,
      settlementEvolutionEvents: 0,
    },
  };
}

export function normalizeLivingWorldState(value, { worldSeed = value?.worldSeed ?? 1 } = {}) {
  value = expandStoredState(value);
  const state = createLivingWorldState({ worldSeed });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return state;
  state.revision = finiteInteger(value.revision);
  state.clock = normalizeLivingWorldClock(value.clock);
  for (const key of [
    'entities', 'commitments', 'commitmentSequences', 'relationships',
    'memories', 'effectReceipts', 'conversationSequences', 'rumorExchanges',
    'rumorCooldowns', 'interactions', 'interactionSequences', 'interactionCooldowns',
    'groups', 'groupSequences', 'actions', 'actionSequences', 'actionCooldowns',
    'actionAnchors',
    'settlementDeltas', 'portals', 'households', 'workplaces', 'routines',
    'occupancy', 'settlementEvolution',
  ]) {
    state[key] = plainRecord(value[key]);
  }
  const projections = plainRecord(value.projections);
  for (const key of Object.keys(state.projections)) {
    state.projections[key] = plainRecord(projections[key]);
  }
  state.events = Array.isArray(value.events)
    ? clonePlain(value.events.slice(-LIVING_WORLD_EVENT_LIMIT))
    : [];
  state.rumorLog = Array.isArray(value.rumorLog)
    ? clonePlain(value.rumorLog.slice(-LIVING_WORLD_RUMOR_LOG_LIMIT))
    : [];
  state.features = normalizeLivingWorldFeatures(value.features);
  state.metrics = {
    ...state.metrics,
    ...Object.fromEntries(Object.entries(plainRecord(value.metrics))
      .map(([key, count]) => [key, finiteNumber(count)])),
  };
  migrateStateV3(state, value);
  migrateStateV4(state, value);
  return state;
}

/** Compact only the persisted representation; runtime state stays readable. */
export function serializeLivingWorldState(value) {
  const state = normalizeLivingWorldState(value);
  const compact = compactStoredState(state);
  let serialized = JSON.stringify(compact);
  compact.metrics.snapshotBytes = new TextEncoder().encode(serialized).length;
  serialized = JSON.stringify(compact);
  return serialized;
}

export function parseLivingWorldState(serialized, { worldSeed = 1 } = {}) {
  return normalizeLivingWorldState(JSON.parse(serialized), { worldSeed });
}

export function normalizeLivingWorldFeatures(value = {}) {
  const features = Object.fromEntries(Object.entries(DEFAULT_LIVING_WORLD_FEATURES)
    .map(([key, defaultValue]) => [key, value?.[key] == null ? defaultValue : !!value[key]]));
  if (!features.commitmentsEnabled) features.consequencesEnabled = false;
  if (!features.socialMemoryEnabled) features.rumorExchangeEnabled = false;
  if (!features.settlementsEnabled) {
    features.familyFrontageEnabled = false;
    features.managedVegetationEnabled = false;
    features.enterableBuildingsEnabled = false;
    features.householdsEnabled = false;
    features.workRoutinesEnabled = false;
    features.largeSettlementsEnabled = false;
    features.settlementEvolutionEnabled = false;
  }
  if (!features.householdsEnabled) features.workRoutinesEnabled = false;
  return features;
}

function migrateStateV3(state, source) {
  if (Number(source?.version) >= 3) return;
  for (const [letterId, letter] of Object.entries(state.projections.letters || {})) {
    const id = letter.itemId || `item:${letterId}`;
    state.projections.items[id] ||= {
      id, kind: 'letter', ownerId: letter.ownerId || letter.carrierId || null,
      purpose: 'delivery', relatedCommitmentId: letter.commitmentId || null,
      condition: letter.status === 'delivered' ? 'delivered' : 'sealed',
      legacyLetterId: letterId,
    };
    letter.itemId = id;
  }
  state.version = LIVING_WORLD_STATE_VERSION;
}

function migrateStateV4(state, source) {
  if (Number(source?.version) >= 4) return;
  state.version = LIVING_WORLD_STATE_VERSION;
}

/** Change consumers without deleting their persisted state, enabling instant rollback. */
export function setLivingWorldFeatures(state, changes = {}) {
  state.features = normalizeLivingWorldFeatures({ ...state.features, ...changes });
  state.revision++;
  return state.features;
}

export function registerLivingWorldEntity(state, entity) {
  if (!entity?.id) throw new TypeError('A stable entity ID is required.');
  const before = state.entities[entity.id];
  state.entities[entity.id] = {
    ...(before || {}),
    ...clonePlain(entity),
    id: String(entity.id),
    tombstone: false,
  };
  if (JSON.stringify(before) !== JSON.stringify(state.entities[entity.id])) state.revision++;
  return state.entities[entity.id];
}

export function tombstoneLivingWorldEntity(state, entityId, reason = 'removed') {
  const id = String(entityId || '');
  if (!id) return null;
  const entity = state.entities[id] || { id };
  state.entities[id] = { ...entity, tombstone: true, tombstoneReason: String(reason) };
  state.revision++;
  return state.entities[id];
}

/**
 * Atomically reduce one stable event into plain living-world state.
 *
 * The reducer runs against a clone. If it throws, the caller's state remains
 * untouched. The receipt and resulting projections land in the same snapshot,
 * which is what makes a repeated arrival harmless after a reload.
 */
export function applyLivingWorldEventOnce(state, event, reducer) {
  if (!event?.id || !event?.type) throw new TypeError('Events require stable id and type fields.');
  const id = String(event.id);
  const receipt = state.effectReceipts[id];
  if (receipt) {
    state.metrics ||= {};
    state.metrics.effectDedupes = finiteInteger(state.metrics.effectDedupes) + 1;
    return { applied: false, duplicate: true, result: clonePlain(receipt.result) };
  }
  if (typeof reducer !== 'function') throw new TypeError('An event reducer is required.');

  const draft = clonePlain(state);
  const safeEvent = clonePlain(event);
  const result = reducer(draft, safeEvent);
  draft.revision = finiteInteger(state.revision) + 1;
  draft.effectReceipts[id] = {
    eventId: id,
    revision: draft.revision,
    result: clonePlain(result ?? null),
  };
  draft.events.push({ ...safeEvent, revision: draft.revision });
  if (draft.events.length > LIVING_WORLD_EVENT_LIMIT) {
    draft.events.splice(0, draft.events.length - LIVING_WORLD_EVENT_LIMIT);
  }
  replacePlainState(state, draft);
  return { applied: true, duplicate: false, result: clonePlain(result ?? null) };
}

export function pruneResolvedCommitments(state, limit = LIVING_WORLD_RESOLVED_COMMITMENTS_PER_NPC) {
  const byActor = new Map();
  for (const commitment of Object.values(state.commitments)) {
    if (commitment?.state !== 'resolved') continue;
    const list = byActor.get(commitment.actorId) || [];
    list.push(commitment);
    byActor.set(commitment.actorId, list);
  }
  for (const list of byActor.values()) {
    list.sort((a, b) => (b.outcome?.atHour ?? 0) - (a.outcome?.atHour ?? 0)
      || String(b.id).localeCompare(String(a.id)));
    for (const commitment of list.slice(Math.max(0, limit))) {
      for (const eventId of commitment.outcome?.effectEventIds || []) {
        delete state.effectReceipts[eventId];
      }
      delete state.commitments[commitment.id];
    }
  }
}

export class LivingWorldStateStore {
  constructor({
    worldSeed = 1,
    storage = typeof localStorage === 'undefined' ? null : localStorage,
    prefix = DEFAULT_PREFIX,
  } = {}) {
    this.worldSeed = Number(worldSeed) || 1;
    this.storage = storage;
    this.prefix = prefix;
    this.lastError = null;
  }

  key() {
    return `${this.prefix}${this.worldSeed}`;
  }

  load() {
    if (!this.storage) return createLivingWorldState({ worldSeed: this.worldSeed });
    try {
      const raw = this.storage.getItem(this.key());
      return raw
        ? parseLivingWorldState(raw, { worldSeed: this.worldSeed })
        : createLivingWorldState({ worldSeed: this.worldSeed });
    } catch (error) {
      this.lastError = error;
      return createLivingWorldState({ worldSeed: this.worldSeed });
    }
  }

  save(state) {
    try {
      const finalSerialized = serializeLivingWorldState(state);
      state.metrics ||= {};
      state.metrics.snapshotBytes = new TextEncoder().encode(finalSerialized).length;
      this.storage?.setItem(this.key(), finalSerialized);
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = error;
      state.metrics ||= {};
      state.metrics.saveFailures = finiteInteger(state.metrics.saveFailures) + 1;
      return false;
    }
  }
}

function compactStoredState(state) {
  const memories = Object.fromEntries(Object.entries(state.memories).map(([ownerId, list]) => [
    ownerId,
    (Array.isArray(list) ? list : []).map((memory) => [
      memory.id, memory.subject?.kind, memory.subject?.id, memory.predicate, memory.object,
      memory.summary, memory.source?.kind, memory.source?.id,
      (memory.sourceChain || []).map((ref) => [ref.kind, ref.id]),
      memory.provenance, memory.originEventId, memory.lineageId, memory.confidence,
      memory.salience, memory.privacy, memory.hopCount, memory.createdAtHour,
      memory.lastRecalledHour, memory.expiresAtHour,
    ]),
  ]));
  const relationships = Object.fromEntries(Object.entries(state.relationships).map(([key, edge]) => [
    key,
    [edge.ownerId, edge.subjectId, edge.familiarity, edge.affinity, edge.trust,
      edge.obligation, edge.tags, edge.lastInteractionHour, edge.lastEventId],
  ]));
  const commitments = Object.fromEntries(Object.entries(state.commitments).map(([key, entry]) => [key, [
    entry.version, entry.id, entry.actorId, entry.kind, entry.target?.kind, entry.target?.id,
    entry.destination?.kind, entry.destination?.key, entry.createdAtHour, entry.deadlineHour,
    entry.state, entry.priority, entry.purposeKey, entry.payload, entry.journeyId, entry.progress,
    entry.blocked, entry.retryCount, entry.outcome,
  ]]));
  const effectReceipts = Object.fromEntries(Object.entries(state.effectReceipts).map(([key, receipt]) => [
    key, [receipt.eventId, receipt.revision, receipt.result],
  ]));
  const events = state.events.map((event) => trimTuple([
    event.id, event.type, event.commitmentId, event.actorId, event.targetId, event.placeKey,
    event.atHour, event.late, event.payload, event.transitionId, event.revision,
    event.episodeId, event.choice,
  ]));
  const items = Object.fromEntries(Object.entries(state.projections.items || {}).map(([key, item]) => [key, [
    item.id, item.kind, item.ownerId, item.condition, item.purpose, item.relatedCommitmentId,
    item.lastTransferEventId, item.legacyLetterId,
  ]]));
  const entities = Object.fromEntries(Object.entries(state.entities).map(([key, entity]) => [key, [
    entity.id, entity.kind, entity.name, entity.role, entity.stationId, entity.homeKey,
    entity.locationKey, entity.inTransit, entity.tombstone, entity.tombstoneReason,
    entity.legacyMemoryMigrated, entity.householdId, entity.workplaceId,
  ]]));
  const letters = Object.fromEntries(Object.entries(state.projections.letters || {}).map(([key, letter]) => [key, [
    letter.id, letter.senderId, letter.recipientId, letter.ownerId, letter.deliveredAtHour,
    letter.deliveryEventId, letter.itemId,
  ]]));
  const rumorExchanges = Object.fromEntries(Object.entries(state.rumorExchanges).map(([key, exchange]) => [key, [
    exchange.atHour, exchange.transferCount, exchange.rejectionCounts,
  ]]));
  const rumorLog = state.rumorLog.map((entry) => [entry.id, entry.conversationId, entry.participantIds,
    entry.atHour, entry.transfers, entry.rejectionCounts, entry.rejections, entry.duplicate]);
  const compact = {
    ...clonePlain(state), storageFormat: 'compact-v4', entities, memories, relationships, commitments,
    effectReceipts, events, rumorExchanges, rumorLog,
    projections: { ...clonePlain(state.projections), items, letters },
  };
  // Frontage is a regenerated settlement-plan/render concern. The default-on
  // capability is intentionally omitted from compact snapshots so legacy
  // living-world budgets and older readers remain byte-stable; an explicit
  // false still persists and normalizes back to a disabled feature.
  if (compact.features?.familyFrontageEnabled === true) delete compact.features.familyFrontageEnabled;
  if (compact.features?.managedVegetationEnabled === true) delete compact.features.managedVegetationEnabled;
  compact.portals = Object.fromEntries(Object.entries(state.portals || {}).filter(([, portal]) =>
    portal.locked || portal.open || portal.target || portal.progress || portal.crossings));
  for (const key of ['interactions', 'interactionSequences', 'interactionCooldowns', 'groups',
    'groupSequences', 'actions', 'actionSequences', 'actionCooldowns', 'actionAnchors',
    'settlementDeltas', 'portals', 'households', 'workplaces', 'routines', 'occupancy',
    'settlementEvolution']) {
    if (!Object.keys(compact[key] || {}).length) delete compact[key];
  }
  for (const key of ['interactionOutcomes', 'playerHoldings']) {
    if (!Object.keys(compact.projections[key] || {}).length) delete compact.projections[key];
  }
  return compact;
}

function expandStoredState(value) {
  if (!['compact-v2', 'compact-v3', 'compact-v4'].includes(value?.storageFormat)) return value;
  const format = value.storageFormat;
  const expanded = { ...value };
  delete expanded.storageFormat;
  expanded.memories = Object.fromEntries(Object.entries(plainRecord(value.memories)).map(([ownerId, list]) => [
    ownerId,
    (Array.isArray(list) ? list : []).map((memory) => Array.isArray(memory) ? ({
      version: 2,
      id: memory[0], ownerId,
      subject: { kind: memory[1], id: memory[2] },
      predicate: memory[3], object: memory[4], summary: memory[5],
      source: { kind: memory[6], id: memory[7] },
      sourceChain: (Array.isArray(memory[8]) ? memory[8] : []).map((ref) => ({ kind: ref[0], id: ref[1] })),
      provenance: memory[9], originEventId: memory[10], lineageId: memory[11],
      confidence: memory[12], salience: memory[13], privacy: memory[14],
      hopCount: memory[15], createdAtHour: memory[16], lastRecalledHour: memory[17],
      expiresAtHour: memory[18],
    }) : memory),
  ]));
  expanded.relationships = Object.fromEntries(Object.entries(plainRecord(value.relationships))
    .map(([key, edge]) => [key, Array.isArray(edge) ? ({
      version: 1, ownerId: edge[0], subjectId: edge[1], familiarity: edge[2],
      affinity: edge[3], trust: edge[4], obligation: edge[5], tags: edge[6],
      lastInteractionHour: edge[7], lastEventId: edge[8],
    }) : edge]));
  if (format === 'compact-v3' || format === 'compact-v4') {
    expanded.entities = Object.fromEntries(Object.entries(plainRecord(value.entities)).map(([key, entity]) => [key, Array.isArray(entity) ? ({
      id: entity[0], kind: entity[1], name: entity[2], role: entity[3], stationId: entity[4],
      homeKey: entity[5], locationKey: entity[6], inTransit: entity[7], tombstone: entity[8],
      tombstoneReason: entity[9], legacyMemoryMigrated: entity[10],
      householdId: entity[11], workplaceId: entity[12],
    }) : entity]));
    expanded.commitments = Object.fromEntries(Object.entries(plainRecord(value.commitments)).map(([key, entry]) => [key, Array.isArray(entry) ? ({
      version: entry[0], id: entry[1], actorId: entry[2], kind: entry[3],
      target: { kind: entry[4], id: entry[5] }, destination: { kind: entry[6], key: entry[7] },
      createdAtHour: entry[8], deadlineHour: entry[9], state: entry[10], priority: entry[11],
      purposeKey: entry[12], payload: entry[13], journeyId: entry[14], progress: entry[15],
      blocked: entry[16], retryCount: entry[17], outcome: entry[18],
    }) : entry]));
    expanded.effectReceipts = Object.fromEntries(Object.entries(plainRecord(value.effectReceipts)).map(([key, receipt]) => [key, Array.isArray(receipt) ? ({
      eventId: receipt[0], revision: receipt[1], result: receipt[2],
    }) : receipt]));
    expanded.events = (Array.isArray(value.events) ? value.events : []).map((event) => Array.isArray(event) ? ({
      id: event[0], type: event[1], commitmentId: event[2], actorId: event[3], targetId: event[4],
      placeKey: event[5], atHour: event[6], late: event[7], payload: event[8],
      transitionId: event[9], revision: event[10], episodeId: event[11], choice: event[12],
    }) : event);
    expanded.projections = { ...plainRecord(value.projections) };
    expanded.projections.items = Object.fromEntries(Object.entries(plainRecord(value.projections?.items)).map(([key, item]) => [key, Array.isArray(item) ? ({
      id: item[0], kind: item[1], ownerId: item[2], condition: item[3], purpose: item[4],
      relatedCommitmentId: item[5], lastTransferEventId: item[6], legacyLetterId: item[7],
    }) : item]));
    expanded.projections.letters = Object.fromEntries(Object.entries(plainRecord(value.projections?.letters)).map(([key, letter]) => [key, Array.isArray(letter) ? ({
      id: letter[0], senderId: letter[1], recipientId: letter[2], ownerId: letter[3],
      deliveredAtHour: letter[4], deliveryEventId: letter[5], itemId: letter[6],
    }) : letter]));
    expanded.rumorExchanges = Object.fromEntries(Object.entries(plainRecord(value.rumorExchanges)).map(([key, exchange]) => [key, Array.isArray(exchange) ? ({
      conversationId: key, atHour: exchange[0], transferCount: exchange[1], rejectionCounts: exchange[2],
    }) : exchange]));
    expanded.rumorLog = (Array.isArray(value.rumorLog) ? value.rumorLog : []).map((entry) => Array.isArray(entry) ? ({
      id: entry[0], conversationId: entry[1], participantIds: entry[2], atHour: entry[3],
      transfers: entry[4], rejectionCounts: entry[5], rejections: entry[6], duplicate: entry[7],
    }) : entry);
  }
  return expanded;
}

function plainRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? clonePlain(value)
    : {};
}

function trimTuple(tuple) {
  while (tuple.length && tuple[tuple.length - 1] === undefined) tuple.pop();
  return tuple;
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function clonePlain(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function replacePlainState(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}
