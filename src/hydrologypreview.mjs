// Explicit development entry only. The normal game retains generation 2 until
// connected rivers, regenerated crossings and the wider visual corpus pass their gates.
// Planning finishes before a World, renderer chunk or player query is activated.
import { trailsAround, trailFrameAtArc } from './trails.js';
import { solveCrossing } from './trailcrossings.mjs';

export async function prepareWaterPreview(seed, search = '') {
  const params = new URLSearchParams(search), mode = params.get('waterPreview');
  if (mode === 'regional') {
    const status = globalThis.document?.getElementById('status');
    const { HydrologyStream, waterPlanningMessage } = await import('./hydrologystream.mjs');
    if (status) { status.setAttribute('role', 'status'); status.textContent = waterPlanningMessage(null, true); }
    const stream = new HydrologyStream(seed, new Worker(new URL('./hydrologyworker.js?v=hydrology10', import.meta.url), { type: 'module' }), {
      onProgress: progress => { if (status) status.textContent = waterPlanningMessage(progress, true); },
    });
    try {
      const window = await stream.initialize(Number(params.get('waterPreviewRegionX') || 0), Number(params.get('waterPreviewRegionZ') || 0));
      stream.commit(window);
      stream.onProgress = null;
      if (status) status.textContent = 'Preparing terrain…';
      return { waterPlans: window.plans, generationVersion: 3, stream };
    } catch (error) {
      stream.dispose();
      if (status) status.textContent = 'Could not prepare this landscape. Reload to retry.';
      throw error;
    }
  }
  if (!['basins', 'fresh', 'network', 'drainage'].includes(mode)) return null;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hydrologyworker.js?v=hydrology7', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (['fresh-planned', 'network-preview-planned', 'basin-drainage-planned'].includes(data.type)) resolve({ waterPlans: [data.plan] });
      else if (data.type === 'basins-planned') resolve({ waterPlans: [data.plan], crossingManifests: [data.manifest] });
      else reject(new Error(data.error || 'Water preview planning failed'));
    };
    worker.onerror = error => { worker.terminate(); reject(new Error(error.message || 'Water preview worker failed')); };
    worker.postMessage({ type: mode === 'drainage' ? 'plan-basin-drainage-preview' : mode === 'network' ? 'plan-network-preview' : mode === 'fresh' ? 'plan-fresh' : 'plan-basins', id: 1, seed, regionX: Number(params.get('waterPreviewRegionX') || 0), regionZ: Number(params.get('waterPreviewRegionZ') || 0), basinId: params.get('waterPreviewBasin') });
  });
}

export function waterPreviewSpawn(world, search = '') {
  if (world.generationVersion === 3 && new URLSearchParams(search).get('waterPreviewTarget') === 'crossing') {
    const plan = world.waterField?.plans[0];
    if (plan) {
      const edges = trailsAround(world, (plan.regionX + 0.5) * 4096, (plan.regionZ + 0.5) * 4096,
        world.seed, 5000, []);
      for (const edge of edges) for (const ford of edge.fords || []) {
        const crossing = solveCrossing(world, edge, ford);
        if (!crossing) continue;
        const p = trailFrameAtArc(edge, Math.max(0, crossing.arcStart - 4), {});
        const site = world.biomeAt(p.x, p.z);
        if (world.riverAt(p.x, p.z).wet || site.h <= 0.55 || site.slope > 0.3) continue;
        return { x: p.x, z: p.z, tangentX: crossing.x - p.x, tangentZ: crossing.z - p.z,
          crossingId: `${edge.id}:crossing:${edge.fords.indexOf(ford)}`, crossingKind: crossing.kind };
      }
    }
  }
  const params = new URLSearchParams(search);
  const regional = params.get('waterPreview') === 'regional';
  const regionX = Number(params.get('waterPreviewRegionX') || 0), regionZ = Number(params.get('waterPreviewRegionZ') || 0);
  const bodies = [...(world.waterField?.bodies.values() || [])]
    .filter(b => !regional || (b.ownerX === regionX && b.ownerZ === regionZ));
  let target = world.waterField?.plans.find(p => p.spawnTarget)?.spawnTarget;
  if (regional) {
    const plan = world.waterField?.plans.find(p => p.regionX === regionX && p.regionZ === regionZ);
    const component = plan?.components.find(c => c.basinIds?.length) || plan?.components[0];
    const g = component?.grid;
    if (g) {
      let index = -1;
      for (let i = 0; i < g.signed.length; i++) {
        if (g.signed[i] > 0 && (index < 0 || (g.lakeKind?.[i] || 0) > (g.lakeKind?.[index] || 0)
          || (g.lakeKind?.[i] === g.lakeKind?.[index] && g.signed[i] > g.signed[index]))) index = i;
      }
      if (index >= 0) target = { x: g.coords[index][0] * g.step, z: g.coords[index][1] * g.step };
    }
  }
  const body = bodies.find(b => b.kind === 'lake') || (!regional || !target ? bodies[0] : null)
    || (target && { centerX: target.x, centerZ: target.z, level: world.riverAt(target.x, target.z).y, id: 'network-preview' });
  if (!body) return null;
  let nearest = null;
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 16) {
    for (let distance = 8; distance <= 500; distance += 2) {
      const x = body.centerX + Math.cos(angle) * distance, z = body.centerZ + Math.sin(angle) * distance;
      const terrain = world.biomeAt(x, z);
      if (!world.riverAt(x, z).wet && terrain.h > body.level + 0.3 && terrain.slope < 0.2) {
        if (!nearest || distance < nearest.distance) nearest = { x, z, distance,
          tangentX: body.centerX - x, tangentZ: body.centerZ - z, bodyId: body.id };
        break;
      }
    }
  }
  return nearest;
}
