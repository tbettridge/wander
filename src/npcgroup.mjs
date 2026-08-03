export const GROUP_STATE = Object.freeze({ forming: 'forming', together: 'together', paused: 'paused', splitting: 'splitting', dissolved: 'dissolved' });
export const GROUP_EPISODES = Object.freeze(['meet', 'walk', 'argue', 'split', 'accompany-risk']);
import { applyLivingWorldEventOnce } from './livingworldstate.mjs';
import { applyRelationshipDelta, rememberSocialMemory } from './npcsocialmemory.mjs';

export function groupForActor(state, actorId) {
  return Object.values(state?.groups || {}).find((group) => group.state !== GROUP_STATE.dissolved && group.memberIds.includes(actorId)) || null;
}

export function createTravelGroup(state, input, { nowHour = state.clock?.worldHours || 0 } = {}) {
  const memberIds = [...new Set(input?.memberIds || [])];
  if (memberIds.length < 2 || memberIds.length > 4) throw new RangeError('Travel groups require 2-4 unique members.');
  if (memberIds.some((id) => groupForActor(state, id))) return null;
  const leaderId = input.leaderId && memberIds.includes(input.leaderId) ? input.leaderId : [...memberIds].sort()[0];
  const sequence = (state.groupSequences[leaderId] || 0) + 1;
  state.groupSequences[leaderId] = sequence;
  const group = {
    id: `group:${leaderId}:${sequence}`, memberIds, leaderId, state: GROUP_STATE.forming,
    episode: input.episode || 'meet', route: input.route || null, progress: Number(input.progress) || 0,
    pace: Math.max(0.1, Number(input.pace) || 1), createdAtHour: nowHour, updatedAtHour: nowHour,
  };
  state.groups[group.id] = group;
  state.metrics.groupsFormed++;
  state.revision++;
  return group;
}

export function advanceTravelGroup(group, dt, members = []) {
  if (!group || group.state === GROUP_STATE.dissolved || group.state === GROUP_STATE.paused) return group;
  if (group.state === GROUP_STATE.forming) group.state = GROUP_STATE.together;
  const paces = members.map((member) => Number(member.pace)).filter(Number.isFinite);
  const slowest = paces.length ? Math.min(...paces) : group.pace;
  group.pace = Math.max(0.1, slowest);
  group.progress = Math.min(1, group.progress + Math.max(0, dt) * group.pace);
  return group;
}

export function formationOffset(group, actorId) {
  const index = group.memberIds.indexOf(actorId);
  if (index < 0) return null;
  if (index === group.memberIds.indexOf(group.leaderId)) return { forward: 0, side: 0 };
  const rank = index + (index < group.memberIds.indexOf(group.leaderId) ? 1 : 0);
  return { forward: -0.75 * Math.ceil(rank / 2), side: (rank % 2 ? -1 : 1) * 0.65 };
}

/** Follow a rotating formation slot without rotating the follower through space. */
export function advanceFormationFollower(followerJourney, leaderJourney, offset, dt, {
  baseSpeed = 1.55, catchupSpeed = 1.45,
} = {}) {
  const targetX = leaderJourney.x + Math.cos(leaderJourney.heading) * offset.side
    + Math.sin(leaderJourney.heading) * offset.forward;
  const targetZ = leaderJourney.z - Math.sin(leaderJourney.heading) * offset.side
    + Math.cos(leaderJourney.heading) * offset.forward;
  const dx = targetX - followerJourney.x, dz = targetZ - followerJourney.z;
  const distance = Math.hypot(dx, dz);
  const maxFollowSpeed = baseSpeed + Math.min(catchupSpeed, distance * 0.65);
  const accepted = Math.min(distance, maxFollowSpeed * Math.max(0, dt));
  if (distance > 1e-5 && accepted > 0) {
    followerJourney.x += dx / distance * accepted;
    followerJourney.z += dz / distance * accepted;
    followerJourney.heading = Math.atan2(dx, dz);
  }
  followerJourney.phase = leaderJourney.phase;
  return { targetX, targetZ, distance, accepted, maxFollowSpeed };
}

export function removeGroupMember(state, groupId, actorId, { nowHour = state.clock?.worldHours || 0 } = {}) {
  const group = state.groups[groupId];
  if (!group || !group.memberIds.includes(actorId)) return false;
  group.memberIds = group.memberIds.filter((id) => id !== actorId);
  group.episode = 'split'; group.updatedAtHour = nowHour;
  if (group.memberIds.length < 2) group.state = GROUP_STATE.dissolved;
  else {
    group.state = GROUP_STATE.splitting;
    if (!group.memberIds.includes(group.leaderId)) group.leaderId = [...group.memberIds].sort()[0];
  }
  state.revision++;
  return true;
}

export function setGroupEpisode(state, groupId, episode, { paused = false, nowHour = state.clock?.worldHours || 0 } = {}) {
  if (!GROUP_EPISODES.includes(episode)) throw new TypeError('Unsupported group episode.');
  const group = state.groups[groupId];
  if (!group) return null;
  group.episode = episode; group.state = paused ? GROUP_STATE.paused : GROUP_STATE.together; group.updatedAtHour = nowHour;
  state.revision++;
  return group;
}

export function applyGroupEpisodeEvent(state, groupId, event, { nowHour = state.clock?.worldHours || 0 } = {}) {
  const group = state.groups?.[groupId];
  if (!group || !event?.id || !event?.type) return { applied: false, reason: 'missing' };
  const result = applyLivingWorldEventOnce(state, { ...event, groupId, atHour: nowHour }, (draft, incoming) => {
    const current = draft.groups[incoming.groupId];
    if (!current || current.state === GROUP_STATE.dissolved) return { code: 'already-dissolved' };
    if (incoming.type === 'group.rendezvous') {
      current.state = GROUP_STATE.together; current.episode = 'walk';
    } else if (incoming.type === 'group.risk-entered') {
      current.state = GROUP_STATE.together; current.episode = 'accompany-risk'; current.riskScore = Number(incoming.riskScore) || 0;
    } else if (incoming.type === 'group.risk-cleared') {
      current.state = GROUP_STATE.together; current.episode = 'walk'; current.riskScore = 0;
    } else if (incoming.type === 'group.argument-started') {
      current.state = GROUP_STATE.paused; current.episode = 'argue'; current.argumentEndsAtHour = incoming.atHour + 0.01;
    } else if (incoming.type === 'group.argument-resolved') {
      current.state = incoming.split ? GROUP_STATE.splitting : GROUP_STATE.together;
      current.episode = incoming.split ? 'split' : 'walk'; current.argumentEndsAtHour = null;
    } else if (incoming.type === 'group.split-completed') {
      current.state = GROUP_STATE.dissolved; current.episode = 'split';
    } else return { code: 'ignored' };
    current.updatedAtHour = incoming.atHour;
    current.episodeHistory = [...(current.episodeHistory || []), {
      eventId: incoming.id, type: incoming.type, atHour: incoming.atHour,
    }].slice(-8);
    if (incoming.type === 'group.rendezvous' || incoming.type === 'group.argument-started') {
      const delta = incoming.type === 'group.rendezvous'
        ? { familiarity: 0.03, affinity: 0.01 }
        : { familiarity: 0.01, affinity: -0.03 };
      for (const ownerId of current.memberIds) for (const subjectId of current.memberIds) {
        if (ownerId !== subjectId) applyRelationshipDelta(draft, ownerId, subjectId, delta, incoming);
      }
    }
    if (incoming.type === 'group.argument-resolved' && incoming.split) {
      for (const ownerId of current.memberIds) rememberSocialMemory(draft, ownerId, {
        id: `memory:${ownerId}:group-history`, ownerId,
        subject: { kind: 'group', id: current.id }, predicate: 'group.split',
        object: { memberIds: current.memberIds }, summary: 'the travelling group argued and split',
        source: { kind: 'world-event', id: incoming.id }, provenance: 'observed',
        originEventId: incoming.id, lineageId: `claim:group-history:${ownerId}`, confidence: 1,
        salience: 0.55, privacy: 'public', hopCount: 0,
        createdAtHour: incoming.atHour, lastRecalledHour: incoming.atHour, expiresAtHour: incoming.atHour + 168,
      }, { nowHour: incoming.atHour });
    }
    return { code: incoming.type, state: current.state, episode: current.episode };
  });
  pruneDissolvedGroups(state);
  return result;
}

export function pruneDissolvedGroups(state, limit = 64) {
  const dissolved = Object.values(state.groups || {}).filter((group) => group.state === GROUP_STATE.dissolved)
    .sort((a, b) => (b.updatedAtHour || 0) - (a.updatedAtHour || 0));
  for (const group of dissolved.slice(Math.max(0, limit))) {
    for (const event of group.episodeHistory || []) delete state.effectReceipts[event.eventId];
    delete state.groups[group.id];
  }
}

export function groupEpisodeLine(group, names = []) {
  const who = names.filter(Boolean).join(' and ') || 'The travellers';
  return ({
    meet: `${who} meet at the roadside and compare where they are headed.`,
    walk: `${who} settle into the pace of the slowest walker.`,
    argue: `${who} stop and disagree about the way ahead.`,
    split: `${who} part and continue separately.`,
    'accompany-risk': `${who} close ranks for the difficult stretch ahead.`,
  })[group?.episode] || `${who} travel together.`;
}

export function routeRiskScore(edge = {}) {
  return Math.max(0, (edge.ford ? 0.45 : 0) + (edge.grade > 0.16 ? 0.25 : 0) + (edge.night ? 0.2 : 0) + (edge.storm ? 0.35 : 0));
}
