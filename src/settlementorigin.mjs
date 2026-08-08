// Why a village is here.
//
// Every settlement in this world is currently the same idea in a different
// place: a square in the middle, streets fanning evenly out of it, the same
// roster of buildings in the same order, and no name. Nothing you can see about
// one is a consequence of anything, which is what makes a hundred of them feel
// like one of them.
//
// Real places have a reason. There is a village at a ford because that is where
// you could get across; a village under a stone ring because people came to it;
// a village on a knoll because it could be held. That reason is visible
// centuries later in the shape of the streets and the name over the door.
//
// So this derives one — from the terrain, not from a die roll. A site beside a
// river channel really does come out a ford; a site under a cairn really does
// come out a shrine. Evidence first, seed only to break ties and to choose among
// equals, because a founding reason that contradicts the ground it stands on is
// worse than none.
//
// DERIVED, NEVER STORED. A pure function of (world, site), so it costs nothing
// to persist, it is identical on the main thread and in the terrain worker, and
// it is true of the thousands of settlements the player will never walk into.
//
// It must never move the site. Trails and the nav graph key off settlement
// positions, and the crossroads detector reads the trail network — moving the
// site from here would close that loop. The origin changes only what happens
// inside the halo.
//
// THREE-free, so the derivation is asserted in Node without a renderer.

import { landmarksAround } from './landmarks.js';
import { mulberry32 } from './noise.js';
import { localStone } from './settlementprops.mjs';
import { trailsAround } from './trails.js';
import { WATER_LEVEL } from './world.js';

export const ORIGIN_KINDS = Object.freeze([
  'ford', 'spring', 'shrine', 'knoll', 'crossroads', 'harbour', 'quarry', 'railway',
]);

// How far out each detector looks. Kept modest: a reason you cannot see from the
// village is not the reason the village is there.
const FORD_REACH = 120;
const SHRINE_REACH = 500;
const COAST_REACH = 220;
const RELIEF_REACH = 90;
const TRAIL_REACH = 260;
// Below this, no piece of evidence is convincing and the settlement falls back
// to the honest default: somebody dug a well and stayed.
const SCORE_FLOOR = 2.2;

const TAU = Math.PI * 2;

const cache = new Map();
const scratch = { landmarks: [], trails: [] };

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// --- the detectors -----------------------------------------------------------
//
// Each returns { score, x, z } or null. The point is the actual feature — the
// crossing, the stone, the summit — because the layout aims the main street at
// it and the founding stone stands looking toward it.

/** A channel you could get across. */
function detectFord(world, site) {
  let best = null;
  // A coarse ring first, then refine toward the bank: sampling a whole disc at
  // fording resolution is hundreds of queries for a feature that is a line.
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * TAU;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    for (let d = 20; d <= FORD_REACH; d += 12) {
      const x = site.x + dx * d, z = site.z + dz * d;
      const river = world.riverAt(x, z);
      if (!river.wet) continue;
      // Shallow and close is what makes a crossing worth founding on. A deep
      // channel is a reason to be somewhere else.
      const shallow = 1 - clamp01(river.depth / 2.4);
      const near = 1 - d / FORD_REACH;
      const score = 3.0 + shallow * 5.5 + near * 3.0;
      if (!best || score > best.score) best = { score, x, z };
      break;                                   // first wet cell along this ray
    }
  }
  return best;
}

/** Water you can reach without a channel: the well came before the houses. */
function detectSpring(world, site) {
  const biome = world.biomeAt(site.x, site.z);
  if (!biome) return null;
  // Damp ground in a hollow. Measured against the ring around it, so this is a
  // place water gathers rather than merely a wet region.
  let higher = 0;
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * TAU;
    const h = world.height(site.x + Math.cos(angle) * 55, site.z + Math.sin(angle) * 55);
    if (h > biome.h + 0.5) higher++;
  }
  const hollow = higher / 8;
  const damp = clamp01(((biome.m ?? 0.5) - 0.42) / 0.4);
  const score = 2.0 + hollow * 3.4 + damp * 3.2;
  return { score, x: site.x, z: site.z };
}

/** Somewhere people already came to. */
function detectShrine(world, site, seed) {
  const found = landmarksAround(world, site.x, site.z, seed, SHRINE_REACH, scratch.landmarks);
  let best = null;
  for (const landmark of found) {
    const distance = Math.hypot(landmark.x - site.x, landmark.z - site.z);
    if (distance > SHRINE_REACH) continue;
    // A ring or a cairn is a reason to gather; a ruined tower is a reason to
    // shelter under. Both found villages, and the great tree most of all.
    const pull = landmark.type === 'ring' ? 6.2 : landmark.type === 'giant' ? 5.6
      : landmark.type === 'cairn' ? 4.6 : landmark.type === 'tower' ? 4.2 : 3.4;
    const near = 1 - distance / SHRINE_REACH;
    const score = 2.6 + pull * (0.45 + near * 0.55);
    if (!best || score > best.score) best = { score, x: landmark.x, z: landmark.z };
  }
  return best;
}

/** High ground worth holding. */
function detectKnoll(world, site) {
  const here = world.height(site.x, site.z);
  let below = 0, summitX = site.x, summitZ = site.z, summitH = here;
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * TAU;
    const x = site.x + Math.cos(angle) * RELIEF_REACH;
    const z = site.z + Math.sin(angle) * RELIEF_REACH;
    const h = world.height(x, z);
    if (h < here - 2) below++;
    if (h > summitH) { summitH = h; summitX = x; summitZ = z; }
  }
  const prominence = below / 12;
  if (prominence < 0.45) return null;
  // The summit is the reason even when the houses sit off its shoulder.
  return { score: 2.4 + prominence * 6.4, x: summitX, z: summitZ };
}

/** Two roads meeting. */
function detectCrossroads(world, site, seed) {
  // Reads the trail network, which is built from settlement SITES and never
  // from their plans — so this cannot feed back into where the village is.
  const trails = trailsAround(world, site.x, site.z, seed, TRAIL_REACH, scratch.trails);
  if (trails.length < 2) return null;
  // Distinct bearings, not distinct edges: a single trail passing through
  // arrives and leaves, and counting both makes every village a crossroads.
  const bearings = [];
  for (const edge of trails) {
    const s = edge.segments;
    if (!s || !s.count) continue;
    const bearing = Math.atan2(s.dz[0], s.dx[0]);
    if (!bearings.some((b) => Math.abs(Math.atan2(Math.sin(b - bearing), Math.cos(b - bearing))) < 0.6)) {
      bearings.push(bearing);
    }
  }
  if (bearings.length < 3) return null;
  return { score: 2.5 + Math.min(bearings.length, 5) * 1.35, x: site.x, z: site.z };
}

/**
 * Shelter you can land a boat in.
 *
 * Tested by reaching open water, NOT by `biome.coastType` — that is a coastal
 * STYLE sampled from a noise field, defined everywhere on the map, so guarding
 * on it made nine villages in ten a harbour, most of them landlocked.
 */
function detectHarbour(world, site) {
  if (world.height(site.x, site.z) > 26) return null;   // nowhere near the sea
  let best = null;
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * TAU;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    for (let d = 30; d <= COAST_REACH; d += 20) {
      const x = site.x + dx * d, z = site.z + dz * d;
      const h = world.height(x, z);
      if (h > WATER_LEVEL + 0.3) continue;
      const near = 1 - d / COAST_REACH;
      // Sheltered water, not a cliff to be wrecked on.
      const gentle = 1 - clamp01((world.biomeAt(x, z)?.slope ?? 0) / 0.5);
      const score = 3.0 + near * 3.4 + gentle * 3.2;
      if (!best || score > best.score) best = { score, x, z };
      break;
    }
  }
  return best;
}

/** Stone worth cutting. */
function detectQuarry(world, site) {
  let best = null;
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * TAU;
    for (let d = 40; d <= RELIEF_REACH + 60; d += 35) {
      const x = site.x + Math.cos(angle) * d, z = site.z + Math.sin(angle) * d;
      const biome = world.biomeAt(x, z);
      if (!biome) continue;
      // A working face: steep, bare and near enough to cart from. The threshold
      // is low because the settlement placer rejects sites with more than 8m of
      // local relief, so a village never sits under a cliff — a quarry village
      // is genuinely rare, and demanding a proper crag made it non-existent.
      if (biome.slope < 0.34) continue;
      const bare = biome.id === 'tundra' || biome.id === 'snow' || biome.h > 70 ? 1 : 0.5;
      const score = 2.6 + clamp01((biome.slope - 0.34) / 0.30) * 4.6 + bare * 2.2;
      if (!best || score > best.score) best = { score, x, z };
    }
  }
  return best;
}

// --- naming ------------------------------------------------------------------
//
// English place-names are feature + type, which is exactly the pair an origin
// hands us. That makes the name legible rather than decorative: someone who
// reads "Alderford" and later finds the ford has learned something true.

const ELEMENTS = Object.freeze({
  forest: ['Alder', 'Ash', 'Holt', 'Thorn', 'Raven', 'Bram', 'Oak', 'Hazel'],
  grassland: ['Wold', 'Marl', 'Kettle', 'Hare', 'Corn', 'Meadow', 'Stony', 'Lark'],
  savanna: ['Dust', 'Amber', 'Long', 'Sun', 'Bramble', 'Ochre'],
  jungle: ['Fern', 'Vine', 'Mire', 'Green', 'Palm'],
  taiga: ['Pine', 'Frost', 'Elk', 'Black', 'Spruce'],
  tundra: ['Bleak', 'Snow', 'Grey', 'Hoar', 'Wind'],
  snow: ['White', 'Rime', 'Cold', 'Winter'],
  desert: ['Salt', 'Dry', 'Sand', 'Scorch', 'Bone'],
  beach: ['Shell', 'Salt', 'Tide', 'Cockle'],
  default: ['Old', 'Nether', 'Upper', 'Middle', 'Far'],
});

// The type half. Some read better as a second word, which also keeps a world of
// these from sounding like one long compound.
// Three or four apiece, not two. Railways follow valleys and valleys have
// rivers, so a line's five stations came out four fords — and with one
// alternative each they were Kettle Crossing, Oak Crossing, Amber Crossing and
// Long Crossing, which reads as one village stamped out four times. The
// founding reason can legitimately repeat; the name has to carry the variety.
const SUFFIXES = Object.freeze({
  ford: [['ford', false], ['wath', false], ['Crossing', true], ['Ford', true]],
  spring: [['well', false], ['keld', false], ['Spring', true], ['Wells', true]],
  shrine: [['stow', false], ['minster', false], ['Chapel', true], ['Stones', true]],
  knoll: [['how', false], ['barrow', false], ['burgh', false], ['Knowe', true]],
  crossroads: [['cross', false], ['gate', false], ['Cross', true], ['Ways', true]],
  harbour: [['haven', false], ['wick', false], ['Quay', true], ['Landing', true]],
  quarry: [['delf', false], ['scar', false], ['Quarry', true], ['Pits', true]],
  railway: [['Junction', true], ['Road', true], ['Halt', true], ['Sidings', true]],
});

const EPITHETS = Object.freeze({
  ford: 'the crossing',
  spring: 'the spring',
  shrine: 'the old stones',
  knoll: 'the hill',
  crossroads: 'the meeting of the roads',
  harbour: 'the landing',
  quarry: 'the stone workings',
  railway: 'the railway',
});

// England disambiguates neighbours exactly this way — Great and Little
// Missenden, Nether and Upper Slaughter — which is lucky, because feature+type
// alone is a small enough space that a day's walk turned up two Alderfords.
const QUALIFIERS = Object.freeze(['Great', 'Little', 'Upper', 'Nether', 'Old', 'New', 'Far']);

function placeName(kind, biomeId, rng) {
  const pool = ELEMENTS[biomeId] || ELEMENTS.default;
  const element = pool[Math.floor(rng() * pool.length)];
  const options = SUFFIXES[kind] || SUFFIXES.spring;
  const [suffix, separate] = options[Math.floor(rng() * options.length)];
  if (separate) return `${element} ${suffix}`;
  const compound = `${element}${suffix}`;
  // Only the compound forms take a qualifier: "Nether Raven Crossing" is a
  // mouthful, "Nether Alderford" is a village.
  return rng() < 0.42 ? `${QUALIFIERS[Math.floor(rng() * QUALIFIERS.length)]} ${compound}` : compound;
}

// --- the derivation ----------------------------------------------------------

/**
 * Why this settlement is here, as a frozen record.
 *
 * Cached against the site's plan hash, so it is computed once per settlement and
 * amortised against the plan that consumes it — the forty-odd world queries
 * never land in a per-frame path.
 */
export function settlementOrigin(world, site) {
  if (!world || !site) return null;
  const key = `${site.id}:${site.planHash}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const seed = world.seed ?? 1;
  const rng = mulberry32((site.seed ^ 0x5f37) >>> 0);
  const biome = world.biomeAt(site.x, site.z);

  const candidates = [
    ['ford', detectFord(world, site)],
    ['spring', detectSpring(world, site)],
    ['shrine', detectShrine(world, site, seed)],
    ['knoll', detectKnoll(world, site)],
    ['crossroads', detectCrossroads(world, site, seed)],
    ['harbour', detectHarbour(world, site)],
    ['quarry', detectQuarry(world, site)],
  ];

  let chosen = null;
  for (const [kind, found] of candidates) {
    if (!found) continue;
    // A small seeded jitter, so two sites with the same evidence can still come
    // out differently — but far too small to overrule the ground itself.
    const score = found.score + rng() * 1.1;
    if (!chosen || score > chosen.score) chosen = { kind, score, x: found.x, z: found.z };
  }

  // A station settlement with nothing older to explain it is what it looks
  // like: a place the line made. Deliberately the fallback rather than a
  // candidate, so most villages predate the railway, as they did in life.
  if (!chosen || chosen.score < SCORE_FLOOR) {
    chosen = site.isStationSettlement
      ? { kind: 'railway', score: SCORE_FLOOR, x: site.station?.x ?? site.x, z: site.station?.z ?? site.z }
      : { kind: 'spring', score: SCORE_FLOOR, x: site.x, z: site.z };
  }

  const dx = chosen.x - site.x, dz = chosen.z - site.z;
  const distance = Math.hypot(dx, dz);
  const record = Object.freeze({
    kind: chosen.kind,
    x: chosen.x,
    z: chosen.z,
    // Measured the way `site.yaw` and the street angles are — atan2(dz, dx), so
    // that (cos, sin) maps to (x, z). NOT the (sin, cos) convention that
    // `facingToward` uses for a building's door; mixing the two puts the main
    // street at ninety degrees to the thing it is supposed to run toward.
    bearing: distance > 0.5 ? Math.atan2(dz, dx) : site.yaw,
    distance,
    strength: clamp01((chosen.score - SCORE_FLOOR) / 8),
    name: placeName(chosen.kind, biome?.id, rng),
    epithet: EPITHETS[chosen.kind] || EPITHETS.spring,
    age: chosen.kind === 'railway' ? 'new' : 'old',
    // The rock they had to hand. Carried here rather than worked out by the
    // props builder because that one has no world to ask, and because what a
    // village marks itself with is part of where it is.
    stone: localStone(biome),
  });

  if (cache.size > 512) cache.delete(cache.keys().next().value);
  cache.set(key, record);
  return record;
}

/** The village's name on its own, for callers that want nothing else. */
export function settlementName(world, site) {
  return settlementOrigin(world, site)?.name || null;
}

export function clearSettlementOriginCache() { cache.clear(); }
