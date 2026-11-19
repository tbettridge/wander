// The last letter at the lighthouse, and the lighthouse's clues counting for
// the main story. Firth Lighthouse is on the round six kilometres from the
// post town A, as in tests/courierlighthouse.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState } from '../src/livingworldstate.mjs';
import { CourierController, initializeCourier } from '../src/courier.mjs';
import { COURIER_ROLES } from '../src/couriercontent.mjs';
import { keeperLog } from '../src/courierlighthouse.mjs';
import { STORY_ENDING, STORY_FIRST, activeTell, beatDone, beatOpen, createPlot, recordAccount, recordCompared, recordHorizonFiled,
  recordPattern, recordVoice, storyEnding, storyNeeds } from '../src/courierstory.mjs';
import { DIRECTOR, applyArrival, lighthouseVisited, planArrival } from '../src/courierdirector.mjs';
import { WALK_POLICIES, walkStory } from '../scripts/walk-courier-story.mjs';

const story = (seed = 5) => ({ runId: 'test', evidence: {}, compared: {}, hypothesis: false, plot: createPlot(seed) });
const people = (site, count = 3) => Array.from({ length: count }, (_, i) => ({ id: 'npc:' + site + ':' + i, name: site + ' ' + i, role: 'farmer' }));
const village = id => ({ id, kind: 'village', name: 'Village ' + id });
const LIGHT = { id: 'M1_0', kind: 'lighthouse', name: 'Firth Lighthouse' };
const KEEPER = { id: 'npc:keeper', name: 'Ada Firth', site: LIGHT.id, siteName: LIGHT.name };
const keeperFolk = [{ id: KEEPER.id, name: KEEPER.name, role: 'lighthouse keeper' }, { id: 'npc:spouse', name: 'Sam Firth', role: 'keeper’s spouse' }];
const arrive = (s, site, residents = people(site.id), options = {}) => { const plan = planArrival(s, site, residents, options); applyArrival(s, plan); return plan; };

/** A story brought up to the turn: everything but the last letter. */
function toTheTurn(s) {
  for (const id of [STORY_FIRST, 'dispatch-old', 'maker-now', 'maker-old']) recordAccount(s, id);
  recordCompared(s, 'post'); recordCompared(s, 'craft'); recordPattern(s);
  recordVoice(s, 'npc:first');
  const named = arrive(s, village('n'));
  recordAccount(s, named.offer.account, 'n');
  recordVoice(s, 'npc:second');
  const turn = arrive(s, village('t'));
  recordAccount(s, turn.offer.account, 't');
  assert.equal(beatOpen(s, 'ending'), true);
  return s;
}

test('a courier who has been to the lighthouse is asked for by its keeper, at lamp-time', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const s = story(seed);
    arrive(s, LIGHT, keeperFolk, { keeper: KEEPER });
    assert.equal(lighthouseVisited(s, LIGHT.id), true, 'the visit is remembered');
    toTheTurn(s);
    const plan = arrive(s, village('t'), people('t'), { nowHour: 0.1, keeper: KEEPER });
    assert.deepEqual(plan.closer, { ...KEEPER, lamp: 't' }, 'the keeper asks, and the word hangs where the courier is');
    assert.equal(s.plot.closer.site, LIGHT.id);
    // Going about elsewhere a while, the keeper is still the one waiting.
    for (let i = 1; i < DIRECTOR.keeperStale; i++) assert.equal(arrive(s, village('x' + i), people('x' + i), { keeper: KEEPER }).closer, null);
    assert.equal(arrive(s, LIGHT, keeperFolk, { keeper: KEEPER }).closer, null, 'at the lighthouse, nobody else takes it');
  }
});

test('a courier who never went to the lighthouse gets the ending exactly as before', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const asked = toTheTurn(story(seed)), plain = toTheTurn(story(seed));
    const withKeeper = arrive(asked, village('t'), people('t'), { nowHour: 0.1, keeper: KEEPER });
    const without = arrive(plain, village('t'), people('t'), { nowHour: 0.1 });
    assert.deepEqual(withKeeper.closer, without.closer, 'someone at home asks, as they always have');
    assert.equal(withKeeper.closer.lamp, undefined);
    assert.deepEqual(asked, plain, 'and the save is the same');
  }
});

test('if the courier never answers the keeper, someone nearer reads it, and the keeper does not ask again', () => {
  const s = story(9);
  arrive(s, LIGHT, keeperFolk, { keeper: KEEPER });
  toTheTurn(s);
  arrive(s, village('t'), people('t'), { nowHour: 0.1, keeper: KEEPER });
  for (let i = 1; i < DIRECTOR.keeperStale; i++) arrive(s, village('y' + i), people('y' + i), { keeper: KEEPER });
  const nearer = arrive(s, village('far'), people('far'), { keeper: KEEPER });
  assert.equal(nearer.closer.site, 'far', 'left long enough, someone where the courier is takes the ending');
  assert.equal(nearer.closer.lamp, undefined, 'and reads it as anyone would');
  for (let i = 0; i < DIRECTOR.closerStale; i++) arrive(s, village('z' + i), people('z' + i), { keeper: KEEPER });
  assert.equal(s.plot.closer.lamp, undefined, 'the keeper is never cast again');
});

test('the keeper does not ask if they wrote the turn', () => {
  const s = story(4);
  arrive(s, LIGHT, keeperFolk, { keeper: KEEPER });
  toTheTurn(s);
  const turn = Object.values(s.plot.accounts).find(cast => cast.site === 't');
  const plan = arrive(s, village('t'), people('t'), { nowHour: 0.1, keeper: { ...KEEPER, id: turn.by } });
  assert.equal(plan.closer.lamp, undefined);
});

test('the walk ends under every policy with the keeper on the round, read at the gallery or by someone nearer', () => {
  let gallery = 0, fallback = 0;
  for (const policy of WALK_POLICIES) for (let seed = 1; seed <= 200; seed++) for (const lighthouse of [true, false]) {
    const walk = walkStory({ seed, policy, tutorial: true, lighthouse });
    assert.equal(walk.ended, true, policy + ' seed ' + seed + (lighthouse ? '' : ' (no log)') + ':\n' + walk.trace.slice(-10).join('\n'));
    if (walk.story.plot.closer.lamp) gallery++;
    else if (walk.trace.some(line => line.includes('come to the lamp'))) fallback++;
  }
  assert.equal(gallery > 100, true, 'the keeper reads it on the gallery in plenty of walks (' + gallery + ')');
  assert.equal(fallback > 0, true, 'and someone nearer reads it when the courier stays away');
});

// —— The lighthouse's clues count for the main story ——

test('half of the doubled night is enough: the story stops looking elsewhere for a memory', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const s = story(seed);
    recordAccount(s, STORY_FIRST); recordAccount(s, 'keeper-log'); recordAccount(s, 'keeper-log-old'); recordAccount(s, 'two-hands-keeper');
    assert.equal(activeTell(s, 'memory', { tutorial: false }).id, 'two-hands');
    const needs = storyNeeds(s, { tutorial: false });
    assert.equal(needs.some(need => need.beat === 'memory'), false, 'no cradle song is posted while the spouse holds the other half');
    assert.equal(needs.some(need => ['keeper-log', 'keeper-log-old', 'two-hands-keeper', 'two-hands-spouse', 'horizon'].includes(need.account)), false,
      'a lighthouse paper is never placed anywhere else');
    // The ship in two logs is a record already; the maker is what the story still looks for.
    assert.equal(recordCompared(s, 'keeper-log'), true);
    assert.equal(beatDone(s, 'record'), true);
    assert.deepEqual(storyNeeds(s, { tutorial: false }).map(need => need.beat), ['maker']);
    recordAccount(s, 'two-hands-spouse');
    assert.equal(recordCompared(s, 'two-hands'), true);
    assert.equal(beatOpen(s, 'pattern'), true, 'two clues from one lighthouse visit make a pattern');
    assert.equal(recordCompared(s, 'keeper-log'), true);
    assert.equal(Object.keys(s.compared).length, 2, 'each clue counted once');
  }
});

test('the horizon page, filed by the archivist, names the pattern, before or after it is seen, and never opens the turn alone', () => {
  const before = story(3);
  for (const id of [STORY_FIRST, 'dispatch-old', 'maker-now', 'maker-old', 'horizon']) recordAccount(before, id);
  assert.equal(beatDone(before, 'named'), false, 'a page in the book is not yet a name');
  assert.equal(recordHorizonFiled(before), false, 'filed before the pattern, it waits');
  assert.equal(beatDone(before, 'named'), false);
  recordCompared(before, 'post'); recordCompared(before, 'craft');
  assert.equal(recordPattern(before), true);
  assert.equal(beatDone(before, 'named'), true, 'named the moment the pattern is seen');
  assert.equal(beatOpen(before, 'turn'), false, 'the turn still waits for what people make of it');
  assert.equal(storyNeeds(before).some(need => need.beat === 'named'), false, 'nobody else is asked to name it');
  recordVoice(before, 'npc:one'); recordVoice(before, 'npc:two');
  assert.equal(beatOpen(before, 'turn'), true);

  const after = story(3);
  for (const id of [STORY_FIRST, 'dispatch-old', 'maker-now', 'maker-old', 'horizon']) recordAccount(after, id);
  recordCompared(after, 'post'); recordCompared(after, 'craft'); recordPattern(after);
  assert.equal(recordHorizonFiled(after), true, 'filed after the pattern, it names it at once');
  const voices = Object.keys(after.plot.voices).length;
  assert.equal(recordAccount(after, 'tally'), true);
  assert.equal(Object.keys(after.plot.voices).length, voices, 'a second naming paper read later counts for nothing more');
});

test('a single paper read before its beat is open does not jump the story forward', () => {
  const s = story(2);
  recordAccount(s, STORY_FIRST); recordAccount(s, 'tally');
  assert.equal(beatDone(s, 'named'), false);
  assert.equal(s.plot.beats.named, undefined);
});

test('reading the log shortens the road on average, and never stops the story', () => {
  let read = 0, saved = 0;
  for (const policy of ['no-jobs', 'every-job', 'three-villages']) for (let seed = 1; seed <= 300; seed++) {
    const visit = walkStory({ seed, policy, tutorial: true }), skip = walkStory({ seed, policy, tutorial: true, lighthouse: false });
    if (!visit.trace.some(line => line.includes('keeper’s log'))) { assert.equal(visit.endedAt, skip.endedAt); continue; }
    read++; saved += skip.endedAt - visit.endedAt;
  }
  assert.equal(read > 100, true);
  assert.equal(saved > 0, true, 'a visit saves arrivals overall (' + saved + ' over ' + read + ' walks)');
});

// —— In the game: the note, the gallery, and the same words ——

function fixture() {
  const state = createLivingWorldState({ worldSeed: 20260612, playerId: 'player:local' });
  const places = { A: { id: 'a', name: 'Ravenkeld', x: 0, z: 0 }, B: { id: 'b', name: 'Oakgate', x: 1000, z: 0 }, H: { id: 'h', name: 'Holtwick', x: 500, z: 300 } };
  const light = { key: 'M1_0', id: 'M1_0', name: 'Firth Lighthouse', kind: 'lighthouse', x: 6000, z: 0 };
  const cast = Object.fromEntries(Object.entries(COURIER_ROLES).map(([role, place]) => {
    const id = 'npc:' + role; state.entities[id] = { id, kind: 'npc', name: role, inTransit: false };
    return [role, { id, name: role, place }];
  }));
  state.entities['npc:keeper'] = { id: 'npc:keeper', kind: 'npc', name: 'Ada Firth', inTransit: false };
  const player = { x: 0, z: 0, y: 2 }, where = { 'npc:keeper': light }, hooks = { onWatch: false, atGallery: false, lit: false };
  initializeCourier(state, { places, cast, routes: {} });
  const controller = new CourierController({ getState: () => state, getPlayer: () => player,
    getNpcPosition: id => where[id] || places[cast[id.replace('npc:', '')]?.place],
    getSourcePosition: id => id === 'board:M1_0' ? light : places[id.split(':')[1]],
    getPlace: key => key === light.key ? light : null, getNpcPlace: id => id === 'npc:keeper' ? light.id : null,
    onWatch: id => hooks.onWatch && id === 'npc:keeper', atGallery: () => hooks.atGallery, lampTurning: () => hooks.lit });
  const visit = place => Object.assign(player, place === 'L' ? light : places[place]);
  return { state, controller, visit, hooks, light };
}
/** Bring the game's story to the ending, with the keeper having asked from Ravenkeld's board. */
function keeperAsks(f, lamp = 'a') {
  const s = f.state.courier;
  toTheTurn(s);
  s.plot.closer = { ...KEEPER, lamp, at: s.plot.pacing.arrivals };
  return s;
}

test('the keeper’s note hangs on the board where the word came, and the book says to come at lamp-time', () => {
  const f = fixture(), c = f.controller;
  keeperAsks(f);
  f.visit('A');
  const board = c.readBoard('A');
  assert.equal(board.ok, true);
  assert.match(board.note, /^A note from Ada Firth of Firth Lighthouse: .*lamp-time.*gallery/);
  f.visit('B');
  assert.equal(c.readBoard('B').note, undefined, 'only on the board where the word reached the courier');
  const guide = c.storyGuidance();
  assert.equal(guide.title, 'The keeper has asked for you');
  assert.match(guide.text, /climb the stair to the gallery after dark/);
});

test('the keeper reads it only up at the lamp after dark, and reads the same words', () => {
  const f = fixture(), c = f.controller, s = keeperAsks(f);
  f.visit('L');
  const ids = Object.keys(s.evidence);
  let tried = c.shareEvidence(KEEPER.id, ids);
  assert.equal(tried.ok, false); assert.match(tried.reason, /lamp-time/);
  assert.equal(c.contextForNpc(KEEPER.id).callingLater, true, 'by day the keeper asks the courier to come back');
  f.hooks.onWatch = true;
  assert.match(c.shareEvidence(KEEPER.id, ids).reason, /Climb the stair/);
  f.hooks.atGallery = true;
  assert.match(c.shareEvidence(KEEPER.id, ids).reason, /lighting the lamp/);
  f.hooks.lit = true;
  const context = c.contextForNpc(KEEPER.id);
  assert.equal(context.callingLater, undefined); assert.match(context.calling, /turns from the lamp/);
  const done = c.shareEvidence(KEEPER.id, ids);
  assert.equal(done.ok, true, done.reason);
  assert.equal(beatDone(c.story, 'ending'), true);
  const plain = storyEnding(c.story, KEEPER.name).lines;
  const lines = done.ending.text.split('\n\n');
  assert.equal(lines[0], STORY_ENDING.gallery.replace('{light}', 'Firth Lighthouse'), 'set on the gallery, with the beam going round');
  assert.deepEqual(lines.slice(1), plain, 'and then word for word the ending everyone hears');
});

test('anyone else who asks reads it wherever they are, as before', () => {
  const f = fixture(), c = f.controller, s = f.state.courier;
  toTheTurn(s);
  s.plot.closer = { id: 'npc:guide', name: 'guide', site: 'a', siteName: 'Ravenkeld', at: 1 };
  f.visit('A');
  assert.equal(c.readBoard('A').note, undefined);
  assert.equal(c.contextForNpc('npc:guide').callingLater, undefined);
  const done = c.shareEvidence('npc:guide', Object.keys(s.evidence));
  assert.equal(done.ok, true, done.reason);
  assert.deepEqual(done.ending.text.split('\n\n'), storyEnding(s, 'guide').lines);
  assert.equal(done.ending.text.includes('gallery'), false);
});

test('the horizon letter, delivered once the pattern is seen, names it in the archivist’s words', () => {
  const f = fixture(), c = f.controller, s = f.state.courier;
  for (const id of [STORY_FIRST, 'dispatch-old', 'maker-now', 'maker-old']) recordAccount(s, id);
  recordCompared(s, 'post'); recordCompared(s, 'craft'); recordPattern(s);
  const keeper = { id: KEEPER.id, name: KEEPER.name, role: 'lighthouse keeper', home: { id: 'h', name: 'home', x: 6000, z: 0, address: 'the keeper’s house' } };
  const read = c.readKeeperLog({ keeper, light: { id: f.light.id, key: f.light.key, name: f.light.name }, log: keeperLog({ seed: 5, day: 0, keeper: keeper.name, light: f.light.name }) });
  assert.equal(read.applied, true, read.reason);
  const letter = Object.values(c.story.plot.jobs).find(def => def.horizon);
  assert.ok(letter);
  f.visit('L');
  assert.equal(c.accept(letter.id, KEEPER.id).ok !== false, true);
  assert.equal(beatDone(c.story, 'named'), false);
  f.visit('B');
  const handed = c.handoff(letter.id, 'npc:archivist');
  assert.equal(handed.ok !== false, true, handed.reason);
  assert.match(handed.result?.message || handed.message, /That is a stage, and someone set it/);
  assert.equal(beatDone(c.story, 'named'), true);
});
