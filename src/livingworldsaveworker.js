// Serializes a living-world snapshot off the main thread.
//
// Normalizing, compacting and stringifying the whole living world is tens of
// milliseconds once a world has run a while, and the routine save used to do
// it inside a frame. The page sends a structured clone of the state; this
// returns the exact string the store would have written itself.
import { serializeLivingWorldState } from './livingworldstate.mjs';

self.onmessage = (event) => {
  const { id, state } = event.data || {};
  try {
    self.postMessage({ id, serialized: serializeLivingWorldState(state) });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
};
