// A village day has a rhythm: busy mornings, a working day, a market that
// peaks and empties, an inn that fills in the evening, quiet nights.

import assert from 'node:assert/strict';
import test from 'node:test';
import { blockAt, dayPlanFor, gatheringTonight, MARKET_HOURS } from '../src/npcdayplan.mjs';
import { shiftFor } from '../src/npcroutine.mjs';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from '../src/railwayterrain.mjs';
import { clearStationSettlementCache, stationSettlements } from '../src/stationsettlement.mjs';
import { createSettlementPlan, pointInsideBuilding } from '../src/settlementplan.mjs';
import { settlementBuildBlocker } from '../src/settlementspatial.mjs';
import { settlementOrigin } from '../src/settlementorigin.mjs';
import { planVenues } from '../src/npcvenues.mjs';

const KINDS = ['smithy', 'workshop', 'barn', 'hall', 'granary'];
function village(gathering = false) {
  return { settlementId: 'v', hasMarket: true, hasInn: true, hasChurch: true, gathering };
}
function people(count = 240) {
  const roles = ['worker', 'worker', 'worker', 'home', 'home', 'home', 'merchant', 'innkeeper'];
  return Array.from({ length: count }, (_, i) => {
    const role = roles[i % roles.length];
    const actorId = `npc:${i}`;
    const workKind = KINDS[i % KINDS.length];
    return {
      actorId, role, ageBand: i % 11 === 0 ? 'elder' : i % 13 === 0 ? 'youth' : 'adult',
      workKind, shift: role === 'worker' ? (() => { const s = shiftFor(actorId, workKind); return { start: s.start, end: s.end }; })() : null,
    };
  });
}

test('every plan covers the whole day without gaps', () => {
  for (const day of [0, 1, 6]) for (const person of people(80)) {
    const blocks = dayPlanFor(person, village(day === 1), day);
    let t = 0;
    for (const block of blocks) {
      assert.ok(Math.abs(block.start - t) < 1e-9, `${person.actorId} day ${day}: a gap at ${t}`);
      assert.ok(block.end > block.start, `${person.actorId}: an empty block`);
      t = block.end;
    }
    assert.equal(t, 24);
  }
});

test('nights are spent indoors', () => {
  const plans = people().map((person) => dayPlanFor(person, village(), 2));
  for (const hour of [23.7, 1, 3, 4.5]) {
    const indoors = plans.filter((blocks) => blockAt(blocks, hour).indoor).length / plans.length;
    assert.ok(indoors >= 0.9, `${Math.round(indoors * 100)}% indoors at ${hour}h`);
  }
});

test('the market is busy in the day and empty at night', () => {
  const plans = people().map((person) => dayPlanFor(person, village(), 3));
  const at = (hour) => plans.filter((blocks) => ['market', 'stall'].includes(blockAt(blocks, hour).activity)).length;
  assert.ok(at(10) > at(14), `mid-morning (${at(10)}) should beat mid-afternoon (${at(14)})`);
  assert.ok(at(10) >= 30, `a thin market at ten: ${at(10)}`);
  assert.equal(at(MARKET_HOURS.close + 1), 0, 'the market should be shut by evening');
  assert.equal(at(2), 0, 'and empty at night');
});

test('the inn fills in the evening', () => {
  const plans = people().map((person) => dayPlanFor(person, village(), 4));
  const at = (hour) => plans.filter((blocks) => ['inn', 'inn-out'].includes(blockAt(blocks, hour).activity)).length;
  assert.ok(at(20.5) > at(12.2) * 2, `evening ${at(20.5)} vs midday ${at(12.2)}`);
  assert.ok(at(20.5) > 20, `a quiet inn: ${at(20.5)}`);
  assert.ok(at(3) === 0, 'and shut at three in the morning');
});

test('nobody sets off in lockstep', () => {
  // A station village's worth of people.
  const plans = people(45).map((person) => ({ person, blocks: dayPlanFor(person, village(), 5) }));
  const departures = new Map();
  for (const { person, blocks } of plans) {
    if (person.role !== 'worker') continue;
    const work = blocks.find((block) => block.venue === 'work');
    if (!work) continue;
    const minute = Math.round(work.start * 60);
    departures.set(minute, (departures.get(minute) || 0) + 1);
  }
  const worst = Math.max(...departures.values());
  assert.ok(worst <= 2, `${worst} workers left for work in the same minute`);
});

test('gatherings come about one night in six', () => {
  let nights = 0;
  for (let day = 0; day < 600; day++) if (gatheringTonight('station-settlement:3', day)) nights++;
  assert.ok(nights > 70 && nights < 130, `${nights} gatherings in 600 nights`);
  const plans = people().map((person) => dayPlanFor(person, village(true), 6));
  const gathered = plans.filter((blocks) => blockAt(blocks, 20.5).activity === 'gathering').length;
  assert.ok(gathered > 40, `only ${gathered} at the gathering`);
});

test('every activity spot is somewhere a person can stand', () => {
  clearStationSettlementCache();
  const world = new World(20260612);
  const railway = planRegionalRailway(world, {
    center: { x: 0, z: 0 }, seed: world.seed ^ 0x5241494c, stationCount: 5, radius: 2600, searchRadius: 5200, exclusions: [],
  });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(railway));
  let checked = 0;
  for (const site of stationSettlements(world, world.seed).slice(0, 3)) {
    const plan = createSettlementPlan(site, {
      heightAt: (x, z) => world.height(x, z), blockedAt: settlementBuildBlocker(world, site), origin: settlementOrigin(world, site),
    });
    const venues = planVenues(plan);
    const nodes = new Set(plan.localGraph.nodes.map((node) => node.key));
    const all = [
      ...Object.values(venues.buildings).flatMap((spots) => Object.values(spots).flat()),
      ...(venues.market?.stalls.flatMap((stall) => [stall.merchant, ...stall.customers]) || []),
      ...venues.gathering, ...venues.stroll, ...(venues.inn?.cluster || []),
    ];
    for (const spot of all) {
      checked++;
      assert.ok(Number.isFinite(spot.x) && Number.isFinite(spot.z) && Number.isFinite(spot.yaw), `${spot.id} is not placed`);
      assert.ok(nodes.has(spot.nodeKey), `${spot.id} has no way onto the paths`);
      const host = spot.buildingId ? plan.buildings.find((b) => b.id === spot.buildingId) : null;
      if (spot.indoor) {
        assert.ok(pointInsideBuilding(host, spot.x, spot.z, -0.2), `${spot.id} is meant to be indoors`);
      } else {
        for (const building of plan.buildings) {
          assert.ok(!pointInsideBuilding(building, spot.x, spot.z, 0.15), `${spot.id} stands inside ${building.id}`);
        }
      }
    }
    for (const home of venues.homes) {
      assert.ok(venues.buildings[home].inside.length >= 2, `${home} has nowhere to be inside`);
    }
  }
  assert.ok(checked > 500, `only ${checked} spots`);
});
