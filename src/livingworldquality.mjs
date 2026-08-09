import { LIVING_WORLD_STATE_VERSION, serializeLivingWorldState } from './livingworldstate.mjs';
import { RUMOR_MAX_HOPS } from './npcrumor.mjs';
import { SOCIAL_MEMORY_LIMIT } from './npcsocialmemory.mjs';
import { auditNpcMobilityState } from './npcmobilityquality.mjs';

export const LIVING_WORLD_BASELINE_SNAPSHOT_BUDGET_BYTES = 220 * 1024;
export const LIVING_WORLD_SNAPSHOT_BUDGET_BYTES = 256 * 1024;
export const LIVING_WORLD_SIMULATION_P95_BUDGET_MS = 0.35;

export function livingWorldSnapshotBytes(state) {
  return new TextEncoder().encode(serializeLivingWorldState(state)).length;
}

export function livingWorldMetrics(state) {
  const commitments = Object.values(state?.commitments || {});
  const memories = Object.values(state?.memories || {}).reduce(
    (sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0,
  );
  return {
    version: state?.version || 0,
    snapshotBytes: livingWorldSnapshotBytes(state),
    entities: Object.keys(state?.entities || {}).length,
    openCommitments: commitments.filter((entry) => entry?.state !== 'resolved').length,
    blockedCommitments: commitments.filter((entry) => entry?.state === 'blocked').length,
    resolvedCommitments: commitments.filter((entry) => entry?.state === 'resolved').length,
    effectDedupes: state?.metrics?.effectDedupes || 0,
    memoryEvictions: state?.metrics?.memoryEvictions || 0,
    memories,
    rumorExchanges: state?.metrics?.rumorExchanges || 0,
    rumorTransfers: state?.metrics?.rumorTransfers || 0,
    saveFailures: state?.metrics?.saveFailures || 0,
    simulationMs: state?.metrics?.simulationMs || 0,
    items: Object.keys(state?.projections?.items || {}).length,
    pendingInteractions: Object.values(state?.interactions || {}).filter((entry) => entry?.state === 'pending').length,
    activeGroups: Object.values(state?.groups || {}).filter((entry) => entry?.state !== 'dissolved').length,
    activeActions: Object.values(state?.actions || {}).filter((entry) => !['completed', 'interrupted', 'expired'].includes(entry?.state)).length,
  };
}

/** Return actionable invariant failures without mutating the snapshot. */
export function auditLivingWorldState(state) {
  const errors = [];
  if (state?.version !== LIVING_WORLD_STATE_VERSION) errors.push('state-version');
  const entities = state?.entities || {};
  const openByActor = new Map();
  for (const commitment of Object.values(state?.commitments || {})) {
    if (!commitment?.id || !commitment.actorId || !entities[commitment.actorId]) {
      errors.push(`commitment-actor:${commitment?.id || 'missing'}`);
      continue;
    }
    if (commitment.target?.kind === 'npc' && !entities[commitment.target.id]) {
      errors.push(`commitment-target:${commitment.id}`);
    }
    if (commitment.state !== 'resolved') {
      openByActor.set(commitment.actorId, (openByActor.get(commitment.actorId) || 0) + 1);
      if (commitment.state === 'active' && !commitment.journeyId) {
        errors.push(`active-without-journey:${commitment.id}`);
      }
    }
  }
  for (const [actorId, count] of openByActor) {
    if (count > 1) errors.push(`multiple-open:${actorId}`);
  }
  for (const [ownerId, list] of Object.entries(state?.memories || {})) {
    if (!entities[ownerId]) errors.push(`memory-owner:${ownerId}`);
    if (!Array.isArray(list)) {
      errors.push(`memory-list:${ownerId}`);
      continue;
    }
    if (list.length > SOCIAL_MEMORY_LIMIT) errors.push(`memory-cap:${ownerId}`);
    const lineages = new Set();
    for (const memory of list) {
      if (!memory?.lineageId || lineages.has(memory.lineageId)) errors.push(`memory-lineage:${ownerId}`);
      lineages.add(memory?.lineageId);
      if (memory?.hopCount > RUMOR_MAX_HOPS) errors.push(`memory-hop:${memory?.id}`);
      if (memory?.subject?.kind === 'npc' && !entities[memory.subject.id]) {
        errors.push(`memory-subject:${memory?.id}`);
      }
      if (memory?.source?.kind === 'npc' && !entities[memory.source.id]) {
        errors.push(`memory-source:${memory?.id}`);
      }
      if (memory?.provenance === 'observed' && memory.originEventId
        && !state.effectReceipts?.[memory.originEventId]
        && !(state.events || []).some((event) => event?.id === memory.originEventId)) {
        errors.push(`memory-origin:${memory.id}`);
      }
    }
  }
  const itemOwners = new Map();
  for (const item of Object.values(state?.projections?.items || {})) {
    if (!item?.id) errors.push('item-id');
    const knownNonPersonOwner = Object.values(state?.commitments || {}).some((commitment) => commitment?.target?.id === item?.ownerId);
    if (item?.ownerId && !entities[item.ownerId] && !knownNonPersonOwner) errors.push(`item-owner:${item.id}`);
    if (item?.ownerId) itemOwners.set(item.id, (itemOwners.get(item.id) || 0) + 1);
  }
  for (const [itemId, count] of itemOwners) if (count > 1) errors.push(`item-duplicate-owner:${itemId}`);
  const membership = new Map();
  for (const group of Object.values(state?.groups || {})) {
    if (group?.state === 'dissolved') continue;
    if (!Array.isArray(group?.memberIds) || group.memberIds.length < 2 || group.memberIds.length > 4) errors.push(`group-size:${group?.id}`);
    for (const actorId of group?.memberIds || []) {
      membership.set(actorId, (membership.get(actorId) || 0) + 1);
      if (!entities[actorId]) errors.push(`group-member:${group.id}:${actorId}`);
    }
  }
  for (const [actorId, count] of membership) if (count > 1) errors.push(`group-membership:${actorId}`);
  if (Object.values(state?.interactions || {}).filter((entry) => entry?.state === 'pending').length > 1) errors.push('interaction-attention-budget');
  for (const action of Object.values(state?.actions || {})) {
    if (!entities[action?.actorId]) errors.push(`action-actor:${action?.id}`);
    if (!state?.actionAnchors?.[action?.anchorId]) errors.push(`action-anchor:${action?.id}`);
    if (state?.actionAnchors?.[action?.anchorId]?.enabled === false
      && !['completed', 'interrupted', 'expired'].includes(action?.state)) errors.push(`action-disabled-anchor:${action?.id}`);
  }
  for (const episode of Object.values(state?.interactions || {})) {
    if (!episode?.actorId || !entities[episode.actorId]) errors.push(`interaction-actor:${episode?.id}`);
    if (!episode?.reason || !episode?.evidence || !Array.isArray(episode?.choices)) errors.push(`interaction-grounding:${episode?.id}`);
    if (episode?.kind === 'confront' && episode?.evidence?.provenance !== 'observed') errors.push(`interaction-confrontation:${episode?.id}`);
  }
  const mobility = auditNpcMobilityState(state);
  for (const issue of mobility.errors) {
    errors.push(`mobility:${issue.code}:${issue.subjectId}`);
  }
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)].sort(),
    metrics: { ...livingWorldMetrics(state), mobility: mobility.metrics },
  };
}

export function percentile(values, fraction = 0.95) {
  const sorted = (Array.isArray(values) ? values : [])
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}
