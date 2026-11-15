import test from 'node:test';
import assert from 'node:assert/strict';
import { LETTER_TOPICS, PARCEL_TOPICS, STORY_LETTER, dailyPostCount, droppedLetterClues, fill, postOpen, sightedFrom, sightedText,
  waysideFor, whereaboutsLine, wantsReply } from '../src/courierpost.mjs';

async function world() {
  const { createLivingWorldState } = await import('../src/livingworldstate.mjs');
  const { CourierController, initializeCourier } = await import('../src/courier.mjs');
  const { COURIER_ROLES } = await import('../src/couriercontent.mjs');
  const state = createLivingWorldState({ worldSeed: 20260612, playerId: 'player:local' });
  const cast = Object.fromEntries(Object.keys(COURIER_ROLES).map(role => { state.entities['npc:' + role] = { id: 'npc:' + role, kind: 'npc', name: role }; return [role, { id: 'npc:' + role, name: role, place: COURIER_ROLES[role] }]; }));
  initializeCourier(state, { places: { A: { id: 'a', name: 'Ash', x: 0, z: 0 }, B: { id: 'b', name: 'Bell', x: 1000, z: 0 }, H: { id: 'h', name: 'Hazel', x: 500, z: 300 } }, cast, routes: {} }, { storySeed: 21 });
  const sites = { 'settlement:1:1': { id: 'settlement:1:1', name: 'Thornby', x: 9000, z: 0 }, 'settlement:2:2': { id: 'settlement:2:2', name: 'Wickham', x: 12000, z: 0 } };
  const person = (id, name, site) => { state.entities[id] = { id, kind: 'npc', name }; return { id, name, role: 'farmer', home: { id: 'home:' + id, name: name + '’s home', x: sites[site].x, z: 0, address: name + '’s household, north of the well in ' + sites[site].name } }; };
  const thornby = [person('npc:t1', 'Wren Mallory', 'settlement:1:1'), person('npc:t2', 'Tom Reed', 'settlement:1:1')];
  const wickham = [person('npc:w1', 'Ida Fenn', 'settlement:2:2'), person('npc:w2', 'Bram Oakes', 'settlement:2:2')];
  const player = { ...sites['settlement:2:2'] };
  const positions = Object.fromEntries([...thornby.map(p => [p.id, sites['settlement:1:1']]), ...wickham.map(p => [p.id, sites['settlement:2:2']])]);
  const c = new CourierController({ getState: () => state, getPlayer: () => player, getNpcPosition: id => positions[id],
    getSourcePosition: () => null, getPlace: id => sites[id] || null, getNpcPlace: id => positions[id]?.id || null });
  return { state, c, sites, thornby, wickham, player, S: () => state.courier };
}

test('the post opens at the morning bell, closes when the sun is down, and each board posts two or three a day', () => {
  assert.equal(postOpen(7.9, 0.3), false); assert.equal(postOpen(8, 0.3), true);
  assert.equal(postOpen(17, 0.01), true); assert.equal(postOpen(18, -0.01), false);
  const counts = new Set(Array.from({ length: 40 }, (_, day) => dailyPostCount(7, 'settlement:1:1', day)));
  assert.deepEqual([...counts].sort(), [2, 3]);
  assert.equal(dailyPostCount(7, 'x', 3), dailyPostCount(7, 'x', 3));
});

test('every letter has a reason the recipient reacts to, in words that name the people', () => {
  for (const topic of [...LETTER_TOPICS, ...PARCEL_TOPICS]) {
    assert.ok(topic.gist.length > 20, topic.id);
    const said = fill(topic.reaction, { from: 'Wren Mallory', to: 'Tom Reed' });
    assert.match(said, /Tom/, topic.id); assert.doesNotMatch(said, /[{}]/, topic.id);
    if (topic.reply) assert.doesNotMatch(fill(topic.reply.reaction, { from: 'Tom Reed', to: 'Wren Mallory' }), /[{}]/);
  }
  const answered = Array.from({ length: 60 }, (_, i) => wantsReply(3, 'post:x:' + i, 'news')).filter(Boolean).length;
  assert.ok(answered > 15 && answered < 45, 'about half the answerable letters are answered');
  assert.equal(wantsReply(3, 'post:x:1', 'debt'), false, 'a debt repaid needs no reply');
  for (const stance of ['afraid', 'relieved', 'denying', 'curious']) assert.ok(STORY_LETTER.opened[stance]);
});

test('a neighbour says where someone has gone, or a note on the door does', () => {
  assert.match(whereaboutsLine({ name: 'Ida Fenn', neighbour: 'Bram Oakes', building: 'Fenn’s smithy' }), /^Nobody answers at Ida’s door\. Bram Oakes.*Fenn’s smithy/);
  assert.match(whereaboutsLine({ name: 'Ida Fenn', elsewhere: 'Thornby' }), /A note is pinned to it: “Gone over to Thornby for the day\.”/);
  assert.match(whereaboutsLine({ name: 'Ida Fenn', neighbour: 'Bram', compass: 'northwest' }), /off to the northwest of the house/);
  assert.match(whereaboutsLine({ name: 'Ida Fenn', neighbour: 'Bram' }), /Try again later/);
  assert.equal(whereaboutsLine({ name: 'Ida Fenn', compass: 'east' }), 'Nobody answers at Ida’s door. A note is pinned to it: “Out to the east. Back soon.”');
  assert.match(whereaboutsLine({ name: 'Ida Fenn' }), /“Out\. Back later\.”/);
});

test('the dropped letter’s clues are a first name, a place, a side of the well and an initial, never the whole name', () => {
  const clues = droppedLetterClues({ sender: 'Wren Mallory', recipient: 'Ida Fenn', placeName: 'Wickham', homeCompass: 'northeast' }).join(' ');
  assert.match(clues, /My dear I…/); assert.match(clues, /“Wren”/); assert.match(clues, /Wickham/); assert.match(clues, /northeast/);
  assert.doesNotMatch(clues, /Ida|Fenn|Mallory/);
});

test('beside a road: a shrine, a milestone, and a cairn only where a hill rises well above it', () => {
  const line = Array.from({ length: 11 }, (_, i) => ({ x: i * 200, z: 0 }));
  const hill = (x, z) => 40 * Math.exp(-((x - 1360) ** 2 + (z - 200) ** 2) / (2 * 90 ** 2));
  const items = waysideFor({ seed: 5, key: 'a~b', line, fromName: 'Ash', toName: 'Bell', groundAt: hill });
  assert.deepEqual(items.map(item => item.kind), ['shrine', 'milestone', 'cairn']);
  const cairn = items.find(item => item.kind === 'cairn');
  assert.ok(Math.hypot(cairn.x - 1360, cairn.z - 200) < 60, 'the cairn stands on the top');
  assert.match(items[1].text, /ASH .* BELL/);
  assert.deepEqual(waysideFor({ seed: 5, key: 'a~b', line, fromName: 'Ash', toName: 'Bell', groundAt: hill }), items, 'the same road gets the same roadside');
  assert.deepEqual(waysideFor({ seed: 5, key: 'a~b', line, fromName: 'Ash', toName: 'Bell', groundAt: () => 0 }).map(item => item.kind), ['shrine', 'milestone']);
  assert.deepEqual(waysideFor({ seed: 5, key: 'a~b', line: line.slice(0, 3), fromName: 'Ash', toName: 'Bell', groundAt: () => 0 }), [], 'too short a road');
});

test('from a cairn: smoke where the land does not hide it, a bell where it is near enough, with compass words', () => {
  // +Z north, +X west. A ridge lies to the north; open ground to the west.
  const ground = (x, z) => (z > 600 && z < 800 ? 120 : 0);
  const spot = { x: 0, z: 0, y: 30 };
  const seen = sightedFrom(spot, [
    { name: 'Westby', x: 1500, z: 0, bell: true },
    { name: 'Northam', x: 0, z: 1800, bell: true },
    { name: 'Faraway', x: -2600, z: 0, bell: false },
    { name: 'Hiddenham', x: 0, z: 2500, bell: false },
  ], ground);
  assert.deepEqual(seen.map(item => [item.name, item.compass, item.smoke, item.bell]),
    [['Westby', 'west', true, true], ['Northam', 'north', false, true], ['Faraway', 'east', true, false]]);
  const words = sightedText(seen);
  assert.match(words, /Chimney smoke to the west: Westby/); assert.match(words, /Northam lies hidden to the north/);
  assert.match(sightedText([]), /No smoke/);
});

test('residents remember what they were shown, and enough papers change their minds', async () => {
  const { c, S, thornby } = await world();
  const { STORY_TELLS } = await import('../src/courierstory.mjs');
  c.grantEvidence(S(), 'dispatch-now');
  const glitch = STORY_TELLS.find(tell => tell.beat === 'record' && tell.accounts.length > 1);
  for (const id of glitch.accounts) c.grantEvidence(S(), id);
  c.compare(glitch.id);
  const held = Object.keys(S().evidence);
  assert.ok(held.length >= 2);
  const denier = thornby[0].id;
  S().plot.stances[denier] = 'denying';
  const player = c.getPlayer(); Object.assign(player, { x: 9000, z: 0 });
  const first = c.shareEvidence(denier, [held[0]]);
  assert.equal(first.ok, true); assert.equal(first.remembered, 0);
  const again = c.shareEvidence(denier, [held[0]]);
  assert.match(again.message, /before/, 'shown the same paper twice, they say so');
  const second = c.shareEvidence(denier, [held[1]]);
  assert.match(second.message, /^“Last time it was ‘/);
  // A third paper wears the denial through.
  S().evidence['extra-paper'] = { id: 'extra-paper', sourceIds: [] };
  const third = c.react(denier, ['extra-paper']);
  assert.equal(third.shifted, true); assert.notEqual(S().plot.stances[denier], 'denying');
  assert.match(c.contextForNpc(denier).belief, /shown you 3 such papers/);
  // Someone frightened enough stops looking, and avoids the courier from then on.
  const fearful = thornby[1].id;
  S().plot.stances[fearful] = 'afraid';
  for (const id of ['p1', 'p2', 'p3']) { S().evidence[id] = { id, sourceIds: [] }; c.react(fearful, [id]); }
  S().evidence.p4 = { id: 'p4', sourceIds: [] };
  assert.equal(c.react(fearful, ['p4']).shifted, true);
  const refused = c.react(fearful, ['p1']);
  assert.equal(refused.avoided, true); assert.match(refused.message, /No more/);
  assert.match(c.contextForNpc(fearful).belief, /avoid them/);
});

test('a dropped letter is found on the road, carried without an address, and handed back by talking', async () => {
  const { c, S, thornby, wickham, player, sites } = await world();
  const { handleCourierUtterance } = await import('../src/courierdialogue.mjs');
  c.pendingOffers = new Map();
  const [owner, sender] = [wickham[0], thornby[0]];
  assert.ok(c.dropLetter({ x: 10500, z: 4, sender, recipient: owner, senderKey: 'settlement:1:1', recipientKey: 'settlement:2:2', homeCompass: 'north', day: 3 }));
  assert.equal(c.dropLetter({ x: 1, z: 1, sender, recipient: owner, senderKey: 'settlement:1:1', recipientKey: 'settlement:2:2', homeCompass: 'north', day: 3 }), null, 'one at a time');
  assert.equal(c.pickUpDropped().ok, false, 'from where it lies, not from afar');
  Object.assign(player, { x: 10501, z: 4 });
  const picked = c.pickUpDropped();
  assert.equal(picked.ok, true); assert.match(picked.message, /My dear I…/);
  assert.equal(S().plot.dropped, undefined);
  const def = Object.values(S().plot.jobs).find(item => item.dropped);
  assert.equal(S().jobs[def.id].state, 'active');
  assert.doesNotMatch(c.guidance().text, /Ida|Fenn/, 'the book does not say whose it is');
  // The wrong person says so; the right one is handed it by saying you found their letter.
  Object.assign(player, sites['settlement:2:2']);
  const wrong = handleCourierUtterance(c, wickham[1].id, 'I found this letter, is it yours?');
  assert.match(wrong.reply.text, /Not mine/); assert.match(wrong.reply.text, /someone here/);
  const right = handleCourierUtterance(c, owner.id, 'I found this letter on the road, is it yours?');
  assert.equal(right.delivered, def.id); assert.match(right.reply.text, /Wren’s letter/);
  assert.equal(S().jobs[def.id].state, 'delivered');
  assert.equal(c.dropLetter({ x: 1, z: 1, sender, recipient: owner, senderKey: 'settlement:1:1', recipientKey: 'settlement:2:2', homeCompass: 'north', day: 4 }), null, 'not again the next day');
});

test('an unopened story letter is shown to the courier by the one who receives it', async () => {
  const { c, S, thornby, wickham, player, sites } = await world();
  c.grantEvidence(S(), 'dispatch-now');
  const posted = c.offerCommission('settlement:2:2', wickham, [{ key: 'settlement:1:1', name: 'Thornby', people: thornby }], { day: 0 });
  const letter = posted.find(item => item.story);
  assert.equal(c.accept(letter.id, letter.sender).ok, true);
  Object.assign(player, sites['settlement:1:1']);
  const done = c.handoff(letter.id, letter.recipient);
  assert.equal(done.revealed, letter.reveals);
  assert.match(done.message, /colour goes out of their face/);
});
