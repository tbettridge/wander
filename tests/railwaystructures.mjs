import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import {
  classifyRailwayStructures,
  STRUCTURE_FAMILY,
  STRUCTURE_FAMILY_NAME,
} from '../src/railwaystructures.mjs';

// --- synthetic scenarios exercise each selection rule -----------------------
function makeLoop(specs, spacing = 10) {
  const points = specs.map((s, i) => ({
    x: i * spacing, z: 0, h: 0,
    wet: !!s.wet, ocean: !!s.ocean, biome: s.biome || 'grassland',
  }));
  const heights = Float64Array.from(specs, (s) => s.offset); // formation above h=0
  return { points, heights };
}

function familyAt(points, i) { return points[i].family; }

// Short shallow watercourse → culvert.
{
  const specs = Array.from({ length: 10 }, () => ({ offset: 0.4 }));
  specs[4] = { wet: true, offset: 2 };
  specs[5] = { wet: true, offset: 2 };
  const { points, heights } = makeLoop(specs);
  classifyRailwayStructures(points, heights);
  assert.equal(points[4].structure, 'bridge');
  assert.equal(familyAt(points, 4), 'culvert', `expected culvert, got ${points[4].family}`);
  assert.equal(points[0].structure, 'surface');
}

// Wide shallow crossing in open country → stone bridge (too long for a culvert).
{
  const specs = Array.from({ length: 12 }, () => ({ offset: 0.4 }));
  for (let i = 3; i <= 8; i++) specs[i] = { wet: true, offset: 3 };
  const { points, heights } = makeLoop(specs);
  classifyRailwayStructures(points, heights);
  assert.equal(familyAt(points, 5), 'stone', `expected stone, got ${points[5].family}`);
}

// Deep valley → viaduct.
{
  const specs = Array.from({ length: 12 }, () => ({ offset: 0.4 }));
  for (let i = 3; i <= 8; i++) specs[i] = { offset: 15 };
  const { points, heights } = makeLoop(specs);
  classifyRailwayStructures(points, heights);
  assert.equal(points[5].structure, 'bridge');
  assert.equal(familyAt(points, 5), 'viaduct', `expected viaduct, got ${points[5].family}`);
}

// Modest span in timber country → timber trestle.
{
  const specs = Array.from({ length: 10 }, () => ({ offset: 0.4 }));
  for (let i = 4; i <= 6; i++) specs[i] = { offset: 7, biome: 'forest' };
  const { points, heights } = makeLoop(specs);
  classifyRailwayStructures(points, heights);
  assert.equal(familyAt(points, 5), 'timber', `expected timber, got ${points[5].family}`);
}

// Earthworks map to embankment / cutting; deep cut → tunnel candidate.
{
  const specs = [
    { offset: 0.2 }, { offset: 3 }, { offset: 3 },      // fill → embankment
    { offset: 0.2 }, { offset: -3 }, { offset: -3 },    // cut → cutting
    { offset: 0.2 }, { offset: -8 }, { offset: -8 }, { offset: 0.2 }, // deep cut → tunnel
  ];
  const { points, heights } = makeLoop(specs);
  classifyRailwayStructures(points, heights);
  assert.equal(points[1].structure, 'fill');
  assert.equal(points[1].family, 'embankment');
  assert.equal(points[4].structure, 'cut');
  assert.equal(points[4].family, 'cutting');
  assert.equal(points[7].structure, 'tunnel');
  assert.equal(points[7].family, 'tunnel');
}

// --- real plan: every point carries a consistent kind + family -------------
const world = new World(20260612);
const plan = planRegionalRailway(world, { center: { x: 0, z: 0 }, seed: 20260612, stationCount: 5 });
const validFamilies = new Set(STRUCTURE_FAMILY_NAME);
const bridgeFamilies = new Set();
for (const point of plan.points) {
  assert.ok(validFamilies.has(point.family), `unknown family ${point.family}`);
  assert.equal(point.familyCode, STRUCTURE_FAMILY[point.family]);
  if (point.structure === 'bridge') {
    bridgeFamilies.add(point.family);
    assert.ok(['culvert', 'timber', 'stone', 'viaduct'].includes(point.family),
      `bridge point had non-bridge family ${point.family}`);
  }
  if (point.structure === 'fill') assert.equal(point.family, 'embankment');
  if (point.structure === 'cut') assert.equal(point.family, 'cutting');
}
assert.ok(bridgeFamilies.size >= 1, 'real plan produced no bridge families');
assert.ok(plan.metrics.families, 'plan metrics missing family counts');

console.log(`railwaystructures PASS · bridge families: ${[...bridgeFamilies].join(', ')} · reroutes ${plan.metrics.reroutes.length}`);
