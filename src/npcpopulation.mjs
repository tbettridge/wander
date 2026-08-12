import { mulberry32 } from './noise.js';
import { chooseNpcWardrobe } from './npcwardrobe.mjs';

const TAU = Math.PI * 2;

export const NPC_FAMILIES = Object.freeze(['storybook', 'cloaked']);

const GIVEN_NAMES = Object.freeze([
  'Alder', 'Anwen', 'Bram', 'Cora', 'Della', 'Edda', 'Elian', 'Fern', 'Garran', 'Hollis',
  'Iona', 'Jory', 'Kit', 'Lina', 'Maren', 'Nell', 'Orin', 'Pippa', 'Quill', 'Rhea',
  'Rowan', 'Sable', 'Silas', 'Tamsin', 'Una', 'Vera', 'Wren', 'Yarrow', 'Zell', 'Zora',
]);

const FAMILY_NAMES = Object.freeze([
  'Bell', 'Briar', 'Brook', 'Cairn', 'Dale', 'Ember', 'Fallow', 'Finch',
  'Grove', 'Hearth', 'Moss', 'Reed', 'Rook', 'Thorne', 'Vale', 'Wick', 'Avery', 'Barton',
  'Cairn', 'Darrow', 'Firth', 'Grange', 'Harrow', 'Lark', 'Marlow', 'Pryce', 'Sutton', 'Weld',
]);

// How a given name is usually read, which is the only thing the appearance
// rules use it for. Kept as a lookup beside the name pools rather than folded
// into them, so the pools keep their exact contents and draw order: a resident
// generated before this existed still has the name they always had, and the
// narrative facts quoting them by name stay true.
//
// `unisex` is a real third answer with a populated middle, not a rounding
// error. Presentation is a continuous value and these only bias where in the
// range a person starts.
const FEMININE_NAMES = Object.freeze([
  'Ada', 'Anwen', 'Briony', 'Cora', 'Della', 'Edda', 'Elsi', 'Faye', 'Fern', 'Gwen',
  'Hester', 'Iona', 'Iris', 'Kara', 'Lina', 'Maud', 'Nell', 'Nessa', 'Pella', 'Pippa',
  'Rhea', 'Rosamund', 'Tamsin', 'Tilda', 'Una', 'Vera', 'Willa', 'Ysabel', 'Zora',
]);
const MASCULINE_NAMES = Object.freeze([
  'Albin', 'Alder', 'Bram', 'Cald', 'Dain', 'Eamon', 'Elian', 'Finn', 'Garran',
  'Hale', 'Idris', 'Jon', 'Lorne', 'Orin', 'Otho', 'Perrin', 'Silas', 'Ursin',
]);
const UNISEX_NAMES = Object.freeze([
  'Hollis', 'Jory', 'Kest', 'Kit', 'Maren', 'Quill', 'Rowan', 'Sable', 'Wren',
  'Yarrow', 'Zell',
]);

const NAME_READING = new Map([
  ...FEMININE_NAMES.map((name) => [name.toLowerCase(), 'feminine']),
  ...MASCULINE_NAMES.map((name) => [name.toLowerCase(), 'masculine']),
  ...UNISEX_NAMES.map((name) => [name.toLowerCase(), 'unisex']),
]);

// Where each reading starts and how far it may drift. The bands overlap
// deliberately at the edges: two people whose names read the same way are not
// built the same way, and an unfamiliar name is simply somewhere in the middle.
const PRESENTATION_BANDS = Object.freeze({
  masculine: Object.freeze([0.00, 0.30]),
  unisex: Object.freeze([0.28, 0.72]),
  feminine: Object.freeze([0.70, 1.00]),
});

export const NPC_AGE_BANDS = Object.freeze(['youth', 'adult', 'elder']);

const SKIN_TONES = Object.freeze([
  0x6f4635, 0x875943, 0xa66f52, 0xbe896b, 0xd0a184, 0xe1bda2,
]);

// Hair had no colour of its own: every style used the palette's `dark`, which
// is also the trousers and the boots. Changing an outfit changed the hair.
const HAIR_TONES = Object.freeze([
  0x1d1712, 0x2c211a, 0x4a3122, 0x6b4526, 0x8a5a2c, 0xa8763c, 0x5c4636, 0x35302c,
]);
const GREYING_HAIR_TONES = Object.freeze([
  0x6f6a64, 0x8a857e, 0xa9a49c, 0xc4bfb7, 0x574f47,
]);

// `warmth` groups these for garment mixing. A palette used to be worn whole,
// which meant the world had exactly six outfits; drawing each garment from its
// own palette turns the same six sets of authored colours into hundreds of
// combinations. Trousers are drawn from the shirt's own warmth group so the
// result still reads as clothes somebody chose rather than a jumble.
const PALETTES = Object.freeze([
  Object.freeze({ id: 'moss', warmth: 'cool', primary: 0x35594c, secondary: 0xb69059, accent: 0xd5c68b, dark: 0x172825 }),
  Object.freeze({ id: 'heather', warmth: 'cool', primary: 0x62536f, secondary: 0x9b6f72, accent: 0xd6b585, dark: 0x282330 }),
  Object.freeze({ id: 'ochre', warmth: 'warm', primary: 0x8a6334, secondary: 0x3f5a54, accent: 0xd7b867, dark: 0x28251d }),
  Object.freeze({ id: 'railway', warmth: 'cool', primary: 0x243d38, secondary: 0x7a4438, accent: 0xb99a53, dark: 0x171d1c }),
  Object.freeze({ id: 'coast', warmth: 'cool', primary: 0x456579, secondary: 0x9a7b5d, accent: 0xd6d4b0, dark: 0x1d2b34 }),
  Object.freeze({ id: 'berry', warmth: 'warm', primary: 0x71404f, secondary: 0x596b45, accent: 0xd0a275, dark: 0x2c1f25 }),
]);

// Slots are authored in the station's local frame. `along` follows the rails;
// `across` sits on either platform. All are clear of the station building and
// remain inside the platform bounds in railstation.mjs.
const STATION_SLOTS = Object.freeze([
  Object.freeze({ key: 'keeper', role: 'station keeper', family: 'cloaked', activity: 'attend', accessory: 'lantern', along: 4.0, across: 2.70 }),
  Object.freeze({ key: 'porter', role: 'railway porter', family: 'storybook', activity: 'pace', accessory: 'satchel', along: -10.5, across: 2.45 }),
  Object.freeze({ key: 'traveller', role: 'traveller', family: 'storybook', activity: 'wait', accessory: 'case', along: 15.0, across: 3.25 }),
  Object.freeze({ key: 'local', role: 'local resident', family: 'storybook', activity: 'pace', accessory: 'basket', along: -18.0, across: 3.05 }),
  Object.freeze({ key: 'rambler', role: 'rambler', family: 'storybook', activity: 'wait', accessory: 'staff', along: 8.0, across: -3.25 }),
  Object.freeze({ key: 'storyteller', role: 'wandering storyteller', family: 'cloaked', activity: 'gesture', accessory: 'book', along: -8.5, across: -3.20 }),
  Object.freeze({ key: 'vendor', role: 'platform vendor', family: 'storybook', activity: 'attend', accessory: 'basket', along: 20.0, across: 2.35 }),
]);

// Hair and hats used to share one slot, so a resident in a cap was bald under
// it and nobody could wear both. They are independent now.
export const NPC_HAIR_STYLES = Object.freeze(['crop', 'bob', 'bun', 'braid', 'long', 'none']);
export const NPC_HAT_STYLES = Object.freeze(['cap', 'brim', 'kerchief', 'hood', 'none']);
const MASK_STYLES = Object.freeze(['oval', 'leaf', 'angular']);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function choice(rng, values) {
  return values[Math.min(values.length - 1, Math.floor(rng() * values.length))];
}

function range(rng, min, max) {
  return min + (max - min) * rng();
}

export function stableNpcSeed(worldSeed, stationId, slotKey) {
  const text = `${worldSeed}|${stationId}|${slotKey}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function weightedChoice(rng, entries) {
  const total = entries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  if (total <= 0) return entries[0]?.[0];
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= Math.max(0, weight);
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

/**
 * How a name is usually read, as a number rather than a category.
 *
 * Nothing downstream branches on a label: every appearance rule takes this
 * value and leans, so two people whose names read the same way still differ,
 * and a name nobody has tagged lands in the middle instead of defaulting to
 * one end of the range.
 */
export function presentationForName(name, rng = () => 0.5) {
  const given = String(name || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  const [min, max] = PRESENTATION_BANDS[NAME_READING.get(given) || 'unisex'];
  return min + (max - min) * rng();
}

function roleHat(slot, family, rng, presentation) {
  if (family === 'cloaked') return 'hood';
  if (slot.key === 'keeper' || slot.key === 'porter') return 'cap';
  if (slot.key === 'rambler') return 'brim';
  // Most people are bare-headed. A kerchief leans with presentation; a cap and
  // a brim do not, because in this world they are working kit rather than dress.
  return weightedChoice(rng, [
    ['none', 2.2],
    ['cap', 0.9],
    ['brim', 0.7],
    ['kerchief', 0.3 + presentation * 0.8],
  ]);
}

function hairStyle(rng, presentation, hat) {
  // A hood covers the head entirely, so there is nothing to draw under it.
  if (hat === 'hood') return 'none';
  return weightedChoice(rng, [
    ['crop', 1.0 - presentation * 0.78],
    ['bob', 0.5 + presentation * 0.3],
    ['bun', 0.15 + presentation * 0.85],
    ['braid', 0.1 + presentation * 0.9],
    ['long', 0.1 + presentation * 0.9],
    ['none', 0.32 - presentation * 0.28],
  ]);
}

/**
 * The frame under the clothes.
 *
 * `build` widens shoulders and hips by the same multiplier, so the
 * shoulder-to-hip ratio was a constant for every person in the world — and
 * that ratio is the silhouette cue the eye reads first. These are bounded so
 * shoulders stay broader than hips at every value, which is true across the
 * range and is also what the anatomy invariants assert.
 */
function frameFor(presentation, rng) {
  const lean = (presentation - 0.5) * 2;             // -1 .. 1
  const jitter = (rng() - 0.5) * 0.06;
  return Object.freeze({
    shoulderScale: clamp(1 - lean * 0.07 + jitter, 0.93, 1.07),
    hipScale: clamp(1 + lean * 0.10 + jitter, 0.94, 1.10),
    waistScale: clamp(1 - lean * 0.05 + jitter, 0.94, 1.06),
  });
}

const AGE_EFFECT = Object.freeze({
  youth: Object.freeze({ height: 0.87, build: 0.90, headScale: 1.09, stoop: 0 }),
  adult: Object.freeze({ height: 1, build: 1, headScale: 1, stoop: 0 }),
  elder: Object.freeze({ height: 0.97, build: 1.02, headScale: 1, stoop: 0.07 }),
});

function normalizeAgeBand(value, rng) {
  if (NPC_AGE_BANDS.includes(value)) return value;
  return weightedChoice(rng, [['adult', 6], ['elder', 1.6], ['youth', 1.2]]);
}

/**
 * Build one resident's whole appearance from a stable seed.
 *
 * `givenName` and `ageBand` are optional inputs for callers that already know
 * them. A settlement resident is named by their household long before this
 * runs, and the body used to be drawn with no reference to that name at all —
 * which is how a Rosamund and a Bram ended up built identically.
 */
export function createNpcIdentity({
  worldSeed = 1, stationId, stationName = 'Station', slot,
  givenName = null, ageBand = null,
}) {
  if (!stationId || !slot?.key) throw new TypeError('A station ID and NPC slot are required.');
  const seed = stableNpcSeed(worldSeed, stationId, slot.key);
  const rng = mulberry32(seed);
  const family = slot.family || choice(rng, NPC_FAMILIES);

  // Each garment draws its own colour. The shirt leads, the trousers come from
  // a palette of the same warmth so the pair still agrees, and the accent is
  // free to be a note from anywhere.
  const shirtSource = slot.key === 'keeper' ? PALETTES[3] : choice(rng, PALETTES);
  const sameWarmth = PALETTES.filter((entry) => entry.warmth === shirtSource.warmth);
  const trouserSource = choice(rng, sameWarmth.length ? sameWarmth : PALETTES);
  const accentSource = choice(rng, PALETTES);

  const given = givenName || choice(rng, GIVEN_NAMES);
  const surname = choice(rng, FAMILY_NAMES);
  const presentation = presentationForName(given, rng);
  const age = normalizeAgeBand(ageBand, rng);
  const ageEffect = AGE_EFFECT[age];

  const palette = Object.freeze({
    id: shirtSource.id,
    primary: shirtSource.primary,
    secondary: trouserSource.secondary,
    accent: accentSource.accent,
    dark: trouserSource.dark,
    skin: choice(rng, SKIN_TONES),
    hair: choice(rng, age === 'elder' ? GREYING_HAIR_TONES : HAIR_TONES),
  });

  const height = range(rng, 0.90, 1.10) * ageEffect.height;
  const build = range(rng, 0.86, 1.14) * ageEffect.build;
  const headScale = range(rng, 0.91, 1.10) * ageEffect.headScale;
  const legScale = range(rng, 0.90, 1.08);
  const frame = frameFor(presentation, rng);
  const phase = rng() * TAU;
  const paceDistance = slot.activity === 'pace' ? range(rng, 1.4, 2.7) : 0;
  const hat = roleHat(slot, family, rng, presentation);

  return Object.freeze({
    id: `npc:${stationId}:${slot.key}`,
    seed,
    name: `${given} ${surname}`,
    role: slot.role,
    stationId,
    stationName,
    family,
    activity: slot.activity,
    accessory: slot.accessory,
    interactive: true,
    presentation,
    age,
    palette,
    proportions: Object.freeze({
      height, build, headScale, legScale,
      shoulderScale: frame.shoulderScale,
      hipScale: frame.hipScale,
      waistScale: frame.waistScale,
    }),
    posture: Object.freeze({ stoop: ageEffect.stoop }),
    appearance: Object.freeze({
      hat,
      hair: hairStyle(rng, presentation, hat),
      mask: family === 'cloaked' ? choice(rng, MASK_STYLES) : 'none',
      scarf: family === 'storybook' && rng() < 0.38,
      freckles: family === 'storybook' && rng() < 0.26,
    }),
    animation: Object.freeze({
      phase,
      period: range(rng, 6.8, 11.5),
      energy: range(rng, 0.72, 1.18),
      paceDistance,
      gestureHand: rng() < 0.5 ? 'left' : 'right',
    }),
    // Last, deliberately. Object literal properties evaluate in source order,
    // so drawing the wardrobe here leaves every draw above it untouched and a
    // resident keeps the name, colouring and build they already had.
    wardrobe: chooseNpcWardrobe({ role: slot.role, presentation, family, age, rng }),
  });
}

/**
 * Roughly how old a household member is, from the shape of the household.
 *
 * A household already records what kind it is and who belongs to it, which is
 * enough to tell a couple from their children without inventing a birth date.
 * Partners and siblings are the adults of the house; anyone past the first two
 * is a child of it. A lone occupant is the one who might be elderly.
 */
export function householdAgeBand(form, memberIndex, memberCount = 1, salt = '') {
  const index = Number.isInteger(memberIndex) ? memberIndex : 0;
  if ((form === 'partners' || form === 'siblings') && index >= 2) return 'youth';
  if (form === 'single' || memberCount <= 1) {
    // Deterministic from the person, not the draw order, so a household gaining
    // a lodger cannot age the occupant who was already there.
    const rng = mulberry32(stableNpcSeed(0, String(salt || 'resident'), 'age'));
    return rng() < 0.34 ? 'elder' : 'adult';
  }
  return 'adult';
}

export function createStationPopulation(station, worldSeed = 1, { count = 6 } = {}) {
  if (!station?.id) throw new TypeError('A station with a stable ID is required.');
  const size = clamp(Math.round(count), 3, STATION_SLOTS.length);
  return Object.freeze(STATION_SLOTS.slice(0, size).map((slot) => {
    const identity = createNpcIdentity({
      worldSeed,
      stationId: station.id,
      stationName: station.name || `Station ${(station.index ?? 0) + 1}`,
      slot,
    });
    const jitter = mulberry32(identity.seed ^ 0x9e3779b9);
    return Object.freeze({
      id: identity.id,
      identity,
      slot: slot.key,
      along: slot.along + range(jitter, -0.45, 0.45),
      across: slot.across + range(jitter, -0.08, 0.08),
    });
  }));
}

export function planNpcPopulation(stations, worldSeed = 1, options = {}) {
  return Object.freeze((stations || []).flatMap(
    (station) => createStationPopulation(station, worldSeed, options),
  ));
}

// A loopable, dependency-free pose used by the Three.js renderer. Returning
// absolute offsets instead of accumulating transforms prevents animation drift.
export function npcHipHeight(legScale = 1) {
  return 0.72 * legScale + 0.075;
}

export function sampleNpcMotion(identity, elapsed, {
  talking = false,
  gestureElapsed = elapsed,
} = {}, out = {}) {
  const animation = identity.animation;
  const phase = ((elapsed / animation.period) * TAU + animation.phase) % TAU;
  const gesturePhase = ((gestureElapsed / animation.period) * TAU + animation.phase) % TAU;
  const pace = animation.paceDistance > 0;
  const pathOffset = pace ? Math.sin(phase) * animation.paceDistance : 0;
  const pathVelocity = pace ? Math.cos(phase) : 0;
  const locomotion = pace && !talking ? Math.min(1, Math.abs(pathVelocity) * 1.35) : 0;
  const step = phase * 4;
  const energy = animation.energy;
  const cloak = identity.family === 'cloaked' ? 0.42 : 1;
  const talkPulse = talking ? Math.sin(gesturePhase * 2) : 0;

  out.phase = phase;
  out.pathOffset = pathOffset;
  out.facingSign = pathVelocity < 0 ? -1 : 1;
  out.locomotion = locomotion;
  out.rootBob = Math.abs(Math.sin(step)) * 0.026 * locomotion * energy
    + Math.sin(gesturePhase) * 0.006;
  out.bodyLean = locomotion * 0.035 + (talking ? -0.025 : 0);
  out.bodySway = Math.sin(gesturePhase) * 0.025 * energy;
  out.headYaw = talking ? Math.sin(gesturePhase * 0.5) * 0.06 : Math.sin(gesturePhase) * 0.12;
  out.headTilt = Math.sin(gesturePhase * 0.7) * 0.035;
  out.leftArm = Math.sin(step) * 0.36 * locomotion * energy * cloak
    + (talking && animation.gestureHand === 'left' ? -0.38 + talkPulse * 0.12 : 0);
  out.rightArm = -Math.sin(step) * 0.36 * locomotion * energy * cloak
    + (talking && animation.gestureHand === 'right' ? -0.38 + talkPulse * 0.12 : 0);
  out.leftArmOut = talking && animation.gestureHand === 'left' ? 0.26 + talkPulse * 0.08 : 0.02;
  out.rightArmOut = talking && animation.gestureHand === 'right' ? -0.26 - talkPulse * 0.08 : -0.02;
  out.leftLeg = -Math.sin(step) * 0.42 * locomotion * energy * cloak;
  out.rightLeg = Math.sin(step) * 0.42 * locomotion * energy * cloak;
  return out;
}

export const NPC_STATION_SLOTS = STATION_SLOTS;
