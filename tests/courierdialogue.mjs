import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState } from '../src/livingworldstate.mjs';
import { CourierController, initializeCourier } from '../src/courier.mjs';
import { COURIER_ROLES } from '../src/couriercontent.mjs';
import { handleCourierUtterance } from '../src/courierdialogue.mjs';
import { safeFallbackDialogue } from '../src/livingworld.mjs';

function fixture() {
  const state = createLivingWorldState({ worldSeed: 20260612, playerId: 'player:local' });
  const places = {
    A: { id: 'a', name: 'Ash', x: 0, z: 0 },
    B: { id: 'b', name: 'Bell', x: 1000, z: 0 },
    H: { id: 'h', name: 'Hazel', x: 500, z: 300 },
  };
  const cast = Object.fromEntries(Object.entries(COURIER_ROLES).map(([role, place]) => {
    const id = `npc:${role}`;
    state.entities[id] = { id, kind: 'npc', name: role, inTransit: false };
    return [role, { id, name: role, place }];
  }));
  const positions = Object.fromEntries(Object.entries(cast).map(([role, person]) => [person.id, places[COURIER_ROLES[role]]]));
  for (const [id, name, place] of [['npc:neighbor', 'Mira Moss', 'A'], ['npc:bell-neighbor', 'Rowan Vale', 'B']]) {
    state.entities[id] = { id, kind: 'npc', name, inTransit: false };
    positions[id] = places[place];
  }
  const player = { x: 0, z: 0, y: 2 };
  initializeCourier(state, { places, cast, routes: {} });
  const controller = new CourierController({
    getState: () => state,
    getPlayer: () => player,
    getNpcPosition: id => positions[id] || null,
    getSourcePosition: id => {
      const position = places[id.split(':')[1]];
      return position ? { x: position.x, z: position.z } : null;
    },
    getNpcPlace: id => id === 'npc:neighbor' ? 'A' : id === 'npc:bell-neighbor' ? 'B' : null,
  });
  return { state, controller, player, visit: place => Object.assign(player, places[place]) };
}

test('a local welcome leads with the available village note and keeps the longer First Letter visible', () => {
  const { controller } = fixture();
  const context = controller.contextForNpc('npc:dispatcher');
  const reply = safeFallbackDialogue({ courier: context });
  assert.match(reply.text, /A Note Across the Village/);
  assert.match(reply.text, /First Letter/);
  assert.ok(reply.text.indexOf('A Note Across the Village') < reply.text.indexOf('First Letter'));
  assert.doesNotMatch(reply.text, /home address|currently at|is waiting at/);
});

test('spoken recipient names identify the correct errand and an uncertain surname cannot accept it', () => {
  const first = fixture();
  first.state.courier.bindings.cast.gardener.name = 'Faye Barton';
  const reply = handleCourierUtterance(first.controller, 'npc:dispatcher', 'I will take the letter for Fay Barton.');
  assert.equal(reply.jobId, 'first-letter');
  assert.equal(reply.result.applied, true);
  assert.equal(first.state.courier.jobs['first-letter'].state, 'active');
  assert.equal(first.state.courier.jobs['village-note'].state, 'offered');
  const uncertain = fixture();
  uncertain.state.courier.bindings.cast.gardener.name = 'Faye Barton';
  const clarification = handleCourierUtterance(uncertain.controller, 'npc:dispatcher', 'I will take the letter for Fay Bartun.');
  assert.match(clarification.reply.text, /Do you mean Faye Barton/);
  assert.equal(uncertain.state.courier.jobs['first-letter'].state, 'offered');
});

test('a named real offer is accepted once and only a successful controller receipt says it is in the satchel', () => {
  const { controller, state } = fixture();
  const accepted = handleCourierUtterance(controller, 'npc:dispatcher', 'I’ll take A Note Across the Village.');
  assert.equal(accepted.handled, true);
  assert.equal(accepted.result.applied, true);
  assert.match(accepted.reply.text, /in your satchel/);
  assert.equal(state.courier.jobs['village-note'].state, 'active');
  assert.equal(state.projections.items['courier:item:village-note'].ownerId, state.playerId);

  const repeat = handleCourierUtterance(controller, 'npc:dispatcher', 'I’ll take A Note Across the Village.');
  assert.equal(repeat.handled, true);
  assert.match(repeat.reply.text, /already accepted or complete/);
  assert.doesNotMatch(repeat.reply.text, /in your satchel/);
});

test('the accepted-action handler makes no model or provider calls', () => {
  const { controller, state } = fixture();
  let providerCalls = 0;
  controller.resumeFromUserGesture = () => { providerCalls++; };
  controller.requestChatReply = () => { providerCalls++; };
  const accepted = handleCourierUtterance(controller, 'npc:dispatcher', 'I’ll take A Note Across the Village.');
  assert.equal(providerCalls, 0);
  assert.equal(accepted.result.applied, true);
  assert.match(accepted.reply.text, /in your satchel/);
  assert.equal(state.projections.items['courier:item:village-note'].ownerId, state.playerId);
});

test('a plain yes accepts only one offer actually named in the preceding assistant line', () => {
  const { controller, state } = fixture();
  const ambiguous = handleCourierUtterance(controller, 'npc:dispatcher', 'Yes, please.', {
    lastAssistantText: 'I can offer First Letter, or the local A Note Across the Village.',
  });
  assert.equal(ambiguous.handled, true);
  assert.match(ambiguous.reply.text, /Which errand/);
  assert.equal(state.courier.jobs['first-letter'].state, 'offered');
  assert.equal(state.courier.jobs['village-note'].state, 'offered');

  const one = handleCourierUtterance(controller, 'npc:dispatcher', 'Yes, please.', {
    lastAssistantText: 'I can offer A Note Across the Village to the trail guide.',
  });
  assert.equal(one.result.applied, true);
  assert.equal(state.courier.jobs['village-note'].state, 'active');
});

test('negative, quoted, hypothetical, capability-only, and unrelated yes statements do not accept work', () => {
  const { controller, state } = fixture();
  const statements = [
    'No, I will not take First Letter.',
    'I will take First Letter, but not today.',
    'I could take First Letter.',
    'I would take First Letter.',
    'What if I said I’ll take First Letter?',
    'They said “I’ll take First Letter.”',
  ];
  for (const text of statements) assert.equal(handleCourierUtterance(controller, 'npc:dispatcher', text), null, text);
  assert.equal(handleCourierUtterance(controller, 'npc:dispatcher', 'Yes, that sounds lovely.'), null);
  assert.equal(state.courier.jobs['first-letter'].state, 'offered');
  assert.equal(state.courier.jobs['village-note'].state, 'offered');
});

test('distant and unavailable offers return truthful failures without claiming a parcel', () => {
  const { controller, state, visit } = fixture();
  visit('B');
  assert.equal(handleCourierUtterance(controller, 'npc:bell-neighbor', 'I’ll take First Letter.'), null,
    'the Ash posting is not exposed in a Bell resident context');

  visit('H');
  assert.equal(controller.accept('platform-cup', 'npc:potter').ok, true);
  assert.equal(controller.accept('platform-seeds', 'npc:gardener').ok, true);
  visit('B');
  assert.equal(controller.accept('return-manuscript', 'npc:poet').ok, true);
  visit('A');
  const full = handleCourierUtterance(controller, 'npc:dispatcher', 'I’ll take A Note Across the Village.');
  assert.match(full.reply.text, /satchel is full/i);
  assert.doesNotMatch(full.reply.text, /in your satchel/);
  assert.notEqual(state.courier.jobs['village-note'].state, 'active');

  const owner = fixture();
  owner.state.projections.items['courier:item:village-note'] = {
    id: 'courier:item:village-note', ownerId: 'npc:someone-else', kind: 'letter', purpose: 'courier',
  };
  const missing = handleCourierUtterance(owner.controller, 'npc:dispatcher', 'I’ll take A Note Across the Village.');
  assert.match(missing.reply.text, /sender does not have this parcel/i);
  assert.doesNotMatch(missing.reply.text, /in your satchel/);
});

test('ordinary residents persist and describe only their own community referrals; board questions point to the canonical board', () => {
  const { controller, state, visit } = fixture();
  const referral = handleCourierUtterance(controller, 'npc:neighbor', 'Any work or errands around here?');
  assert.equal(referral.handled, true);
  assert.match(referral.reply.text, /A Note Across the Village/);
  assert.match(referral.reply.text, /First Letter/);
  assert.equal(referral.reply.targetId, 'npc:dispatcher');
  assert.equal(state.courier.knownOffers['village-note'], true);
  assert.equal(state.courier.knownOffers['first-letter'], true);
  // Trail Notes is posted by the guide in Ash even though its destination is
  // Bell. Other communities' postings remain outside this local view.
  for (const remoteTitle of ['Seeds for the Platform', 'Return Manuscript', 'Catalog Copy']) {
    assert.doesNotMatch(referral.reply.text, new RegExp(remoteTitle));
  }
  assert.doesNotMatch(referral.reply.text, /home address|cottage|currently at/);

  const board = handleCourierUtterance(controller, 'npc:neighbor', 'Where is the public board?');
  assert.equal(board.reply.targetId, 'board:A');
  assert.match(board.reply.text, /Post & Errands board/);

  visit('B');
  const bellLead = handleCourierUtterance(controller, 'npc:bell-neighbor', 'Can I help with anything around here?');
  assert.equal(bellLead.handled, true);
  assert.match(bellLead.reply.text, /Return Manuscript|Catalog Copy/);
  assert.doesNotMatch(bellLead.reply.text, /A Note Across the Village|First Letter/);
});
