export const SOCIAL_MEMORY_VERSION = 2;
export const SOCIAL_MEMORY_LIMIT = 32;
export const RELATIONSHIP_VERSION = 1;

export function relationshipKey(ownerId, subjectId) {
  return `${String(ownerId || '')}|${String(subjectId || '')}`;
}

export function relationshipBetween(state, ownerId, subjectId) {
  const edge = state?.relationships?.[relationshipKey(ownerId, subjectId)];
  return edge ? normalizeRelationship(edge, ownerId, subjectId) : null;
}

export function applyRelationshipDelta(state, ownerId, subjectId, deltas = {}, event = {}) {
  if (!ownerId || !subjectId || ownerId === subjectId) return null;
  const key = relationshipKey(ownerId, subjectId);
  const edge = normalizeRelationship(state.relationships[key], ownerId, subjectId);
  edge.familiarity = clamp(edge.familiarity + finite(deltas.familiarity), 0, 1);
  edge.affinity = clamp(edge.affinity + finite(deltas.affinity), -1, 1);
  edge.trust = clamp(edge.trust + finite(deltas.trust), -1, 1);
  edge.obligation = clamp(edge.obligation + finite(deltas.obligation), -1, 1);
  if (Array.isArray(deltas.tags)) edge.tags = uniqueStrings([...edge.tags, ...deltas.tags], 8);
  edge.lastInteractionHour = finite(event.atHour ?? edge.lastInteractionHour);
  edge.lastEventId = event.id ? String(event.id) : edge.lastEventId;
  state.relationships[key] = edge;
  return edge;
}

export function relationshipBand(edge) {
  const value = edge ? normalizeRelationship(edge, edge.ownerId, edge.subjectId) : null;
  if (!value) return 'stranger';
  if (value.trust < -0.3 || value.affinity < -0.35) return 'wary';
  if (value.obligation > 0.45) return 'indebted';
  if (value.trust > 0.45) return 'trusted';
  if (value.familiarity >= 0.18) return 'familiar';
  return 'acquainted';
}

export function normalizeRelationship(value, ownerId = value?.ownerId, subjectId = value?.subjectId) {
  return {
    version: RELATIONSHIP_VERSION,
    ownerId: String(ownerId || ''),
    subjectId: String(subjectId || ''),
    familiarity: clamp(finite(value?.familiarity), 0, 1),
    affinity: clamp(finite(value?.affinity), -1, 1),
    trust: clamp(finite(value?.trust), -1, 1),
    obligation: clamp(finite(value?.obligation), -1, 1),
    tags: uniqueStrings(value?.tags, 8),
    lastInteractionHour: finite(value?.lastInteractionHour),
    lastEventId: value?.lastEventId ? String(value.lastEventId) : null,
  };
}

export function normalizeSocialMemory(value, ownerId = value?.ownerId) {
  if (!value || typeof value !== 'object') return null;
  const owner = String(ownerId || '');
  const lineageId = clean(value.lineageId, 180);
  const predicate = clean(value.predicate, 80);
  if (!owner || !lineageId || !predicate) return null;
  const source = entityRef(value.source) || { kind: 'unknown', id: 'unknown' };
  return {
    version: SOCIAL_MEMORY_VERSION,
    id: clean(value.id, 220) || `memory:${owner}:${lineageId}`,
    ownerId: owner,
    subject: entityRef(value.subject) || { kind: 'unknown', id: 'unknown' },
    predicate,
    object: plain(value.object),
    summary: clean(value.summary, 220),
    source,
    sourceChain: normalizeSourceChain(value.sourceChain, source),
    provenance: ['observed', 'told', 'player-claim', 'legacy'].includes(value.provenance)
      ? value.provenance : 'legacy',
    originEventId: value.originEventId ? clean(value.originEventId, 220) : null,
    lineageId,
    confidence: clamp(finite(value.confidence), 0, 1),
    salience: clamp(finite(value.salience), 0, 1),
    privacy: ['public', 'personal', 'private'].includes(value.privacy)
      ? value.privacy : 'personal',
    hopCount: Math.max(0, Math.floor(finite(value.hopCount))),
    createdAtHour: finite(value.createdAtHour),
    lastRecalledHour: finite(value.lastRecalledHour ?? value.createdAtHour),
    expiresAtHour: value.expiresAtHour == null ? null : finite(value.expiresAtHour),
  };
}

export function rememberSocialMemory(state, ownerId, value, { nowHour = value?.createdAtHour ?? 0 } = {}) {
  const memory = normalizeSocialMemory(value, ownerId);
  if (!memory) return null;
  const list = state.memories[ownerId] ||= [];
  const at = list.findIndex((entry) => entry?.lineageId === memory.lineageId);
  if (at >= 0) {
    const existing = normalizeSocialMemory(list[at], ownerId);
    memory.createdAtHour = Math.min(existing.createdAtHour, memory.createdAtHour);
    memory.lastRecalledHour = Math.max(existing.lastRecalledHour, nowHour);
    memory.confidence = Math.max(existing.confidence, memory.confidence);
    memory.salience = Math.max(existing.salience, memory.salience);
    list[at] = memory;
  } else {
    list.push(memory);
  }
  const evicted = evictSocialMemories(list, nowHour);
  if (evicted > 0) {
    state.metrics ||= {};
    state.metrics.memoryEvictions = Math.max(0, Math.floor(finite(state.metrics.memoryEvictions))) + evicted;
  }
  return memory;
}

export function memoriesFor(state, ownerId, { nowHour = state?.clock?.worldHours ?? 0, limit = SOCIAL_MEMORY_LIMIT } = {}) {
  const list = Array.isArray(state?.memories?.[ownerId]) ? state.memories[ownerId] : [];
  return list.map((value) => normalizeSocialMemory(value, ownerId)).filter(Boolean)
    .filter((memory) => memory.expiresAtHour == null || memory.expiresAtHour > nowHour)
    .sort((a, b) => memoryScore(b, nowHour) - memoryScore(a, nowHour)
      || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}

export function migrateLegacyNpcMemory(state, npcId, legacy, { nowHour = 0 } = {}) {
  if (!legacy || typeof legacy !== 'object') return [];
  const migrated = [];
  const fields = ['playerFacts', 'npcFacts', 'quests', 'landmarks', 'worldFacts'];
  for (const field of fields) {
    for (const text of Array.isArray(legacy[field]) ? legacy[field] : []) {
      const summary = clean(text, 220);
      if (!summary) continue;
      const lineageId = `legacy:${field}:${hashText(summary.toLowerCase()).toString(16)}`;
      const memory = rememberSocialMemory(state, npcId, {
        id: `memory:${npcId}:${lineageId}`,
        ownerId: npcId,
        subject: { kind: field === 'playerFacts' ? 'player' : 'legacy', id: field === 'playerFacts' ? 'player:local' : field },
        predicate: `legacy.${field}`,
        object: { text: summary },
        summary,
        source: { kind: 'legacy-memory', id: npcId },
        provenance: 'legacy',
        originEventId: null,
        lineageId,
        confidence: 0.65,
        salience: field === 'quests' ? 0.75 : 0.45,
        privacy: 'personal',
        hopCount: 0,
        createdAtHour: nowHour,
        lastRecalledHour: nowHour,
        expiresAtHour: null,
      }, { nowHour });
      if (memory) migrated.push(memory);
    }
  }
  return migrated;
}

export function socialContextFor(state, ownerId, {
  playerId = 'player:local',
  nowHour = state?.clock?.worldHours ?? 0,
  memoryLimit = 8,
  peopleLimit = 6,
} = {}) {
  const people = Object.values(state?.relationships || {})
    .filter((edge) => edge?.ownerId === ownerId)
    .map((edge) => normalizeRelationship(edge, ownerId, edge.subjectId))
    .sort((a, b) => b.familiarity - a.familiarity || a.subjectId.localeCompare(b.subjectId))
    .slice(0, peopleLimit)
    .map((edge) => ({
      id: edge.subjectId,
      name: state.entities?.[edge.subjectId]?.name || edge.subjectId,
      role: state.entities?.[edge.subjectId]?.role || '',
      relationship: relationshipBand(edge),
    }));
  return {
    relationshipToPlayer: relationshipBand(relationshipBetween(state, ownerId, playerId)),
    relevantPeople: people,
    memories: memoriesFor(state, ownerId, { nowHour, limit: memoryLimit }).map((memory) => ({
      id: memory.id,
      statement: memory.summary || memory.object?.text || memory.predicate,
      subjectId: memory.subject.id,
      provenance: memory.provenance,
      sourceId: memory.source.id,
      sourceName: state.entities?.[memory.source.id]?.name || memory.source.id,
      confidence: confidenceBand(memory.confidence),
    })),
  };
}

function evictSocialMemories(list, nowHour) {
  const normalized = list.map((memory) => normalizeSocialMemory(memory, memory?.ownerId)).filter(Boolean);
  normalized.sort((a, b) => {
    const aExpired = a.expiresAtHour != null && a.expiresAtHour <= nowHour;
    const bExpired = b.expiresAtHour != null && b.expiresAtHour <= nowHour;
    if (aExpired !== bExpired) return aExpired ? 1 : -1;
    return memoryScore(b, nowHour) - memoryScore(a, nowHour) || a.id.localeCompare(b.id);
  });
  const retained = normalized.slice(0, SOCIAL_MEMORY_LIMIT);
  const evicted = Math.max(0, normalized.length - retained.length);
  list.splice(0, list.length, ...retained);
  return evicted;
}

function normalizeSourceChain(values, source) {
  const chain = (Array.isArray(values) ? values : [])
    .map(entityRef).filter(Boolean).slice(-4);
  if (!chain.length && source) chain.push(source);
  return chain;
}

function memoryScore(memory, nowHour) {
  const age = Math.max(0, nowHour - memory.lastRecalledHour);
  const recency = 1 / (1 + age / 24);
  const durable = memory.predicate === 'commitment.outcome' ? 0.12 : 0;
  return memory.salience * 0.45 + memory.confidence * 0.3 + recency * 0.25 + durable;
}

function confidenceBand(value) {
  if (value >= 0.85) return 'certain';
  if (value >= 0.6) return 'likely';
  if (value >= 0.35) return 'uncertain';
  return 'doubtful';
}

function entityRef(value) {
  if (!value?.kind || !value?.id) return null;
  return { kind: clean(value.kind, 40), id: clean(value.id, 180) };
}

function uniqueStrings(values, limit) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => clean(value, 48)).filter(Boolean))]
    .slice(0, limit);
}

function clean(value, limit) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, limit).trim()
    : '';
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? structuredClone(value)
    : {};
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
