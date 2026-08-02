// What a traveller can tell you about their own journey.
//
// A travelling NPC knows four things a stationary one does not: where it set
// out from, where it is going, how much of the walk is behind it, and why it is
// making it at all. Without them the honest answer to "where are you headed" is
// nothing, and the model fills the silence — inventing a destination on Tuesday
// and a different one on Wednesday, mid-conversation.
//
// So this turns journey state into facts a character can speak from. It does NOT
// write the story. The purpose is a seed — "carrying a message" — and what that
// message is, who it is for and whether they want to deliver it belongs to the
// character, not to a lookup table. Anchors, then room.
//
// Distances are rounded before they leave here. A walker crossing country says
// "most of a morning still" and not "4,812 metres", and a number that precise in
// the context is a number the model will happily quote.

import { landmarksAround } from './landmarks.js';
import { bearingBetween, compassFromBearing, describeDistance } from './livingworldcontext.mjs';
import { isTravelling, JOURNEY_PHASE } from './npcjourney.mjs';

const LANDMARK_NAMES = Object.freeze({
  giant: 'the great tree',
  ring: 'the old stone ring',
  cairn: 'the high cairn',
  tower: 'the ruined watchtower',
  lighthouse: 'the lighthouse ruin',
});

// Walking pace in metres per in-world hour, for turning a distance into a
// duration. A traveller thinks in "half a day", not in metres.
const METRES_PER_HOUR = 4200;

/**
 * Name the landmark a nav-graph node stands for.
 *
 * Nav-graph nodes carry a key and a position but no identity — the trail solver
 * had no reason to record one. The landmark layer knows, so ask it, matching on
 * the key rather than on proximity: two landmarks can share a cell boundary and
 * the nearest one is not always the one the trail was built for.
 */
export function describeLandmark(world, seed, key, x, z) {
  if (!Number.isFinite(x)) return null;
  const found = landmarksAround(world, x, z, seed, 900, []);
  const match = found.find((landmark) => landmark.key === key)
    || found.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
  const biome = world.biomeAt(x, z);
  return {
    key,
    name: match ? (LANDMARK_NAMES[match.type] || `the ${match.type}`) : 'open country',
    kind: match?.type || 'wild',
    country: biome?.id || 'unknown country',
    worldX: x,
    worldZ: z,
  };
}

/** Roughly how long a distance takes on foot, in a walker's own words. */
export function describeWalkingTime(metres) {
  const hours = metres / METRES_PER_HOUR;
  if (hours < 0.35) return 'less than half an hour';
  if (hours < 0.75) return 'about half an hour';
  if (hours < 1.5) return 'an hour or so';
  if (hours < 3) return 'a couple of hours';
  if (hours < 5) return 'half a day';
  if (hours < 9) return 'the better part of a day';
  return 'more than a day';
}

/**
 * Everything a traveller could say about the walk they are on.
 *
 * Returns null for someone who has never left — a station resident has no
 * journey to describe, and a null field is a clearer signal to the prompt than
 * an object full of empty strings.
 */
export function describeJourney(journey, { world, seed, nodes = null } = {}) {
  if (!journey || !world) return null;
  if (!journey.fromKey && !isTravelling(journey)) return null;

  const nodeAt = (key) => (nodes && nodes.get ? nodes.get(key) : null);
  const fromNode = nodeAt(journey.fromKey);
  const toNode = nodeAt(journey.destKey);
  const origin = journey.fromKey
    ? describeLandmark(world, seed, journey.fromKey, fromNode?.x, fromNode?.z)
    : null;
  const destination = journey.destKey
    ? describeLandmark(world, seed, journey.destKey, toNode?.x, toNode?.z)
    : null;

  const travelling = isTravelling(journey);
  const total = journey.route
    ? journey.route.distance + journey.route.openGroundDistance
    : 0;
  const covered = Math.max(0, journey.coveredM || 0);
  const remaining = Math.max(0, total - covered);

  // What the route puts in their way. A traveller who has forded three rivers
  // has something to say that one who crossed bridges does not.
  let bridges = 0;
  let fords = 0;
  for (const leg of journey.route?.legs || []) {
    bridges += leg.edge.bridgeCount || 0;
    fords += Math.max(0, (leg.edge.fordCount || 0) - (leg.edge.bridgeCount || 0));
  }

  const heading = destination && Number.isFinite(destination.worldX)
    ? compassFromBearing(bearingBetween(journey.x, journey.z,
      destination.worldX, destination.worldZ))
    : compassFromBearing(journey.heading || 0);

  return {
    travelling,
    // 'walking' and 'crossing open ground' rather than the internal phase
    // names: the model reads this, and 'transfer' means nothing to a character.
    doing: travelling
      ? (journey.phase === JOURNEY_PHASE.transfer ? 'crossing open ground between paths' : 'walking a trail')
      : 'resting at the end of a journey',
    purpose: journey.purpose || null,
    from: origin,
    to: destination,
    headingDirection: heading,
    // Rounded hard on the way out. Precision here is precision the model will
    // quote back, and nobody crossing country talks in metres.
    coveredPhrase: describeDistance(Math.round(covered)),
    remainingPhrase: remaining > 0 ? describeDistance(Math.round(remaining)) : null,
    remainingTimePhrase: remaining > 0 ? describeWalkingTime(remaining) : null,
    walkedTimePhrase: describeWalkingTime(covered),
    progressPercent: total > 0 ? Math.round((covered / total) * 100) : 0,
    legsWalked: journey.legIndex + (travelling ? 1 : 0),
    legsTotal: journey.route?.legs.length || 0,
    crossings: { bridges, fords },
    journeysCompleted: journey.arrivals || 0,
  };
}
