import { applyLivingWorldEventOnce } from './livingworldstate.mjs';
import {
  blockCommitment,
  COMMITMENT_KIND,
  resolveCommitment,
} from './npccommitment.mjs';
import {
  applyRelationshipDelta,
  rememberSocialMemory,
  SOCIAL_MEMORY_LIMIT,
} from './npcsocialmemory.mjs';
import { transferItem } from './npcitems.mjs';

export const OUTCOME_MEMORY_LIMIT = SOCIAL_MEMORY_LIMIT;

/** Resolve one journey arrival into an authoritative consequence. */
export function resolveCommitmentArrival(state, transition, { nowHour = transition?.atHour ?? 0 } = {}) {
  const commitment = state?.commitments?.[transition?.commitmentId];
  if (!commitment) return { applied: false, reason: 'commitment-missing' };
  const event = eventForArrival(commitment, transition, nowHour);
  if (!event) return { applied: false, reason: 'unsupported-kind' };

  // Duplicates must reach the receipt check before current-state validation: a
  // successfully delivered commitment is already resolved by definition.
  if (state.effectReceipts[event.id]) {
    return applyLivingWorldEventOnce(state, event, () => null);
  }
  if (transition.destinationKey !== commitment.destination.key) {
    blockCommitment(commitment, 'wrong-destination', nowHour);
    return { applied: false, reason: 'wrong-destination' };
  }
  if (commitment.target.kind === 'npc') {
    const target = state.entities[commitment.target.id];
    if (!target || target.tombstone) {
      blockCommitment(commitment, 'target-removed', nowHour);
      return { applied: false, reason: 'target-removed' };
    }
    if (target.inTransit || (target.locationKey && target.locationKey !== commitment.destination.key)) {
      blockCommitment(commitment, 'target-absent', nowHour);
      return { applied: false, reason: 'target-absent' };
    }
  }

  return applyLivingWorldEventOnce(state, event, (draft, incoming) => {
    const current = draft.commitments[incoming.commitmentId];
    if (!current || current.state === 'resolved') throw new Error('Commitment is not open.');
    const result = reduceByKind(draft, current, incoming);
    if (result.terminal !== false) {
      resolveCommitment(current, {
        status: result.status || 'succeeded',
        code: result.code,
        atHour: incoming.atHour,
        placeKey: incoming.placeKey,
        effectEventIds: [incoming.id],
      });
    }
    return result;
  });
}

export function outcomeContextForActor(state, actorId, limit = 3) {
  const commitments = Object.values(state?.commitments || {})
    .filter((commitment) => commitment?.actorId === actorId)
    .sort((a, b) => (b.outcome?.atHour ?? b.createdAtHour ?? 0)
      - (a.outcome?.atHour ?? a.createdAtHour ?? 0));
  const activeCommitment = commitments.find((commitment) => commitment.state !== 'resolved') || null;
  return {
    activeCommitment: activeCommitment ? describeCommitment(activeCommitment, state.entities) : null,
    recentOutcomes: commitments.filter((commitment) => commitment.outcome)
      .slice(0, limit).map((commitment) => describeCommitment(commitment, state.entities)),
  };
}

export function advanceRepairJobs(state, nowHour) {
  const completed = [];
  for (const job of Object.values(state?.projections?.repairJobs || {})) {
    if (!job || job.status !== 'in-progress' || nowHour < job.completesAtHour) continue;
    const commitment = state.commitments[job.commitmentId];
    const event = {
      id: `event:${job.commitmentId}:repair-completed`,
      type: 'repair.completed',
      commitmentId: job.commitmentId,
      actorId: job.workerId,
      targetId: job.assetId,
      placeKey: job.placeKey,
      atHour: nowHour,
    };
    const applied = applyLivingWorldEventOnce(state, event, (draft, incoming) => {
      const currentJob = draft.projections.repairJobs[incoming.targetId];
      currentJob.status = 'completed';
      currentJob.completedAtHour = incoming.atHour;
      draft.projections.assets[incoming.targetId] = {
        id: incoming.targetId,
        condition: 'repaired',
        repairedBy: incoming.actorId,
        repairedAtHour: incoming.atHour,
      };
      const currentCommitment = draft.commitments[incoming.commitmentId];
      resolveCommitment(currentCommitment, {
        status: 'succeeded', code: 'repaired', atHour: incoming.atHour,
        placeKey: incoming.placeKey,
        effectEventIds: [
          `event:${incoming.commitmentId}:repair-started`, incoming.id,
        ],
      });
      rememberOutcome(draft, incoming.actorId, incoming, 'completed a repair');
      return { code: 'repaired', terminal: true };
    });
    if (applied.applied) completed.push(commitment);
  }
  return completed;
}

function eventForArrival(commitment, transition, atHour) {
  const suffix = {
    delivery: 'delivered',
    trade: 'restocked',
    visit: 'visited',
    repair: 'repair-started',
  }[commitment.kind];
  if (!suffix) return null;
  return {
    id: `event:${commitment.id}:${suffix}`,
    type: `${commitment.kind}.${suffix}`,
    commitmentId: commitment.id,
    actorId: commitment.actorId,
    targetId: commitment.target.id,
    placeKey: commitment.destination.key,
    atHour: finite(atHour),
    late: commitment.deadlineHour != null && finite(atHour) > commitment.deadlineHour,
    payload: commitment.payload,
    transitionId: transition.id,
  };
}

function reduceByKind(state, commitment, event) {
  if (commitment.kind === COMMITMENT_KIND.delivery) return reduceDelivery(state, commitment, event);
  if (commitment.kind === COMMITMENT_KIND.trade) return reduceTrade(state, commitment, event);
  if (commitment.kind === COMMITMENT_KIND.visit) return reduceVisit(state, commitment, event);
  if (commitment.kind === COMMITMENT_KIND.repair) return reduceRepairStart(state, commitment, event);
  throw new Error(`Unsupported commitment kind: ${commitment.kind}`);
}

function reduceDelivery(state, commitment, event) {
  const letter = state.projections.letters[commitment.payload.id];
  if (!letter || letter.ownerId !== commitment.actorId) {
    throw new Error('Courier does not own the committed letter.');
  }
  letter.ownerId = commitment.target.id;
  letter.deliveredAtHour = event.atHour;
  letter.deliveryEventId = event.id;
  if (letter.itemId) transferItem(state, letter.itemId, commitment.target.id, {
    eventId: event.id, condition: 'delivered',
  });
  const code = event.late ? 'delivered-late' : 'delivered';
  rememberOutcome(state, commitment.actorId, event, 'delivered a letter');
  rememberOutcome(state, commitment.target.id, event, 'received a letter');
  touchRelationship(state, commitment.target.id, commitment.actorId, event, {
    familiarity: 0.08,
    trust: event.late ? 0 : 0.04,
  });
  return { code, status: 'succeeded', terminal: true, letterId: letter.id };
}

function reduceTrade(state, commitment, event) {
  const station = state.projections.stationInventory[commitment.target.id] ||= {};
  const itemKey = commitment.payload.itemKey;
  const quantity = Math.max(1, Math.floor(commitment.payload.quantity || 1));
  station[itemKey] = Math.max(0, Math.floor(station[itemKey] || 0)) + quantity;
  transferItem(state, `item:${commitment.id}:goods`, commitment.target.id, {
    eventId: event.id, condition: 'unpacked',
  });
  rememberOutcome(state, commitment.actorId, event, `restocked ${itemKey}`);
  return { code: event.late ? 'restocked-late' : 'restocked', terminal: true, itemKey, quantity };
}

function reduceVisit(state, commitment, event) {
  const pair = [commitment.actorId, commitment.target.id].sort().join('|');
  const meeting = state.projections.meetings[pair] ||= { count: 0 };
  meeting.count++;
  meeting.lastEventId = event.id;
  meeting.lastMetAtHour = event.atHour;
  meeting.placeKey = event.placeKey;
  rememberOutcome(state, commitment.actorId, event, `met ${commitment.target.id}`);
  rememberOutcome(state, commitment.target.id, event, `met ${commitment.actorId}`);
  touchRelationship(state, commitment.actorId, commitment.target.id, event, { familiarity: 0.12 });
  touchRelationship(state, commitment.target.id, commitment.actorId, event, { familiarity: 0.12 });
  return { code: 'visited', terminal: true, meetingKey: pair };
}

function reduceRepairStart(state, commitment, event) {
  const durationHours = Math.max(0.1, finite(commitment.payload.durationHours) || 0.5);
  state.projections.repairJobs[commitment.target.id] = {
    assetId: commitment.target.id,
    commitmentId: commitment.id,
    workerId: commitment.actorId,
    placeKey: event.placeKey,
    status: 'in-progress',
    startedAtHour: event.atHour,
    completesAtHour: event.atHour + durationHours,
  };
  state.projections.assets[commitment.target.id] = {
    id: commitment.target.id,
    condition: 'under-repair',
    workerId: commitment.actorId,
  };
  rememberOutcome(state, commitment.actorId, event, 'began a repair');
  return { code: 'repair-started', terminal: false, assetId: commitment.target.id };
}

function rememberOutcome(state, ownerId, event, summary) {
  if (!ownerId || state.features?.socialMemoryEnabled === false) return;
  const id = `memory:${ownerId}:${event.id}`;
  rememberSocialMemory(state, ownerId, {
    version: 2,
    id,
    ownerId,
    subject: { kind: 'commitment', id: event.commitmentId },
    predicate: 'commitment.outcome',
    object: { type: event.type, targetId: event.targetId, placeKey: event.placeKey },
    summary,
    source: { kind: 'world-event', id: event.id },
    provenance: 'observed',
    originEventId: event.id,
    lineageId: `claim:${event.id}`,
    confidence: 1,
    salience: 0.8,
    privacy: 'public',
    hopCount: 0,
    createdAtHour: event.atHour,
    lastRecalledHour: event.atHour,
    expiresAtHour: null,
  }, { nowHour: event.atHour });
}

function touchRelationship(state, ownerId, subjectId, event, deltas = {}) {
  if (state.features?.socialMemoryEnabled === false) return null;
  return applyRelationshipDelta(state, ownerId, subjectId, deltas, event);
}

function describeCommitment(commitment, entities) {
  return {
    id: commitment.id,
    kind: commitment.kind,
    state: commitment.state,
    targetId: commitment.target.id,
    targetName: entities?.[commitment.target.id]?.name || commitment.target.id,
    destinationKey: commitment.destination.key,
    deadlineHour: commitment.deadlineHour,
    purpose: commitment.purposeKey,
    outcome: commitment.outcome,
  };
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
