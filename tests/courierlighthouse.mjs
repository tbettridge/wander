import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState } from '../src/livingworldstate.mjs';
import { CourierController, initializeCourier } from '../src/courier.mjs';
import { COURIER_ROLES } from '../src/couriercontent.mjs';
import { LIGHTHOUSE_ORDER_GAP_DAYS, galleryView, galleryViewText, jobSlots, keeperDoorNote, keeperLine, keeperPhase, lighthouseOrder } from '../src/courierlighthouse.mjs';

/**
 * The tutorial round plus a lighthouse, L, six kilometres out from the post
 * town A, kept by the Firths. Townspeople of A send the keeper their supplies.
 */
function fixture() {
  const state = createLivingWorldState({ worldSeed: 20260612, playerId: 'player:local' });
  const places = { A: { id: 'a', name: 'Ravenkeld', x: 0, z: 0 }, B: { id: 'b', name: 'Oakgate', x: 1000, z: 0 }, H: { id: 'h', name: 'Holtwick', x: 500, z: 300 } };
  const light = { key: 'M1_0', id: 'M1_0', name: 'Firth Lighthouse', kind: 'lighthouse', x: 6000, z: 0 };
  const cast = Object.fromEntries(Object.entries(COURIER_ROLES).map(([role, place]) => {
    const id = 'npc:' + role; state.entities[id] = { id, kind: 'npc', name: role, inTransit: false };
    return [role, { id, name: role, place }];
  }));
  const person = (id, name, at, address, role = 'resident') => {
    state.entities[id] = { id, kind: 'npc', name, inTransit: false };
    return { id, name, role, home: { id: id + ':home', name: name + '’s home', x: at.x, z: at.z, address } };
  };
  const keeper = person('npc:keeper', 'Ada Firth', light, 'Ada Firth’s household, the keeper’s house at the foot of Firth Lighthouse', 'lighthouse keeper');
  const townsfolk = [person('npc:chandler', 'Rowan Hale', places.A, 'north of the well'), person('npc:baker', 'Elis Moor', places.A, 'south of the well')];
  const where = { 'npc:keeper': light, 'npc:chandler': places.A, 'npc:baker': places.A };
  const player = { x: 0, z: 0, y: 2 };
  initializeCourier(state, { places, cast, routes: {} });
  const controller = new CourierController({ getState: () => state, getPlayer: () => player,
    getNpcPosition: id => where[id] || places[cast[id.replace('npc:', '')]?.place],
    getSourcePosition: id => id === 'board:M1_0' ? light : places[id.split(':')[1]],
    getPlace: key => key === light.key ? light : null });
  const visit = place => Object.assign(player, place === 'L' ? light : places[place]);
  const round = { id: light.id, key: light.key, name: light.name, keeper };
  const offer = (day = state.courier.plot.postDay || 0) => controller.offerLighthouseOrder('A', townsfolk, round, { day });
  const deliverFirst = () => {
    controller.accept('village-note', 'npc:dispatcher');
    assert.equal(controller.handoff('village-note', 'npc:guide').ok, true);
  };
  return { state, controller, visit, player, keeper, townsfolk, round, offer, deliverFirst, light };
}

test('the lighthouse order goes up in the post town after the first delivery, one at a time', () => {
  const { controller: c, offer, deliverFirst, state } = fixture();
  assert.equal(offer(), null, 'nothing for the lighthouse before the courier has delivered anything');
  deliverFirst();
  const order = offer();
  assert.ok(order, 'the order is posted once a delivery is done');
  assert.equal(order.cargo, 'oil');
  assert.equal(order.title, 'Lamp Oil for Firth Lighthouse');
  assert.equal(c.placeOf(order.sender), 'A');
  assert.equal(c.placeOf(order.recipient), 'M1_0');
  assert.equal(c.npc(order.recipient).home.address, 'Ada Firth’s household, the keeper’s house at the foot of Firth Lighthouse');
  assert.ok(c.boardJobs('A').some(job => job.id === order.id), 'it is pinned on the post town’s board');
  assert.equal(offer(), null, 'only one order is up at a time');
  assert.equal(state.courier.jobs[order.id].state, 'offered');
});

test('a standing order is never taken down unaccepted, so the lighthouse cannot drop off the round', () => {
  const { controller: c, offer, deliverFirst, townsfolk, state } = fixture();
  deliverFirst();
  const order = offer(0);
  for (let day = 1; day <= 12; day++) c.offerCommission('A', townsfolk, [{ key: 'B', name: 'Oakgate', people: [] }], { day });
  assert.ok(state.courier.plot.jobs[order.id], 'still there twelve post days later');
  assert.equal(state.courier.jobs[order.id].state, 'offered');
});

test('lamp oil takes two places in the satchel, and the satchel never locks', () => {
  const { controller: c, visit, offer, deliverFirst, state } = fixture();
  deliverFirst();
  const order = offer();
  assert.equal(jobSlots(order), 2);
  c.accept('first-letter', 'npc:dispatcher'); c.accept('trail-notes', 'npc:guide');
  assert.equal(c.satchelLoad(), 2);
  const refused = c.accept(order.id, order.sender);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /takes 2 places/);
  // Delivering one frees a place: the oil now fits, and fills the satchel.
  visit('B'); assert.equal(c.handoff('trail-notes', 'npc:archivist').ok, true);
  visit('A'); assert.equal(c.accept(order.id, order.sender).ok, true);
  assert.equal(c.satchelLoad(), 3);
  assert.equal(c.carryingHeavy()?.id, order.id);
  visit('H'); assert.match(c.accept('platform-seeds', 'npc:gardener').reason, /full/);
  // Every thing in it can still be delivered or taken back: nothing is stuck.
  visit('A'); assert.equal(c.handoff(order.id, order.sender, true).ok, true);
  assert.equal(state.courier.jobs[order.id].state, 'returned');
  assert.equal(c.satchelLoad(), 1);
});

test('the keeper writes back when the order is handed over in person, and it delivers once', () => {
  const { controller: c, visit, offer, deliverFirst, state } = fixture();
  deliverFirst();
  const order = offer();
  c.accept(order.id, order.sender);
  visit('L');
  const done = c.handoff(order.id, 'npc:keeper');
  assert.equal(done.ok, true);
  assert.match(done.message, /next fortnight of nights/);
  assert.match(done.message, /A Note from Firth Lighthouse/);
  assert.equal(c.handoff(order.id, 'npc:keeper').duplicate, true, 'a second handoff is not a second delivery');
  const reply = Object.values(state.courier.plot.jobs).find(def => def.lighthouseReply);
  assert.ok(reply);
  assert.equal(reply.sender, 'npc:keeper'); assert.equal(reply.recipient, order.sender);
  assert.equal(c.placeOf(reply.sender), 'M1_0');
  assert.ok(c.boardJobs('M1_0').some(job => job.id === reply.id), 'the reply waits at the lighthouse');
  // The next order waits a few post days, then it is the glass.
  state.courier.plot.postDay = (state.courier.plot.postDay || 0) + LIGHTHOUSE_ORDER_GAP_DAYS - 1;
  assert.equal(offer(), null);
  state.courier.plot.postDay++;
  assert.equal(offer()?.cargo, 'glass');
});

test('the lamp glass cracks if run with on foot, not on the train, and still delivers', () => {
  const { controller: c, visit, offer, deliverFirst, state, player } = fixture();
  deliverFirst();
  state.courier.plot.lighthouse = { count: 1, lastDay: null };
  const glass = offer();
  assert.equal(glass.cargo, 'glass'); assert.equal(glass.fragile, true);
  c.accept(glass.id, glass.sender);
  for (let i = 0; i < 60; i++) { player.x += 1; c.recordTravel(0.2, { position: player, mode: 'train', sprint: true }); }
  assert.equal(state.courier.jobs[glass.id].condition, 'intact', 'the train is gentle');
  let message = '';
  c.subscribe(result => { if (result?.message) message = result.message; });
  for (let i = 0; i < 30; i++) { player.x += 2; c.recordTravel(0.2, { position: player, mode: 'foot', sprint: true }); }
  assert.equal(state.courier.jobs[glass.id].condition, 'chipped');
  assert.match(message, /lamp glass has cracked/);
  visit('L');
  const done = c.handoff(glass.id, 'npc:keeper');
  assert.equal(done.ok, true);
  assert.match(done.message, /finds the crack/);
  assert.doesNotMatch(done.message, /holds tea/);
});

test('the box at the foot of the ramp takes post when the keeper is not there to sign for it', () => {
  const { controller: c, visit, offer, deliverFirst, state, player } = fixture();
  deliverFirst();
  const order = offer();
  c.accept(order.id, order.sender);
  assert.equal(c.leaveInBox(order.id, 'M1_0').ok, false, 'not from the town');
  visit('L'); player.x += 10;
  assert.equal(c.leaveInBox(order.id, 'M1_0').ok, false, 'stand by the box');
  visit('L');
  assert.equal(c.leaveInBox('first-letter', 'M1_0').ok, false, 'only post addressed here');
  const boxed = c.leaveInBox(order.id, 'M1_0');
  assert.equal(boxed.ok, true); assert.match(boxed.message, /box at the foot of the ramp/);
  assert.equal(state.courier.jobs[order.id].state, 'delivered');
  assert.equal(state.projections.items[state.courier.jobs[order.id].itemId].ownerId, 'npc:keeper');
  assert.equal(Object.values(state.courier.plot.jobs).some(def => def.lighthouseReply), false, 'nobody awake to write back');
  assert.equal(c.handoff(order.id, 'npc:keeper').duplicate, true, 'it is not delivered twice');
  assert.equal(state.courier.plot.lighthouse.count, 1);
});

test('the keeper keeps watch-keeper’s hours, and says so without AI', () => {
  assert.equal(keeperPhase(19), 'lamp-time');
  assert.equal(keeperPhase(23), 'watch'); assert.equal(keeperPhase(2), 'watch');
  assert.equal(keeperPhase(6), 'dawn');
  assert.equal(keeperPhase(10), 'asleep');
  assert.equal(keeperPhase(16), 'day');
  for (const hour of [19, 23, 6, 10, 16]) {
    const said = keeperLine({ hour, seed: 7, town: 'Ravenkeld' });
    assert.ok(said.line.length > 20);
    assert.doesNotMatch(said.line, /\{/);
    assert.match(keeperLine({ hour, seed: 7, inbound: 'Lamp Oil for Firth Lighthouse' }).line, /Is that Lamp Oil for Firth Lighthouse\?/);
  }
  assert.match(keeperDoorNote({ hour: 10, surname: 'Firth' }), /Asleep after the night’s watch.*box at the foot of the ramp.*The Firths/);
  assert.match(keeperDoorNote({ hour: 22, surname: 'Firth' }), /On watch/);
  assert.deepEqual([0, 1, 2, 3].map(count => lighthouseOrder(count).cargo), ['oil', 'glass', 'stores', 'oil']);
});

test('the gallery names what it overlooks, with directions and walking times', () => {
  const view = galleryView({ from: { x: 0, z: 0 },
    places: [{ name: 'Ravenkeld', x: -5000, z: 0, kind: 'settlement' }, { name: 'the great tree', x: 0, z: 2000, kind: 'tree' },
      { name: 'a cave mouth', x: 1500, z: 1500, kind: 'cave' }, { name: 'here', x: 5, z: 5, kind: 'settlement' }],
    walkTime: m => Math.round(m / 80) + ' minutes', compass: (dx, dz) => (dz > 0 ? 'north' : '') + (dx > 0 ? 'east' : dx < 0 ? 'west' : '') });
  assert.deepEqual(view.map(place => place.name), ['the great tree', 'a cave mouth', 'Ravenkeld']);
  assert.equal(view[2].direction, 'west'); assert.equal(view[2].walk, '63 minutes');
  assert.match(galleryViewText(view, 'Firth Lighthouse'), /From the gallery of Firth Lighthouse you can see:\n· the great tree, to the north/);
});
