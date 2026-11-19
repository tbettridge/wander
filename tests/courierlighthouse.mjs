import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState } from '../src/livingworldstate.mjs';
import { CourierController, initializeCourier } from '../src/courier.mjs';
import { COURIER_ROLES } from '../src/couriercontent.mjs';
import { KEEPER_LOG_REACTIONS, LIGHTHOUSE_ORDER_GAP_DAYS, galleryView, galleryViewText, jobSlots, keeperDoorNote, keeperLine, keeperLog, keeperLogNight,
  keeperPhase, keeperSchedule, lampLit, lighthouseOrder, repeatingShip } from '../src/courierlighthouse.mjs';
import { STORY_FIRST, beatDone, storyNeeds, storyThreads } from '../src/courierstory.mjs';

/**
 * The tutorial round plus a lighthouse, L, six kilometres out from the post
 * town A, kept by the Firths. Townspeople of A send the keeper their supplies.
 */
function fixture({ watch = { onWatch: false, atGallery: false } } = {}) {
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
    getPlace: key => key === light.key ? light : null,
    onWatch: id => watch.onWatch && id === 'npc:keeper', atGallery: () => watch.atGallery });
  const visit = place => Object.assign(player, place === 'L' ? light : places[place]);
  const round = { id: light.id, key: light.key, name: light.name, keeper };
  const offer = (day = state.courier.plot.postDay || 0) => controller.offerLighthouseOrder('A', townsfolk, round, { day });
  const deliverFirst = () => {
    controller.accept('village-note', 'npc:dispatcher');
    assert.equal(controller.handoff('village-note', 'npc:guide').ok, true);
  };
  return { state, controller, visit, player, keeper, townsfolk, round, offer, deliverFirst, light, watch };
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
  assert.equal(keeperPhase(17.5), 'lamp-time');
  assert.equal(keeperPhase(19), 'watch'); assert.equal(keeperPhase(23), 'watch'); assert.equal(keeperPhase(2), 'watch');
  assert.equal(keeperPhase(6), 'dawn');
  assert.equal(keeperPhase(10), 'asleep');
  assert.equal(keeperPhase(16), 'day');
  for (const hour of [17.5, 23, 6, 10, 16]) {
    const said = keeperLine({ hour, seed: 7, town: 'Ravenkeld' });
    assert.ok(said.line.length > 20);
    assert.doesNotMatch(said.line, /\{/);
    assert.match(keeperLine({ hour, seed: 7, inbound: 'Lamp Oil for Firth Lighthouse' }).line, /Is that Lamp Oil for Firth Lighthouse\?/);
  }
  assert.match(keeperDoorNote({ hour: 10, surname: 'Firth' }), /Asleep after the night’s watch.*box at the foot of the ramp.*The Firths/);
  assert.match(keeperDoorNote({ hour: 22, surname: 'Firth' }), /On watch/);
  assert.deepEqual([0, 1, 2, 3, 4].map(count => lighthouseOrder(count).cargo), ['oil', 'glass', 'stores', 'watch', 'oil']);
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

test('the keeper climbs to the lamp at lamp-time, keeps the watch, and comes down at sunrise', () => {
  assert.equal(keeperSchedule(12), null, 'the middle of the day is their own');
  assert.equal(keeperSchedule(16.5), null);
  assert.equal(keeperSchedule(16.8), 'up'); assert.equal(keeperSchedule(23), 'up'); assert.equal(keeperSchedule(5.9), 'up');
  assert.equal(keeperSchedule(6.2), 'down'); assert.equal(keeperSchedule(8.5), null);
  // Watched, the lamp is lit when the keeper reaches it; unwatched, once the climb would be done.
  assert.equal(lampLit({ hour: 17.2, watched: true }), false, 'not before the keeper is up');
  assert.equal(lampLit({ hour: 17.2, watched: true, keeperUp: true }), true, 'lit as the keeper arrives');
  assert.equal(lampLit({ hour: 17.95 }), true, 'nobody watching: lit once the climb is done');
  assert.equal(lampLit({ hour: 17.95, watched: true }), false);
  assert.equal(lampLit({ hour: 18.5, watched: true }), true, 'never left dark past dusk');
  assert.equal(lampLit({ hour: 2 }), true); assert.equal(lampLit({ hour: 6.5, keeperUp: true }), false, 'out at sunrise');
  assert.equal(lampLit({ hour: 14, keeperUp: true }), false);
});

test('the keeper’s log has a ship every night, and one at the same minute every night, in every log', () => {
  for (const seed of [1, 77, 20260612]) {
    const ship = repeatingShip(seed);
    const nights = Array.from({ length: 12 }, (_, night) => keeperLogNight(seed, night));
    for (const page of nights) {
      const again = page.entries.filter(entry => entry.repeating);
      assert.equal(again.length, 1);
      assert.deepEqual([again[0].name, again[0].time, again[0].flag, again[0].heading], [ship.name, ship.time, ship.flag, ship.heading]);
      assert.equal(page.entries.filter(entry => entry.name === ship.name).length, 1, 'nobody else sails under its name');
      assert.ok(page.entries.length >= 3 && page.entries.length <= 4);
      assert.equal(page.entries.filter(entry => !entry.repeating).some(entry => entry.time === ship.time), false, 'only it has that minute');
    }
    assert.notDeepEqual(nights[0].entries.map(entry => entry.name), nights[1].entries.map(entry => entry.name), 'the other ships change');
    assert.deepEqual(keeperLogNight(seed, 3), keeperLogNight(seed, 3), 'a page is the same however often it is read');
    const log = keeperLog({ seed, day: 5, keeper: 'Ada Firth', light: 'Firth Lighthouse' });
    assert.equal(log.pages.length, 3);
    assert.match(log.recent[0], /The log of Firth Lighthouse, kept by Ada Firth/);
    assert.match(log.recent.join('\n'), /^Last night\./m);
    assert.ok(log.oldest.some(line => line.includes(ship.time + '  The ' + ship.name)), 'the oldest page has it too');
    assert.match(log.oldest[0], /not Ada’s/);
    assert.doesNotMatch([...log.recent, ...log.oldest].join('\n'), /\{|undefined|NaN/);
  }
  assert.notEqual(repeatingShip(1).name + repeatingShip(1).time, repeatingShip(2).name + repeatingShip(2).time, 'each story has its own ship');
});

test('reading the log gives the record clue, both halves at once, and the director never goes looking for it', () => {
  const { controller: c, state, keeper, light } = fixture();
  const log = keeperLog({ seed: state.courier.plot.seed, day: 0, keeper: keeper.name, light: light.name });
  const read = () => c.readKeeperLog({ keeper: { id: keeper.id, name: keeper.name }, light: { id: light.id, name: light.name }, log });
  const early = read();
  assert.equal(early.applied, false);
  assert.match(early.message, /means nothing much to you yet/);
  assert.equal(state.courier.evidence['keeper-log'], undefined, 'not a clue before the dispatch sheet');
  state.courier.evidence[STORY_FIRST] = { id: STORY_FIRST, sourceIds: [] };
  const needs = storyNeeds(state.courier).map(need => need.account);
  assert.equal(needs.some(id => id.startsWith('keeper-log')), false);
  const done = read();
  assert.equal(done.ok, true);
  assert.match(done.message, /New in your book: “The keeper’s log”, “The oldest log on the shelf” and “The horizon doesn’t move”/);
  assert.ok(state.courier.evidence['keeper-log'] && state.courier.evidence['keeper-log-old']);
  assert.equal(c.accountDoc('keeper-log').text, log.recent.join('\n'), 'the book keeps the page as it was read');
  assert.equal(c.accountDoc('keeper-log-old').author, keeper.name);
  const thread = storyThreads(state.courier).find(item => item.tell.id === 'keeper-log');
  assert.ok(thread?.ready, 'ready to compare on the Story page');
  assert.equal(storyNeeds(state.courier).some(need => need.account.startsWith('keeper-log')), false, 'nothing dangling for the director to place');
  assert.equal(c.compare('keeper-log').ok, true);
  assert.equal(beatDone(state.courier, 'record'), true, 'a record that repeats');
  assert.equal(read().applied, false, 'reading it again changes nothing');
});

test('read aloud, the log gets each temperament’s answer, and the keeper answers for their own book', () => {
  const { controller: c, state, keeper, light, visit } = fixture();
  state.courier.evidence[STORY_FIRST] = { id: STORY_FIRST, sourceIds: [] };
  c.readKeeperLog({ keeper: { id: keeper.id, name: keeper.name }, light: { id: light.id, name: light.name },
    log: keeperLog({ seed: 3, day: 0, keeper: keeper.name, light: light.name }) });
  visit('L');
  assert.equal(c.shareEvidence('npc:keeper', ['keeper-log']).message, KEEPER_LOG_REACTIONS.keeper);
  visit('A');
  for (const id of ['npc:chandler', 'npc:baker']) {
    const said = c.shareEvidence(id, ['keeper-log']);
    assert.equal(said.ok, true);
    assert.ok(said.message.endsWith(KEEPER_LOG_REACTIONS[said.stance]), id + ' answers as ' + said.stance);
  }
});

test('after dark the keeper is up at the lamp: post is handed over on the gallery, not left in the box', () => {
  const { controller: c, visit, offer, deliverFirst, state, watch } = fixture();
  deliverFirst();
  const order = offer();
  c.accept(order.id, order.sender);
  visit('L'); Object.assign(watch, { onWatch: true, atGallery: false });
  const boxed = c.leaveInBox(order.id, 'M1_0');
  assert.equal(boxed.ok, false); assert.match(boxed.reason, /up at the lamp and will sign for it there/);
  const below = c.handoff(order.id, 'npc:keeper');
  assert.equal(below.ok, false); assert.match(below.reason, /Ada is up at the lamp\. Take it up the stair/);
  watch.atGallery = true;
  assert.equal(c.handoff(order.id, 'npc:keeper').ok, true, 'handed over at the lamp');
  assert.equal(state.courier.jobs[order.id].state, 'delivered');
});

test('the watch’s supper is wanted after dark on the gallery, and never in the box', () => {
  const { controller: c, visit, offer, deliverFirst, state, watch } = fixture();
  deliverFirst();
  state.courier.plot.lighthouse = { count: 3, lastDay: null };
  const supper = offer();
  assert.equal(supper.cargo, 'watch'); assert.equal(supper.night, true);
  assert.match(supper.title, /Supper for the Watch at Firth Lighthouse/);
  assert.match(supper.description, /hand it over on the gallery/);
  assert.equal(c.accept(supper.id, supper.sender).ok, true);
  visit('L');
  const early = c.handoff(supper.id, 'npc:keeper');
  assert.equal(early.ok, false); assert.match(early.reason, /Bring it up to me at the lamp after dark/);
  assert.match(c.leaveInBox(supper.id, 'M1_0').reason, /not left in a box/);
  Object.assign(watch, { onWatch: true, atGallery: true });
  const done = c.handoff(supper.id, 'npc:keeper');
  assert.equal(done.ok, true); assert.match(done.message, /watch the light go round/);
  assert.ok(Object.values(state.courier.plot.jobs).some(def => def.lighthouseReply && def.replyTo === supper.id), 'the keeper writes back');
  // Nothing is ever stuck: an undelivered supper can always be taken back to its sender.
  const again = fixture();
  again.deliverFirst();
  again.state.courier.plot.lighthouse = { count: 3, lastDay: null };
  const next = again.offer();
  assert.equal(again.controller.accept(next.id, next.sender).ok, true);
  again.visit('A');
  const back = again.controller.handoff(next.id, next.sender, true);
  assert.equal(back.ok, true, back.reason);
});
