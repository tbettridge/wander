// Walking into someone's home.
//
// A house with its family inside is not a public room. When the traveller
// comes in uninvited, whoever is up walks over and speaks first: some ask if
// you need something, some want to know why you didn't knock. Someone asleep
// wakes when you come close to the bed, and is cross about it; a few are
// furious.
//
// This module is the pure half: which buildings count as a home, how each
// resident takes an intrusion (seeded, so the same person reacts the same way
// in every session), what they say when no model is available, and what the
// dialogue model is told. The settlement stream does the walking.
//
// None of it is authoritative for the game: an angry resident still takes a
// delivery, still answers about the road, and cannot throw anyone out.

/** Buildings people live in. Inns, shops, halls, churches and the rest are open to callers. */
export const PRIVATE_HOME_PROGRAMS = Object.freeze(new Set(['dwelling', 'row-house', 'infill-house']));

/** How close the traveller comes to a bed before the sleeper wakes, in metres. */
export const HOME_WAKE_RANGE = 2.2;
/** A resident walking over stops this far from the traveller. */
export const HOME_APPROACH_STOP = 1.7;
/** Stepping out and straight back in is the same visit, not a new intrusion. */
export const HOME_REENTRY_GRACE_SECONDS = 45;
/** How long after the traveller comes in before the resident looks up. */
export const HOME_NOTICE_SECONDS = 0.8;
/** Visits within this many world hours count as the same day. */
export const HOME_DAY_HOURS = 16;
/** Wakings within this many world hours count as the same night. */
export const HOME_NIGHT_HOURS = 10;

export const HOME_MOODS = Object.freeze(['welcoming', 'annoyed', 'angry']);

export function isPrivateHome(building) {
  return PRIVATE_HOME_PROGRAMS.has(building?.program);
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * The resident's temper about their own front door, fixed for life by the
 * world seed and who they are: easygoing folk ask what you need, prickly ones
 * want to know why you didn't knock, fiery ones are the ones to wake at your
 * peril.
 */
export function homeTemper(worldSeed, actorId) {
  const roll = (hashText(`${worldSeed}:home-temper:${actorId}`) % 1000) / 1000;
  return roll < 0.45 ? 'easygoing' : roll < 0.8 ? 'prickly' : 'fiery';
}

/**
 * Who has been in whose house, and when. Kept for the session: enough that a
 * second visit in a day gets "you again" rather than the first outburst
 * replayed word for word.
 */
export class HomeVisitLedger {
  constructor() { this.records = new Map(); }

  entry(actorId, worldHours = 0) {
    const record = this.records.get(actorId);
    if (!record) return { visitsToday: 0, wokenTonight: 0, total: 0 };
    return {
      visitsToday: record.visits.filter((at) => worldHours - at < HOME_DAY_HOURS).length,
      wokenTonight: record.wakings.filter((at) => worldHours - at < HOME_NIGHT_HOURS).length,
      total: record.total,
    };
  }

  record(actorId, situation, worldHours = 0) {
    const record = this.records.get(actorId) || { visits: [], wakings: [], total: 0 };
    record.visits.push(worldHours);
    if (situation === 'woke') record.wakings.push(worldHours);
    record.total++;
    // Old entries say nothing about today.
    record.visits = record.visits.filter((at) => worldHours - at < HOME_DAY_HOURS * 2).slice(-8);
    record.wakings = record.wakings.filter((at) => worldHours - at < HOME_NIGHT_HOURS * 2).slice(-8);
    this.records.set(actorId, record);
    return record;
  }
}

const LINES = Object.freeze({
  welcoming: [
    'Oh! I didn’t hear you knock. Can I help you with something?',
    'Hello there. You’ve found your way in, then. Do you need something?',
    'Well, a visitor. Is there something I can do for you?',
    'Ah, you gave me a start. What can I do for you?',
    'Hello? Are you lost, or looking for someone?',
    'Come in, since you’re in. Was there something you needed?',
  ],
  annoyed: [
    'Excuse me. This is my home. Do you always walk in without knocking?',
    'Can I help you? Most people knock first.',
    'Hold on. Who said you could come in here?',
    'You can’t just wander into people’s houses. What do you want?',
    'This isn’t the inn, you know. What are you doing in here?',
    'I don’t remember inviting anyone in. Well?',
  ],
  wokeAnnoyed: [
    'Mm? What… who’s there? Do you know what time it is?',
    'Someone’s in the house… You woke me. What do you want?',
    'Can’t a person sleep in their own bed? What is it?',
    'You’d better have a good reason for waking me.',
    'What? Who… this had better be important.',
  ],
  wokeAngry: [
    'What on earth? Get out of my house! You walk in while I’m asleep and stand over my bed?',
    'Who are you? What are you doing in here while I’m sleeping? Out!',
    'Have you lost your mind? Creeping into a house while folk are asleep! Out, before I wake the street!',
    'I was asleep! In my own home! Give me one good reason not to throw you out.',
    'You’ve got some nerve, waking me like this. Out. Now.',
  ],
  welcomingRepeat: [
    'Back again? Did you forget something?',
    'You again! Come in, then. What is it this time?',
  ],
  annoyedRepeat: [
    'You again. I did ask you to knock.',
    'Twice in one day. What now?',
  ],
  wokeRepeat: [
    'Again? You woke me again? Out!',
    'Twice in one night! I’m bolting the door after you.',
  ],
  courierAwake: [
    'Oh, the courier. You could have knocked, but never mind. Is that {title} you’ve got?',
    'Ah, is that the post? Come in. Is {title} for us?',
  ],
  courierWoke: [
    'Mm… the courier? At this hour? If that’s {title}, I suppose I’d better take it.',
    'You woke me for the post? Well, if that’s {title}, let’s have it.',
  ],
  collectionAwake: [
    'Ah, it’s you. Come in; I’ve something to give you.',
    'Oh, the courier. Good, I was hoping you’d come by.',
  ],
  collectionWoke: [
    'Mm… the courier? It’s late. You’ll be wanting what I wrote, I suppose.',
  ],
  contactAwake: [
    'Oh, it’s you. Come in, then; I wasn’t expecting you indoors.',
    'Courier! You found the house. What can I do for you?',
  ],
  contactWoke: [
    'Mm… courier? It’s the middle of the night. What is it?',
  ],
  lingerWelcoming: [
    'Was there something else?',
    'Still here? What else can I do for you?',
  ],
  lingerAnnoyed: [
    'Still here? Go on, then. What is it?',
    'You’re still in my house. What now?',
  ],
  lingerAngry: [
    'I told you to get out. What now?',
    'Are you still here? Say what you want and go.',
  ],
});

function pick(pool, seed) {
  return pool[seed % pool.length];
}

/**
 * How this resident takes it, and the first thing they say.
 *
 * situation: 'intruding' (they were up when you walked in) or 'woke'.
 * errand: a reason the courier is in this house, from the courier story:
 *   { kind: 'delivery' | 'collection' | 'contact', title? }.
 * familiar: the traveller is someone they know well.
 */
export function homeVisitReaction({
  worldSeed = 0, actorId, situation = 'intruding', ledger = null, worldHours = 0,
  errand = null, familiar = false,
} = {}) {
  const temper = homeTemper(worldSeed, actorId);
  const history = ledger?.entry(actorId, worldHours) || { visitsToday: 0, wokenTonight: 0, total: 0 };
  const repeat = situation === 'woke' ? history.wokenTonight > 0 : history.visitsToday > 0;
  let mood;
  if (situation === 'woke') {
    // Nobody is glad to be woken. The fiery wake furious, and anyone woken a
    // second time in a night is past being polite. Post they were waiting for
    // takes the edge off: grumpy, never furious.
    mood = errand ? 'annoyed'
      : (temper === 'fiery' && !familiar) || history.wokenTonight > 0 ? 'angry' : 'annoyed';
  } else {
    mood = errand || familiar || temper === 'easygoing' ? 'welcoming' : 'annoyed';
  }
  const seed = hashText(`${worldSeed}:home-line:${actorId}:${history.total}`);
  let pool;
  if (errand?.kind === 'delivery') pool = situation === 'woke' ? LINES.courierWoke : LINES.courierAwake;
  else if (errand?.kind === 'collection') pool = situation === 'woke' ? LINES.collectionWoke : LINES.collectionAwake;
  else if (errand) pool = situation === 'woke' ? LINES.contactWoke : LINES.contactAwake;
  else if (repeat) pool = situation === 'woke' ? LINES.wokeRepeat : mood === 'welcoming' ? LINES.welcomingRepeat : LINES.annoyedRepeat;
  else if (situation === 'woke') pool = mood === 'angry' ? LINES.wokeAngry : LINES.wokeAnnoyed;
  else pool = mood === 'welcoming' ? LINES.welcoming : LINES.annoyed;
  const line = pick(pool, seed).replace('{title}', errand?.title || 'that');
  return {
    actorId, situation, mood, temper, repeat,
    visitsToday: history.visitsToday + 1,
    errand: errand ? { kind: errand.kind, ...(errand.title ? { title: errand.title } : {}) } : null,
    familiar: !!familiar,
    line,
    // A third uninvited visit in one day: they've stopped getting up for it.
    approach: situation === 'woke' || history.visitsToday < 2 || !!errand,
  };
}

/** What they say if the traveller speaks to them again while still in the house. */
export function homeVisitLingerLine(reaction, seed = 0) {
  const pool = reaction?.mood === 'angry' ? LINES.lingerAngry
    : reaction?.mood === 'annoyed' ? LINES.lingerAnnoyed : LINES.lingerWelcoming;
  return pick(pool, Math.abs(Math.floor(seed)) || 0);
}

/**
 * The dialogue context's view of it. `opening` is the line they already said
 * aloud (or will open with); it is null once a conversation has opened, so a
 * second chat in the same visit does not repeat the first outburst.
 */
export function homeVisitContext(reaction, { opening = true, homeName = null } = {}) {
  if (!reaction) return null;
  return {
    situation: reaction.situation === 'woke' ? 'woke-you' : 'intruding',
    mood: reaction.mood,
    repeat: !!reaction.repeat,
    visitsToday: reaction.visitsToday || 1,
    ...(homeName ? { home: homeName } : {}),
    errand: reaction.errand || null,
    spoken: !!reaction.spoken,
    opening: opening ? reaction.line : null,
    ...(opening ? {} : { linger: homeVisitLingerLine(reaction, reaction.visitsToday) }),
  };
}

/** Instructions for the model; empty when the conversation is not in the resident's home. */
export function homeVisitInstructions(homeVisit) {
  if (!homeVisit) return '';
  const what = homeVisit.situation === 'woke-you'
    ? 'You were asleep in your own bed and the traveller came into your home uninvited and woke you.'
    : 'The traveller has walked into your own home without knocking or being invited. You noticed and went over to them.';
  const mood = homeVisit.mood === 'angry'
    ? 'You are angry: speak sharply and tell them plainly they should not be here.'
    : homeVisit.mood === 'annoyed'
      ? 'You are annoyed at the intrusion: be curt and ask what they want.'
      : 'You take it in good part: ask whether they need something.';
  return [
    `homeVisit is authoritative. ${what} ${mood}`,
    homeVisit.repeat ? 'They have already come in uninvited earlier today; you remember it.' : '',
    homeVisit.errand ? 'They are the courier and may have a real reason to be here (homeVisit.errand), so let that soften you and let any handover happen.' : '',
    homeVisit.opening ? `You have already said: "${homeVisit.opening}". Do not repeat it; carry on from it.` : '',
    'Let them explain. An apology or a good reason can soften you; rudeness can make you crosser. Stay in character.',
    'Anger is words only: never threaten violence, never claim to call a watch or lock them in, and never refuse a delivery or directions the game offers. You cannot physically remove them.',
  ].filter(Boolean).join(' ');
}

/** The model's instruction for a conversation the resident opens in their own home. */
export function homeVisitOpeningPrompt(homeVisit) {
  if (!homeVisit) return null;
  return homeVisit.situation === 'woke-you'
    ? `You have just been woken in your own bed by the traveller standing in your home. Speak first, ${homeVisit.mood === 'angry' ? 'angrily' : 'groggy and cross'}, in one or two sentences.`
    : `The traveller has just walked into your home uninvited and you have come over to them. Speak first, ${homeVisit.mood === 'welcoming' ? 'asking whether they need something' : 'annoyed, asking what they are doing in your house'}, in one or two sentences.`;
}

/**
 * Authored replies when no model is available, for the things people say
 * to someone whose house they walked into. Null when nothing fits, so the
 * ordinary replies (directions, neighbours, the road) carry on.
 */
export function homeVisitFallbackReply(homeVisit, userText = '') {
  if (!homeVisit) return null;
  const text = String(userText || '').toLocaleLowerCase();
  const angry = homeVisit.mood === 'angry', welcoming = homeVisit.mood === 'welcoming';
  if (/\b(?:sorry|apolog|excuse me|didn'?t mean|did not mean|my mistake|forgive|pardon)/.test(text)) {
    return { text: angry
      ? 'Hmph. Sorry doesn’t put me back to sleep. Next time, knock, and not in the middle of the night.'
      : welcoming ? 'No harm done. Most people knock, that’s all.'
        : 'Well. Next time, knock. What is it you wanted?' };
  }
  if (/\b(?:leav|going|go now|i'?ll go|get out|bye|goodbye|goodnight|good night)\b/.test(text)) {
    return { text: angry ? 'Good. Shut the door behind you.'
      : welcoming ? 'Mind the step on your way out.' : 'Close the door on your way out.' };
  }
  if (/\b(?:knock|door was open|door open|wasn'?t locked|thought.*(?:inn|shop|empty))\b/.test(text)) {
    return { text: welcoming ? 'Ha. It’s a house, not the inn, but you’re here now.'
      : 'An open door isn’t an invitation. This is somebody’s home.' };
  }
  if (/^\s*(?:hi|hello|hey|good (?:morning|evening|afternoon)|greetings)\b/.test(text)) {
    return { text: angry ? 'Never mind hello. What are you doing in my house?'
      : welcoming ? 'Hello. What brings you in?' : 'Hello yourself. What do you want?' };
  }
  if (/\b(?:what are you doing|who are you|why are you)\b/.test(text)) {
    return { text: angry ? 'Me? I live here! Who are you, walking in on people?'
      : 'I live here. That’s rather my question for you.' };
  }
  return null;
}

/**
 * One frame of deciding who reacts. The settlement stream supplies the house
 * the traveller is standing in (if any) and the people of that house who are
 * in it; this returns who should start reacting now.
 *
 * hosts: [{ id, awake, eligible, busy, distance, sameFloor }]
 */
export class HomeVisitTracker {
  constructor({ ledger = new HomeVisitLedger() } = {}) {
    this.ledger = ledger;
    this.buildingId = null;
    this.enteredAt = 0;
    this.reacted = new Set();
    this.awakeReacted = false;
    this.left = new Map();   // buildingId -> { at, reacted, awakeReacted }
  }

  update({ buildingId = null, hosts = [], simSeconds = 0, playerBusy = false } = {}) {
    if (buildingId !== this.buildingId) {
      if (this.buildingId) {
        this.left.set(this.buildingId, { at: simSeconds, reacted: this.reacted, awakeReacted: this.awakeReacted });
      }
      this.buildingId = buildingId;
      const earlier = buildingId ? this.left.get(buildingId) : null;
      if (earlier && simSeconds - earlier.at < HOME_REENTRY_GRACE_SECONDS) {
        // Out to the step and back: carry on the same visit.
        this.reacted = earlier.reacted; this.awakeReacted = earlier.awakeReacted;
        this.enteredAt = simSeconds - HOME_NOTICE_SECONDS;
      } else {
        this.reacted = new Set(); this.awakeReacted = false; this.enteredAt = simSeconds;
      }
      for (const [id, record] of this.left) if (simSeconds - record.at > HOME_REENTRY_GRACE_SECONDS) this.left.delete(id);
    }
    if (!buildingId || playerBusy) return [];
    const starts = [];
    for (const host of hosts) {
      if (host.awake || !host.eligible || host.busy || this.reacted.has(host.id)) continue;
      if (host.sameFloor && host.distance <= HOME_WAKE_RANGE) {
        this.reacted.add(host.id);
        starts.push({ actorId: host.id, situation: 'woke' });
      }
    }
    if (!this.awakeReacted && simSeconds - this.enteredAt >= HOME_NOTICE_SECONDS - 1e-6) {
      const awake = hosts.filter((host) => host.awake && host.eligible && !host.busy && !this.reacted.has(host.id))
        .sort((a, b) => (b.sameFloor - a.sameFloor) || (a.distance - b.distance));
      if (awake.length) {
        this.awakeReacted = true;
        this.reacted.add(awake[0].id);
        starts.push({ actorId: awake[0].id, situation: 'intruding' });
      }
    }
    return starts;
  }
}
