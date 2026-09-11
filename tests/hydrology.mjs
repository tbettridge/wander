import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { descriptorHash } from '../src/hydrologyformat.mjs';
import { solveCrossing } from '../src/trailcrossings.mjs';
import { buildCrossingRecipe } from '../src/crossinggeometry.mjs';
import { World } from '../src/world.js';
import { priorityFlood, floodBasin } from '../src/drainage.mjs';
import { planBasins } from '../src/basinplanner.mjs';
import { prepareBasinRegion } from '../src/hydrologyworker.js';
import { captureCrossingManifest, readCrossingManifest, CrossingReservations } from '../src/crossingpreservation.mjs';
import { trailsAround, clearTrailCache } from '../src/trails.js';
import { buildTerrainArrays, buildRiver, buildScatter, sampleRenderedTerrainTriangle } from '../src/chunkgen.js';

test('depression analysis retains natural terrain, drains flats without cycles, rejects cropped basins', () => {
  const size = 17, heights = new Float64Array(size * size).fill(10);
  for (let z = 3; z < 14; z++) for (let x = 3; x < 14; x++) heights[z * size + x] = 2;
  heights[8 * size + 2] = 6; // a lower sill, followed by a descending outlet
  heights[8 * size + 1] = 5; heights[8 * size] = 4;
  heights[7 * size + 7] = 11; // surviving island
  const original = heights.slice(), start = 8 * size + 8;
  const drainage = priorityFlood(heights, size);
  assert.deepEqual(heights, original);
  assert.equal(drainage.filled[start], 6);
  for (let i = 0; i < heights.length; i++) {
    const visited = new Set();
    for (let n = i; n >= 0; n = drainage.parent[n]) {
      assert.ok(!visited.has(n), 'drainage cycle'); visited.add(n);
      const p = drainage.parent[n];
      if (p >= 0) assert.ok(drainage.filled[p] <= drainage.filled[n]);
    }
  }
  const basin = floodBasin(heights, size, start, 5.7);
  assert.equal(basin.boundary, false);
  assert.equal(basin.rim, 6);
  assert.equal(basin.mask[7 * size + 7], 0);
  assert.equal(floodBasin(heights, size, start, 10.1).boundary, true);
});

test('crossing extraction preserves original complete scatter payloads and records', () => {
  // Captured from 842d14a before extracting the live construction recipe.
  const gold = [
    [-14, -2, 'e98d7ee7ba8ef07f533d08c349a9cb0f0ca6c97721caa9f68c93140cc86cc30d'],
    [-8, -8, '18fd79d6e42e5639c7ec6c5889b1c6e22e3fad1cf9c037a6bed508afc5120da8'],
    [-15, -14, 'a4d1b2676ca896bb83c272b74bfb9f1aff8471be2e3c5a0e83d23df6093f79a7'],
    [5, 29, 'ec274c5c9277dcc0e1b40cb8391e617cb8aa2686d1757241f3069169a55bba8e'],
  ];
  const world = new World(20260612);
  clearTrailCache();
  for (const [cx, cz, hash] of gold) {
    const scatter = buildScatter(world, cx, cz, 140, { mode: 'full', res: 64, audit: true });
    assert.equal(createHash('sha256').update(JSON.stringify(scatter)).digest('hex'), hash);
  }
});

test('crossing manifests freeze realised recipes, complete approaches and route identity', () => {
  const world = new World(20260612);
  const edges = trailsAround(world, 0, 0, world.seed, 1500, []);
  const a = captureCrossingManifest(world, edges);
  const b = captureCrossingManifest(world, [...edges].reverse());
  assert.equal(a.hash, b.hash);
  const restored = readCrossingManifest(JSON.parse(JSON.stringify(a)), { seed: world.seed });
  assert.deepEqual(restored, a);
  const index = new CrossingReservations([restored, b]);
  const migrated = new World(world.seed, { waterPlans: [], crossingManifests: [restored] });
  const restoredEdges = trailsAround(migrated, 0, 0, world.seed, 1500, []);
  for (const original of edges) {
    const edge = restoredEdges.find(e => e.id === original.id);
    assert.ok(edge.segments.bins instanceof Map);
    for (let i = 0; i < edge.fords.length; i++) {
      const crossing = edge.fords[i], id = `${edge.id}:crossing:${i}`;
      const entry = index.crossings.get(id);
      assert.deepEqual(solveCrossing(migrated, edge, crossing), entry.solved);
      assert.deepEqual(buildCrossingRecipe(migrated, edge, crossing, id, entry.solved), entry.recipe);
    }
  }
  const conflicting = structuredClone(restored);
  conflicting.routes[0].width += 1;
  const { hash: ignored, ...payload } = conflicting;
  conflicting.hash = descriptorHash(payload);
  assert.throws(() => new CrossingReservations([restored, conflicting]), /Conflicting preserved route/);
  assert.ok(a.crossings.length >= 4);
  for (const crossing of a.crossings.filter(c => c.solved)) {
    assert.ok(crossing.recipe.instances.length > 0);
    assert.ok(Object.isFrozen(crossing.recipe.instances[0].matrix));
    for (const point of crossing.reservation.points) assert.ok(index.at(point.x, point.z));
    assert.ok(crossing.waterInterval[0] <= crossing.solved.waterY);
    assert.ok(crossing.waterInterval[1] >= crossing.solved.waterY - 1e-9);
    for (const instance of crossing.recipe.instances) {
      assert.ok(index.at(instance.matrix[12], instance.matrix[14]), 'support outside protected envelope');
    }
  }
  const corrupt = structuredClone(a);
  corrupt.crossings.find(c => c.solved).solved.surfaceY += 1;
  assert.throws(() => readCrossingManifest(corrupt), /checksum/);
  assert.throws(() => readCrossingManifest(a, { seed: 17 }), /seed/);
});

test('six-seed basin corpus has level, contained, unexcavated water with explicit identities', () => {
  let count = 0;
  for (const seed of [20260612, 4242, 1, 42, 8675309, 12345]) {
    const original = new World(seed), plan = planBasins(original, 0, 0);
    const world = new World(seed, { waterPlans: [plan] });
    for (const body of plan.basins) {
      count++;
      assert.ok(body.level < body.spill && body.rim >= body.level);
      assert.ok(body.length <= 600 && body.area > 0);
      assert.ok(body.grid.signed.some(depth => depth > 0.3));
      for (let i = 0; i < body.grid.floor.length; i++) {
        if (body.grid.signed[i] <= 0) continue;
        const x = body.grid.x0 + (i % body.grid.cols) * body.grid.step;
        const z = body.grid.z0 + Math.floor(i / body.grid.cols) * body.grid.step;
        const river = world.riverAt(x, z);
        assert.equal(river.kind, body.kind);
        assert.equal(river.y, body.level);
        assert.equal(river.flowX, 0); assert.equal(river.flowZ, 0);
        assert.ok(Math.abs(world.height(x, z) - original._naturalHeight(x, z)) < 1e-8);
      }
    }
    // Installing a malformed replacement never discards the active field.
    const before = world.waterPlanHash, corrupt = structuredClone(plan);
    corrupt.hash = 'bad';
    assert.throws(() => world.installWaterPlans([corrupt]), /checksum/);
    assert.equal(world.waterPlanHash, before);
  }
  assert.ok(count >= 8, `corpus must exercise actual basins, got ${count}`);
});

test('protected basin planning and mixed detail share exact shores and gameplay depths', () => {
  const { plan, manifest } = prepareBasinRegion({ seed: 20260612, regionX: 0, regionZ: 0 });
  assert.ok(plan.basins.some(body => body.kind === 'lake'));
  assert.ok(plan.basins.some(body => body.kind === 'pond'));
  const world = new World(plan.seed, { waterPlans: [plan], crossingManifests: [manifest] }), index = new CrossingReservations([manifest]);
  let shoreVertices = 0, wetProbes = 0;
  const chunks = new Map();
  for (const body of plan.basins) {
    for (let cz = Math.floor(body.bounds.minZ / 140); cz <= Math.floor(body.bounds.maxZ / 140); cz++) {
      for (let cx = Math.floor(body.bounds.minX / 140); cx <= Math.floor(body.bounds.maxX / 140); cx++) {
        let reference;
        for (const res of [16, 24, 48, 96, 112]) {
          const terrain = buildTerrainArrays(world, cx, cz, res, 140);
          const mesh = buildRiver(cx, cz, res, 140, terrain.river);
          if (!mesh) continue;
          if (reference) assert.deepEqual(mesh, reference, 'water changed with requested detail');
          reference = mesh;
          chunks.set(`${cx},${cz}`, { cx, cz, mesh });
          for (let i = 0; i < mesh.wet.length; i++) {
            if (mesh.body[i * 4] < 0.5) continue;
            const x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
            assert.equal(mesh.body[i * 4 + 3], 0, 'inland water was given to the ocean');
            if (mesh.wet[i] === 0) {
              shoreVertices++;
              const ground = sampleRenderedTerrainTriangle(terrain.positions, terrain.res, 140, cx * 140, cz * 140, x, z).y;
              assert.ok(Math.abs(ground - y) < 0.001, `shore gap ${ground - y}`);
            } else if (mesh.wet[i] > 0.1) {
              wetProbes++;
              assert.equal(index.at(x, z), null); assert.equal(index.routeAt(x, z), false);
              const water = world.riverAt(x, z);
              assert.ok(Math.abs(water.y - y) < 1e-4);
              assert.ok(Math.abs(water.depth - mesh.wet[i]) < 0.002, 'rendered and physical water disagree');
            }
          }
        }
      }
    }
  }
  const boundary = (mesh, x) => {
    const points = [];
    for (let i = 0; i < mesh.wet.length; i++) if (mesh.positions[i * 3] === x) {
      points.push([mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]]);
    }
    return points.sort((a, b) => a[1] - b[1]);
  };
  let seams = 0;
  for (const { cx, cz, mesh } of chunks.values()) {
    const neighbour = chunks.get(`${cx + 1},${cz}`);
    if (!neighbour) continue;
    const a = boundary(mesh, (cx + 1) * 140), b = boundary(neighbour.mesh, (cx + 1) * 140);
    if (!a.length && !b.length) continue;
    assert.deepEqual(a, b); seams++;
  }
  assert.ok(shoreVertices > 500 && wetProbes > 500 && seams > 0);
  const repeat = prepareBasinRegion({ seed: 20260612, regionX: 0, regionZ: 0 });
  assert.equal(repeat.plan.hash, plan.hash); assert.equal(repeat.manifest.hash, manifest.hash);
});

test('real geometry worker carries basin identity and rejects a mismatched plan', async () => {
  const { plan, manifest } = prepareBasinRegion({ seed: 20260612, regionX: 0, regionZ: 0 });
  const basin = plan.basins.find(body => body.kind === 'lake');
  const world = new World(plan.seed, { waterPlans: [plan], crossingManifests: [manifest] });
  const messages = [];
  globalThis.self = { postMessage(message, transfer = []) { messages.push(structuredClone(message, { transfer })); } };
  try {
    await import('../src/worker.js?hydrology-test');
    self.onmessage({ data: { type: 'init', seed: plan.seed, waterPlans: [plan], crossingManifests: [manifest] } });
    const request = { type: 'build', id: 1, cx: Math.floor(basin.centerX / 140), cz: Math.floor(basin.centerZ / 140),
      res: 16, chunkSize: 140, doTerrain: true, waterPlanHash: world.waterPlanHash };
    self.onmessage({ data: request });
    const built = messages.at(-1);
    assert.equal(built.type, 'built'); assert.equal(built.waterPlanHash, world.waterPlanHash);
    assert.ok(built.river?.wet.some(depth => depth > 1));
    assert.ok(built.river.body.some((v, i) => i % 4 === 0 && v === 2));
    const directTerrain = buildTerrainArrays(world, request.cx, request.cz, request.res, 140);
    const direct = buildRiver(request.cx, request.cz, request.res, 140, directTerrain.river);
    assert.deepEqual(built.river, direct);
    self.onmessage({ data: { ...request, waterPlanHash: 'stale' } });
    assert.equal(messages.at(-1).type, 'build-error');
  } finally { delete globalThis.self; }
});
