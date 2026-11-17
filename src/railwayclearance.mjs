// Where the railway's running line is, for things that walk the ground beside it.
//
// The train is scripted: it never brakes for anything and cannot be blocked, so
// anything standing on the line is driven straight through. Animals may cross
// the track, but nothing may stop on it. This module answers the two questions
// that rule needs: "is this point on the line?" and "which way is off it?".
//
// "On the line" means at track level as well as near it. The nearest segment of
// a tunnel lies under a hillside an animal grazes on top of, and the nearest
// segment of a viaduct is high above the valley floor an animal walks beneath;
// neither is on the track, and measuring only horizontal distance would fence
// both off for no reason. Comparing the ground with the rail formation handles
// cuttings, embankments, bridge approaches and tunnel mouths in one test.
//
// THREE-free, so the same answers drive the game and the headless tests.

import { RAILWAY_TERRAIN_TYPES, RAILWAY_TRACKBED_DROP } from './railwayterrain.mjs';

// Half-width of the strip a stationary animal must never occupy, measured from
// the track centreline. The carriage body is 1.275 m either side of the rails;
// the rest is the reach of the largest animal's body and head from its centre,
// so an animal standing just outside this line clears a passing train.
export const RAILWAY_FOUL_HALF_WIDTH = 3.2;

// How far from the centreline anywhere an animal chooses to go (a spawn, a
// grazing patch, a roam target, a drinking bank) has to be. Wider than the foul
// strip so an animal that settles at its destination, or drifts a step while it
// grazes, is still well clear of the train.
export const RAILWAY_STANDING_CLEARANCE = 6;

// How far below the trackbed the ground may be and still count as the track:
// enough to tell the line from the valley floor under a bridge.
export const RAILWAY_LEVEL_TOLERANCE = 2.2;
// And how far above it. Anything standing on ground less than a carriage's
// height above the rails is in the train's way, even on a hump of earth the
// cutting failed to remove. Tunnels are told apart by their kind, not by this:
// the hillside over a bore is never the track.
export const RAILWAY_HEADROOM = 5;

// The spatial bins only ever need to answer queries this close to the line.
const LINE_REACH = 40;
const BIN_SIZE = 64;
const lineIndexes = new WeakMap();

function lineIndexFor(index) {
  let lines = lineIndexes.get(index);
  if (lines) return lines;
  const bins = new Map();
  const segments = index.segments;
  const count = index.kinds?.length || 0;
  for (let i = 0; i < count; i++) {
    const o = i * 6;
    const ax = segments[o], az = segments[o + 1], bx = segments[o + 3], bz = segments[o + 4];
    const ix0 = Math.floor((Math.min(ax, bx) - LINE_REACH) / BIN_SIZE);
    const ix1 = Math.floor((Math.max(ax, bx) + LINE_REACH) / BIN_SIZE);
    const iz0 = Math.floor((Math.min(az, bz) - LINE_REACH) / BIN_SIZE);
    const iz1 = Math.floor((Math.max(az, bz) + LINE_REACH) / BIN_SIZE);
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const key = `${ix},${iz}`;
      let bin = bins.get(key);
      if (!bin) bins.set(key, bin = []);
      bin.push(i);
    }
  }
  lines = { bins };
  lineIndexes.set(index, lines);
  return lines;
}

/**
 * The nearest stretch of running line to (x, z), or null when the railway is
 * more than LINE_REACH away (or there is no railway).
 *
 * `across` is the signed offset from the centreline: positive on the left of
 * the segment's direction of travel, which is the side `normalX/normalZ`
 * points to. `formation` is the rail formation height at the foot point.
 */
export function nearestRailwayLine(world, x, z, out = {}) {
  const index = world?.railwayTerrain;
  if (!index?.segments || !index.kinds?.length) return null;
  const bin = lineIndexFor(index).bins.get(
    `${Math.floor(x / BIN_SIZE)},${Math.floor(z / BIN_SIZE)}`);
  if (!bin) return null;
  const segments = index.segments;
  let best = Infinity, bestIndex = -1, bestT = 0;
  for (const i of bin) {
    const o = i * 6;
    const ax = segments[o], az = segments[o + 1];
    const dx = segments[o + 3] - ax, dz = segments[o + 4] - az;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 1e-9
      ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSq)) : 0;
    const px = ax + dx * t, pz = az + dz * t;
    const distance = Math.hypot(x - px, z - pz);
    // At a joint between two segments both are equally near; the open-air one
    // owns the joint, so a tunnel mouth does not hide the track in front of it.
    if (distance < best - 1e-6
      || (distance < best + 1e-6 && index.kinds[bestIndex] === RAILWAY_TERRAIN_TYPES.tunnel)) {
      best = distance; bestIndex = i; bestT = t;
    }
  }
  if (bestIndex < 0 || best > LINE_REACH) return null;
  const o = bestIndex * 6;
  const ax = segments[o], az = segments[o + 1];
  const dx = segments[o + 3] - ax, dz = segments[o + 4] - az;
  const length = Math.hypot(dx, dz) || 1;
  const tangentX = dx / length, tangentZ = dz / length;
  const footX = ax + dx * bestT, footZ = az + dz * bestT;
  // Left of the direction of travel.
  const normalX = -tangentZ, normalZ = tangentX;
  out.distance = best;
  out.footX = footX;
  out.footZ = footZ;
  out.tangentX = tangentX;
  out.tangentZ = tangentZ;
  out.normalX = normalX;
  out.normalZ = normalZ;
  out.across = (x - footX) * normalX + (z - footZ) * normalZ;
  out.formation = segments[o + 2] + (segments[o + 5] - segments[o + 2]) * bestT;
  out.kind = index.kinds[bestIndex];
  out.segment = bestIndex;
  return out;
}

const scratchLine = {};

/**
 * Horizontal distance from (x, z) to the centreline when the ground there is at
 * track level, or Infinity when it is not (no railway near, the line is in a
 * tunnel below, or on a bridge above).
 */
export function railwayTrackDistance(world, x, z, groundY = null, out = scratchLine) {
  const line = nearestRailwayLine(world, x, z, out);
  if (!line || line.kind === RAILWAY_TERRAIN_TYPES.tunnel) return Infinity;
  const ground = Number.isFinite(groundY) ? groundY : world.height(x, z);
  const rise = ground - (line.formation - RAILWAY_TRACKBED_DROP);
  if (rise < -RAILWAY_LEVEL_TOLERANCE || rise > RAILWAY_HEADROOM) return Infinity;
  return line.distance;
}

/** Is this point inside the strip where a stationary animal would be hit? */
export function onRailwayTrack(world, x, z, halfWidth = RAILWAY_FOUL_HALF_WIDTH, groundY = null) {
  return railwayTrackDistance(world, x, z, groundY) < halfWidth;
}

/** Is this point far enough from the line for an animal to settle there? */
export function clearOfRailway(world, x, z, clearance = RAILWAY_STANDING_CLEARANCE) {
  return !(railwayTrackDistance(world, x, z) < clearance);
}

/**
 * Does any running line pass within `reach` of (x, z), whatever its level?
 * For a whole area (a livestock field), where the level test at one point says
 * nothing about the rest of it. Tunnels are ignored: the ground over a bore is
 * the hillside, not the track.
 */
export function railwayWithin(world, x, z, reach, out = scratchLine) {
  const line = nearestRailwayLine(world, x, z, out);
  if (!line || line.distance >= reach) return false;
  return line.kind !== RAILWAY_TERRAIN_TYPES.tunnel;
}

/**
 * The point an animal standing on the line should walk to: straight across to
 * the side its destination is on (or back to the side it came from), far enough
 * out to be clear of the track. Walking to it crosses the line square-on rather
 * than drifting along the rails.
 *
 * `toward` is where the animal wants to end up, if anywhere; `fallbackSide` is
 * +1 or -1 for when neither the destination nor the animal's own offset picks a
 * side; `side` forces one (the far side, when the near one is a river).
 */
export function railwayExitPoint(line, x, z, {
  toward = null,
  fallbackSide = 1,
  side: forcedSide = 0,
  clearance = RAILWAY_STANDING_CLEARANCE,
  margin = 1.5,
} = {}) {
  let side = forcedSide ? Math.sign(forcedSide) : 0;
  if (!side && toward && Number.isFinite(toward.x) && Number.isFinite(toward.z)) {
    const across = (toward.x - line.footX) * line.normalX + (toward.z - line.footZ) * line.normalZ;
    if (Math.abs(across) > 0.5) side = Math.sign(across);
  }
  if (!side && Math.abs(line.across) > 0.25) side = Math.sign(line.across);
  if (!side) side = fallbackSide < 0 ? -1 : 1;
  const out = clearance + margin;
  return {
    x: line.footX + line.normalX * side * out,
    z: line.footZ + line.normalZ * side * out,
    side,
  };
}
