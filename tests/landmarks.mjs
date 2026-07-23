import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import {
  GREAT_TREE_ARCHETYPES,
  greatTreeArchetype,
  inLandmarkHalo,
  landmarkForCell,
} from '../src/landmarks.js';

const world = new World(20260612);
const giants = [];
for (let z = -30; z <= 30; z++) {
  for (let x = -30; x <= 30; x++) {
    const landmark = landmarkForCell(world, x, z, world.seed);
    if (landmark?.type === 'giant') giants.push(landmark);
  }
}

assert.ok(giants.length > 20, 'seed exposes too few Great Trees for variation coverage');
const forms = new Set(giants.map((landmark) => greatTreeArchetype(landmark.seed)));
assert.deepEqual([...forms].sort(), [...GREAT_TREE_ARCHETYPES].sort(),
  'seeded world does not expose every Great Tree growth form');
assert.deepEqual([0, 1, 4, 123456789, 20260612].map(greatTreeArchetype),
  ['forked', 'storm', 'hollow', 'forked', 'hollow'],
  'Great Tree growth-form fixtures are not deterministic');

const tree = giants[0];
let boundaryInside = 0, boundaryOutside = 0;
for (let i = 0; i < 48; i++) {
  const angle = i / 48 * Math.PI * 2;
  const point = (radius) => ({
    x: tree.x + Math.cos(angle) * radius,
    z: tree.z + Math.sin(angle) * radius,
  });
  const inner = point(tree.halo * 0.80);
  const edge = point(tree.halo);
  const outer = point(tree.halo * 1.20);
  assert.equal(inLandmarkHalo([tree], inner.x, inner.z), true,
    'irregular Great Tree clearing excludes its protected inner crown');
  assert.equal(inLandmarkHalo([tree], outer.x, outer.z), false,
    'irregular Great Tree clearing extends beyond its intended outer verge');
  if (inLandmarkHalo([tree], edge.x, edge.z)) boundaryInside++;
  else boundaryOutside++;
}
assert.ok(boundaryInside > 0 && boundaryOutside > 0,
  'Great Tree clearing boundary is still circular');

console.log(`landmarks PASS · ${giants.length} Great Trees · ${forms.size} growth forms · irregular clearings`);
