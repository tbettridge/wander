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
    assert.ok(plan.masonry.blocks.length > 20, `seed ${seed}: ${plan.masonry.blocks.length} blocks`);
    assert.ok(plan.masonry.lines.length > 0);
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
    for (const record of [...plan.masonry.blocks, ...plan.masonry.lines]) {
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== 'number') continue;
        assert.ok(Number.isFinite(value), `seed ${seed}: ${record.id}.${key} is ${value}`);
      }
    }
  }
});

console.log('dungeonmasonry PASS · masonry not dripstone · varied programmes · no NaN');
