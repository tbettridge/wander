import { mulberry32 } from './noise.js';

const TAU = Math.PI * 2;

export const NPC_FAMILIES = Object.freeze(['storybook', 'cloaked']);

const GIVEN_NAMES = Object.freeze([
  'Alder', 'Anwen', 'Bram', 'Cora', 'Edda', 'Elian', 'Fern', 'Hollis',
  'Iona', 'Jory', 'Kit', 'Lina', 'Maren', 'Nell', 'Orin', 'Pippa',
  'Quill', 'Rowan', 'Sable', 'Tamsin', 'Una', 'Wren', 'Yarrow', 'Zell',
]);

const FAMILY_NAMES = Object.freeze([
  'Bell', 'Briar', 'Brook', 'Cairn', 'Dale', 'Ember', 'Fallow', 'Finch',
  'Grove', 'Hearth', 'Moss', 'Reed', 'Rook', 'Thorne', 'Vale', 'Wick',
]);

const SKIN_TONES = Object.freeze([
  0x6f4635, 0x875943, 0xa66f52, 0xbe896b, 0xd0a184, 0xe1bda2,
]);

const PALETTES = Object.freeze([
  Object.freeze({ id: 'moss', primary: 0x35594c, secondary: 0xb69059, accent: 0xd5c68b, dark: 0x172825 }),
  Object.freeze({ id: 'heather', primary: 0x62536f, secondary: 0x9b6f72, accent: 0xd6b585, dark: 0x282330 }),
  Object.freeze({ id: 'ochre', primary: 0x8a6334, secondary: 0x3f5a54, accent: 0xd7b867, dark: 0x28251d }),
  Object.freeze({ id: 'railway', primary: 0x243d38, secondary: 0x7a4438, accent: 0xb99a53, dark: 0x171d1c }),
  Object.freeze({ id: 'coast', primary: 0x456579, secondary: 0x9a7b5d, accent: 0xd6d4b0, dark: 0x1d2b34 }),
  Object.freeze({ id: 'berry', primary: 0x71404f, secondary: 0x596b45, accent: 0xd0a275, dark: 0x2c1f25 }),
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

const STORYBOOK_HEADWEAR = Object.freeze(['cap', 'brim', 'bob', 'bun', 'crop', 'none']);
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

function roleHeadwear(slot, family, rng) {
  if (family === 'cloaked') return 'hood';
  if (slot.key === 'keeper' || slot.key === 'porter') return 'cap';
  if (slot.key === 'rambler') return 'brim';
  return choice(rng, STORYBOOK_HEADWEAR);
}

export function createNpcIdentity({ worldSeed = 1, stationId, stationName = 'Station', slot }) {
  if (!stationId || !slot?.key) throw new TypeError('A station ID and NPC slot are required.');
  const seed = stableNpcSeed(worldSeed, stationId, slot.key);
  const rng = mulberry32(seed);
  const family = slot.family || choice(rng, NPC_FAMILIES);
  const paletteSource = slot.key === 'keeper' ? PALETTES[3] : choice(rng, PALETTES);
  const palette = Object.freeze({
    id: paletteSource.id,
    primary: paletteSource.primary,
    secondary: paletteSource.secondary,
    accent: paletteSource.accent,
    dark: paletteSource.dark,
    skin: choice(rng, SKIN_TONES),
  });
  const given = choice(rng, GIVEN_NAMES);
  const surname = choice(rng, FAMILY_NAMES);
  const height = range(rng, 0.90, 1.10);
  const build = range(rng, 0.86, 1.14);
  const headScale = range(rng, 0.91, 1.10);
  const legScale = range(rng, 0.90, 1.08);
  const phase = rng() * TAU;
  const paceDistance = slot.activity === 'pace' ? range(rng, 1.4, 2.7) : 0;

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
    palette,
    proportions: Object.freeze({ height, build, headScale, legScale }),
    appearance: Object.freeze({
      headwear: roleHeadwear(slot, family, rng),
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
  });
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
