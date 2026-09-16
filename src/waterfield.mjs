// Indexed, immutable water descriptors. Sampling does not plan, flood or query
// another World. An entire validated plan set replaces the previous field.
import { BASIN_PLAN_VERSION, descriptorHash } from './hydrologyformat.mjs';
import { RiverReachField } from './riverterrain.mjs';
import { RiverComponentMeshField } from './rivercomponentmesh.mjs';
import { SparseRiverComponentField } from './riversparsemesh.mjs';
import { lerp, smoothstep } from './noise.js';

const BIN = 128;
const MAX_BYTES = 16 * 1024 * 1024;

function immutable(value) {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  // Primitive grid values do not need recursive calls. This avoids a function
  // call for every one of the millions of scalar cells while still freezing
  // every nested descriptor object and coordinate tuple.
  if (Array.isArray(value)) {
    for (const child of value) if (child && typeof child === 'object') immutable(child);
  } else for (const key of Object.keys(value)) immutable(value[key]);
  Object.freeze(value);
  return value;
}

function initField(field, seed) {
  field.seed = seed;
  field.bins = new Map();
  field.bodies = new Map();
  field.reaches = new Map();
  field.components = new Map();
  field.componentBins = new Map();
  field.local = null;
  return field;
}

function planLimit(plans) {
  return plans.length <= 9 && plans.every(plan => plan.regional === 1) ? 32 * 1024 * 1024 : MAX_BYTES;
}

function addPlan(field, plan, { cloneComponents = true } = {}) {
  const { diagnostics, hash, ...payload } = plan;
  if (plan.version !== BASIN_PLAN_VERSION || plan.seed !== field.seed || hash !== descriptorHash(payload)
    || !Array.isArray(plan.basins)) {
    throw new Error('Water plan identity/checksum mismatch');
  }
  for (const reach of plan.reaches || []) {
    if (reach.basinIds?.length) throw new Error('Lake-connected reaches require a combined water mesh');
    if (field.reaches.has(reach.id)) throw new Error(`Duplicate river reach ${reach.id}`);
    field.reaches.set(reach.id, new RiverReachField(reach));
  }
  if (plan.components?.length && (plan.generationVersion !== 3 || plan.preview !== true)) {
    throw new Error('Component meshes require a generation-3 preview');
  }
  for (const mesh of plan.components || []) {
    if (mesh.seed !== field.seed) throw new Error('Component mesh seed mismatch');
    const options = { clone: cloneComponents };
    const component = mesh.version === 3
      ? new SparseRiverComponentField(mesh, options)
      : new RiverComponentMeshField(mesh, options);
    if (field.components.has(mesh.hash)) throw new Error('Duplicate river component');
    field.components.set(mesh.hash, component);
  }
  for (const body of plan.basins) {
    if (field.bodies.has(body.id)) throw new Error(`Duplicate water body ${body.id}`);
    const g = body.grid;
    if (!g || !Number.isInteger(g.cols) || !Number.isInteger(g.rows) || g.cols < 2 || g.rows < 2
      || !Number.isFinite(g.step) || g.step <= 0 || !Number.isFinite(body.level)
      || g.floor.length !== g.cols * g.rows || g.signed.length !== g.floor.length
      || !g.floor.every(Number.isFinite) || !g.signed.every(Number.isFinite)) {
      throw new Error('Malformed water body grid');
    }
    field.bodies.set(body.id, body);
    const b = body.bounds;
    for (let z = Math.floor(b.minZ / BIN); z <= Math.floor(b.maxZ / BIN); z++) {
      for (let x = Math.floor(b.minX / BIN); x <= Math.floor(b.maxX / BIN); x++) {
        const key = `${x},${z}`;
        if (!field.bins.has(key)) field.bins.set(key, []);
        field.bins.get(key).push(body);
      }
    }
  }
}

function finalizeField(field) {
  const ownedReaches = new Set(), ownedBasins = new Set();
  const components = [...field.components.values()];
  for (let i = 0; i < components.length; i++) {
    const mesh = components[i].mesh, a = mesh.bounds;
    for (const id of mesh.basinIds || []) {
      if (ownedBasins.has(id) || field.bodies.has(id)) throw new Error('Duplicate component basin ownership');
      ownedBasins.add(id);
    }
    for (const id of mesh.reachIds) {
      if (ownedReaches.has(id) || field.reaches.has(id)) throw new Error('Duplicate component reach ownership');
      ownedReaches.add(id);
    }
    for (const other of [...components.slice(i + 1).map(component => component.mesh),
      ...[...field.reaches.values()].map(reach => reach.reach), ...field.bodies.values()]) {
      const b = other.bounds;
      if (a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ) {
        throw new Error('Unresolved overlapping component descriptors');
      }
    }
    for (let z = Math.floor(a.minZ / BIN); z <= Math.floor(a.maxZ / BIN); z++) {
      for (let x = Math.floor(a.minX / BIN); x <= Math.floor(a.maxX / BIN); x++) {
        const key = `${x},${z}`;
        if (!field.componentBins.has(key)) field.componentBins.set(key, []);
        field.componentBins.get(key).push(components[i]);
      }
    }
  }
  // Separate reach descriptors do not own junction geometry. Refuse their
  // intersections instead of letting array order choose the water head.
  const reaches = [...field.reaches.values()];
  for (let i = 0; i < reaches.length; i++) {
    const a = reaches[i].reach.bounds;
    for (const other of [...reaches.slice(i + 1).map(reach => reach.reach), ...field.bodies.values()]) {
      const b = other.bounds;
      if (a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ) {
        throw new Error('Unresolved overlapping river descriptors');
      }
    }
  }
  field.reachBins = new Map();
  for (const component of field.reaches.values()) {
    const b = component.reach.bounds;
    for (let z = Math.floor(b.minZ / BIN); z <= Math.floor(b.maxZ / BIN); z++) {
      for (let x = Math.floor(b.minX / BIN); x <= Math.floor(b.maxX / BIN); x++) {
        const key = `${x},${z}`;
        if (!field.reachBins.has(key)) field.reachBins.set(key, []);
        field.reachBins.get(key).push(component);
      }
    }
  }
  field.hash = descriptorHash(field.plans.map(plan => plan.hash));
  field.local = null;
  return field;
}

function clonePlan(plan) {
  try { return structuredClone(plan); }
  catch { return JSON.parse(JSON.stringify(plan)); }
}

function attachWorkerPlanPayload(field, payload) {
  if (payload === null || payload === undefined) return;
  const value = Array.isArray(payload) ? Object.freeze([...payload]) : payload;
  Object.defineProperty(field, 'workerPlansJSON', {
    value, enumerable: false, writable: false, configurable: false,
  });
}

function scheduleHost(callback) {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(() => callback());
  } else if (typeof globalThis.setImmediate === 'function') {
    globalThis.setImmediate(callback);
  } else {
    globalThis.setTimeout(callback, 0);
  }
}

function yieldHost() {
  return new Promise(resolve => scheduleHost(resolve));
}

function aborted(signal) {
  if (signal?.aborted) throw new Error('Water field preparation cancelled');
}

export class WaterField {
  constructor(seed, plans, { adopt = false, workerPlansJSON = null } = {}) {
    if (!Array.isArray(plans)) throw new Error('Invalid water plans');
    const sorted = [...plans].sort((a, b) => a.regionX - b.regionX || a.regionZ - b.regionZ);
    const byteLimit = planLimit(sorted);
    if (JSON.stringify(sorted).length > byteLimit) throw new Error('Water plan memory budget exceeded');
    this.seed = seed;
    initField(this, seed);
    this.plans = immutable(adopt ? sorted : JSON.parse(JSON.stringify(sorted)));
    for (const plan of this.plans) addPlan(this, plan, { cloneComponents: !adopt });
    finalizeField(this);
    this.bytes = JSON.stringify(this.plans).length;
    attachWorkerPlanPayload(this, workerPlansJSON);
  }

  sample(x, z, naturalHeight, out) {
    const ix = Math.floor(x / BIN), iz = Math.floor(z / BIN);
    if (!this.local || this.local.x !== ix || this.local.z !== iz) {
      this.local = { x: ix, z: iz, bodies: this.bins.get(`${ix},${iz}`) || [], reaches: this.reachBins.get(`${ix},${iz}`) || [],
        components: this.componentBins.get(`${ix},${iz}`) || [] };
    }
    for (const field of this.local.components) if (field.sample(x, z, naturalHeight, out)) return true;
    for (const field of this.local.reaches) {
      if (field.sample(x, z, naturalHeight, out)) { out.base = naturalHeight; return true; }
    }
    for (const body of this.local.bodies) {
      const g = body.grid;
      const gx = (x - g.x0) / g.step, gz = (z - g.z0) / g.step;
      if (gx < 0 || gz < 0 || gx >= g.cols - 1 || gz >= g.rows - 1) continue;
      const col = Math.floor(gx), row = Math.floor(gz), fx = gx - col, fz = gz - row;
      const a = row * g.cols + col, b = a + 1, c = a + g.cols, d = c + 1;
      // Same diagonal as the terrain mesher. Its 4m shore grid subdivides
      // these 8m triangles exactly, so walking depth agrees between vertices.
      const interpolate = values => fx + fz <= 1
        ? values[a] + (values[b] - values[a]) * fx + (values[c] - values[a]) * fz
        : values[d] + (values[c] - values[d]) * (1 - fx) + (values[b] - values[d]) * (1 - fz);
      const domain = interpolate(g.signed);
      // Do not flood an unconnected neighbouring hollow merely because it is
      // below this body's level. Its negative membership samples exclude it.
      if (domain <= -0.001 && [a, b, c, d].every(i => g.signed[i] <= 0 && g.floor[i] < body.level)) continue;
      const distanceToBoundary = Math.min(gx, gz, g.cols - 1 - gx, g.rows - 1 - gz) * g.step;
      const strength = smoothstep(0, g.step * 2, distanceToBoundary);
      const floor = lerp(naturalHeight, interpolate(g.floor), strength);
      const signedDepth = Math.min(domain, body.level - floor);
      out.base = naturalHeight;
      out.floor = floor;
      out.waterY = out.head = body.level;
      out.ch = signedDepth > 0 ? 1 : 0;
      out.signedDepth = out.domainDepth = signedDepth;
      out.riverInfluence = true;
      out.bodyId = body.id; out.bodyKind = body.kind; out.waterKind = body.material.kind;
      out.flowX = 0; out.flowZ = 0;
      out.turbidity = body.material.turbidity; out.turbulence = 0;
      out.exposure = body.material.exposure; out.estuary = 0;
      return true;
    }
    return false;
  }

  gridStep(minX, minZ, maxX, maxZ) {
    for (let z = Math.floor(minZ / BIN); z <= Math.floor(maxZ / BIN); z++) {
      for (let x = Math.floor(minX / BIN); x <= Math.floor(maxX / BIN); x++) {
        for (const field of this.componentBins.get(`${x},${z}`) || []) {
          if (field.gridStep(minX, minZ, maxX, maxZ)) return 2;
        }
        for (const field of this.reachBins.get(`${x},${z}`) || []) {
          const b = field.reach.bounds;
          if (b.maxX >= minX && b.minX <= maxX && b.maxZ >= minZ && b.minZ <= maxZ) return 2;
        }
      }
    }
    return this.intersectsBounds(minX, minZ, maxX, maxZ) ? 4 : null;
  }

  intersectsBounds(minX, minZ, maxX, maxZ) {
    for (let z = Math.floor(minZ / BIN); z <= Math.floor(maxZ / BIN); z++) {
      for (let x = Math.floor(minX / BIN); x <= Math.floor(maxX / BIN); x++) {
        for (const body of this.bins.get(`${x},${z}`) || []) {
          const b = body.bounds;
          if (b.maxX >= minX && b.minX <= maxX && b.maxZ >= minZ && b.minZ <= maxZ) return true;
        }
      }
    }
    return false;
  }
}

// Build a field in bounded host tasks. A regional response can contain about
// 25 MiB of JSON, so parsing, hashing and cloning the complete window in one
// turn would pause the walking/render loop. The synchronous constructor above
// remains the strict, defensive path for raw callers; this helper is used only
// when a caller owns the decoded worker response and can safely adopt it after
// each plan has passed the same validation.
export async function prepareWaterField(seed, plans, {
  adopt = false,
  workerPlansJSON = null,
  planBytes = null,
  signal = null,
  onProgress = null,
  yieldTask = yieldHost,
} = {}) {
  if (!Array.isArray(plans)) throw new Error('Invalid water plans');
  if (typeof yieldTask !== 'function') throw new Error('Invalid water preparation scheduler');
  const sorted = [...plans].sort((a, b) => a.regionX - b.regionX || a.regionZ - b.regionZ);
  const byteLimit = planLimit(sorted);
  const field = initField(Object.create(WaterField.prototype), seed);
  const held = [], total = sorted.length;
  let bytes = 2;
  for (let index = 0; index < sorted.length; index++) {
    aborted(signal);
    // Start every potentially large plan on a fresh host turn. This keeps a
    // component mesh clone/hash from sharing the frame that received a worker
    // message.
    await yieldTask();
    aborted(signal);
    const input = sorted[index], plan = adopt ? input : clonePlan(input);
    const key = `${plan?.regionX},${plan?.regionZ}`;
    const encodedBytes = planBytes?.get?.(key) ?? JSON.stringify(plan).length;
    if (!Number.isSafeInteger(encodedBytes) || encodedBytes < 0) throw new Error('Invalid water plan payload size');
    bytes += encodedBytes + (index ? 1 : 0);
    if (bytes > byteLimit) throw new Error('Water plan memory budget exceeded');
    addPlan(field, plan, { cloneComponents: !adopt });
    held.push(immutable(plan));
    onProgress?.({ completed: index + 1, total, phase: 'validated' });
  }
  aborted(signal);
  await yieldTask();
  aborted(signal);
  // Every descriptor was deeply frozen as it was added above. Freezing the
  // containing array is sufficient here; recursively walking the full 25 MiB
  // graph again would recreate the hitch this cooperative path avoids.
  field.plans = Object.freeze(held);
  finalizeField(field);
  field.bytes = bytes;
  if (Array.isArray(workerPlansJSON)) {
    // Keep wire parsing incremental, then do one cheap join on its own host
    // turn. Terrain workers receive one string, which is materially cheaper
    // to clone repeatedly than nine separate strings, while the preparation
    // path never re-stringifies the decoded graph.
    await yieldTask();
    aborted(signal);
    attachWorkerPlanPayload(field, `[${workerPlansJSON.join(',')}]`);
  } else attachWorkerPlanPayload(field, workerPlansJSON);
  field.prepared = true;
  onProgress?.({ completed: total, total, phase: 'ready' });
  return field;
}
