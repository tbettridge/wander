// The lighthouse on the courier's round.
//
// A lighthouse is lived in: a keeper and their household, named after the
// family ("Firth Lighthouse"), who light the lamp at dusk, keep the watch
// through the night, put it out at dawn and sleep the morning away. They need
// things carried up from the post town: lamp oil (heavy), glass chimneys
// (fragile) and ordinary stores. This module is the plain, testable part of
// that: what each order is, how the keeper's day runs, and what they say.
// Nothing here touches three.js or the scene.

import { storyHash } from './courierstory.mjs';

/** A lighthouse joins the round when it stands this close to the post town. */
export const LIGHTHOUSE_ROUND_REACH = 9000;
/** Post days between one supply order and the next, once one is delivered. */
export const LIGHTHOUSE_ORDER_GAP_DAYS = 3;

const firstName = name => String(name || '').split(' ')[0];
const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');

/**
 * The standing order, in the order the keeper runs short. Each carries how it
 * travels: oil is heavy (two places in the satchel, and no running with it on
 * foot) and the chimney is fragile (it cracks if run with, galloped or jumped).
 */
export const LIGHTHOUSE_ORDERS = Object.freeze([
  Object.freeze({ cargo: 'oil', kind: 'parcel', heavy: true, slots: 2, icon: '🛢️',
    title: 'Lamp Oil for {light}',
    description: 'A stoppered can of lamp oil from the chandler in {town}, for {keeper} at {light}. Heavy: it takes two places in your satchel, and you cannot run with it on foot. The loan horse carries it easily.',
    thanks: '{keeperFirst} takes the can by its handle and weighs it. “That’s the next fortnight of nights. The lamp thanks you, and so do the ships.”',
    reply: 'A note from {keeperFirst} for {senderFirst}: the oil came safe, and the lamp has not gone dark.' }),
  Object.freeze({ cargo: 'glass', kind: 'parcel', fragile: true, icon: '🔦',
    title: 'A Lamp Glass for {light}',
    description: 'A new glass chimney for the lamp, packed in straw, from {town} for {keeper} at {light}. Fragile: walk with it, take the train, or keep the horse to a walk. Running, galloping or jumping will crack it.',
    thanks: '{keeperFirst} lifts the chimney out of its straw and holds it to the light. “Not a mark on it. The old one has a crack you could post a letter through.”',
    cracked: '{keeperFirst} turns the chimney and finds the crack. “Ah. It will do for a few nights while I write for another. Thank you for bringing it all this way.”',
    crackedLabel: 'cracked',
    chipMessage: 'The lamp glass has cracked. Walk gently or take the train; it can still be delivered.',
    reply: 'A note from {keeperFirst} for {senderFirst}: the glass is fitted and the lamp burns clear again.' }),
  Object.freeze({ cargo: 'stores', kind: 'parcel', icon: '📦',
    title: 'Stores for {light}',
    description: 'A box of stores for {keeper} at {light}: tea, wicks, candles and the week’s newspapers from {town}.',
    thanks: '{keeperFirst} sets the box on the step and pulls out the newspapers first. “A week of news at once. That will see me through a long watch.”',
    reply: 'A list from {keeperFirst} for {senderFirst}: what the lighthouse is short of for next time.' }),
  Object.freeze({ cargo: 'watch', kind: 'parcel', night: true, icon: '🧺',
    title: 'Supper for the Watch at {light}',
    description: 'A covered basket from the inn at {town}: a pie, a twist of tea and the evening paper, for {keeper} to have on the night’s watch. It is wanted after dark, when the keeper is up at the lamp: carry it up the stair and hand it over on the gallery. The box at the foot of the ramp will not do.',
    thanks: '{keeperFirst} lifts the cloth and breathes in. “Nearly warm still. You climbed all that way with it? Sit a minute and watch the light go round.”',
    early: '{keeperFirst} smiles at the basket. “That’s my supper for the watch. Bring it up to me at the lamp after dark; it’s no use to me yet.”',
    boxed: 'This basket is wanted on the watch, not left in a box. Take it up the stair to the gallery after dark.',
    reply: 'A note from {keeperFirst} for {senderFirst}: the supper reached the gallery, and the watch went quickly.' }),
]);

/** The order after `count` deliveries: oil, then glass, then stores, and round again. */
export function lighthouseOrder(count = 0) {
  return LIGHTHOUSE_ORDERS[((count % LIGHTHOUSE_ORDERS.length) + LIGHTHOUSE_ORDERS.length) % LIGHTHOUSE_ORDERS.length];
}

/** How many places a commission takes in the satchel. */
export function jobSlots(def) { return Math.max(1, Math.floor(Number(def?.slots) || 1)); }

/**
 * A supply order, as a commission: posted by someone in the post town for the
 * keeper. `standing` keeps it pinned up until it is carried, so a courier who
 * misses a day never loses the lighthouse from their round.
 */
export function lighthouseOrderDef({ id, day = 0, count = 0, sender, keeper, town, light, lighthouseId, townId }) {
  const order = lighthouseOrder(count);
  const names = { town, light, keeper: keeper.name, keeperFirst: firstName(keeper.name), sender: sender.name, senderFirst: firstName(sender.name) };
  return {
    id, dynamic: true, standing: true, lighthouse: lighthouseId, cargo: order.cargo, kind: order.kind, day,
    ...(order.heavy ? { heavy: true, slots: order.slots } : {}),
    ...(order.fragile ? { fragile: true, chipMessage: order.chipMessage, crackedLabel: order.crackedLabel } : {}),
    ...(order.night ? { night: true, early: fill(order.early, names), boxed: fill(order.boxed, names) } : {}),
    title: fill(order.title, names), description: fill(order.description, names),
    thanks: fill(order.thanks, names), ...(order.cracked ? { crackedThanks: fill(order.cracked, names) } : {}),
    sender: sender.id, recipient: keeper.id, senderPlace: townId, recipientPlace: lighthouseId,
  };
}

/** The keeper's answer to an order handed over in person: a letter back to whoever sent it. */
export function lighthouseReplyDef({ id, order, keeper, sender, town, light }) {
  const source = LIGHTHOUSE_ORDERS.find(item => item.cargo === order.cargo) || LIGHTHOUSE_ORDERS[2];
  const names = { keeperFirst: firstName(keeper.name), senderFirst: firstName(sender.name) };
  return {
    id, dynamic: true, kind: 'letter', lighthouseReply: true, replyTo: order.id, day: order.day,
    title: 'A Note from ' + light, sender: keeper.id, recipient: sender.id,
    senderPlace: order.recipientPlace, recipientPlace: order.senderPlace,
    description: fill(source.reply, names) + ' For ' + sender.name + ' in ' + town + '.',
    thanks: firstName(sender.name) + ' reads the note twice. “Good. I worry, with only the sea out there. Thank you for carrying it.”',
  };
}

/**
 * When the keeper sets off up the stair. The game's clock runs about 78 real
 * seconds to the hour by day and races once the sun is down, and the climb
 * from the house is a minute and a half: setting off at a quarter to five
 * puts the keeper at the lamp as the light goes, a little before six.
 */
export const KEEPER_CLIMB_HOUR = 16.75;
/** When the lamp goes out and the keeper comes down: sunrise. */
export const KEEPER_DOWN_HOUR = 6;
/** By this hour the lamp is lit, whether or not anyone saw the keeper reach it. */
export const LAMP_LIT_BY_HOUR = 18.4;
/** With nobody near enough to watch the climb, it takes this long. */
export const LAMP_UNSEEN_HOUR = 17.9;

/**
 * The keeper's day. Lamp-time is dusk, when the lamp is lit; the watch runs
 * the night; at dawn the lamp goes out and the log is written up; then the
 * keeper sleeps the morning away and is about the house in the afternoon.
 */
export function keeperPhase(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  if (h >= KEEPER_CLIMB_HOUR && h < 19) return 'lamp-time';
  if (h >= 19 || h < KEEPER_DOWN_HOUR) return 'watch';
  if (h < 8) return 'dawn';
  if (h < 14) return 'asleep';
  return 'day';
}

const KEEPER_LINES = Object.freeze({
  'lamp-time': [
    'Can’t stop long: the lamp wants lighting before the light goes. If you have post, it can go on the step or in the box at the foot of the ramp.',
    'Dusk already. I’ll be up the stair in a minute to light her. Is it news from {town}?',
  ],
  watch: [
    'Quiet on the water tonight. I’m up until dawn, so you have company if you want it. Mind the stair if you go up; the gallery rail is cold.',
    'You’ve come a long way for the middle of the night. The lamp’s turning, the log’s open, and the kettle’s on.',
  ],
  dawn: [
    'Lamp’s out and the wick’s trimmed. I’ll write the night up in the log, and then it’s bed for me.',
    'Morning. Not a ship in sight all night, which is how I like it. I’m about to turn in.',
  ],
  asleep: [
    'Mm? Sorry, you’ve caught me on my way to bed. Watch-keeper’s hours. Anything for us can go in the box at the foot of the ramp.',
    'I keep the night watch, so mornings I sleep. The note on the door says so, and the box by the board takes the post.',
  ],
  day: [
    'Afternoon. Have you come up from {town}? The oil and the glass all come that way, on someone’s back.',
    'You found us. Not many walk out this far. If you go up the stair, the view from the gallery is worth the climb.',
  ],
});

/** A line the keeper says when you find them, by the hour, authored so it works without AI. */
export function keeperLine({ hour, seed = 0, town = 'the town', inbound = null }) {
  const phase = keeperPhase(hour), lines = KEEPER_LINES[phase];
  const line = fill(lines[storyHash(seed, 'keeper-line', phase, Math.floor(Number(hour) || 0)) % lines.length], { town });
  if (!inbound) return { phase, line };
  const ask = phase === 'asleep' ? ' Is that ' + inbound + '? I’m awake enough to sign for it.' : ' Is that ' + inbound + '? Hand it over whenever you’re ready.';
  return { phase, line: line + ask };
}

/** The note pinned to the door, by the hour. */
export function keeperDoorNote({ hour, surname = 'the keeper' }) {
  const phase = keeperPhase(hour);
  const family = surname === 'the keeper' ? 'The keeper' : 'The ' + surname + 's';
  if (phase === 'asleep') return 'Asleep after the night’s watch. Post in the box at the foot of the ramp, please. — ' + family;
  if (phase === 'watch' || phase === 'lamp-time') return 'On watch. Knock, or leave post in the box at the foot of the ramp. — ' + family;
  return 'Knock if you have post. The lamp is lit at dusk. — ' + family;
}

/**
 * What the courier can see from the gallery: each place within sight, with
 * which way it lies and how long it is on foot. `places` are `{ name, x, z,
 * kind }`; the nearest few of each kind are kept so the view reads as a view.
 */
export function galleryView({ from, places = [], walkTime, compass, limit = 7 }) {
  const seen = places.filter(place => Number.isFinite(place.x) && Number.isFinite(place.z))
    .map(place => ({ ...place, metres: Math.hypot(place.x - from.x, place.z - from.z) }))
    .filter(place => place.metres > 40)
    .sort((a, b) => a.metres - b.metres);
  const kept = [], byKind = new Map();
  for (const place of seen) {
    const count = byKind.get(place.kind) || 0;
    if (count >= 3) continue;
    byKind.set(place.kind, count + 1); kept.push(place);
    if (kept.length >= limit) break;
  }
  return kept.map(place => ({ name: place.name, kind: place.kind, x: place.x, z: place.z, metres: Math.round(place.metres),
    direction: compass(place.x - from.x, place.z - from.z), walk: walkTime(place.metres) }));
}

/** The view, as the courier reads it standing at the rail. */
export function galleryViewText(view, light = 'the lighthouse') {
  if (!view.length) return 'From the gallery of ' + light + ' there is only the sea on one side and empty country on the other.';
  return 'From the gallery of ' + light + ' you can see:\n' + view.map(place => '· ' + place.name + ', to the ' + place.direction + ', ' + place.walk + ' on foot').join('\n');
}

/**
 * Where the keeper's body should be: going up to the lamp and keeping the
 * watch from lamp-time to sunrise, coming down and writing up the log until
 * eight, and otherwise about the house as anyone is.
 */
export function keeperSchedule(hour) {
  const phase = keeperPhase(hour);
  if (phase === 'lamp-time' || phase === 'watch') return 'up';
  if (phase === 'dawn') return 'down';
  return null;
}

/**
 * Is the lamp lit? It is lit when the keeper reaches it at lamp-time (or, if
 * nobody is near enough to watch, once the climb would be done), burns all
 * night, and is put out at sunrise. `keeperUp` is whether the keeper has been
 * seen at the lamp tonight; `watched` whether their body is about to be seen.
 */
export function lampLit({ hour, keeperUp = false, watched = false }) {
  const h = ((Number(hour) % 24) + 24) % 24, phase = keeperPhase(h);
  if (phase === 'watch') return true;
  if (phase !== 'lamp-time') return false;
  return keeperUp || h >= (watched ? LAMP_LIT_BY_HOUR : LAMP_UNSEEN_HOUR);
}

// ——— The keeper's log ———
// Every night the keeper writes down what passes the light. There are no
// ships anywhere in this world, and nobody finds that strange, but the log is
// full of them: a few new ones each night, and one that passes at the same
// minute, under the same flag, on the same heading, every night of every log.

const SHIP_NAMES = Object.freeze(['Marigold', 'Kittiwake', 'Grey Heron', 'Amity', 'Providence', 'Morning Star', 'Curlew',
  'Hesper', 'Linnet', 'Fair Isle', 'Constant', 'Swallow', 'Halcyon', 'Ploughman', 'Rosamund', 'Peregrine', 'Tidings', 'Wren',
  'Endeavour', 'Merlin', 'Bonny Lass', 'Sea Holly', 'Lodestar', 'Thrift']);
const RIGS = Object.freeze(['barque', 'brig', 'schooner', 'ketch', 'lugger', 'smack', 'brigantine', 'cutter']);
const FLAGS = Object.freeze(['a blue ensign', 'a red ensign', 'a black and gold house flag', 'a white flag with a green cross',
  'a red and white house flag', 'a yellow pennant', 'no colours shown', 'a blue and white chequer']);
const HEADINGS = Object.freeze(['westbound', 'eastbound', 'northbound', 'southbound', 'standing off', 'beating up the coast']);
const WEATHER = Object.freeze(['Wind light, sea slight.', 'Fresh breeze from the west, sea moderate.', 'Haze after midnight; fog signal not needed.',
  'Clear, a good moon.', 'Rain squalls until two, then clearing.', 'Calm. Lamp burned clear all night.', 'Mist in the hollows inland; sea clear.']);

const pad = n => String(n).padStart(2, '0');
const clockTime = minutes => pad(Math.floor(minutes / 60) % 24) + ':' + pad(minutes % 60);

/** The ship that is in every log: chosen once from the story seed. */
export function repeatingShip(seed = 0) {
  const at = 60 + storyHash(seed, 'log-ship', 'minute') % 240; // between one and five in the morning
  return { name: SHIP_NAMES[storyHash(seed, 'log-ship', 'name') % SHIP_NAMES.length],
    rig: RIGS[storyHash(seed, 'log-ship', 'rig') % RIGS.length], flag: FLAGS[storyHash(seed, 'log-ship', 'flag') % FLAGS.length],
    heading: HEADINGS[storyHash(seed, 'log-ship', 'heading') % 4], minutes: at, time: clockTime(at) };
}

/**
 * One night's entries: two or three ships seeded from the night, and the
 * repeating one at its minute, sorted by time from dusk. `night` is the post
 * day (or any day number); the same seed and night always write the same page.
 */
export function keeperLogNight(seed = 0, night = 0) {
  const ship = repeatingShip(seed), entries = [];
  const count = 2 + storyHash(seed, 'log-count', night) % 2;
  for (let i = 0; i < count; i++) {
    const h = (...part) => storyHash(seed, 'log', night, i, ...part);
    let name = SHIP_NAMES[h('name') % SHIP_NAMES.length];
    if (name === ship.name) name = SHIP_NAMES[(h('name') + 1) % SHIP_NAMES.length];
    // From an hour after dusk to an hour before sunrise, never on the repeating ship's minute.
    let minutes = (19 * 60 + h('minute') % (10 * 60)) % (24 * 60);
    if (minutes === ship.minutes) minutes += 7;
    entries.push({ name, rig: RIGS[h('rig') % RIGS.length], flag: FLAGS[h('flag') % FLAGS.length],
      heading: HEADINGS[h('heading') % HEADINGS.length], minutes, time: clockTime(minutes) });
  }
  entries.push({ ...ship, repeating: true });
  const fromDusk = m => (m - 18 * 60 + 24 * 60) % (24 * 60);
  entries.sort((a, b) => fromDusk(a.minutes) - fromDusk(b.minutes));
  return { night, weather: WEATHER[storyHash(seed, 'log-weather', night) % WEATHER.length], entries };
}

const NIGHT_LABELS = Object.freeze(['Last night', 'The night before', 'Three nights ago', 'Four nights ago']);
const entryLine = entry => entry.time + '  The ' + entry.name + ', ' + entry.rig + ', ' + entry.flag + ', ' + entry.heading + '. Lights showing.';

/**
 * The open log as the courier reads it: the last few nights in the keeper's
 * hand, and then the first page of the oldest log on the shelf, written
 * before the keeper was born, with the same ship at the same minute in it.
 */
export function keeperLog({ seed = 0, day = 0, nights = 3, keeper = 'the keeper', light = 'the lighthouse' } = {}) {
  const pages = [];
  for (let night = Math.max(0, day - nights + 1); night <= day; night++) pages.push(keeperLogNight(seed, night));
  const ship = repeatingShip(seed);
  // The old log keeps the old ways of writing it, but the same ship in the same minute.
  const old = keeperLogNight(seed, 'oldest');
  const recent = ['The log of ' + light + ', kept by ' + keeper + '.',
    ...pages.flatMap(page => [NIGHT_LABELS[Math.min(NIGHT_LABELS.length - 1, day - page.night)] + '. ' + page.weather, ...page.entries.map(entryLine)])];
  const oldest = ['The first page of the oldest log on the shelf, its ink gone brown, in a hand that is not ' + firstName(keeper) + '’s.',
    'Weather: ' + old.weather, ...old.entries.map(entryLine),
    'Every night since, in every log on the shelf, the ' + ship.name + ' passes at ' + ship.time + '.'];
  return { ship, pages, old, recent, oldest };
}

/**
 * What people make of the log when the courier reads it to them. Nobody here
 * has seen a ship; what strikes them is the one that comes back.
 */
export const KEEPER_LOG_REACTIONS = Object.freeze({
  afraid: 'Every night, at the very same minute? Then something passes us that we cannot see, and somebody has been writing it down for longer than any of us has been alive. Close the book.',
  relieved: 'A ship. I have never seen one, but it is good to think of something out there keeping its time, night after night, and someone up the tower keeping it company.',
  denying: 'A keeper copies last night’s page when the night is dull. That is all a log that repeats is: a tired hand.',
  curious: 'The same minute? Not a minute either side? Then it is not a ship keeping time, it is time keeping the ship. Who wrote the first page?',
  keeper: 'I write down what passes the light. That is the whole of the job. I have never once wondered why it is always the same one at the same minute. …I am wondering now.',
});

/** A resident's reaction to the log being read to them, in their temperament; the keeper answers for their own book. */
export function keeperLogReaction(stance, { isKeeper = false } = {}) {
  if (isKeeper) return KEEPER_LOG_REACTIONS.keeper;
  return KEEPER_LOG_REACTIONS[stance] || KEEPER_LOG_REACTIONS.curious;
}
