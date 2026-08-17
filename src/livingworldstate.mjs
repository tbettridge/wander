import {
  createLivingWorldClock,
  normalizeLivingWorldClock,
} from './livingworldclock.mjs';
import {
  createNpcSpatialState,
  npcSpatialSnapshot,
} from './npclocation.mjs';
import { LEGACY_PLAYER_ID, migrateLegacyPlayerReferences } from './multiplayeridentity.mjs';

export const LIVING_WORLD_STATE_VERSION = 5;
export const NPC_MOBILITY_ROLLOUT_VERSION = 1;
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
  // Narrative continuity is layered so each consumer can be rolled back
  // without deleting the community or fact records it depends on.
  npcCommunityKnowledgeEnabled: true,
  npcNarrativeGraphRetrievalEnabled: true,
  npcNarrativeFactPropagationEnabled: true,
  // The continuous resident/trail/train presentation has completed rollout.
  // Migration remains opt-in because it changes where somebody lives; ordinary
  // travel does not, so it is safe and expected in the shipped world.
  unifiedNpcMobilityEnabled: true,
  npcRailTravelEnabled: true,
  npcLeisureTravelEnabled: true,
  npcMigrationEnabled: false,
});

// v5 writes beside the deployed v1-v4 key. Older application code cannot
// expand compact-v5 tuples, so overwriting its key would make a code rollback
// look like data loss. The new reader imports the old key once and thereafter
// saves only to its forward schema key.
const DEFAULT_PREFIX = 'wander.livingWorld.state.v5.';
const LEGACY_PREFIX = 'wander.livingWorld.state.v1.';
const LEGACY_SOURCE_FINGERPRINT_FIELD = '_legacySourceFingerprint';
const INVALID_STORAGE_RECORD = Symbol('invalid-storage-record');
const PLAYER_SCOPE_PREFIX = 'wander.livingWorld.playerScope.v1.';

export function createLivingWorldState({ worldSeed = 1, playerId = LEGACY_PLAYER_ID, playerName = 'Traveller' } = {}) {
  const state = {
    version: LIVING_WORLD_STATE_VERSION,
    npcMobilityRolloutVersion: NPC_MOBILITY_ROLLOUT_VERSION,
    worldSeed: Number(worldSeed) || 1,
    playerId: String(playerId || LEGACY_PLAYER_ID),
    playerName: String(playerName || 'Traveller').slice(0, 40),
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
    narrativeFacts: {},
    narrativeFactReceipts: {},
    settlementDeltas: {},
    portals: {},
    households: {},
    workplaces: {},
    routines: {},
    occupancy: {},
    itineraries: {},
    railServices: {},
    railManifests: {},
    settlementEvolution: {},
    effectReceipts: {},
    events: [],
    features: { ...DEFAULT_LIVING_WORLD_FEATURES },
    metrics: {
      effectDedupes: 0,
      memoryEvictions: 0,
      rumorExchanges: 0,
      rumorTransfers: 0,
      narrativeFactsAccepted: 0,
      narrativeFactsRejected: 0,
      narrativeGraphRetrievals: 0,
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
  if (state.playerId !== LEGACY_PLAYER_ID) {
    state.entities[state.playerId] = {
      id: state.playerId,
      kind: 'player',
      name: state.playerName,
      role: 'traveller',
    };
  }
  return state;
}

export function normalizeLivingWorldState(value, {
  worldSeed = value?.worldSeed ?? 1,
  playerId = value?.playerId || LEGACY_PLAYER_ID,
  playerName = value?.playerName || 'Traveller',
} = {}) {
  value = expandStoredState(value);
  const sourcePlayerId = value?.playerId || playerId;
  const state = createLivingWorldState({ worldSeed, playerId: sourcePlayerId, playerName });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return state;
  state.revision = finiteInteger(value.revision);
  state.clock = normalizeLivingWorldClock(value.clock);
  for (const key of [
    'entities', 'commitments', 'commitmentSequences', 'relationships',
    'memories', 'effectReceipts', 'conversationSequences', 'rumorExchanges',
    'rumorCooldowns', 'interactions', 'interactionSequences', 'interactionCooldowns',
    'narrativeFacts', 'narrativeFactReceipts',
    'groups', 'groupSequences', 'actions', 'actionSequences', 'actionCooldowns',
    'actionAnchors',
    'settlementDeltas', 'portals', 'households', 'workplaces', 'routines',
    'occupancy', 'itineraries', 'railServices', 'railManifests', 'settlementEvolution',
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
  if (sourcePlayerId !== LEGACY_PLAYER_ID) {
    const migrated = migrateLegacyPlayerReferences(state, sourcePlayerId);
    replacePlainState(state, migrated);
  }
  migrateNpcMobilityRollout(state, value);
  state.metrics = {
    ...state.metrics,
    ...Object.fromEntries(Object.entries(plainRecord(value.metrics))
      .map(([key, count]) => [key, finiteNumber(count)])),
  };
  migrateStateV3(state, value);
  migrateStateV4(state, value);
  migrateStateV5(state, value);
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
    features.unifiedNpcMobilityEnabled = false;
  }
  if (!features.householdsEnabled) features.workRoutinesEnabled = false;
  if (!features.householdsEnabled) features.npcCommunityKnowledgeEnabled = false;
  if (!features.npcCommunityKnowledgeEnabled) {
    features.npcNarrativeGraphRetrievalEnabled = false;
    features.npcNarrativeFactPropagationEnabled = false;
  }
  if (!features.npcNarrativeGraphRetrievalEnabled || !features.socialMemoryEnabled) {
    features.npcNarrativeFactPropagationEnabled = false;
  }
  if (!features.householdsEnabled) features.unifiedNpcMobilityEnabled = false;
  if (!features.unifiedNpcMobilityEnabled) {
    features.npcRailTravelEnabled = false;
    features.npcLeisureTravelEnabled = false;
    features.npcMigrationEnabled = false;
  }
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

function migrateStateV5(state, source) {
  if (Number(source?.version) >= 5) return;
  // Deliberately do not infer residence or current location from legacy
  // homeKey/locationKey values. Those keys can name stations, trail nodes,
  // rooms or buildings and guessing would turn travel into migration.
  state.version = LIVING_WORLD_STATE_VERSION;
}

/**
 * Activate the completed mobility stack once for pre-rollout saves. The marker
 * is persisted separately from the feature switches so a player can still turn
 * any layer off after migration without it being re-enabled on the next load.
 */
function migrateNpcMobilityRollout(state, source) {
  const prior = finiteInteger(source?.npcMobilityRolloutVersion);
  if (prior >= NPC_MOBILITY_ROLLOUT_VERSION) {
    state.npcMobilityRolloutVersion = prior;
    return;
  }
  state.features = normalizeLivingWorldFeatures({
    ...state.features,
    unifiedNpcMobilityEnabled: true,
    npcRailTravelEnabled: true,
    npcLeisureTravelEnabled: true,
  });
  state.npcMobilityRolloutVersion = NPC_MOBILITY_ROLLOUT_VERSION;
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

/**
 * Attach authoritative residence and current-location data to an existing NPC.
 *
 * Legacy homeKey/locationKey fields remain untouched for instant rollback while
 * the unified mobility rollout is disabled. Unknown IDs and non-NPC entities
 * are rejected rather than silently creating a second population.
 */
export function attachNpcSpatialState(state, entityId, spatialState) {
  const id = typeof entityId === 'string' ? entityId : '';
  const entity = id ? state?.entities?.[id] : null;
  if (!entity) throw new RangeError(`Unknown living-world entity: ${id || '(empty)'}.`);
  if (entity.kind !== 'npc') throw new TypeError(`Entity ${id} is not an NPC.`);
  const validated = createNpcSpatialState(spatialState);
  const snapshot = npcSpatialSnapshot(validated);
  const before = JSON.stringify([entity.residence, entity.location]);
  entity.residence = snapshot.residence;
  entity.location = snapshot.location;
  if (before !== JSON.stringify([entity.residence, entity.location])) {
    state.revision = finiteInteger(state.revision) + 1;
  }
  return entity;
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
    playerId = LEGACY_PLAYER_ID,
    playerName = 'Traveller',
    storage = typeof localStorage === 'undefined' ? null : localStorage,
    prefix = DEFAULT_PREFIX,
    legacyPrefix = prefix === DEFAULT_PREFIX ? LEGACY_PREFIX : null,
  } = {}) {
    this.worldSeed = Number(worldSeed) || 1;
    this.playerId = String(playerId || LEGACY_PLAYER_ID);
    this.playerName = String(playerName || 'Traveller').slice(0, 40);
    this.storage = storage;
    this.prefix = prefix;
    this.legacyPrefix = legacyPrefix;
    this.lastError = null;
  }

  key() {
    const suffix = this.playerId === LEGACY_PLAYER_ID
      ? ''
      : `.${encodeURIComponent(this.playerId)}`;
    return `${this.prefix}${this.worldSeed}${suffix}`;
  }

  legacyKey() {
    return this.legacyPrefix ? `${this.legacyPrefix}${this.worldSeed}` : null;
  }

  load() {
    if (!this.storage) return createLivingWorldState({
      worldSeed: this.worldSeed, playerId: this.playerId, playerName: this.playerName,
    });
    try {
      const forwardRaw = this.storage.getItem(this.key());
      const legacyRaw = this.legacyKey() ? this.storage.getItem(this.legacyKey()) : null;
      const recordedLegacyFingerprint = storedLegacySourceFingerprint(forwardRaw);
      // A rolled-back build may have advanced the old key after v5 was first
      // written. Prefer that changed source on the next upgrade instead of
      // silently shadowing the rollback-era progress with a stale forward copy.
      const legacyChanged = forwardRaw != null && legacyRaw != null
        && recordedLegacyFingerprint != null
        && recordedLegacyFingerprint !== legacySourceFingerprint(legacyRaw);
      const forwardInvalid = recordedLegacyFingerprint === INVALID_STORAGE_RECORD;
      const preferred = legacyChanged || forwardInvalid ? legacyRaw : forwardRaw;
      const fallback = preferred === legacyRaw ? forwardRaw : legacyRaw;
      const candidates = [...new Set([preferred, fallback].filter((raw) => raw != null))];
      for (const raw of candidates) {
        try {
          const state = normalizeLivingWorldState(JSON.parse(raw), {
            worldSeed: this.worldSeed,
            playerId: this.playerId,
            playerName: this.playerName,
          });
          this.lastError = null;
          return state;
        } catch (error) {
          this.lastError = error;
        }
      }
      return createLivingWorldState({
        worldSeed: this.worldSeed, playerId: this.playerId, playerName: this.playerName,
      });
    } catch (error) {
      this.lastError = error;
      return createLivingWorldState({
        worldSeed: this.worldSeed, playerId: this.playerId, playerName: this.playerName,
      });
    }
  }

  save(state) {
    try {
      let finalSerialized = serializeLivingWorldState(state);
      if (this.storage && this.legacyKey()) {
        finalSerialized = withLegacySourceFingerprint(
          finalSerialized,
          legacySourceFingerprint(this.storage.getItem(this.legacyKey())),
        );
      }
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

function withLegacySourceFingerprint(serialized, fingerprint) {
  const record = JSON.parse(serialized);
  record[LEGACY_SOURCE_FINGERPRINT_FIELD] = fingerprint;
  return JSON.stringify(record);
}

function storedLegacySourceFingerprint(serialized) {
  if (serialized == null) return null;
  try {
    const value = JSON.parse(serialized)?.[LEGACY_SOURCE_FINGERPRINT_FIELD];
    return typeof value === 'string' && value.length ? value : null;
  } catch {
    return INVALID_STORAGE_RECORD;
  }
}

function legacySourceFingerprint(serialized) {
  if (serialized == null) return 'absent';
  const value = String(serialized);
  let first = 2166136261;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 16777619) >>> 0;
    second ^= code + index;
    second = Math.imul(second, 2246822519) >>> 0;
  }
  return `${value.length}:${first.toString(36)}:${second.toString(36)}`;
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
  const entities = Object.fromEntries(Object.entries(state.entities).map(([key, entity]) => [key, trimTuple([
    entity.id, entity.kind, entity.name, entity.role, entity.stationId, entity.homeKey,
    entity.locationKey, entity.inTransit, entity.tombstone, entity.tombstoneReason,
    entity.legacyMemoryMigrated, entity.householdId, entity.workplaceId,
    entity.residence, entity.location, entity.activity, entity.itineraryId,
  ])]));
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
    ...clonePlain(state), storageFormat: 'compact-v5', entities, memories, relationships, commitments,
    effectReceipts, events, rumorExchanges, rumorLog,
    projections: { ...clonePlain(state.projections), items, letters },
  };
  // Frontage is a regenerated settlement-plan/render concern. The default-on
  // capability is intentionally omitted from compact snapshots so legacy
  // living-world budgets and older readers remain byte-stable; an explicit
  // false still persists and normalizes back to a disabled feature.
  if (compact.features?.familyFrontageEnabled === true) delete compact.features.familyFrontageEnabled;
  if (compact.features?.managedVegetationEnabled === true) delete compact.features.managedVegetationEnabled;
  if (compact.features?.npcCommunityKnowledgeEnabled === true) delete compact.features.npcCommunityKnowledgeEnabled;
  if (compact.features?.npcNarrativeGraphRetrievalEnabled === true) delete compact.features.npcNarrativeGraphRetrievalEnabled;
  if (compact.features?.npcNarrativeFactPropagationEnabled === true) delete compact.features.npcNarrativeFactPropagationEnabled;
  compact.portals = Object.fromEntries(Object.entries(state.portals || {}).filter(([, portal]) =>
    portal.locked || portal.open || portal.target || portal.progress || portal.crossings));
  for (const key of ['interactions', 'interactionSequences', 'interactionCooldowns', 'groups',
    'groupSequences', 'actions', 'actionSequences', 'actionCooldowns', 'actionAnchors',
    'settlementDeltas', 'portals', 'households', 'workplaces', 'routines', 'occupancy',
    'itineraries', 'railServices', 'railManifests', 'settlementEvolution',
    'narrativeFacts', 'narrativeFactReceipts']) {
    if (!Object.keys(compact[key] || {}).length) delete compact[key];
  }
  for (const key of ['interactionOutcomes', 'playerHoldings']) {
    if (!Object.keys(compact.projections[key] || {}).length) delete compact.projections[key];
  }
  return compact;
}

function expandStoredState(value) {
  if (!['compact-v2', 'compact-v3', 'compact-v4', 'compact-v5'].includes(value?.storageFormat)) return value;
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
  if (format === 'compact-v3' || format === 'compact-v4' || format === 'compact-v5') {
    expanded.entities = Object.fromEntries(Object.entries(plainRecord(value.entities)).map(([key, entity]) => [key, Array.isArray(entity) ? ({
      id: entity[0], kind: entity[1], name: entity[2], role: entity[3], stationId: entity[4],
      homeKey: entity[5], locationKey: entity[6], inTransit: entity[7], tombstone: entity[8],
      tombstoneReason: entity[9], legacyMemoryMigrated: entity[10],
      householdId: entity[11], workplaceId: entity[12],
      residence: entity[13], location: entity[14], activity: entity[15],
      itineraryId: entity[16],
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
