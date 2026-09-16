import { refineBasinConnection } from './basinmembership.mjs';
import { drainageAnchors } from './basinoutlet.mjs';
import { RiverRoutePlanner } from './riverroute.mjs';
import { fitRiverReach } from './riverterrain.mjs';
import { bakeSparseRiverComponent } from './riversparsemesh.mjs';

// Join a higher contained lake to a lower contained lake. Neither endpoint is
// an arbitrary regional boundary; the complete connection has one mesh owner.
export function connectInlandBasins(world, source, target, { maxVisited = 2048, maxAttempts = 4, existingReaches = [] } = {}) {
  if (!Number.isInteger(maxVisited) || maxVisited < 1 || maxVisited > 8192
    || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) throw new Error('Invalid inland connection budget');
  if (!Array.isArray(existingReaches) || existingReaches.some(r => r.status && r.status !== 'fitted')) throw new Error('Invalid existing inland reaches');
  const reject = reason => ({ status: 'rejected', reason, sourceId: source?.id, targetId: target?.id });
  if (!source || !target || source.id === target.id || !(source.level > target.level + 0.2)) return reject('invalid-downstream-lake');
  if (existingReaches.some(r => !r.sourceClosure && r.basinIds?.includes(source.id))) return reject('lake-already-has-outlet');
  const distance = Math.hypot(source.centerX - target.centerX, source.centerZ - target.centerZ);
  if (distance > 1400) return reject('inland-connection-extent');
  let upper, lower;
  try { upper = refineBasinConnection(world, source); lower = refineBasinConnection(world, target); }
  catch (error) {
    if (['Basin connection grid budget exceeded', 'Uncontained refined basin'].includes(error.message)) return reject('uncontained-inland-lake');
    throw error;
  }
  const anchors = drainageAnchors(world, upper, { x: upper.centerX, z: upper.centerZ });
  anchors.sort((a, b) => Math.hypot(a.x - lower.centerX, a.z - lower.centerZ) - Math.hypot(b.x - lower.centerX, b.z - lower.centerZ)
    || a.x - b.x || a.z - b.z);
  let visited = 0, reason = 'inland-route-budget';
  for (const anchor of anchors.slice(0, maxAttempts)) {
    if (visited >= 8192) break;
    const route = new RiverRoutePlanner(world, { step: 32, maxVisited: Math.min(maxVisited, 8192 - visited) })
      .route({ ...anchor, minY: upper.level, maxY: upper.level }, { deferProfile: true,
        hydraulic: true, basinSource: upper, basinTarget: lower });
    visited += route.visited || 0;
    if (route.status !== 'candidate') { reason = route.reason; continue; }
    const reach = fitRiverReach(world, route, { id: `lake-link:${upper.id}:${lower.id}`, basins: [upper, lower],
      sourceClosure: false, oceanMouth: false, halfWidth: 2.4,
      fixedLevels: [{ ...anchor, minY: upper.level, maxY: upper.level }] });
    if (reach.status !== 'fitted') { reason = reach.reason; continue; }
    if (![upper, lower].every(b => reach.basinIds?.includes(b.id))) { reason = 'inland-link-misses-lake'; continue; }
    const component = { status: 'fitted', basins: [upper, lower], reaches: [...existingReaches, reach], junctions: [] };
    const mesh = bakeSparseRiverComponent(world, component);
    if (mesh.status !== 'baked') { reason = mesh.reason; continue; }
    return { status: 'baked', component, mesh, sourceId: upper.id, targetId: lower.id, visited, inland: !mesh.oceanHandoff };
  }
  return { ...reject(reason), visited };
}
