// Count unique transferred buffers, including aliased typed-array views.
// Geometry/property arrays dominate staging memory; driver/object overhead is additional.
export function waterStagePayloadBytes(value, buffers = new Set()) {
  if (!value || typeof value !== 'object') return 0;
  const buffer = ArrayBuffer.isView(value) ? value.buffer : value instanceof ArrayBuffer ? value : null;
  if (buffer) {
    if (buffers.has(buffer)) return 0;
    buffers.add(buffer); return buffer.byteLength;
  }
  return Object.values(value).reduce((n, entry) => n + waterStagePayloadBytes(entry, buffers), 0);
}
// WaterField plans are immutable. Reuse one serialization while the field is
// alive, avoiding repeated structured clones of millions of array elements.
const workerPlans = new WeakMap();
export function waterWorkerPlans(field) {
  if (!field) return null;
  let encoded = workerPlans.get(field);
  if (encoded === undefined) {
    encoded = JSON.stringify(field.plans);
    workerPlans.set(field, encoded);
  }
  return encoded;
}

export function decodeWaterWorkerPlans(message) {
  if (message.waterPlansJSON === undefined) return message.waterPlans || null;
  if (message.waterPlansJSON === null) return null;
  if (typeof message.waterPlansJSON !== 'string' || message.waterPlansJSON.length > 32 * 1024 * 1024) {
    throw new Error('Invalid worker water plan payload');
  }
  const plans = JSON.parse(message.waterPlansJSON);
  if (!Array.isArray(plans)) throw new Error('Invalid worker water plan payload');
  return plans; // World still performs the full identity and geometry validation.
}
