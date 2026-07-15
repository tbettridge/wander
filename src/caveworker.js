// Dedicated Phase-2 cave meshing worker. The protocol verifies the exact graph
// supplied by the main thread before constructing or reusing its field.

import { createCaveWorkerProtocol } from './caveworker-protocol.mjs';

const protocol = createCaveWorkerProtocol({
  postMessage: (message, transferables) => self.postMessage(message, transferables),
});

self.onmessage = (event) => protocol.handleJob(event.data);
