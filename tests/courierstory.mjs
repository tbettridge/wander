import test from 'node:test';
import assert from 'node:assert/strict';
import { COURIER_EVIDENCE, COURIER_THREADS } from '../src/couriercontent.mjs';
import { STORY_ACCOUNTS, STORY_BEATS, STORY_FIRST, STORY_GLITCHES, STORY_REACTIONS, STORY_STANCES, STORY_TELLS, STORY_WORD,
  accountDef, activeTell, beatDone, beatOpen, createPlot, fallbackStoryWork, recordAccount, recordCompared, recordPattern,
  recordVoice, stanceOf, storyEnding, storyFacts, storyNeeds, storyThreads, tellsOf, upgradeCourierPlot,
  validateStoryWork } from '../src/courierstory.mjs';

const story = (seed = 5) => ({ runId: 'test', evidence: {}, compared: {}, hypothesis: false, plot: createPlot(seed) });
const hold = (s, ...ids) => { for (const id of ids) recordAccount(s, id); return s; };

test('the beats form a lattice: every prerequisite exists, nothing loops, and the ending needs everything before it', () => {
  const ids = new Set(STORY_BEATS.map(beat => beat.id)), depth = new Map();
  const needs = beat => beat.needs.flatMap(need => typeof need === 'string' ? [need] : need.anyOf);
  const measure = (id, trail = []) => {
    assert.equal(trail.includes(id), false, 'a beat cannot depend on itself: ' + [...trail, id].join(' → '));
    if (!depth.has(id)) depth.set(id, 1 + Math.max(0, ...needs(STORY_BEATS.find(beat => beat.id === id)).map(other => measure(other, [...trail, id]))));
    return depth.get(id);
  };
  for (const beat of STORY_BEATS) { for (const need of needs(beat)) assert.equal(ids.has(need), true, need); measure(beat.id); }
  assert.deepEqual(STORY_BEATS.filter(beat => !beat.needs.length).map(beat => beat.id), STORY_GLITCHES);
  assert.equal(depth.get('ending'), Math.max(...depth.values()));
});
test('every placed beat has interchangeable tells, built from authored facts', () => {
  for (const beat of STORY_BEATS.filter(item => ['glitch', 'placed'].includes(item.kind))) {
    const tells = tellsOf(beat.id);
    assert.equal(tells.length >= 2 && tells.length <= 3, true, beat.id + ' has ' + tells.length + ' tells');
    for (const tell of tells) assert.equal(tell.accounts.length, beat.kind === 'glitch' ? 2 : 1, tell.id);
  }
  for (const tell of STORY_TELLS) for (const id of tell.accounts) assert.ok(accountDef(id), tell.id + ' → ' + id);
  for (const account of STORY_ACCOUNTS) {
    assert.equal(account.roles.at(-1), '*', account.id + ' can always be cast');
    assert.equal(account.channels.some(channel => channel !== 'job'), true, account.id + ' can be met without a job');
    assert.equal(account.facts.some(fact => fact.anchors.length), true, account.id + ' carries a clue');
    for (const fact of account.facts) for (const anchor of fact.anchors) assert.equal(fact.text.includes(anchor), true, account.id + ': ' + anchor);
  }
  // The tutorial's threads and accounts keep their ids, so existing saves still mean what they meant.
  assert.deepEqual(STORY_TELLS.filter(tell => tell.tutorial).map(tell => tell.id), COURIER_THREADS.map(thread => thread.id));
  assert.deepEqual(STORY_ACCOUNTS.filter(account => account.tutorial).map(account => account.id), COURIER_EVIDENCE.map(evidence => evidence.id));
  assert.equal(tellsOf('record').every(tell => tell.accounts[0] === STORY_FIRST), true, 'the first tell opens every record tell');
});
test('a clue belongs to one tell, so prose for one account cannot leak another', () => {
  for (const account of STORY_ACCOUNTS) {
    const own = new Set(STORY_TELLS.filter(tell => tell.accounts.includes(account.id)).flatMap(tell => tell.accounts));
    for (const other of STORY_ACCOUNTS.filter(item => !own.has(item.id))) {
      // "Twenty winters" dates both the old receipt and the old catalog on purpose.
      for (const anchor of other.facts.flatMap(fact => fact.anchors).filter(item => item !== 'twenty winters' && item !== 'FP-17')) {
        assert.equal(account.facts.some(fact => fact.text.includes(anchor)), false, account.id + ' also says “' + anchor + '”');
      }
    }
  }
});
test('beats open when their prerequisites are met, in any order', () => {
  const s = story();
  assert.deepEqual(storyNeeds(s), [{ beat: 'record', account: STORY_FIRST, first: true }]);
  hold(s, STORY_FIRST, 'guide-memory', 'gardener-memory', 'maker-now', 'maker-old');
  assert.equal(beatOpen(s, 'pattern'), false);
  assert.equal(recordPattern(s), false);
  assert.equal(recordCompared(s, 'craft'), true); assert.equal(beatDone(s, 'maker'), true);
  assert.equal(recordCompared(s, 'post'), false, 'one half is not enough to compare');
  assert.equal(recordCompared(s, 'memories'), true);
  assert.equal(beatOpen(s, 'named'), false);
  assert.equal(recordPattern(s), true); assert.equal(beatOpen(s, 'named'), true);
  assert.equal(beatOpen(s, 'turn'), false);
  const named = storyNeeds(s).find(need => need.beat === 'named').account;
  s.plot.accounts[named] = { by: 'npc:namer', name: 'Namer', site: 'x', siteName: 'X', stance: 'afraid' };
  hold(s, named); assert.equal(beatDone(s, 'named'), true);
  assert.equal(s.plot.voices.afraid, 'npc:namer', 'naming it is itself a voice');
  assert.equal(beatOpen(s, 'turn'), false, 'one voice is not two');
  recordVoice(s, 'npc:other'); assert.equal(beatOpen(s, 'turn'), true);
  hold(s, storyNeeds(s).find(need => need.beat === 'turn').account);
  assert.equal(beatOpen(s, 'ending'), true); assert.deepEqual(storyNeeds(s), []);
});
test('needs close a begun glitch before opening another, and leave comparing to the courier', () => {
  const s = hold(story(), STORY_FIRST);
  const [first, ...rest] = storyNeeds(s);
  assert.equal(first.beat, 'record'); assert.equal(activeTell(s, 'record').accounts[1], first.account);
  assert.deepEqual(rest.map(need => need.beat).sort(), ['maker', 'memory']);
  hold(s, 'lullaby-a', 'tool-new');
  assert.deepEqual(storyNeeds(s).map(need => need.account).sort(), [first.account, 'lullaby-b', 'tool-old'].sort(), 'three dangling: nothing new is begun');
  hold(s, 'lullaby-b');
  assert.equal(storyNeeds(s).some(need => need.beat === 'memory'), false, 'both halves in hand: comparing is the courier’s step');
  assert.equal(storyThreads(s).find(thread => thread.tell.id === 'lullaby').ready, true);
});
test('a tell once begun is the one that is followed, whatever the seed would have chosen', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const s = hold(story(seed), STORY_FIRST, 'gardener-memory');
    assert.equal(activeTell(s, 'memory').id, 'memories');
    assert.equal(storyNeeds(s).some(need => need.account === 'guide-memory'), true);
    hold(s, 'book-entry'); assert.equal(activeTell(s, 'record').id, 'post-book');
  }
  const picks = new Set(Array.from({ length: 60 }, (_, seed) => activeTell(story(seed), 'maker').id));
  assert.deepEqual([...picks].sort(), ['craft', 'tool'], 'different seeds fill a beat with different tells');
  const tutorial = { ...story(3), bindings: { places: { A: { id: 'a' } }, cast: {} } };
  assert.equal(activeTell(tutorial, 'maker').id, 'craft', 'near the tutorial villages their own tell is the one in play');
});
test('temperament is fixed for a resident, spread across the four, and two people always give two voices', () => {
  const s = story(11), counts = Object.fromEntries(STORY_STANCES.map(stance => [stance, 0]));
  for (let i = 0; i < 400; i++) { const stance = stanceOf(s, 'npc:' + i); assert.equal(stanceOf(s, 'npc:' + i), stance); counts[stance]++; }
  for (const stance of STORY_STANCES) assert.equal(counts[stance] > 60, true, stance + ': ' + counts[stance]);
  assert.equal(recordVoice(s, 'npc:1').counted, false, 'nothing to react to before a discrepancy is seen');
  hold(s, STORY_FIRST, 'dispatch-old'); recordCompared(s, 'post');
  for (let seed = 1; seed <= 200; seed++) {
    const t = story(seed); hold(t, STORY_FIRST, 'dispatch-old'); recordCompared(t, 'post');
    const first = recordVoice(t, 'npc:a'), again = recordVoice(t, 'npc:a');
    assert.equal(again.stance, first.stance); assert.equal(beatDone(t, 'voices'), false, 'one person is one voice');
    const second = recordVoice(t, 'npc:b');
    assert.notEqual(second.stance, first.stance); assert.equal(beatDone(t, 'voices'), true);
    assert.equal(stanceOf(t, 'npc:b'), second.stance, 'and they keep it');
  }
  for (const stance of STORY_STANCES) {
    assert.deepEqual(Object.keys(STORY_REACTIONS[stance]), ['glitch', 'pattern', 'named']);
    assert.ok(STORY_WORD.learned[stance]);
  }
});
test('an older save upgrades to the same plot every time, and the poet stays curious', () => {
  const old = { runId: 'run-7', evidence: { 'dispatch-now': { id: 'dispatch-now', sourceIds: [] } }, compared: {}, hypothesis: true, concluded: true,
    bindings: { places: {}, cast: { poet: { id: 'npc:poet' } } } };
  const copy = JSON.parse(JSON.stringify(old));
  upgradeCourierPlot(old); upgradeCourierPlot(copy); upgradeCourierPlot(copy);
  assert.deepEqual(old.plot, copy.plot);
  assert.equal(stanceOf(old, 'npc:poet'), 'curious'); assert.equal(old.plot.voices.curious, 'npc:poet');
  assert.equal(upgradeCourierPlot({ runId: 'new', evidence: {}, compared: {} }, { seed: 99 }).seed, 99);
  const kept = { runId: 'new', plot: createPlot(4) }; upgradeCourierPlot(kept, { seed: 99 });
  assert.equal(kept.plot.seed, 4, 'a saved seed is never replaced');
});

const facts = (id, extra = {}) => storyFacts(id, { author: 'Rosamund Hale', authorPlace: 'Ashford', stance: 'afraid', refrain: 'as it was before',
  names: ['Bram Oakes', 'Hazel'], render: text => text.replace('{dispatcher}', 'Bram Oakes').replace('{gardener}', 'Ida Fenn'), ...extra });
test('the authored version of every account, in every temperament, passes its own validation', () => {
  for (const account of STORY_ACCOUNTS.filter(item => !item.tutorial)) for (const stance of STORY_STANCES) {
    const given = facts(account.id, { stance, events: [{ id: 'arrival:H', summary: 'Arrived at Hazel on foot.' }] });
    const work = fallbackStoryWork(given);
    assert.deepEqual(validateStoryWork(work, given).lines, work.lines, account.id + ' as ' + stance);
    assert.equal(work.lines.some(line => line.includes('{')), false, 'no unfilled name');
  }
});
test('generated prose is rejected when it drops, invents or borrows a clue', () => {
  const given = facts('tally'), good = fallbackStoryWork(given);
  const change = (from, to) => ({ ...good, lines: good.lines.map(line => line.replace(from, to)) });
  assert.ok(validateStoryWork(good, given));
  assert.throws(() => validateStoryWork(change('as many cradles as graves', 'more cradles than graves'), given), /missing/);
  assert.throws(() => validateStoryWork({ ...good, lines: [...good.lines, 'There were 31 of us once.'] }, given), /number/);
  assert.throws(() => validateStoryWork({ ...good, lines: [...good.lines, 'I hid a brass button and said nothing.'] }, given), /another account/);
  assert.throws(() => validateStoryWork({ ...good, lines: [...good.lines, 'I wrote to Tobias about it.'] }, given), /not a name/);
  assert.throws(() => validateStoryWork({ ...good, lines: [...good.lines, 'Perhaps this is all a simulation.'] }, given), /not a word/);
  assert.ok(validateStoryWork({ ...good, lines: [...good.lines, 'The courier calls it a simulation.'] }, given, { lexicon: ['simulation'] }),
    'a writer who has been taught the word may use it');
  assert.throws(() => validateStoryWork({ ...good, referencedEventIds: ['count'] }, given), /left out/);
  assert.throws(() => validateStoryWork({ ...good, referencedEventIds: [...good.referencedEventIds, 'made-up'] }, given), /unknown/);
  assert.throws(() => validateStoryWork({ ...good, lines: good.lines.slice(0, 2) }, given), /shape/);
  assert.ok(validateStoryWork({ ...good, lines: [...good.lines, 'Ask Bram Oakes in Hazel, if you doubt me.'] }, given), 'names the facts gave are allowed');
});
test('the turn is written only from the courier’s real journey', () => {
  const events = [{ id: 'arrival:H', summary: 'Arrived at Hazel on foot.' }, { id: 'delivery:first-letter', summary: 'Delivered First Letter to Ida Fenn.' }];
  const given = facts('route-book', { events, names: ['Hazel', 'Ida Fenn'] }), work = fallbackStoryWork(given);
  assert.deepEqual(given.facts.map(fact => fact.id), ['found', 'arrival:H', 'delivery:first-letter', 'last']);
  assert.equal(work.lines.includes('Delivered First Letter to Ida Fenn.'), true);
  assert.ok(validateStoryWork(work, given));
  assert.throws(() => validateStoryWork({ ...work, lines: [...work.lines, 'Delivered a cup to Wren.'] }, given), /not a name/);
  assert.throws(() => validateStoryWork({ ...work, referencedEventIds: work.referencedEventIds.filter(id => id !== 'arrival:H') }, given), /left out/);
});
test('the ending recounts what this courier found and ends on the same moment for everyone', () => {
  const a = hold(story(1), STORY_FIRST, 'dispatch-old'), b = hold(story(2), 'lullaby-a', 'lullaby-b', 'tool-new', 'tool-old');
  recordCompared(a, 'post'); recordCompared(b, 'lullaby'); recordCompared(b, 'tool');
  const first = storyEnding(a, 'Ada Reed'), second = storyEnding(b, 'Ada Reed');
  assert.notEqual(first.lines[1], second.lines[1]);
  assert.deepEqual(first.lines.slice(-3), second.lines.slice(-3));
  assert.match(first.lines.at(-2), /Who keeps yours\?/);
  assert.equal(first.lines.join(' ').includes('{'), false);
  assert.equal(/simulat/i.test(first.lines.join(' ')), false, 'nobody here has the word');
});
test('a new courier draws a story seed once, a pinned seed is kept, and it survives save and reload', async () => {
  const { createLivingWorldState, serializeLivingWorldState, parseLivingWorldState } = await import('../src/livingworldstate.mjs');
  const { initializeCourier } = await import('../src/courier.mjs');
  const { COURIER_ROLES } = await import('../src/couriercontent.mjs');
  const make = options => {
    const state = createLivingWorldState({ worldSeed: 20260612, playerId: 'player:local' });
    const cast = Object.fromEntries(Object.keys(COURIER_ROLES).map(role => { state.entities['npc:' + role] = { id: 'npc:' + role, kind: 'npc', name: role }; return [role, { id: 'npc:' + role, name: role, place: COURIER_ROLES[role] }]; }));
    initializeCourier(state, { places: { A: { id: 'a' }, B: { id: 'b' }, H: { id: 'h' } }, cast, routes: {} }, options);
    return state;
  };
  const pinned = make({ storySeed: 42 });
  assert.equal(pinned.courier.plot.seed, 42);
  initializeCourier(pinned, pinned.courier.bindings, { storySeed: 7 });
  assert.equal(pinned.courier.plot.seed, 42, 'a saved seed is never redrawn');
  const restored = parseLivingWorldState(serializeLivingWorldState(pinned), { worldSeed: 20260612 });
  assert.deepEqual(restored.courier.plot, pinned.courier.plot);
  const seeds = new Set(Array.from({ length: 8 }, () => make().courier.plot.seed));
  assert.equal(seeds.size > 1, true, 'new couriers get different stories');
});
test('the controller reads, compares and forms the pattern through the beats, for tutorial and placed accounts alike', async () => {
  const { createLivingWorldState } = await import('../src/livingworldstate.mjs');
  const { CourierController, initializeCourier } = await import('../src/courier.mjs');
  const { COURIER_ROLES } = await import('../src/couriercontent.mjs');
  const state = createLivingWorldState({ worldSeed: 20260612, playerId: 'player:local' });
  const places = { A: { id: 'a', name: 'Ash', x: 0, z: 0 }, B: { id: 'b', name: 'Bell', x: 1000, z: 0 }, H: { id: 'h', name: 'Hazel', x: 500, z: 300 } };
  const cast = Object.fromEntries(Object.keys(COURIER_ROLES).map(role => { state.entities['npc:' + role] = { id: 'npc:' + role, kind: 'npc', name: role }; return [role, { id: 'npc:' + role, name: role, place: COURIER_ROLES[role] }]; }));
  initializeCourier(state, { places, cast, routes: {} }, { storySeed: 3 });
  const far = { id: 'settlement:4:2', name: 'Thornby', x: 9000, z: 0 };
  const player = { x: 0, z: 0 };
  const c = new CourierController({ getState: () => state, getPlayer: () => player, getNpcPosition: () => null,
    getSourcePosition: id => { const site = id.split(':').slice(1).join(':'); return places[site] || (site === far.id ? far : null); },
    getPlace: id => id === far.id ? far : null });
  // Every commit swaps in a fresh courier record, so always read it from the state.
  const S = () => state.courier;
  S().plot.accounts['lullaby-a'] = { by: 'npc:far', name: 'Wren Mallory', site: far.id, siteName: far.name, stance: 'afraid' };
  S().plot.sites[far.id] = { name: far.name, offers: [{ a: 'lullaby-a', ch: 'stand', at: 1 }] };
  assert.deepEqual(c.sources().map(item => item.id), ['dispatch-now', 'dispatch-now'], 'until the dispatch sheet is read, it is the only paper on show');
  Object.assign(player, places.A); assert.equal(c.discover('dispatch-now:A').ok, true);
  const source = c.sources().find(item => item.id === 'lullaby-a');
  assert.equal(source.place, far.id); assert.match(source.text, /Wren Mallory of Thornby/);
  assert.equal(c.discover(source.sourceId).ok, false, 'read it where it is kept');
  Object.assign(player, far);
  assert.equal(c.discover(source.sourceId).ok, true);
  assert.deepEqual(S().plot.works['lullaby-a'].lines.join('\n'), c.accountDoc('lullaby-a').text, 'the edition is fixed as it is read');
  assert.equal(S().plot.sites[far.id].offers.length, 1, 'the paper read stays where it was');
  assert.equal(c.compare('lullaby').ok, false);
  S().plot.accounts['lullaby-b'] = { by: 'npc:other', name: 'Ida Fenn', site: 'b', siteName: 'Bell', stance: 'curious' };
  S().plot.sites.b = { name: 'Bell', offers: [{ a: 'lullaby-b', ch: 'stand', at: 2 }] };
  Object.assign(player, places.B);
  assert.equal(c.discover('lullaby-b:B').ok, true);
  assert.equal(c.readyThread().id, 'lullaby');
  assert.equal(c.compare('lullaby').ok, true);
  assert.equal(c.formHypothesis().ok, false, 'one glitch is not a pattern');
  for (const id of ['maker-now', 'maker-old']) assert.equal(c.discover(id + ':B').ok, true);
  assert.equal(c.compare('craft').ok, true);
  assert.equal(c.formHypothesis().ok, true);
  assert.equal(S().hypothesis, true);
});
test('anyone can be shown the accounts, two temperaments make the voices beat, and a cast resident hands over their paper', async () => {
  const { createLivingWorldState } = await import('../src/livingworldstate.mjs');
  const { CourierController, initializeCourier } = await import('../src/courier.mjs');
  const { COURIER_ROLES } = await import('../src/couriercontent.mjs');
  const state = createLivingWorldState({ worldSeed: 20260612, playerId: 'player:local' });
  const cast = Object.fromEntries(Object.keys(COURIER_ROLES).map(role => { state.entities['npc:' + role] = { id: 'npc:' + role, kind: 'npc', name: role }; return [role, { id: 'npc:' + role, name: role, place: COURIER_ROLES[role] }]; }));
  initializeCourier(state, { places: { A: { id: 'a', name: 'Ash', x: 0, z: 0 }, B: { id: 'b', name: 'Bell', x: 1000, z: 0 }, H: { id: 'h', name: 'Hazel', x: 500, z: 300 } }, cast, routes: {} }, { storySeed: 12 });
  const far = { id: 'settlement:9:9', name: 'Thornby', x: 9000, z: 0 };
  for (const id of ['npc:wren', 'npc:ida', 'npc:tom']) state.entities[id] = { id, kind: 'npc', name: id.slice(4), residence: { settlementId: far.id } };
  const c = new CourierController({ getState: () => state, getPlayer: () => far, getNpcPosition: () => far, getSourcePosition: () => far,
    getPlace: id => id === far.id ? far : null, getNpcPlace: () => far.id });
  const S = () => state.courier;
  assert.equal(c.shareEvidence('npc:wren', ['dispatch-now']).ok, false, 'only what you hold');
  for (const id of ['dispatch-now', 'dispatch-old']) c.grantEvidence(S(), id);
  const quiet = c.shareEvidence('npc:wren', ['dispatch-now']);
  assert.match(quiet.message, /copying error/, 'nothing compared yet: nothing to make of it');
  c.compare('post');
  const receipts = Object.keys(state.effectReceipts).length;
  const first = c.shareEvidence('npc:wren', ['dispatch-now', 'dispatch-old']);
  const second = c.shareEvidence('npc:ida', ['dispatch-now', 'dispatch-old']);
  assert.notEqual(first.stance, second.stance);
  assert.equal(beatDone(S(), 'voices'), true);
  assert.match(second.message, /do not agree/);
  assert.equal(Object.keys(state.effectReceipts).length, receipts, 'reactions leave no receipts');
  assert.match(c.contextForNpc('npc:wren').belief, /no word for it beyond your own/);
  // A paper the director cast someone to hand over in person.
  S().plot.accounts.tally = { by: 'npc:tom', name: 'Tom Reed', site: far.id, siteName: far.name, stance: 'afraid' };
  S().plot.sites[far.id] = { name: far.name, offers: [{ a: 'tally', ch: 'handed', at: 1 }] };
  const context = c.contextForNpc('npc:tom');
  assert.match(context.handover.text, /^Tom Reed has been waiting for you/);
  assert.equal(context.people.some(person => person.id === 'npc:tom'), true, 'a writer is a contact, so names find them');
  assert.equal(c.receive('tally', 'npc:wren').ok, false);
  const taken = c.receive('tally', 'npc:tom');
  assert.equal(taken.ok, true); assert.match(taken.document.text, /as many cradles as graves/);
  assert.equal(c.handedHere('npc:tom').length, 0);
  assert.equal(c.contextForNpc('npc:tom').handover, undefined);
});
test('any settlement can post a commission to a place already visited, carrying a paper, and finished ones become a count', async () => {
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
    getSourcePosition: () => null, getPlace: id => sites[id] || null });
  const S = () => state.courier;
  c.grantEvidence(S(), 'dispatch-now');
  assert.equal(c.offerCommission('A', thornby, []), null, 'the tutorial villages keep their own seven');
  const def = c.offerCommission('settlement:2:2', wickham, [{ key: 'settlement:1:1', name: 'Thornby', people: thornby }]);
  assert.ok(def); assert.equal(def.senderPlace, 'settlement:2:2'); assert.equal(def.recipientPlace, 'settlement:1:1');
  assert.ok(def.reveals, 'the story had a fresh half to carry');
  assert.equal(S().plot.accounts[def.reveals].by, def.recipient);
  assert.equal(c.offerCommission('settlement:2:2', wickham, []), null, 'one open commission per place');
  const card = c.boardJobs('settlement:2:2')[0];
  assert.equal(card.id, def.id); assert.equal(card.destinationName, 'Thornby');
  const sender = def.sender;
  assert.equal(c.accept(def.id, sender).ok, true);
  Object.assign(player, sites['settlement:1:1']);
  const delivered = c.handoff(def.id, def.recipient);
  assert.equal(delivered.ok, true); assert.equal(delivered.revealed, def.reveals);
  assert.equal(!!S().evidence[def.reveals], true);
  assert.match(c.accountDoc(def.reveals).text, new RegExp(S().plot.people[def.recipient].name));
  // Many more commissions later, only the latest few delivered ones are kept.
  const receipts = Object.keys(state.effectReceipts).length;
  for (let i = 0; i < 8; i++) {
    const here = i % 2 ? 'settlement:1:1' : 'settlement:2:2', people = i % 2 ? thornby : wickham, other = i % 2 ? wickham : thornby;
    const next = c.offerCommission(here, people, [{ key: i % 2 ? 'settlement:2:2' : 'settlement:1:1', name: 'there', people: other }]);
    Object.assign(player, sites[here]); assert.equal(c.accept(next.id, next.sender).ok, true);
    Object.assign(player, sites[next.recipientPlace]); assert.equal(c.handoff(next.id, next.recipient).ok, true);
  }
  c.pruneCommissions();
  assert.equal(Object.keys(S().plot.jobs).length, 3);
  assert.equal(c.standing().delivered, 9);
  assert.equal(Object.keys(state.effectReceipts).length <= receipts + 3 * 2 + 1, true, 'receipts of forgotten commissions are released');
  assert.equal(Object.keys(S().plot.people).length <= 8, true);
});
