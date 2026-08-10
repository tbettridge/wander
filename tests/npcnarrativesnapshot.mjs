import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  attachNpcSpatialState,
  createLivingWorldState,
  registerLivingWorldEntity,
} from '../src/livingworldstate.mjs';
import {
  buildNpcNarrativeSnapshot,
  NPC_NARRATIVE_SNAPSHOT_VERSION,
} from '../src/npcnarrativesnapshot.mjs';

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const elmResidence = {
  originSettlementId: 'settlement:elm',
  residenceSettlementId: 'settlement:elm',
  householdId: 'household:elm:1',
  homeBuildingId: 'building:elm:1',
};
const ashResidence = {
  originSettlementId: 'settlement:ash',
  residenceSettlementId: 'settlement:ash',
  householdId: 'household:ash:1',
  homeBuildingId: 'building:ash:1',
};
const home = {
  kind: 'building', settlementId: 'settlement:elm', buildingId: 'building:elm:1', nodeId: null,
};

const plans = [
  { plan: { site: { id: 'settlement:elm', name: 'Elmspring' }, buildings: [] } },
  { plan: { site: { id: 'settlement:ash' }, place: { name: 'Ashfold' }, buildings: [] } },
];

function world() {
  const state = createLivingWorldState({ worldSeed: 41 });
  state.households['household:elm:1'] = {
    id: 'household:elm:1',
    surname: 'Thatcher',
    form: 'partners',
    homeBuildingId: 'building:elm:1',
    memberIds: ['npc:mira', 'npc:orin'],
  };
  state.households['household:ash:1'] = {
    id: 'household:ash:1',
    surname: 'Bray',
    form: 'single',
    homeBuildingId: 'building:ash:1',
    memberIds: ['npc:sella'],
  };
  registerLivingWorldEntity(state, { id: 'npc:mira', kind: 'npc', name: 'Mira Thatcher', role: 'miller' });
  registerLivingWorldEntity(state, { id: 'npc:orin', kind: 'npc', name: 'Orin Thatcher', role: 'carter' });
  registerLivingWorldEntity(state, { id: 'npc:sella', kind: 'npc', name: 'Sella Bray', role: 'signaller' });
  attachNpcSpatialState(state, 'npc:mira', { residence: elmResidence, location: home });
  attachNpcSpatialState(state, 'npc:orin', { residence: elmResidence, location: home });
  attachNpcSpatialState(state, 'npc:sella', {
    residence: ashResidence,
    location: { kind: 'building', settlementId: 'settlement:ash', buildingId: 'building:ash:1', nodeId: null },
  });
  return state;
}

function find(node, id) {
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

function everyNode(node, out = []) {
  out.push(node);
  for (const child of node.children || []) everyNode(child, out);
  return out;
}

test('the snapshot projects settlement, household and person containment', () => {
  const snapshot = buildNpcNarrativeSnapshot({ state: world(), settlementPlans: plans });
  assert.equal(snapshot.version, NPC_NARRATIVE_SNAPSHOT_VERSION);
  assert.equal(snapshot.stats.people, 3);
  assert.equal(snapshot.stats.settlements, 2);
  assert.equal(snapshot.stats.households, 2);

  // Settlement display names come from the supplied plans, under either the
  // place name or the site name, and fall back to the raw id when absent.
  const titles = snapshot.tree.children.map((child) => child.title);
  assert.deepEqual(titles, ['Ashfold', 'Elmspring'], 'settlements sort by display name');

  const elm = find(snapshot.tree, 'settlement:settlement:elm');
  const household = elm.children[0];
  assert.equal(household.id, 'household:household:elm:1');
  assert.equal(household.title, 'Thatcher household');
  assert.deepEqual(household.children.map((child) => child.title),
    ['Mira Thatcher', 'Orin Thatcher'], 'members sort by name');
});

test('every fact hangs under exactly one person and reports its own provenance', () => {
  const state = world();
  state.narrativeFacts['narrative-fact:abc'] = {
    id: 'narrative-fact:abc',
    subjectId: 'npc:orin',
    factKey: 'craft.wheelwright',
    value: 'wheelwright',
    statement: 'Orin Thatcher mends cart wheels for the whole valley.',
    classification: 'asserted-fact',
    status: 'asserted',
    confidence: 0.7,
    visibility: 'public',
    knownBy: ['npc:mira'],
    contradicts: [],
    provenance: { speakerId: 'npc:mira', messageIndex: 2, quote: 'x' },
  };
  const snapshot = buildNpcNarrativeSnapshot({ state, settlementPlans: plans });

  const occurrences = everyNode(snapshot.tree)
    .filter((node) => node.id === 'fact:narrative-fact:abc');
  assert.equal(occurrences.length, 1, 'a fact is never duplicated across the tree');

  const orin = find(snapshot.tree, 'person:npc:orin');
  const category = orin.children.find((child) => child.category === 'narrative');
  assert.ok(category, 'the fact lands in its subject\'s narrative branch');
  assert.equal(category.children[0].id, 'fact:narrative-fact:abc');

  const fields = Object.fromEntries(category.children[0].fields
    .map((field) => [field.label, field.value]));
  assert.equal(fields.provenance, 'npc-statement');
  assert.equal(fields['known by'], 'npc:mira');
  assert.equal(fields.visibility, 'public · public');

  // Mira knows it, so the tree keeps its shape while the real many-to-many
  // edge stays visible as a cross-link.
  assert.deepEqual(
    snapshot.crossLinks.filter((edge) => edge.from === 'fact:narrative-fact:abc'),
    [{ from: 'fact:narrative-fact:abc', to: 'person:npc:mira', relation: 'knows', kind: 'narrative' }],
  );
});

test('relationships become owner-side branches and link to their subject', () => {
  const state = world();
  state.relationships['npc:mira|npc:sella'] = {
    ownerId: 'npc:mira',
    subjectId: 'npc:sella',
    trust: 0.62,
    familiarity: 0.4,
    affinity: 0.2,
    obligation: 0,
    tags: ['trusted'],
    lastEventId: 'event:7',
  };
  const snapshot = buildNpcNarrativeSnapshot({ state, settlementPlans: plans });
  const mira = find(snapshot.tree, 'person:npc:mira');
  const branch = mira.children.find((child) => child.category === 'relationship');
  assert.equal(branch.children[0].title, '→ Sella Bray');
  assert.equal(snapshot.stats.byCategory.relationship, 1);
  assert.ok(snapshot.crossLinks.some((edge) =>
    edge.from === 'relationship:npc:mira|npc:sella' && edge.to === 'person:npc:sella'));
});

test('a fact about nobody canonical is surfaced rather than silently dropped', () => {
  const state = world();
  state.narrativeFacts['narrative-fact:ghost'] = {
    id: 'narrative-fact:ghost',
    subjectId: 'npc:departed',
    factKey: 'trade.baker',
    value: 'baker',
    statement: 'The old baker left before the frost.',
    classification: 'asserted-fact',
    status: 'asserted',
    confidence: 0.7,
    visibility: 'public',
    knownBy: [],
    contradicts: [],
    provenance: { speakerId: 'npc:mira', messageIndex: 0, quote: 'x' },
  };
  const snapshot = buildNpcNarrativeSnapshot({ state, settlementPlans: plans });
  assert.equal(snapshot.stats.unattachedFacts, 1);
  const bucket = find(snapshot.tree, 'unattached');
  assert.equal(bucket.children[0].id, 'fact:narrative-fact:ghost');
});

test('a resident without canonical residence still appears', () => {
  const state = world();
  registerLivingWorldEntity(state, { id: 'npc:drifter', kind: 'npc', name: 'Wen', role: 'pedlar' });
  const snapshot = buildNpcNarrativeSnapshot({ state, settlementPlans: plans });
  assert.equal(snapshot.stats.people, 4);
  assert.ok(find(snapshot.tree, 'person:npc:drifter'),
    'an entity missing residence links is shown under its placeholder grouping, not omitted');
});

test('tombstoned entities and non-NPC entities are excluded', () => {
  const state = world();
  registerLivingWorldEntity(state, { id: 'npc:gone', kind: 'npc', name: 'Gone', role: 'farrier' });
  state.entities['npc:gone'].tombstone = true;
  registerLivingWorldEntity(state, { id: 'prop:cart', kind: 'prop', name: 'Cart' });
  const snapshot = buildNpcNarrativeSnapshot({ state, settlementPlans: plans });
  assert.equal(snapshot.stats.people, 3);
  assert.equal(find(snapshot.tree, 'person:npc:gone'), null);
  assert.equal(find(snapshot.tree, 'person:prop:cart'), null);
});

test('the snapshot is JSON-safe, deterministic, and does not mutate the state', () => {
  const state = world();
  const before = structuredClone(state);
  const first = buildNpcNarrativeSnapshot({ state, settlementPlans: plans });
  const second = buildNpcNarrativeSnapshot({ state, settlementPlans: plans });
  assert.deepEqual(state, before, 'building a view never edits the world');
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'same state, same bytes');
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first, 'no Maps, Sets, or undefined survive');
  assert.equal(first.stats.nodeCount, everyNode(first.tree).length);
});

test('missing or malformed state is rejected rather than half-rendered', () => {
  assert.throws(() => buildNpcNarrativeSnapshot({}), /Canonical living-world state is required/);
  assert.throws(() => buildNpcNarrativeSnapshot({ state: { entities: null } }),
    /Canonical living-world state is required/);
});

test('the viewer is reachable from the debug panel and carries its own snapshot', async () => {
  const [main, debug, page] = await Promise.all([
    source('src/main.js'), source('src/debug.js'), source('narrative-graph.html'),
  ]);
  assert.match(debug, /narrativeGraphActions\?\.open/,
    'the button must be optional so the panel still builds without the action');
  assert.match(debug, /fPeople\.add\(narrativeGraphActions, 'open'\)/,
    'the viewer opens from the Living World population folder');
  assert.match(main,
    /buildNpcNarrativeSnapshot\(\{[\s\S]{0,300}state: livingWorldPopulation\.worldState/,
    'the snapshot is taken from live canonical state at click time');
  assert.match(main, /window\.__WANDER_NARRATIVE_SNAPSHOT__ = snapshot;/,
    'the snapshot is handed over by reference, which has no quota');
  assert.match(main, /window\.open\('\.\/narrative-graph\.html', 'wander-narrative-graph'\)/,
    'repeated clicks reuse one named tab');

  // jsDelivr is blocked on the managed contributor profile; unpkg is not.
  assert.match(page, /https:\/\/unpkg\.com\/d3@7\.9\.0\/dist\/d3\.min\.js/,
    'd3 must be pinned and served from the permitted CDN host');
  assert.doesNotMatch(page, /src="[^"]*jsdelivr/i, 'no script may load from the blocked host');
  assert.match(page, /window\.opener\?\.__WANDER_NARRATIVE_SNAPSHOT__/,
    'the viewer prefers the handed-over object over stored bytes');
  assert.match(page, /function escapeHtml/,
    'NPC- and model-authored statements are injected as text, never as markup');
});
