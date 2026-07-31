import { landmarksAround } from './landmarks.js';

const LANDMARK_NAMES = Object.freeze({
  giant: 'the great tree',
  ring: 'the old stone ring',
  cairn: 'the high cairn',
  tower: 'the ruined watchtower',
  lighthouse: 'the lighthouse ruin',
});

// +Z is north. Bearings are measured the same way headings are, so a bearing
// can be handed straight to a resident as the direction to turn and point.
const COMPASS = Object.freeze([
  'north', 'north-east', 'east', 'south-east',
  'south', 'south-west', 'west', 'north-west',
]);

const NUMBER_WORDS = Object.freeze([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
]);

function numberWord(value) {
  return NUMBER_WORDS[value] || String(value);
}

export function bearingBetween(fromX, fromZ, toX, toZ) {
  return Math.atan2(toX - fromX, toZ - fromZ);
}

export function compassFromBearing(bearing = 0) {
  const degrees = (((bearing * 180) / Math.PI) % 360 + 360) % 360;
  return COMPASS[Math.round(degrees / 45) % 8];
}

/**
 * How somebody standing on a platform would actually say a distance.
 *
 * Nobody says "two thousand seven hundred and forty metres". They round hard —
 * to the nearest hundred paces up close, the nearest half kilometre further
 * out, the nearest kilometre beyond that — and say "about". The rounding is the
 * point: an exact figure from a character leaning on a fence reads as a
 * readout, not a person.
 */
export function describeDistance(metres) {
  const m = Math.max(0, Math.round(Number.isFinite(metres) ? metres : 0));
  if (m < 80) return 'just over there';
  if (m < 950) return `about ${numberWord(Math.max(1, Math.round(m / 100)))} hundred metres`;
  const km = m / 1000;
  if (km < 10) {
    const halves = Math.max(2, Math.round(km * 2)) / 2;
    const whole = Math.floor(halves);
    const unit = halves === 1 ? 'kilometre' : 'kilometres';
    return halves - whole >= 0.5
      ? `about ${numberWord(whole)} and a half ${unit}`
      : `about ${numberWord(whole)} ${unit}`;
  }
  return `about ${Math.round(km)} kilometres`;
}

/**
 * The place a line of dialogue is talking about, if any.
 *
 * Text matching, deliberately: the on-device model returns prose, and asking it
 * for a machine-readable marker alongside the prose is a reliability problem
 * traded for a parsing one. The longest name wins so "the great tree" is not
 * beaten by a shorter name inside it.
 */
export function findMentionedTarget(targets, text) {
  if (!targets?.length || !text) return null;
  const haystack = String(text).toLowerCase();
  let best = null;
  for (const target of targets) {
    const name = String(target?.name || '').toLowerCase();
    if (!name) continue;
    const bare = name.replace(/^the\s+/, '');
    if (!bare || !haystack.includes(bare)) continue;
    if (!best || bare.length > best.bare.length) best = { target, bare };
  }
  return best?.target || null;
}

export function timeOfDayLabel(time = 0) {
  const hour = ((time % 1) + 1) % 1 * 24;
  if (hour < 5) return 'before dawn';
  if (hour < 8) return 'at dawn';
  if (hour < 12) return 'this morning';
  if (hour < 17) return 'this afternoon';
  if (hour < 21) return 'this evening';
  return 'tonight';
}

export function buildStationDialogueContext({
  world,
  station,
  player,
  sky,
  weather,
  npc = null,
  encounterCount = 0,
  radius = 1800,
  // Where the speaker is standing. Distances and bearings are measured from
  // here, not from the station: the resident is the one being asked, the one
  // who answers, and the one who turns to point, so the numbers have to be
  // theirs. It falls back to the station for callers that have no body.
  origin = null,
}) {
  if (!world || !station) throw new TypeError('World and station are required.');
  const from = origin || station;
  const describe = (x, z) => {
    const distanceM = Math.round(Math.hypot(x - from.x, z - from.z));
    const bearing = bearingBetween(from.x, from.z, x, z);
    return {
      distanceM,
      bearing,
      // Enough for a resident to turn and point at the real thing.
      worldX: x,
      worldZ: z,
      distancePhrase: describeDistance(distanceM),
      direction: compassFromBearing(bearing),
    };
  };
  const nearby = landmarksAround(
    world, station.x, station.z, world.seed, radius, [],
  ).map((landmark) => ({
    id: `landmark:${landmark.key}`,
    name: LANDMARK_NAMES[landmark.type] || `the ${landmark.type} landmark`,
    kind: landmark.type,
    ...describe(landmark.x, landmark.z),
  })).sort((a, b) => a.distanceM - b.distanceM).slice(0, 4);

  const targets = [{
    id: station.id,
    name: station.name || `Station ${station.index + 1}`,
    kind: 'station',
    ...describe(station.x, station.z),
  }, ...nearby];
  const biome = world.biomeAt(player.x, player.z);
  const encounterBand = encounterCount === 0 ? 'new'
    : encounterCount < 3 ? 'familiar' : 'returning';

  return {
    npc: npc ? {
      id: npc.id,
      name: npc.name,
      role: npc.role,
      family: npc.family,
    } : {
      id: `station-keeper:${station.id}`,
      name: `${station.name || 'the station'} keeper`,
      role: 'station keeper',
      family: 'cloaked',
    },
    station: { id: station.id, name: station.name || `Station ${station.index + 1}` },
    biome: biome.id || station.biome || 'unknown country',
    weather: weather?.current?.archetype || 'changeable weather',
    timeOfDay: weather?.current?.solarPhase || timeOfDayLabel(sky?.time || 0),
    playerHistory: encounterCount > 0
      ? `The traveller has spoken with you ${encounterCount} time${encounterCount === 1 ? '' : 's'} before.`
      : 'This is the traveller\'s first conversation with you.',
    encounterBand,
    // Every target is measured from the speaker, so `targets[].distanceM` is no
    // longer how far the traveller is from the station. That is still worth
    // knowing, so it keeps its own field.
    travellerDistanceM: Math.round(Math.hypot(player.x - station.x, player.z - station.z)),
    targets,
  };
}
