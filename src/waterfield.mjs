// Indexed, immutable water descriptors. Sampling does not plan, flood or query
// another World. An entire validated plan set replaces the previous field.
import { BASIN_PLAN_VERSION, descriptorHash } from './hydrologyformat.mjs';
import { RiverReachField } from './riverterrain.mjs';
import { lerp, smoothstep } from './noise.js';

const BIN = 128;
const MAX_BYTES = 16 * 1024 * 1024;

function immutable(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export class WaterField {
  constructor(seed, plans) {
    this.seed = seed;
    this.bins = new Map();
    this.bodies = new Map();
    this.reaches = new Map();
    const sorted = [...plans].sort((a, b) => a.regionX - b.regionX || a.regionZ - b.regionZ);
    if (JSON.stringify(sorted).length > MAX_BYTES) throw new Error('Water plan memory budget exceeded');
    this.plans = immutable(JSON.parse(JSON.stringify(sorted)));
    for (const plan of this.plans) {
      const { diagnostics, hash, ...payload } = plan;
      if (plan.version !== BASIN_PLAN_VERSION || plan.seed !== seed || hash !== descriptorHash(payload)) {
        throw new Error('Water plan identity/checksum mismatch');
      }
      for (const reach of plan.reaches || []) {
        if (this.reaches.has(reach.id)) throw new Error(`Duplicate river reach ${reach.id}`);
        this.reaches.set(reach.id, new RiverReachField(reach));
      }
      for (const body of plan.basins) {
        if (this.bodies.has(body.id)) throw new Error(`Duplicate water body ${body.id}`);
        const g = body.grid;
        if (!g || !Number.isInteger(g.cols) || !Number.isInteger(g.rows) || g.cols < 2 || g.rows < 2
          || !Number.isFinite(g.step) || g.step <= 0 || !Number.isFinite(body.level)
          || g.floor.length !== g.cols * g.rows || g.signed.length !== g.floor.length
          || !g.floor.every(Number.isFinite) || !g.signed.every(Number.isFinite)) {
          throw new Error('Malformed water body grid');
        }
        this.bodies.set(body.id, body);
        const b = body.bounds;
        for (let z = Math.floor(b.minZ / BIN); z <= Math.floor(b.maxZ / BIN); z++) {
          for (let x = Math.floor(b.minX / BIN); x <= Math.floor(b.maxX / BIN); x++) {
            const key = `${x},${z}`;
            if (!this.bins.has(key)) this.bins.set(key, []);
            this.bins.get(key).push(body);
          }
        }
      }
    }
    // Junction geometry is not published by this field yet. Refuse intersecting
    // descriptors instead of letting array order silently choose the water head.
    const reaches = [...this.reaches.values()];
    for (let i = 0; i < reaches.length; i++) {
      const a = reaches[i].reach.bounds;
      for (const other of [...reaches.slice(i + 1).map(field => field.reach), ...this.bodies.values()]) {
        const b = other.bounds;
        if (a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ) {
          throw new Error('Unresolved overlapping river descriptors');
        }
      }
    }
    this.reachBins = new Map();
    for (const field of this.reaches.values()) {
      const b = field.reach.bounds;
      for (let z = Math.floor(b.minZ / BIN); z <= Math.floor(b.maxZ / BIN); z++) {
        for (let x = Math.floor(b.minX / BIN); x <= Math.floor(b.maxX / BIN); x++) {
          const key = `${x},${z}`;
          if (!this.reachBins.has(key)) this.reachBins.set(key, []);
          this.reachBins.get(key).push(field);
        }
      }
    }
    this.hash = descriptorHash(this.plans.map(p => p.hash));
    this.bytes = JSON.stringify(this.plans).length;
    this.local = null;
  }

  sample(x, z, naturalHeight, out) {
    const ix = Math.floor(x / BIN), iz = Math.floor(z / BIN);
    if (!this.local || this.local.x !== ix || this.local.z !== iz) {
      this.local = { x: ix, z: iz, bodies: this.bins.get(`${ix},${iz}`) || [], reaches: this.reachBins.get(`${ix},${iz}`) || [] };
    }
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
