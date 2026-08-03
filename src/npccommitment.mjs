import { mulberry32 } from './noise.js';
import { findRoute, reachableWithin } from './npcnavgraph.mjs';
import {
  journeyProgressSnapshot,
  restoreJourneyProgress,
  startJourney,
} from './npcjourney.mjs';
import { createItem } from './npcitems.mjs';

export const COMMITMENT_VERSION = 1;
export const COMMITMENT_STATE = Object.freeze({
  planned: 'planned',
  active: 'active',
  blocked: 'blocked',
  resolved: 'resolved',
});
export const COMMITMENT_KIND = Object.freeze({
  delivery: 'delivery',
  trade: 'trade',
  visit: 'visit',
  repair: 'repair',
});

const PURPOSE = Object.freeze({
  delivery: 'delivering a letter',
  trade: 'taking goods to trade',
  visit: 'visiting someone they know',
  repair: 'going to make a repair',
});

const ALLOWED_TRANSITIONS = Object.freeze({
  planned: new Set(['active', 'resolved']),
  active: new Set(['blocked', 'resolved']),
  blocked: new Set(['planned', 'active', 'resolved']),
  resolved: new Set(),
});

export function createCommitment(input) {
  if (!input?.id || !input?.actorId || !input?.kind) {
    throw new TypeError('A commitment requires id, actorId, and kind.');
  }
  if (!Object.values(COMMITMENT_KIND).includes(input.kind)) {
    throw new TypeError(`Unknown commitment kind: ${input.kind}`);
  }
  if (!input.target?.id || !input.destination?.key) {
    throw new TypeError('A commitment requires concrete target and destination references.');
  }
  const createdAtHour = finite(input.createdAtHour);
  return {
    version: COMMITMENT_VERSION,
    id: String(input.id),
    actorId: String(input.actorId),
    kind: input.kind,
    target: plain(input.target),
    destination: plain(input.destination),
    createdAtHour,
    deadlineHour: input.deadlineHour == null ? null : Math.max(createdAtHour, finite(input.deadlineHour)),
    state: COMMITMENT_STATE.planned,
    priority: clamp01(input.priority ?? 0.5),
    purposeKey: String(input.purposeKey || PURPOSE[input.kind]),
    payload: plain(input.payload),
    journeyId: null,
    progress: null,
    blocked: null,
    retryCount: Math.max(0, Math.floor(input.retryCount || 0)),
    outcome: null,
  };
}

export function transitionCommitment(commitment, nextState, details = {}) {
  if (!commitment || !ALLOWED_TRANSITIONS[commitment.state]?.has(nextState)) {
    throw new Error(`Invalid commitment transition ${commitment?.state || 'missing'} → ${nextState}.`);
  }
  if (nextState === COMMITMENT_STATE.resolved && !details.outcome) {
    throw new Error('A resolved commitment requires a terminal outcome.');
  }
  commitment.state = nextState;
  if (nextState === COMMITMENT_STATE.blocked) {
    commitment.blocked = {
      code: String(details.code || 'blocked'),
      sinceHour: finite(details.atHour),
      attempts: Math.max(0, Math.floor(details.attempts ?? commitment.blocked?.attempts ?? 0)),
    };
  } else {
    commitment.blocked = null;
  }
  if (nextState === COMMITMENT_STATE.resolved) {
    commitment.outcome = normalizeOutcome(details.outcome);
    commitment.progress = null;
    commitment.journeyId = null;
  }
  return commitment;
}

export function openCommitmentForActor(state, actorId) {
  return Object.values(state?.commitments || {}).find(
    (commitment) => commitment?.actorId === actorId && commitment.state !== COMMITMENT_STATE.resolved,
  ) || null;
}

/**
 * Deterministically create one concrete intention from entities and the nav graph.
 */
export function planCommitment(state, actor, graph, { nowHour = 0 } = {}) {
  const actorId = actor?.identity?.id || actor?.id;
  const homeKey = actor?.journey?.homeKey || actor?.homeKey;
  if (!actorId || !homeKey || !graph?.nodes?.has(homeKey)) return null;
  const existing = openCommitmentForActor(state, actorId);
  if (existing) return existing;

  const reachable = [...reachableWithin(graph, homeKey, 3000).entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  if (!reachable.length) return null;
  const sequence = Math.max(0, Math.floor(state.commitmentSequences[actorId] || 0)) + 1;
  const seed = ((actor?.identity?.seed || hashText(actorId)) ^ Math.imul(sequence, 0x9e3779b1)) >>> 0;
  const rng = mulberry32(seed);
  let kind = kindForActor(actor?.identity || actor, sequence);
  let destinationKey;
  let target;

  if (kind === COMMITMENT_KIND.delivery || kind === COMMITMENT_KIND.visit) {
    const people = Object.values(state.entities)
      .filter((entity) => entity?.kind === 'npc' && entity.id !== actorId
        && !entity.tombstone && !entity.inTransit
        && reachable.some(([key]) => key === (entity.locationKey || entity.homeKey)))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (people.length) {
      const person = people[Math.floor(rng() * people.length) % people.length];
      destinationKey = person.locationKey || person.homeKey;
      target = { kind: 'npc', id: person.id };
    } else {
      kind = kind === COMMITMENT_KIND.delivery ? COMMITMENT_KIND.trade : COMMITMENT_KIND.repair;
    }
  }

  if (!destinationKey) {
    destinationKey = reachable[Math.floor(rng() * reachable.length) % reachable.length][0];
    if (kind === COMMITMENT_KIND.trade) {
      const station = Object.values(state.entities)
        .filter((entity) => entity?.kind === 'npc' && entity.homeKey === destinationKey)
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      target = { kind: 'station', id: station?.stationId || `station-at:${destinationKey}` };
    } else {
      target = { kind: 'asset', id: `asset:maintenance:${destinationKey}` };
    }
  }

  const route = findRoute(graph, homeKey, destinationKey);
  if (!route?.legs?.length) return null;
  const travelHours = Math.max(1, route.cost / 1000);
  const id = `commitment:${state.worldSeed}:${actorId}:${sequence}`;
  const commitment = createCommitment({
    id,
    actorId,
    kind,
    target,
    destination: { kind: 'landmark', key: destinationKey },
    createdAtHour: nowHour,
    deadlineHour: nowHour + travelHours * 2 + 4,
    priority: 0.45 + rng() * 0.45,
    purposeKey: PURPOSE[kind],
    payload: payloadFor(kind, id, actorId, target, rng),
  });
  state.commitments[id] = commitment;
  initializeCommitmentProjection(state, commitment);
  state.commitmentSequences[actorId] = sequence;
  state.revision++;
  return commitment;
}

export function initializeCommitmentProjection(state, commitment) {
  if (commitment?.kind === COMMITMENT_KIND.delivery && commitment.payload?.id) {
    state.projections.letters[commitment.payload.id] ||= {
      id: commitment.payload.id,
      senderId: commitment.payload.senderId,
      recipientId: commitment.payload.recipientId,
      ownerId: commitment.actorId,
      deliveredAtHour: null,
      deliveryEventId: null,
    };
    const item = createItem(state, {
      id: `item:${commitment.payload.id}`, kind: 'letter', ownerId: commitment.actorId,
      purpose: 'commitment', condition: 'sealed', relatedCommitmentId: commitment.id,
    });
    state.projections.letters[commitment.payload.id].itemId = item.id;
  } else if (commitment?.kind === COMMITMENT_KIND.trade) {
    createItem(state, {
      id: `item:${commitment.id}:goods`, kind: 'basket', ownerId: commitment.actorId,
      purpose: 'commitment', condition: 'full', relatedCommitmentId: commitment.id,
    });
  } else if (commitment?.kind === COMMITMENT_KIND.repair) {
    createItem(state, {
      id: `item:${commitment.id}:tools`, kind: 'tools', ownerId: commitment.actorId,
      purpose: 'commitment', condition: 'usable', relatedCommitmentId: commitment.id,
    });
    createItem(state, {
      id: `item:${commitment.id}:damaged`, kind: 'damaged-equipment', ownerId: commitment.actorId,
      purpose: 'commitment', condition: 'damaged', relatedCommitmentId: commitment.id,
    });
  }
  return commitment;
}

export function activateCommitment(commitment, journey, graph) {
  if (!commitment || commitment.state !== COMMITMENT_STATE.planned) return false;
  const journeyId = `journey:${commitment.id}`;
  if (!startJourney(journey, {
    graph,
    destKey: commitment.destination.key,
    purpose: PURPOSE[commitment.kind],
    commitmentId: commitment.id,
    journeyId,
  })) return false;
  transitionCommitment(commitment, COMMITMENT_STATE.active);
  commitment.journeyId = journeyId;
  commitment.progress = journeyProgressSnapshot(journey);
  return true;
}

export function syncCommitmentProgress(commitment, journey) {
  if (!commitment || commitment.state !== COMMITMENT_STATE.active) return null;
  commitment.progress = journeyProgressSnapshot(journey);
  return commitment.progress;
}

export function restoreCommitmentJourney(commitment, journey, graph) {
  if (!commitment?.progress || commitment.state !== COMMITMENT_STATE.active) return false;
  return restoreJourneyProgress(journey, commitment.progress, graph);
}

export function blockCommitment(commitment, code, atHour, attempts = null) {
  return transitionCommitment(commitment, COMMITMENT_STATE.blocked, {
    code,
    atHour,
    attempts: attempts ?? commitment.retryCount ?? commitment.blocked?.attempts ?? 0,
  });
}

export function retryBlockedCommitment(commitment, { nowHour = 0, targetLocationKey = null } = {}) {
  if (commitment?.state !== COMMITMENT_STATE.blocked) return false;
  if (commitment.deadlineHour != null && nowHour >= commitment.deadlineHour) {
    resolveCommitment(commitment, {
      status: 'failed', code: 'deadline-missed', atHour: nowHour,
      placeKey: commitment.destination.key, effectEventIds: [],
    });
    return false;
  }
  if ((commitment.retryCount || 0) >= 1 || !targetLocationKey) return false;
  commitment.destination = { kind: 'landmark', key: targetLocationKey };
  commitment.retryCount = (commitment.retryCount || 0) + 1;
  transitionCommitment(commitment, COMMITMENT_STATE.planned);
  return true;
}

export function resolveCommitment(commitment, outcome) {
  if (commitment?.state === COMMITMENT_STATE.resolved) return commitment;
  return transitionCommitment(commitment, COMMITMENT_STATE.resolved, { outcome });
}

export function expireCommitments(state, nowHour) {
  const expired = [];
  for (const commitment of Object.values(state.commitments)) {
    if (!commitment || commitment.state === COMMITMENT_STATE.resolved
      || commitment.deadlineHour == null || nowHour < commitment.deadlineHour) continue;
    resolveCommitment(commitment, {
      status: 'failed', code: 'deadline-missed', atHour: nowHour,
      placeKey: commitment.destination.key, effectEventIds: [],
    });
    expired.push(commitment);
  }
  return expired;
}

function kindForActor(identity, sequence) {
  const role = String(identity?.role || '').toLowerCase();
  if (/porter|courier|messenger|trader|vendor/.test(role)) {
    return sequence % 2 ? COMMITMENT_KIND.delivery : COMMITMENT_KIND.trade;
  }
  if (/keeper|worker|ranger|guide/.test(role)) {
    return sequence % 2 ? COMMITMENT_KIND.repair : COMMITMENT_KIND.visit;
  }
  return [
    COMMITMENT_KIND.visit,
    COMMITMENT_KIND.delivery,
    COMMITMENT_KIND.trade,
    COMMITMENT_KIND.repair,
  ][(identity?.seed || sequence) % 4];
}

function payloadFor(kind, commitmentId, actorId, target, rng) {
  if (kind === COMMITMENT_KIND.delivery) {
    return {
      kind: 'letter',
      id: `letter:${commitmentId}`,
      senderId: actorId,
      recipientId: target.id,
    };
  }
  if (kind === COMMITMENT_KIND.trade) {
    const goods = ['tea', 'cloth', 'lamp-oil', 'apples'];
    return {
      kind: 'goods',
      itemKey: goods[Math.floor(rng() * goods.length) % goods.length],
      quantity: 1 + Math.floor(rng() * 3),
    };
  }
  if (kind === COMMITMENT_KIND.repair) {
    return { kind: 'tools', durationHours: 0.5 + rng() * 1.5 };
  }
  return { kind: 'visit' };
}

function normalizeOutcome(value) {
  if (!value || !['succeeded', 'failed', 'cancelled'].includes(value.status)) {
    throw new TypeError('A terminal outcome requires succeeded, failed, or cancelled status.');
  }
  return {
    status: value.status,
    code: String(value.code || value.status),
    atHour: finite(value.atHour),
    placeKey: value.placeKey == null ? null : String(value.placeKey),
    effectEventIds: Array.isArray(value.effectEventIds)
      ? [...new Set(value.effectEventIds.map(String))]
      : [],
  };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, finite(value)));
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {};
}

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
