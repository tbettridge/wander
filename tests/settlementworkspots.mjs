import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { settlementForCell } from '../src/settlementplacement.mjs';
import { createSettlementPlan } from '../src/settlementplan.mjs';
import { planVenues } from '../src/npcvenues.mjs';
import { ACTIVITY } from '../src/npcdayplan.mjs';

// settlementstream.js needs three, so the spot chooser is lifted from its
// source and run on a real generated village's venues.
const source = await readFile(new URL('../src/settlementstream.js', import.meta.url), 'utf8');
const pool = source.slice(source.indexOf('const SPOT_FALLBACK'), source.indexOf('/** How long someone stays on one spot'))
  + source.slice(source.indexOf('function spotPool('), source.indexOf('\nfunction doorLegs('));
const choose = source.slice(source.indexOf('  _chooseSpot(current, resident, block'), source.indexOf('\n  /** Waypoints from where the resident is to `spot`'));
const System = vm.runInNewContext(`${pool}\n(class {${choose}})`, {});

const world = {
  seed: 991,
  height(x, z) { return 16 + Math.sin(x * 0.0002) + Math.cos(z * 0.0003); },
  biomeAt(x, z) { return { h: this.height(x, z), slope: 0.035, m: 0.6, t: 12, id: 'grassland' }; },
  riverAt() { return { wet: false }; },
};

/** A village whose inn has guest beds upstairs and no desk or bench to work at, like Dale's Inn. */
function innWithoutDesk() {
  for (let j = -6; j <= 6; j++) for (let i = -6; i <= 6; i++) {
    const site = settlementForCell(world, i, j, world.seed);
    if (!site) continue;
    const plan = createSettlementPlan(site, { heightAt: world.height.bind(world) });
    const inn = plan.buildings.find((building) => building.program === 'inn');
    if (!inn) continue;
    const venues = planVenues(plan), inside = venues.buildings[inn.id].inside;
    if (inside.some((spot) => spot.furnitureAction === 'work' || spot.furnitureAction === 'read')) continue;
    if (!inside.some((spot) => spot.furnitureAction === 'sleep')) continue;
    return { plan, inn, venues };
  }
  throw new Error('No inn without a desk in the test corpus.');
}

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('an innkeeper at work keeps to the bar, kitchen and stores, never the guest beds', () => {
  const { inn, venues } = innWithoutDesk();
  const system = new System();
  const current = { venues, spotOwners: new Map(), residents: [] };
  const block = { start: 10, end: 18, activity: 'work', ...ACTIVITY.work };
  const chosen = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    const innkeeper = { actorId: `innkeeper:${seed}`, homeBuildingId: inn.id, day: { workplaceId: inn.id }, emote: { rng: rng(seed) } };
    const spot = system._chooseSpot(current, innkeeper, block);
    assert.ok(spot, 'the innkeeper has somewhere to work');
    assert.notEqual(spot.purpose, 'sleeping', `${spot.id} is in a bedroom`);
    assert.notEqual(spot.furnitureAction, 'sleep', `${spot.id} is a bed`);
    assert.equal(spot.floor ?? 0, 0, `${spot.id} is upstairs`);
    chosen.add(spot.id);
  }
  assert.ok(chosen.size > 1, 'the working day still moves between rooms');
});

test('the same inn is still slept in at night', () => {
  const { inn, venues } = innWithoutDesk();
  const system = new System();
  const current = { venues, spotOwners: new Map(), residents: [] };
  const block = { start: 0, end: 8, activity: 'sleep', ...ACTIVITY.sleep };
  const guest = { actorId: 'guest', homeBuildingId: inn.id, day: {}, emote: { rng: rng(7) } };
  assert.equal(system._chooseSpot(current, guest, block).furnitureAction, 'sleep');
});
