import test from 'node:test';
import assert from 'node:assert/strict';
import { CourierUI } from '../src/courierui.js';
import { createNotebook } from '../src/notebook.mjs';
import { createLivingWorldState } from '../src/livingworldstate.mjs';
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
  const controller = new CourierController({ getState: () => state, getPlayer: () => player,
    getNpcPosition: id => positions[id], getSourcePosition: id => places[id.split(':')[1]],
    getNpcPlace: id => id === 'npc:local' ? 'A' : id === 'npc:visitor' ? 'B' : null });
  const book = createNotebook();
  book.pages[0].title = 'Field notes'; book.pages[0].text = 'Keep the well on my left.';
  book.pages[0].strokes.push({ id: 'my-map', color: '#25352e', width: 3, points: [[0.2, 0.3], [0.7, 0.8]] });
  const ui = Object.create(CourierUI.prototype);
  Object.assign(ui, { controller, notebook: { book, lastError: null }, view: 'welcome', pageId: book.pages[0].id,
    focusedJobId: null, chatDraft: '', message: '', erase: false, getNearbyBoards: () => [{ place: 'A', name: 'Ash post desk', contactName: 'Lorne', address: 'beside the village well' }],
    getNearbySources: () => [], renderer: { xr: { isPresenting: false } },
    population: { dialogueOpen: false, conversationNpcId: null, activeNpc: null, chatBusy: false,
      dialogueSnapshot: () => ({ messages: [] }) } });
  ui.render = () => {};
  ui.renderReminder = () => {};
  ui.flush = () => Promise.resolve(true);
  ui.action = result => { if (result?.ok) ui.syncCollected(); return result; };
  return { state, controller, book, ui };
}

test('welcome choice opens the local lead without accepting it and keeps the handwritten notebook intact', () => {
  const { state, controller, book, ui } = fixture();
  const welcome = ui.screen();
  assert.deepEqual(welcome.buttons.map(action => action.label), [
    'Show me an easy delivery', 'Explain how this works', 'I’ll explore first',
  ]);

  welcome.buttons[0].run();
  assert.equal(state.courier.onboarding.seen, true);
  assert.equal(state.courier.onboarding.choice, 'easy');
  assert.equal(ui.view, 'leads');
  assert.equal(state.courier.jobs['village-note'].state, 'offered');
  assert.equal(state.projections.items['courier:item:village-note'], undefined);

  const lead = ui.screen();
  const text = lead.paragraphs.join('\n');
  assert.match(text, /A Note Across the Village/);
  assert.match(text, /Sender home address: dispatcher cottage, beside the well/);
  assert.match(text, /Recipient home address: guide cottage, beside the well/);
  assert.match(text, /Ash/);
  assert.doesNotMatch(text, /\bin A\b/);
  assert.ok(lead.buttons.some(action => action.label === 'Meet dispatcher'));

  ui.syncCollected();
  assert.equal(book.pages[0].title, 'Field notes');
  assert.equal(book.pages[0].text, 'Keep the well on my left.');
  assert.deepEqual(book.pages[0].strokes[0].points, [[0.2, 0.3], [0.7, 0.8]]);
  assert.ok(book.collected.some(page => page.id === 'guide:first-post'));
  assert.ok(book.collected.some(page => page.id === 'lead:village-note'));

  let visited;
  ui.onVisitContact = contact => { visited = contact; };
  lead.buttons.find(action => action.label === 'Meet dispatcher').run();
  assert.deepEqual(visited, { jobId: 'village-note', contactId: 'npc:dispatcher', place: 'Ash',
    address: 'dispatcher cottage, beside the well', name: 'dispatcher' });
  assert.equal(state.courier.jobs['village-note'].state, 'offered');
  assert.equal(state.projections.items['courier:item:village-note'], undefined);

  const boardAction = ui.screen().buttons.find(action => action.label === 'Read board: Ash post desk');
  assert.ok(boardAction);
  boardAction.run();
  assert.equal(Object.keys(state.courier.leads).length, 3);
  assert.ok(book.collected.some(page => page.id === 'lead:trail-notes'));
});

test('opening an ordinary neighbor conversation records and displays referrals without accepting work', () => {
  const { state, controller, ui } = fixture();
  ui.view = 'conversation';
  ui.population.dialogueOpen = true;
  ui.population.conversationNpcId = 'npc:local';
  ui.population.activeNpc = { identity: { id: 'npc:local', name: 'A local neighbor' }, distance: 1 };
  ui.learnConversationLeads();

  assert.ok(state.courier.leads['job:village-note']);
  const screen = ui.screen();
  assert.ok(screen.paragraphs.some(text => text.includes('Local referral: A Note Across the Village')));
  const action = screen.buttons.find(item => item.label === 'View lead: A Note Across the Village');
  assert.ok(action);
  action.run();
  assert.equal(ui.view, 'leads');
  assert.equal(state.courier.jobs['village-note'].state, 'offered');
  assert.equal(state.projections.items['courier:item:village-note'], undefined);
});
