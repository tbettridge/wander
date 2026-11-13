#!/usr/bin/env node
// Walk First Post's story without the game: an invented courier arrives at
// invented settlements in a random order, the director decides what each
// offers, and the courier reads, compares and talks according to a policy.
//
//   node scripts/walk-courier-story.mjs --seed 7 --policy no-jobs
//   node scripts/walk-courier-story.mjs --seed 7 --policy three-villages --tutorial
//
// tests/courierdirector.mjs runs the same walk over many seeds to prove the
// ending is always reachable.
import { pathToFileURL } from 'node:url';
import { COURIER_EVIDENCE } from '../src/couriercontent.mjs';
import { STORY_FIRST, STORY_TELLS, accountDef, beatDone, beatOpen, createPlot, recordAccount, recordCompared,
  recordEnding, recordPattern, recordVoice, storyHeld } from '../src/courierstory.mjs';
import { applyArrival, planArrival } from '../src/courierdirector.mjs';

export const WALK_POLICIES = Object.freeze(['no-jobs', 'every-job', 'random', 'three-villages', 'never-revisit', 'farmsteads-only']);
const KINDS = [['farmstead', 0.62], ['hamlet', 0.84], ['village', 0.96], ['town', 1]];
const ROLES = {
  farmstead: ['farmer'], hamlet: ['farmer', 'craftsperson', 'miller'],
  village: ['clerk', 'innkeeper', 'shopkeeper', 'smith', 'farmer', 'craftsperson'],
  town: ['clerk', 'innkeeper', 'shopkeeper', 'smith', 'miller', 'farmer', 'craftsperson'],
};
const ADULTS = { farmstead: [0, 2], hamlet: [2, 5], village: [6, 12], town: [12, 20], 'station-village': [6, 12] };
const TUTORIAL = { A: 'station-village', B: 'station-village', H: 'hamlet' };

function random(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * One courier's walk. `policy` is how they play; `tutorial` starts them in
 * three villages that keep the fixed accounts posted, as the game does.
 * `onStep(story, site)` is called after every decision, for invariants.
 */
export function walkStory({ seed = 1, policy = 'no-jobs', maxArrivals = 400, keepWalking = false, tutorial = false, onStep = null } = {}) {
  const rng = random((seed * 2654435761) ^ (policy.length * 97));
  const story = { runId: 'walk:' + seed, evidence: {}, compared: {}, hypothesis: false, concluded: false, plot: createPlot(seed) };
  const world = new Map(), trace = [];
  const make = (id, kind, name) => {
    const [least, most] = ADULTS[kind] || ADULTS.hamlet, roles = ROLES[kind] || ROLES.village;
    const count = least + Math.floor(rng() * (most - least + 1));
    const residents = Array.from({ length: count }, (_, i) => ({ id: 'npc:' + id + ':' + i, name: name + ' resident ' + (i + 1), role: roles[i] || 'resident' }));
    const entry = { site: { id, kind, name }, residents, fixed: [] };
    world.set(id, entry); return entry;
  };
  if (tutorial) {
    story.bindings = { places: {}, cast: {} };
    for (const [key, kind] of Object.entries(TUTORIAL)) {
      const entry = make('tutorial:' + key, kind, 'Tutorial ' + key);
      story.bindings.places[key] = { key, id: entry.site.id, name: entry.site.name };
      entry.fixed = COURIER_EVIDENCE.filter(evidence => evidence.places.includes(key)).map(evidence => evidence.id);
    }
  } else if (policy === 'three-villages') for (const key of ['one', 'two', 'three']) make('village:' + key, 'village', 'Village ' + key);
  const home = [...world.keys()];
  let made = 0, hour = 0, arrivals = 0, endedAt = null, current = null;
  const fresh = () => {
    const roll = rng(), kind = policy === 'farmsteads-only' ? 'farmstead' : KINDS.find(([, upTo]) => roll < upTo)[0];
    made++; return make('site:' + made, kind, kind[0].toUpperCase() + kind.slice(1) + ' ' + made).site.id;
  };
  const next = () => {
    if (policy === 'three-villages') { const others = home.filter(id => id !== current); return others[Math.floor(rng() * others.length)]; }
    if (tutorial && !current) return home[0];
    if (policy === 'never-revisit' || policy === 'farmsteads-only' || world.size < 2 || rng() < 0.7) return fresh();
    const others = [...world.keys()].filter(id => id !== current);
    return others[Math.floor(rng() * others.length)];
  };
  const say = text => trace.push('#' + arrivals + ' ' + world.get(current).site.name + ': ' + text);
  const evaluate = () => {
    const { site, residents } = world.get(current);
    const plan = planArrival(story, site, residents, { nowHour: hour });
    if (plan?.offer) say('offers “' + accountDef(plan.offer.account).title + '”' + (plan.offer.copy ? ' (a copy)' : ' by ' + plan.offer.author.name) + ' [' + plan.offer.channel + ']');
    if (plan?.recycle) say('an unread copy is taken down at ' + world.get(plan.recycle.siteId).site.name);
    if (plan?.closer) say(plan.closer.name + ' asks for the courier');
    if (plan?.quiet) say('quiet');
    applyArrival(story, plan);
    onStep?.(story, site, plan);
  };
  const act = () => {
    if (policy === 'ignore') return;
    const { site, residents, fixed } = world.get(current), careless = policy === 'random';
    const read = id => { if (recordAccount(story, id, site.id)) say('reads “' + accountDef(id).title + '”'); };
    if (!careless || rng() < 0.5) {
      // Until the dispatch sheet is in hand it is the only paper a board shows.
      for (const id of fixed) if (!storyHeld(story, id) && (id === STORY_FIRST || storyHeld(story, STORY_FIRST))) read(id);
      for (const offer of [...(story.plot.sites[site.id]?.offers || [])]) {
        if (storyHeld(story, offer.a) || (offer.a !== STORY_FIRST && !storyHeld(story, STORY_FIRST))) continue;
        if (offer.ch === 'handed' && !residents.some(person => person.id === story.plot.accounts[offer.a]?.by)) continue;
        read(offer.a);
      }
    }
    for (const tell of STORY_TELLS) {
      if (tell.accounts.length < 2 || story.compared[tell.id] || (careless && rng() < 0.3)) continue;
      if (recordCompared(story, tell.id)) say('compares “' + tell.title + '”');
    }
    if (recordPattern(story)) say('sees the pattern');
    if (residents.length && (!careless || rng() < 0.5)) {
      const person = residents[Math.floor(rng() * residents.length)], voice = recordVoice(story, person.id);
      if (voice.counted) say(person.name + ' is ' + voice.stance);
    }
    if (beatOpen(story, 'ending') && story.plot.closer?.site === site.id && recordEnding(story)) say('the last letter');
  };
  while (arrivals < maxArrivals) {
    current = next(); arrivals++; hour += 1 + rng() * 3;
    evaluate(); act();
    // The courier lingers some days: after a rest the place is looked at again.
    if (policy === 'three-villages' || rng() < 0.3) { hour += 7; evaluate(); act(); }
    if (endedAt === null && beatDone(story, 'ending')) { endedAt = arrivals; if (!keepWalking) break; }
  }
  return { story, trace, arrivals, ended: endedAt !== null, endedAt, sites: world.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = (name, fallback) => { const i = args.indexOf('--' + name); return i < 0 ? fallback : args[i + 1]; };
  const policy = value('policy', 'no-jobs');
  if (![...WALK_POLICIES, 'ignore'].includes(policy)) { console.error('Policies: ' + WALK_POLICIES.join(', ')); process.exit(1); }
  const walk = walkStory({ seed: Number(value('seed', 1)) || 1, policy, maxArrivals: Number(value('arrivals', 400)) || 400, tutorial: args.includes('--tutorial') });
  console.log(walk.trace.join('\n'));
  console.log('\n' + (walk.ended ? 'Ending reached after ' + walk.endedAt + ' arrivals' : 'No ending after ' + walk.arrivals + ' arrivals')
    + ' across ' + walk.sites + ' settlements; save holds ' + JSON.stringify(walk.story).length + ' bytes of story.');
  process.exit(walk.ended ? 0 : 1);
}
