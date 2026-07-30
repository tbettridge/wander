import { landmarksAround } from './landmarks.js';

const LANDMARK_NAMES = Object.freeze({
  giant: 'the great tree',
  ring: 'the old stone ring',
  cairn: 'the high cairn',
  tower: 'the ruined watchtower',
  lighthouse: 'the lighthouse ruin',
});

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
}) {
  if (!world || !station) throw new TypeError('World and station are required.');
  const nearby = landmarksAround(
    world, station.x, station.z, world.seed, radius, [],
  ).map((landmark) => ({
    id: `landmark:${landmark.key}`,
    name: LANDMARK_NAMES[landmark.type] || `the ${landmark.type} landmark`,
    kind: landmark.type,
    distanceM: Math.round(Math.hypot(landmark.x - station.x, landmark.z - station.z)),
  })).sort((a, b) => a.distanceM - b.distanceM).slice(0, 4);

  const targets = [{
    id: station.id,
    name: station.name || `Station ${station.index + 1}`,
    kind: 'station',
    distanceM: Math.round(Math.hypot(player.x - station.x, player.z - station.z)),
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
    targets,
  };
}
