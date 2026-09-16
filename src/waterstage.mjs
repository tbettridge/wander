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
    // HydrologyStream attaches these only after the decoded plans have passed
    // WaterField validation. A prepared window therefore reaches terrain
    // workers as the original per-plan wire strings without another main
    // thread serialization pass.
    encoded = field.workerPlansJSON ?? JSON.stringify(field.plans);
    workerPlans.set(field, encoded);
  }
  return encoded;
}

const MAX_WORKER_PLAN_BYTES = 32 * 1024 * 1024;

export function decodeWaterPlanJSON(value) {
  if (typeof value !== 'string' || value.length > MAX_WORKER_PLAN_BYTES) {
    throw new Error('Invalid worker water plan payload');
  }
  let plan;
  try { plan = JSON.parse(value); }
  catch { throw new Error('Invalid worker water plan payload'); }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('Invalid worker water plan payload');
  }
  return plan;
}

export function decodeWaterWorkerPlans(message) {
  if (message.waterPlansJSON === undefined) return message.waterPlans || null;
  if (message.waterPlansJSON === null) return null;
  if (Array.isArray(message.waterPlansJSON)) {
    let bytes = 2;
    const plans = message.waterPlansJSON.map(value => {
      bytes += (bytes > 2 ? 1 : 0) + (typeof value === 'string' ? value.length : 0);
      if (bytes > MAX_WORKER_PLAN_BYTES) throw new Error('Invalid worker water plan payload');
      return decodeWaterPlanJSON(value);
    });
    if (bytes > MAX_WORKER_PLAN_BYTES) throw new Error('Invalid worker water plan payload');
    return plans;
  }
  if (typeof message.waterPlansJSON !== 'string' || message.waterPlansJSON.length > MAX_WORKER_PLAN_BYTES) {
    throw new Error('Invalid worker water plan payload');
  }
  let plans;
  try { plans = JSON.parse(message.waterPlansJSON); }
  catch { throw new Error('Invalid worker water plan payload'); }
  if (!Array.isArray(plans)) throw new Error('Invalid worker water plan payload');
  return plans; // World still performs the full identity and geometry validation.
}
