import assert from 'node:assert/strict';
import { generateCaveGraph } from '../src/cavegen.mjs';
import { createCaveField } from '../src/cavefield.mjs';
import { buildCaveHydrologyPlan } from '../src/cavehydrology.mjs';
import { buildCaveDressingPlan, buildCaveDressingGeometry } from '../src/cavedressing.mjs';

function routeDistance2(graph, x, z) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  let best = Infinity;
  for (const edge of graph.edges) {
    const a = nodeById.get(edge.a).p, b = nodeById.get(edge.b).p;
    const abx = b[0] - a[0], abz = b[2] - a[2];
    const denom = abx * abx + abz * abz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * abx + (z - a[2]) * abz) / denom));
    best = Math.min(best, Math.hypot(x - (a[0] + abx * t), z - (a[2] + abz * t)));
  }
  return best;
}

function planFor(seed, options = {}) {
  const graph = generateCaveGraph(seed, options);
  const field = createCaveField(graph);
  const hydrology = buildCaveHydrologyPlan(graph, field);
  const plan = buildCaveDressingPlan(graph, field, hydrology, { biome: options.testBiome || 'forest' });
  return { graph, field, hydrology, plan };
}

function findGeology(target, options = {}) {
  for (let seed = 0; seed < 500; seed++) {
    const graph = generateCaveGraph(seed, options);
    if (graph.geology === target) return seed;
  }
  throw new Error(`no ${target} seed found`);
}

// --- determinism --------------------------------------------------------------
{
  const a = planFor(3), b = planFor(3);
  assert.deepEqual(a.plan, b.plan, 'dressing plan is not deterministic');
  const ga = buildCaveDressingGeometry(a.plan, a.field);
  const gb = buildCaveDressingGeometry(b.plan, b.field);
  assert.deepEqual(ga.positions, gb.positions, 'dressing geometry is not deterministic');
  assert.deepEqual(ga.surfaces, gb.surfaces, 'dressing semantics are not deterministic');
}

// --- anchoring + clearance over a spread of seeds ----------------------------
let totals = { stalactites: 0, stalagmites: 0, columns: 0, rubble: 0, fungi: 0, roots: 0 };
for (const seed of [0, 3, 5, 9, 17, 23, 42]) {
  const { graph, field, plan } = planFor(seed);
  for (const key of Object.keys(totals)) totals[key] += plan[key].length;

  for (const s of plan.stalactites) {
    // the anchor must sit at rock: just above the top is rock, just below air
    assert.ok(field.sdf(s.x, s.top + 0.35, s.z) >= -0.05, `seed ${seed} stalactite not anchored to ceiling`);
    assert.ok(field.sdf(s.x, s.top - Math.max(0.4, s.length * 0.5), s.z) < 0.05, `seed ${seed} stalactite buried in rock`);
    // tips above the walking corridor keep headroom
    if (routeDistance2(graph, s.x, s.z) < 2.0) {
      const floor = field.floorHeightNear(s.x, s.z, s.top - 6, 8, 8) ?? field.floorHeight(s.x, s.z);
      if (floor !== null) {
        assert.ok(s.top - s.length - floor >= 2.3, `seed ${seed} stalactite tip in head height (${(s.top - s.length - floor).toFixed(2)}m)`);
      }
    }
  }
  for (const s of plan.stalagmites) {
    assert.ok(routeDistance2(graph, s.x, s.z) >= 1.9, `seed ${seed} stalagmite on the route`);
    const floor = field.floorHeightNear(s.x, s.z, s.bottom + 0.5, 4, 4);
    if (floor !== null) assert.ok(Math.abs(s.bottom - floor) < 1.0, `seed ${seed} stalagmite floats (${Math.abs(s.bottom - floor).toFixed(2)}m)`);
  }
  for (const c of plan.columns) {
    assert.ok(routeDistance2(graph, c.x, c.z) >= 1.9, `seed ${seed} column on the route`);
  }
  for (const r of plan.rubble) {
    assert.ok(routeDistance2(graph, r.x, r.z) >= 1.9, `seed ${seed} rubble on the route`);
  }
  for (const f of plan.fungi) {
    assert.ok(routeDistance2(graph, f.x, f.z) >= 1.5, `seed ${seed} fungi on the route`);
    const mouth = graph.entrance.mouth;
    const depth = Math.hypot(f.x - mouth[0], f.z - mouth[2]);
    assert.ok(depth > 15, `seed ${seed} fungi too near the entrance (${depth.toFixed(0)}m)`);
  }
  for (const r of plan.roots) {
    const mouth = graph.entrance.mouth;
    assert.ok(Math.hypot(r.x - mouth[0], r.z - mouth[2]) < 22, `seed ${seed} roots too deep`);
  }

  const geometry = buildCaveDressingGeometry(plan, field);
  assert.equal(geometry.positions.length, geometry.normals.length, `seed ${seed} attribute mismatch`);
  assert.equal(geometry.surfaces.length, (geometry.positions.length / 3) * 4, `seed ${seed} surface channel mismatch`);
  assert.ok([...geometry.positions].every(Number.isFinite), `seed ${seed} non-finite geometry`);
  for (let i = 0; i < geometry.normals.length; i += 3) {
    const len = Math.hypot(geometry.normals[i], geometry.normals[i + 1], geometry.normals[i + 2]);
    assert.ok(Math.abs(len - 1) < 1e-3, `seed ${seed} non-unit normal`);
  }
}
assert.ok(totals.stalactites > 6, `too little dripstone overall (${totals.stalactites})`);

// --- geology character --------------------------------------------------------
{
  const grotto = planFor(findGeology('grotto')).plan;
  const boulder = planFor(findGeology('boulder')).plan;
  const iceSeed = findGeology('ice', { biome: 'snow' });
  const ice = planFor(iceSeed, { biome: 'snow', testBiome: 'snow' }).plan;
  const rubbleRate = (plan) => plan.rubble.length / Math.max(1, plan.stalactites.length + plan.rubble.length);
  assert.ok(rubbleRate(boulder) > rubbleRate(grotto), 'boulder caves should skew toward breakdown rubble');
  assert.equal(ice.fungi.length, 0, 'ice caves must not grow fungi');
  assert.equal(ice.roots.length, 0, 'snow-biome caves must not grow roots');
}

const sample = planFor(3).plan;
console.log(`cavedressing PASS · ${totals.stalactites} stalactites · ${totals.stalagmites} stalagmites · ${totals.columns} columns`
  + ` · ${totals.rubble} rubble · ${totals.fungi} fungi · ${totals.roots} roots · sample ${sample.geology}`);
