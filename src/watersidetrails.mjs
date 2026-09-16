import { descriptorHash } from './hydrologyformat.mjs';

const cache = new WeakMap();

// A few quiet destinations, not a path around every shore. Cache by immutable
// field so every geometry/grass worker derives the same endpoints after a swap.
export function watersideTrailNodes(world) {
  const field = world.waterField;
  if (!field || world.generationVersion !== 3) return [];
  if (cache.has(field)) return cache.get(field);
  const nodes = [];
  for (const plan of field.plans) {
    if (plan.regional !== 1) continue;
    const targets = plan.basins.map(b => ({ id: b.id, x: b.centerX, z: b.centerZ, level: b.level, kind: b.kind }));
    for (const mesh of plan.components || []) {
      if (!mesh.basinIds?.length) continue;
      const g = mesh.grid;
      let index = -1;
      for (let i = 0; i < g.coords.length; i++) {
        if (g.lakeKind[i] > 0 && g.signed[i] > 0 && (index < 0 || g.signed[i] > g.signed[index])) index = i;
      }
      if (index >= 0) targets.push({ id: mesh.basinIds[0], x: g.coords[index][0] * g.step,
        z: g.coords[index][1] * g.step, level: g.head[index], kind: g.lakeKind[index] === 2 ? 'lake' : 'pond' });
    }
    targets.sort((a, b) => Number(b.kind === 'lake') - Number(a.kind === 'lake')
      || descriptorHash(['waterside', a.id]).localeCompare(descriptorHash(['waterside', b.id])));
    let accepted = 0;
    for (const target of targets) {
      if (accepted >= 2) break;
      let best = null;
      for (let ray = 0; ray < 16; ray++) {
        const angle = ray * Math.PI / 8;
        let leftWaterAt = null;
        for (let d = 4; d <= 640; d += 4) {
          const x = target.x + Math.cos(angle) * d, z = target.z + Math.sin(angle) * d;
          if (world.riverAt(x, z).wet) { leftWaterAt = null; continue; }
          leftWaterAt ??= d;
          if (d > leftWaterAt + 20) break;
          const site = world.biomeAt(x, z);
          if (site.h < target.level + 0.25 || site.h > target.level + 2 || site.slope > 0.2) continue;
          const score = d + site.slope * 80;
          if (!best || score < best.score) best = { x, z, score };
          break;
        }
      }
      if (!best) continue;
      nodes.push({ key: `waterside:${target.id}`, type: 'waterside', halo: 0,
        x: best.x, z: best.z, seed: Number.parseInt(descriptorHash(target.id), 16), waterBody: target.id,
        viewX: target.x, viewZ: target.z });
      accepted++;
    }
  }
  cache.set(field, nodes);
  return nodes;
}
