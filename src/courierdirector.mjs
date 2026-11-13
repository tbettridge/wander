// The story director: when the courier reaches a settlement it decides what
// that place offers, zero or one paper at a time, from the story seed, the
// settlement and how far this courier has come. `planArrival` is pure and
// `applyArrival` is its reducer, so the same seed and the same choices always
// give the same story, and what a place offered is saved and never re-rolled.
import { COURIER_EVIDENCE } from './couriercontent.mjs';
import { STORY_STANCES, STORY_AWAY, accountDef, beatDone, beatOpen, activeTell, stanceOf, storyHash, storyHeld,
  storyNeeds, storyPick, tellsWith } from './courierstory.mjs';

export const DIRECTOR = Object.freeze({
  siteOffers: 4,     // papers one settlement will ever be recorded as holding
  liveCopies: 3,     // unread copies of one account; a fourth takes the oldest down
  staleArrivals: 2,  // arrivals elsewhere before an unread paper is offered again nearer the courier
  restHours: 6,      // a place the courier has not left offers something new only after a rest
  quietPercent: 35,  // how often a farmstead or hamlet has nothing, when nothing forces it
  closerStale: 3,    // arrivals elsewhere before someone nearer takes the ending
  seen: 16,          // places remembered as already looked at
});
const BIG = new Set(['village', 'town', 'station-village', 'station-halt']);

/** Changes whenever the story moves, so a place is looked at again only when there is something new to decide. */
export function progressMark(story) {
  const plot = story.plot;
  return [Object.keys(story.evidence || {}).length, Object.values(story.compared || {}).filter(Boolean).length,
    story.hypothesis ? 1 : 0, Object.keys(plot.voices).length, plot.beats.named ? 1 : 0, plot.beats.turn ? 1 : 0,
    plot.beats.ending ? 1 : 0].join('.');
}
/** Settlement id → the accounts the tutorial keeps posted there. */
export function tutorialCopies(story) {
  const copies = new Map();
  for (const [key, place] of Object.entries(story.bindings?.places || {})) {
    copies.set(place.id, new Set(COURIER_EVIDENCE.filter(evidence => evidence.places.includes(key)).map(evidence => evidence.id)));
  }
  return copies;
}
const unreadOffers = story => Object.entries(story.plot.sites).flatMap(([siteId, site]) =>
  site.offers.filter(offer => !storyHeld(story, offer.a)).map(offer => ({ siteId, offer })));

/**
 * Decide what `site` offers now. Returns null when there is nothing to
 * decide (the same place, with the story where it was), otherwise a plan for
 * `applyArrival`. `residents` are the adults at home there:
 * `{ id, name, role, familiarity? }`.
 */
export function planArrival(story, site, residents = [], { nowHour = 0, channels = null } = {}) {
  const plot = story.plot, pacing = plot.pacing, mark = progressMark(story);
  const arrival = pacing.last !== site.id;
  const copies = tutorialCopies(story), tutorial = copies.has(site.id);
  const closerDue = beatOpen(story, 'ending') && !plot.closer;
  if (!arrival) {
    const seen = pacing.seen.find(entry => entry[0] === site.id);
    if (seen && seen[1] === mark) return null;
    if (seen && nowHour - seen[2] < DIRECTOR.restHours && !closerDue) return null;
  }
  const arrivals = pacing.arrivals + (arrival ? 1 : 0);
  const away = !arrival ? pacing.away : tutorial ? 0 : pacing.away + 1;
  const plan = { site: { id: site.id, name: site.name || site.id, kind: site.kind || 'hamlet', tutorial },
    arrival, nowHour, mark, quiet: false, offer: null, recycle: null, closer: null };
  const people = [...residents].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (beatDone(story, 'ending')) return plan;
  if (beatOpen(story, 'ending')) {
    const left = plot.closer && plot.closer.site !== site.id && arrivals - plot.closer.at >= DIRECTOR.closerStale;
    if ((!plot.closer || left) && people.length) plan.closer = pickCloser(story, site, people);
    return plan;
  }
  const record = plot.sites[site.id];
  if (record?.offers.some(offer => !storyHeld(story, offer.a)) || (record?.offers.length || 0) >= DIRECTOR.siteOffers) return plan;
  const inTutorial = !!story.bindings?.places && away < STORY_AWAY;
  const needs = storyNeeds(story, { tutorial: inTutorial });
  const unread = unreadOffers(story);
  const fresh = unread.filter(({ siteId, offer }) => siteId === site.id || arrivals - offer.at < DIRECTOR.staleArrivals);
  let candidate = null;
  for (const need of needs) {
    if (need.first) { if (copies.get(site.id)?.has(need.account)) break; }
    else {
      if (fresh.some(({ offer }) => offer.a === need.account)) continue;
      if (inTutorial && [...copies.values()].some(posted => posted.has(need.account))) continue;
    }
    candidate = place(story, need, site, people, channels);
    if (candidate) break;
  }
  if (!candidate) return plan;
  const must = candidate.first || BIG.has(plan.site.kind) || pacing.quiet >= 1
    || storyHash(plot.seed, 'pace', site.id) % 100 >= DIRECTOR.quietPercent;
  if (!must) { plan.quiet = true; return plan; }
  plan.offer = candidate;
  const live = unread.filter(({ offer }) => offer.a === candidate.account);
  if (live.length >= DIRECTOR.liveCopies) {
    const oldest = live.filter(({ siteId }) => siteId !== site.id).sort((a, b) => a.offer.at - b.offer.at)[0];
    if (oldest) plan.recycle = { siteId: oldest.siteId, account: candidate.account };
  }
  return plan;
}

function place(story, need, site, people, channels) {
  const plot = story.plot, def = accountDef(need.account);
  // An account that already has its writer travels as a copy pinned to the board.
  if (def.tutorial || plot.accounts[need.account]) return { account: need.account, beat: need.beat, channel: 'stand', copy: true, author: null, first: !!need.first };
  const partners = tellsWith(need.account).flatMap(tell => tell.accounts).filter(id => id !== need.account)
    .map(id => plot.accounts[id]).filter(Boolean);
  // The two halves of one tell come from two different places.
  if (partners.some(partner => partner.site === site.id)) return null;
  const writers = new Set(Object.values(plot.accounts).map(account => account.by));
  let pool = [];
  for (const role of def.roles) {
    pool = people.filter(person => (role === '*' || person.role === role) && !writers.has(person.id));
    if (pool.length) break;
  }
  if (!pool.length) pool = people.filter(person => !partners.some(partner => partner.by === person.id));
  if (!pool.length) return null;
  let author = storyPick(pool, plot.seed, 'cast', site.id, need.account), stance = stanceOf(story, author.id);
  if (need.beat === 'named') {
    // Whoever names it should not simply repeat the one voice already heard.
    const heard = Object.keys(plot.voices);
    if (heard.length === 1 && heard[0] === stance) {
      const other = pool.find(person => stanceOf(story, person.id) !== stance);
      if (other) { author = other; stance = stanceOf(story, other.id); }
      else stance = storyPick(STORY_STANCES.filter(item => item !== stance), plot.seed, 'tilt', author.id);
    }
  }
  const allowed = def.channels.filter(channel => !channels || channels.includes(channel));
  return { account: need.account, beat: need.beat, channel: allowed.length ? storyPick(allowed, plot.seed, 'channel', site.id, need.account) : 'stand',
    copy: false, author: { id: author.id, name: author.name, stance }, first: false };
}

function pickCloser(story, site, people) {
  const plot = story.plot;
  // Not the person who has just handed over the turn, if anyone else is at home.
  const turn = plot.accounts[activeTell(story, 'turn').accounts[0]]?.by;
  const pool = people.filter(person => person.id !== turn);
  const from = pool.length ? pool : people;
  // Someone the courier already knows, when there is one.
  const known = from.filter(person => person.familiarity > 0).sort((a, b) => b.familiarity - a.familiarity)[0];
  const closer = known || storyPick(from, plot.seed, 'closer', site.id);
  return { id: closer.id, name: closer.name, site: site.id, siteName: site.name || site.id };
}

/** Record a plan in the save. */
export function applyArrival(story, plan) {
  if (!plan) return story;
  const plot = story.plot, pacing = plot.pacing, { site } = plan;
  if (plan.arrival) { pacing.arrivals++; pacing.last = site.id; pacing.away = site.tutorial ? 0 : pacing.away + 1; }
  pacing.seen = [...pacing.seen.filter(entry => entry[0] !== site.id), [site.id, plan.mark, plan.nowHour]].slice(-DIRECTOR.seen);
  if (plan.recycle) {
    const record = plot.sites[plan.recycle.siteId];
    if (record) {
      record.offers = record.offers.filter(offer => offer.a !== plan.recycle.account);
      if (!record.offers.length) delete plot.sites[plan.recycle.siteId];
    }
  }
  if (plan.offer) {
    const record = plot.sites[site.id] ||= { name: site.name, offers: [] };
    record.offers.push({ a: plan.offer.account, ch: plan.offer.channel, at: pacing.arrivals });
    if (plan.offer.author) {
      const { id, name, stance } = plan.offer.author;
      plot.accounts[plan.offer.account] = { by: id, name, site: site.id, siteName: site.name, stance };
      if (stanceOf(story, id) !== stance) plot.stances[id] = stance;
    }
    pacing.quiet = 0;
  } else if (plan.quiet) pacing.quiet++;
  if (plan.closer) plot.closer = { ...plan.closer, at: pacing.arrivals };
  return story;
}
