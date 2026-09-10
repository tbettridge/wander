import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { buildTerrainArrays, buildRiver } from '../src/chunkgen.js';
import { splitQuadValue } from '../src/terraincut.mjs';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from '../src/railwayterrain.mjs';

function channelNormal(world, x, z) {
  const e = 2;
  const dx = world._riverSignalAt(x + e, z) - world._riverSignalAt(x - e, z);
  const dz = world._riverSignalAt(x, z + e) - world._riverSignalAt(x, z - e);
  const length = Math.hypot(dx, dz);
  assert.ok(length > 1e-5, 'river fixture has no stable cross-section normal');
  return { x: dx / length, z: dz / length };
}

function findBank(world, section, normal, side) {
  for (let distance = 0; distance <= 120; distance += 0.5) {
    const x = section.x + normal.x * distance * side;
    const z = section.z + normal.z * distance * side;
    const river = world.riverAt(x, z);
    const ground = world.height(x, z);
    if (!river.wet && ground >= section.waterY + 0.20) return { distance, ground };
  }
  return null;
}

// Fixed sections cover asymmetric channels in two seeds. Water may descend
// along a reach, but it remains level across it and reaches a real bank on both
// sides instead of curling down to low terrain.
for (const fixture of [
  { seed: 20260612, x: -600, z: -1000 },
  { seed: 20260612, x: -920, z: -960 },
  { seed: 4242, x: 640, z: -800 },
  { seed: 4242, x: 520, z: -760 },
]) {
  const world = new World(fixture.seed);
  const river = world.riverAt(fixture.x, fixture.z);
  assert.ok(river.wet && river.depth > 1, `river fixture ${fixture.seed}/${fixture.x},${fixture.z} drifted`);
  assert.ok(Math.abs(river.y - river.ySmooth) < 1e-9, 'effective water diverged from its physical surface');
  const normal = channelNormal(world, fixture.x, fixture.z);
  const acrossA = world.riverAt(fixture.x - normal.x * 2, fixture.z - normal.z * 2);
  const acrossB = world.riverAt(fixture.x + normal.x * 2, fixture.z + normal.z * 2);
  assert.ok(Math.abs(acrossA.y - acrossB.y) < 0.16,
    `water slopes ${(Math.abs(acrossA.y - acrossB.y) / 4).toFixed(3)}m/m across the channel`);
  const section = { ...fixture, waterY: river.y };
  for (const side of [-1, 1]) {
    const bank = findBank(world, section, normal, side);
    assert.ok(bank, `river fixture ${fixture.seed}/${fixture.x},${fixture.z} has no bank on side ${side}`);
  }
}

function terrainHeightAt(terrain, cx, cz, res, x, z) {
  const n = res + 1, step = 140 / res;
  let gx = (x - cx * 140) / step, gz = (z - cz * 140) / step;
  if (Math.abs(gx - Math.round(gx)) < 1e-4) gx = Math.round(gx);
  if (Math.abs(gz - Math.round(gz)) < 1e-4) gz = Math.round(gz);
  gx = Math.max(0, Math.min(res, gx));
  gz = Math.max(0, Math.min(res, gz));
  const ix = Math.min(res - 1, Math.floor(gx));
  const iz = Math.min(res - 1, Math.floor(gz));
  const a = iz * n + ix, b = a + 1, c = a + n, d = c + 1;
  return splitQuadValue(
    terrain.positions[a * 3 + 1], terrain.positions[b * 3 + 1],
    terrain.positions[c * 3 + 1], terrain.positions[d * 3 + 1],
    gx - ix, gz - iz,
  );
}

// The originally reported low bank must stay connected to the river, with a
// common level across its full width. Sampling only four metres near the
// centre would miss the old metres-high lateral curl.
{
  const world = new World(20260612);
  const x = -550, z = -960, normal = channelNormal(world, x, z);
  const levels = [];
  for (let distance = 10; distance <= 60; distance += 2) {
    const river = world.riverAt(x + normal.x * distance, z + normal.z * distance);
    assert.ok(river.wet, `reported reach is interrupted ${distance}m across its section`);
    levels.push(river.y);
  }
  assert.ok(Math.max(...levels) - Math.min(...levels) < 0.08,
    'reported reach bends towards its lateral shoreline');
}

// Planning cannot depend on which worker or chunk asked first, including cache
// eviction. Reversing probes must preserve both terrain and water exactly.
{
  const forward = new World(20260612), reverse = new World(20260612);
  const points = [];
  for (let z = -1200; z <= -700; z += 11) for (let x = -1100; x <= -400; x += 17) points.push([x, z]);
  const expected = points.map(([x, z]) => ({ h: forward.height(x, z), river: forward.riverAt(x, z) }));
  for (let i = points.length - 1; i >= 0; i--) {
    const [x, z] = points[i];
    assert.deepEqual({ h: reverse.height(x, z), river: reverse.riverAt(x, z) }, expected[i]);
  }
  reverse._riverPlanCache.clear();
  assert.deepEqual(reverse.riverAt(...points[0]), expected[0].river);
}

// The water mesh is clipped, rather than emitting whole shoreline cells. Test
// the complete quality/LOD range and require every zero-depth vertex to be on
// the exact pair of terrain triangles used for rendering.
{
  const world = new World(20260612);
  const cx = -8, cz = -8;
  for (const res of [112, 96, 80, 72, 64, 56, 48, 32, 24, 20, 16]) {
    const terrain = buildTerrainArrays(world, cx, cz, res, 140);
    const river = buildRiver(cx, cz, res, 140, terrain.river);
    assert.ok(river?.indices.length, `resolution ${res} lost the fixture river`);
    assert.ok([...river.wet].every((depth) => depth >= 0), `resolution ${res} emitted negative water depth`);
    let shoreVertices = 0;
    for (let i = 0; i < river.wet.length; i++) {
      if (river.wet[i] > 1e-6) continue;
      shoreVertices++;
      const x = river.positions[i * 3], y = river.positions[i * 3 + 1], z = river.positions[i * 3 + 2];
      const ground = terrainHeightAt(terrain, cx, cz, res, x, z);
      assert.ok(Math.abs(y - ground) < 0.001,
        `resolution ${res} shoreline floats ${(y - ground).toFixed(4)}m above rendered ground`);
    }
    assert.ok(shoreVertices > 10, `resolution ${res} did not exercise shoreline clipping`);
  }
}

{
  // Coarsest supported terrain over a 4.2km square in each seed. Include dry
  // bank shoulders and route endings, where clamping the wrong signed field
  // can produce floating contact points despite passing a central fixture.
  let contacts = 0;
  for (const seed of [20260612, 4242]) {
    const world = new World(seed);
    for (let cz = -15; cz < 15; cz++) for (let cx = -15; cx < 15; cx++) {
      const terrain = buildTerrainArrays(world, cx, cz, 16, 140);
      const river = buildRiver(cx, cz, 16, 140, terrain.river);
      if (!river) continue;
      for (let i = 0; i < river.wet.length; i++) {
        if (river.wet[i] > 1e-6) continue;
        const x = river.positions[i * 3], y = river.positions[i * 3 + 1], z = river.positions[i * 3 + 2];
        assert.ok(Math.abs(y - terrainHeightAt(terrain, cx, cz, 16, x, z)) < 0.001,
          `seed ${seed} has a floating shoreline at ${x},${z}`);
        contacts++;
      }
    }
  }
  assert.ok(contacts > 10000, 'wide shoreline sweep covered too few contacts');
}

// Railway terrain and ordinary height queries must see the same final river
// floor. The corridor reservation prevents cut/fill blending from puncturing a
// bank or burying a channel while riverAt continues to report water there.
{
  const world = new World(20260612);
  const plan = planRegionalRailway(world, {
    center: { x: 0, z: 0 }, seed: world.seed, stationCount: 5,
  });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(plan));
  let wetSamples = 0;
  for (const point of plan.points) {
    for (let dz = -16; dz <= 16; dz += 8) {
      for (let dx = -16; dx <= 16; dx += 8) {
        const x = point.x + dx, z = point.z + dz;
        const river = world.riverAt(x, z);
        if (!river.wet) continue;
        wetSamples++;
        assert.ok(Math.abs(river.floor - world.height(x, z)) < 1e-9,
          'river floor and final railway terrain disagree');
        assert.ok(Math.abs(river.depth - (river.y - world.height(x, z))) < 1e-9,
          'river depth is not measured from final terrain');
      }
    }
  }
  assert.ok(wetSamples > 20, 'railway integration fixture did not sample river water');
}

console.log('rivers PASS · level cross-sections · two containing banks · exact clipped shorelines · final-ground depth');
