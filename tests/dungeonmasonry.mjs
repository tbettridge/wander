import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDungeonGraph } from '../src/cavegen.mjs';
import { createCaveField } from '../src/cavefield.mjs';
import { buildCaveDressingPlan } from '../src/cavedressing.mjs';
import { dungeonMasonryFor, DUNGEON_PROGRAM_FAMILIES } from '../src/fortifieddungeon.mjs';

const graphFor = (seed) => generateDungeonGraph(seed, { hillClass: 'low', geology: 'limestone' });

test('a keep undercroft is dressed with masonry instead of dripstone', () => {
  const families = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const graph = graphFor(seed);
    const plan = buildCaveDressingPlan(graph, createCaveField(graph), null, {});
    assert.equal(plan.mode, 'dungeon');
    // Nothing grows in a cellar.
    for (const grown of ['stalactites', 'stalagmites', 'columns', 'fungi', 'roots']) {
      assert.equal(plan[grown].length, 0, `${grown} in a dungeon`);
    }
    assert.equal(plan.masonry.available, true);
    // Stone only where a builder would have put it: framing the way in, and
    // bracing the vault. Lining every wall read as brick pasted over a cave.
    assert.ok(plan.masonry.blocks.length <= 12,
      `seed ${seed}: ${plan.masonry.blocks.length} loose masonry pieces`);
    assert.ok(plan.masonry.blocks.some((b) => b.kind === 'masonry-pier'),
      `seed ${seed}: no entrance piers`);
    for (const rib of plan.masonry.ribs) {
      assert.ok(rib.span >= 2.4 && rib.height > 1.8, `seed ${seed}: rib too small to stand under`);
    }
    families.add(plan.masonry.program.family);
  }
  // The programme grammar is what makes one undercroft a crypt and the next a
  // cistern, so it has to actually vary.
  assert.ok(families.size >= 3, [...families].join(','));
  for (const family of families) assert.ok(DUNGEON_PROGRAM_FAMILIES.includes(family));
});

// One NaN vertex poisons the merged buffer and the cave never finishes
// streaming — with nothing in the console but a bounding-sphere warning.
test('no dressing piece ever carries a non-finite coordinate', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const graph = graphFor(seed);
    const masonry = dungeonMasonryFor(graph, { seed });
    for (const piece of masonry.pieces) {
      for (const [key, value] of Object.entries(piece)) {
        if (typeof value !== 'number') continue;
        assert.ok(Number.isFinite(value), `seed ${seed}: ${piece.id}.${key} is ${value}`);
      }
    }
    const plan = buildCaveDressingPlan(graph, createCaveField(graph), null, {});
    for (const record of [...plan.masonry.blocks, ...plan.masonry.ribs]) {
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== 'number') continue;
        assert.ok(Number.isFinite(value), `seed ${seed}: ${record.id}.${key} is ${value}`);
      }
    }
  }
});

// The rock itself does the talking now, so it has to be dug rather than dissolved.
test('a dungeon is vaulted, and an ordinary cave is not', async () => {
  const { generateCaveGraph } = await import('../src/cavegen.mjs');
  let vaulted = 0, rooms = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const dungeon = graphFor(seed);
    assert.ok(dungeon.edges.some((edge) => edge.profile === 'vault'), `seed ${seed}: no vaulted passage`);
    vaulted += dungeon.edges.filter((edge) => edge.profile === 'vault').length;
    for (const chamber of dungeon.chambers) {
      assert.equal(chamber.form, 'vault', `seed ${seed}: chamber ${chamber.id} is ${chamber.form}`);
      rooms++;
    }
    // A wild cave is untouched by any of this.
    const wild = generateCaveGraph(seed, { hillClass: 'low', geology: 'limestone' });
    assert.ok(!wild.edges.some((edge) => edge.profile === 'vault'), `seed ${seed}: wild cave was vaulted`);
    assert.ok(!wild.chambers.some((chamber) => chamber.form === 'vault'));
  }
  assert.ok(vaulted > 100 && rooms > 40, `${vaulted} vaulted passages, ${rooms} rooms`);
});

console.log('dungeonmasonry PASS · dug and vaulted · stone only where it braces · no NaN');
