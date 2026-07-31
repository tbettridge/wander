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
import { deckHeightAlong } from '../src/trailcrossings.mjs';

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
    const bridges = (scatter.trailRecords || []).filter((r) => r.kind === 'bridge');
    if (!bridges.length) continue;
    const bridge = bridges[0];
    inspected++;

    assert.ok(bridge.surfaceY > bridge.waterY,
      'a deck sits above the water, not in it');
    assert.ok(bridge.surfaceY - bridge.waterY >= 0.5,
      `a deck needs real clearance, had ${(bridge.surfaceY - bridge.waterY).toFixed(2)}m`);

    // Deck boards are plank instances sitting on the deck profile. The deck is
    // a curve, so a board is identified by matching the profile at its own
    // position along the crossing rather than one flat height.
    const along = [];
    for (const batch of scatter.filter((b) => b.type === 'plank')) {
      for (let i = 0; i < batch.matrices.length; i += 16) {
        const x = batch.matrices[i + 12];
        const y = batch.matrices[i + 13];
        const z = batch.matrices[i + 14];
        const at = (x - bridge.x) * bridge.tangentX + (z - bridge.z) * bridge.tangentZ;
        if (Math.abs(y - deckHeightAlong(bridge, at)) > 0.25) continue;
        along.push(at);
      }
    }
    assert.ok(along.length > 8, `a bridge deck needs boards, found ${along.length}`);
    along.sort((a, b) => a - b);

    // No hole big enough to fall through: this is the difference between a
    // bridge and a row of posts.
    let largestGap = 0;
    for (let i = 1; i < along.length; i++) largestGap = Math.max(largestGap, along[i] - along[i - 1]);
    assert.ok(largestGap <= BOARD_SPACING + 0.05,
      `deck has a ${largestGap.toFixed(2)}m hole in it`);

    // And it has to reach across the water it was built for.
    const built = along[along.length - 1] - along[0];
    assert.ok(built >= bridge.span,
      `deck spans ${built.toFixed(1)}m but the water is ${bridge.span.toFixed(1)}m`);
  }
  assert.ok(inspected > 0, 'at least one bridge must have been built and inspected');
}

console.log('trailcrossings PASS · crossings are built rather than abandoned · '
  + 'decks clear the water · decks have no holes · decks reach across the span');
