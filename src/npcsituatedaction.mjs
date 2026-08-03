import { nearestActionAnchor } from './npcactionanchors.mjs';

export const SITUATED_ACTIONS = Object.freeze({
  'shelter-rain': { anchor: 'shelter', duration: 0.008, requires: ['raining'] },
  'drink-stream': { anchor: 'stream', duration: 0.004, requires: ['thirsty'] },
  'consult-map': { anchor: 'map-point', duration: 0.003, item: 'map' },
  'repair-boots': { anchor: 'repair-site', duration: 0.012, item: 'boot-kit' },
  'examine-marker': { anchor: 'trail-marker', duration: 0.004 },
  'wait-train': { anchor: 'platform', duration: 0.02, requires: ['trainDue'] },
  'repair-site': { anchor: 'repair-site', duration: 0.02, item: 'tools' },
});
export const ACTION_STATE = Object.freeze({ planned: 'planned', approaching: 'approaching', acting: 'acting', completed: 'completed', interrupted: 'interrupted', expired: 'expired' });
export const SITUATED_ACTION_COOLDOWN_HOURS = 0.25;

export function situatedActionCandidateFor(state, actor, facts = {}, itemKinds = []) {
  return situatedActionCandidatesFor(state, actor, facts, itemKinds)[0] || null;
}

export function situatedActionCandidatesFor(state, actor, facts = {}, itemKinds = []) {
  const actorId = actor?.identity?.id || actor?.id;
  if (!actorId) return [];
  const available = [];
  if (facts.raining) available.push('shelter-rain');
  if (facts.thirsty && facts.hasStreamAnchor) available.push('drink-stream');
  if (itemKinds.includes('map')) available.push('consult-map');
  if (itemKinds.includes('boot-kit') && facts.bootsNeedRepair) available.push('repair-boots');
  if (facts.hasTrailMarker) available.push('examine-marker');
  if (facts.trainDue) available.push('wait-train');
  if (itemKinds.includes('tools') && facts.hasRepairSite) available.push('repair-site');
  if (!available.length) return [];
  if (available[0] === 'shelter-rain') return available.map((kind) => ({ actorId, kind }));
  const sequence = Number(state.actionSequences?.[actorId]) || 0;
  const rotated = [...available.slice(sequence % available.length), ...available.slice(0, sequence % available.length)];
  return rotated.map((kind) => ({ actorId, kind }));
}

export function planSituatedAction(state, input, { nowHour = state.clock?.worldHours || 0 } = {}) {
  const rule = SITUATED_ACTIONS[input?.kind];
  if (!input?.actorId || !rule) return null;
  const cooldownKey = `${input.actorId}:${input.kind}`;
  if ((state.actionCooldowns?.[cooldownKey] || -Infinity) > nowHour) return null;
  if (Object.values(state.actions || {}).some((action) => action.actorId === input.actorId && !terminal(action.state))) return null;
  if ((rule.requires || []).some((key) => !input.facts?.[key])) return null;
  if (rule.item && !(input.itemKinds || []).includes(rule.item)) return null;
  const found = input.anchorId ? { anchor: state.actionAnchors[input.anchorId], distance: 0 }
    : nearestActionAnchor(state, rule.anchor, input.position || { x: 0, z: 0 }, { maxDistance: input.maxDistance || 80 });
  if (!found?.anchor) return null;
  const occupancy = Object.values(state.actions || {}).filter((action) => action.anchorId === found.anchor.id && !terminal(action.state)).length;
  if (occupancy >= found.anchor.capacity) return null;
  const sequence = (state.actionSequences[input.actorId] || 0) + 1;
  state.actionSequences[input.actorId] = sequence;
  const action = { id: `action:${input.actorId}:${sequence}`, actorId: input.actorId, kind: input.kind,
    anchorId: found.anchor.id, state: found.distance <= 1.5 ? ACTION_STATE.acting : ACTION_STATE.approaching,
    progressHours: 0, durationHours: rule.duration, createdAtHour: nowHour, expiresAtHour: nowHour + 2 };
  state.actions[action.id] = action; state.metrics.situatedActions++; state.revision++;
  state.actionCooldowns[cooldownKey] = nowHour + SITUATED_ACTION_COOLDOWN_HOURS;
  return action;
}

export function advanceSituatedAction(state, actionId, { hours = 0, distance = 0, interruptedBy = null, nowHour = state.clock?.worldHours || 0, facts = null, itemKinds = null } = {}) {
  const action = state.actions[actionId];
  if (!action || terminal(action.state)) return action || null;
  const invalid = validationFailure(action, facts, itemKinds);
  if (!interruptedBy && invalid) interruptedBy = invalid;
  if (interruptedBy) {
    action.state = ACTION_STATE.interrupted; action.interruptedBy = interruptedBy; action.endedAtHour = nowHour;
    state.metrics.activityInterruptions++; state.revision++; pruneSituatedActions(state); return action;
  }
  if (nowHour >= action.expiresAtHour) { action.state = ACTION_STATE.expired; action.endedAtHour = nowHour; state.revision++; pruneSituatedActions(state); return action; }
  if (action.state === ACTION_STATE.approaching && distance <= 1.5) action.state = ACTION_STATE.acting;
  if (action.state === ACTION_STATE.acting) {
    action.progressHours += Math.max(0, hours);
    if (action.progressHours >= action.durationHours) { action.state = ACTION_STATE.completed; action.endedAtHour = nowHour; }
  }
  state.revision++;
  pruneSituatedActions(state);
  return action;
}

export function pruneSituatedActions(state, limit = 64) {
  const finished = Object.values(state.actions || {}).filter((action) => terminal(action.state))
    .sort((a, b) => (b.endedAtHour || 0) - (a.endedAtHour || 0));
  for (const action of finished.slice(Math.max(0, limit))) delete state.actions[action.id];
}

export function activeActionForActor(state, actorId) {
  return Object.values(state?.actions || {}).find((action) => action.actorId === actorId && !terminal(action.state)) || null;
}

export function situatedActionLine(action, actorName = 'Someone') {
  return ({
    'shelter-rain': `${actorName} waits beneath shelter while the rain passes.`,
    'drink-stream': `${actorName} kneels at a safe bank to drink.`,
    'consult-map': `${actorName} unfolds a map and checks the route.`,
    'repair-boots': `${actorName} stops to repair a worn boot.`,
    'examine-marker': `${actorName} studies the trail marker before moving on.`,
    'wait-train': `${actorName} watches the line and waits for the next train.`,
    'repair-site': `${actorName} works at the repair site with their tools.`,
  })[action?.kind] || `${actorName} pauses to attend to something nearby.`;
}

function terminal(state) { return ['completed', 'interrupted', 'expired'].includes(state); }

function validationFailure(action, facts, itemKinds) {
  if (!facts && !itemKinds) return null;
  const rule = SITUATED_ACTIONS[action.kind];
  if ((rule.requires || []).some((key) => !facts?.[key])) return 'precondition-ended';
  if (rule.item && !itemKinds?.includes(rule.item)) return 'required-item-lost';
  if (facts?.anchorEnabled === false) return 'anchor-departed';
  return null;
}
