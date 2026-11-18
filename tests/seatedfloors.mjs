// Villagers sit, sleep and stand on the floor of the room they are in.
//
// The playtest bot once reported people in an inn sitting at upstairs height
// in the rooms below. It did not happen again on main, so this keeps it that
// way. Every multi-storey building with an interior, in villages from several
// world seeds and on sloping ground, is checked three ways:
//
// 1. Each inside spot is planned at its own room's floor, on its own storey.
// 2. The walkable surface a resident is grounded on every frame
//    (groundSettlementNpc) keeps someone standing on that spot at that height,
//    rather than lifting them onto the deck above or dropping them below.
// 3. Someone walking from a seat or bed upstairs to a seat downstairs, and
//    back up, by the game's own interior route and grounding, ends on the
//    floor of the seat they walked to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { settlementForCell } from '../src/settlementplacement.mjs';
import { createSettlementPlan } from '../src/settlementplan.mjs';
import { planVenues } from '../src/npcvenues.mjs';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import { routeInterior } from '../src/interiorplan.mjs';
import { interiorBaseY } from '../src/interiorarchitecture.mjs';
import { groundSettlementNpc } from '../src/settlementnpcgrounding.mjs';

const TOLERANCE = 0.05;

// Gentle, rolling and steep ground, so pads are both built up and cut into hills.
const GROUNDS = [
  { seed: 991, height: (x, z) => 16 + Math.sin(x * 0.0002) + Math.cos(z * 0.0003), slope: 0.035 },
  { seed: 4127, height: (x, z) => 22 + Math.sin(x * 0.011) * 1.6 + Math.cos(z * 0.009) * 1.3, slope: 0.08 },
  { seed: 20260612, height: (x, z) => 30 + x * 0.045 + Math.sin(z * 0.02) * 1.1, slope: 0.12 },
];

function worldFor({ seed, height, slope }) {
  return {
    seed, height,
    biomeAt(x, z) { return { h: height(x, z), slope, m: 0.6, t: 12, id: 'grassland' }; },
    riverAt() { return { wet: false }; },
  };
}

function surfaceFor(world, plan) {
  const surface = new WalkableSurface({ ...world, railwayTerrain: null, generationVersion: 0 });
  surface.crossingsAt = () => [];   // no trails in these villages, only buildings
  surface.registerClaims(plan.claims);
  return surface;
}

/** Villages with at least one building of more than one storey, a few per ground. */
function corpus() {
  const out = [];
  for (const ground of GROUNDS) {
    const world = worldFor(ground);
    let villages = 0;
    for (let j = -6; j <= 6 && villages < 4; j++) for (let i = -6; i <= 6 && villages < 4; i++) {
      const site = settlementForCell(world, i, j, world.seed);
      if (!site) continue;
      const plan = createSettlementPlan(site, { heightAt: world.height });
      const tall = plan.buildings.filter((b) => b.interior?.levels.length > 1);
      if (!tall.length) continue;
      villages++;
      out.push({ ground, world, plan, tall, venues: planVenues(plan), surface: surfaceFor(world, plan) });
    }
  }
  return out;
}

const villages = corpus();

test('the corpus has multi-storey inns, houses and workshops with seats and beds on both floors', () => {
  const programs = new Set(villages.flatMap((v) => v.tall.map((b) => b.program)));
  for (const program of ['inn', 'dwelling']) assert.ok(programs.has(program), `no two-storey ${program} in the corpus`);
  const seats = villages.flatMap((v) => v.tall.flatMap((b) => v.venues.buildings[b.id].inside))
    .filter((spot) => spot.furniturePose);
  assert.ok(seats.some((s) => s.furniturePose.kind === 'sit' && !s.floor), 'no seat downstairs');
  assert.ok(seats.some((s) => s.furniturePose.kind === 'sleep' && s.floor), 'no bed upstairs');
  assert.ok(new Set(villages.map((v) => v.ground.seed)).size === GROUNDS.length, 'a ground with no tall buildings');
});

test('every inside spot is planned on the floor of its own room', () => {
  let checked = 0;
  for (const { plan, tall, venues } of villages) for (const building of tall) {
    const base = interiorBaseY(building);
    const rooms = new Map(building.interior.rooms.map((room) => [room.id, room]));
    for (const spot of venues.buildings[building.id].inside) {
      const room = rooms.get(spot.roomId);
      assert.ok(room, `${spot.id} names no room of ${building.id}`);
      assert.equal(spot.floor ?? 0, room.floor, `${spot.id} is on another storey from its room (${plan.site.id})`);
      assert.ok(Math.abs(spot.y - (base + room.y)) < TOLERANCE,
        `${spot.id} is at ${spot.y.toFixed(2)}, its room's floor is ${(base + room.y).toFixed(2)}`);
      checked++;
    }
  }
  assert.ok(checked > 200, `only ${checked} spots checked`);
});

test('grounding keeps a villager on a seat or bed at that floor, upstairs and down', () => {
  let checked = 0;
  for (const { tall, venues, surface } of villages) for (const building of tall) {
    for (const spot of venues.buildings[building.id].inside) {
      const position = { x: spot.x, y: spot.y, z: spot.z };
      // Every frame for a few seconds: a held height that creeps would show here.
      for (let frame = 0; frame < 30; frame++) groundSettlementNpc(position, surface);
      assert.ok(Math.abs(position.y - spot.y) < TOLERANCE,
        `${spot.id} (${spot.furniturePose?.kind || 'standing'}, floor ${spot.floor ?? 0}) grounds to ${position.y.toFixed(2)}, not ${spot.y.toFixed(2)}`);
      checked++;
    }
  }
  assert.ok(checked > 200, `only ${checked} spots checked`);
});

/** Walk the game's interior route in fixed steps, grounding after each one as the game does. */
function walk(building, surface, from, to, step) {
  const points = [...routeInterior(building, from, to), to];
  const position = { x: from.x, y: from.y, z: from.z };
  for (const target of points) {
    for (let k = 0; k < 2000; k++) {
      const dx = target.x - position.x, dz = target.z - position.z, d = Math.hypot(dx, dz);
      if (d < 0.05) break;
      const s = Math.min(step, d);
      position.x += dx / d * s; position.z += dz / d * s;
      groundSettlementNpc(position, surface);
    }
  }
  return position;
}

test('walking between a seat or bed upstairs and a seat downstairs ends on the right floor', () => {
  let walks = 0;
  for (const { tall, venues, surface } of villages) for (const building of tall) {
    const inside = venues.buildings[building.id].inside;
    const up = inside.filter((s) => s.floor && s.furniturePose).slice(0, 3);
    const down = inside.filter((s) => !s.floor && s.furniturePose).slice(0, 3);
    for (const a of up) for (const b of down) {
      // A short step, and the long one a distant villager takes when updated every fourth frame.
      for (const step of [0.1, 0.5]) {
        const below = walk(building, surface, a, b, step);
        assert.ok(Math.abs(below.y - b.y) < TOLERANCE,
          `${a.id} -> ${b.id} (step ${step}) ends at ${below.y.toFixed(2)}, the seat's floor is ${b.y.toFixed(2)}`);
        const above = walk(building, surface, { ...b, y: below.y }, a, step);
        assert.ok(Math.abs(above.y - a.y) < TOLERANCE,
          `${b.id} -> ${a.id} (step ${step}) ends at ${above.y.toFixed(2)}, the floor upstairs is ${a.y.toFixed(2)}`);
        walks++;
      }
    }
  }
  assert.ok(walks > 50, `only ${walks} walks`);
});
