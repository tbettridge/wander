import test from 'node:test';
import assert from 'node:assert/strict';
import { WELCOME_OFFER_STEP, goodbyeIntent, skipIntent, welcomeLines } from '../src/courierwelcome.mjs';

async function world() {
  const { createLivingWorldState } = await import('../src/livingworldstate.mjs');
  const { CourierController, initializeCourier } = await import('../src/courier.mjs');
  const { COURIER_ROLES } = await import('../src/couriercontent.mjs');
  const state = createLivingWorldState({ worldSeed: 20260612, playerId: 'player:local' });
  const names = { dispatcher: 'Ada Dale', guide: 'Mara Holt' };
  const cast = Object.fromEntries(Object.keys(COURIER_ROLES).map(role => {
    state.entities['npc:' + role] = { id: 'npc:' + role, kind: 'npc', name: names[role] || role };
    return [role, { id: 'npc:' + role, name: names[role] || role, place: COURIER_ROLES[role],
      home: { id: 'home:' + role, name: role + '’s home', x: 0, z: 0, address: (names[role] || role) + '’s household, east of the central well in Ravenkeld' } }];
  }));
  initializeCourier(state, { places: { A: { id: 'a', name: 'Ravenkeld', x: 0, z: 0 }, B: { id: 'b', name: 'Oakgate', x: 3000, z: 0 }, H: { id: 'h', name: 'Holtwick', x: 1500, z: 900 } }, cast, routes: {} }, { storySeed: 4 });
  const player = { x: 0, z: 0 };
  const c = new CourierController({ getState: () => state, getPlayer: () => player, getNpcPosition: () => ({ x: 1, z: 0 }),
    getSourcePosition: () => null, getNpcPlace: id => (id.startsWith('npc:') ? COURIER_ROLES[id.slice(4)] : null) });
  c.pendingOffers = new Map();
  const lines = welcomeLines({ ada: 'Ada Dale', home: { name: 'Ravenkeld', station: true }, up: { name: 'Oakgate', walk: 'an hour', station: true },
    out: { name: 'Holtwick', walk: 'half an hour' }, guide: { name: 'Mara Holt', address: 'whose house is east of the central well in Ravenkeld' } });
  return { state, c, lines, S: () => state.courier };
}

test('the welcome greets, explains the post and the board, names the neighbours and the ways there, then offers the first errand', () => {
  const lines = welcomeLines({ ada: 'Ada Dale', home: { name: 'Ravenkeld', station: true }, up: { name: 'Oakgate', walk: 'an hour', station: true },
    out: { name: 'Holtwick', walk: 'half an hour' }, guide: { name: 'Mara Holt', address: 'whose house is east of the well' } });
  assert.equal(lines.length, WELCOME_OFFER_STEP + 1);
  assert.match(lines[0], /new courier\. Welcome to Ravenkeld\. I am Ada/);
  assert.match(lines[1], /satchel holds three/); assert.match(lines[1], /never a line on a map/);
  assert.match(lines[2], /Post & Errands board/); assert.match(lines[2], /morning bell/); assert.match(lines[2], /press E/);
  assert.match(lines[3], /Oakgate is up the line, an hour on foot or a short ride on the regional train/);
  assert.match(lines[3], /Holtwick is out past the fields, half an hour/); assert.match(lines[3], /lend you a horse/);
  assert.match(lines[4], /first errand.*Mara Holt.*Will you take it\?$/);
  for (const line of lines) assert.doesNotMatch(line, /undefined|null|\{|\}/);
});

test('goodbyes are heard, and other talk is not mistaken for one', () => {
  for (const text of ['Goodbye', 'bye!', 'Okay, bye for now', 'See you later', 'Thanks, see ya', 'I have to go', 'I’ve got to go now', 'Farewell, Ada', 'take care', 'I must be going']) {
    assert.equal(goodbyeIntent(text), true, text);
  }
  for (const text of ['Hello', 'Where is the guide?', 'I will not say goodbye yet', 'by the well', 'Can you tell me how the board works and whether I should take the train to Oakgate or walk there on foot?']) {
    assert.equal(goodbyeIntent(text), false, text);
  }
  assert.equal(skipIntent('No thanks, I know how it works'), true);
  assert.equal(skipIntent('Yes please'), false);
});

test('Ada talks the courier through the welcome, and taking the first errand ends it with good luck', async () => {
  const { c, lines, S } = await world();
  const { handleCourierUtterance } = await import('../src/courierdialogue.mjs');
  assert.ok(c.startWelcome('npc:dispatcher', lines));
  assert.equal(c.contextForNpc('npc:dispatcher').welcome, lines[0], 'she opens the conversation');
  let reply = handleCourierUtterance(c, 'npc:dispatcher', 'Hello! Yes please.');
  assert.equal(reply.reply.text, lines[1]);
  assert.equal(c.contextForNpc('npc:dispatcher').welcome, undefined);
  reply = handleCourierUtterance(c, 'npc:dispatcher', 'Okay, makes sense.');
  assert.equal(reply.reply.text, lines[2]);
  reply = handleCourierUtterance(c, 'npc:dispatcher', 'And where can I go from here?');
  assert.equal(reply.reply.text, lines[3]);
  reply = handleCourierUtterance(c, 'npc:dispatcher', 'Good to know.');
  assert.equal(reply.reply.text, lines[4]);
  assert.equal(c.pendingOffers.get('npc:dispatcher')?.jobId, 'village-note', 'the first errand is held out');
  reply = handleCourierUtterance(c, 'npc:dispatcher', 'Yes, I will take it');
  assert.equal(reply.endConversation, true);
  assert.match(reply.reply.text, /^Here you are\. A Note Across the Village is in your satchel/);
  assert.match(reply.reply.text, /Good luck out there, courier/);
  assert.equal(S().jobs['village-note'].state, 'active');
  assert.equal(S().onboarding.seen, true); assert.equal(S().onboarding.choice, 'easy');
  assert.equal(c.welcome, null);
});

test('a courier who knows the work skips to the errand, and turning it down still ends kindly', async () => {
  const { c, lines, S } = await world();
  const { handleCourierUtterance } = await import('../src/courierdialogue.mjs');
  c.startWelcome('npc:dispatcher', lines);
  let reply = handleCourierUtterance(c, 'npc:dispatcher', 'No thanks, I know how it works.');
  assert.match(reply.reply.text, /^Then I will not keep you with the rest\. Now, your first errand/);
  reply = handleCourierUtterance(c, 'npc:dispatcher', 'Not right now');
  assert.equal(reply.endConversation, true); assert.match(reply.reply.text, /on the board whenever you want it/);
  assert.equal(S().jobs['village-note'].state, 'declined');
  assert.equal(S().onboarding.seen, true);
});

test('goodbye at any point ends the conversation, with Ada or anyone else', async () => {
  const { c, lines, S } = await world();
  const { handleCourierUtterance } = await import('../src/courierdialogue.mjs');
  c.startWelcome('npc:dispatcher', lines);
  handleCourierUtterance(c, 'npc:dispatcher', 'Hi');
  const parting = handleCourierUtterance(c, 'npc:dispatcher', 'Sorry, I have to go. Bye!');
  assert.equal(parting.endConversation, true); assert.match(parting.reply.text, /^Off already\? Then good luck, courier/);
  assert.equal(c.welcome, null); assert.equal(S().onboarding.seen, true); assert.equal(S().jobs['village-note'].state, 'offered', 'nothing taken');
  const other = handleCourierUtterance(c, 'npc:guide', 'Goodbye');
  assert.equal(other.endConversation, true); assert.ok(other.reply.text.length > 5);
  // Held out a job and then said goodbye: the offer is withdrawn, not accepted.
  c.pendingOffers.set('npc:guide', { jobId: 'trail-notes' });
  handleCourierUtterance(c, 'npc:guide', 'see you later');
  assert.equal(c.pendingOffers.has('npc:guide'), false);
  assert.equal(S().jobs['trail-notes'].state, 'offered');
});
