// Testable protocol boundary for cave meshing workers. The main thread sends
// the exact finalized graph used to produce its sparse plan; workers never
// regenerate topology from a seed, which prevents generator/config drift.

import { createCaveField } from './cavefield.mjs';
import { caveGraphSignature } from './cavegen.mjs';
import { meshCaveChunk } from './cavemesh.mjs';

const DEFAULT_FIELD_CACHE_LIMIT = 8;

function transferablesFor(result) {
  const buffers = [];
  const seen = new Set();
  // `indices`/`index` are included for forward compatibility with indexed
  // streamed cave chunks. Current triangle-soup results use the first two.
  for (const key of ['positions', 'normals', 'indices', 'index']) {
    const value = result?.[key];
    const buffer = ArrayBuffer.isView(value) ? value.buffer : null;
    if (!(buffer instanceof ArrayBuffer) || seen.has(buffer)) continue;
    seen.add(buffer);
    buffers.push(buffer);
  }
  return buffers;
}

function requireMeshEnvelope(job) {
  if (!job || job.type !== 'mesh') return false;
  if (!Number.isSafeInteger(job.epoch) || job.epoch < 0) {
    throw new Error(`Invalid cave worker epoch ${String(job.epoch)}`);
  }
  if (!job.graph || typeof job.graph !== 'object') {
    throw new Error('Cave mesh job is missing its finalized graph');
  }
  if (typeof job.graphHash !== 'string' || !job.graphHash) {
    throw new Error('Cave mesh job is missing its graph hash');
  }
  if (!job.plan || typeof job.plan !== 'object') {
    throw new Error('Cave mesh job is missing its signed chunk plan');
  }
  if (!Number.isFinite(job.resolution) || job.resolution <= 0) {
    throw new Error(`Invalid cave worker resolution ${String(job.resolution)}`);
  }
  for (const axis of ['ix', 'iy', 'iz']) {
    if (!Number.isInteger(job.plan[axis])) {
      throw new Error(`Cave mesh plan has invalid ${axis} ${String(job.plan[axis])}`);
    }
    // Positional coordinates are retained during hot reload only. Refuse an
    // ambiguous envelope instead of silently meshing a different block.
    if (job[axis] !== undefined && job[axis] !== job.plan[axis]) {
      throw new Error(`Cave mesh job ${axis} disagrees with its signed plan`);
    }
  }
  return true;
}

export function createCaveWorkerProtocol({
  postMessage,
  createField = createCaveField,
  meshChunk = meshCaveChunk,
  fieldCacheLimit = DEFAULT_FIELD_CACHE_LIMIT,
} = {}) {
  if (typeof postMessage !== 'function') throw new Error('Cave worker protocol requires postMessage');
  if (typeof createField !== 'function' || typeof meshChunk !== 'function') {
    throw new Error('Cave worker protocol requires field and mesh functions');
  }
  if (!Number.isSafeInteger(fieldCacheLimit) || fieldCacheLimit < 1) {
    throw new Error(`Invalid cave worker field cache limit ${String(fieldCacheLimit)}`);
  }

  // Insertion order is the LRU order. A hit is refreshed; fields are keyed by
  // the verified graph content hash, never by the graph's source seed.
  const fieldCache = new Map();
  const fieldFor = (graph, verifiedGraphHash) => {
    let field = fieldCache.get(verifiedGraphHash);
    if (field) {
      fieldCache.delete(verifiedGraphHash);
      fieldCache.set(verifiedGraphHash, field);
      return field;
    }
    field = createField(graph);
    fieldCache.set(verifiedGraphHash, field);
    while (fieldCache.size > fieldCacheLimit) {
      fieldCache.delete(fieldCache.keys().next().value);
    }
    return field;
  };

  const handleJob = (job) => {
    if (!job || job.type !== 'mesh') return null;

    let actualGraphHash = null;
    let verifiedGraphHash = null;
    try {
      requireMeshEnvelope(job);
      actualGraphHash = caveGraphSignature(job.graph);
      if (actualGraphHash !== job.graphHash) {
        throw new Error(`Cave graph hash mismatch: requested ${job.graphHash}, actual ${actualGraphHash}`);
      }
      verifiedGraphHash = actualGraphHash;

      const result = meshChunk(
        fieldFor(job.graph, verifiedGraphHash),
        Number(job.resolution),
        job.plan,
      );
      const response = {
        ...result,
        type: 'mesh-result',
        requestId: job.requestId,
        cacheKey: job.cacheKey,
        epoch: job.epoch,
        graphHash: verifiedGraphHash,
      };
      postMessage(response, transferablesFor(result));
      return response;
    } catch (error) {
      const response = {
        type: 'mesh-error',
        requestId: job?.requestId,
        cacheKey: job?.cacheKey,
        epoch: job?.epoch ?? null,
        // `graphHash` is populated only after the supplied graph and requested
        // hash agree. Diagnostic fields retain both sides of a failed check.
        graphHash: verifiedGraphHash,
        requestedGraphHash: job?.graphHash ?? null,
        actualGraphHash,
        message: error?.stack || error?.message || String(error),
      };
      postMessage(response, []);
      return response;
    }
  };

  return {
    handleJob,
    clearFieldCache: () => fieldCache.clear(),
    fieldCacheSize: () => fieldCache.size,
  };
}

