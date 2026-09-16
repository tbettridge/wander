import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { descriptorHash } from '../src/hydrologyformat.mjs';
import { captureTravelLandscape, adoptTravelLandscape } from '../src/landscapetravel.mjs';

function regional(seed) {
  const plans = [];
  for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
    const p = { version: 1, generationVersion: 3, regional: 1, preview: true, seed, regionX: x, regionZ: z, basins: [], components: [] };
    plans.push({ ...p, hash: descriptorHash(p) });
  }
  const stream = { seed, disposed: false, active: { regionX: 0, regionZ: 0 }, dispose() { this.disposed = true; } };
  return { world: new World(seed, { waterPlans: plans }), stream };
}

test('legacy home returns unchanged after a verified regional visit and guest stream is released', () => {
  const world = new World(7), identity = world, height = world.height(100, 200);
  const home = captureTravelLandscape(world), guest = regional(42);
  const stream = adoptTravelLandscape(world, 42, guest);
  assert.equal(world, identity); assert.equal(world.generationVersion, 3);
  assert.equal(world.waterPlanHash, guest.world.waterPlanHash);
  assert.equal(adoptTravelLandscape(world, 7, home, { currentStream: stream }), null);
  assert.equal(world.height(100, 200), height); assert.equal(world.generationVersion, 2);
  assert.equal(stream.disposed, true); assert.equal(world.waterField, undefined);
});

test('a regional home keeps its one retained stream and resumes its exact generation after a visit', () => {
  const homeWorld = regional(42), active = homeWorld.world;
  const snapshot = captureTravelLandscape(active, homeWorld.stream), hash = active.waterPlanHash;
  const guest = regional(99);
  const guestStream = adoptTravelLandscape(active, 99, guest, { currentStream: homeWorld.stream, retainedStream: snapshot.stream });
  assert.equal(snapshot.world.seed, 42); assert.equal(snapshot.world.waterPlanHash, hash);
  assert.equal(homeWorld.stream.disposed, false);
  assert.equal(adoptTravelLandscape(active, 42, snapshot, { currentStream: guestStream }), homeWorld.stream);
  assert.equal(active.waterPlanHash, hash); assert.equal(active.generationVersion, 3);
  assert.equal(guestStream.disposed, true); assert.equal(homeWorld.stream.disposed, false);
});

test('failed travel validation leaves the current world and stream untouched', () => {
  const home = regional(42), hash = home.world.waterPlanHash;
  for (const bad of [regional(99), { ...regional(42), stream: null }, { world: new World(42), stream: { seed: 42, disposed: true } }]) {
    assert.throws(() => adoptTravelLandscape(home.world, 42, bad, { currentStream: home.stream }), /Travel|Regional/);
    assert.equal(home.world.waterPlanHash, hash); assert.equal(home.stream.disposed, false);
  }
});
