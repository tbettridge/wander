import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildNpcCommunityContext,
  communityContextForNpc,
} from '../src/npccommunitycontext.mjs';

const A = 'settlement:alder';
const B = 'settlement:birch';

function residence(settlementId, householdId, homeBuildingId, originSettlementId = settlementId) {
  return { originSettlementId, residenceSettlementId: settlementId, householdId, homeBuildingId };
}

function npc(id, name, role, householdId, homeBuildingId, overrides = {}) {
  return {
    id, kind: 'npc', name, role, householdId, tombstone: false,
    residence: residence(A, householdId, homeBuildingId),
    location: { kind: 'building', settlementId: A, buildingId: homeBuildingId, nodeId: null },
    ...overrides,
  };
}

function fixture() {
  const plans = [{
    site: { id: A, name: 'Alder Cross' },
    buildings: [
      { id: 'home:reed', x: 130, z: 160, program: 'dwelling', displayName: 'Reed House', ownerHouseholdId: 'hh:reed' },
      { id: 'home:moss', x: 70, z: 60, program: 'dwelling', displayName: 'Moss House', ownerHouseholdId: 'hh:moss' },
      { id: 'work:forge', x: 200, z: 100, program: 'smithy', displayName: 'Reed Forge', ownerHouseholdId: 'hh:reed' },
      { id: 'hall', x: 100, z: 180, program: 'hall', displayName: 'Village Hall', ownerHouseholdId: null },
    ],
    localGraph: { nodes: [{ id: 'square', x: 105, z: 105 }] },
  }, {
    site: { id: B, name: 'Birch End' },
    buildings: [{ id: 'home:birch', x: 900, z: 900, program: 'dwelling', displayName: 'Birch House', ownerHouseholdId: 'hh:birch' }],
  }];
  const entities = {
    'npc:zara': npc('npc:zara', 'Zara Reed', 'resident', 'hh:reed', 'home:reed'),
    'npc:ada': npc('npc:ada', 'Ada Reed', 'smith', 'hh:reed', 'home:reed', {
      workplaceId: 'work:forge', workplaceName: 'untrusted stale label',
      location: { kind: 'building', settlementId: A, buildingId: 'work:forge', nodeId: null },
    }),
    'npc:mos': npc('npc:mos', 'Mos Moss', 'clerk', 'hh:moss', 'home:moss', {
      location: { kind: 'building', settlementId: B, buildingId: 'home:birch', nodeId: null },
    }),
  };
  return {
    plans,
    state: {
      entities,
      households: {
        'hh:moss': { id: 'hh:moss', surname: 'Moss', form: 'single', homeBuildingId: 'home:moss', memberIds: ['npc:mos'] },
        'hh:reed': { id: 'hh:reed', surname: 'Reed', form: 'siblings', homeBuildingId: 'home:reed', memberIds: ['npc:zara', 'npc:ada'] },
      },
      workplaces: {
        'work:forge': { id: 'work:forge', settlementId: A, buildingId: 'work:forge', kind: 'smithy', displayName: 'The Honest Forge' },
      },
      routines: {
        'routine:ada': { id: 'routine:ada', actorId: 'npc:ada', workplaceId: 'work:forge', kind: 'work', state: 'working' },
        'routine:mos': { id: 'routine:mos', actorId: 'npc:mos', workplaceId: 'missing-work', kind: 'work', state: 'scheduled' },
      },
    },
  };
}

test('builds the complete home-community directory from canonical records', () => {
  const { state, plans } = fixture();
  const context = buildNpcCommunityContext({
    state, speakerId: 'npc:zara', settlementPlans: plans, speakerPosition: { x: 100, z: 100 },
  });
  assert.equal(context.homeCommunity.id, A);
  assert.equal(context.homeCommunity.name, 'Alder Cross');
  assert.equal(context.homeCommunity.residentCount, 3);
  assert.deepEqual(context.homeCommunity.residents.map((entry) => entry.id), ['npc:ada', 'npc:mos', 'npc:zara']);
  assert.equal('currentCommunity' in context, false);

  const ada = context.homeCommunity.residents[0];
  assert.deepEqual(ada.household, { id: 'hh:reed', surname: 'Reed', form: 'siblings' });
  assert.deepEqual(ada.family, { surname: 'Reed', memberIds: ['npc:ada', 'npc:zara'] });
  assert.equal(ada.workplace.name, 'The Honest Forge', 'canonical workplace beats entity display text');
  assert.equal(ada.workplace.building.id, 'work:forge');
  assert.equal(ada.status.kind, 'working');
  assert.equal(context.homeCommunity.residents[1].status.kind, 'visiting');
  assert.equal(context.homeCommunity.residents[2].status.kind, 'at-home');
  assert.equal(context.homeCommunity.residents[1].workplace, null, 'invented workplace links are not narrated');
});

test('building directions use rounded east/north offsets from the speaker', () => {
  const { state, plans } = fixture();
  const context = communityContextForNpc({
    state, speakerId: 'npc:zara', settlementPlans: new Map(plans.map((plan) => [plan.site.id, plan])),
    origin: { x: 100.4, z: 100.4 },
  });
  const zara = context.homeCommunity.residents.find((entry) => entry.id === 'npc:zara');
  assert.deepEqual(zara.home, {
    id: 'home:reed', settlementId: A, name: 'Reed House', program: 'dwelling',
    eastM: 30, northM: 60, distanceM: 67,
    distancePhrase: 'just over there', direction: 'north-east',
  });
  const forge = context.homeCommunity.residents.find((entry) => entry.id === 'npc:ada').workplace.building;
  assert.equal(forge.eastM, 100);
  assert.equal(forge.northM, 0);
  assert.equal(forge.direction, 'east');
  assert.equal(forge.distancePhrase, 'about one hundred metres');
});

test('durable migrated residence selects home community while current location identifies a visit', () => {
  const { state, plans } = fixture();
  state.households['hh:birch'] = {
    id: 'hh:birch', surname: 'Birch', form: 'single', homeBuildingId: 'home:birch', memberIds: ['npc:zara'],
  };
  state.households['hh:reed'].memberIds = ['npc:ada'];
  state.entities['npc:zara'] = {
    ...state.entities['npc:zara'], householdId: 'hh:birch',
    residence: residence(B, 'hh:birch', 'home:birch', A),
    location: { kind: 'building', settlementId: A, buildingId: 'home:reed', nodeId: null },
  };
  const context = buildNpcCommunityContext({
    state, speakerId: 'npc:zara', settlementPlans: Object.fromEntries(plans.map((plan) => [plan.site.id, { plan }])),
    speakerPosition: { x: 130, z: 160 },
  });
  assert.equal(context.homeCommunity.id, B);
  assert.deepEqual(context.homeCommunity.residents.map((entry) => entry.id), ['npc:zara']);
  assert.deepEqual(context.currentCommunity, { id: A, name: 'Alder Cross' });
  assert.equal(context.homeCommunity.residents[0].status.kind, 'visiting');
});

test('between-community travel preserves home and does not invent a current community', () => {
  const { state, plans } = fixture();
  state.entities['npc:zara'].location = {
    kind: 'train-seat', runId: 'run:1', carriageId: 'car:1', seatId: 'seat:1',
  };
  const context = buildNpcCommunityContext({
    state, speakerId: 'npc:zara', settlementPlans: plans, speakerPosition: { x: 500, z: 500 },
  });
  assert.equal(context.homeCommunity.id, A);
  assert.equal('currentCommunity' in context, false);
  assert.equal(context.homeCommunity.residents.find((entry) => entry.id === 'npc:zara').status.kind, 'travelling');
});

test('falls back to canonical building and settlement-node coordinates', () => {
  const first = fixture();
  const fromHome = buildNpcCommunityContext({
    state: first.state, speakerId: 'npc:zara', settlementPlans: first.plans,
  });
  assert.equal(fromHome.homeCommunity.residents.find((entry) => entry.id === 'npc:zara').home.direction, 'here');

  const second = fixture();
  second.state.entities['npc:zara'].location = { kind: 'settlement-node', settlementId: A, nodeId: 'square' };
  const fromNode = buildNpcCommunityContext({ state: second.state, speakerId: 'npc:zara', settlementPlans: second.plans });
  const home = fromNode.homeCommunity.residents.find((entry) => entry.id === 'npc:zara').home;
  assert.equal(home.eastM, 25);
  assert.equal(home.northM, 55);
  assert.equal(home.direction, 'north-east');
});

test('omits malformed, tombstoned, invented, duplicated, and mismatched members', () => {
  const { state, plans } = fixture();
  state.households['hh:reed'].memberIds.push('npc:invented', 'npc:dead', 'npc:bad-home', 'npc:duplicate');
  state.entities['npc:dead'] = npc('npc:dead', 'Dead Reed', 'resident', 'hh:reed', 'home:reed', { tombstone: true });
  state.entities['npc:bad-home'] = npc('npc:bad-home', 'Bad Reed', 'resident', 'hh:reed', 'wrong-home');
  state.entities['npc:duplicate'] = npc('npc:duplicate', 'Dupe Reed', 'resident', 'hh:reed', 'home:reed');
  state.households['hh:moss'].memberIds.push('npc:duplicate');
  state.entities['npc:key-mismatch'] = npc('npc:other-id', 'False Reed', 'resident', 'hh:reed', 'home:reed');
  state.households['hh:reed'].memberIds.push('npc:key-mismatch');

  const context = buildNpcCommunityContext({
    state, speakerId: 'npc:zara', settlementPlans: plans, speakerPosition: { x: 100, z: 100 },
  });
  assert.deepEqual(context.homeCommunity.residents.map((entry) => entry.id), ['npc:ada', 'npc:mos', 'npc:zara']);
  assert.deepEqual(context.homeCommunity.residents.find((entry) => entry.id === 'npc:zara').family.memberIds,
    ['npc:ada', 'npc:zara']);
});

test('output is input-order stable, deeply immutable, JSON-safe, and side-effect free', () => {
  const left = fixture();
  const right = fixture();
  right.state.entities = Object.fromEntries(Object.entries(right.state.entities).reverse());
  right.state.households = Object.fromEntries(Object.entries(right.state.households).reverse());
  right.state.households['hh:reed'].memberIds.reverse();
  right.state.routines = Object.fromEntries(Object.entries(right.state.routines).reverse());
  right.plans.reverse();
  right.plans[1].buildings.reverse();
  const before = structuredClone(left.state);
  const args = { speakerId: 'npc:zara', speakerPosition: { x: 100, z: 100 } };
  const a = buildNpcCommunityContext({ ...args, state: left.state, settlementPlans: left.plans });
  const b = buildNpcCommunityContext({ ...args, state: right.state, settlementPlans: right.plans });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(left.state, before);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(a.homeCommunity.residents), true);
  assert.equal(Object.isFrozen(a.homeCommunity.residents[0].family.memberIds), true);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

test('ambiguous plan catalogs and noncanonical speakers fail closed', () => {
  const { state, plans } = fixture();
  assert.throws(() => buildNpcCommunityContext({
    state, speakerId: 'npc:zara', settlementPlans: [plans[0], structuredClone(plans[0])], speakerPosition: { x: 0, z: 0 },
  }), /Missing home settlement plan/);
  state.entities['npc:zara'].role = '';
  assert.throws(() => buildNpcCommunityContext({
    state, speakerId: 'npc:zara', settlementPlans: plans, speakerPosition: { x: 0, z: 0 },
  }), /not a canonical resident/);
});

test('module remains renderer-free and has no random source', async () => {
  const source = await readFile(new URL('../src/npccommunitycontext.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]three|document\.|window\./i);
  assert.doesNotMatch(source, /Math\.random/);
});
