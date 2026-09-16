// Worker for the first distant valley slice. It owns the deterministic World
// and emits one bounded terrain/water tile at a time. The main thread never
// builds a 6 km mesh or clones the accepted plan graph into a render object.

import { World } from './world.js?v=distant-water1';
import { decodeWaterWorkerPlans } from './waterstage.mjs';
import {
  buildDistantWaterTile,
  collectDistantWaterHints,
  enumerateDistantWaterTiles,
  validateDistantWaterOptions,
} from './distantwaterplan.mjs';

let activeJob = null;

function transferables(tile) {
  return [
    tile.terrain.positions.buffer,
    tile.terrain.normals.buffer,
    tile.terrain.colors.buffer,
    tile.terrain.indices.buffer,
    tile.water.positions.buffer,
    tile.water.normals.buffer,
    tile.water.indices.buffer,
    tile.samples.wet.buffer,
    tile.samples.waterLevels.buffer,
  ];
}

function yieldTask() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function cancelled(job) {
  return job.cancelled || activeJob !== job;
}

function sampleWorld(world, x, z, out = {}) {
  const natural = {};
  world._naturalHeight(x, z, natural);
  const info = {};
  const height = world.height(x, z, info);
  // Keep the callback serializable and intentionally omit the World internals.
  // The `signedDepth` and waterY values are authoritative accepted samples;
  // distant geometry never invents a water level from the coarse terrain.
  out.height = height;
  out.naturalHeight = natural.h;
  out.waterY = info.waterY;
  out.head = info.head;
  out.signedDepth = info.signedDepth;
  out.domainDepth = info.domainDepth;
  out.wet = info.signedDepth > 1e-3;
  out.bodyId = info.bodyId;
  out.bodyKind = info.bodyKind;
  out.flowX = info.flowX;
  out.flowZ = info.flowZ;
  return out;
}

async function prepare(job, message) {
  try {
    const options = validateDistantWaterOptions(message);
    const plans = decodeWaterWorkerPlans(message);
    const world = new World(message.seed, {
      waterPlans: plans,
      generationVersion: message.generationVersion ?? plans?.[0]?.generationVersion ?? 3,
    });
    const tiles = enumerateDistantWaterTiles(options);
    const hints = message.waterHints || collectDistantWaterHints(plans,
      { maxHints: Math.min(100000, options.maxTiles * 2048) });
    const hintSampleStep = Number.isFinite(message.hintSampleStep)
      ? message.hintSampleStep : undefined;
    let bytes = 0, waterTiles = 0, wetSamples = 0, waterTriangles = 0, waterArea = 0;
    let unsupportedWaterSamples = 0;
    self.postMessage({ type: 'distant-water-progress', id: job.id, completed: 0, total: tiles.length, bytes: 0,
      waterPlanHash: world.waterPlanHash || null });
    for (let index = 0; index < tiles.length; index++) {
      if (cancelled(job)) {
        self.postMessage({ type: 'distant-water-cancelled', id: job.id });
        return;
      }
      const tile = buildDistantWaterTile({
        tile: tiles[index],
        bounds: options.bounds,
        sampleStep: tileSampleStep(tiles[index], options, hints, hintSampleStep),
        sampleAt: (x, z, out) => sampleWorld(world, x, z, out),
      });
      bytes += tile.bytes;
      if (bytes > options.maxBytes) throw new RangeError(
        `Distant landscape memory budget exceeded (${bytes} > ${options.maxBytes})`,
      );
      if (tile.stats.waterTriangles) waterTiles++;
      wetSamples += tile.stats.wetSamples;
      waterTriangles += tile.stats.waterTriangles;
      waterArea += tile.stats.waterArea;
      unsupportedWaterSamples += tile.stats.unsupportedWaterSamples;
      self.postMessage({ type: 'distant-water-tile', id: job.id, index, total: tiles.length, tile,
        bytes, waterPlanHash: world.waterPlanHash || null }, transferables(tile));
      // A task boundary lets a cancellation request interrupt between tiles
      // and keeps a large 6 km view cooperative on slower devices.
      await yieldTask();
    }
    if (cancelled(job)) {
      self.postMessage({ type: 'distant-water-cancelled', id: job.id });
      return;
    }
    self.postMessage({ type: 'distant-water-ready', id: job.id, bounds: options.bounds,
      waterPlanHash: world.waterPlanHash || null,
      stats: { tileCount: tiles.length, waterTiles, bytes, wetSamples, waterTriangles, waterArea,
        unsupportedWaterSamples }, });
  } catch (error) {
    if (!cancelled(job)) self.postMessage({ type: 'distant-water-error', id: job.id,
      error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (activeJob === job) activeJob = null;
  }
}

function tileSampleStep(tile, options, hints, hintSampleStep) {
  if (!hints?.length) return options.sampleStep;
  const pad = options.sampleStep;
  const hinted = hints.some(hint => hint.x >= tile.minX - pad && hint.x <= tile.maxX + pad
    && hint.z >= tile.minZ - pad && hint.z <= tile.maxZ + pad);
  if (!hinted) return options.sampleStep;
  const refined = Number.isFinite(hintSampleStep) ? hintSampleStep : Math.max(4, options.sampleStep / 4);
  return Math.min(options.sampleStep, refined);
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === 'distant-water-cancel') {
    if (activeJob?.id === message.id) activeJob.cancelled = true;
    return;
  }
  if (message.type !== 'distant-water-prepare') return;
  if (activeJob) activeJob.cancelled = true;
  const job = { id: message.id, cancelled: false };
  activeJob = job;
  prepare(job, message);
};
