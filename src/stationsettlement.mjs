// Villages at the stations.
//
// Every other settlement in this world is a pure function of a grid cell and a
// seed, which is what lets the worker and the main thread agree on where towns
// are without talking to each other. A station is not: it comes from a regional
// railway plan, chosen for gradients and curve radii, and it exists only once
// that plan has been computed and shipped across as terrain.
//
// So these are sourced the way station trail spurs are — from
// `world.railwayTerrain`, which both threads already hold — and cached against
// the plan's signature so a re-plan produces a new set rather than a stale one.
// Before the railway lands there are no station villages, and the world is what
// it always was. That ordering is real and documented at the call sites.
//
// The village does not sit ON the platform. It sits beside the line, offset
// across the track so the platform lands near its edge: you arrive at a village
// and the station is part of it, rather than arriving at a station that happens
// to have houses behind it.

import { railwayStationSites } from './railwayterrain.mjs';
import { layoutSpecFor } from './settlementlayout.mjs';

// Two tiers. The best-sited stations grow the larger, denser villages; the rest
// stay halts — the real railway word for a minor stop, and the right size for a
// place the line reaches but does not favour.
export const STATION_SETTLEMENT_TIERS = Object.freeze({
  'station-village': Object.freeze({ radius: 265, trailClass: 'primary', silhouetteCue: 'spire' }),
  'station-halt': Object.freeze({ radius: 165, trailClass: 'primary', silhouetteCue: 'hall' }),
});

// How many of the stations get the larger village. The rest become halts.
export const MAJOR_STATION_VILLAGES = 3;

// A grid settlement whose centre falls within this of a station is suppressed:
// the station village occupies that ground instead. Without it the two placers
// know nothing about each other and produce overlapping streets.
export const STATION_SUPPRESSION_RADIUS = 1000;

// Candidate centres are probed across the track at these multiples of how far
// the village actually BUILDS — not of its halo radius.
//
// The halo is a claim on ground; the built-up area is a good deal smaller, and
// it shrank again when the layout moved from a scatter to streets around a
// square. Offsetting by the halo left the centre far enough out that the
// nearest house stood over a hundred metres from the platform: from the train
// the village had simply receded into the middle distance. Measured against the
// built reach, the platform lands at the edge of the houses, which is what
// makes the station part of the village rather than a stop near one.
// Biased a little beyond the built reach rather than sitting on it: a centre
// pulled right up to the line has half its lots inside the railway's exclusion
// and comes out a third of the size it should be. Measured, a band around
// 1.05–1.35 keeps the nearest houses within about thirty metres of the platform
// while leaving the village enough ground on its own side of the track.
const OFFSETS = Object.freeze([1.05, 1.2, 1.35]);
const SIDES = Object.freeze([1, -1]);
const GENERATION_VERSION = 1;

const cache = new Map();

/**
 * How good is this ground for a village centre?
 *
 * Scored rather than rejected. Grid settlements can decline a cell and leave it
 * empty, but a station is already built and the line already stops there, so
 * every station gets a village — the question is only which side of the track
 * and how far out. A hostile site returns a low score, not null, and the
 * building placer's own terrain fit is what ultimately refuses a bad lot.
 */
function centreQuality(world, x, z) {
  const biome = world.biomeAt(x, z);
  if (!biome) return -1e6;
  let score = 8;
  if (world.riverAt(x, z).wet) score -= 400;      // in the channel: almost always wrong
  if (biome.h < 2.5) score -= 500;                // at or under the waterline
  score -= biome.slope * 15;
  const e = 28;
  const relief = Math.max(
    Math.abs(world.height(x + e, z) - biome.h), Math.abs(world.height(x - e, z) - biome.h),
    Math.abs(world.height(x, z + e) - biome.h), Math.abs(world.height(x, z - e) - biome.h),
  );
  score -= relief * 0.35;
  score += (1 - Math.abs((biome.m ?? 0.5) - 0.55)) * 2;
  return score;
}

/** How far out from its centre a settlement of this kind actually builds. */
function builtReachFor(kind) {
  const spec = layoutSpecFor(kind);
  return spec ? spec.reach : STATION_SETTLEMENT_TIERS[kind].radius * 0.5;
}

/** The best centre for a village beside this platform, given how far it builds. */
function chooseCentre(world, station, builtReach) {
  // Across the track, not along it: the platform's long axis is the line, so a
  // village offset along the tangent would sit on the rails.
  const hyp = Math.hypot(station.tangentX, station.tangentZ) || 1;
  const acrossX = -station.tangentZ / hyp, acrossZ = station.tangentX / hyp;
  let best = null;
  for (const side of SIDES) {
    for (const offset of OFFSETS) {
      const distance = builtReach * offset;
      const x = station.x + acrossX * side * distance;
      const z = station.z + acrossZ * side * distance;
      const quality = centreQuality(world, x, z);
      // Ties break on side then offset, so the same world always sites the same
      // village on the same side of the line.
      if (!best || quality > best.quality) best = { x, z, quality, side, offset };
    }
  }
  return best;
}

/**
 * The villages that belong to the current railway plan, or an empty list.
 *
 * Shaped to match `settlementForCell` output so every existing consumer —
 * vegetation halos, the settlement streamer, the plan builder — treats one like
 * any other settlement.
 */
export function stationSettlements(world, seed = world?.seed ?? 1) {
  const index = world?.railwayTerrain;
  if (!index || !index.stationCount) return [];
  const key = (seed >>> 0) + ':' + index.signature;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const stations = railwayStationSites(index);
  // Rank on a common probe radius first. Tier decides the final radius, so
  // scoring at each tier's own radius would rank stations on different ground
  // and make the ordering depend on the answer it is supposed to produce.
  const probeReach = builtReachFor('station-village');
  const ranked = stations
    .map((station) => ({ station, probe: chooseCentre(world, station, probeReach) }))
    .sort((a, b) => b.probe.quality - a.probe.quality || a.station.index - b.station.index);

  const settlements = new Array(stations.length);
  for (let rank = 0; rank < ranked.length; rank++) {
    const { station } = ranked[rank];
    const kind = rank < MAJOR_STATION_VILLAGES ? 'station-village' : 'station-halt';
    const tier = STATION_SETTLEMENT_TIERS[kind];
    const centre = chooseCentre(world, station, builtReachFor(kind));
    const radius = tier.radius;
    const y = world.height(centre.x, centre.z);
    // The village faces its station: the gateway a traveller arrives through is
    // the one the line delivers them to.
    const yaw = Math.atan2(station.z - centre.z, station.x - centre.x);
    const id = `station-settlement:${station.index}`;
    const entranceDistance = radius * 0.82;
    const ex = centre.x + Math.cos(yaw) * entranceDistance;
    const ez = centre.z + Math.sin(yaw) * entranceDistance;
    // Ordered by station index, not by rank, so the list is stable to read.
    settlements[station.index] = Object.freeze({
      id, key: id, kind, seed: (index.signature.length * 2654435761 ^ (station.index + 1) * 40503) >>> 0,
      generationVersion: GENERATION_VERSION,
      isStationSettlement: true, stationIndex: station.index,
      // The platform, so the plan builder can keep its streets and lots off it.
      station: Object.freeze({ x: station.x, y: station.y, z: station.z,
        tangentX: station.tangentX, tangentZ: station.tangentZ,
        halfLength: station.halfLength, halfWidth: station.halfWidth }),
      x: centre.x, y, z: centre.z, yaw, radius,
      bounds: { minX: centre.x - radius, maxX: centre.x + radius, minZ: centre.z - radius, maxZ: centre.z + radius },
      exclusionHalo: radius + 24,
      regionalEntrance: { key: `${id}:entrance`, x: ex, y: world.height(ex, ez), z: ez },
      trailClass: tier.trailClass,
      silhouetteCue: tier.silhouetteCue,
      planHash: `${index.signature}:${station.index}:${GENERATION_VERSION}`,
    });
  }
  const result = settlements.filter(Boolean);
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

/**
 * Is this point close enough to a station that a grid settlement should give
 * way? Measured against the platform rather than the village centre: the
 * station is the fixed thing, and the village is placed relative to it.
 */
export function suppressedByStation(world, x, z, radius = STATION_SUPPRESSION_RADIUS) {
  const index = world?.railwayTerrain;
  if (!index || !index.stationCount) return false;
  const limit = radius * radius;
  for (let i = 0; i < index.stationCount; i++) {
    const o = i * 9;
    const dx = x - index.stations[o], dz = z - index.stations[o + 1];
    if (dx * dx + dz * dz < limit) return true;
  }
  return false;
}

export function clearStationSettlementCache() {
  cache.clear();
}
