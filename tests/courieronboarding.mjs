import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState, serializeLivingWorldState, parseLivingWorldState } from '../src/livingworldstate.mjs';
import { CourierController, initializeCourier } from '../src/courier.mjs';
import { COURIER_ROLES } from '../src/couriercontent.mjs';

function fixture() {
  const state = createLivingWorldState({ worldSeed: 20260612, playerId: 'player:local' });
  const places = { A: { id: 'a', name: 'Ash', x: 0, z: 0 }, B: { id: 'b', name: 'Bell', x: 100, z: 0 }, H: { id: 'h', name: 'Hazel', x: 200, z: 0 } };
  const positions = { 'npc:local': places.A, 'npc:visitor': places.B };
  const cast = Object.fromEntries(Object.entries(COURIER_ROLES).map(([role, place]) => {
    const id = 'npc:' + role;
    state.entities[id] = { id, kind: 'npc', name: role };
    positions[id] = places[place];
    return [role, { id, name: role, place, home: { address: role + ' cottage, beside the well' } }];
  }));
  for (const id of ['npc:local', 'npc:visitor']) state.entities[id] = { id, name: id, kind: 'npc' };
  const player = { x: 0, z: 0 };
  initializeCourier(state, { places, cast, routes: {} });
  const c = new CourierController({ getState: () => state, getPlayer: () => player,
    getNpcPosition: id => positions[id], getSourcePosition: id => places[id.split(':')[1]],
    getNpcPlace: id => id === 'npc:local' ? 'A' : id === 'npc:visitor' ? 'B' : null });
  return { state, c, player, visit: key => Object.assign(player, places[key]) };
}

test('old First Post saves gain the optional errand without replacing inventory, knowledge, or editions', () => {
  const { state, c } = fixture();
  c.accept('first-letter', 'npc:dispatcher');
  state.courier.works.personal = { title: 'A retained poem', lines: ['A road'] };
  delete state.courier.jobs['village-note']; delete state.courier.onboarding; delete state.courier.leads;
  const restored = parseLivingWorldState(serializeLivingWorldState(state), { worldSeed: state.worldSeed });
  assert.equal(restored.courier.jobs['first-letter'].state, 'active');
  assert.equal(restored.projections.items['courier:item:first-letter'].ownerId, state.playerId);
  assert.equal(restored.courier.knowledge['npc:dispatcher'].jobs['first-letter'].state, 'accepted');
  assert.equal(restored.courier.works.personal.title, 'A retained poem');
  assert.equal(restored.courier.jobs['village-note'].state, 'offered');
  assert.equal(restored.courier.onboarding.seen, false);
});
test('welcome offers help and focus without accepting a parcel or revealing story evidence', () => {
  const { state, c } = fixture();
  assert.equal(c.chooseWelcome('easy').ok, true);
  assert.equal(state.courier.onboarding.seen, true);
  assert.equal(c.guidance().jobId, 'village-note');
  assert.equal(Object.values(state.courier.jobs).every(j => j.state === 'offered'), true);
  assert.deepEqual(state.projections.items, {});
  assert.deepEqual(state.courier.evidence, {});
  c.decline('village-note', 'npc:dispatcher');
  assert.notEqual(c.guidance().jobId, 'village-note');
  assert.equal(c.accept('trail-notes', 'npc:guide').ok, true);
});
test('boards record encountered local notices only and reject remote reading and pickup', () => {
  const { state, c, visit } = fixture();
  assert.equal(c.readBoard('B').ok, false);
  assert.deepEqual(state.courier.leads, {});
  const result = c.readBoard('A');
  assert.equal(result.jobs.length, 3);
  assert.equal(Object.keys(state.courier.leads).length, 3);
  assert.equal(state.courier.knownOffers['platform-seeds'], undefined);
  assert.equal(c.readBoard('A').applied, false);
  visit('B');
  assert.equal(c.accept('village-note', 'npc:dispatcher').ok, false);
});
test('ordinary local referrals are grounded, private knowledge is excluded, and context is read-only', () => {
  const { state, c } = fixture();
  const context = c.contextForNpc('npc:local');
  assert.equal(context.responsibility, 'neighbor');
  assert.equal(context.place, 'A');
  assert.equal(context.boardTarget.id, 'board:A');
  assert.match(context.boardTarget.name, /Post & Errands/);
  assert.equal(context.offers.length, 0);
  assert.equal(context.localOpportunities.length, 3);
  assert.equal(context.people.some(p => p.id === 'npc:poet'), false);
  assert.equal(context.evidence.some(e => e.id === 'dispatch-old'), false);
  assert.deepEqual(state.courier.leads, {});
  assert.equal(c.learnReferrals('npc:local', 'H').ok, false);
  assert.equal(c.learnReferrals('npc:visitor', 'B').ok, false);
  assert.equal(c.learnReferrals('npc:local', 'A').ok, true);
  assert.equal(state.courier.leads['job:village-note'].source.id, 'npc:local');
});
test('local delivery confirms ownership, invites another real opportunity, and grants no mystery clue', () => {
  const { state, c } = fixture();
  c.chooseWelcome('easy'); c.accept('village-note', 'npc:dispatcher');
  assert.equal(c.guidance().title, 'Deliver A Note Across the Village');
  const result = c.handoff('village-note', 'npc:guide');
  assert.equal(result.ok, true);
  assert.match(result.message, /first delivery is complete/);
  assert.equal(result.nextLead.jobId, 'trail-notes');
  assert.equal(state.projections.items['courier:item:village-note'].ownerId, 'npc:guide');
  assert.equal(state.courier.jobs['trail-notes'].state, 'offered');
  assert.deepEqual(state.courier.evidence, {});
  assert.equal(c.handoff('village-note', 'npc:guide').duplicate, true);
});
test('reminders can be disabled and preferences and encountered leads survive reload', () => {
  const { state, c } = fixture();
  c.readBoard('A'); c.chooseWelcome('explore'); c.setHints(false);
  const restored = parseLivingWorldState(serializeLivingWorldState(state), { worldSeed: state.worldSeed });
  assert.equal(restored.courier.onboarding.hintsEnabled, false);
  assert.equal(restored.courier.onboarding.choice, 'explore');
  assert.equal(Object.keys(restored.courier.leads).length, 3);
});
