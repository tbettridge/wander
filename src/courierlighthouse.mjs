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
    'Dusk already. I’ll be up the stair in a minute to light it. Is it news from {town}?',
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
export function keeperLog({ seed = 0, day = 0, nights = 3, keeper = 'the keeper', light = 'the lighthouse', spouse = null } = {}) {
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
  // Further back, one night written twice; and folded into the back cover, the keeper's page about the horizon.
  return { ship, pages, old, recent, oldest, twoHands: spouse ? twoHandsLines({ seed, keeper, spouse }) : null, horizon: horizonPage({ keeper, light }) };
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

// ——— Lamp out ———
// One evening the beam does not come on: the keeper is down with a fever and
// the spouse is away in the post town doing the shopping. Nothing goes wrong
// if the courier is not there; if they are, they can climb and light it, and
// fetch fever powders from the town. Letters come the next post day from
// people along the coast who saw the dark, and from the keeper.

/** The courier must be this close to the tower, before the lamp would be lit, for the dark evening to fall. */
export const LAMP_OUT_REACH = 1500;
/** With nobody to light it, the spouse is home from the town and lights it late. */
export const SPOUSE_HOME_HOUR = 22;
/** How long E is held at the lamp to light it: a match, and the wick taking. */
export const LAMP_HOLD_SECONDS = 1.6;

/** The night a light belongs to: the evening's day, so the small hours count with the evening before. */
export function lampNight(day, hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  return (Number(day) || 0) - (h < KEEPER_DOWN_HOUR ? 1 : 0);
}

/**
 * Does tonight go dark? Once only, on an evening after the courier has seen
 * the lamp lit at least once (a light you have watched come on is a light you
 * notice failing), while they are near enough and the lamp is not yet lit.
 */
export function lampOutDue({ lampOut = null, seenLit = null, night, hour, near, keeperUp = false }) {
  if (lampOut || !Number.isFinite(seenLit) || !near || keeperUp || night <= seenLit) return false;
  const h = ((Number(hour) % 24) + 24) % 24;
  // From the late afternoon, before the keeper would have set off up the stair, until the lamp would be lit unseen.
  return h >= LAMP_OUT_FROM_HOUR && h < LAMP_UNSEEN_HOUR;
}
/** The fever shows from the late afternoon of the dark night. */
export const LAMP_OUT_FROM_HOUR = 15.5;

/**
 * Is the lamp lit on the dark night? Out from lamp-time until somebody lights
 * it: the courier (`litHour`), or the spouse home from the town at ten. Out
 * at sunrise as on any night.
 */
export function lampOutLit({ hour, litHour = null, homeHour = SPOUSE_HOME_HOUR }) {
  const h = ((Number(hour) % 24) + 24) % 24, phase = keeperPhase(h);
  if (phase !== 'lamp-time' && phase !== 'watch') return false;
  if (h < KEEPER_DOWN_HOUR) return true;
  return (Number.isFinite(litHour) && h >= litHour) || h >= Math.min(SPOUSE_HOME_HOUR, Number.isFinite(homeHour) ? homeHour : SPOUSE_HOME_HOUR);
}
/** How long the spouse takes to get home from the post town once the courier finds them there. */
export const SPOUSE_FETCH_HOURS = 0.75;

const KEEPER_FEVER = Object.freeze({
  dark: '{keeperFirst} is propped up in a chair by the stove, wrapped in a blanket, and shivering. “Fever. It came on at noon and I can’t stand for long, let alone climb. {spouseFirst} is in {town} with the shopping and won’t be back before ten. The lamp is dark.” A pause. “The matches are on the shelf beside the lamp. Hold the flame to the wick until it takes, and it will turn on its own. Will you?”',
  lit: '{keeperFirst} turns toward the window, where the beam sweeps the yard. “You lit it. I watched the light go round and I could have wept.” A cough. “If you are going back to {town}: {senderFirst} keeps fever powders, and {spouseFirst} will be at the market. Either one would do.”',
  late: '{keeperFirst} is still in the chair by the stove. “{spouseFirst} came home and climbed up with the lamp three hours late. Somebody on the coast will have noticed.”',
  fetched: '{keeperFirst} is still in the chair by the stove, with {spouseFirst} fussing over the kettle. “You found {spouseFirst} at the market and sent them running. They were up the stair before they had their coat off.”',
  better: '{keeperFirst} is up, pale and wrapped in a scarf. “The fever’s broken. I’ll be back up the stair tonight.”',
});
// A keeper who lives alone: nobody is in the town, and nobody comes home to climb.
const KEEPER_FEVER_ALONE = Object.freeze({
  dark: '{keeperFirst} is propped up in a chair by the stove, wrapped in a blanket, and shivering. “Fever. It came on at noon and I can’t stand for long, let alone climb, and there is nobody else here. The lamp is dark.” A pause. “The matches are on the shelf beside the lamp. Hold the flame to the wick until it takes, and it will turn on its own. Will you?”',
  lit: '{keeperFirst} turns toward the window, where the beam sweeps the yard. “You lit it. I watched the light go round and I could have wept.” A cough. “If you are going back to {town}: {senderFirst} keeps fever powders.”',
  late: '{keeperFirst} is still in the chair by the stove. “I got myself up the stair at ten, a step at a time, and lit it three hours late. Somebody on the coast will have noticed.”',
});

/** What the keeper says on the dark night (and the morning after), authored. */
export function keeperFeverLine({ stage, keeper, spouse, town, sender }) {
  const lines = spouse ? KEEPER_FEVER : { ...KEEPER_FEVER, ...KEEPER_FEVER_ALONE };
  const text = lines[stage] || lines.dark;
  return fill(text, { keeperFirst: firstName(keeper), spouseFirst: firstName(spouse) || 'My other half', town, senderFirst: firstName(sender) || 'the chandler' });
}

/** The note on the door on the dark night. */
export function lampOutDoorNote({ surname = 'the keeper' } = {}) {
  const family = surname === 'the keeper' ? 'The keeper' : 'The ' + surname + 's';
  return 'Keeper laid up with a fever. Please knock and come in. — ' + family;
}

/**
 * Fever powders from the post town, for the keeper: posted on the town's
 * board the evening the lamp goes dark, and never taken down until carried.
 */
export function feverPowdersDef({ id, day = 0, sender, keeper, spouse = null, town, light, lighthouseId, townId }) {
  const names = { town, light, keeper: keeper.name, keeperFirst: firstName(keeper.name), sender: sender.name, senderFirst: firstName(sender.name),
    alone: spouse?.name ? ' while ' + firstName(spouse.name) + ' is away' : ' with nobody else at home' };
  return {
    id, dynamic: true, standing: true, lampOut: true, kind: 'parcel', day,
    title: fill('Fever Powders for {keeperFirst}', names),
    description: fill('A twist of willow-bark fever powders from {sender} in {town}, for {keeper} at {light}, who is laid up{alone}. It can go in the box at the foot of the ramp if nobody answers.', names),
    thanks: fill('{keeperFirst} tips a powder into a cup of water and drinks it with a face. “Willow bark. Horrible, and it works. You walked six kilometres in the dark for this?”', names),
    sender: sender.id, recipient: keeper.id, senderPlace: townId, recipientPlace: lighthouseId,
  };
}

const COAST_LETTERS = Object.freeze({
  litByCourier: [
    '{short} was dark at dusk last night. I watched for it from {place} for an hour and more, and then it came on, late, and turned as if nothing had happened. They say down the lane it was the courier who lit it. If that is you, thank you. I sleep better with it going round.',
    'We noticed. Everyone on this side noticed: the light at {surname} did not come on with the dark. My father went out to the gate three times. Then it caught, and he came in and said nothing, which is how he says thank you. I am saying it for him.',
    'I keep the window toward the sea. Last night there was nothing in it until long after dusk, and I could not settle. When the flash came round at last I counted the turns out of habit, as I always have. All well. Whoever climbed, I hope the stair was kind.',
  ],
  litLate: [
    '{short} was dark from dusk until well into the evening last night. Nobody here has ever seen it miss. I am writing so that someone knows we noticed, in case it matters to whoever keeps it.',
    'Last night the light on the headland did not come on. We sat up. It came round at last, hours late, and my mother said a prayer I had not heard since I was small.',
    'I counted the hours it was dark last night from {place}. When it came back it turned as steady as it always has. I do not like a thing that always is, missing.',
  ],
});

/**
 * The letters that come for the courier the next post day, about the dark
 * night: one from each of the places that could see the light (up to three),
 * and one from the keeper. `watchers` are `{ name, place }`, people who live
 * where the beam is in sight. `lit` is 'courier' or 'late'; `powders` whether
 * the fever powders came.
 */
export function lampOutLetters({ seed = 0, night = 0, light = 'the lighthouse', keeper, spouse = null, watchers = [], lit = 'late', powders = false, fetched = false }) {
  const pool = COAST_LETTERS[lit === 'courier' ? 'litByCourier' : 'litLate'];
  const letters = watchers.slice(0, 3).map((watcher, i) => {
    const text = fill(pool[(storyHash(seed, 'coast-letter', night) + i) % pool.length], { place: watcher.place, light, short: lightShortName(light),
      surname: lightShortName(light).replace(/ Light$/, '') });
    return { id: 'lamp-out:' + night + ':' + i, title: 'A letter from ' + watcher.place, author: watcher.name,
      text: text + '\n— ' + watcher.name + ', ' + watcher.place };
  });
  const keeperFirst = firstName(keeper), spouseFirst = firstName(spouse);
  const thanks = lit === 'courier'
    ? 'You lit it. I have kept that lamp for nineteen years and never once seen it lit from below, by somebody else’s hand, with me sat watching from the window like a passenger.'
    : lit === 'fetched' && spouseFirst
      ? 'You found ' + spouseFirst + ' at the market and sent them home to me, and they climbed with the shopping still on their back. The light was late, but it was lit.'
    : 'You will have heard that the light was dark half the evening. ' + (spouseFirst ? spouseFirst + ' came home and climbed with the shopping still on their back.' : 'I got myself up the stair at ten, a step at a time.') + ' I am ashamed of it, though I could not have stood.';
  const after = powders ? ' The powders did their work, and I am back up the stair.'
    : fetched && spouseFirst ? ' ' + spouseFirst + ' sat up with me, the fever broke by morning, and I am back up the stair.'
    : ' The fever broke on its own in the night, and I am back up the stair.';
  letters.push({ id: 'lamp-out:' + night + ':keeper', title: 'A letter from ' + light, author: keeper,
    text: 'To the courier,\n' + thanks + after + ' Letters have been coming up the ramp all morning from people who saw the dark and wanted to say so. I did not know anyone was looking.\n— ' + keeper + (spouseFirst ? ', and ' + spouseFirst : '') });
  return letters;
}

/** "Firth Lighthouse" as the coast says it: "Firth Light". */
export function lightShortName(name = 'the lighthouse') {
  return /\sLighthouse$/.test(name) ? name.replace(/\sLighthouse$/, ' Light') : name;
}

// ——— Walking home by the beam ———
// The beam is a local guide: from the coast and the rises near the tower you
// can see the flash, from behind the hills you cannot. Residents who can see
// it give directions by it after dark, and road posts in sight of the tower
// carry an arm pointing at it.

/** The beam carries this far on a clear night before the land and the haze take it. */
export const BEAM_SIGHT_RANGE = 5500;

/**
 * Can the flash be seen from here? A straight line from eye height to the lamp
 * that the ground never rises through, within the beam's reach. `lamp` is the
 * lamp's world point; `heightAt(x, z)` is the terrain.
 */
export function beamVisibleFrom(point, lamp, heightAt, { eye = 1.7, range = BEAM_SIGHT_RANGE, step = 20 } = {}) {
  if (!point || !lamp || !Number.isFinite(point.x) || !Number.isFinite(point.z)) return false;
  const dx = lamp.x - point.x, dz = lamp.z - point.z, d = Math.hypot(dx, dz);
  if (d > range) return false;
  if (d < 60) return true;
  const y0 = (Number.isFinite(point.y) ? point.y : heightAt(point.x, point.z)) + eye;
  const n = Math.max(12, Math.ceil(d / step));
  // The last few metres are the tower's own headland: the lamp stands above it.
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (d * (1 - t) < 25) break;
    if (heightAt(point.x + dx * t, point.z + dz * t) > y0 + (lamp.y - y0) * t) return false;
  }
  return true;
}

/** Where the flash lies as you walk, from the angle between the way you go and the way to the light. */
export function beamSide(heading, toLight) {
  const len = v => Math.hypot(v.x, v.z) || 1;
  const fx = heading.x / len(heading), fz = heading.z / len(heading), lx = toLight.x / len(toLight), lz = toLight.z / len(toLight);
  const ahead = fx * lx + fz * lz;
  // +Z north and +X west (couriercontent.mjs): facing north, the right hand is east, -X.
  const right = -fz * lx + fx * lz;
  const angle = Math.acos(Math.max(-1, Math.min(1, ahead))) * 180 / Math.PI;
  if (angle > 140) return 'at your back';
  if (angle < 35) return 'straight ahead of you';
  if (angle >= 100) return right > 0 ? 'over your right shoulder' : 'over your left shoulder';
  return right > 0 ? 'on your right' : 'on your left';
}

/**
 * Directions home by the flash, as someone who can see it would give them
 * after a night delivery. `from` is where you stand, `lamp` the light, and
 * `toward` the first stretch of your way home (the road out), `home` its name.
 */
export function beamDirections({ from, lamp, toward, home = 'home', light = 'the lighthouse' }) {
  const heading = { x: toward.x - from.x, z: toward.z - from.z }, toLight = { x: lamp.x - from.x, z: lamp.z - from.z };
  const near = Math.hypot(toLight.x, toLight.z) < 250;
  const side = near ? 'at your back' : beamSide(heading, toLight);
  const flash = 'the flash of ' + light;
  return near
    ? 'Going back to ' + home + ' in the dark? Walk away from the tower with ' + flash + ' at your back until you strike the road, and the road posts will see you the rest of the way.'
    : 'Going back to ' + home + ' tonight? Keep ' + flash + ' ' + side + ' until you strike the road. Once the hills hide it, the road posts will see you home.';
}

/**
 * Road posts in sight of the tower carry one more arm, "Firth Light",
 * pointing straight at it. `posts` are the road's `{ x, z, arms }`; a post
 * already full, already pointing at the light, or out of sight is left alone.
 * Returns the posts that gained an arm.
 */
export function addBeamArms(posts, { lamp, name, heightAt, range = BEAM_SIGHT_RANGE, visible = null }) {
  const added = [];
  for (const post of posts) {
    if (!post?.arms || post.arms.length >= 4 || post.arms.some(arm => arm.beam)) continue;
    const sees = visible ? visible(post) : beamVisibleFrom(post, lamp, heightAt, { range, eye: 1.9 });
    if (!sees) continue;
    post.arms.push({ destination: name, toward: { x: lamp.x, z: lamp.z }, owner: post.arms[0]?.owner ?? null, beam: true });
    added.push(post);
  }
  return added;
}

// ——— A log in two hands ———
// Turning back the pages, one night is in the log twice: once in the
// keeper's hand, once in the spouse's, with different weather. Each says
// they sat that watch, and each will swear to it.

const ORDINALS = Object.freeze(['third', 'fifth', 'seventh', 'ninth', 'eleventh', 'twelfth', 'fourteenth', 'seventeenth', 'twentieth', 'twenty-second']);

/** The night written twice: chosen once from the story seed, before the courier came. */
export function twoHandsNight(seed = 0) {
  const date = ORDINALS[storyHash(seed, 'two-hands', 'date') % ORDINALS.length];
  const first = storyHash(seed, 'two-hands', 'weather') % WEATHER.length;
  const second = (first + 1 + storyHash(seed, 'two-hands', 'other') % (WEATHER.length - 1)) % WEATHER.length;
  const page = keeperLogNight(seed, 'two-hands');
  return { date, keeperWeather: WEATHER[first], spouseWeather: WEATHER[second], entries: page.entries };
}

/** The doubled page as the courier reads it. */
export function twoHandsLines({ seed = 0, keeper, spouse }) {
  const night = twoHandsNight(seed), ship = night.entries.find(entry => entry.repeating);
  return { night, lines: [
    'Turning back the pages, you find the night of the ' + night.date + ' written twice, one entry under the other.',
    'In ' + firstName(keeper) + '’s square hand: “' + night.keeperWeather + ' Kept the watch alone. ' + (ship ? 'The ' + ship.name + ' at ' + ship.time + '.' : '') + ' — ' + keeper + '”',
    'Beneath it, in ' + firstName(spouse) + '’s rounder hand: “' + night.spouseWeather + ' Sat the watch through; ' + firstName(keeper) + ' abed. ' + (ship ? 'The ' + ship.name + ' at ' + ship.time + '.' : '') + ' — ' + spouse + '”',
  ] };
}

// ——— The horizon doesn't move ———
// The keeper has noticed that from the step and from the gallery the
// horizon is the same distance off, and that the sea beyond a certain line
// never changes. They have written it down, and they are frightened of it.

/** The loose page in the back of the log. */
export function horizonPage({ keeper, light = 'the lighthouse' }) {
  return [
    'A loose page folded into the back of the log, in ' + firstName(keeper) + '’s hand, the writing smaller and more careful than the rest.',
    '“From the step of the house the horizon is a line across the sea. From the gallery, high over the yard, it is the same line at the same distance. It should be farther off the higher you climb. It is not.”',
    '“And beyond that line the sea does not change. I have watched it in every weather. The waves come in from it, but out there it is always the same grey, as if it were a painted board.”',
    '“I have not said this to anyone. I am writing it down so that it is somewhere other than in my head. I do not want to be the only one who knows.” — ' + keeper + ', ' + light,
  ];
}

/** The keeper's fair copy of that page, for the station archivist, who keeps such things. */
export function horizonLetterDef({ id, day = 0, keeper, archivist, light, lighthouseId, archivistPlace, archivistPlaceName }) {
  return {
    id, dynamic: true, standing: true, horizon: true, kind: 'letter', day,
    title: 'A Letter for the Archivist',
    description: 'A sealed letter from ' + keeper.name + ' at ' + light + ' for ' + archivist.name + ', the station archivist in ' + archivistPlaceName + ': a fair copy of the page about the horizon, “for whoever keeps the records of things that do not add up”.',
    sender: keeper.id, recipient: archivist.id, senderPlace: lighthouseId, recipientPlace: archivistPlace,
  };
}

/** What the archivist makes of the keeper's page, in their temperament. */
export const HORIZON_ARCHIVIST = Object.freeze({
  afraid: 'The archivist reads it standing up, and then sits down. “The same distance from the step and the gallery. I will file it. I will file it at the back, where I do not have to see the drawer.”',
  relieved: 'The archivist reads it twice and lets out a long breath. “Then it is not only the old papers that repeat. Someone out on the edge has seen it too. Tell the keeper it is kept, and kept carefully.”',
  denying: 'The archivist frowns at it. “Sea haze, and a tired keeper. A horizon cannot stay put.” But they put it in a folder of its own, and label it.',
  curious: 'The archivist reads it with a finger under each line. “The same distance however high you climb. That is not a mistake of the eye: that is a measurement. I want to go out there and stand on that gallery myself.”',
});

/** People's reactions when the courier reads them the keeper's page. */
export const HORIZON_REACTIONS = Object.freeze({
  afraid: 'Do not read me the rest. If the sky has an edge you can see from a tower, I do not want to live where I can see it.',
  relieved: 'The keeper is not mad, then, only the first to look. Someone ought to have looked long ago.',
  denying: 'Haze. Anyone who sits up all night staring at water will see the water staring back.',
  curious: 'Then the higher you go, the more you would expect to see, and you do not. I would like to climb that tower with a piece of string and a stone.',
});
