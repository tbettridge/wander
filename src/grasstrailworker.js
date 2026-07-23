import { World } from './world.js';
import { buildGrassTrailBundle } from './grasstrailprep.mjs';

let world = null;

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'init') {
    world = new World(message.seed);
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
