import { RiverReachField, riverSectionFloor } from './riverterrain.mjs';
import { prepareRiverJunctions } from './riverjunctions.mjs';
import { descriptorHash } from './hydrologyformat.mjs';
import { lerp, smoothstep } from './noise.js';
import { wetBasinAt } from './basinmembership.mjs';
import { buildLakeRiverContacts, sampleLakeRiverTransition } from './lakecontacts.mjs';

const LIMIT = 65536, STEP = 2;
const key = (x, z) => `${x},${z}`;
const neighbours = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
const triangleNeighbours = neighbours.filter(([dx, dz]) => dx * dz <= 0);

// Store only the corridor around each reach, on the same global 2m lattice.
// Empty space between tributaries consumes no vertices and owns no water.
export function bakeSparseRiverComponent(world, component, { maxCells = LIMIT, lakeTransitions = false } = {}) {
  const basins = component.basins || [];
  if (!Array.isArray(basins) || basins.length > 4 || new Set(basins.map(b => b?.id)).size !== basins.length
    || basins.some(b => !b || typeof b.id !== 'string' || !b.id.length || !['pond', 'lake'].includes(b.kind)
      || ![b.level, b.centerX, b.centerZ, b.bounds?.minX, b.bounds?.maxX, b.bounds?.minZ, b.bounds?.maxZ].every(Number.isFinite)
      || b.bounds.minX >= b.bounds.maxX || b.bounds.minZ >= b.bounds.maxZ)) throw new Error('Invalid component basins');
  if (component.reaches?.some(r => r.basinIds?.some(id => !basins.some(b => b.id === id)))) return { status: 'rejected', reason: 'missing-lake-composition' };
  if (!Number.isInteger(maxCells) || maxCells < 1 || maxCells > LIMIT) throw new Error('Invalid sparse mesh budget');
  const ownership = prepareRiverJunctions(component);
  if (ownership.status !== 'prepared') return ownership;
  const reaches = [...component.reaches].sort((a, b) => a.id.localeCompare(b.id));
  // Development preview only until the complete lake/river corpus is accepted.
  // Contacts affect currents, never water heads, wet ownership or dry terrain.
  const contactPlan = lakeTransitions ? buildLakeRiverContacts(reaches, basins) : null;
  if (contactPlan && contactPlan.status !== 'built') return contactPlan;
  const contactSample = {};
  const fields = reaches.map(r => new RiverReachField(r)), vertices = new Map();
  const width = p => Math.max(...['left', 'right'].map(s => p[`${s}Width`] + p[`${s}BankWidth`] + p[`${s}BlendWidth`]));
  for (const reach of reaches) for (const p of reach.points) {
    const radius = width(p) + 10;
    for (let z = Math.floor((p.z - radius) / STEP); z <= Math.ceil((p.z + radius) / STEP); z++) {
      for (let x = Math.floor((p.x - radius) / STEP); x <= Math.ceil((p.x + radius) / STEP); x++) {
        if (Math.hypot(x * STEP - p.x, z * STEP - p.z) > radius) continue;
        vertices.set(key(x, z), [x, z]);
        if (vertices.size > maxCells) return { status: 'rejected', reason: 'component-mesh-budget' };
      }
    }
  }
  for (const basin of basins) {
    const b = basin.bounds;
    for (let z = Math.floor((b.minZ - 8) / STEP); z <= Math.ceil((b.maxZ + 8) / STEP); z++) {
      for (let x = Math.floor((b.minX - 8) / STEP); x <= Math.ceil((b.maxX + 8) / STEP); x++) {
        vertices.set(key(x, z), [x, z]);
        if (vertices.size > maxCells) return { status: 'rejected', reason: 'component-mesh-budget' };
      }
    }
  }
  const coords = [...vertices.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const index = new Map(coords.map((p, i) => [key(...p), i]));
  const caps = ownership.junctions.map(j => {
    const ends = reaches.flatMap(r => [r.points[0], r.points.at(-1)]).filter(p => p.nodeId === j.nodeId);
    return { ...j, ends, x: ends[0].x, z: ends[0].z, radius: Math.max(...ends.map(width)) };
  });
  const mouths = reaches.filter(r => r.oceanMouth).map(r => r.points.at(-1));
  if (mouths.some(p => Math.abs(p.waterY) > 1e-9 || world._naturalHeight(p.x, p.z) >= -0.25)) {
    return { status: 'rejected', reason: 'invalid-ocean-handoff' };
  }
  const grid = { step: STEP, coords, floor: [], natural: [], head: [], signed: [], flowX: [], flowZ: [], estuary: [] };
  if (basins.length) { grid.lakeKind = []; grid.turbidity = []; grid.exposure = []; }
  const samples = fields.map(() => ({})), maxCut = Math.min(...reaches.map(r => r.maxCut));
  for (const [ix, iz] of coords) {
    const x = ix * STEP, z = iz * STEP, natural = world._naturalHeight(x, z);
    let floor = natural, head = null, fx = 0, fz = 0, count = 0, estuary = 0;
    const lakes = basins.filter(b => x >= b.bounds.minX && x <= b.bounds.maxX && z >= b.bounds.minZ && z <= b.bounds.maxZ);
    if (lakes.length > 1) return { status: 'rejected', reason: 'overlapping-lake-domains' };
    const lake = lakes[0];
    const wetLake = lake && wetBasinAt([lake], x, z);
    let lakeKind = wetLake ? (lake.kind === 'pond' ? 1 : 2) : 0;
    // Bounds include disconnected low hollows. Only the connected basin may
    // claim those wet vertices; dry shore vertices still carry the lake head.
    if (lake && (wetLake || natural >= lake.level)) head = lake.level;
    for (let k = 0; k < fields.length; k++) {
      const s = samples[k];
      if (!fields[k].sample(x, z, natural, s)) continue;
      if (head !== null && Math.abs(head - s.waterY) > 1e-9) {
        if (!lake || count || wetLake) return { status: 'rejected', reason: 'junction-head-conflict', x, z };
        lakeKind = 0;
      }
      head = s.waterY;
      // Finish bed conditioning before the open mouth plane. Both the head
      // and natural ground must already belong to the sea for this handoff.
      const fade = natural < -0.25 && Math.abs(head) < 1e-9 ? smoothstep(0.94, 1, s.estuary) : 0;
      floor = Math.min(floor, lerp(s.floor, natural, fade));
      fx += s.flowX; fz += s.flowZ; count++; estuary = Math.max(estuary, s.estuary);
    }
    for (const cap of caps) {
      const radius = Math.hypot(x - cap.x, z - cap.z);
      if (radius >= cap.radius) continue;
      if (head !== null && Math.abs(head - cap.waterY) > 1e-9) return { status: 'rejected', reason: 'junction-cap-head-conflict', x, z };
      for (const p of cap.ends) for (const side of [-1, 1]) floor = Math.min(floor, riverSectionFloor(p, side * radius, natural));
      head = cap.waterY;
    }
    if (natural - floor > maxCut + 1e-7) return { status: 'rejected', reason: 'junction-cut-budget', x, z };
    grid.floor.push(floor); grid.natural.push(natural); grid.head.push(head);
    let flowX = count ? fx / count : 0, flowZ = count ? fz / count : 0;
    if (contactPlan && wetLake) {
      flowX = 0; flowZ = 0;
      for (const contact of contactPlan.contacts) {
        if (contact.lakeId !== lake.id || !sampleLakeRiverTransition(contact, lake, x, z, contactSample)) continue;
        flowX += contactSample.flowX; flowZ += contactSample.flowZ;
      }
      const magnitude = Math.max(1, Math.hypot(flowX, flowZ));
      flowX /= magnitude; flowZ /= magnitude;
    }
    grid.flowX.push(flowX); grid.flowZ.push(flowZ); grid.estuary.push(estuary);
    if (grid.lakeKind) {
      grid.lakeKind.push(lakeKind);
      grid.turbidity.push(wetLake ? (lake.material?.turbidity ?? (lake.kind === 'pond' ? 0.65 : 0.25)) : 0.25);
      grid.exposure.push(wetLake ? (lake.material?.exposure ?? 0.2) : 0.15);
    }
  }
  const queue = [];
  for (let i = 0; i < coords.length; i++) if (grid.head[i] !== null) queue.push(i);
  const owned = new Set(queue);
  if (!queue.length) return { status: 'rejected', reason: 'empty-component-mesh' };
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const i = queue[cursor], [x, z] = coords[i];
    for (const [dx, dz] of neighbours) {
      const j = index.get(key(x + dx, z + dz));
      if (j === undefined || grid.head[j] !== null) continue;
      grid.head[j] = grid.head[i];
      const ocean = mouths.length && Math.abs(grid.head[j]) < 1e-9 && grid.natural[j] < 0;
      grid.estuary[j] = ocean ? 1 : grid.estuary[i];
      queue.push(j);
    }
  }
  if (queue.length !== coords.length) return { status: 'rejected', reason: 'disconnected-component-domain' };
  // Only wet regions connected to a channel centre belong to this river.
  // Natural hollows beyond a dry bank crest can lie inside the blend envelope.
  const wet = new Set(), wetQueue = [];
  for (const basin of basins) {
    const i = index.get(key(Math.round(basin.centerX / STEP), Math.round(basin.centerZ / STEP)));
    if (i === undefined || grid.head[i] <= grid.floor[i]) return { status: 'rejected', reason: 'dry-basin-anchor' };
    if (i !== undefined && grid.head[i] > grid.floor[i] && !wet.has(i)) { wet.add(i); wetQueue.push(i); }
  }
  for (const r of reaches) for (const p of r.points) {
    if (p.depth <= 0.1) continue;
    const i = index.get(key(Math.round(p.x / STEP), Math.round(p.z / STEP)));
    if (i !== undefined && owned.has(i) && grid.head[i] > grid.floor[i] && !wet.has(i)) { wet.add(i); wetQueue.push(i); }
  }
  const roots = basins.length ? [...wetQueue] : null;
  for (let cursor = 0; cursor < wetQueue.length; cursor++) {
    const [x, z] = coords[wetQueue[cursor]];
    for (const [dx, dz] of neighbours) {
      const j = index.get(key(x + dx, z + dz));
      if (j === undefined || !owned.has(j) || wet.has(j) || grid.head[j] <= grid.floor[j]) continue;
      wet.add(j); wetQueue.push(j);
    }
  }
  if (roots) {
    const connected = new Set([roots[0]]), queue = [roots[0]];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const [x, z] = coords[queue[cursor]];
      for (const [dx, dz] of triangleNeighbours) {
        const j = index.get(key(x + dx, z + dz));
        if (j === undefined || !wet.has(j) || connected.has(j)) continue;
        connected.add(j); queue.push(j);
      }
    }
    if (roots.some(i => !connected.has(i))) return { status: 'rejected', reason: 'disconnected-lake-outlet' };
  }
  // A lower hollow beyond a dry bank is not part of this river. Its dummy
  // head may change only where no incident triangle contains channel-connected water.
  // Thus visible water triangles keep their solved head, including the shore.
  for (let i = 0; i < coords.length; i++) if (!wet.has(i) && grid.head[i] > grid.floor[i]) {
    if (mouths.length && Math.abs(grid.head[i]) < 1e-9 && grid.natural[i] < 0) continue;
    const [x, z] = coords[i];
    const openWater = neighbours.some(([dx, dz]) => {
      const j = index.get(key(x + dx, z + dz));
      return j !== undefined && wet.has(j);
    });
    if (openWater) return { status: 'rejected', reason: 'uncontained-component-boundary', x: x * STEP, z: z * STEP };
    grid.head[i] = grid.floor[i] - 0.02;
  }
  grid.signed = grid.head.map((h, i) => h - grid.floor[i]);
  if (basins.length) for (let i = 0; i < coords.length; i++) {
    if (!grid.lakeKind[i]) continue;
    const [x, z] = coords[i];
    for (const [dx, dz] of triangleNeighbours) {
      const j = index.get(key(x + dx, z + dz));
      if (j !== undefined && Math.abs(grid.head[i] - grid.head[j]) > 1e-9) {
        return { status: 'rejected', reason: 'lake-shore-head-conflict', x: x * STEP, z: z * STEP };
      }
    }
  }
  const xs = coords.map(p => p[0] * STEP), zs = coords.map(p => p[1] * STEP);
  const payload = { version: 3, seed: world.seed, reachIds: reaches.map(r => r.id), oceanHandoff: mouths.length > 0,
    ...(basins.length ? { basinIds: basins.map(b => b.id).sort() } : {}),
    bounds: { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }, grid };
  const mesh = { status: 'baked', ...payload, hash: descriptorHash(payload), activationReady: false };
  try { new SparseRiverComponentField(mesh); }
  catch (error) { return { status: 'rejected', reason: 'invalid-component-collar', detail: error.message }; }
  return mesh;
}

export class SparseRiverComponentField {
  constructor(mesh, { clone = true } = {}) {
    const { status, hash, activationReady, ...payload } = mesh;
    if (status !== 'baked' || mesh.version !== 3 || hash !== descriptorHash(payload)) throw new Error('Invalid sparse component identity');
    const g = mesh.grid, n = g?.coords?.length;
    if (!n || n > LIMIT || g.step !== STEP || typeof mesh.oceanHandoff !== 'boolean'
      || !Array.isArray(mesh.reachIds) || !mesh.reachIds.length || new Set(mesh.reachIds).size !== mesh.reachIds.length
      || !mesh.reachIds.every(id => typeof id === 'string' && id.length)
      || !g.coords.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isSafeInteger))
      || !['floor', 'natural', 'head', 'signed', 'flowX', 'flowZ', 'estuary'].every(k => Array.isArray(g[k])
        && g[k].length === n && g[k].every(Number.isFinite))) throw new Error('Malformed sparse component');
    if (mesh.basinIds && (!Array.isArray(mesh.basinIds) || !mesh.basinIds.length
      || new Set(mesh.basinIds).size !== mesh.basinIds.length || !mesh.basinIds.every(id => typeof id === 'string' && id.length)
      || !Array.isArray(g.lakeKind) || g.lakeKind.length !== n || !g.lakeKind.every(v => Number.isFinite(v) && v >= 0 && v <= 2))) {
      throw new Error('Malformed sparse lake ownership');
    }
    if (g.lakeKind && !mesh.basinIds) throw new Error('Missing sparse lake ownership');
    for (const name of ['turbidity', 'exposure']) if (g[name] && (!Array.isArray(g[name]) || g[name].length !== n
      || !g[name].every(v => Number.isFinite(v) && v >= 0 && v <= 1))) throw new Error('Malformed sparse water material');
    // Prepared worker plans already own their decoded descriptor graph. Keep
    // cloning as the safe default for direct/raw construction.
    this.mesh = clone ? structuredClone(mesh) : mesh;
    this.index = new Map(g.coords.map((p, i) => [key(...p), i]));
    if (this.index.size !== n) throw new Error('Duplicate sparse vertex');
    const xs = g.coords.map(p => p[0] * STEP), zs = g.coords.map(p => p[1] * STEP), b = mesh.bounds;
    if (!b || b.minX !== Math.min(...xs) || b.maxX !== Math.max(...xs)
      || b.minZ !== Math.min(...zs) || b.maxZ !== Math.max(...zs)) throw new Error('Malformed sparse bounds');
    this.distance = new Array(n).fill(Infinity);
    const queue = [];
    for (let i = 0; i < n; i++) {
      const [x, z] = g.coords[i];
      if (neighbours.some(([dx, dz]) => !this.index.has(key(x + dx, z + dz)))) {
        this.distance[i] = 0; queue.push(i);
      }
      if (Math.abs(g.signed[i] - (g.head[i] - g.floor[i])) > 1e-7 || g.floor[i] > g.natural[i] + 1e-7
        || g.estuary[i] < 0 || g.estuary[i] > 1) throw new Error('Inconsistent sparse terrain');
      if (g.lakeKind?.[i]) for (const [dx, dz] of triangleNeighbours) {
        const j = this.index.get(key(x + dx, z + dz));
        if (j !== undefined && Math.abs(g.head[i] - g.head[j]) > 1e-9) throw new Error('Inconsistent lake shoreline head');
      }
    }
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const i = queue[cursor], [x, z] = g.coords[i];
      if (this.distance[i] >= 3) continue;
      for (const [dx, dz] of neighbours) {
        const j = this.index.get(key(x + dx, z + dz));
        if (j === undefined || this.distance[j] <= this.distance[i] + 1) continue;
        this.distance[j] = this.distance[i] + 1; queue.push(j);
      }
    }
    for (let i = 0; i < n; i++) if (this.distance[i] <= 2) {
      const ocean = mesh.oceanHandoff && Math.abs(g.head[i]) < 1e-9 && g.natural[i] < 0 && g.estuary[i] === 1;
      if (Math.abs(g.floor[i] - g.natural[i]) > 1e-7 || (g.signed[i] >= 0 && !ocean)) throw new Error('Uncontained sparse collar');
    }
    this.distance = this.distance.map(d => Math.min(3, d));
    this.bins = new Map();
    for (const [x, z] of g.coords) {
      const bin = key(Math.floor(x * STEP / 128), Math.floor(z * STEP / 128));
      if (!this.bins.has(bin)) this.bins.set(bin, []);
      this.bins.get(bin).push([x * STEP, z * STEP]);
    }
  }

  gridStep(minX, minZ, maxX, maxZ) {
    const b = this.mesh.bounds;
    if (maxX < b.minX || minX > b.maxX || maxZ < b.minZ || minZ > b.maxZ) return null;
    for (let z = Math.floor((minZ - STEP) / 128); z <= Math.floor((maxZ + STEP) / 128); z++) {
      for (let x = Math.floor((minX - STEP) / 128); x <= Math.floor((maxX + STEP) / 128); x++) {
        if ((this.bins.get(key(x, z)) || []).some(([px, pz]) => px >= minX - STEP && px <= maxX + STEP
          && pz >= minZ - STEP && pz <= maxZ + STEP)) return STEP;
      }
    }
    return null;
  }

  sample(x, z, natural, out) {
    const gx = x / STEP, gz = z / STEP, ix = Math.floor(gx), iz = Math.floor(gz);
    const ids = [[ix, iz], [ix + 1, iz], [ix, iz + 1], [ix + 1, iz + 1]].map(p => this.index.get(key(...p)));
    if (ids.some(i => i === undefined)) return false;
    const [a, b, c, d] = ids, fx = gx - ix, fz = gz - iz, g = this.mesh.grid;
    const interpolate = v => fx + fz <= 1 ? v[a] + (v[b] - v[a]) * fx + (v[c] - v[a]) * fz
      : v[d] + (v[c] - v[d]) * (1 - fx) + (v[b] - v[d]) * (1 - fz);
    const floor = lerp(natural, interpolate(g.floor), smoothstep(0, 2, interpolate(this.distance)));
    const waterY = interpolate(g.head), signedDepth = Math.min(interpolate(g.signed), waterY - floor);
    const kind = g.lakeKind ? interpolate(g.lakeKind) : 0;
    Object.assign(out, { base: natural, floor, waterY, head: waterY, signedDepth, domainDepth: signedDepth,
      ch: signedDepth > 0 ? 1 : 0, riverInfluence: true, bodyId: `component:${this.mesh.hash}`,
      bodyKind: kind > 1.5 ? 'lake' : kind > 0.5 ? 'pond' : 'river', waterKind: kind > 0 ? kind : -1, flowX: interpolate(g.flowX), flowZ: interpolate(g.flowZ),
      turbulence: 0.1, turbidity: g.turbidity ? interpolate(g.turbidity) : 0.25,
      exposure: g.exposure ? interpolate(g.exposure) : 0.15, estuary: interpolate(g.estuary) });
    return true;
  }
}
