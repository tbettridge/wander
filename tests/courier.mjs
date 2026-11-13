import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState, serializeLivingWorldState, parseLivingWorldState } from '../src/livingworldstate.mjs';
import { CourierController, initializeCourier } from '../src/courier.mjs';
import { COURIER_ROLES, COURIER_JOBS, COURIER_THREADS, validateCourierCoverage } from '../src/couriercontent.mjs';
import { beatDone, beatOpen } from '../src/courierstory.mjs';

function fixture(director = null) {
  const state = createLivingWorldState({ worldSeed: 20260612, playerId: 'player:local' });
  const places = { A: { id: 'a', name: 'Ash', x: 0, z: 0 }, B: { id: 'b', name: 'Bell', x: 1000, z: 0 }, H: { id: 'h', name: 'Hazel', x: 500, z: 300 } };
  const cast = Object.fromEntries(Object.entries(COURIER_ROLES).map(([role, place]) => {
    const id = 'npc:' + role; state.entities[id] = { id, kind: 'npc', name: role, inTransit: false };
    return [role, { id, name: role, place }];
  }));
  const player = { x: 0, z: 0, y: 2 };
  initializeCourier(state, { places, cast, routes: {} });
  const controller = new CourierController({ getState: () => state, getPlayer: () => player,
    getNpcPosition: id => places[cast[id.replace('npc:', '')]?.place],
    getSourcePosition: id => places[id.split(':')[1]], director });
  const visit = place => Object.assign(player, places[place]);
  return { state, controller, visit, player };
}
test('declining an opening job leaves independent village jobs and three satchel slots', () => {
  const { controller: c, visit } = fixture();
  assert.equal(c.decline('first-letter', 'npc:dispatcher').ok, true);
  visit('H'); assert.equal(c.accept('platform-cup', 'npc:potter').ok, true);
  assert.equal(c.accept('platform-seeds', 'npc:gardener').ok, true);
  visit('B'); assert.equal(c.accept('return-manuscript', 'npc:poet').ok, true);
  assert.match(c.accept('catalog-copy', 'npc:archivist').reason, /full/);
  assert.equal(c.handoff('platform-cup', 'npc:archivist').ok, true);
  assert.equal(c.accept('catalog-copy', 'npc:archivist').ok, true);
});
test('mixed-order handoffs, proximity, ownership and returns do not duplicate rewards', () => {
  const { state, controller: c, visit } = fixture();
  c.accept('first-letter', 'npc:dispatcher'); c.accept('trail-notes', 'npc:guide');
  assert.equal(c.handoff('first-letter', 'npc:gardener').ok, false);
  visit('B'); assert.equal(c.handoff('trail-notes', 'npc:archivist').ok, true);
  const trust = state.relationships['npc:archivist|player:local'].trust;
  assert.equal(c.handoff('trail-notes', 'npc:archivist').duplicate, true);
  assert.equal(state.relationships['npc:archivist|player:local'].trust, trust);
  visit('A'); assert.equal(c.handoff('first-letter', 'npc:dispatcher', true).ok, true);
  assert.equal(state.projections.items['courier:item:first-letter'].ownerId, 'npc:dispatcher');
  assert.equal(c.accept('first-letter', 'npc:dispatcher').ok, true);
  visit('H'); c.handoff('first-letter', 'npc:gardener');
  assert.equal(c.accept('first-letter', 'npc:dispatcher').ok, false);
});
test('all jobs can be declined and any one community omitted without blocking the story', () => {
  for (const excluded of [null, 'A', 'B', 'H']) {
    assert.equal(validateCourierCoverage(excluded).ok, true);
    const { controller: c, visit, state } = fixture();
    for (const job of COURIER_JOBS) { visit(COURIER_ROLES[job.sender]); c.decline(job.id, 'npc:' + job.sender); }
    // The dispatch sheet comes first; once it is read, every stand shows its accounts.
    for (const pass of [1, 2]) for (const source of c.sources().filter(s => s.place !== excluded)) { visit(source.place); c.discover(source.sourceId); }
    for (const thread of COURIER_THREADS) assert.equal(c.compare(thread.id).ok, true);
    assert.equal(c.formHypothesis().ok, true);
    assert.equal(Object.values(state.courier.jobs).every(j => j.state === 'declined'), true);
    assert.equal(Object.keys(state.courier.evidence).length, 6);
  }
});
test('copies do not multiply discoveries and arbitrary remote evidence is rejected', () => {
  const { controller: c, visit, state } = fixture();
  assert.equal(c.discover('dispatch-old:B').ok, false);
  c.discover('dispatch-now:A'); visit('B'); c.discover('dispatch-now:B');
  assert.equal(Object.keys(state.courier.evidence).length, 1);
  assert.equal(c.compare('post').ok, false);
  assert.equal(c.formHypothesis().ok, false);
  assert.equal(c.shareEvidence('npc:poet', ['maker-old']).ok, false);
});
test('NPCs keep last-witnessed delivery states and learn only explicitly shared evidence', () => {
  const { controller: c, visit } = fixture();
  c.accept('first-letter', 'npc:dispatcher'); visit('H'); c.handoff('first-letter', 'npc:gardener');
  assert.equal(c.contextForNpc('npc:dispatcher').offers[0].lastWitnessedState, 'accepted');
  assert.equal(c.contextForNpc('npc:gardener').witnessedJobs['first-letter'].state, 'delivered');
  const before = c.contextForNpc('npc:guide').evidence.map(e => e.id);
  assert.equal(before.includes('dispatch-old'), false);
  visit('B'); c.discover('dispatch-old:B'); visit('A'); c.shareEvidence('npc:guide', ['dispatch-old']);
  assert.equal(c.contextForNpc('npc:guide').evidence.some(e => e.id === 'dispatch-old'), true);
});
test('train motion does not damage cargo; actual sprint movement does, and chipped cargo remains deliverable', () => {
  const { controller: c, player, state, visit } = fixture();
  visit('H'); c.accept('platform-cup', 'npc:potter');
  for (let i = 0; i < 70; i++) { player.x++; c.recordTravel(0.1, { position: player, mode: 'train', sprint: true, jumped: true }); }
  assert.equal(state.courier.jobs['platform-cup'].condition, 'intact');
  for (let i = 0; i < 60; i++) { player.x++; c.recordTravel(0.1, { position: player, mode: 'horse', sprint: true }); }
  assert.equal(state.courier.jobs['platform-cup'].condition, 'chipped');
  visit('B'); assert.equal(c.handoff('platform-cup', 'npc:archivist').ok, true);
});
test('courier jobs, separate knowledge, evidence, and cached editions survive world serialization', async () => {
  const { state, controller: c, visit, player } = fixture();
  c.accept('first-letter', 'npc:dispatcher'); c.discover('dispatch-now:A');
  c.recordTravel(0.1, { position: player }); player.x++; c.recordTravel(0.1, { position: player }); visit('B');
  const published = await c.shareJourney('npc:poet'); assert.equal(published.ok, true);
  const restored = parseLivingWorldState(serializeLivingWorldState(state), { worldSeed: state.worldSeed });
  assert.deepEqual(restored.courier, state.courier);
  assert.equal(restored.projections.items['courier:item:first-letter'].ownerId, state.playerId);
});
test('generation is cached, normal actions do not discard it, and a restarted run rejects stale output', async () => {
  let resolve, calls = 0;
  const director = { requestCreativeWork: facts => { calls++; return new Promise(r => { resolve = () => r({ work: { title: 'The trip', lines: ['Road', 'Rain', 'Home'], referencedEventIds: [facts.events[0].id] }, source: 'edge' }); }); } };
  const { controller: c, player, visit, state } = fixture(director);
  c.recordTravel(0.1, { position: player }); player.x++; c.recordTravel(0.1, { position: player }); visit('B');
  const pending = c.shareJourney('npc:poet'); c.accept('return-manuscript', 'npc:poet'); resolve();
  assert.equal((await pending).ok, true); await c.shareJourney('npc:poet'); assert.equal(calls, 1);
  delete state.courier.works.personal;
  const stale = c.shareJourney('npc:poet'); state.courier.runId = 'another-run'; resolve();
  assert.equal((await stale).ok, false); assert.equal(state.courier.works.personal, undefined);
});

test('deliveries reveal accounts, raise standing, and the poet closes the story', async () => {
  const { COURIER_JOBS, courierBearing, courierCompass } = await import('../src/couriercontent.mjs');
  assert.equal(courierCompass(0, 10), 'north'); assert.equal(courierCompass(-10, 0), 'east');
  assert.equal(courierBearing({ x: 0, z: 0 }, { x: 0, z: -72 }), 'about 70 m south');
  assert.equal(courierBearing({ x: 0, z: 0 }, { x: -3800, z: 0 }), 'about 3.8 km east');
  assert.ok(COURIER_JOBS.filter(job => job.reveals).length >= 5);
});

test('carrying parcels uncovers the story and a closer near the courier gives it the last letter', () => {
  const { state, controller: c, visit } = fixture();
  state.courier.bindings.cast.gardener.home = { x: 500, z: 300, address: 'west of the well' };
  const accepted = c.accept('first-letter', 'npc:dispatcher');
  assert.match(accepted.message, /current dispatch sheet/);
  // Guidance gives an address and how the road is signed, never a live distance.
  assert.match(c.guidance().text, /road posts marked “Hazel”.*their home is west of the well/);
  assert.doesNotMatch(c.guidance().text, /about \d+/);
  visit('H');
  const delivered = c.handoff('first-letter', 'npc:gardener');
  assert.equal(delivered.revealed, 'dispatch-old');
  assert.match(delivered.message, /1 of 7 delivered — you are now “Known at the post desk”/);
  assert.equal(c.guidance().view, 'stories');
  assert.equal(c.compare('post').ok, true);
  c.accept('platform-seeds', 'npc:gardener'); visit('A');
  assert.equal(c.handoff('platform-seeds', 'npc:dispatcher').revealed, 'gardener-memory');
  c.accept('trail-notes', 'npc:guide'); visit('B');
  assert.equal(c.handoff('trail-notes', 'npc:archivist').revealed, 'guide-memory');
  assert.equal(c.compare('memories').ok, true);
  assert.equal(c.guidance().title, 'A pattern is forming');
  assert.match(c.formHypothesis().message, /Somebody, somewhere/);
  assert.match(c.guidance().title, /Somebody will have tried to say it/);
  // The poet is one more voice now, not the ending.
  const poet = c.shareEvidence('npc:poet', Object.keys(state.courier.evidence));
  assert.equal(poet.stance, 'curious'); assert.equal(poet.ending, undefined);
  // Anyone shown the accounts answers in their own temperament; two people, two voices.
  const reaction = c.shareEvidence('npc:archivist', Object.keys(state.courier.evidence));
  assert.equal(reaction.ok, true); assert.notEqual(reaction.stance, 'curious');
  // The director casts the naming and the turn; here they are placed by hand.
  const plot = () => state.courier.plot;
  plot().accounts.rope = { by: 'npc:archivist', name: 'archivist', site: 'b', siteName: 'Bell', stance: reaction.stance };
  plot().sites.b = { name: 'Bell', offers: [{ a: 'rope', ch: 'handed', at: 5 }] };
  assert.match(c.guidance().text, /archivist in Bell has something to give you in person/);
  assert.equal(c.receive('rope', 'npc:archivist').ok, true);
  assert.equal(beatOpen(state.courier, 'turn'), true);
  plot().accounts['route-book'] = { by: 'npc:poet', name: 'poet', site: 'b', siteName: 'Bell', stance: 'curious' };
  plot().sites.b.offers.push({ a: 'route-book', ch: 'handed', at: 6 });
  const turn = c.receive('route-book', 'npc:poet');
  assert.match(turn.document.text, /Delivered First Letter to gardener/, 'the turn is told from the courier’s own road');
  assert.match(turn.document.text, /and then the courier reads this/);
  assert.equal(c.finish('npc:archivist').ok, false, 'nobody has asked for the courier yet');
  plot().closer = { id: 'npc:archivist', name: 'archivist', site: 'b', siteName: 'Bell', at: 6 };
  assert.match(c.guidance().text, /archivist in Bell has asked for the courier/);
  const ending = c.shareEvidence('npc:archivist', Object.keys(state.courier.evidence));
  assert.match(ending.ending.text, /Who keeps yours\?/);
  assert.match(ending.ending.text, /A letter that was signed for before it was sent/);
  assert.equal(beatDone(state.courier, 'ending'), true);
  assert.equal(state.courier.concluded, false, 'the old poet ending is not used by a new story');
  assert.equal(c.standing().rank, 'Trusted courier');
  assert.equal(c.storyGuidance(), null, 'the story is done; errands carry on as before');
});

test('fingerposts give walking times in the day’s own terms, never metres', async () => {
  const { courierWalkTime, COURIER_METRES_PER_HOUR } = await import('../src/couriercontent.mjs');
  assert.equal(COURIER_METRES_PER_HOUR, 4200);
  assert.equal(courierWalkTime(60), 'a short stroll');
  assert.equal(courierWalkTime(4376), 'an hour');
  assert.equal(courierWalkTime(5616), 'an hour and a half');
  assert.equal(courierWalkTime(12000), 'half a morning');
  assert.equal(courierWalkTime(NaN), 'a short stroll');
  const order = [500, 2000, 3000, 4500, 6000, 9000, 12000, 18000, 30000, 40000].map(courierWalkTime);
  assert.equal(new Set(order).size, order.length, 'longer roads always read as longer');
  for (const phrase of order) assert.doesNotMatch(phrase, /\d/);
});
