import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { waterPlanningTerrain } from '../src/waterplanningterrain.mjs';
import { planRegionalTrunk } from '../src/regionaltrunks.mjs';
import { addRegionalDelta } from '../src/regionaldeltas.mjs';
import { normalizeChannelProfile } from '../src/rivercharacter.mjs';
import { descriptorHash, BASIN_PLAN_VERSION } from '../src/hydrologyformat.mjs';
import { resolveWaterRegion } from '../src/hydrologyregions.mjs';

test('regional trunk restores broad, winding source-to-sea water on real terrain', () => {
  const world = waterPlanningTerrain(new World(20260612, { generationVersion: 3 }));
  const trunk = planRegionalTrunk(world, -1, -1);
  assert.equal(trunk.status, 'baked');
  const reach = trunk.component.reaches[0], points = reach.points;
  assert.ok(points.at(-1).arc > 1950);
  assert.ok(trunk.diagnostics.sinuosity > 1.3);
  const broad = points.filter(p => p.arc > 250 && p.arc < points.at(-1).arc - 150);
  assert.ok(broad.reduce((n, p) => n + p.leftWidth + p.rightWidth, 0) / broad.length > 65);
  assert.ok(Math.max(...broad.map(p => p.leftWidth + p.rightWidth)) > 95);
  assert.ok(Math.max(...broad.map(p => p.leftWidth + p.rightWidth))
    / Math.min(...broad.map(p => p.leftWidth + p.rightWidth)) > 1.4);
  assert.ok(points[0].leftWidth + points[0].rightWidth < 12);
  assert.equal(points.at(-1).waterY, 0);
  for (let i = 1; i < points.length; i++) assert.ok(points[i].waterY <= points[i - 1].waterY + 1e-9);
  assert.ok(JSON.stringify(trunk.mesh).length < 3000000);
});

test('regional delta shares one tidal head and hands every arm to the sea', () => {
  const terrain = waterPlanningTerrain(new World(20260612, { generationVersion: 3 }));
  const result = addRegionalDelta(terrain, planRegionalTrunk(terrain, -1, -1));
  assert.ok(result.delta.arms >= 2, 'at least one physical distributary forks before sea');
  assert.equal(result.component.reaches.filter(r => r.oceanMouth).length, result.delta.arms);
  assert.equal(result.mesh.grid.step, 8);
  for (const reach of result.component.reaches.filter(r => r.oceanMouth)) {
    const end = reach.points.at(-1);
    assert.equal(end.waterY, 0);
    assert.ok(terrain._naturalHeight(end.x, end.z) < -0.25);
  }
  const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, preview: true,
    regional: 1, seed: terrain.seed, regionX: -1, regionZ: -1, basins: [], components: [result.mesh] };
  const world = new World(terrain.seed, { generationVersion: 3,
    waterPlans: [{ ...payload, hash: descriptorHash(payload) }] });
  for (const reach of result.component.reaches) for (const p of reach.points) {
    if (p.arc < 40 || p.depth < 0.2) continue;
    const water = world.riverAt(p.x, p.z);
    assert.ok(water.wet, `connected wet centre ${reach.id}:${p.arc}`);
    assert.ok(world.height(p.x, p.z) < water.y);
  }
  const g = result.mesh.grid;
  for (let i = 0; i < g.floor.length; i++) assert.ok(g.floor[i] <= g.natural[i] + 1e-9);
});

test('wider profiles require explicit regional declaration', () => {
  const profile = { id: 'declared', halfWidth: 40, depth: 2 };
  assert.throws(() => normalizeChannelProfile(profile));
  assert.equal(normalizeChannelProfile({ ...profile, regionalTrunk: true }).halfWidth, 40);
  assert.throws(() => normalizeChannelProfile({ ...profile, regionalTrunk: true, halfWidth: 80.001 }));
  assert.throws(() => normalizeChannelProfile({ ...profile, regionalTrunk: 'yes' }));
});

test('regional trunk priority survives an overlapping smaller neighbouring feature', () => {
  const bounds = { minX: 0, minZ: 0, maxX: 100, maxZ: 100 };
  const candidate = { seed: 42, regionX: 0, regionZ: 0, basins: [],
    components: [{ bounds, regionalTrunk: true }] };
  const neighbour = { seed: 42, regionX: 1, regionZ: 0, basins: [{ bounds }], components: [] };
  assert.equal(resolveWaterRegion(candidate, [neighbour]).components.length, 1);
  assert.equal(resolveWaterRegion(neighbour, [candidate]).basins.length, 0);
});
