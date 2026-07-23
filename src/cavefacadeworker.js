import { createCaveFacadeWorkerProtocol } from './cavefacadeworker-protocol.mjs';

const protocol = createCaveFacadeWorkerProtocol({
  postMessage: (message, transferables) => self.postMessage(message, transferables),
});

self.onmessage = (event) => protocol.handleJob(event.data);
