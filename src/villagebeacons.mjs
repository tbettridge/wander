// Things that tell a walker a village is there before they can see it: the
// church bell on the hour and smoke from a few chimneys. Pure, so where they
// are and which chimneys are lit can be tested without a renderer; the bell
// is synthesised in audio.js and the smoke drawn by chimneysmoke.js.

/** How far a bell carries, in metres. */
export const BELL_RANGE = 2400;
/** How far off chimney smoke is drawn. */
export const SMOKE_RANGE = 2600;
/** Game hours a chimney stays lit before the village's lit chimneys change. */
export const SMOKE_SHIFT_HOURS = 2;
const SPEED_OF_SOUND = 343;
// A small pentatonic set, so neighbouring villages ring recognisably different bells.
// These are the bell's prime; its hum sounds an octave lower and its bright nominal an octave higher.
const BELL_NOTES = Object.freeze(['G3', 'A3', 'C4', 'D4', 'E4', 'G4']);

function hash(...parts) {
  let h = 2166136261;
  for (const ch of parts.join('|')) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13;
  return h >>> 0;
}

/** A point in a building's own frame, carried into the world (three.js Y rotation by yaw). */
export function buildingPoint(building, lx, ly, lz) {
  const c = Math.cos(building.yaw || 0), s = Math.sin(building.yaw || 0);
  const lift = (building.masses || []).find(item => item.role === 'core')?.baseY || 0;
  return { x: building.x + lx * c + lz * s, y: (building.y || 0) + lift + ly, z: building.z - lx * s + lz * c };
}

/** The belfry of each church in these plans: where the bell is heard from. */
export function churchBells(plans) {
  const bells = [];
  for (const plan of plans) for (const building of plan.buildings || []) {
    if (building.program !== 'church') continue;
    const tower = (building.masses || []).find(item => item.role === 'tower');
    const at = tower ? buildingPoint(building, tower.dx, tower.height * 0.86, tower.dz)
      : buildingPoint(building, 0, building.floorCount * building.floorHeight, 0);
    bells.push({ id: building.id, settlementId: plan.site.id, ...at, note: BELL_NOTES[hash(plan.site.id, 'bell') % BELL_NOTES.length], seed: hash(plan.site.id, 'cast') });
  }
  return bells;
}

/**
 * The top of every chimney in a plan, matching where settlementstream.js
 * builds them: a stack off-centre on a house's roof, and on a terrace a stack
 * at each unshared end and one on every other party wall.
 */
export function chimneyTops(plan) {
  const tops = [];
  for (const building of plan.buildings || []) {
    if (!building.style?.chimney) continue;
    const h = building.floorCount * building.floorHeight, w = building.width, d = building.depth;
    if (building.row) {
      const rise = building.row.rise || 0;
      if (building.row.right?.shared && building.row.index % 2 === 0) tops.push({ buildingId: building.id, ...buildingPoint(building, w / 2, h + rise + 0.95, 0) });
      for (const [end, side] of [[building.row.left, -1], [building.row.right, 1]]) {
        if (end && !end.shared) tops.push({ buildingId: building.id, ...buildingPoint(building, side * (w / 2 - 0.42), h + rise + 0.85, 0) });
      }
    } else tops.push({ buildingId: building.id, ...buildingPoint(building, w * 0.24, h + 2.3, -d * 0.12) });
  }
  return tops;
}

/**
 * Which chimneys are smoking in a settlement now: two or three, chosen from
 * the world seed, the settlement and the time of day, so every player sees
 * the same ones and they change through the day as fires are lit and let go.
 */
export function smokingChimneys(plan, worldSeed, gameHours) {
  const tops = chimneyTops(plan);
  if (!tops.length) return [];
  const shift = Math.floor(gameHours / SMOKE_SHIFT_HOURS);
  const count = Math.min(tops.length, 2 + (hash(worldSeed, plan.site.id, 'count', shift) % 2));
  // One stack per house: a terrace's end stacks are one household's fire.
  const byHouse = new Map();
  for (const top of tops) if (!byHouse.has(top.buildingId)) byHouse.set(top.buildingId, top);
  return [...byHouse.values()]
    .map(top => ({ top, rank: hash(worldSeed, plan.site.id, top.buildingId, shift) }))
    .sort((a, b) => a.rank - b.rank).slice(0, count).map(item => item.top);
}

/** Strikes for an hour, as a clock tower counts them: 1 to 12. */
export function bellStrikes(hour) {
  const h = ((Math.floor(hour) % 12) + 12) % 12;
  return h === 0 ? 12 : h;
}

/**
 * How a bell reaches the listener: loudness that falls away with distance,
 * a duller tone further off, how far left or right it sits relative to where
 * they face, and when it arrives (sound is not instant over two kilometres).
 * `facing` is the listener's horizontal forward vector.
 */
export function bellHeard(bell, listener, facing) {
  const dx = bell.x - listener.x, dz = bell.z - listener.z, d = Math.hypot(dx, dz);
  if (!(d < BELL_RANGE)) return null;
  const near = Math.min(1, 150 / Math.max(150, d));
  const reach = 1 - d / BELL_RANGE;
  const gain = Math.min(1, near * 0.55 + reach * reach * 0.45);
  const fl = Math.hypot(facing.x, facing.z) || 1, fx = facing.x / fl, fz = facing.z / fl;
  // The listener's right is forward turned clockwise seen from above (+Y up).
  const rightX = -fz, rightZ = fx;
  const pan = d > 1 ? Math.max(-1, Math.min(1, (dx * rightX + dz * rightZ) / d)) : 0;
  const behind = d > 1 ? (dx * fx + dz * fz) / d < -0.2 : false;
  return { distance: d, gain, pan, delay: d / SPEED_OF_SOUND,
    // Air takes the top off a distant bell; one behind the head is a little duller still.
    lowpass: Math.round(5200 * Math.pow(1 - d / BELL_RANGE, 1.4) + 650 - (behind ? 250 : 0)) };
}
