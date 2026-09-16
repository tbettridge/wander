import { World } from './world.js';
import { buildGrassTrailBundle } from './grasstrailprep.mjs';
import { decodeWaterWorkerPlans } from './waterstage.mjs';

let world = null;

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'init') {
    world = new World(message.seed, { waterPlans: decodeWaterWorkerPlans(message),
      generationVersion: message.generationVersion, crossingManifests: message.crossingManifests || [] });
    self.postMessage({ type: 'ready' });
    return;
  }
  if (message.type !== 'prepare' || !world) return;
  try {
    const bundle = buildGrassTrailBundle(world, message.spec);
    self.postMessage(
      { type: 'prepared', id: message.id, bundle },
      [bundle.coverage.buffer, bundle.height.buffer],
    );
  } catch (error) {
    self.postMessage({
      type: 'failed',
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
