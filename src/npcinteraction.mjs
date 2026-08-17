import { applyLivingWorldEventOnce } from './livingworldstate.mjs';
import { applyRelationshipDelta } from './npcsocialmemory.mjs';

export const INTERACTION_KINDS = Object.freeze([
  'request-directions', 'warn-weather', 'ask-help', 'offer-trade', 'recognize-player', 'confront',
]);
export const INTERACTION_STATE = Object.freeze({ pending: 'pending', accepted: 'accepted', declined: 'declined', expired: 'expired', resolved: 'resolved' });
export const INTERACTION_OFFER_TTL_HOURS = 12 / 3600;
export const INTERACTION_COOLDOWN_HOURS = 90 / 3600;

export function interactionCandidateFor(state, actor, facts = {}) {
  const actorId = actor?.identity?.id || actor?.id;
  if (!actorId) return null;
  const evidence = (extra = {}) => ({ provenance: 'observed', actorId, ...extra });
  if (facts.confrontationEvidence?.provenance === 'observed') return {
    actorId, kind: 'confront', reason: 'a directly observed unresolved incident', evidence: facts.confrontationEvidence,
  };
  if (facts.raining || facts.storm) return {
    actorId, kind: 'warn-weather', reason: 'dangerous weather is approaching',
    evidence: evidence({ weather: facts.weather || 'rain', shelterAnchorId: facts.shelterAnchorId || null }),
  };
  if (facts.needsHelp || facts.damagedEquipment) return {
    actorId, kind: 'ask-help', reason: facts.damagedEquipment ? 'damaged equipment needs attention' : 'their load or route needs assistance',
    evidence: evidence({ itemId: facts.damagedEquipment?.id || null, commitmentId: facts.commitmentId || null }),
  };
  if (facts.tradeItem) return {
    actorId, kind: 'offer-trade', reason: 'they own goods available to exchange',
    evidence: evidence({ itemId: facts.tradeItem.id, condition: facts.tradeItem.condition }),
  };
  if (facts.metPlayerBefore) return {
    actorId, kind: 'recognize-player', reason: 'they remember an earlier meeting with the player',
    evidence: evidence({ relationshipEventId: facts.relationshipEventId || null }),
  };
  if (facts.destinationKey || facts.routeUncertain) return {
    actorId, kind: 'request-directions', reason: 'they are navigating toward a concrete destination',
    evidence: evidence({ destinationKey: facts.destinationKey || null, commitmentId: facts.commitmentId || null }),
  };
  return null;
}

export function createInteractionEpisode(state, input, { nowHour = state.clock?.worldHours || 0 } = {}) {
  if (!input?.actorId || !INTERACTION_KINDS.includes(input.kind)) throw new TypeError('Interaction needs actorId and supported kind.');
  if (!input.reason || !input.evidence) throw new TypeError('NPC initiation must have a grounded reason and evidence.');
  if (input.kind === 'confront' && input.evidence.provenance !== 'observed') return null;
  if (pendingInteraction(state)) return null;
  const cooldownKey = `${input.actorId}:${input.kind}`;
  if ((state.interactionCooldowns.global || -Infinity) > nowHour) return null;
  if ((state.interactionCooldowns[cooldownKey] || -Infinity) > nowHour) return null;
  const sequence = (state.interactionSequences[input.actorId] || 0) + 1;
  state.interactionSequences[input.actorId] = sequence;
  const episode = {
    id: `interaction:${input.actorId}:${sequence}`, actorId: input.actorId, kind: input.kind,
    reason: input.reason, evidence: input.evidence, state: INTERACTION_STATE.pending,
    createdAtHour: nowHour, expiresAtHour: nowHour + INTERACTION_OFFER_TTL_HOURS,
    choices: input.choices || defaultChoices(input.kind), outcome: null,
  };
  state.interactions[episode.id] = episode;
  state.interactionCooldowns[cooldownKey] = nowHour + INTERACTION_COOLDOWN_HOURS;
  state.interactionCooldowns.global = nowHour + INTERACTION_COOLDOWN_HOURS;
  state.metrics.initiatedOffers++;
  state.revision++;
  return episode;
}

export function pendingInteraction(state) {
  return Object.values(state?.interactions || {}).find((entry) => entry.state === INTERACTION_STATE.pending) || null;
}

export function advanceInteractions(state, nowHour = state.clock?.worldHours || 0) {
  for (const episode of Object.values(state.interactions || {})) {
    if (episode.state === INTERACTION_STATE.pending && nowHour >= episode.expiresAtHour) {
      episode.state = INTERACTION_STATE.expired;
      episode.outcome = { choice: 'expired', atHour: nowHour };
      state.revision++;
    }
  }
  pruneInteractions(state);
}

export function pruneInteractions(state, limit = 32) {
  const terminal = Object.values(state.interactions || {})
    .filter((entry) => entry.state !== INTERACTION_STATE.pending)
    .sort((a, b) => (b.outcome?.atHour ?? b.createdAtHour) - (a.outcome?.atHour ?? a.createdAtHour));
  for (const episode of terminal.slice(Math.max(0, limit))) {
    if (episode.outcome?.choice) delete state.effectReceipts[`event:${episode.id}:${episode.outcome.choice}`];
    delete state.interactions[episode.id];
  }
}

export function resolveInteraction(state, episodeId, choice, {
  nowHour = state.clock?.worldHours || 0,
  playerId = state.playerId || 'player:local',
} = {}) {
  const episode = state.interactions[episodeId];
  if (!episode) return { applied: false, reason: 'missing' };
  const event = { id: `event:${episodeId}:${choice}`, type: 'interaction.resolved', episodeId, choice, atHour: nowHour };
  return applyLivingWorldEventOnce(state, event, (draft, incoming) => {
    const target = draft.interactions[incoming.episodeId];
    if (target.state !== INTERACTION_STATE.pending) return target.outcome;
    const accepted = incoming.choice !== 'decline' && incoming.choice !== 'ignore';
    target.state = accepted ? INTERACTION_STATE.accepted : INTERACTION_STATE.declined;
    target.outcome = { choice: incoming.choice, accepted, atHour: incoming.atHour };
    draft.projections.interactionOutcomes[incoming.episodeId] = {
      episodeId: incoming.episodeId, kind: target.kind, actorId: target.actorId,
      choice: incoming.choice, accepted, atHour: incoming.atHour,
    };
    if (accepted) {
      applyRelationshipDelta(draft, target.actorId, playerId, {
        familiarity: 0.02, affinity: target.kind === 'confront' ? -0.01 : 0.01,
        obligation: target.kind === 'ask-help' ? 0.04 : 0,
      }, incoming);
      if (target.kind === 'offer-trade' && incoming.choice === 'trade') {
        draft.projections.playerHoldings.tradeGoods = Math.max(0,
          Number(draft.projections.playerHoldings.tradeGoods) || 0) + 1;
      }
    }
    draft.metrics[accepted ? 'acceptedOffers' : 'declinedOffers']++;
    return target.outcome;
  });
}

export function interactionLine(episode, actorName = 'Someone') {
  const lines = {
    'request-directions': `${actorName} unfolds a map. “Could you point me toward the next station?”`,
    'warn-weather': `${actorName} glances at the sky. “Rain is closing in. There is shelter nearby.”`,
    'ask-help': `${actorName} steadies their load. “Could you lend me a hand?”`,
    'offer-trade': `${actorName} lifts a basket. “Would you care to trade?”`,
    'recognize-player': `${actorName} looks twice. “I remember you.”`,
    confront: `${actorName} steps into view. “I saw what happened. We should speak plainly.”`,
  };
  return lines[episode?.kind] || `${actorName} wants your attention.`;
}

function defaultChoices(kind) {
  if (kind === 'offer-trade') return ['trade', 'decline'];
  if (kind === 'request-directions') return ['guide', 'unsure', 'decline'];
  return ['listen', 'decline'];
}
