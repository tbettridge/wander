// A villager's day.
//
// Residents used to do one thing forever: walk a ring round their house, or
// round their workplace in working hours, or round the market stalls, at
// midnight as at noon. A village has a rhythm instead, and it is made of
// ordinary days: up at dawn, a few minutes in the doorway or out in the garden,
// off to work, the market busy in the morning and again as work lets out, the
// inn filling in the evening, everyone home and the lanes empty by midnight.
//
// This module writes that day for one person: a list of blocks, each a span
// of hours with an activity, the venue it happens at and the kind of spot
// they will stand in there. It is deterministic from the person, the day and
// the village, so a resident does the same thing on the same day for everyone
// who looks, and nothing about it needs saving. Everybody's times are their
// own — a few minutes either side of their neighbours' — because a village
// whose doors all open in the same second is a clockwork toy.
//
// Pure and THREE-free; npcvenues.mjs turns a block into a place to stand and
// settlementstream.js walks them there.

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function rngFor(key) {
  let a = hashText(key);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MARKET_HOURS = Object.freeze({ open: 7, close: 18 });
export const INN_HOURS = Object.freeze({ open: 11, close: 23.5 });

/**
 * Is there a gathering in this village's square tonight? About one night in
 * six, decided by the village and the day so every visitor sees the same one.
 */
export function gatheringTonight(settlementId, dayIndex) {
  return hashText(`${settlementId}:gathering:${dayIndex}`) % 6 === 0;
}

// Activities and how each sits in the world. `indoor` blocks are where a
// resident goes out of sight (and out of simulation) when nobody is near.
export const ACTIVITY = Object.freeze({
  sleep: { venue: 'home', spot: 'inside', indoor: true },
  home: { venue: 'home', spot: 'inside', indoor: true },
  window: { venue: 'home', spot: 'window', indoor: true },
  doorway: { venue: 'home', spot: 'doorway', indoor: true },
  chores: { venue: 'home', spot: 'yard', indoor: false },
  step: { venue: 'home', spot: 'front', indoor: false },
  work: { venue: 'work', spot: 'inside', indoor: true },
  'work-front': { venue: 'work', spot: 'front', indoor: false },
  'work-yard': { venue: 'work', spot: 'yard', indoor: false },
  stall: { venue: 'market', spot: 'stall', indoor: false },
  market: { venue: 'market', spot: 'customer', indoor: false },
  stroll: { venue: 'square', spot: 'stroll', indoor: false },
  inn: { venue: 'inn', spot: 'inside', indoor: true },
  'inn-out': { venue: 'inn', spot: 'cluster', indoor: false },
  gathering: { venue: 'square', spot: 'gathering', indoor: false },
  church: { venue: 'church', spot: 'inside', indoor: true },
  play: { venue: 'play', spot: 'play', indoor: false },
  school: { venue: 'school', spot: 'inside', indoor: true },
});

const hour = (h) => Math.max(0, Math.min(24, h));

/**
 * One person's day as contiguous blocks covering 0..24.
 *
 * `person`: { actorId, role, ageBand, shift: {start, end} | null, workKind }
 * `village`: { settlementId, hasMarket, hasInn, hasChurch }
 * Roles: 'merchant' (keeps a stall), 'innkeeper', 'worker', 'home' (keeps the
 * house), 'elder', 'youth'.
 */
export function dayPlanFor(person, village, dayIndex) {
  const rng = rngFor(`${person.actorId}:day:${dayIndex}`);
  const jitter = (spread) => (rng() - 0.5) * spread;
  const blocks = [];
  let clock = 0;
  const add = (activity, until, extra = {}) => {
    const end = hour(until);
    if (end - clock < 0.05) return;
    const last = blocks[blocks.length - 1];
    if (last && last.activity === activity && !extra.fresh) { last.end = end; clock = end; return; }
    blocks.push({ start: clock, end, activity, ...ACTIVITY[activity], ...extra });
    clock = end;
  };
  const elder = person.ageBand === 'elder', youth = person.ageBand === 'youth';
  const role = person.role || 'home';
  const sunday = dayIndex % 7 === 6;

  if (role === 'child') {
    // A child's day: school in the morning where there is one, play, and
    // home before dark.
    const wakeChild = 7 + jitter(0.6), bedChild = 20.2 + jitter(0.6);
    add('sleep', wakeChild);
    add('home', wakeChild + 0.6 + rng() * 0.4);
    if (village.hasSchool && dayIndex % 7 < 5) {
      add('home', 8.6 + jitter(0.2));
      add('school', 12.4 + jitter(0.3));
      add('home', 13.4 + jitter(0.4));
    } else {
      add('home', 8.8 + jitter(0.6));
      add('play', 12 + jitter(0.6), { fresh: true });
      add('home', 13.2 + jitter(0.4));
    }
    add('play', 17.2 + jitter(0.8), { fresh: true });
    if (rng() < 0.4) add('step', clock + 0.4 + rng() * 0.4, { fresh: true });
    add('home', bedChild);
    add('sleep', 24);
    blocks[blocks.length - 1].end = 24;
    return blocks;
  }
  const wake = (elder ? 7.2 : role === 'innkeeper' ? 8.4 : 6.1) + jitter(1.2);
  const bed = (elder ? 21.2 : role === 'innkeeper' ? 23.9 : youth ? 22.4 : 22.6) + jitter(1.0);

  add('sleep', wake);
  // The first of the day at home: inside, and for some a few minutes in the
  // doorway or out in the garden before anything else.
  add('home', wake + 0.4 + rng() * 0.5);
  const morning = rng();
  if (morning < 0.3) add('doorway', clock + 0.2 + rng() * 0.25, { fresh: true });
  else if (morning < 0.62) add('chores', clock + 0.5 + rng() * 0.8, { fresh: true });
  else if (morning < 0.75) add('window', clock + 0.15 + rng() * 0.2, { fresh: true });

  if (sunday && village.hasChurch && !youth && rng() < 0.6) {
    add('home', 9.3 + jitter(0.4));
    add('church', 11 + jitter(0.3));
  }

  const marketOpen = village.hasMarket;
  if (role === 'merchant' && marketOpen && !sunday) {
    add('home', MARKET_HOURS.open - 0.4 + jitter(0.3));
    add('stall', MARKET_HOURS.close - 0.4 + jitter(0.5));
  } else if (role === 'innkeeper' && village.hasInn) {
    add('home', Math.max(clock, 9.8 + jitter(0.5)));
    add('work', 18 + jitter(0.5));
    add('inn-out', 18.6 + rng() * 0.6, { fresh: true });
    add('work', bed - 0.2);
  } else if ((role === 'worker') && person.shift && !sunday) {
    const start = person.shift.start, end = person.shift.end;
    add('home', start - 0.25);
    const front = person.workKind === 'smithy' || person.workKind === 'workshop' || person.workKind === 'barn';
    const midday = 12 + jitter(0.8);
    // Work alternates between inside and the front or the yard, so a trade is
    // seen being done rather than only being entered.
    let t = clock;
    while (t < Math.min(end, midday)) {
      const next = Math.min(Math.min(end, midday), t + 0.6 + rng() * 1.1);
      add(rng() < (front ? 0.5 : 0.25) ? (rng() < 0.5 ? 'work-front' : 'work-yard') : 'work', next, { fresh: true });
      t = next;
    }
    if (end > midday + 0.8) {
      // The midday meal: at home, or at the inn when there is one.
      add(village.hasInn && rng() < 0.35 ? 'inn' : 'home', midday + 0.6 + rng() * 0.3, { fresh: true });
      t = clock;
      while (t < end) {
        const next = Math.min(end, t + 0.6 + rng() * 1.1);
        add(rng() < (front ? 0.5 : 0.25) ? (rng() < 0.5 ? 'work-front' : 'work-yard') : 'work', next, { fresh: true });
        t = next;
      }
    }
    // Some call at the market on the way home while it is still open.
    if (marketOpen && clock < MARKET_HOURS.close - 0.5 && rng() < 0.4) {
      add('market', Math.min(MARKET_HOURS.close - 0.2, clock + 0.4 + rng() * 0.5), { fresh: true });
    }
  } else {
    // Keeping the house: chores, the market at its busiest, an afternoon of
    // the garden, the window and the step.
    add('home', 8.6 + jitter(1.0));
    if (marketOpen && !sunday && rng() < (elder ? 0.55 : 0.75)) {
      add('market', 9.6 + rng() * 1.6, { fresh: true });
    } else if (rng() < 0.5) add('stroll', clock + 0.5 + rng() * 0.6, { fresh: true });
    add('chores', clock + 0.6 + rng() * 0.9, { fresh: true });
    add('home', 13 + jitter(0.6));
    const afternoon = rng();
    if (afternoon < 0.35) add('chores', 14.4 + jitter(0.8), { fresh: true });
    else if (afternoon < 0.55) add('step', 14 + jitter(0.6), { fresh: true });
    else if (afternoon < 0.7) add('window', 13.6 + jitter(0.4), { fresh: true });
    add('home', 15.4 + jitter(0.8));
    if (marketOpen && !sunday && rng() < 0.35) add('market', Math.min(MARKET_HOURS.close - 0.2, clock + 0.5 + rng() * 0.6), { fresh: true });
  }

  // The evening: the inn, the gathering, the step or the window, or home.
  //
  // Decided for the household, not the person: a couple who spend the
  // evening together leave together, which is most of how two people come to
  // be seen walking side by side.
  if (role !== 'innkeeper') {
    const home = person.householdKey ? rngFor(`${person.householdKey}:evening:${dayIndex}`) : rng;
    const homeJitter = (spread) => (home() - 0.5) * spread;
    add('home', Math.max(clock + 0.2, 18.4 + homeJitter(0.8)));
    const gather = village.gathering && !elder && home() < 0.6;
    const evening = home();
    if (gather) {
      add('gathering', Math.min(bed - 0.3, 22 + homeJitter(0.8)), { fresh: true });
    } else if (village.hasInn && !elder && evening < (youth ? 0.25 : 0.32)) {
      // Some stand out front with a drink before going in.
      if (home() < 0.45) add('inn-out', clock + 0.4 + home() * 0.8, { fresh: true });
      add('inn', Math.min(bed - 0.2, 22.3 + homeJitter(0.9)), { fresh: true });
    } else if (evening < 0.55) {
      // The long summer-evening sit on the step.
      add('step', Math.min(bed - 0.4, clock + 1.0 + home() * 1.6), { fresh: true });
    } else if (evening < 0.64) {
      add('stroll', Math.min(bed - 0.4, clock + 0.4 + home() * 0.6), { fresh: true });
    } else if (evening < 0.74) {
      add('window', Math.min(bed - 0.4, clock + 0.2 + rng() * 0.3), { fresh: true });
    }
    add('home', bed);
  }
  add('sleep', 24);
  blocks[blocks.length - 1].end = 24;
  return blocks;
}

/** The block a plan is in at `dayHour`. */
export function blockAt(blocks, dayHour) {
  const h = ((dayHour % 24) + 24) % 24;
  for (const block of blocks) if (h >= block.start && h < block.end) return block;
  return blocks[blocks.length - 1];
}
