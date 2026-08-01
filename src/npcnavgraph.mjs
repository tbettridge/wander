// Routing between landmarks over the trail network.
//
// The desire-line solver already built the hard part. Every trail edge names the
// two landmarks it joins (`fromKey`, `toKey`), knows its own arc length, and
// carries the grade analysis that produced it. That is a graph — it has simply
// never been walked as one.
//
// So this holds no geometry of its own. Nodes are landmark keys, arcs are trail
// edges, and a route is a sequence of edges plus the direction each is taken in.
// Positions along an edge stay in arc length, the same coordinate the crossing
// solver and `trailFrameAtArc` already speak, so a traveller's position on a
// bridge means the same thing to every part of the system.
//
// One thing the geometry forces and the graph must not hide: trail edges stop at
// a landmark's CLEARING HALO, not at its centre —
//
//     const sx = owner.x + ux * owner.halo, sz = owner.z + uz * owner.halo;
//
// so two edges meeting at the same landmark end at different points on its halo,
// measured here at up to ~100m apart. A traveller changing edges has to cross
// open ground between them. That transfer is published as `gapToNext` rather
// than smoothed over, because an NPC that silently teleports across a clearing
// is the kind of thing nobody notices until it happens in front of the player.
//
// THREE-free, and the only thing it asks of the world is where a point on a
// trail is. That makes a route assertable without a renderer.

import { trailFrameAtArc } from './trails.js';

// Tobler's hiking function: walking speed against slope, in km/h.
//
//     speed = 6 · exp(-3.5 · |slope + 0.05|)
//
// Cost is TIME, not distance, which is what makes a gentle detour beat a steep
// direct line without any arbitrary weighting. A linear penalty was tried first
// and got it backwards: at a weight of 2.4, a 600m route at 30% grade (1032)
// beat a 1000m route at 2% (1048). Nobody walks like that. Steepness hurts
// disproportionately, and an exponential is the shape of the real relationship
// rather than a constant tuned until the test passed.
//
// The +0.05 offset is Tobler's, and it carries the "declines matter less" rule
// for free: the fastest going is a slight descent, not the flat.
const TOBLER_BASE = 6;
const TOBLER_DECAY = 3.5;
const TOBLER_OFFSET = 0.05;
// Metres of easy walking a traveller will accept to keep their feet dry.
const FORD_PENALTY = 18;

/** Walking speed on a given slope, km/h. */
export function hikingSpeed(slope) {
  return TOBLER_BASE * Math.exp(-TOBLER_DECAY * Math.abs(slope + TOBLER_OFFSET));
}

/**
 * Adjacency over a set of trail edges.
 *
 * Edges arrive from `trailsAround`, which returns whatever is near a point, so
 * the graph is inherently partial — it describes the region gathered, not the
 * world. Routing beyond that region is the caller's problem to notice, and
 * `findRoute` says so by returning null rather than inventing a path.
 */
export function buildNavGraph(edges) {
  const nodes = new Map();
  const seen = new Set();
  const node = (key, x, z) => {
    let n = nodes.get(key);
    if (n === undefined) {
      n = { key, x, z, links: [] };
      nodes.set(key, n);
    } else if (!Number.isFinite(n.x) && Number.isFinite(x)) {
      n.x = x; n.z = z;
    }
    return n;
  };

  for (const edge of edges) {
    if (!edge || !edge.fromKey || !edge.toKey) continue;
    if (edge.fromKey === edge.toKey) continue;   // a spur to itself is not a route
    if (seen.has(edge.id)) continue;             // trailsAround can repeat an edge
    seen.add(edge.id);
    const c = edge.curve || {};
    const from = node(edge.fromKey, c.startX, c.startZ);
    const to = node(edge.toKey, c.endX, c.endZ);
    // Each edge is walkable both ways; the direction is what tells a traveller
    // which end of the arc to start from.
    from.links.push({ edge, to: to.key, forward: true });
    to.links.push({ edge, to: from.key, forward: false });
  }
  return { nodes, edgeCount: seen.size };
}

/**
 * What an edge costs to walk, as time rather than distance.
 *
 * The solver publishes grade as a MAGNITUDE, so cost is currently symmetric —
 * a descent is charged like the climb it mirrors. Making it asymmetric is
 * Phase 3's job and needs signed elevation per direction, which is why
 * `forward` is threaded through here unused: it is the seam that work attaches
 * to, not an oversight.
 */
export function edgeCost(edge, forward = true, weights = {}) {
  void forward;
  const fordPenalty = weights.ford ?? FORD_PENALTY;
  const length = edge.arcLength || 0;
  const speed = hikingSpeed(edge.meanGrade || 0);
  // Fords only count where the trail did not get a bridge. A crossing that was
  // built is a dry way over, and should not be charged as a wet one.
  const unbridged = Math.max(0, (edge.fordCount || 0) - (edge.bridgeCount || 0));
  // The penalty is expressed in metres, so it converts at the speed of easy
  // going rather than being added to a time in whatever units it happens to be.
  return (length + unbridged * fordPenalty) / speed;
}

/**
 * Cheapest route between two landmarks, or null when none exists in this graph.
 *
 * Plain Dijkstra over a handful of nodes: the trail network keeps its degree
 * bounded by mutual top-4 selection, so a region holds tens of nodes rather
 * than thousands, and a heuristic would cost more to justify than it saves.
 */
export function findRoute(graph, fromKey, toKey, { weights, maxCost = Infinity } = {}) {
  if (fromKey === toKey) return { keys: [fromKey], legs: [], cost: 0, distance: 0 };
  if (!graph.nodes.has(fromKey) || !graph.nodes.has(toKey)) return null;

  const best = new Map([[fromKey, 0]]);
  const cameFrom = new Map();
  // A settled node has its final cost; re-reaching it can only be worse.
  const settled = new Set();
  const frontier = [{ key: fromKey, cost: 0 }];

  while (frontier.length) {
    let pick = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i].cost < frontier[pick].cost) pick = i;
    }
    const current = frontier.splice(pick, 1)[0];
    if (settled.has(current.key)) continue;
    settled.add(current.key);
    if (current.key === toKey) break;
    if (current.cost > maxCost) continue;

    for (const link of graph.nodes.get(current.key).links) {
      if (settled.has(link.to)) continue;
      const cost = current.cost + edgeCost(link.edge, link.forward, weights);
      if (cost > maxCost) continue;
      if (cost < (best.get(link.to) ?? Infinity)) {
        best.set(link.to, cost);
        cameFrom.set(link.to, { from: current.key, link });
        frontier.push({ key: link.to, cost });
      }
    }
  }

  if (!best.has(toKey) || !settled.has(toKey)) return null;

  const legs = [];
  const keys = [toKey];
  let key = toKey;
  while (key !== fromKey) {
    const step = cameFrom.get(key);
    if (!step) return null;
    legs.push(legFor(step.link));
    keys.push(step.from);
    key = step.from;
  }
  legs.reverse();
  keys.reverse();
  linkJunctions(legs);
  return {
    keys,
    legs,
    cost: best.get(toKey),
    distance: legs.reduce((sum, leg) => sum + (leg.edge.arcLength || 0), 0),
    // Open ground the traveller covers crossing landmark clearings between
    // edges. Small next to the trail distance, and not optional: it is where a
    // route stops being a sequence of trails and becomes a walk.
    openGroundDistance: legs.reduce((sum, leg) => sum + (leg.gapToNext || 0), 0),
  };
}

/**
 * Measure the open-ground hop between each pair of consecutive legs.
 *
 * Both ends are real positions on real trails; what sits between them is the
 * landmark's cleared halo, which no edge covers.
 */
function linkJunctions(legs) {
  const point = {};
  for (let i = 0; i < legs.length - 1; i++) {
    const leg = legs[i];
    const next = legs[i + 1];
    trailFrameAtArc(leg.edge, leg.endArc, point);
    const endX = point.x, endZ = point.z;
    trailFrameAtArc(next.edge, next.startArc, point);
    leg.gapToNext = Math.hypot(point.x - endX, point.z - endZ);
    leg.junctionX = (endX + point.x) * 0.5;
    leg.junctionZ = (endZ + point.z) * 0.5;
  }
  if (legs.length) legs[legs.length - 1].gapToNext = 0;
}

/**
 * Every landmark reachable from `fromKey` within a cost ceiling, and what each
 * costs to reach.
 *
 * Choosing a destination by picking a random landmark and hoping it is in range
 * does not work: cost is hiking TIME, so a ceiling of a few hours covers a small
 * fraction of a 20km graph and almost every guess is rejected. Ask what is
 * actually within reach and choose from that instead.
 */
export function reachableWithin(graph, fromKey, maxCost = Infinity, weights = undefined) {
  const reached = new Map();
  if (!graph.nodes.has(fromKey)) return reached;
  const best = new Map([[fromKey, 0]]);
  const settled = new Set();
  const frontier = [{ key: fromKey, cost: 0 }];
  while (frontier.length) {
    let pick = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i].cost < frontier[pick].cost) pick = i;
    }
    const current = frontier.splice(pick, 1)[0];
    if (settled.has(current.key)) continue;
    settled.add(current.key);
    if (current.key !== fromKey) reached.set(current.key, current.cost);
    for (const link of graph.nodes.get(current.key).links) {
      if (settled.has(link.to)) continue;
      const cost = current.cost + edgeCost(link.edge, link.forward, weights);
      if (cost > maxCost) continue;
      if (cost < (best.get(link.to) ?? Infinity)) {
        best.set(link.to, cost);
        frontier.push({ key: link.to, cost });
      }
    }
  }
  return reached;
}

/**
 * One edge of a route, expressed the way a walker travels it.
 *
 * `startArc` and `endArc` are arc length along the edge — the same coordinate
 * the crossing solver uses — so a traveller partway across knows whether it is
 * on a bridge without a second representation to keep in step. Walking an edge
 * backwards means counting down.
 */
function legFor(link) {
  const length = link.edge.arcLength || 0;
  return {
    edge: link.edge,
    edgeId: link.edge.id,
    to: link.to,
    forward: link.forward,
    startArc: link.forward ? 0 : length,
    endArc: link.forward ? length : 0,
  };
}

/**
 * Where a traveller stands after covering `travelled` metres of a leg.
 *
 * Returns the arc position and whether the leg is finished, leaving the caller
 * to turn arc into a position with `trailFrameAtArc`. Keeping those apart is
 * what lets this be tested without generating any terrain.
 */
export function advanceLeg(leg, travelled) {
  const length = leg.edge.arcLength || 0;
  const covered = Math.max(0, Math.min(length, travelled));
  return {
    arc: leg.forward ? covered : length - covered,
    done: covered >= length - 1e-6,
    remaining: Math.max(0, length - covered),
  };
}
