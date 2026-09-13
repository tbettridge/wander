// Explicit development entry only. The normal game retains generation 2 until
// connected rivers, regenerated crossings and the wider visual corpus pass their gates.
// Planning finishes before a World, renderer chunk or player query is activated.
import { trailsAround, trailFrameAtArc } from './trails.js';
import { solveCrossing } from './trailcrossings.mjs';

export async function prepareWaterPreview(seed, search = '') {
  const mode = new URLSearchParams(search).get('waterPreview');
  if (!['basins', 'fresh'].includes(mode)) return null;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hydrologyworker.js?v=hydrology4', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.type === 'fresh-planned') resolve({ waterPlans: [data.plan] });
      else if (data.type === 'basins-planned') resolve({ waterPlans: [data.plan], crossingManifests: [data.manifest] });
      else reject(new Error(data.error || 'Water preview planning failed'));
    };
    worker.onerror = error => { worker.terminate(); reject(new Error(error.message || 'Water preview worker failed')); };
    worker.postMessage({ type: mode === 'fresh' ? 'plan-fresh' : 'plan-basins', id: 1, seed, regionX: 0, regionZ: 0 });
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
  const bodies = [...(world.waterField?.bodies.values() || [])];
  const body = bodies.find(b => b.kind === 'lake') || bodies[0];
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
