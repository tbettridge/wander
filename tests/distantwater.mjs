import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDistantWaterStage,
  buildDistantWaterTile,
  enumerateDistantWaterTiles,
} from '../src/distantwaterplan.mjs';
import { DistantWaterLandscape } from '../src/distantwater.js';

function ringSampler(x, z) {
  const distance = Math.hypot(x, z);
  const wet = distance < 112 && distance > 28;
  return {
    height: wet ? 4 : 11,
    waterY: 8,
    signedDepth: wet ? 4 : -1,
    wet,
    color: [0.2, 0.25, 0.22],
  };
}

test('distant tiles carry a supported lake surface and retain a shoreline hole', () => {
  const stage = buildDistantWaterStage({ center: { x: 0, z: 0 }, radius: 256,
    tileSize: 128, sampleStep: 8, maxTiles: 64, maxBytes: 4 * 1024 * 1024, sampleAt: ringSampler });
  assert.equal(stage.stats.unsupportedWaterSamples, 0);
  assert.ok(stage.stats.waterTiles > 0);
  assert.ok(stage.stats.waterArea > 20_000 && stage.stats.waterArea < 45_000,
    `unexpected ring water area ${stage.stats.waterArea}`);
  let vertices = 0;
  for (const tile of stage.tiles) {
    for (let i = 1; i < tile.terrain.normals.length; i += 3) assert.ok(tile.terrain.normals[i] > 0,
      'distant terrain support must face the overlook');
    vertices += tile.water.positions.length / 3;
    for (let i = 0; i < tile.water.positions.length; i += 3) {
      const x = tile.water.positions[i], y = tile.water.positions[i + 1], z = tile.water.positions[i + 2];
      assert.equal(y, 8, 'lake water level must come from the accepted sample');
      assert.ok(Math.hypot(x, z) > 20, 'water polygon crossed into the island hole');
    }
    for (let i = 1; i < tile.water.normals.length; i += 3) assert.ok(tile.water.normals[i] > 0,
      'distant water normals must face upward');
  }
  assert.ok(vertices > 0);
});

test('distant water preserves an accepted sloping river level without shader displacement', () => {
  const stage = buildDistantWaterStage({ center: { x: 0, z: 0 }, radius: 128,
    tileSize: 128, sampleStep: 16, maxTiles: 16, sampleAt: (x, z) => {
    const wet = Math.abs(z) < 28 && Math.abs(x) < 110;
    return { height: wet ? 2 : 10, waterY: 7 - x * 0.01, signedDepth: wet ? 5 : -1, wet };
  } });
  const levels = [];
  for (const tile of stage.tiles) for (let i = 0; i < tile.water.positions.length; i += 3) {
    levels.push(tile.water.positions[i + 1]);
  }
  assert.ok(levels.length > 0);
  assert.ok(Math.min(...levels) < 6 && Math.max(...levels) > 8,
    'river water geometry lost the accepted level slope');
  assert.equal(stage.stats.unsupportedWaterSamples, 0);
});

test('unsupported wet samples are rejected instead of floating above coarse terrain', () => {
  const stage = buildDistantWaterStage({ center: { x: 0, z: 0 }, radius: 64,
    tileSize: 128, sampleStep: 16, maxTiles: 4, sampleAt: () => ({
      height: 10, waterY: 8, signedDepth: 2, wet: true,
    }) });
  assert.ok(stage.stats.unsupportedWaterSamples > 0);
  assert.equal(stage.stats.waterTriangles, 0);
  assert.equal(stage.stats.waterArea, 0);
});

test('accepted water hints refine a river thinner than the overview sample step', () => {
  const sampler = (x, z) => {
    // A four metre channel sits between the 32 m overview rows. Without its
    // accepted descriptor hint every coarse corner is dry.
    const wet = Math.abs(z - 3.5) < 2 && Math.abs(x) < 52;
    return { height: wet ? 2 : 10, waterY: 7, signedDepth: wet ? 5 : -1, wet };
  };
  const coarse = buildDistantWaterStage({ center: { x: 0, z: 0 }, radius: 64,
    tileSize: 128, sampleStep: 32, maxTiles: 4, sampleAt: sampler });
  assert.equal(coarse.stats.waterTriangles, 0, 'coarse samples should miss the subpixel channel');
  const refined = buildDistantWaterStage({ center: { x: 0, z: 0 }, radius: 64,
    tileSize: 128, sampleStep: 32, hintSampleStep: 4, waterHints: [{ x: 0, z: 3.5 }],
    maxTiles: 4, sampleAt: sampler });
  assert.ok(refined.stats.refinedTiles > 0);
  assert.ok(refined.stats.waterTriangles > 0, 'accepted hint must recover the narrow channel');
  assert.equal(refined.stats.unsupportedWaterSamples, 0);
});

test('separate wet corners never bridge across a dry diagonal', () => {
  const tile = { key: 'fixture', ix: 0, iz: 0, x0: -16, z0: -16, width: 32, height: 32,
    minX: -16, maxX: 16, minZ: -16, maxZ: 16 };
  const result = buildDistantWaterTile({ tile, sampleStep: 16, sampleAt: (x, z) => {
    const wet = (x < -7 && z < -7) || (x > 7 && z > 7);
    return { height: wet ? 1 : 10, waterY: 4, signedDepth: wet ? 3 : -1, wet };
  } });
  // Two opposite wet corners produce two clipped islands. A single triangle
  // spanning both would have nearly the full cell area.
  assert.equal(result.stats.waterTriangles, 2);
  assert.ok(result.stats.waterArea < 200, `unexpected bridged water area ${result.stats.waterArea}`);
});

test('shore clipping follows a deep dry signed distance instead of a unit fallback', () => {
  const tile = { key: 'shore', ix: 0, iz: 0, x0: 0, z0: 0, width: 32, height: 32,
    minX: 0, maxX: 32, minZ: 0, maxZ: 32 };
  const result = buildDistantWaterTile({ tile, sampleStep: 16, sampleAt: (x, z) => {
    const wet = x < 16 && z < 16;
    return { height: wet ? 1 : 10, waterY: 4, signedDepth: wet ? 3 : -100, wet };
  } });
  // With the old -1 dry fallback this corner occupied roughly a quarter of a
  // cell; the accepted -100 shore should leave only a narrow clipped wedge.
  assert.ok(result.stats.waterArea < 30, `dry bank pulled too much water (${result.stats.waterArea})`);
});

test('refinement on a shared tile edge is symmetric', () => {
  const stage = buildDistantWaterStage({ center: { x: 0, z: 0 }, radius: 64,
    tileSize: 64, sampleStep: 32, hintSampleStep: 4, waterHints: [{ x: 31, z: 0 }],
    maxTiles: 16, sampleAt: (x, z) => ({
      height: Math.abs(z) < 4 && Math.abs(x) < 60 ? 1 : 10,
      waterY: 4, signedDepth: Math.abs(z) < 4 && Math.abs(x) < 60 ? 3 : -1,
      wet: Math.abs(z) < 4 && Math.abs(x) < 60,
    }) });
  const edgeTiles = stage.tiles.filter(tile => tile.ix === -1 || tile.ix === 0);
  assert.ok(edgeTiles.length >= 2);
  for (const tile of edgeTiles) assert.ok(tile.stepX <= 4.01 && tile.stepZ <= 4.01,
    'neighboring tiles must share the refinement tier at a water boundary');
});

test('distant preparation is bounded and cancellable while the previous stage remains committed', async () => {
  const sent = [];
  let prepareCount = 0;
  class FakeWorker {
    postMessage(message) {
      sent.push(message);
      if (message.type === 'distant-water-cancel') return;
      if (message.type !== 'distant-water-prepare') return;
      prepareCount++;
      const id = message.id;
      const tiles = enumerateDistantWaterTiles(message);
      const emit = (index = 0) => {
        if (index >= tiles.length) {
          this.onmessage({ data: { type: 'distant-water-ready', id, bounds: {
            minX: -64, minZ: -64, maxX: 64, maxZ: 64, centerX: 0, centerZ: 0, radius: 64,
          }, stats: { tileCount: tiles.length, waterTiles: 1, waterTriangles: 1, waterArea: 1 } } });
          return;
        }
        const tile = buildDistantWaterTile({ tile: tiles[index], sampleStep: message.sampleStep,
          bounds: { centerX: 0, centerZ: 0, radius: message.radius }, sampleAt: () => ({
            height: 1, waterY: 4, signedDepth: 3, wet: true,
          }) });
        this.onmessage({ data: { type: 'distant-water-tile', id, index, total: tiles.length, tile,
          bytes: tile.bytes, waterPlanHash: 'fake' } });
        setTimeout(() => emit(index + 1), 0);
      };
      setTimeout(() => emit(), prepareCount === 1 ? 0 : 12);
    }
    terminate() { this.terminated = true; }
  }
  const landscape = new DistantWaterLandscape(null, { workerFactory: () => new FakeWorker() });
  const first = await landscape.prepare({ seed: 7, waterPlansJSON: null, center: { x: 0, z: 0 },
    radius: 64, tileSize: 128, sampleStep: 32, maxTiles: 4, maxBytes: 2 * 1024 * 1024 });
  assert.equal(landscape.ready, first);
  const pending = landscape.prepare({ seed: 7, waterPlansJSON: null, center: { x: 0, z: 0 },
    radius: 64, tileSize: 128, sampleStep: 32, maxTiles: 4, maxBytes: 2 * 1024 * 1024 });
  assert.equal(landscape.ready, first, 'old complete stage should remain visible while replacing it');
  landscape.cancel();
  await assert.rejects(pending, /cancel/i);
  assert.equal(landscape.ready, first);
  assert.equal(prepareCount, 2);
  assert.ok(sent.some(message => message.type === 'distant-water-cancel'));
  landscape.dispose();
});
