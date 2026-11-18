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
 * The keeper's day. Lamp-time is dusk, when the lamp is lit; the watch runs
 * the night; at dawn the lamp goes out and the log is written up; then the
 * keeper sleeps the morning away and is about the house in the afternoon.
 */
export function keeperPhase(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  if (h >= 18 && h < 21) return 'lamp-time';
  if (h >= 21 || h < 5) return 'watch';
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
