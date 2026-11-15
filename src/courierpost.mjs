// What the post itself is made of: the reason inside each letter, how the
// one who opens it takes it, the replies, the story's own papers carried as
// letters, the letter dropped on the road, and the things beside the road a
// courier can stop at. Pure and deterministic: the same story seed gives the
// same letters, the same roadside and the same view from the same hill.

import { courierCompass, courierWalkTime } from './couriercontent.mjs';
import { storyHash, storyPick } from './courierstory.mjs';

/** The morning post goes up at the morning bell; nothing new is posted after the sun is down. */
export const POST_OPENS_HOUR = 8;
/** Notices waiting for the courier, across every board. The satchel holds three, so there is choosing to do. */
export const POST_LIVE_CAP = 9;
export const SATCHEL_SLOTS = 3;

export function postOpen(hour, sunElevation) {
  return Number.isFinite(hour) && hour >= POST_OPENS_HOUR && !(Number.isFinite(sunElevation) && sunElevation <= 0);
}
/** How many notices a board puts up on a given post day: two or three. */
export function dailyPostCount(seed, siteId, day) { return 2 + storyHash(seed, 'post-count', siteId, day) % 2; }

/**
 * Why a letter was written. `gist` is what the courier can tell from the
 * outside; `reaction` is the recipient opening it; `reply`, when there is
 * one, is the answer they may ask the courier to carry back.
 */
export const LETTER_TOPICS = Object.freeze([
  { id: 'apology', gist: 'An apology, by the look of it: the name on the front was written twice and one try scratched out.',
    reaction: '{to} reads it twice. “{from} is sorry. After all this time.” They fold it small and keep it in their hand.',
    reply: { gist: 'An answer to an apology, sealed with a thumbprint of wax.',
      reaction: '{to} breaks the seal and lets out a long breath. “Forgiven, then. Good. I was tired of being right.”' } },
  { id: 'invitation', gist: 'An invitation: stiff card inside thin paper.',
    reaction: '{to} laughs as they read. “{from} wants me at their table on the feast day. I shall have to find a clean collar.”',
    reply: { gist: 'An acceptance, written in a hurry.',
      reaction: '“They are coming!” {to} counts on their fingers. “Then I need more chairs.”' } },
  { id: 'news', gist: 'News from home, several pages thick.',
    reaction: '{to} skims it on the doorstep. “A new calf, a leaking roof, and {from} has opinions about both.”',
    reply: { gist: 'News sent back the other way.',
      reaction: '{to} reads it standing up. “So that is how things are over there. Thank you for bringing it.”' } },
  { id: 'debt', gist: 'Something folded around coins: you can feel them through the paper.',
    reaction: '{to} tips the coins into their palm. “{from} has paid it back, to the penny. I had stopped expecting it.”', reply: null },
  { id: 'recipe', gist: 'A recipe, the paper spotted with grease.',
    reaction: '{to} reads it and smiles. “{from}’s barley bread. They swore they would never write it down.”',
    reply: { gist: 'Thanks for a recipe, and a confession.',
      reaction: '{to} reads it and snorts. “Burnt the first loaf. Of course they did.”' } },
  { id: 'gossip', gist: 'Gossip, by the way it is folded: small, tight and sealed twice.',
    reaction: '{to} reads it, glances up the lane and tucks it away. “You did not see me read that.”',
    reply: { gist: 'More gossip, sealed three times this time.',
      reaction: '{to} reads it and covers their mouth. “No. Not the miller. Well.”' } },
  { id: 'condolence', gist: 'A letter edged in black.',
    reaction: '{to} holds it a while before opening it. “{from} remembered. That is kind of them.”', reply: null },
]);
export const PARCEL_TOPICS = Object.freeze([
  { id: 'seeds', gist: 'Seed packets by the rattle, each one labelled in pencil.', reaction: '{to} shakes a packet by their ear. “{from} kept the good beans back for me. This year they will come up.”' },
  { id: 'mending', gist: 'Something soft: mending sent back, by the feel of it.', reaction: '{to} unwraps a darned coat. “{from} has done the elbows again. I shall wear it out a third time.”' },
  { id: 'tools', gist: 'Something heavy and narrow, wrapped in sacking.', reaction: '{to} unwraps a sharpened sickle. “{from} has put an edge on it you could shave with.”' },
  { id: 'gift', gist: 'A gift, tied with a bit of red wool.', reaction: '{to} turns it over twice before opening it. “From {from}? It is not even my birthday.”' },
]);
/** The story's own papers, carried as a letter. The seal would not be hard to lift. */
export const STORY_LETTER = Object.freeze({
  gist: '{from} asked you to carry it carefully. The seal is a plain blob of wax; it would not be hard to lift.',
  unopened: '{to} reads it, and the colour goes out of their face. They hold it out to you. “You had better see this. {from} has written down what I have been telling nobody.”',
  opened: {
    afraid: '{to} sees the lifted seal and goes still. “You read it. Then you know, and I cannot take it back.”',
    relieved: '“You opened it.” {to} almost smiles. “Good. I did not want to be the only one who had read it.”',
    denying: '{to} frowns at the seal. “A courier who reads the post. {from} writes nonsense, and now you have read nonsense.”',
    curious: '“You read it first? Then tell me: did it make sense to you? It does not to me.”',
  },
  read: 'You lift the seal with a thumbnail. It is from {from}, and it is not ordinary news.',
});

const first = name => String(name || '').split(' ')[0];
export const fill = (text, { from = '', to = '' } = {}) => String(text).replaceAll('{from}', first(from)).replaceAll('{to}', first(to));

/** The reason inside a commission, chosen by the story seed. */
export function letterTopic(seed, kind, id) {
  return kind === 'parcel' ? storyPick(PARCEL_TOPICS, seed, 'parcel-topic', id) : storyPick(LETTER_TOPICS, seed, 'letter-topic', id);
}
export function topicById(id) { return LETTER_TOPICS.find(topic => topic.id === id) || PARCEL_TOPICS.find(topic => topic.id === id) || null; }
/** About half the letters that can be answered are: the recipient asks the courier to carry it back. */
export function wantsReply(seed, jobId, topicId) {
  return !!topicById(topicId)?.reply && storyHash(seed, 'reply', jobId) % 2 === 0;
}

/**
 * The letter on the road. The front is blank; the clues inside are the
 * writer's first name, the place it was going, where in that place the house
 * stands, and the first letter of the name it opens with.
 */
export function droppedLetterClues({ sender, recipient, placeName, homeCompass }) {
  const initial = first(recipient).charAt(0).toUpperCase();
  return [
    'Nothing is written on the front, and the seal has come away in the wet.',
    'It begins “My dear ' + initial + '…” and is signed only “' + first(sender) + '”.',
    'It speaks of “the walk up from the well in ' + placeName + '” and of a house on the ' + homeCompass + ' side.',
  ];
}

const SHRINE_NAMES = ['the Lantern Saint', 'Our Lady of the Ford', 'Saint Brannoc of the roads', 'the Quiet Mother',
  'Saint Elwen, who walked', 'the Shepherd’s Saint', 'the Mother of Crossings', 'Saint Hild of the hill paths'];

/**
 * What stands beside one road between two places: a shrine about a third of
 * the way, a milestone at the middle, and a cairn on the highest ground near
 * the far third if it rises well above the road. `line` is the road as
 * points from `fromName` to `toName`; `groundAt(x, z)` is the land's height.
 */
export function waysideFor({ seed, key, line, fromName, toName, groundAt, isDry = () => true }) {
  if (!line || line.length < 4) return [];
  const lengths = [0];
  for (let i = 1; i < line.length; i++) lengths.push(lengths[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z));
  const total = lengths.at(-1);
  if (total < 600) return [];
  const at = fraction => {
    const target = total * fraction;
    let i = lengths.findIndex(value => value >= target); if (i < 1) i = 1;
    const a = line[i - 1], b = line[i], t = (target - lengths[i - 1]) / Math.max(1e-6, lengths[i] - lengths[i - 1]);
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    return { x: a.x + dx * t, z: a.z + dz * t, ux: dx / len, uz: dz / len };
  };
  const beside = (point, side) => ({ x: point.x - point.uz * side, z: point.z + point.ux * side });
  const out = [];
  const shrineAt = at(0.3 + (storyHash(seed, 'shrine-at', key) % 10) / 100);
  const shrine = beside(shrineAt, storyHash(seed, 'shrine-side', key) % 2 ? 3.2 : -3.2);
  if (isDry(shrine)) out.push({ id: 'shrine:' + key, kind: 'shrine', x: shrine.x, z: shrine.z, face: Math.atan2(shrineAt.ux, shrineAt.uz),
    name: 'Wayside shrine to ' + storyPick(SHRINE_NAMES, seed, 'shrine', key),
    text: 'A little roofed shrine on a post, to ' + storyPick(SHRINE_NAMES, seed, 'shrine', key) + '. Someone has left a sprig of heather, still fresh.' });
  const mileAt = at(0.5), mile = beside(mileAt, -2.4);
  if (isDry(mile)) {
    const back = total * 0.5, ahead = total * 0.5;
    out.push({ id: 'milestone:' + key, kind: 'milestone', x: mile.x, z: mile.z, face: Math.atan2(mileAt.ux, mileAt.uz),
      name: 'Milestone between ' + fromName + ' and ' + toName,
      text: 'An old milestone, the letters worn but cut deep: ' + fromName.toUpperCase() + ' ' + courierWalkTime(back) + ' one way, '
        + toName.toUpperCase() + ' ' + courierWalkTime(ahead) + ' the other.' });
  }
  // The cairn: highest ground within a few hundred metres of the far third of the road.
  const hillAt = at(0.68), road = groundAt(hillAt.x, hillAt.z);
  let top = null;
  for (let dx = -300; dx <= 300; dx += 30) for (let dz = -300; dz <= 300; dz += 30) {
    if (Math.hypot(dx, dz) > 300) continue;
    const x = hillAt.x + dx, z = hillAt.z + dz, y = groundAt(x, z);
    if (Number.isFinite(y) && (!top || y > top.y) && isDry({ x, z })) top = { x, z, y };
  }
  if (top && Number.isFinite(road) && top.y - road >= 22) out.push({ id: 'cairn:' + key, kind: 'cairn', x: top.x, z: top.z, y: top.y,
    name: 'Cairn above the ' + fromName + ' road', text: 'A cairn of piled stones on the hilltop. Walkers add one as they pass.' });
  return out;
}

/**
 * From a hilltop, which villages can be told apart: their chimney smoke if the
 * land between does not hide it, and their bell if it is near enough to hear.
 * `places` are `{ name, x, z, bell }`. Directions use the world's compass.
 */
export function sightedFrom(spot, places, groundAt, { smokeRange = 2600, bellRange = 2400, eye = 1.7, smokeHeight = 22 } = {}) {
  const from = { x: spot.x, z: spot.z, y: (Number.isFinite(spot.y) ? spot.y : groundAt(spot.x, spot.z)) + eye };
  const seen = [];
  for (const place of places) {
    const dx = place.x - from.x, dz = place.z - from.z, d = Math.hypot(dx, dz);
    if (d < 120 || d > Math.max(smokeRange, bellRange)) continue;
    const toY = groundAt(place.x, place.z) + smokeHeight;
    let clear = d <= smokeRange;
    for (let i = 1; clear && i < 48; i++) {
      const t = i / 48, x = from.x + dx * t, z = from.z + dz * t;
      if (groundAt(x, z) > from.y + (toY - from.y) * t) clear = false;
    }
    const bell = !!place.bell && d <= bellRange;
    if (clear || bell) seen.push({ name: place.name, compass: courierCompass(dx, dz), distance: Math.round(d), smoke: clear, bell });
  }
  return seen.sort((a, b) => a.distance - b.distance);
}
/** The cairn's view in words. */
export function sightedText(seen) {
  if (!seen.length) return 'Mist and moor in every direction. No smoke you can put a name to, and no bell.';
  return seen.map(item => (item.smoke ? 'Chimney smoke to the ' + item.compass + ': ' + item.name + (item.bell ? ', near enough that you would hear its bell' : '')
    : item.name + ' lies hidden to the ' + item.compass + ', but you would hear its bell from here')
    + ', ' + courierWalkTime(item.distance) + ' away.').join(' ');
}

/** What a resident remembers of the papers they were shown, and how a temperament wears. */
export const STORY_MEMORY = Object.freeze({
  again: '“Last time it was ‘{title}’. Now this.”',
  seen: '“You showed me ‘{title}’ before. It has not changed its mind.”',
  turned: {
    curious: '“Three. All right. Three is not carelessness, whatever I said before. Show me again, slowly.”',
    afraid: '“Three of them.” They have stopped arguing. “I do not want to see a fourth. I mean it.”',
  },
  avoids: 'They step back before you have it out. “No more. Please. I see you on the lane now and I go the other way.”',
});

/**
 * Nobody answers at the recipient's door. A neighbour, or a note on the door,
 * says where they have gone: the building they are in, the way they went, the
 * place they have gone over to, or nothing more than that they are out.
 */
export function whereaboutsLine({ name, neighbour = null, building = null, compass = null, elsewhere = null }) {
  const who = first(name);
  if (neighbour) {
    const where = building ? 'You will find them at ' + building + '.'
      : elsewhere ? 'They have gone over to ' + elsewhere + ' for the day.'
      : compass ? 'They went off to the ' + compass + ' of the house a while ago. They will not be long.'
      : 'They went out early and have not been back. Try again later.';
    return 'Nobody answers at ' + who + '’s door. ' + neighbour + ', from next door, calls over: “' + who + '? Not home. ' + where + '”';
  }
  const note = building ? 'At ' + building + '.' : elsewhere ? 'Gone over to ' + elsewhere + ' for the day.'
    : compass ? 'Out to the ' + compass + '. Back soon.' : 'Out. Back later.';
  return 'Nobody answers at ' + who + '’s door. A note is pinned to it: “' + note + '”';
}
export const DROPPED_THANKS = '{to} turns it over and laughs with relief. “{from}’s letter! I thought it had gone in the river. How ever did you know it was mine?”';
