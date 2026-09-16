import { watershedDescriptorFromWaterPlan } from './watersheddescriptor.mjs';
import { serializeWatershedDescriptor, deserializeWatershedDescriptor } from './watershedpacking.mjs';
import { decodeWaterWorkerPlans } from './waterstage.mjs';

function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

// An opt-in inspection report, never part of world startup or animation work.
self.onmessage = ({ data }) => {
  try {
    if (data?.type !== 'descriptor-report' || ![data.seed, data.regionX, data.regionZ].every(Number.isSafeInteger)) {
      throw new Error('Invalid descriptor report request');
    }
    const plans = decodeWaterWorkerPlans(data);
    const plan = plans?.find(value => value.seed === data.seed
      && value.regionX === data.regionX && value.regionZ === data.regionZ);
    if (!plan) throw new Error('Requested region is outside accepted coverage');
    const start = performance.now();
    const descriptor = watershedDescriptorFromWaterPlan(plan, { verifyPlanHash: true });
    const extracted = performance.now();
    const packed = serializeWatershedDescriptor(descriptor);
    const serialized = performance.now();
    const restored = deserializeWatershedDescriptor(packed);
    const finished = performance.now();
    const originalJSON = JSON.stringify(descriptor);
    if (!sameValue(descriptor, restored)) throw new Error('Descriptor round-trip differs');
    const bytes = value => new TextEncoder().encode(value).byteLength;
    self.postMessage({ type: 'descriptor-report-ready', report: {
      region: [data.regionX, data.regionZ], seed: data.seed,
      sourcePlanBytes: bytes(JSON.stringify(plan)), descriptorBytes: bytes(originalJSON),
      packedBytes: bytes(packed), exactRoundTrip: true,
      extractionMs: extracted - start, packingMs: serialized - extracted, unpackingMs: finished - serialized,
      note: 'Lossless relative to the compatibility descriptor; existing partial/unknown topology stays partial/unknown.',
    } });
  } catch (error) { self.postMessage({ type: 'descriptor-report-error', error: error.message }); }
};
