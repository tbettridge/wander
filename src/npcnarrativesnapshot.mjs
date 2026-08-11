// A JSON-safe, point-in-time projection of the whole narrative graph, shaped
// for a mindmap viewer.
//
// The narrative graph is a general entity/fact graph and is normally built
// speaker-scoped and thrown away (see npcnarrativecontinuity.mjs). This module
// builds it once, unfiltered, and projects it onto the world's own containment
// hierarchy — settlement, household, person, category, item — because that is
// the only tree a reader can navigate without already knowing the answer.
//
// Facts that touch several people are attached to one primary owner and
// reported again as cross-links, so the tree stays a tree while the real
// many-to-many structure remains visible.
//
// Pure: no DOM, no THREE, no clock, no mutation of the supplied state.

import { buildNpcNarrativeGraph } from './npcnarrativegraph.mjs';
import { PLAYER_NARRATIVE_SUBJECT_ID } from './npcnarrativefacts.mjs';
import { normalizeNpcLocation, normalizeNpcResidence } from './npclocation.mjs';

export const NPC_NARRATIVE_SNAPSHOT_VERSION = 1;

const NO_SETTLEMENT = '(no canonical residence)';
const NO_HOUSEHOLD = '(no canonical household)';

// Fixed display order. A category is omitted entirely when it holds nothing,
// so an ordinary resident does not sprout five empty branches.
const CATEGORY_ORDER = Object.freeze([
  ['profile', 'Profile'],
  ['narrative', 'Narrative facts'],
  ['memory', 'Social memories'],
  ['commitment', 'Commitments'],
  ['relationship', 'Relationships'],
  ['other', 'Other facts'],
]);

/**
 * Build the whole-graph snapshot.
 *
 * `settlementPlans` accepts the same shapes as the community context builder:
 * an array, a Map, or an id-keyed object, whose values are plans or `{ plan }`.
 * It is optional and only supplies settlement display names.
 */
export function buildNpcNarrativeSnapshot({
  state,
  settlementPlans = null,
  capturedAtHours = null,
} = {}) {
  if (!plain(state) || !plain(state.entities)) {
    throw new TypeError('Canonical living-world state is required.');
  }
  const plans = planCatalog(settlementPlans);
  const people = collectPeople(state);
  const graph = buildNpcNarrativeGraph({
    revision: state.revision,
    communityRecords: [...people.values()].map((person) => communityRecord(person, state)),
    relationships: state.relationships || {},
    socialMemories: state.memories || {},
    commitments: state.commitments || {},
    narrativeFacts: state.narrativeFacts || {},
  });

  const classify = factClassifier(state);
  const attached = new Map();  // personId -> category -> node[]
  const orphans = [];
  const crossLinks = [];
  const counts = { profile: 0, narrative: 0, memory: 0, commitment: 0, relationship: 0, other: 0 };

  for (const fact of sortedById([...graph.facts.values()])) {
    const category = classify(fact);
    const ownerId = primaryOwner(fact, people);
    const node = factNode(fact, category);
    counts[category] = (counts[category] || 0) + 1;
    if (!ownerId) {
      orphans.push({ ...node, subjectIds: [...fact.subjectIds] });
      continue;
    }
    bucket(attached, ownerId, category).push(node);
    // The two ways a fact reaches someone other than its owner: it names them,
    // or they carry it. Both matter — `involves` is the shape of the claim,
    // `knows` is how it spread — and neither is visible from a pure tree.
    const related = new Map();
    for (const otherId of fact.knownBy) {
      if (otherId !== ownerId && people.has(otherId)) related.set(otherId, 'knows');
    }
    for (const otherId of fact.entityIds) {
      if (otherId !== ownerId && people.has(otherId)) related.set(otherId, 'involves');
    }
    for (const [otherId, relation] of related) {
      crossLinks.push({ from: node.id, to: `person:${otherId}`, relation, kind: category });
    }
  }

  for (const edge of sortedRelationships(state.relationships)) {
    if (!people.has(edge.ownerId)) continue;
    const node = relationshipNode(edge, people);
    counts.relationship++;
    bucket(attached, edge.ownerId, 'relationship').push(node);
    if (people.has(edge.subjectId)) {
      crossLinks.push({
        from: node.id, to: `person:${edge.subjectId}`, relation: 'involves', kind: 'relationship',
      });
    }
  }

  const settlements = groupSettlements(people, state, plans);
  const children = settlements.map((settlement) => settlementNode(settlement, attached, state));
  // What the village believes about the player, as its own branch. These have
  // no household to sit under and would otherwise land in the orphan bucket
  // beside genuinely broken records, which is the one place nobody looks.
  const travellerFacts = orphans.filter((node) => node.subjectIds?.includes(PLAYER_NARRATIVE_SUBJECT_ID));
  const unattached = orphans.filter((node) => !travellerFacts.includes(node));
  if (travellerFacts.length) children.push(travellerNode(travellerFacts));
  if (unattached.length) children.push(unattachedNode(unattached));

  const tree = {
    id: 'root',
    kind: 'root',
    title: 'Living world',
    subtitle: `revision ${integer(state.revision)} · ${people.size} people · ${graph.facts.size} facts`,
    badges: [
      { label: 'settlements', value: String(settlements.length) },
      { label: 'people', value: String(people.size) },
      { label: 'facts', value: String(graph.facts.size) },
    ],
    fields: [
      { label: 'world seed', value: text(state.worldSeed) },
      { label: 'revision', value: String(integer(state.revision)) },
      { label: 'world hours', value: capturedAtHours == null ? '—' : capturedAtHours.toFixed(2) },
      { label: 'relationships', value: String(counts.relationship), detail: true },
      { label: 'narrative fact receipts', value: String(size(state.narrativeFactReceipts)), detail: true },
      ...featureFields(state.features),
    ],
    entityIds: [],
    children,
  };

  return {
    version: NPC_NARRATIVE_SNAPSHOT_VERSION,
    revision: integer(state.revision),
    capturedAtHours: Number.isFinite(capturedAtHours) ? capturedAtHours : null,
    stats: {
      settlements: settlements.length,
      households: settlements.reduce((sum, entry) => sum + entry.households.length, 0),
      people: people.size,
      facts: graph.facts.size,
      unattachedFacts: unattached.length,
      travellerFacts: travellerFacts.length,
      crossLinks: crossLinks.length,
      byCategory: { ...counts },
      nodeCount: countNodes(tree),
    },
    crossLinks: crossLinks.sort((a, b) => a.from.localeCompare(b.from)
      || a.to.localeCompare(b.to) || a.relation.localeCompare(b.relation)),
    tree,
  };
}

/** Shorter alias for the debug integration call site. */
export const narrativeGraphSnapshot = buildNpcNarrativeSnapshot;

function collectPeople(state) {
  const people = new Map();
  for (const id of Object.keys(state.entities).sort()) {
    const entity = state.entities[id];
    if (!plain(entity) || entity.id !== id || entity.kind !== 'npc' || entity.tombstone === true) continue;
    const residence = normalizeNpcResidence(entity.residence);
    people.set(id, {
      id,
      entity,
      residence,
      settlementId: residence?.residenceSettlementId || NO_SETTLEMENT,
      householdId: residence?.householdId || entity.householdId || NO_HOUSEHOLD,
      location: normalizeNpcLocation(entity.location),
    });
  }
  return people;
}

function communityRecord(person, state) {
  const household = state.households?.[person.householdId];
  return {
    id: person.id,
    name: person.entity.name || person.id,
    role: person.entity.role || '',
    household: { surname: household?.surname || '' },
    family: { surname: household?.surname || '' },
  };
}

/**
 * Which collection a normalized fact came from.
 *
 * Checked against the canonical keyed collections first and the id prefix
 * second: the graph mints a hashed id for a record that arrived without one,
 * so neither test alone covers every fact.
 */
function factClassifier(state) {
  const narrative = new Set(Object.keys(state.narrativeFacts || {}));
  const commitments = new Set(Object.keys(state.commitments || {}));
  const memories = new Set();
  for (const owned of Object.values(state.memories || {})) {
    for (const memory of Array.isArray(owned) ? owned : [owned]) {
      if (plain(memory) && memory.id) memories.add(String(memory.id));
    }
  }
  return (fact) => {
    if (narrative.has(fact.id) || fact.id.startsWith('narrative-fact:')) return 'narrative';
    if (commitments.has(fact.id) || fact.predicate.startsWith('commitment')) return 'commitment';
    if (memories.has(fact.id) || fact.id.startsWith('memory:')) return 'memory';
    if (fact.predicate === 'entity.profile' || fact.id.startsWith('profile:')) return 'profile';
    return 'other';
  };
}

/** The one person a fact hangs under: its subject, else its owner, else any named entity. */
function primaryOwner(fact, people) {
  for (const list of [fact.subjectIds, fact.ownerIds, fact.entityIds]) {
    for (const id of list) if (people.has(id)) return id;
  }
  return null;
}

function groupSettlements(people, state, plans) {
  const settlements = new Map();
  for (const person of people.values()) {
    const settlement = settlements.get(person.settlementId) || {
      id: person.settlementId,
      name: settlementName(plans, person.settlementId),
      households: new Map(),
    };
    const household = settlement.households.get(person.householdId) || {
      id: person.householdId,
      record: state.households?.[person.householdId] || null,
      members: [],
    };
    household.members.push(person);
    settlement.households.set(person.householdId, household);
    settlements.set(person.settlementId, settlement);
  }
  return [...settlements.values()]
    .map((settlement) => ({
      ...settlement,
      households: [...settlement.households.values()]
        .map((household) => ({
          ...household,
          members: household.members.sort((a, b) => compare(personName(a), personName(b))
            || compare(a.id, b.id)),
        }))
        .sort((a, b) => compare(householdName(a), householdName(b)) || compare(a.id, b.id)),
    }))
    .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id));
}

function settlementNode(settlement, attached, state) {
  const residents = settlement.households.reduce((sum, household) => sum + household.members.length, 0);
  return {
    id: `settlement:${settlement.id}`,
    kind: 'settlement',
    title: settlement.name,
    subtitle: `${plural(settlement.households.length, 'household')} · ${plural(residents, 'resident')}`,
    badges: [{ label: 'people', value: String(residents) }],
    fields: [
      { label: 'id', value: settlement.id, detail: true },
    ],
    entityIds: [],
    children: settlement.households.map((household) => householdNode(household, attached, state)),
  };
}

function householdNode(household, attached, state) {
  const record = household.record;
  return {
    id: `household:${household.id}`,
    kind: 'household',
    title: householdName(household),
    subtitle: `${plural(household.members.length, 'member')}${record?.form ? ` · ${record.form}` : ''}`,
    badges: [{ label: 'members', value: String(household.members.length) }],
    fields: [
      { label: 'id', value: household.id, detail: true },
      { label: 'home building', value: text(record?.homeBuildingId) || '—', detail: true },
      { label: 'form', value: text(record?.form) || '—', detail: true },
    ],
    entityIds: household.members.map((member) => member.id),
    children: household.members.map((member) => personNode(member, attached, state)),
  };
}

function personNode(person, attached, state) {
  const byCategory = attached.get(person.id) || new Map();
  const children = [];
  let factTotal = 0;
  for (const [key, label] of CATEGORY_ORDER) {
    const items = byCategory.get(key) || [];
    if (!items.length) continue;
    factTotal += items.length;
    children.push({
      id: `category:${person.id}:${key}`,
      kind: 'category',
      category: key,
      title: label,
      subtitle: plural(items.length, 'entry', 'entries'),
      badges: [],
      fields: [],
      entityIds: [person.id],
      children: items,
    });
  }
  const household = state.households?.[person.householdId];
  const location = person.location;
  return {
    id: `person:${person.id}`,
    kind: 'person',
    title: personName(person),
    subtitle: person.entity.role || 'resident',
    badges: [
      { label: 'facts', value: String(factTotal) },
      ...(person.entity.inTransit ? [{ label: 'travelling', value: '' }] : []),
    ],
    fields: [
      { label: 'role', value: person.entity.role || '—' },
      { label: 'household', value: household?.surname || person.householdId },
      { label: 'located', value: locationPhrase(location) },
      { label: 'id', value: person.id, detail: true },
      { label: 'home building', value: text(person.residence?.homeBuildingId) || '—', detail: true },
      { label: 'residence', value: text(person.residence?.residenceSettlementId) || '—', detail: true },
      { label: 'origin', value: text(person.residence?.originSettlementId) || '—', detail: true },
      { label: 'itinerary', value: text(person.entity.itineraryId) || '—', detail: true },
      { label: 'activity', value: text(person.entity.activity?.kind) || '—', detail: true },
    ],
    entityIds: [person.id],
    children,
  };
}

function factNode(fact, category) {
  return {
    id: `fact:${fact.id}`,
    kind: 'fact',
    category,
    title: fact.statement,
    subtitle: `${fact.predicate} · ${fact.visibility}/${fact.privacy}`,
    badges: [
      ...(fact.status ? [{ label: fact.status, value: '' }] : []),
      { label: 'conf', value: fact.confidence.toFixed(2) },
    ],
    fields: [
      { label: 'predicate', value: fact.predicate },
      { label: 'visibility', value: `${fact.visibility} · ${fact.privacy}` },
      { label: 'provenance', value: fact.provenance || '—' },
      { label: 'id', value: fact.id, detail: true },
      { label: 'status', value: fact.status || 'asserted', detail: true },
      { label: 'confidence', value: fact.confidence.toFixed(2), detail: true },
      { label: 'salience', value: fact.salience.toFixed(2), detail: true },
      { label: 'subjects', value: list(fact.subjectIds), detail: true },
      { label: 'entities', value: list(fact.entityIds), detail: true },
      { label: 'known by', value: list(fact.knownBy), detail: true },
      { label: 'topics', value: list(fact.topics), detail: true },
      { label: 'source', value: text(fact.sourceId) || '—', detail: true },
    ],
    entityIds: [...fact.entityIds],
    children: [],
  };
}

function relationshipNode(edge, people) {
  const subject = people.get(edge.subjectId);
  const name = subject ? personName(subject) : edge.subjectId;
  return {
    id: `relationship:${edge.ownerId}|${edge.subjectId}`,
    kind: 'relationship',
    category: 'relationship',
    title: `→ ${name}`,
    subtitle: edge.tags.length ? edge.tags.join(', ') : 'no tags',
    badges: [{ label: 'trust', value: edge.trust.toFixed(2) }],
    fields: [
      { label: 'trust', value: edge.trust.toFixed(2) },
      { label: 'familiarity', value: edge.familiarity.toFixed(2) },
      { label: 'affinity', value: edge.affinity.toFixed(2), detail: true },
      { label: 'obligation', value: edge.obligation.toFixed(2), detail: true },
      { label: 'tags', value: list(edge.tags), detail: true },
      { label: 'subject', value: edge.subjectId, detail: true },
      { label: 'last event', value: text(edge.lastEventId) || '—', detail: true },
    ],
    entityIds: [edge.ownerId, edge.subjectId],
    children: [],
  };
}

function travellerNode(facts) {
  return {
    id: 'traveller',
    kind: 'settlement',
    title: 'The traveller',
    subtitle: 'what the village believes about the player',
    badges: [{ label: 'facts', value: String(facts.length) }],
    fields: [{ label: 'subject', value: PLAYER_NARRATIVE_SUBJECT_ID, detail: true }],
    entityIds: [PLAYER_NARRATIVE_SUBJECT_ID],
    children: facts,
  };
}

function unattachedNode(orphans) {
  return {
    id: 'unattached',
    kind: 'settlement',
    title: 'Unattached facts',
    subtitle: 'no canonical person in this world state',
    badges: [{ label: 'facts', value: String(orphans.length) }],
    fields: [],
    entityIds: [],
    children: orphans,
  };
}

function featureFields(features) {
  if (!plain(features)) return [];
  return Object.keys(features).sort().map((key) => ({
    label: key, value: features[key] ? 'on' : 'off', detail: true,
  }));
}

function sortedRelationships(value) {
  if (!plain(value)) return [];
  return Object.keys(value).sort().flatMap((key) => {
    const edge = value[key];
    if (!plain(edge)) return [];
    const ownerId = text(edge.ownerId);
    const subjectId = text(edge.subjectId);
    if (!ownerId || !subjectId) return [];
    return [{
      ownerId,
      subjectId,
      trust: number(edge.trust),
      familiarity: number(edge.familiarity),
      affinity: number(edge.affinity),
      obligation: number(edge.obligation),
      tags: Array.isArray(edge.tags) ? edge.tags.map(text).filter(Boolean) : [],
      lastEventId: text(edge.lastEventId),
    }];
  });
}

function planCatalog(value) {
  const catalog = new Map();
  if (!value) return catalog;
  const records = value instanceof Map ? [...value.values()]
    : Array.isArray(value) ? value
      : plain(value) ? Object.values(value) : [];
  for (const record of records) {
    const plan = plain(record?.plan) ? record.plan : record;
    const id = text(plan?.site?.id);
    if (id) catalog.set(id, plan);
  }
  return catalog;
}

function settlementName(plans, id) {
  const plan = plans.get(id);
  if (!plan) return id;
  return text(plan.place?.name) || text(plan.site?.name) || text(plan.site?.displayName) || id;
}

function householdName(household) {
  const surname = text(household.record?.surname);
  return surname ? `${surname} household` : household.id;
}

function personName(person) {
  return text(person.entity?.name) || person.id;
}

function locationPhrase(location) {
  if (!location) return 'unknown';
  if (location.kind === 'building') return `building ${location.buildingId}`;
  if (location.kind === 'station-platform') return `platform ${location.stationId}`;
  if (location.kind === 'train-seat') return `train ${location.serviceId ?? ''}`.trim();
  if (location.kind === 'settlement-node') return `${location.settlementId}/${location.nodeId}`;
  if (location.kind === 'regional-edge') return `en route ${location.edgeId}`;
  return location.kind;
}

function bucket(map, personId, category) {
  const byCategory = map.get(personId) || new Map();
  const items = byCategory.get(category) || [];
  byCategory.set(category, items);
  map.set(personId, byCategory);
  return items;
}

function countNodes(node) {
  return 1 + (node.children || []).reduce((sum, child) => sum + countNodes(child), 0);
}

function sortedById(values) {
  return values.sort((a, b) => compare(a.id, b.id));
}

function compare(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function plural(count, singular, plural_ = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural_}`;
}

function list(values) {
  return Array.isArray(values) && values.length ? values.join(', ') : '—';
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integer(value) {
  return Math.max(0, Math.floor(number(value)));
}

function size(value) {
  return plain(value) ? Object.keys(value).length : 0;
}

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
