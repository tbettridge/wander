import { refineBasinConnection } from './basinmembership.mjs';
import { drainageAnchors } from './basinoutlet.mjs';
import { RiverRoutePlanner } from './riverroute.mjs';
import { fitRiverReach } from './riverterrain.mjs';
import { bakeSparseRiverComponent } from './riversparsemesh.mjs';
import { lakeChannelProfile } from './lakechannelcharacter.mjs';
import { proposeRiverMeanders } from './rivermeanders.mjs';

// Join a higher contained lake to a lower contained lake. Neither endpoint is
// an arbitrary regional boundary; the complete connection has one mesh owner.
export function connectInlandBasins(world, source, target, {
  maxVisited = 2048, maxAttempts = 4, existingReaches = [],
  riverCharacter = false, riverMeanders = false, riverMorphology = false,
} = {}) {
  if (!Number.isInteger(maxVisited) || maxVisited < 1 || maxVisited > 8192
    || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8
    || ![riverCharacter, riverMeanders, riverMorphology].every(v => typeof v === 'boolean')) throw new Error('Invalid inland connection budget');
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
    const id = `lake-link:${upper.id}:${lower.id}`;
    const profile = riverCharacter || riverMorphology
      ? lakeChannelProfile(world, upper, id, { inlet: true, morphology: riverMorphology }) : null;
    const options = { id, basins: [upper, lower],
      sourceClosure: false, oceanMouth: false, halfWidth: 2.4,
      fixedLevels: [{ ...anchor, minY: upper.level, maxY: upper.level }],
      ...(profile ? { channelProfile: profile } : {}) };
    const authored = { ...route, id, sourceClosure: false, oceanMouth: false,
      points: route.points.map((point, i) => ({ ...point,
        ...(profile && i === 0 ? { basinId: upper.id } : {}),
        ...(profile && i === route.points.length - 1 ? { basinId: lower.id } : {}),
      })) };
    const proposals = [authored];
    if (riverMeanders) {
      const shaped = proposeRiverMeanders(world, { status: 'candidate', reaches: [authored], junctions: [] },
        { channelProfiles: profile ? { [id]: profile } : {} });
      if (shaped.diagnostics.proposed > 0) proposals.unshift(shaped.reaches[0]);
    }
    const trials = proposals.map(proposal => ({ proposal, options }));
    if (profile) trials.push({ proposal: route, options: { ...options, channelProfile: undefined }, conservative: true });
    for (const trial of trials) {
      const reach = fitRiverReach(world, trial.proposal, trial.options);
      if (reach.status !== 'fitted') { reason = reach.reason; continue; }
      if (![upper, lower].every(b => reach.basinIds?.includes(b.id))) { reason = 'inland-link-misses-lake'; continue; }
      const component = { status: 'fitted', basins: [upper, lower], reaches: [...existingReaches, reach], junctions: [],
        ...(trial.conservative ? { featureFallback: reason } : {}) };
      const mesh = bakeSparseRiverComponent(world, component);
      if (mesh.status !== 'baked') { reason = mesh.reason; continue; }
      return { status: 'baked', component, mesh, sourceId: upper.id, targetId: lower.id, visited, inland: !mesh.oceanHandoff };
    }
  }
  return { ...reject(reason), visited };
}
