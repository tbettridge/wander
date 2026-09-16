import { World } from './world.js';
import { createWaterAgreement } from './wateragreement.mjs';

export function validateTravelLandscape(seed, landscape) {
  if (!(landscape?.world instanceof World) || landscape.world.seed !== seed) throw new Error('Travel landscape seed mismatch');
  const { world, stream } = landscape;
  if (stream && (stream.disposed || stream.seed !== seed || !stream.active)) throw new Error('Travel landscape stream unavailable');
  if (world.generationVersion === 3 && world.waterField?.plans.some(p => p.regional === 1)) {
    if (!stream) throw new Error('Regional travel requires a prepared stream');
    createWaterAgreement(seed, stream.active.regionX, stream.active.regionZ, world.waterField.plans);
  }
  return landscape;
}

// Keep one home snapshot. World identity is shared by render/physics services,
// so capture its properties before adoption changes that object's contents.
export function captureTravelLandscape(world, stream = null) {
  const snapshot = Object.assign(Object.create(World.prototype), world);
  return validateTravelLandscape(world.seed, { world: snapshot, stream });
}

export function adoptTravelLandscape(world, seed, landscape = null, { currentStream = null, retainedStream = null } = {}) {
  const incoming = validateTravelLandscape(seed, landscape || { world: new World(seed), stream: null });
  const replacement = { ...incoming.world };
  // Validate before touching either current terrain or the worker that owns it.
  for (const key of Object.keys(world)) delete world[key];
  Object.assign(world, replacement);
  if (currentStream && currentStream !== incoming.stream && currentStream !== retainedStream) currentStream.dispose();
  return incoming.stream || null;
}
