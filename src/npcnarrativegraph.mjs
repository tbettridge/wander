/**
 * Disposable, read-only narrative index. The supplied records remain canonical;
 * this graph only makes a small, speaker-scoped retrieval packet from them.
 */
export const NPC_NARRATIVE_GRAPH_VERSION = 1;

export const FACT_ACCESS_MODE = Object.freeze({
  speakable: 'speakable',
  consistencyOnly: 'consistency-only',
  inaccessible: 'inaccessible',
});

const DEFAULT_LIMITS = Object.freeze({ maxHops: 2, maxFacts: 8, maxEntities: 8, maxTopics: 8 });
const UNSPEAKABLE_PROVENANCE = new Set(['inferred', 'model', 'generated', 'unverified']);
const RESTRICTED_VISIBILITY = new Set(['restricted', 'secret']);

/** Build a deterministic derived graph. It must be rebuilt after canonical state changes. */
export function buildNpcNarrativeGraph(source = {}, options = {}) {
  const worldRevision = String(options.worldRevision ?? source.worldRevision ?? source.revision ?? '0');
  const entities = new Map();
  const facts = new Map();
  const relationships = new Map();
  const adjacency = new Map();

  for (const raw of sortedRecords(communityEntities(source.communityRecords ?? source.entities ?? source.residents))) {
    const entity = normalizeEntity(raw);
    if (!entity) continue;
    entities.set(entity.id, entity);
    adjacency.set(entityNode(entity.id), new Set());
    const fields = [entity.role && `role: ${entity.role}`, entity.workplace && `works at ${entity.workplace}`]
      .filter(Boolean).join('; ');
    addFact(facts, adjacency, normalizeFact({
      id: `profile:${entity.id}`,
      predicate: 'entity.profile',
      statement: fields ? `${entity.name}; ${fields}` : entity.name,
      subjectId: entity.id,
      entityIds: [entity.id],
      topics: [entity.role, entity.workplace],
      visibility: entity.visibility ?? 'public',
      privacy: 'public', provenance: 'canonical', confidence: 1, salience: 0.35,
    }, 'profile'));
  }

  for (const raw of sortedRecords(source.relationships)) {
    const edge = normalizeRelationship(raw);
    if (!edge) continue;
    relationships.set(`${edge.ownerId}|${edge.subjectId}`, edge);
    link(adjacency, entityNode(edge.ownerId), entityNode(edge.subjectId));
  }

  const memoryRecords = flattenOwnedRecords(source.socialMemories ?? source.memories);
  for (const raw of sortedRecords(memoryRecords)) {
    addFact(facts, adjacency, normalizeMemory(raw));
  }
  for (const raw of sortedRecords(source.commitments)) {
    addFact(facts, adjacency, normalizeCommitment(raw, entities));
  }
  for (const raw of sortedRecords(source.outcomes)) {
    addFact(facts, adjacency, normalizeFact(raw, 'outcome'));
  }
  const durable = source.narrativeFacts ?? source.durableNarrativeFacts ?? source.durableFacts ?? source.facts;
  for (const raw of sortedRecords(durable)) {
    addFact(facts, adjacency, normalizeFact(raw, 'fact'));
  }

  // Indexes are derived after sorting, so object/array insertion order is immaterial.
  const aliases = new Map();
  for (const entity of sortedValues(entities)) {
    for (const alias of entity.aliases) addIndex(aliases, alias, entity.id);
  }
  const topicIndex = new Map();
  for (const fact of sortedValues(facts)) {
    for (const topic of fact.topics) addIndex(topicIndex, topic, fact.id);
  }

  return {
    version: NPC_NARRATIVE_GRAPH_VERSION,
    authoritative: false,
    worldRevision,
    entities,
    facts,
    relationships,
    adjacency,
    aliases,
    topicIndex,
  };
}

/** Resolve explicit IDs and the longest name/workplace aliases in text. */
export function resolveNarrativeEntities(graph, text, { maxEntities = DEFAULT_LIMITS.maxEntities } = {}) {
  const normalized = normalizeText(text);
  const resolved = new Set();
  const ambiguous = [];
  const matches = [];
  const candidates = [...(graph?.aliases ?? [])]
    .filter(([alias]) => containsPhrase(normalized, alias))
    .sort(([a], [b]) => b.length - a.length || a.localeCompare(b));
  const acceptedAliases = [];
  for (const [alias, ids] of candidates) {
    // A full name (or workplace) owns its span. Do not let its shorter first
    // name/surname aliases reintroduce ambiguity after the longer match won.
    if (acceptedAliases.some((longer) => phraseContains(longer, alias))) continue;
    acceptedAliases.push(alias);
    const candidateIds = [...ids].sort();
    if (candidateIds.length === 1) {
      resolved.add(candidateIds[0]);
      matches.push({ text: alias, entityId: candidateIds[0] });
    } else {
      ambiguous.push({ text: alias, candidateIds });
    }
  }
  const entityIds = [...resolved].sort().slice(0, positiveInt(maxEntities, DEFAULT_LIMITS.maxEntities));
  return {
    entityIds,
    matches: matches.filter((entry) => entityIds.includes(entry.entityId))
      .sort((a, b) => a.text.localeCompare(b.text) || a.entityId.localeCompare(b.entityId)),
    ambiguous: dedupeAmbiguities(ambiguous),
  };
}

/** Determine access without modifying or trusting the underlying fact as authority. */
export function narrativeFactAccess(graph, factOrId, speakerId) {
  const fact = typeof factOrId === 'string' ? graph?.facts?.get(factOrId) : factOrId;
  const speaker = String(speakerId ?? '');
  if (!fact || !speaker || fact.visibility === 'inaccessible' || fact.status === 'retracted') {
    return FACT_ACCESS_MODE.inaccessible;
  }
  const subjects = new Set(fact.subjectIds ?? []);
  const owners = new Set(fact.ownerIds ?? []);
  const participants = new Set([...subjects, ...owners]);
  const explicitlyKnown = fact.knownBy.includes(speaker);
  const publicKnowledge = ['public', 'community'].includes(fact.visibility)
    && fact.privacy === 'public';
  const sharedKnowledge = fact.visibility === 'shared' && fact.knownBy.some((knowerId) =>
    relationshipAllowsDisclosure(graph, speaker, knowerId));
  const participantKnowledge = participants.has(speaker) && fact.knownBy.length === 0;
  const subjectKnowledge = subjects.has(speaker) && fact.predicate === 'fact';
  if (!(explicitlyKnown || publicKnowledge || sharedKnowledge || participantKnowledge || subjectKnowledge)) {
    return FACT_ACCESS_MODE.inaccessible;
  }

  if (UNSPEAKABLE_PROVENANCE.has(fact.provenance) || fact.status === 'disputed'
    || (subjectKnowledge && !explicitlyKnown && fact.status === 'asserted')) {
    return FACT_ACCESS_MODE.consistencyOnly;
  }
  if (RESTRICTED_VISIBILITY.has(fact.visibility) && !participants.has(speaker)) {
    return FACT_ACCESS_MODE.consistencyOnly;
  }
  if (fact.privacy === 'private' && !participants.has(speaker)) return FACT_ACCESS_MODE.consistencyOnly;
  if (fact.privacy === 'personal' && !participants.has(speaker) && !sharedKnowledge) {
    const related = fact.subjectIds.some((subjectId) => relationshipAllowsDisclosure(graph, speaker, subjectId));
    if (!related) return FACT_ACCESS_MODE.consistencyOnly;
  }
  return FACT_ACCESS_MODE.speakable;
}

/** A conversation-owned cache. Passing it is optional and never changes source state. */
export function createNarrativeRetrievalCache() {
  return { worldRevision: null, entries: new Map() };
}

/**
 * Retrieve at most two graph hops and return JSON-safe data only. Inaccessible
 * facts are omitted; consistency-only facts are explicitly separated.
 */
export function retrieveNpcNarrative(graph, request = {}, cache = request.cache) {
  if (!graph?.facts || !graph?.entities) throw new TypeError('A narrative graph is required.');
  const speakerId = String(request.speakerId ?? request.npcId ?? '');
  const text = String(request.text ?? request.query ?? '');
  const maxHops = clampInt(request.maxHops, 1, 2, DEFAULT_LIMITS.maxHops);
  const maxFacts = clampInt(request.maxFacts, 1, 64, DEFAULT_LIMITS.maxFacts);
  const conversationId = String(request.conversationId ?? 'default');
  const cacheKey = stableKey({
    conversationId, speakerId, subjectId: String(request.subjectId ?? ''),
    entityIds: uniqueStrings(request.entityIds).sort(), text: normalizeText(text),
    maxHops, maxFacts,
    maxEntities: positiveInt(request.maxEntities, DEFAULT_LIMITS.maxEntities),
    maxTopics: positiveInt(request.maxTopics, DEFAULT_LIMITS.maxTopics),
  });
  if (cache?.entries instanceof Map) {
    if (cache.worldRevision !== graph.worldRevision) {
      cache.entries.clear();
      cache.worldRevision = graph.worldRevision;
    }
    const cached = cache.entries.get(cacheKey);
    if (cached) return cloneJson({ ...cached, cacheHit: true });
  }

  const resolution = resolveNarrativeEntities(graph, text, request);
  const queryTerms = significantTerms(text);
  const topics = resolveTopics(graph, queryTerms, request.maxTopics);
  const seeds = uniqueStrings([speakerId, request.subjectId, ...(request.entityIds ?? []), ...resolution.entityIds])
    .filter((id) => graph.entities.has(id));
  const distances = graphDistances(graph, seeds, maxHops);
  const candidates = new Map();
  for (const [node, hops] of distances) {
    if (node.startsWith('f:')) candidates.set(node.slice(2), hops);
  }
  // Text/topic matching may retrieve a fact without an entity mention, but is
  // still considered one retrieval hop and remains subject to access control.
  for (const fact of graph.facts.values()) {
    if (termOverlap(queryTerms, fact.searchTerms) > 0) {
      candidates.set(fact.id, Math.min(candidates.get(fact.id) ?? 1, 1));
    }
  }

  const ranked = [...candidates].map(([id, hops]) => {
    const fact = graph.facts.get(id);
    const access = narrativeFactAccess(graph, fact, speakerId);
    const overlap = termOverlap(queryTerms, fact.searchTerms);
    const entityMatch = fact.entityIds.some((id) => resolution.entityIds.includes(id)) ? 1 : 0;
    const score = overlap * 100 + entityMatch * 25 + (maxHops - hops + 1) * 8
      + fact.salience * 5 + fact.confidence * 3;
    return { fact, hops, access, score };
  }).filter((item) => item.access !== FACT_ACCESS_MODE.inaccessible)
    .sort((a, b) => b.score - a.score || a.hops - b.hops || a.fact.id.localeCompare(b.fact.id));
  const selected = ranked.slice(0, maxFacts);
  const allFacts = selected.map(toPacketFact);
  const packet = {
    version: NPC_NARRATIVE_GRAPH_VERSION,
    worldRevision: graph.worldRevision,
    authoritative: false,
    speakerId,
    query: {
      text,
      entityIds: resolution.entityIds,
      ambiguous: resolution.ambiguous,
      topics,
    },
    // Split by access and never as one combined list. A `facts` union used to
    // ride along beside these two, which meant every retrieved fact was
    // serialized twice into the model's turn — about half the packet — and put
    // consistency-only statements one careless read away from being spoken.
    speakable: allFacts.filter((fact) => fact.access === FACT_ACCESS_MODE.speakable),
    consistencyOnly: allFacts.filter((fact) => fact.access === FACT_ACCESS_MODE.consistencyOnly),
    limits: { maxHops, maxFacts },
    truncated: ranked.length > selected.length,
    cacheHit: false,
  };
  if (cache?.entries instanceof Map) cache.entries.set(cacheKey, cloneJson(packet));
  return packet;
}

// Concise aliases for callers that do not use the NPC-prefixed API.
export const buildNarrativeGraph = buildNpcNarrativeGraph;
export const resolveEntitiesFromText = resolveNarrativeEntities;
export const retrieveNarrativeContext = retrieveNpcNarrative;
export const factAccessMode = narrativeFactAccess;

function normalizeEntity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = clean(raw.id ?? raw.identity?.id);
  if (!id) return null;
  const name = clean(raw.name ?? raw.identity?.name ?? id);
  const workplace = clean(raw.workplace?.name ?? raw.workplace ?? raw.workplaceName
    ?? raw.stationName ?? raw.work?.name);
  const role = clean(raw.role ?? raw.occupation ?? raw.identity?.role);
  const nameParts = normalizeText(name).split(' ').filter(Boolean);
  const aliases = uniqueStrings([
    id, name, ...nameParts, workplace,
    raw.family?.surname, raw.household?.surname,
    ...(raw.aliases ?? []), ...(raw.surnames ?? []),
  ].map(normalizeText).filter(Boolean)).sort();
  return { id, name, workplace, role, visibility: clean(raw.visibility) || 'public', aliases };
}

function normalizeRelationship(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ownerId = clean(raw.ownerId ?? raw.fromId);
  const subjectId = clean(raw.subjectId ?? raw.toId);
  if (!ownerId || !subjectId) return null;
  return {
    ownerId, subjectId,
    trust: clampNumber(raw.trust, -1, 1),
    familiarity: clampNumber(raw.familiarity, 0, 1),
    tags: uniqueStrings(raw.tags).sort(),
  };
}

function normalizeMemory(raw) {
  const ownerId = clean(raw?.ownerId ?? raw?.__ownerId);
  return normalizeFact({
    ...raw,
    id: raw?.id,
    statement: raw?.summary ?? raw?.statement ?? raw?.object?.text,
    subjectId: raw?.subject?.id ?? raw?.subjectId,
    entityIds: [ownerId, raw?.subject?.id, raw?.source?.id],
    ownerIds: [ownerId],
    knownBy: [ownerId],
    sourceId: raw?.source?.id ?? raw?.originEventId,
  }, 'memory');
}

function normalizeCommitment(raw, entities) {
  const actorId = clean(raw?.actorId);
  const targetId = clean(raw?.target?.id ?? raw?.targetId);
  const targetName = entities.get(targetId)?.name ?? targetId;
  const outcome = raw?.outcome;
  const statement = clean(raw?.summary) || [actorId, raw?.purposeKey ?? raw?.kind, targetName,
    outcome?.code ?? outcome?.status].filter(Boolean).join(' ');
  return normalizeFact({
    ...raw,
    statement,
    predicate: outcome ? 'commitment.outcome' : 'commitment.state',
    entityIds: [actorId, targetId], subjectIds: [actorId, targetId], ownerIds: [actorId],
    knownBy: raw?.knownBy ?? [actorId, targetId],
    provenance: 'canonical', privacy: raw?.privacy ?? 'personal',
    sourceId: outcome?.effectEventIds?.[0] ?? raw?.id,
  }, 'commitment');
}

function normalizeFact(raw, prefix) {
  if (!raw || typeof raw !== 'object') return null;
  const statement = clean(raw.statement ?? raw.summary ?? raw.text ?? raw.object?.text);
  const id = clean(raw.id ?? raw.factId ?? (statement && `${prefix}:${hashText(statement)}`));
  if (!id || !statement) return null;
  const subjectIds = uniqueStrings([
    ...(raw.subjectIds ?? []), raw.subjectId, raw.subject?.id,
  ]).sort();
  const entityIds = uniqueStrings([
    ...subjectIds, ...(raw.entityIds ?? []), raw.actorId, raw.targetId,
  ]).sort();
  const topics = uniqueStrings([
    ...(raw.topics ?? []), ...(raw.tags ?? []), raw.topic, raw.predicate, raw.factKey, raw.placeKey,
  ].map(normalizeText).filter(Boolean)).sort();
  const visibility = normalizeVisibility(raw.visibility ?? raw.access);
  const structuredProvenance = raw.provenance && typeof raw.provenance === 'object'
    ? raw.provenance : null;
  return {
    id, statement,
    predicate: clean(raw.predicate ?? raw.type) || prefix,
    subjectIds,
    entityIds,
    ownerIds: uniqueStrings(raw.ownerIds ?? (raw.ownerId ? [raw.ownerId] : [])).sort(),
    topics,
    knownBy: uniqueStrings(raw.knownBy).sort(),
    visibility,
    privacy: normalizePrivacy(raw.privacy ?? (visibility === 'private' ? 'private'
      : visibility === 'shared' ? 'personal' : 'public')),
    provenance: normalizeText(structuredProvenance?.kind ?? structuredProvenance?.type
      ?? (structuredProvenance?.speakerId ? 'npc-statement' : raw.provenance) ?? 'canonical'),
    status: normalizeText(raw.status),
    sourceId: clean(raw.sourceId ?? raw.source?.id ?? raw.originEventId
      ?? structuredProvenance?.speakerId),
    confidence: clampNumber(raw.confidence ?? 1, 0, 1),
    salience: clampNumber(raw.salience ?? 0.5, 0, 1),
    searchTerms: significantTerms([statement, raw.predicate, ...topics, ...entityIds].join(' ')),
  };
}

function addFact(facts, adjacency, fact) {
  if (!fact || facts.has(fact.id)) return;
  facts.set(fact.id, fact);
  const factKey = factNode(fact.id);
  adjacency.set(factKey, new Set());
  for (const id of fact.entityIds) link(adjacency, factKey, entityNode(id));
}

function graphDistances(graph, entityIds, maxHops) {
  const distances = new Map();
  let frontier = entityIds.map(entityNode).sort();
  for (const node of frontier) distances.set(node, 0);
  for (let depth = 1; depth <= maxHops; depth++) {
    const next = [];
    for (const node of frontier) {
      for (const adjacent of [...(graph.adjacency.get(node) ?? [])].sort()) {
        if (distances.has(adjacent)) continue;
        distances.set(adjacent, depth);
        next.push(adjacent);
      }
    }
    frontier = next.sort();
  }
  return distances;
}

function relationshipAllowsDisclosure(graph, speakerId, subjectId) {
  if (speakerId === subjectId) return true;
  const edge = graph.relationships.get(`${speakerId}|${subjectId}`);
  return Boolean(edge && (edge.trust >= 0.25 || edge.tags.some((tag) =>
    ['family', 'household', 'partner', 'trusted'].includes(normalizeText(tag)))));
}

function resolveTopics(graph, queryTerms, maximum) {
  const maxTopics = positiveInt(maximum, DEFAULT_LIMITS.maxTopics);
  return [...graph.topicIndex.keys()].filter((topic) => termOverlap(queryTerms, significantTerms(topic)) > 0)
    .sort().slice(0, maxTopics);
}

function toPacketFact({ fact, hops, access }) {
  return {
    id: fact.id, statement: fact.statement, predicate: fact.predicate,
    subjectIds: fact.subjectIds, entityIds: fact.entityIds, topics: fact.topics,
    access, hops, provenance: fact.provenance, status: fact.status, sourceId: fact.sourceId,
    confidence: fact.confidence,
  };
}

function flattenOwnedRecords(value) {
  if (!value || Array.isArray(value)) return value;
  if (typeof value !== 'object') return [];
  const flattened = [];
  const entries = value instanceof Map ? [...value.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))
    : Object.keys(value).sort().map((key) => [key, value[key]]);
  for (const [ownerId, owned] of entries) {
    const records = Array.isArray(owned) ? owned : [owned];
    for (const record of records) if (record && typeof record === 'object') {
      flattened.push({ ...record, __ownerId: record.ownerId ?? ownerId });
    }
  }
  return flattened;
}

function sortedRecords(value) {
  if (!value) return [];
  const records = value instanceof Map ? [...value.values()]
    : Array.isArray(value) ? [...value]
      : typeof value === 'object' ? Object.values(value) : [];
  return records.filter((record) => record && typeof record === 'object')
    .sort((a, b) => recordId(a).localeCompare(recordId(b)) || stableKey(a).localeCompare(stableKey(b)));
}

function sortedValues(map) {
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function recordId(value) {
  return clean(value?.id ?? value?.identity?.id ?? value?.ownerId ?? value?.actorId);
}

function link(adjacency, a, b) {
  if (!a || !b || a === 'e:' || b === 'e:') return;
  if (!adjacency.has(a)) adjacency.set(a, new Set());
  if (!adjacency.has(b)) adjacency.set(b, new Set());
  adjacency.get(a).add(b);
  adjacency.get(b).add(a);
}

function addIndex(index, rawKey, id) {
  const key = normalizeText(rawKey);
  if (!key) return;
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(id);
}

function dedupeAmbiguities(values) {
  const map = new Map();
  for (const value of values) map.set(`${value.text}|${value.candidateIds.join('|')}`, value);
  return [...map.values()].sort((a, b) => a.text.localeCompare(b.text)
    || a.candidateIds.join('|').localeCompare(b.candidateIds.join('|')));
}

function normalizeVisibility(value) {
  const normalized = normalizeText(value || 'public');
  return ['public', 'community', 'shared', 'private', 'restricted', 'secret', 'inaccessible'].includes(normalized)
    ? normalized : 'public';
}

function communityEntities(value) {
  if (!value || Array.isArray(value) || value instanceof Map) return value;
  return value.homeCommunity?.residents ?? value.residents ?? value;
}

function normalizePrivacy(value) {
  const normalized = normalizeText(value || 'public');
  return ['public', 'personal', 'private'].includes(normalized) ? normalized : 'personal';
}

function significantTerms(value) {
  return uniqueStrings(normalizeText(value).split(' ').filter((term) => term.length > 1)).sort();
}

function termOverlap(a, b) {
  const right = new Set(b);
  let count = 0;
  for (const term of a) if (right.has(term)) count++;
  return count;
}

function containsPhrase(text, phrase) {
  return (` ${text} `).includes(` ${phrase} `);
}

function phraseContains(longer, shorter) {
  return longer !== shorter && containsPhrase(longer, shorter);
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US').replace(/[^a-z0-9:_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function entityNode(id) { return `e:${id}`; }
function factNode(id) { return `f:${id}`; }

function clampNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.floor(number)) : fallback;
}

function stableKey(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(',')}}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
