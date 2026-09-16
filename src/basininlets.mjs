import { RiverRoutePlanner } from './riverroute.mjs';
import { fitRiverReach } from './riverterrain.mjs';
import { bakeSparseRiverComponent } from './riversparsemesh.mjs';
import { refineBasinConnection, wetBasinAt } from './basinmembership.mjs';
import { planBasinDrainage } from './basinoutlet.mjs';

export function addBasinInlets(world, drainage, { maxInlets = 2, maxSources = 32, maxVisited = 512, maxBytes = Infinity } = {}) {
  if (!Number.isInteger(maxInlets) || maxInlets < 0 || maxInlets > 3
    || !Number.isInteger(maxSources) || maxSources < 1 || maxSources > 32
    || !Number.isInteger(maxVisited) || maxVisited < 1 || maxVisited > 2048
    || !(maxBytes > 0) || (maxBytes !== Infinity && !Number.isSafeInteger(maxBytes))) throw new Error('Invalid inlet budget');
  if (drainage.status !== 'baked') return drainage;
  const basin = drainage.basin, sources = [];
  for (const distance of [96, 160]) for (let i = 0; i < 16; i++) {
    const angle = i * Math.PI / 8;
    const x = Math.round((basin.centerX + Math.cos(angle) * (distance + basin.length / 2)) / 4) * 4;
    const z = Math.round((basin.centerZ + Math.sin(angle) * (distance + basin.length / 2)) / 4) * 4;
    const height = world._naturalHeight(x, z);
    if (height < basin.level + 0.6 || height > basin.level + 5) continue;
    sources.push({ x, z, height, score: Math.abs(height - basin.level - distance * 0.012) });
  }
  // Sample from the actual shore, rather than a circle based on the lake's
  // longest axis, which can miss the valleys beside narrow or irregular lakes.
  for (let i = 0; i < 16; i++) {
    const angle = i * Math.PI / 8, dx = Math.cos(angle), dz = Math.sin(angle);
    let shore = 0;
    for (let r = 0; r <= basin.length + 64; r += 4) {
      if (wetBasinAt([basin], basin.centerX + dx * r, basin.centerZ + dz * r)) shore = r;
    }
    for (const distance of [40, 72, 112]) {
      const x = Math.round((basin.centerX + dx * (shore + distance)) / 4) * 4;
      const z = Math.round((basin.centerZ + dz * (shore + distance)) / 4) * 4;
      const height = world._naturalHeight(x, z);
      if (height < basin.level + 0.6 || height > basin.level + 5 || wetBasinAt([basin], x, z)) continue;
      if (!sources.some(s => s.x === x && s.z === z)) sources.push({ x, z, height,
        score: Math.abs(height - basin.level - distance * 0.012) });
    }
  }
  sources.sort((a, b) => a.score - b.score || a.x - b.x || a.z - b.z);
  let component = drainage.component, mesh = drainage.mesh, count = 0, visited = 0;
  const rejected = [];
  for (const source of sources.slice(0, maxSources)) {
    if (count >= maxInlets || visited >= 8192) break;
    if (wetBasinAt(component.basins || [basin], source.x, source.z)) { rejected.push('source-in-existing-lake'); continue; }
    const route = new RiverRoutePlanner(world, { step: 32, maxVisited: Math.min(maxVisited, 8192 - visited) })
      .route(source, { deferProfile: true, basinTarget: basin, hydraulic: true });
    visited += route.visited || 0;
    if (route.status !== 'candidate') { rejected.push(route.reason); continue; }
    const reach = fitRiverReach(world, route, { id: `lake-inlet:${basin.id}:${source.x}:${source.z}`,
      basins: component.basins || [basin], sourceClosure: true, oceanMouth: false, halfWidth: 2.4 });
    if (reach.status !== 'fitted') { rejected.push(reach.reason); continue; }
    if (!reach.basinIds?.includes(basin.id)) { rejected.push('inlet-misses-lake'); continue; }
    const candidate = { ...component, reaches: [...component.reaches, reach] };
    const baked = bakeSparseRiverComponent(world, candidate);
    if (baked.status !== 'baked') { rejected.push(baked.reason); continue; }
    if (maxBytes !== Infinity && JSON.stringify(baked).length > maxBytes) { rejected.push('inlet-detail-budget'); continue; }
    component = candidate; mesh = baked; count++;
  }
  return { ...drainage, component, mesh, inletCount: count, inletDiagnostics: { visited, rejected }, activationReady: false };
}

export function planLakeSystem(world, basin, { outlet = {}, inlets = {}, inland = true } = {}) {
  const drainage = planBasinDrainage(world, basin, outlet);
  if (drainage.status === 'baked' || !inland) return addBasinInlets(world, drainage, inlets);
  // A contained inland lake is a valid receiving body even without a route to
  // the ocean. Its incoming streams and lake are published as one owned mesh.
  let refined;
  try { refined = refineBasinConnection(world, basin); }
  catch (error) {
    if (['Basin connection grid budget exceeded', 'Uncontained refined basin'].includes(error.message)) return drainage;
    throw error;
  }
  const component = { status: 'fitted', basins: [refined], reaches: [], junctions: [] };
  const result = addBasinInlets(world, { status: 'baked', basin: refined, component,
    mesh: null, visited: drainage.visited || 0, attempts: Array.isArray(drainage.attempts) ? drainage.attempts.length : (drainage.attempts || 0), inland: true }, inlets);
  return result.inletCount ? result : drainage;
}
