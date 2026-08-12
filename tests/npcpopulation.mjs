import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNpcIdentity,
  createStationPopulation,
  householdAgeBand,
  NPC_AGE_BANDS,
  NPC_HAIR_STYLES,
  NPC_HAT_STYLES,
  NPC_STATION_SLOTS,
  npcHipHeight,
  planNpcPopulation,
  presentationForName,
  sampleNpcMotion,
  stableNpcSeed,
} from '../src/npcpopulation.mjs';
import { npcBindDimensions } from '../src/npcanatomy.mjs';

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
    // Age scales the base draw: a youth is shorter with a larger head, an
    // elder slightly shorter and a shade heavier. The bounds are the base
    // range times the widest age factor in either direction.
    assert.ok(identity.proportions.height >= 0.78 && identity.proportions.height <= 1.10);
    assert.ok(identity.proportions.build >= 0.77 && identity.proportions.build <= 1.17);
    assert.ok(identity.proportions.headScale >= 0.91 && identity.proportions.headScale <= 1.20);
    assert.ok(NPC_AGE_BANDS.includes(identity.age));
    assert.ok(identity.presentation >= 0 && identity.presentation <= 1);
    assert.ok(NPC_HAIR_STYLES.includes(identity.appearance.hair));
    assert.ok(NPC_HAT_STYLES.includes(identity.appearance.hat));
    // Shoulders stay broader than hips at every point in the frame range,
    // which the anatomy invariants depend on.
    const dims = npcBindDimensions(identity.proportions);
    assert.ok(dims.shoulderWidth > dims.hipWidth,
      `${identity.name} lost the shoulder/hip ordering`);
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
  const outfits = new Set();
  const hairColours = new Set();
  for (let seed = 0; seed < 32; seed++) {
    for (const resident of createStationPopulation({
      ...station, id: `station-${seed}`, name: `Station ${seed}`,
    }, seed, { count: 7 })) {
      palettes.add(resident.identity.palette.id);
      headwear.add(`${resident.identity.appearance.hair}/${resident.identity.appearance.hat}`);
      names.add(resident.identity.name);
      families.add(resident.identity.family);
      outfits.add([
        resident.identity.palette.primary, resident.identity.palette.dark,
        resident.identity.palette.accent,
      ].join(':'));
      hairColours.add(resident.identity.palette.hair);
    }
  }
  assert.ok(palettes.size >= 5);
  assert.ok(headwear.size >= 5);
  assert.ok(names.size >= 80);
  assert.deepEqual(families, new Set(['cloaked', 'storybook']));
  // A palette used to be worn whole, so the world had exactly six outfits.
  assert.ok(outfits.size >= 40, `only ${outfits.size} distinct outfits`);
  assert.ok(hairColours.size >= 6, `only ${hairColours.size} hair colours`);
});

test('a name that reads one way is built to match, without becoming a costume', () => {
  const rng = () => 0.5;
  assert.ok(presentationForName('Rosamund Bell', rng) > 0.7, 'a feminine name sits high');
  assert.ok(presentationForName('Bram Reed', rng) < 0.3, 'a masculine name sits low');
  const unisex = presentationForName('Wren Bell', rng);
  assert.ok(unisex > 0.3 && unisex < 0.7, 'a unisex name sits in a real middle');
  // An unfamiliar name is not assumed to be either.
  assert.equal(presentationForName('Xylia Bell', rng), unisex);
  assert.equal(presentationForName('', rng), unisex);

  // The frame follows presentation. This is the shoulder-to-hip ratio, which
  // was a hard constant for every person in the world before.
  const slot = NPC_STATION_SLOTS[3];
  const ratios = new Map();
  for (const given of ['Rosamund', 'Bram']) {
    const identity = createNpcIdentity({
      worldSeed: 5, stationId: 'station-frame', slot, givenName: given, ageBand: 'adult',
    });
    const dims = npcBindDimensions(identity.proportions);
    ratios.set(given, dims.shoulderWidth / dims.hipWidth);
  }
  assert.ok(ratios.get('Bram') > ratios.get('Rosamund'),
    'the same seed and slot no longer produce the same silhouette');

  // Across a population the lean is a tendency, not a rule: some residents
  // with feminine names still read broad, and that is the point.
  let feminineLong = 0;
  let masculineLong = 0;
  for (let seed = 0; seed < 120; seed++) {
    for (const [given, bucket] of [['Rosamund', 'f'], ['Bram', 'm']]) {
      const identity = createNpcIdentity({
        worldSeed: seed, stationId: `s-${seed}`, slot, givenName: given, ageBand: 'adult',
      });
      const long = ['long', 'braid', 'bun'].includes(identity.appearance.hair);
      if (bucket === 'f' && long) feminineLong++;
      if (bucket === 'm' && long) masculineLong++;
    }
  }
  assert.ok(feminineLong > masculineLong, 'longer hair leans with presentation');
  assert.ok(masculineLong > 0, 'but is never exclusive to it');
});

test('a household has adults, children, and the occasional elder', () => {
  assert.equal(householdAgeBand('partners', 0, 4), 'adult');
  assert.equal(householdAgeBand('partners', 1, 4), 'adult');
  assert.equal(householdAgeBand('partners', 2, 4), 'youth', 'past the couple are their children');
  assert.equal(householdAgeBand('siblings', 3, 4), 'youth');
  assert.equal(householdAgeBand('lodger', 1, 2), 'adult');

  // A lone occupant may be elderly, decided from who they are rather than from
  // the draw order, so a household gaining a lodger cannot age them.
  const alone = householdAgeBand('single', 0, 1, 'npc:elm:3');
  assert.ok(NPC_AGE_BANDS.includes(alone));
  assert.equal(householdAgeBand('single', 0, 1, 'npc:elm:3'), alone);

  const bands = new Set();
  for (let index = 0; index < 60; index++) {
    bands.add(householdAgeBand('single', 0, 1, `npc:elm:${index}`));
  }
  assert.deepEqual(bands, new Set(['adult', 'elder']));

  // An elder greys and carries a forward set through the spine.
  const slot = NPC_STATION_SLOTS[3];
  const elder = createNpcIdentity({
    worldSeed: 2, stationId: 'station-age', slot, givenName: 'Maud', ageBand: 'elder',
  });
  const youth = createNpcIdentity({
    worldSeed: 2, stationId: 'station-age', slot, givenName: 'Maud', ageBand: 'youth',
  });
  assert.ok(elder.posture.stoop > 0);
  assert.equal(youth.posture.stoop, 0);
  assert.ok(youth.proportions.height < elder.proportions.height, 'a child is shorter');
  assert.ok(youth.proportions.headScale > elder.proportions.headScale, 'and bigger-headed');
});

test('hair has a colour of its own, independent of the outfit', () => {
  const slot = NPC_STATION_SLOTS[3];
  const hairByOutfit = new Map();
  for (let seed = 0; seed < 40; seed++) {
    const identity = createNpcIdentity({
      worldSeed: seed, stationId: `station-hair-${seed}`, slot, ageBand: 'adult',
    });
    assert.ok(Number.isInteger(identity.palette.hair));
    const outfit = identity.palette.dark;
    const seen = hairByOutfit.get(outfit) || new Set();
    seen.add(identity.palette.hair);
    hairByOutfit.set(outfit, seen);
  }
  // Hair used to BE the trouser colour, so one trouser colour meant one hair
  // colour. At least one outfit must now appear with several heads of hair.
  assert.ok([...hairByOutfit.values()].some((set) => set.size > 1),
    'the same trousers must be able to appear under different hair');
});
