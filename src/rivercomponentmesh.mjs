import { RiverReachField, riverSectionFloor } from './riverterrain.mjs';
import { prepareRiverJunctions } from './riverjunctions.mjs';
import { descriptorHash } from './hydrologyformat.mjs';

// Bounded prototype: rasterize the complete component once so terrain, water
// and walking queries share exactly the same triangles. Bank fills are not
// combined here: a cut-only union is continuous, whereas choosing the lowest
// of independently raised banks can leave a step at an influence boundary.
export function bakeRiverComponent(world, component, { maxCells = 65536 } = {}) {
  const ownership = prepareRiverJunctions(component);
  if (ownership.status !== 'prepared') return ownership;
  const reaches = [...component.reaches].sort((a, b) => a.id.localeCompare(b.id));
  const fields = reaches.map(reach => new RiverReachField(reach));
  const step = 2;
  const x0 = Math.floor(Math.min(...reaches.map(r => r.bounds.minX)) / step) * step - 4;
  const z0 = Math.floor(Math.min(...reaches.map(r => r.bounds.minZ)) / step) * step - 4;
  const cols = Math.ceil((Math.max(...reaches.map(r => r.bounds.maxX)) + 4 - x0) / step) + 1;
  const rows = Math.ceil((Math.max(...reaches.map(r => r.bounds.maxZ)) + 4 - z0) / step) + 1;
  if (!Number.isInteger(maxCells) || maxCells < 1 || maxCells > 65536) throw new Error('Invalid component mesh budget');
  if (cols * rows > maxCells) return { status: 'rejected', reason: 'component-mesh-budget' };
  const caps = ownership.junctions.map(junction => {
    const ends = reaches.flatMap(r => [r.points[0], r.points.at(-1)])
      .filter(p => p.nodeId === junction.nodeId);
    return { ...junction, ends, x: ends[0].x, z: ends[0].z,
      radius: Math.max(...ends.flatMap(p => ['left', 'right'].map(side =>
        p[`${side}Width`] + p[`${side}BankWidth`] + p[`${side}BlendWidth`]))) };
  });
  const floor = [], head = [], signed = [], flowX = [], flowZ = [];
  const samples = fields.map(() => ({}));
  const maxCut = Math.min(...reaches.map(r => r.maxCut));
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const x = x0 + col * step, z = z0 + row * step, natural = world._naturalHeight(x, z);
    let ground = natural, water = null, fx = 0, fz = 0, count = 0;
    for (let k = 0; k < fields.length; k++) {
      const sample = samples[k];
      if (!fields[k].sample(x, z, natural, sample)) continue;
      if (sample.floor > natural + 1e-7) return { status: 'rejected', reason: 'junction-bank-fill', x, z };
      if (water !== null && Math.abs(water - sample.waterY) > 1e-9) {
        return { status: 'rejected', reason: 'junction-head-conflict', x, z };
      }
      water = sample.waterY; ground = Math.min(ground, sample.floor);
      fx += sample.flowX; fz += sample.flowZ; count++;
    }
    for (const cap of caps) {
      const radius = Math.hypot(x - cap.x, z - cap.z);
      if (radius >= cap.radius) continue;
      if (water !== null && Math.abs(water - cap.waterY) > 1e-9) {
        return { status: 'rejected', reason: 'junction-cap-head-conflict', x, z };
      }
      // A radial minimum of every incident endpoint section covers all three
      // open end planes. Both bank profiles participate, so the cap cannot
      // introduce an angular seam or a wall across a tributary mouth.
      for (const p of cap.ends) for (const side of [-1, 1]) {
        ground = Math.min(ground, riverSectionFloor(p, side * radius, natural));
      }
      water = cap.waterY;
    }
    if (natural - ground > maxCut + 1e-7) return { status: 'rejected', reason: 'junction-cut-budget', x, z };
    // This prototype has no ocean handoff. A water domain ending in ground
    // below its head must be routed/contained before a mesh can be published.
    if (water !== null && natural < water + 0.02) {
      return { status: 'rejected', reason: 'uncontained-component-water', x, z };
    }
    floor.push(ground); head.push(water); signed.push(water === null ? null : water - ground);
    flowX.push(count ? fx / count : 0); flowZ.push(count ? fz / count : 0);
  }
  // Dry vertices beside an active channel use its head. This makes clipping
  // intersect the actual ground triangle rather than a fabricated wet mask.
  // Multi-source propagation is linear in grid size; scanning every section
  // for every dry vertex made large components unnecessarily expensive.
  const queue = [];
  for (let i = 0; i < head.length; i++) if (head[i] !== null) queue.push(i);
  if (!queue.length) return { status: 'rejected', reason: 'empty-component-mesh' };
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const i = queue[cursor], col = i % cols, row = Math.floor(i / cols);
    for (const j of [col > 0 ? i - 1 : -1, col + 1 < cols ? i + 1 : -1,
      row > 0 ? i - cols : -1, row + 1 < rows ? i + cols : -1]) {
      if (j < 0 || head[j] !== null) continue;
      head[j] = head[i]; signed[j] = head[j] - floor[j];
      if (signed[j] >= 0) return { status: 'rejected', reason: 'uncontained-component-boundary' };
      queue.push(j);
    }
  }
  const payload = { version: 1, seed: world.seed, reachIds: reaches.map(r => r.id),
    bounds: { minX: x0, minZ: z0, maxX: x0 + (cols - 1) * step, maxZ: z0 + (rows - 1) * step },
    grid: { x0, z0, cols, rows, step, floor, head, signed, flowX, flowZ } };
  return { status: 'baked', ...payload, hash: descriptorHash(payload), activationReady: false };
}

export class RiverComponentMeshField {
  constructor(mesh) {
    const { status, hash, activationReady, ...payload } = mesh;
    if (status !== 'baked' || hash !== descriptorHash(payload)) throw new Error('Invalid component mesh identity');
    const g = mesh.grid;
    if (!g || g.step !== 2 || !Number.isInteger(g.cols) || !Number.isInteger(g.rows) || g.cols < 2 || g.rows < 2
      || g.cols * g.rows > 65536 || ![g.x0, g.z0].every(Number.isFinite)
      || !['floor', 'head', 'signed', 'flowX', 'flowZ'].every(k => Array.isArray(g[k])
        && g[k].length === g.cols * g.rows && g[k].every(Number.isFinite))) throw new Error('Malformed component mesh');
    this.mesh = structuredClone(mesh);
  }

  gridStep(minX, minZ, maxX, maxZ) {
    const b = this.mesh.bounds;
    return maxX >= b.minX && minX <= b.maxX && maxZ >= b.minZ && minZ <= b.maxZ ? 2 : null;
  }

  sample(x, z, natural, out) {
    const g = this.mesh.grid, gx = (x - g.x0) / g.step, gz = (z - g.z0) / g.step;
    if (gx < 0 || gz < 0 || gx >= g.cols - 1 || gz >= g.rows - 1) return false;
    const col = Math.floor(gx), row = Math.floor(gz), fx = gx - col, fz = gz - row;
    const a = row * g.cols + col, b = a + 1, c = a + g.cols, d = c + 1;
    const interpolate = values => fx + fz <= 1
      ? values[a] + (values[b] - values[a]) * fx + (values[c] - values[a]) * fz
      : values[d] + (values[c] - values[d]) * (1 - fx) + (values[b] - values[d]) * (1 - fz);
    const floor = interpolate(g.floor), waterY = interpolate(g.head), signedDepth = waterY - floor;
    Object.assign(out, { base: natural, floor, waterY, head: waterY, signedDepth, domainDepth: signedDepth,
      ch: signedDepth > 0 ? 1 : 0, riverInfluence: true, bodyId: `component:${this.mesh.hash}`,
      bodyKind: 'river', waterKind: -1, flowX: interpolate(g.flowX), flowZ: interpolate(g.flowZ),
      turbulence: 0.1, turbidity: 0.25, exposure: 0.15, estuary: 0 });
    return true;
  }
}
