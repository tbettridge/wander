import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTerrainRoute, trailsAround, trailFrameAtArc, trailEcologyAt } from '../src/trails.js';
import { solveCrossing, deckHeightAt, DECK_MIN_CLEARANCE, DECK_STEP_UP } from '../src/trailcrossings.mjs';
import { buildCrossingRecipe } from '../src/crossinggeometry.mjs';
import { planWaterRegionCandidates } from '../src/hydrologyregions.mjs';
import { World } from '../src/world.js';
import { buildScatter } from '../src/chunkgen.js';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import { IMPOSTOR_TYPES } from '../src/vegdata.js';
import { setWorldRailwayTerrain, RAILWAY_TRACKBED_DROP } from '../src/railwayterrain.mjs';

let defaultRegional;
function defaultWorld() {
  if (!defaultRegional) {
    const seed = 20260612, plan = planWaterRegionCandidates(seed, -1, -1);
    defaultRegional = { seed, plan, world: new World(seed, { waterPlans: [plan] }) };
  }
  return defaultRegional;
}

function inlandRiver(width = 80, depth = 3.5) {
  const world = { seed: 42, generationVersion: 3, waterField: {}, waterPlanHash: 'first', rise: 0,
    height(x, z, out) {
      const waterY = 2 + x * 0.006 + this.rise;
      const wet = Math.abs(x) < width / 2;
      const h = wet ? waterY - depth : waterY + 0.08 + Math.min(3, (Math.abs(x) - width / 2) * 0.1);
      if (out) Object.assign(out, { floor: h, waterY, head: waterY, ch: wet ? 1 : 0,
        signedDepth: waterY - h, bodyId: 'river', bodyKind: 'river' });
      return h;
    },
    riverAt(x, z) {
      const out = {}; this.height(x, z, out);
      return { wet: out.ch > 0, y: out.waterY, depth: out.ch ? depth : 0, bodyId: 'river', kind: 'river' };
    },
    biomeAt(x, z) { return { h: this.height(x, z), slope: 0.02, id: 'grassland' }; },
  };
  return world;
}

function lineEdge(world) {
  const pts = new Float32Array([-120, 0, -60, 0, -40, 0, -39, 0, 0, 0, 39, 0, 40, 0, 60, 0, 120, 0]);
  const route = analyzeTerrainRoute(world, pts), n = pts.length / 2 - 1;
  const segments = { count: n, ax: [], az: [], dx: [], dz: [], len: [], invLen2: [], arc: [0] };
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 2 + 2] - pts[i * 2], dz = pts[i * 2 + 3] - pts[i * 2 + 1];
    const length = Math.hypot(dx, dz);
    segments.ax.push(pts[i * 2]); segments.az.push(pts[i * 2 + 1]);
    segments.dx.push(dx); segments.dz.push(dz); segments.len.push(length);
    segments.invLen2.push(1 / (length * length)); segments.arc.push(segments.arc.at(-1) + length);
  }
  return { id: 'river-crossing', width: 1.8, arcLength: segments.arc.at(-1), segments,
    fords: route.fords, route, pts };
}

test('owned inland river routes follow the water plane even when the bed lies below sea level', () => {
  const world = inlandRiver(), edge = lineEdge(world);
  assert.ok(world.height(0, 0) < 0);
  assert.equal(edge.fords.length, 1);
  assert.ok(edge.route.maxGrade < 0.12, 'a bridge route must not inherit the steep riverbed descent');
  assert.ok(edge.fords[0].maxDepth > 3);
});

test('owned generation3 tidal channels remain bridgeable at sea level without opening routes across the receiving ocean', () => {
  const world = inlandRiver();
  world.height = (x, z, out) => {
    const wet = Math.abs(x) < 40, h = wet ? -3.5 : 0.08 + Math.min(3, (Math.abs(x) - 40) * 0.1);
    if (out) Object.assign(out, { floor: h, waterY: 0, head: 0, ch: wet ? 1 : 0,
      signedDepth: -h, bodyId: 'tidal-river', bodyKind: 'river', estuary: world.estuary || 0 });
    return h;
  };
  const edge = lineEdge(world);
  assert.equal(edge.fords.length, 1);
  assert.ok(edge.route.maxGrade < 0.12, 'tidal channel routes follow the water plane');
  assert.equal(solveCrossing(world, edge, edge.fords[0]).kind, 'bridge');
  world.estuary = 1;
  assert.ok(lineEdge(world).route.maxGrade > 3, 'the receiving ocean retains its terrain and route exclusion');
  world.estuary = 0; world.generationVersion = 2;
  assert.ok(lineEdge(world).route.maxGrade > 3, 'legacy routing keeps its established sea-level threshold');
});

test('a wide regional river receives a supported timber bridge with clearance over its whole head', () => {
  const world = inlandRiver(), edge = lineEdge(world), ford = edge.fords[0];
  const solved = solveCrossing(world, edge, ford);
  assert.equal(solved.kind, 'bridge');
  assert.ok(solved.span > 75);
  assert.ok(Math.abs(solved.bankA.h - solved.surfaceY) <= DECK_STEP_UP);
  assert.ok(Math.abs(solved.bankB.h - solved.surfaceY) <= DECK_STEP_UP);
  const edgeMap = new Map([[edge.id, edge]]);
  for (let arc = solved.arcStart; arc <= solved.arcEnd; arc += 0.5) {
    const p = trailFrameAtArc(edge, arc, {}), water = world.riverAt(p.x, p.z);
    assert.equal(deckHeightAt([solved], edgeMap, p.x, p.z), solved.surfaceY);
    if (water.wet) assert.ok(solved.surfaceY - water.y >= DECK_MIN_CLEARANCE - 1e-6);
  }
  const recipe = buildCrossingRecipe(world, edge, ford, 'river-crossing:0', solved);
  assert.ok(recipe.instances.filter(i => i.type === 'plank').length > 150);
  assert.ok(recipe.instances.filter(i => i.type === 'trailPost').length > 12);
  assert.ok(recipe.instances.every(i => i.matrix.every(Number.isFinite)));
  assert.equal(solveCrossing(world, edge, ford), solved, 'repeat queries reuse the validated solve');
  world.rise = 0.2; world.waterPlanHash = 'second';
  const moved = solveCrossing(world, edge, ford);
  assert.notEqual(moved, solved);
  assert.ok(moved.surfaceY > solved.surfaceY + 0.19, 'a new plan invalidates the old deck height');
});

test('small tributaries retain plank and stone crossings while wide shallow rivers require a bridge', () => {
  for (const [width, depth, kind] of [[8, 1, 'plank-bridge'], [6, 0.2, 'stepping-stones'], [26, 0.2, 'bridge']]) {
    const world = inlandRiver(width, depth), edge = lineEdge(world);
    assert.equal(solveCrossing(world, edge, edge.fords[0]).kind, kind);
  }
});

test('fresh walkable crossings follow railway terrain installation, replacement and removal', () => {
  const world = inlandRiver(), naturalHeight = world.height;
  world.height = function(x, z, out) {
    const height = naturalHeight.call(this, x, z, out);
    if (out) out.riverInfluence = Math.abs(x) < 40;
    return height;
  };
  const edge = lineEdge(world), ford = edge.fords[0];
  let gathers = 0;
  const surface = new WalkableSurface(world, { trailsAround(w, x, z, seed, reach, out) {
    gathers++; out.push(edge);
  } });
  const original = surface.crossingsAt(0, 0)[0];
  const waterHash = world.waterPlanHash;
  for (const rise of [0.2, 0.4, 0]) {
    const spec = rise ? { version: 1, signature: `approach-fill:${rise}`,
      segments: new Float64Array([-70, 0, naturalHeight.call(world, -70, 0) + rise + RAILWAY_TRACKBED_DROP,
        -40, 0, naturalHeight.call(world, -40, 0) + rise + RAILWAY_TRACKBED_DROP,
        40, 0, naturalHeight.call(world, 40, 0) + rise + RAILWAY_TRACKBED_DROP,
        70, 0, naturalHeight.call(world, 70, 0) + rise + RAILWAY_TRACKBED_DROP]),
      kinds: new Uint8Array([2, 2]), stations: new Float64Array(0) } : null;
    setWorldRailwayTerrain(world, spec);
    const crossing = surface.crossingsAt(0, 0)[0];
    assert.equal(crossing, solveCrossing(world, edge, ford), 'footing must use the same current solve as the rendered structure');
    assert.notEqual(crossing, original);
    if (rise) assert.ok(Math.abs(crossing.surfaceY - original.surfaceY) > 1e-6
      || crossing.arcStart !== original.arcStart || crossing.arcEnd !== original.arcEnd,
    'changed dry approach support must change the physical deck solution');
    assert.equal(world.waterPlanHash, waterHash, 'railway changes do not require a water-plan replacement');
    assert.equal(surface.crossingsAt(0, 0)[0], crossing, 'unchanged authorities retain the cache');
  }
  assert.equal(gathers, 4, 'each authority change invalidates region and crossing caches once');
  const restored = surface.crossingsAt(0, 0)[0];
  assert.equal(restored.surfaceY, original.surfaceY);
  assert.equal(restored.arcStart, original.arcStart);
  assert.equal(restored.arcEnd, original.arcEnd);

  const legacyWorld = inlandRiver(); legacyWorld.generationVersion = 2;
  const legacyEdge = lineEdge(legacyWorld);
  const legacySurface = new WalkableSurface(legacyWorld, { trailsAround(w, x, z, seed, reach, out) { out.push(legacyEdge); } });
  const legacy = legacySurface.crossingsAt(0, 0)[0];
  legacyWorld.railwayTerrain = { signature: 'legacy-layout-authority' };
  assert.equal(legacySurface.crossingsAt(0, 0)[0], legacy, 'legacy layout crossing authority remains unchanged');
});

test('production regional trails build a real crossing from the current water field', () => {
  const plan = planWaterRegionCandidates(42, 0, 0), world = new World(42, { waterPlans: [plan] });
  const edges = trailsAround(world, 2052, 3555, 42, 1800, []);
  const candidates = edges.flatMap(edge => edge.fords.map(ford => ({ edge, ford,
    solved: solveCrossing(world, edge, ford) }))).filter(c => c.solved?.walkable);
  assert.ok(candidates.length > 0, 'regional walking routes must retain an actual supported crossing');
  const { edge, ford, solved } = candidates[0];
  const scatter = buildScatter(world, Math.floor(solved.x / 140), Math.floor(solved.z / 140), 140,
    { mode: 'full', res: 64, treeDensityScale: 0, audit: true });
  assert.ok(scatter.some(batch => batch.type === 'plank' && batch.matrices.length > 0));
  const record = scatter.trailRecords.find(r => r.edgeId === edge.id && r.kind === solved.kind);
  assert.ok(record);
  assert.ok(Math.abs(record.surfaceY - solved.surfaceY) < 1e-6);
  assert.ok(buildCrossingRecipe(world, edge, ford, 'review', solved).instances.length > 0);
});

test('the default wide regional trunk receives a visible timber bridge with safe water clearance', () => {
  const { seed, plan, world } = defaultWorld();
  const trunk = plan.components.find(component => component.regionalTrunk);
  assert.ok(trunk);
  const edges = trailsAround(world, -3890, -150, seed, 1900, []);
  const crossing = edges.flatMap(edge => edge.fords.map(ford => ({ edge, ford,
    solved: solveCrossing(world, edge, ford) }))).find(({ solved }) => solved?.walkable
      && solved.kind === 'bridge' && solved.span > 40
      && world.riverAt(solved.x, solved.z).bodyId === `component:${trunk.hash}`);
  assert.ok(crossing, 'a real default-world trail must cross the physical wide main river');
  const { edge, ford, solved } = crossing;
  for (let arc = solved.arcStart; arc <= solved.arcEnd; arc += 1) {
    const point = trailFrameAtArc(edge, arc, {}), water = world.riverAt(point.x, point.z);
    if (water.wet) assert.ok(solved.surfaceY - water.y >= DECK_MIN_CLEARANCE - 1e-6);
  }
  const scatter = buildScatter(world, Math.floor(solved.x / 140), Math.floor(solved.z / 140), 140,
    { mode: 'full', res: 64, treeDensityScale: 0, audit: true });
  assert.ok(scatter.some(batch => batch.type === 'plank' && batch.matrices.length > 0));
  assert.ok(scatter.trailRecords.some(record => record.edgeId === edge.id && record.kind === 'bridge'));
  assert.ok(buildCrossingRecipe(world, edge, ford, 'default-main-river', solved).instances.length > 150);
  const surface = new WalkableSurface(world, { trailsAround });
  surface.debug = false;
  let previous = null;
  for (let arc = solved.arcStart - 3; arc <= solved.arcEnd + 3; arc += 0.5) {
    const point = trailFrameAtArc(edge, arc, {});
    const height = surface.groundAt(point.x, point.z, solved.surfaceY);
    assert.ok(Number.isFinite(height));
    if (previous !== null) assert.ok(Math.abs(height - previous) <= DECK_STEP_UP + 0.05,
      `unwalkable deck/landing step at arc ${arc}`);
    if (arc > solved.arcStart + 1 && arc < solved.arcEnd - 1) {
      assert.equal(surface.heightAt(point.x, point.z, solved.surfaceY), solved.surfaceY);
      const water = world.riverAt(point.x, point.z);
      if (water.wet) {
        assert.equal(height, solved.surfaceY);
        assert.equal(surface.queryAt(point.x, point.z, solved.surfaceY).surfaceKind, 'trail-deck');
      }
    }
    previous = height;
  }
});

test('ordinary trees, saplings and riverside clusters keep their roots clear of generation3 trail cores', () => {
  const { seed, world } = defaultWorld();
  let checked = 0, riverside = 0;
  for (const [cx, cz] of [[-39, -5], [-25, -5], [-24, -2], [-29, -1]]) {
    const trails = trailsAround(world, cx * 140 + 70, cz * 140 + 70, seed, 180, []);
    assert.ok(trails.length > 0);
    const scatter = buildScatter(world, cx, cz, 140,
      { mode: 'full', res: 64, treeDensityScale: 1, audit: true });
    for (const batch of scatter) {
      if (!IMPOSTOR_TYPES.has(batch.type)) continue;
      for (let i = 0; i < batch.matrices.length; i += 16) {
        const x = batch.matrices[i + 12], z = batch.matrices[i + 14];
        const ecology = trailEcologyAt(trails, x, z, {});
        checked++;
        if ([[5, 0], [-5, 0], [0, 5], [0, -5]].some(([dx, dz]) => world.riverAt(x + dx, z + dz).wet)) riverside++;
        assert.ok(!ecology.edgeId || ecology.distance >= ecology.width + 2 - 0.001,
          `${batch.type} root obstructs trail in chunk${cx},${cz} at${x},${z}`);
      }
    }
  }
  assert.ok(checked > 100, 'the test must include ordinary forest trees and saplings');
  assert.ok(riverside > 0, 'the test must also include planted riverbank trees');
});
