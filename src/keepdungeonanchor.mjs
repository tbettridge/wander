// Where a keep's way down goes, and how the cave runtime is told about it.
//
// The rule that shapes all of this: a door into a bank has to be in a bank. The
// cave entrance machinery folds terrain around a mouth and needs real ground
// rising behind it, so the undercroft cannot be a hatch in a flat courtyard —
// it has to stand where the hill actually keeps going up.
//
// So the terrain is asked first, before a single stone is cut. Candidates all
// round the bailey are scored for how much hill lies behind them, the best one
// becomes the door's place, and the plan authors its masonry there. What the
// player walks up to and what the cave runtime carves are then the same opening
// by construction rather than by coincidence.

import { scoreCaveEntrance } from './cavegen.mjs';

// Where in the bailey to look. Bearing alone is not enough: on a crown the
// ground barely moves near the drum and only starts to rise where the bailey
// meets the rampart, so the far ring is where most doors end up — cut into the
// bank under the wall, which is where an undercroft belongs anyway.
const PROBE_RADII = Object.freeze([8, 10.5, 13, 15.5]);
const PROBE_BEARINGS = 24;
// How far the sill drops below the bailey.
//
// Barely at all, on purpose. A natural cave mouth is sunk well into its slope so
// the hillside hides the throat, but doing that here put the whole door — arch,
// jambs and retaining wall — under the grass line: from six paces away there was
// nothing to see but a dip. An undercroft door is meant to be found, so it
// stands against the bank at very nearly the height you walk up to it, and the
// floor falls away behind it instead of in front. The cave runtime is handed the
// same number as its entrance inset, so its threshold meets the masonry sill.
export const UNDERCROFT_SILL_DROP = 0.5;
// Below this there is not enough hill behind the door to bury a passage in, and
// the site gets a choked, collapsed undercroft instead of a working one.
//
// Far lower than the natural-cave threshold on purpose. A wild mouth needs the
// hillside to do all the work of hiding its throat; an undercroft's first few
// metres are the keep's own vault — a retaining wall holding the bank back, an
// arch, and a sill sunk below the bailey — so it only needs the ground to keep
// rising, not to already be a cliff.
const MIN_COVER_RISE = 0.45;

const probeCache = new Map();

function localToWorld(entry, localX, localZ) {
  const c = Math.cos(entry.yaw), s = Math.sin(entry.yaw);
  return { x: entry.x + localX * c + localZ * s, z: entry.z - localX * s + localZ * c };
}

/**
 * Where in the bailey the ground keeps rising, and how much.
 *
 * Probed once per site and remembered, so the place the plan builds its door
 * and the place the cave runtime carves its mouth can never disagree.
 *
 * Deliberately does NOT use the terrain's own gradient direction. An undercroft
 * door has one job — face the courtyard, so you can see it from the gate and
 * walk straight at it — which fixes its facing to the outward radial from the
 * site centre. So cover is measured along that same radial: the question is not
 * "which way does this hillside fall" but "if the door stands here, facing in,
 * is there hill behind it". Letting the gradient answer instead produced doors
 * facing out through the curtain wall.
 */
function probeSite(world, entry) {
  const key = `${world.seed >>> 0}:${entry.key}`;
  const hit = probeCache.get(key);
  if (hit) return hit;
  const yaw = entry.yaw;
  // A local bearing θ points along world (cos(θ − yaw), sin(θ − yaw)).
  const worldDir = (bearing) => ({
    x: Math.cos(bearing - yaw), z: Math.sin(bearing - yaw),
  });
  let best = null;
  for (const radius of PROBE_RADII) {
    for (let index = 0; index < PROBE_BEARINGS; index++) {
      const bearing = index / PROBE_BEARINGS * Math.PI * 2;
      const point = localToWorld(entry, Math.cos(bearing) * radius, Math.sin(bearing) * radius);
      const here = world.height(point.x, point.z);
      const direction = worldDir(bearing);
      // Progressive overburden, not one lucky sample far inland: the passage
      // has to stay buried the whole way, not dive under a ridge and out again.
      let cover = Infinity;
      for (const distance of [14, 24, 34]) {
        cover = Math.min(cover,
          world.height(point.x + direction.x * distance, point.z + direction.z * distance) - here);
      }
      if (!best || cover > best.cover) best = { cover, bearing, radius, point, direction, here };
    }
  }
  const result = {
    ...best,
    reach: best.radius,
    // The door faces back down the radial, into the courtyard.
    facing: best.bearing,
    viable: best.cover >= MIN_COVER_RISE,
  };
  if (probeCache.size >= 256) probeCache.delete(probeCache.keys().next().value);
  probeCache.set(key, result);
  return result;
}

/** Where a keep's undercroft door should be cut, in the plan's local terms. */
export function undercroftSitingFor(world, entry) {
  const probe = probeSite(world, entry);
  return { bearing: probe.bearing, facing: probe.facing, reach: probe.reach };
}

/** Whether the hill behind this site can actually hold a passage. */
export function undercroftIsViable(world, entry) {
  return probeSite(world, entry).viable;
}

/**
 * A CaveExperiment anchor for a keep's undercroft, or null when the hill will
 * not take one. Shaped exactly like the ones caveAnchorForCell produces, plus
 * two fields the cave runtime reads only from dungeons: an explicit entrance
 * inset so the threshold meets the masonry sill, and the dungeon mode that
 * swaps stalactites for masonry.
 */
export function keepUndercroftAnchor(world, entry, plan) {
  const undercroft = plan?.intact?.undercroft;
  if (!undercroft) return null;
  const probe = probeSite(world, entry);
  if (!probe.viable) return null;
  // Scored where the masonry actually is, not where the ring was sampled: the
  // plan may have nudged the door around to keep the bailey's route clear.
  const door = localToWorld(entry, undercroft.x, undercroft.z);
  const direction = {
    x: Math.cos(undercroft.facing - entry.yaw),
    z: Math.sin(undercroft.facing - entry.yaw),
  };
  const here = world.height(door.x, door.z);
  let cover = Infinity;
  for (const distance of [14, 24, 34]) {
    cover = Math.min(cover,
      world.height(door.x + direction.x * distance, door.z + direction.z * distance) - here);
  }
  if (cover < MIN_COVER_RISE) return null;
  // Everything the cave runtime reads about a mouth, answered by the door
  // rather than by the hillside, so the passage runs the way the arch points.
  const scored = scoreCaveEntrance(world, door.x, door.z, entry.outpostSeed >>> 0);
  return {
    ...scored,
    id: `dungeon:${entry.key}`,
    key: `dungeon_${entry.key}`,
    cellX: 0, cellZ: 0,
    x: door.x, z: door.z,
    surfaceY: here,
    yaw: Math.atan2(direction.x, direction.z),
    inwardX: direction.x, inwardZ: direction.z,
    coverRise: cover,
    seed: entry.outpostSeed >>> 0,
    kind: 'dungeon',
    mode: 'dungeon',
    entranceInset: UNDERCROFT_SILL_DROP,
    // Deliberately at a landmark, which is exactly what the natural-cave
    // placement filter exists to prevent. Say so, rather than being caught by it.
    ignoreLandmarkHalo: true,
    valid: true,
    reasons: [],
    site: { key: entry.key, tier: entry.tier, x: entry.x, y: entry.y, z: entry.z },
  };
}

/**
 * The undercrofts currently streamed in.
 *
 * CaveExperiment owns one cave at a time and finds it by probing cells. This is
 * the other source it consults: the doors the surface has actually built, which
 * no cell probe would ever produce because they sit inside a landmark halo.
 */
export class KeepUndercroftRegistry {
  constructor() { this.anchors = new Map(); }

  registerUndercroft(entry, anchor) {
    if (!anchor) return null;
    this.anchors.set(entry.key, anchor);
    return () => { this.anchors.delete(entry.key); };
  }

  anchorsNear(px, pz, radius) {
    const out = [];
    for (const anchor of this.anchors.values()) {
      if ((anchor.x - px) ** 2 + (anchor.z - pz) ** 2 <= radius * radius) out.push(anchor);
    }
    return out;
  }

  snapshot() { return [...this.anchors.values()]; }

  clear() { this.anchors.clear(); probeCache.clear(); }
}
