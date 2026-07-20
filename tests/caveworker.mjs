import assert from 'node:assert/strict';
import { generateCaveGraph, caveGraphSignature } from '../src/cavegen.mjs';
import { createCaveChunkPlan } from '../src/cavemesh.mjs';
import { createCaveWorkerProtocol } from '../src/caveworker-protocol.mjs';

const graph = generateCaveGraph(0x51deca7e);
const graphHash = caveGraphSignature(graph);
const signedPlan = { key: '-3_2_5', ix: -3, iy: 2, iz: 5 };
const messages = [];
let fieldBuilds = 0;
let meshCalls = 0;
let firstFieldGraph = null;

const protocol = createCaveWorkerProtocol({
  fieldCacheLimit: 1,
  postMessage(message, transferables) { messages.push({ message, transferables }); },
  createField(finalizedGraph) {
    fieldBuilds++;
    firstFieldGraph ??= finalizedGraph;
    return { graph: finalizedGraph };
  },
  meshChunk(field, resolution, plan) {
    meshCalls++;
    assert.equal(resolution, 48, 'worker changed the requested resolution');
    assert.equal(plan, signedPlan, 'worker did not pass the authoritative signed plan');
    assert.ok(field.graph, 'worker did not construct its field from a finalized graph');
    if (plan.fail) throw new Error('synthetic mesher failure');
    return {
      key: plan.key, ix: plan.ix, iy: plan.iy, iz: plan.iz,
      positions: new Float32Array([1, 2, 3]),
      normals: new Float32Array([0, 1, 0]),
      surfaces: new Uint8Array([10, 20, 30, 40]),
      indices: new Uint16Array([0]),
      triangles: 0, bytes: 30,
    };
  },
});

const validJob = {
  type: 'mesh', requestId: 1, cacheKey: 'valid', epoch: 7,
  graph, graphHash, resolution: 48, plan: signedPlan,
  ix: signedPlan.ix, iy: signedPlan.iy, iz: signedPlan.iz,
};
const valid = protocol.handleJob(validJob);
assert.equal(valid.type, 'mesh-result');
assert.equal(valid.epoch, 7, 'success did not echo the generation epoch');
assert.equal(valid.graphHash, graphHash, 'success did not echo the verified graph hash');
assert.equal(fieldBuilds, 1);
assert.equal(meshCalls, 1);
assert.equal(firstFieldGraph, graph, 'worker regenerated or replaced the finalized graph');
assert.equal(messages[0].transferables.length, 4, 'worker omitted a geometry transfer buffer');
assert.ok(valid.surfaces instanceof Uint8Array, 'worker dropped the semantic surface channel');

// Once this worker has verified a finalized graph, later block requests can
// name its cached field by content hash without cloning the full graph again.
const cached = protocol.handleJob({
  ...validJob, requestId: 2, cacheKey: 'cached', graph: undefined,
});
assert.equal(cached.type, 'mesh-result', cached.message);
assert.equal(cached.graphHash, graphHash);
assert.equal(fieldBuilds, 1, 'verified graph hash did not reuse the cached field');
assert.equal(meshCalls, 2);

// Omitting a graph is only valid after that exact content hash has been
// initialized in this worker; an arbitrary hash cannot select a field.
const uninitialized = protocol.handleJob({
  ...validJob, requestId: 20, cacheKey: 'uninitialized', graph: undefined,
  graphHash: 'ffffffffffffffff',
});
assert.equal(uninitialized.type, 'mesh-error');
assert.equal(uninitialized.graphHash, null);
assert.match(uninitialized.message, /not initialized/i);

signedPlan.fail = true;
const meshFailure = protocol.handleJob({ ...validJob, requestId: 21, cacheKey: 'mesh-failure', epoch: 9 });
delete signedPlan.fail;
assert.equal(meshFailure.type, 'mesh-error');
assert.equal(meshFailure.epoch, 9, 'mesh error did not echo its epoch');
assert.equal(meshFailure.graphHash, graphHash, 'mesh error did not echo the verified graph hash');
assert.equal(meshFailure.actualGraphHash, graphHash);
assert.match(meshFailure.message, /synthetic mesher failure/i);

const changedGraph = structuredClone(graph);
changedGraph.chambers[0].r[0] += 0.125;
const changedHash = caveGraphSignature(changedGraph);
assert.notEqual(changedHash, graphHash, 'test graph mutation did not affect its canonical hash');
protocol.handleJob({
  ...validJob, requestId: 3, cacheKey: 'changed', graph: changedGraph, graphHash: changedHash,
});
assert.equal(fieldBuilds, 2, 'same-seed graph content was incorrectly cached by seed');

// The one-entry LRU evicted the first graph, proving the cache remains bounded.
firstFieldGraph = graph;
protocol.handleJob({ ...validJob, requestId: 4, cacheKey: 'reloaded' });
assert.equal(fieldBuilds, 3, 'bounded field cache did not evict its least-recent graph');
assert.equal(protocol.fieldCacheSize(), 1);

const callsBeforeMismatch = meshCalls;
const mismatch = protocol.handleJob({
  ...validJob, requestId: 5, cacheKey: 'mismatch', epoch: 12, graphHash: changedHash,
});
assert.equal(mismatch.type, 'mesh-error');
assert.equal(mismatch.epoch, 12, 'hash error did not echo its epoch');
assert.equal(mismatch.graphHash, null, 'unverified requested hash was echoed as verified');
assert.equal(mismatch.requestedGraphHash, changedHash);
assert.equal(mismatch.actualGraphHash, graphHash);
assert.match(mismatch.message, /graph hash mismatch/i);
assert.equal(meshCalls, callsBeforeMismatch, 'hash-mismatched graph reached the mesher');

const ambiguous = protocol.handleJob({ ...validJob, requestId: 6, ix: signedPlan.ix + 1 });
assert.equal(ambiguous.type, 'mesh-error');
assert.equal(ambiguous.graphHash, null, 'ambiguous envelope reached graph verification');
assert.match(ambiguous.message, /disagrees with its signed plan/i);

assert.equal(protocol.handleJob({ type: 'noop' }), null, 'unknown worker job was not ignored');

// Exercise the real field and current signed-plan mesher API once so protocol
// tests cannot pass with an obsolete positional call shape.
const actualMessages = [];
const actualProtocol = createCaveWorkerProtocol({
  postMessage(message, transferables) { actualMessages.push({ message, transferables }); },
});
const actualPlan = createCaveChunkPlan(graph, 48)[0];
const actual = actualProtocol.handleJob({
  type: 'mesh', requestId: 7, cacheKey: `actual:${actualPlan.key}`,
  epoch: 19, graph, graphHash, resolution: 48, plan: actualPlan,
});
assert.equal(actual.type, 'mesh-result', actual.message);
assert.equal(actual.key, actualPlan.key);
assert.equal(actual.epoch, 19);
assert.equal(actual.graphHash, graphHash);
assert.ok(actualMessages[0].transferables.length >= 2, 'real geometry buffers were not transferred');

console.log(`caveworker PASS · verified ${graphHash} · signed ${signedPlan.key} · cache LRU · epoch ${actual.epoch}`);
