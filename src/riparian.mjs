import { mulberry32 } from './noise.js';

// Small patches on a global lattice survive chunk/LOD changes. Every blade
// and stone is seated on the shared water/terrain field and owned by one chunk.
export function riparianPlacements(world, cx, cz, chunkSize, blockedAt = () => false) {
  if (world.generationVersion !== 3 || !world.waterField?.gridStep(cx * chunkSize, cz * chunkSize,
    (cx + 1) * chunkSize, (cz + 1) * chunkSize)) return [];
  const minX = cx * chunkSize, minZ = cz * chunkSize, maxX = minX + chunkSize, maxZ = minZ + chunkSize;
  const result = [], step = 6;
  for (let iz = Math.floor((minZ - 4) / step); iz <= Math.floor((maxZ + 4) / step); iz++) {
    for (let ix = Math.floor((minX - 4) / step); ix <= Math.floor((maxX + 4) / step); ix++) {
      const rng = mulberry32(Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663) ^ world.seed ^ 0x52454544);
      const x = (ix + 0.15 + rng() * 0.7) * step, z = (iz + 0.15 + rng() * 0.7) * step;
      const patch = world.glade.noise(x * 0.038 + 29, z * 0.038 - 11);
      const water = world.riverAt(x, z);
      if (water.wet && water.depth > 0.02 && water.depth < 0.5 && water.exposure < 0.65 && patch > -0.16) {
        const count = 3 + Math.floor(rng() * 6);
        for (let i = 0; i < count; i++) {
          const px = x + (rng() - 0.5) * 5, pz = z + (rng() - 0.5) * 5;
          const scale = 0.65 + rng() * 0.65, yaw = rng() * Math.PI * 2, variant = Math.floor(rng() * 4);
          if (px < minX || px >= maxX || pz < minZ || pz >= maxZ || blockedAt(px, pz)) continue;
          const r = world.riverAt(px, pz);
          if (!r.wet || r.depth < 0.015 || r.depth > 0.58) continue;
          result.push({ type: 'reed', x: px, y: r.floor - 0.035, z: pz, scale, yaw, variant });
        }
      } else if (!water.wet && patch < 0.15 && rng() < 0.28 && x >= minX && x < maxX && z >= minZ && z < maxZ) {
        if (blockedAt(x, z)) continue;
        const shores = [[-3, 0], [3, 0], [0, -3], [0, 3]].map(([dx, dz]) => world.riverAt(x + dx, z + dz));
        const near = shores.find(r => r.wet && Math.abs(water.floor - r.y) < 0.9);
        if (!near || water.floor < 0.7) continue;
        const scale = 0.32 + rng() * 0.72;
        result.push({ type: 'rock', x, y: water.floor - scale * 0.22, z, scale,
          yaw: rng() * Math.PI * 2, variant: Math.floor(rng() * 4) });
      }
    }
  }
  return result;
}
