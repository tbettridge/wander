import assert from 'node:assert/strict';
import { createLivestockPasture, isLivestockVillage, pastureContains } from '../src/livestockpasture.mjs';
import { createAnimalFamily } from '../src/animalpopulation.mjs';
import { ANIMAL_RECIPES } from '../src/animaldata.mjs';
import { mulberry32 } from '../src/noise.js';

const site = { id: 'village:test', seed: 42, kind: 'village', x: 0, z: 0, radius: 100 };
const plan = { site, buildings: [], props: [] };
const world = { height: () => 10, biomeAt: () => ({ id: 'grassland', h: 10, slope: 0 }),
  riverAt: () => ({ wet: false }), openFactor: () => 0.9, groveFactor: () => 0.1 };
const sheep = createLivestockPasture(world, plan, 'sheep');
const cows = createLivestockPasture(world, plan, 'cow', [sheep]);
assert.ok(sheep && cows);
assert.deepEqual(createLivestockPasture(world, plan, 'sheep'), sheep);
for (const field of [sheep, cows]) {
  assert.ok(Math.hypot(field.x, field.z) - field.radius > site.radius);
  assert.ok(pastureContains(field, field.x, field.z));
  assert.ok(!pastureContains(field, field.x + field.radius, field.z, 1));
}
assert.ok(Math.hypot(sheep.x - cows.x, sheep.z - cows.z) > sheep.radius + cows.radius);
assert.equal(isLivestockVillage({ ...site, isStationSettlement: true }), false);
assert.equal(createLivestockPasture(world, { ...plan, site: { ...site, kind: 'station-village' } }, 'cow'), null);
for (const overrides of [
  { riverAt: () => ({ wet: true }) },
  { biomeAt: () => ({ id: 'grassland', h: 10, slope: 0.4 }) },
  { biomeAt: () => ({ id: 'desert', h: 10, slope: 0 }) },
  { groveFactor: () => 0.8 },
  { biomeAt: () => ({ id: 'forest', h: 10, slope: 0 }), openFactor: () => 0.2 },
]) assert.equal(createLivestockPasture({ ...world, ...overrides }, plan, 'sheep'), null);
assert.equal(createLivestockPasture(world, plan, 'cow', [], () => true), null);

// A river surrounding each proposed centre must refuse the field even though
// its first standing point is dry.
const wetEdge = { ...world, riverAt: (x, z) => ({ wet: Math.abs(Math.hypot(x, z) - 146) > 2 }) };
assert.equal(createLivestockPasture(wetEdge, plan, 'sheep'), null);

for (const species of ['sheep', 'cow']) {
  assert.ok(ANIMAL_RECIPES[species].tame && ANIMAL_RECIPES[species].livestock);
  let juveniles = 0, brown = 0, spotted = 0;
  for (let seed = 0; seed < 100; seed++) {
    const family = createAnimalFamily(species, mulberry32(seed));
    assert.deepEqual(family, createAnimalFamily(species, mulberry32(seed)));
    const adults = family.members.filter(member => !member.juvenile);
    assert.ok(adults.length >= (species === 'sheep' ? 4 : 3));
    assert.ok(family.members.length <= (species === 'sheep' ? 7 : 5));
    for (const member of family.members) {
      if (member.juvenile) { juveniles++; assert.ok(member.scale < 0.7); }
      else assert.ok(member.scale >= 0.9);
      if (member.morph === 'brown') brown++;
      if (member.markings?.patches) spotted++;
    }
  }
  assert.ok(juveniles > 0);
  if (species === 'cow') assert.ok(brown > 0 && spotted > 0);
}
console.log('livestockpasture PASS · stable separate village fields · water/slope/trees excluded · small flocks/herds with young');
