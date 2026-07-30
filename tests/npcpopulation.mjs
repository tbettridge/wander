import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNpcIdentity,
  createStationPopulation,
  NPC_STATION_SLOTS,
  npcHipHeight,
  planNpcPopulation,
  sampleNpcMotion,
  stableNpcSeed,
} from '../src/npcpopulation.mjs';

const station = {
  id: 'station-wren',
  index: 0,
  name: 'Wren Halt',
  x: 100,
  z: -40,
  y: 12,
  formationY: 11.5,
  tangentX: 0.8,
  tangentZ: 0.6,
};

test('NPC identities are deterministic for a world, station, and slot', () => {
  const slot = NPC_STATION_SLOTS[1];
  const first = createNpcIdentity({ worldSeed: 17, stationId: station.id, stationName: station.name, slot });
  const second = createNpcIdentity({ worldSeed: 17, stationId: station.id, stationName: station.name, slot });
  assert.deepEqual(first, second);
  assert.equal(first.seed, stableNpcSeed(17, station.id, slot.key));
});

test('different stable slots produce distinct residents', () => {
  const keeper = createNpcIdentity({
    worldSeed: 17, stationId: station.id, stationName: station.name, slot: NPC_STATION_SLOTS[0],
  });
  const porter = createNpcIdentity({
    worldSeed: 17, stationId: station.id, stationName: station.name, slot: NPC_STATION_SLOTS[1],
  });
  assert.notEqual(keeper.id, porter.id);
  assert.notEqual(keeper.seed, porter.seed);
  assert.equal(keeper.family, 'cloaked');
  assert.equal(porter.family, 'storybook');
});

test('a station roster is varied, unique, and remains on its platforms', () => {
  const population = createStationPopulation(station, 81, { count: 6 });
  assert.equal(population.length, 6);
  assert.equal(population.filter((npc) => npc.identity.role === 'station keeper').length, 1);
  assert.deepEqual(new Set(population.map((npc) => npc.identity.family)), new Set(['cloaked', 'storybook']));
  assert.equal(new Set(population.map((npc) => npc.id)).size, population.length);
  const keeper = population.find((npc) => npc.identity.role === 'station keeper');
  // The railway debug arrival is at local (along 0, across 7). Keep the first
  // resident inside the interaction radius so the feature is discoverable.
  assert.ok(Math.hypot(keeper.along, keeper.across - 7) <= 6.5);
  assert.ok(keeper.across + 0.75 < 3.6, 'the full cloak must clear the building wall');

  for (const npc of population) {
    assert.ok(Number.isFinite(npc.along));
    assert.ok(Number.isFinite(npc.across));
    if (npc.across > 0) {
      assert.ok(npc.along >= -20.5 && npc.along <= 20.5);
      assert.ok(npc.across >= 1.45 && npc.across <= 5.35);
    } else {
      assert.ok(npc.along >= -16.5 && npc.along <= 16.5);
      assert.ok(npc.across >= -4.8 && npc.across <= -1.8);
    }
  }

  for (let i = 0; i < population.length; i++) {
    for (let j = i + 1; j < population.length; j++) {
      assert.ok(Math.hypot(
        population[i].along - population[j].along,
        population[i].across - population[j].across,
      ) > 3, 'authored residents must not overlap');
    }
  }
});

test('station ordering does not change generated identities', () => {
  const other = { ...station, id: 'station-ash', index: 1, name: 'Ash Gate', x: -300 };
  const forward = planNpcPopulation([station, other], 42, { count: 4 });
  const reverse = planNpcPopulation([other, station], 42, { count: 4 });
  const profile = (items, id) => items.find((npc) => npc.id === id).identity;
  assert.deepEqual(
    profile(forward, 'npc:station-wren:porter'),
    profile(reverse, 'npc:station-wren:porter'),
  );
});

test('profile proportions and animation parameters stay within authored bounds', () => {
  for (let seed = 0; seed < 80; seed++) {
    const identity = createNpcIdentity({
      worldSeed: seed,
      stationId: `station-${seed}`,
      stationName: 'Bounds Halt',
      slot: NPC_STATION_SLOTS[seed % NPC_STATION_SLOTS.length],
    });
    assert.ok(identity.proportions.height >= 0.90 && identity.proportions.height <= 1.10);
    assert.ok(identity.proportions.build >= 0.86 && identity.proportions.build <= 1.14);
    assert.ok(identity.proportions.headScale >= 0.91 && identity.proportions.headScale <= 1.10);
    assert.ok(identity.animation.period >= 6.8 && identity.animation.period <= 11.5);
    assert.ok(identity.animation.energy >= 0.72 && identity.animation.energy <= 1.18);
  }
});

test('procedural motion is finite, bounded, opposing, and loopable', () => {
  const identity = createNpcIdentity({
    worldSeed: 9,
    stationId: station.id,
    stationName: station.name,
    slot: NPC_STATION_SLOTS[1],
  });
  const pose = sampleNpcMotion(identity, 2.75);
  const looped = sampleNpcMotion(identity, 2.75 + identity.animation.period);
  for (const value of Object.values(pose)) assert.ok(Number.isFinite(value));
  assert.ok(Math.abs(pose.pathOffset) <= identity.animation.paceDistance + 1e-9);
  assert.ok(Math.abs(pose.leftLeg + pose.rightLeg) < 1e-9);
  assert.ok(Math.abs(pose.leftArm + pose.rightArm) < 1e-9);
  for (const key of Object.keys(pose)) {
    assert.ok(Math.abs(pose[key] - looped[key]) < 1e-8, `${key} should loop`);
  }
});

test('talking creates a deterministic one-handed gesture without pacing away', () => {
  const identity = createNpcIdentity({
    worldSeed: 13,
    stationId: station.id,
    stationName: station.name,
    slot: NPC_STATION_SLOTS[1],
  });
  const walking = sampleNpcMotion(identity, 1.5);
  const pose = sampleNpcMotion(identity, 1.5, { talking: true });
  assert.equal(pose.pathOffset, walking.pathOffset);
  assert.equal(pose.locomotion, 0);
  const gesture = identity.animation.gestureHand === 'left' ? pose.leftArmOut : pose.rightArmOut;
  assert.ok(Math.abs(gesture) > 0.15);
});

test('conversation freezes the walking path while gestures keep moving', () => {
  const identity = createNpcIdentity({
    worldSeed: 22,
    stationId: station.id,
    stationName: station.name,
    slot: NPC_STATION_SLOTS[1],
  });
  const first = sampleNpcMotion(identity, 2, { talking: true, gestureElapsed: 2 });
  const later = sampleNpcMotion(identity, 2, { talking: true, gestureElapsed: 2.7 });
  assert.equal(first.pathOffset, later.pathOffset);
  assert.notEqual(first.rootBob, later.rootBob);
});

test('leg-length variation preserves exact primitive foot contact', () => {
  for (const legScale of [0.90, 1, 1.08]) {
    const footBottom = npcHipHeight(legScale) - 0.72 * legScale - 0.075;
    assert.ok(Math.abs(footBottom) < 1e-12);
  }
});

test('the curated generator exposes meaningful visual variety', () => {
  const palettes = new Set();
  const headwear = new Set();
  const names = new Set();
  const families = new Set();
  for (let seed = 0; seed < 32; seed++) {
    for (const resident of createStationPopulation({
      ...station, id: `station-${seed}`, name: `Station ${seed}`,
    }, seed, { count: 7 })) {
      palettes.add(resident.identity.palette.id);
      headwear.add(resident.identity.appearance.headwear);
      names.add(resident.identity.name);
      families.add(resident.identity.family);
    }
  }
  assert.ok(palettes.size >= 5);
  assert.ok(headwear.size >= 5);
  assert.ok(names.size >= 80);
  assert.deepEqual(families, new Set(['cloaked', 'storybook']));
});
