// Where a village's horses are allowed to stand.
//
// The rule the siting has to keep is narrow and absolute: a horse is in the
// square or out on the common, and never inside a building. The bug this
// guards against was a uniform pick inside the settlement halo, which put
// horses in front rooms and — because the halo dwarfs the village — put most of
// the rest in an empty field a long way from anything.

import assert from 'node:assert/strict';
import {
  HORSE_CLEARANCE, OUTSIDE_MARGIN, PASTURE_BAND, builtRadius, groundIsClear,
  resolveHorseGround,
} from '../src/horsepasture.mjs';
import { PROP_KIND } from '../src/settlementprops.mjs';

const site = { id: 'v', x: 1000, z: -500, radius: 160 };

// A ring of houses at 40m, a well and two stalls in the square.
const buildings = [];
for (let i = 0; i < 8; i++) {
  const angle = (i / 8) * Math.PI * 2;
  buildings.push({
    id: `b${i}`,
    x: site.x + Math.cos(angle) * 40,
    z: site.z + Math.sin(angle) * 40,
    yaw: angle,
    width: 10, depth: 8,
  });
}
const plan = {
  buildings,
  props: [
    { kind: PROP_KIND.well, x: site.x, z: site.z },
    { kind: PROP_KIND.stall, x: site.x + 6, z: site.z + 4 },
    // A bench is passable on purpose, so it must NOT block a horse either.
    { kind: PROP_KIND.bench, x: site.x - 9, z: site.z + 2 },
  ],
  square: { id: 'v:square', x: site.x, z: site.z, radius: 26, yaw: 0 },
};

const distanceTo = (p) => Math.hypot(p.x - site.x, p.z - site.z);
const insideAnyBuilding = (p) => !groundIsClear(plan, p.x, p.z, 0);

// --- the built radius covers the walls, not just the origins ------------------
{
  const reach = builtRadius(plan, site);
  assert.ok(reach > 40, `reach must clear the far wall, not stop at the centre (${reach})`);
  assert.ok(reach < 40 + 10, 'and must not be wildly generous');
}

// --- no horse ever stands in a house ------------------------------------------
{
  // Sweep candidate points across the whole village and its surroundings,
  // including points dead inside the houses, and check every resolution.
  let inSquare = 0, onCommon = 0, refused = 0, checked = 0;
  for (let i = 0; i < 400; i++) {
    const angle = (i / 400) * Math.PI * 2 * 7;
    const distance = (i / 400) * 220;
    const x = site.x + Math.cos(angle) * distance;
    const z = site.z + Math.sin(angle) * distance;
    const roll = (i * 0.0177) % 1;
    const spot = resolveHorseGround(plan, site, x, z, roll);
    if (!spot) { refused++; continue; }
    checked++;
    assert.ok(!insideAnyBuilding(spot),
      `resolved into a building at ${spot.x.toFixed(1)},${spot.z.toFixed(1)}`);
    assert.ok(groundIsClear(plan, spot.x, spot.z),
      'resolved somewhere without room to stand');
    if (spot.where === 'square') inSquare++; else onCommon++;
  }
  assert.equal(refused, 0, 'a village with open ground around it should never refuse');
  assert.ok(inSquare > 0, 'some horses should end up in the square');
  assert.ok(onCommon > 0, 'and most out on the common');
  assert.ok(inSquare < checked * 0.6, 'the square is not a horse fair');
}

// --- the two bands are the ONLY places a horse ends up -------------------------
{
  const reach = builtRadius(plan, site);
  for (let i = 0; i < 200; i++) {
    const angle = (i / 200) * Math.PI * 2 * 3;
    const x = site.x + Math.cos(angle) * (i % 190);
    const z = site.z + Math.sin(angle) * (i % 190);
    const spot = resolveHorseGround(plan, site, x, z, (i * 0.031) % 1);
    const d = distanceTo(spot);
    if (spot.where === 'square') {
      assert.ok(d < plan.square.radius,
        `a square horse must be in the square (${d.toFixed(1)}m from the well)`);
    } else {
      assert.ok(d >= reach + OUTSIDE_MARGIN - 1e-6,
        `a common horse must be past the last building (${d.toFixed(1)} vs ${(reach + OUTSIDE_MARGIN).toFixed(1)})`);
      // Not banished to the horizon either — the whole point is being able to
      // see the village's horses from the village.
      assert.ok(d <= reach + OUTSIDE_MARGIN + PASTURE_BAND + 90,
        `a common horse wandered off to ${d.toFixed(1)}m`);
    }
  }
}

// --- horses keep out of the well and the stalls --------------------------------
{
  assert.equal(groundIsClear(plan, site.x, site.z), false, 'the well is not standing room');
  assert.equal(groundIsClear(plan, site.x + 6, site.z + 4), false, 'nor is a stall');
  assert.ok(groundIsClear(plan, site.x + 300, site.z + 300), 'open country is');
}

// --- the same cell resolves the same way every time -----------------------------
{
  const a = resolveHorseGround(plan, site, site.x + 12, site.z - 3, 0.21);
  const b = resolveHorseGround(plan, site, site.x + 12, site.z - 3, 0.21);
  assert.deepEqual(a, b, 'siting must be stable or horses teleport as you walk away');
}

// --- a scattered horse already standing well is left where it is -----------------
{
  const reach = builtRadius(plan, site);
  const good = { x: site.x + reach + OUTSIDE_MARGIN + 10, z: site.z };
  const spot = resolveHorseGround(plan, site, good.x, good.z, 0.9);
  assert.equal(+spot.x.toFixed(4), +good.x.toFixed(4), 'a good spot should be kept');
  assert.equal(+spot.z.toFixed(4), +good.z.toFixed(4));
}

// --- a settlement with no square still works --------------------------------------
{
  const hamlet = { ...plan, square: null };
  for (let i = 0; i < 60; i++) {
    const spot = resolveHorseGround(hamlet, site, site.x + i, site.z - i, (i * 0.017) % 1);
    assert.ok(spot, 'a squareless hamlet must still site its horses');
    assert.equal(spot.where, 'common');
    assert.ok(!insideAnyBuilding(spot));
  }
}

// --- clearance is real, not nominal -------------------------------------------------
{
  const wall = buildings[0];
  assert.ok(HORSE_CLEARANCE > 1, 'a horse is not a point');
  assert.equal(groundIsClear(plan, wall.x, wall.z), false);
}

console.log('horse pasture ok · square or common · never inside a building');
