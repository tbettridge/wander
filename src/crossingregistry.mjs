// Read-only migration records and their runtime spatial indexes. Kept separate
// from capture so World never imports trail/landmark generation through itself.
import { plain, descriptorHash } from './hydrologyformat.mjs';
export const CROSSING_MANIFEST_VERSION = 1;
const CROSSING_RECIPE_VERSION = 1;
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function readCrossingManifest(value, { seed, layoutSignature } = {}) {
  if (!value || value.version !== CROSSING_MANIFEST_VERSION || value.recipeVersion !== CROSSING_RECIPE_VERSION
    || value.generationVersion !== 2 || !Array.isArray(value.routes) || !Array.isArray(value.crossings)) {
    throw new Error('Unsupported crossing manifest');
  }
  if (seed !== undefined && value.seed !== seed) throw new Error('Crossing manifest seed mismatch');
  if (layoutSignature !== undefined && value.layoutSignature !== layoutSignature) {
    throw new Error('Crossing manifest layout mismatch');
  }
  const { hash, ...payload } = plain(value);
  if (hash !== descriptorHash(payload)) throw new Error('Crossing manifest checksum mismatch');
  return freeze({ ...payload, hash });
}

// Capsule union follows the complete curved structure and both approaches.
// Index by bounds before measuring distance; never scan a regional manifest in
// a terrain vertex loop. The bins are reconstructed, not serialized.
export class CrossingReservations {
  constructor(manifests, cellSize = 128) {
    manifests = manifests.map(manifest => readCrossingManifest(manifest));
    this.manifests = manifests;
    this.seed = manifests[0]?.seed;
    this.bytes = JSON.stringify(manifests).length;
    if (this.bytes > 16 * 1024 * 1024) throw new Error('Crossing manifest memory budget exceeded');
    if (manifests.some(m => m.seed !== this.seed || m.layoutSignature !== manifests[0].layoutSignature)) {
      throw new Error('Mixed crossing layout identities');
    }
    this.cellSize = cellSize;
    this.bins = new Map();
    this.crossings = new Map();
    this.routeBins = new Map();
    this.routes = new Map();
    const seenRoutes = new Map();
    for (const manifest of manifests) for (const edge of manifest.routes) {
      const routeHash = descriptorHash(edge);
      if (seenRoutes.has(edge.id)) {
        if (seenRoutes.get(edge.id) !== routeHash) throw new Error(`Conflicting preserved route ${edge.id}`);
        continue;
      }
      seenRoutes.set(edge.id, routeHash);
      const bins = edge.segments.bins;
      if (bins?.type !== 'Map' || !Array.isArray(bins.entries)) throw new Error('Missing preserved route spatial index');
      this.routes.set(edge.id, { ...edge, segments: { ...edge.segments, bins: new Map(bins.entries) } });
      const s = edge.segments, radius = (edge.width || 2) + 12;
      for (let i = 0; i < s.count; i++) {
        const a = { x: s.ax[i], z: s.az[i] }, b = { x: a.x + s.dx[i], z: a.z + s.dz[i] };
        const segment = { a, b, radius };
        for (let z = Math.floor((Math.min(a.z, b.z) - radius) / cellSize);
          z <= Math.floor((Math.max(a.z, b.z) + radius) / cellSize); z++) {
          for (let x = Math.floor((Math.min(a.x, b.x) - radius) / cellSize);
            x <= Math.floor((Math.max(a.x, b.x) + radius) / cellSize); x++) {
            const key = `${x},${z}`;
            if (!this.routeBins.has(key)) this.routeBins.set(key, []);
            this.routeBins.get(key).push(segment);
          }
        }
      }
    }
    for (const manifest of manifests) for (const entry of manifest.crossings) {
      if (this.crossings.has(entry.id)) {
        if (descriptorHash(this.crossings.get(entry.id)) !== descriptorHash(entry)) {
          throw new Error(`Conflicting preserved crossing ${entry.id}`);
        }
        continue;
      }
      this.crossings.set(entry.id, entry);
      if (!entry.reservation) continue;
      const b = entry.reservation.bounds;
      for (let z = Math.floor(b.minZ / cellSize); z <= Math.floor(b.maxZ / cellSize); z++) {
        for (let x = Math.floor(b.minX / cellSize); x <= Math.floor(b.maxX / cellSize); x++) {
          const key = `${x},${z}`;
          if (!this.bins.has(key)) this.bins.set(key, []);
          this.bins.get(key).push(entry);
        }
      }
    }
  }

  at(x, z) {
    const entries = this.bins.get(`${Math.floor(x / this.cellSize)},${Math.floor(z / this.cellSize)}`);
    for (const entry of entries || []) {
      const { points, radius } = entry.reservation;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], dx = b.x - a.x, dz = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
        if ((x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2 <= radius * radius) return entry;
      }
    }
    return null;
  }

  routeAt(x, z) {
    const segments = this.routeBins.get(`${Math.floor(x / this.cellSize)},${Math.floor(z / this.cellSize)}`);
    for (const { a, b, radius } of segments || []) {
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      if ((x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2 <= radius * radius) return true;
    }
    return false;
  }

  bind(world) {
    if (this.seed !== undefined && this.seed !== world.seed) throw new Error('Crossing manifest seed mismatch');
    world.preservedCrossings = this.crossings;
    world.preservedRoutes = this.routes;
    world.hydrologyManifests = this.manifests;
  }
}
