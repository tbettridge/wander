import test from 'node:test';
import assert from 'node:assert/strict';
import { STORY_FIRST, accountDef, beatOpen, createPlot, recordAccount, recordCompared, recordPattern, recordVoice,
  storyHeld } from '../src/courierstory.mjs';
import { DIRECTOR, applyArrival, planArrival } from '../src/courierdirector.mjs';
import { WALK_POLICIES, walkStory } from '../scripts/walk-courier-story.mjs';

const story = (seed = 5) => ({ runId: 'test', evidence: {}, compared: {}, hypothesis: false, plot: createPlot(seed) });
const people = (site, count = 3) => Array.from({ length: count }, (_, i) => ({ id: 'npc:' + site + ':' + i, name: site + ' ' + i, role: 'farmer' }));
const village = id => ({ id, kind: 'village', name: 'Village ' + id });
const arrive = (s, site, residents = people(site.id), options = {}) => { const plan = planArrival(s, site, residents, options); applyArrival(s, plan); return plan; };
const readAll = (s, site) => { for (const offer of [...(s.plot.sites[site.id]?.offers || [])]) recordAccount(s, offer.a, site.id); };

test('the ending is reachable on 500 seeds under every policy, with and without the tutorial villages', () => {
  for (const tutorial of [false, true]) for (const policy of WALK_POLICIES) {
    let slowest = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const walk = walkStory({ seed, policy, tutorial });
      assert.equal(walk.ended, true, policy + (tutorial ? ' (tutorial)' : '') + ' seed ' + seed + ' never reached the ending:\n' + walk.trace.slice(-12).join('\n'));
      slowest = Math.max(slowest, walk.endedAt);
    }
    // A courier who reads what they are offered should not need to cross half the country.
    if (policy !== 'random') assert.equal(slowest <= 40, true, policy + ' needed ' + slowest + ' arrivals');
  }
});
test('the same seed and the same choices give the same story; a different seed gives another', () => {
  const stories = new Set();
  for (let seed = 1; seed <= 40; seed++) for (const policy of WALK_POLICIES) {
    const one = walkStory({ seed, policy }), two = walkStory({ seed, policy });
    assert.deepEqual(two.trace, one.trace); assert.deepEqual(two.story, one.story);
    if (policy === 'no-jobs') stories.add(Object.keys(one.story.evidence).sort().join(','));
  }
  assert.equal(stories.size >= 6, true, 'only ' + stories.size + ' different sets of accounts across 40 seeds');
});
test('what a place has offered is never re-rolled, and a paper the courier has read is never taken down', () => {
  for (let seed = 1; seed <= 120; seed++) for (const policy of ['no-jobs', 'random', 'three-villages']) {
    const posted = new Map(), readAt = new Map(), writers = new Map();
    let previous = null;
    walkStory({ seed, policy, maxArrivals: 120, keepWalking: true, onStep(s, site) {
      // Looking again with nothing changed decides nothing.
      assert.equal(planArrival(s, site, [], { nowHour: s.plot.pacing.seen.at(-1)[2] }), null);
      // Whatever the courier now holds was read where they last stood.
      for (const account of Object.keys(s.evidence)) if (!readAt.has(account)) readAt.set(account, previous);
      for (const [id, before] of posted) {
        const now = (s.plot.sites[id]?.offers || []).map(offer => offer.a);
        // Copies elsewhere may be taken down; nothing is swapped, reordered or rewritten.
        for (const account of before) if (!now.includes(account)) assert.notEqual(readAt.get(account), id, account + ' vanished from ' + id + ', where it was read');
        assert.equal(now.filter(account => before.includes(account)).join(), before.filter(account => now.includes(account)).join());
      }
      posted.clear();
      for (const [id, record] of Object.entries(s.plot.sites)) {
        posted.set(id, record.offers.map(offer => offer.a));
        assert.equal(record.offers.length <= DIRECTOR.siteOffers, true);
        assert.equal(record.offers.filter(offer => !storyHeld(s, offer.a)).length <= 1, true, 'one unread paper at a time');
      }
      // Once someone has written an account, it is theirs for good.
      for (const [account, cast] of Object.entries(s.plot.accounts)) {
        if (!writers.has(account)) writers.set(account, cast.by + '@' + cast.site);
        assert.equal(cast.by + '@' + cast.site, writers.get(account), account + ' changed hands');
      }
      previous = site.id;
    } });
  }
});
test('the save stays small however far the courier walks', () => {
  for (const policy of ['ignore', 'no-jobs', 'random', 'farmsteads-only']) for (const seed of [1, 2, 3]) {
    const walk = walkStory({ seed, policy, maxArrivals: 2000, keepWalking: true });
    assert.equal(walk.arrivals, 2000);
    const bytes = JSON.stringify(walk.story).length;
    assert.equal(bytes < 24000, true, policy + ' kept ' + bytes + ' bytes');
    assert.equal(Object.keys(walk.story.plot.sites).length <= 30, true);
    assert.equal(walk.story.plot.pacing.seen.length <= DIRECTOR.seen, true);
  }
});
test('the first paper anywhere is the dispatch sheet, and a place offers one paper at a time', () => {
  const s = story(), a = village('a'), b = village('b');
  const first = arrive(s, a);
  assert.equal(first.offer.account, STORY_FIRST); assert.equal(first.offer.copy, true);
  assert.equal(planArrival(s, a, people('a')), null, 'nothing new to decide');
  assert.equal(arrive(s, b).offer.account, STORY_FIRST, 'unread, so it is posted wherever the courier goes next');
  recordAccount(s, STORY_FIRST, 'b');
  assert.equal(s.plot.sites.a, undefined, 'the copy left behind is taken down');
  assert.equal(planArrival(s, b, people('b'), { nowHour: 1 }), null, 'the same visit offers nothing more');
  const later = arrive(s, b, people('b'), { nowHour: 9 });
  assert.equal(later.arrival, false); assert.equal(later.offer.beat, 'record', 'after a rest, the other half of what was begun');
  const second = arrive(s, a);
  assert.notEqual(second.offer.beat, 'record', 'one loose end is close by, so this place begins something else');
  assert.equal(second.offer.copy, false); assert.ok(second.offer.author.id.startsWith('npc:a:'));
  const third = arrive(s, village('c'));
  assert.equal(third.offer.account, later.offer.account, 'two arrivals on, the half left unread follows the courier');
  assert.equal(third.offer.copy, true);
});
test('the two halves of a tell are written by different people in different places', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const walk = walkStory({ seed, policy: 'never-revisit' }), cast = walk.story.plot.accounts;
    for (const [a, b] of [['lullaby-a', 'lullaby-b'], ['tool-new', 'tool-old']]) if (cast[a] && cast[b]) {
      assert.notEqual(cast[a].site, cast[b].site); assert.notEqual(cast[a].by, cast[b].by);
    }
  }
});
test('a small place may be quiet, but never twice running while the story has something to place', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const s = story(seed); recordAccount(s, STORY_FIRST);
    let quiet = 0, placed = 0;
    for (let i = 0; i < 12; i++) {
      const site = { id: 'farm:' + seed + ':' + i, kind: 'farmstead', name: 'Farm ' + i }, plan = arrive(s, site, people(site.id, 1));
      if (plan.quiet) { quiet++; assert.equal(quiet < 2, true, 'two quiet farms in a row'); } else quiet = 0;
      if (plan.offer) { placed++; readAll(s, site); }
    }
    assert.equal(placed >= 4, true);
  }
  const s = story(2); recordAccount(s, STORY_FIRST);
  assert.ok(arrive(s, village('v')).offer, 'a village always has something when there is a need');
});
test('a place with nobody at home can still carry a copy, but nothing new is written there', () => {
  const s = story(9); recordAccount(s, STORY_FIRST);
  for (let i = 0; i < 6; i++) {
    const plan = arrive(s, village('empty:' + i), []);
    if (plan.offer) { assert.equal(plan.offer.copy, true); assert.equal(plan.offer.author, null); readAll(s, plan.site); }
  }
  assert.deepEqual(Object.keys(s.plot.accounts), []);
});
test('an unread paper left behind is offered again nearer the courier, at most three copies', () => {
  const s = story(4); recordAccount(s, STORY_FIRST);
  const origin = arrive(s, village('v0')), account = origin.offer.account;
  const sites = ['v0'];
  for (let i = 1; i <= 12; i++) {
    const plan = arrive(s, village('v' + i));
    if (plan.offer?.account === account) { assert.equal(plan.offer.copy, true, 'the same account, not a new one'); sites.push('v' + i); }
    const live = Object.values(s.plot.sites).flatMap(site => site.offers).filter(offer => offer.a === account);
    assert.equal(live.length <= DIRECTOR.liveCopies, true);
  }
  assert.equal(sites.length > 3, true, 'it keeps following the courier');
  assert.equal(s.plot.sites.v0?.offers.some(offer => offer.a === account) || false, false, 'the oldest copy was taken down');
});
test('near the tutorial villages the director leaves their own accounts to them', () => {
  const s = { ...story(6), bindings: { places: { A: { id: 'a', name: 'Ash' }, B: { id: 'b', name: 'Bell' }, H: { id: 'h', name: 'Hazel' } }, cast: {} } };
  assert.equal(arrive(s, village('a')).offer, null, 'the dispatch sheet is already posted in A');
  assert.equal(arrive(s, { id: 'h', kind: 'hamlet', name: 'Hazel' }).offer.account, STORY_FIRST, 'H has no fixed copy, so one is posted');
  recordAccount(s, STORY_FIRST, 'h');
  for (const id of ['a', 'b', 'h', 'a', 'b']) assert.equal(arrive(s, village(id), people(id), { nowHour: 50 }).offer, null, 'glitches are the tutorial’s to show');
  for (const id of ['dispatch-old', 'maker-now', 'maker-old']) recordAccount(s, id);
  recordCompared(s, 'post'); recordCompared(s, 'craft'); recordPattern(s);
  const named = arrive(s, village('h'), people('h'), { nowHour: 99 });
  assert.equal(named.offer.beat, 'named', 'the later beats are placed wherever the courier is');
  assert.equal(named.offer.author.id.startsWith('npc:h:'), true);
  // Far from the tutorial, the missing half of its thread follows the courier as a copy.
  recordAccount(s, 'guide-memory'); recordAccount(s, named.offer.account, 'h');
  arrive(s, village('far1')); const far = arrive(s, village('far2'));
  assert.equal(far.offer.account, 'gardener-memory'); assert.equal(far.offer.copy, true);
});
test('whoever names it does not repeat the only voice heard, and the closer is someone nearby', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const s = story(seed);
    for (const id of [STORY_FIRST, 'dispatch-old', 'maker-now', 'maker-old']) recordAccount(s, id);
    recordCompared(s, 'post'); recordCompared(s, 'craft'); recordPattern(s);
    const heard = recordVoice(s, 'npc:first').stance;
    const named = arrive(s, village('n'));
    assert.notEqual(named.offer.author.stance, heard);
    recordAccount(s, named.offer.account, 'n');
    assert.equal(beatOpen(s, 'turn'), true);
    const turn = arrive(s, village('t'));
    assert.equal(accountDef(turn.offer.account).journey, true); assert.equal(turn.offer.channel, 'handed');
    recordAccount(s, turn.offer.account, 't');
    const close = planArrival(s, village('t'), people('t'), { nowHour: 0.1 });
    assert.equal(close.closer.site, 't', 'no rest is needed before someone asks for the courier');
    assert.notEqual(close.closer.id, turn.offer.author.id);
    applyArrival(s, close);
    assert.equal(arrive(s, village('x1')).closer, null, 'still close enough');
    arrive(s, village('x2'));
    assert.equal(arrive(s, village('x3')).closer.site, 'x3', 'left far behind, someone nearer takes the ending');
  }
});
test('the director can be held to the channels the game supports so far', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const s = story(seed); recordAccount(s, STORY_FIRST);
    for (let i = 0; i < 8; i++) {
      const site = village('c' + i), plan = arrive(s, site, people(site.id), { channels: ['stand'] });
      if (plan.offer) { assert.equal(plan.offer.channel, 'stand'); readAll(s, site); }
    }
  }
});
