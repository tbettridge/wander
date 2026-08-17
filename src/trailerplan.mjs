export const TRAILER_CAPTURE_VERSION = 1;

export const TRAILER_SHOTS = Object.freeze([
  { id: '01_mountain_reveal', duration: 10, scene: 'mountain', qualityLevel: 4 },
  { id: '02_trail_walk', duration: 6, scene: 'trail' },
  { id: '03a_env_taiga', duration: 2, scene: 'taiga' },
  { id: '03b_env_desert', duration: 2, scene: 'desert' },
  { id: '03c_env_jungle', duration: 2, scene: 'jungle' },
  { id: '03d_env_coast', duration: 2, scene: 'coast' },
  { id: '04a_crossing_stones', duration: 1, scene: 'stepping' },
  {
    id: '04b_plank_bridge_zoom', duration: 4, scene: 'bridge-zoom',
    qualityLevel: 4, travelMeters: 28,
  },
  { id: '05_wildlife', duration: 5, scene: 'wildlife' },
  { id: '06_village', duration: 7, scene: 'village' },
  { id: '07_village_life', duration: 7, scene: 'village-life' },
  { id: '08_npc_journey', duration: 8, scene: 'npc-journey' },
  { id: '09_npc_memory', duration: 5, scene: 'npc-memory' },
  { id: '10_market', duration: 10, scene: 'market' },
  { id: '11_player_train', duration: 5, scene: 'player-train', qualityLevel: 2 },
  { id: '12_cave_exit', duration: 7, scene: 'cave-exit', qualityLevel: 3 },
  { id: '12b_great_tree', duration: 3, scene: 'great-tree' },
]);

export const TRAILER_TIMELINE = Object.freeze({
  // The title is composited over the opening vista instead of occupying a
  // separate black card, so the landscape is visible from the first frame.
  titleDuration: 4,
  footageDuration: TRAILER_SHOTS.reduce((sum, shot) => sum + shot.duration, 0),
  endDuration: 6,
  totalDuration: 92,
});

export function validateTrailerPlan(shots = TRAILER_SHOTS) {
  if (!Array.isArray(shots) || !shots.length) throw new TypeError('Trailer plan requires shots.');
  const ids = new Set();
  for (const shot of shots) {
    if (!/^[a-z0-9][a-z0-9_-]+$/.test(shot.id) || ids.has(shot.id)) {
      throw new TypeError(`Invalid or repeated trailer shot id: ${shot.id}`);
    }
    if (!(shot.duration > 0) || !Number.isFinite(shot.duration)) {
      throw new TypeError(`Invalid trailer shot duration: ${shot.id}`);
    }
    ids.add(shot.id);
  }
  const footage = shots.reduce((sum, shot) => sum + shot.duration, 0);
  const total = footage + TRAILER_TIMELINE.endDuration;
  if (Math.abs(total - TRAILER_TIMELINE.totalDuration) > 1e-6) {
    throw new Error(`Trailer timeline is ${total}s, expected ${TRAILER_TIMELINE.totalDuration}s.`);
  }
  return true;
}
