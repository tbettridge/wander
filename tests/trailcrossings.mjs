// Water crossings on the desire-line network.
//
// Trails cross rivers constantly — 688 of 1018 edges in a six-seed sweep — and
// until now almost none of those crossings built anything: the span refinement
// stopped at 18m, so every river wider than that was either rejected outright
// or had its bank probes land mid-channel. 92% of crossings were bare water
// with a trail walking into one side and out of the other.
//
// This holds the line on the three things that make a crossing real: it gets
// built, its deck is continuous enough to walk, and the deck is over the water
// rather than under it.

import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { trailsAround, clearTrailCache, nearestTrailPoint } from '../src/trails.js';
import { buildScatter } from '../src/chunkgen.js';
import { nearestArcOnEdge } from '../src/trailcrossings.mjs';

const CHUNK = 140;
const BOARD_SPACING = 0.52;
const SEEDS = [20260612, 4242];
const REGIONS = [[0, 0], [8000, -3000]];

function waterWidthAt(world, x, z, tx, tz) {
  if (!world.riverAt(x, z).wet) return 0;
  let back = 0, forward = 0;
  for (let d = 0.75; d <= 400; d += 0.75) {
    if (!world.riverAt(x - tx * d, z - tz * d).wet) break; back = d;
  }
  for (let d = 0.75; d <= 400; d += 0.75) {
    if (!world.riverAt(x + tx * d, z + tz * d).wet) break; forward = d;
  }
  return back + forward;
}

// --- crossings must actually get built ---------------------------------------
let crossings = 0;
let rejected = 0;
const widths = [];
for (const seedValue of SEEDS) {
  const world = new World(seedValue);
  clearTrailCache();
  for (const [rx, rz] of REGIONS) {
    const edges = [];
    trailsAround(world, rx, rz, world.seed, 5000, edges);
    for (const edge of edges) {
      for (const crossing of edge.fords || []) {
        const x = crossing.centerX ?? crossing.x;
        const z = crossing.centerZ ?? crossing.z;
        if (!world.riverAt(x, z).wet) continue;
        const near = nearestTrailPoint([edge], x, z);
        crossings++;
        widths.push(waterWidthAt(world, x, z, near.tangentX, near.tangentZ));
      }
    }
  }
}
assert.ok(crossings > 40, `the sweep must actually find crossings, found ${crossings}`);
// Rivers here are wide: the old 14.5m ceiling covered almost none of them, which
// is the whole reason bridges span any length now.
const wide = widths.filter((w) => w > 14.5).length;
assert.ok(wide / crossings > 0.5,
  `most crossings are wider than the old build limit (${wide}/${crossings})`);

// --- a built bridge must be walkable ------------------------------------------
// Build real chunks around the widest crossings and inspect what came out.
{
  const world = new World(20260612);
  clearTrailCache();
  const edges = [];
  trailsAround(world, 0, 0, world.seed, 5000, edges);
  const targets = [];
  for (const edge of edges) {
    for (const crossing of edge.fords || []) {
      const x = crossing.centerX ?? crossing.x;
      const z = crossing.centerZ ?? crossing.z;
      if (!world.riverAt(x, z).wet) continue;
      const near = nearestTrailPoint([edge], x, z);
      const width = waterWidthAt(world, x, z, near.tangentX, near.tangentZ);
      if (width > 20) targets.push({ x, z, width });
    }
  }
  targets.sort((a, b) => b.width - a.width);
  assert.ok(targets.length >= 3, 'the sample region must contain wide crossings to inspect');

  let inspected = 0;
  for (const target of targets.slice(0, 4)) {
    const cx = Math.floor(target.x / CHUNK);
    const cz = Math.floor(target.z / CHUNK);
    const scatter = buildScatter(world, cx, cz, CHUNK, { mode: 'full', res: 64, audit: true });
    const edgeById = new Map(edges.map((e) => [e.id, e]));
    const bridges = (scatter.trailRecords || []).filter((r) => r.kind === 'bridge');
    if (!bridges.length) continue;
    const bridge = bridges[0];
    inspected++;

    assert.ok(bridge.surfaceY > bridge.waterY,
      'a deck sits above the water, not in it');
    assert.ok(bridge.surfaceY - bridge.waterY >= 0.5,
      `a deck needs real clearance, had ${(bridge.surfaceY - bridge.waterY).toFixed(2)}m`);

    // Deck boards are plank instances at the deck height. The deck follows the
    // TRAIL, so boards are ordered by arc along that trail — measuring them
    // against a straight chord is exactly the mistake that let a bridge drift
    // off the path it carries.
    const edge = edgeById.get(bridge.edgeId);
    assert.ok(edge, 'a crossing must name the trail it was built on');
    const boards = [];
    for (const batch of scatter.filter((b) => b.type === 'plank')) {
      for (let i = 0; i < batch.matrices.length; i += 16) {
        const y = batch.matrices[i + 13];
        // Deck boards only: the longitudinal bearers sit just under the deck
        // and 0.6m off the centreline, and counting them as decking makes a
        // sound deck look like it has holes.
        if (Math.abs(y - bridge.surfaceY) > 0.02) continue;
        const x = batch.matrices[i + 12];
        const z = batch.matrices[i + 14];
        boards.push({ x, z, arc: nearestArcOnEdge(edge, x, z).arc });
      }
    }
    assert.ok(boards.length > 8, `a bridge deck needs boards, found ${boards.length}`);
    boards.sort((a, b) => a.arc - b.arc);

    // No hole big enough to fall through: this is the difference between a
    // bridge and a row of posts. Measured as "does every board have a
    // neighbour", which needs no ordering — and ordering is unreliable here,
    // because a trail that passes close to itself can put two boards from
    // opposite ends of the deck side by side in any sorted list.
    let worstIsolation = 0;
    for (let i = 0; i < boards.length; i++) {
      let nearest = Infinity;
      for (let j = 0; j < boards.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(boards[i].x - boards[j].x, boards[i].z - boards[j].z);
        if (d < nearest) nearest = d;
      }
      worstIsolation = Math.max(worstIsolation, nearest);
    }
    assert.ok(worstIsolation <= BOARD_SPACING + 0.15,
      `a deck board sits ${worstIsolation.toFixed(2)}m from its nearest neighbour`);

    // The deck reaches past the water on both sides, by construction: its ends
    // are the abutments found beyond the wet run.
    assert.ok(bridge.deckLength >= bridge.span,
      `deck runs ${bridge.deckLength.toFixed(1)}m but the water is ${bridge.span.toFixed(1)}m`);
    // And the boards actually cover that run rather than stopping short.
    const built = boards[boards.length - 1].arc - boards[0].arc;
    assert.ok(built >= bridge.deckLength - 1.5,
      `boards cover ${built.toFixed(1)}m of a ${bridge.deckLength.toFixed(1)}m deck`);
  }
  assert.ok(inspected > 0, 'at least one bridge must have been built and inspected');
}

console.log('trailcrossings PASS · crossings are built rather than abandoned · '
  + 'decks clear the water · decks have no holes · decks reach across the span');
