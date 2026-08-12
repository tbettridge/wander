import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/noise.js';
import {
  chooseNpcWardrobe,
  NPC_GARMENTS,
  NPC_LAYERS,
  NPC_WORK_DRESS,
  workDressForRole,
} from '../src/npcwardrobe.mjs';
import { createNpcIdentity, NPC_STATION_SLOTS } from '../src/npcpopulation.mjs';

const wardrobeFor = (options, seed = 1) =>
  chooseNpcWardrobe({ rng: mulberry32(seed), ...options });

test('working kit comes from the job, not from a dice roll', () => {
  assert.deepEqual(workDressForRole('smith'), ['apron', 'rolled-sleeves']);
  assert.deepEqual(workDressForRole('miller'), ['apron', 'rolled-sleeves']);
  assert.deepEqual(workDressForRole('clerk'), ['armband']);
  assert.deepEqual(workDressForRole('railway porter'),
    ['armband', 'rolled-sleeves', 'satchel-strap']);
  // A bare `keeper` substring used to match `innkeeper` and pin a railway
  // armband on the publican, so the rules are word-anchored.
  assert.deepEqual(workDressForRole('innkeeper'), ['apron']);

  // Matched on the string, because roles arrive from households, work routines
  // and station slots, and a new building program invents new ones.
  assert.deepEqual(workDressForRole('Station Keeper'), ['armband']);
  assert.deepEqual(workDressForRole('granary hand'), ['apron', 'rolled-sleeves']);

  // Anything unrecognised gets nothing rather than a guess.
  assert.deepEqual(workDressForRole('resident'), []);
  assert.deepEqual(workDressForRole(''), []);
  assert.deepEqual(workDressForRole(null), []);

  for (const role of ['smith', 'porter', 'clerk', 'farmer']) {
    for (const item of workDressForRole(role)) {
      assert.ok(NPC_WORK_DRESS.includes(item), `${item} is not a known piece of kit`);
    }
  }
});

test('a wardrobe is always renderable', () => {
  for (let seed = 0; seed < 200; seed++) {
    const wardrobe = wardrobeFor({
      role: ['smith', 'clerk', 'resident', 'porter'][seed % 4],
      presentation: (seed % 11) / 10,
      age: ['adult', 'elder', 'youth'][seed % 3],
    }, seed);
    assert.ok(NPC_GARMENTS.includes(wardrobe.garment));
    assert.ok(NPC_LAYERS.includes(wardrobe.layer));
    assert.ok(Array.isArray(wardrobe.workDress));
    assert.equal(typeof wardrobe.trim.collar, 'boolean');
    // A hem band needs a hem: trousers have no single edge to trim.
    if (wardrobe.garment === 'trousers') assert.equal(wardrobe.trim.hem, false);
  }
});

test('presentation leans the silhouette without dictating it', () => {
  const count = (presentation, garment) => {
    let hits = 0;
    for (let seed = 0; seed < 300; seed++) {
      if (wardrobeFor({ presentation, role: 'resident' }, seed).garment === garment) hits++;
    }
    return hits;
  };
  const skirtsHigh = count(0.95, 'skirt');
  const skirtsLow = count(0.05, 'skirt');
  assert.ok(skirtsHigh > skirtsLow, 'a skirt leans with presentation');
  assert.ok(skirtsLow > 0, 'but is never ruled out');
  assert.ok(count(0.05, 'trousers') > 0 && count(0.95, 'trousers') > 0,
    'trousers stay available across the whole range');
});

test('an elder reaches for a shawl more often', () => {
  const shawls = (age) => {
    let hits = 0;
    for (let seed = 0; seed < 300; seed++) {
      if (wardrobeFor({ age, role: 'resident', presentation: 0.5 }, seed).layer === 'shawl') hits++;
    }
    return hits;
  };
  assert.ok(shawls('elder') > shawls('adult'));
  assert.ok(shawls('adult') > 0);
});

test('layers that would fight each other are not worn together', () => {
  for (let seed = 0; seed < 400; seed++) {
    const wardrobe = wardrobeFor({ role: 'smith', presentation: 0.5 }, seed);
    if (wardrobe.layer === 'coat') {
      assert.equal(wardrobe.workDress.includes('apron'), false,
        'an apron under a buttoned coat is invisible and only ever z-fights');
    }
    const porter = wardrobeFor({ role: 'porter', presentation: 0.5 }, seed);
    if (porter.layer === 'shawl') {
      assert.equal(porter.workDress.includes('satchel-strap'), false);
    }
  }
});

test('a robe is a whole silhouette and takes nothing over it', () => {
  const wardrobe = wardrobeFor({ role: 'station keeper', family: 'cloaked' }, 7);
  assert.equal(wardrobe.garment, 'trousers');
  assert.equal(wardrobe.layer, 'none');
  assert.deepEqual(wardrobe.workDress, []);
  assert.deepEqual(wardrobe.trim, { collar: false, cuffs: false, hem: false });
});

test('the identity carries a wardrobe, and adding one changed nothing above it', () => {
  const slot = NPC_STATION_SLOTS[1];
  const identity = createNpcIdentity({ worldSeed: 11, stationId: 'station-wardrobe', slot });
  assert.ok(NPC_GARMENTS.includes(identity.wardrobe.garment));
  // The porter's kit is the slot's role showing through, not a coincidence.
  assert.ok(identity.wardrobe.workDress.includes('armband'));

  // The wardrobe is drawn last from the identity's rng, so every earlier draw
  // is untouched: a resident keeps the name, colouring and build they had.
  const again = createNpcIdentity({ worldSeed: 11, stationId: 'station-wardrobe', slot });
  assert.deepEqual(again, identity, 'identities stay deterministic');
  // Pinned on purpose: if a future rng draw is inserted anywhere above the
  // wardrobe, every name in the world shifts and this is what says so.
  assert.equal(identity.name, 'Una Lark');
});

test('the whole population is dressed, and dressed differently', () => {
  const looks = new Set();
  const garments = new Set();
  const layers = new Set();
  const kit = new Set();
  for (let seed = 0; seed < 60; seed++) {
    for (const resident of [0, 1, 2, 3, 4, 5, 6].map((index) => createNpcIdentity({
      worldSeed: seed,
      stationId: `station-${seed}`,
      slot: NPC_STATION_SLOTS[index],
    }))) {
      const { garment, layer, workDress, trim } = resident.wardrobe;
      garments.add(garment);
      layers.add(layer);
      for (const item of workDress) kit.add(item);
      looks.add([garment, layer, workDress.join('+'), trim.collar, trim.cuffs, trim.hem].join('|'));
    }
  }
  assert.deepEqual(garments, new Set(NPC_GARMENTS));
  assert.deepEqual(layers, new Set(NPC_LAYERS));
  assert.ok(kit.size >= 3, `only ${kit.size} kinds of working kit appeared`);
  assert.ok(looks.size >= 30, `only ${looks.size} distinct outfits`);
});
