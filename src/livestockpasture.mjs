// Village livestock lives in stable, open grazing fields beyond the last house.
import { mulberry32 } from './noise.js';
import { builtRadius, groundIsClear } from './horsepasture.mjs';

export const LIVESTOCK_PASTURE_REACH = 220;
export const LIVESTOCK_MAX_ACTIVE = 16;
const RURAL_KINDS = new Set(['farmstead', 'hamlet', 'village', 'town']);

export function isLivestockVillage(site) {
  return !!site && !site.isStationSettlement && RURAL_KINDS.has(site.kind);
}

export function pastureContains(pasture, x, z, margin = 0) {
  return !pasture || Math.hypot(x - pasture.x, z - pasture.z) <= Math.max(0, pasture.radius - margin);
}

export function livestockGroundSuitable(world, plan, x, z, blockedAt = null) {
  const biome = world.biomeAt(x, z);
  if (!biome || biome.h <= 1 || biome.slope > 0.22) return false;
  if (!['grassland', 'savanna', 'forest', 'taiga', 'tundra'].includes(biome.id)) return false;
  const river = world.riverAt(x, z);
  if (river.wet || blockedAt?.(x, z)) return false;
  const wooded = biome.id === 'forest' || biome.id === 'taiga';
  // Grassland is already a field; the glade signal is only a prerequisite
  // when the biome would otherwise put a woodland canopy over the herd.
  if (wooded && (world.openFactor?.(x, z) ?? 0.3) < 0.50) return false;
  if ((world.groveFactor?.(x, z) ?? (wooded ? 0.7 : 0.1)) > 0.42) return false;
  return groundIsClear(plan, x, z, 2.5);
}

export function createLivestockPasture(world, plan, species, occupied = [], blockedAt = null) {
  const site = plan?.site;
  if (!isLivestockVillage(site) || !['sheep', 'cow'].includes(species)) return null;
  const rng = mulberry32((site.seed ^ (species === 'sheep' ? 0x53484545 : 0x434f5721)) >>> 0);
  const radius = species === 'sheep' ? 24 : 28;
  const reach = Math.max(site.radius, builtRadius(plan, site));
  const phase = rng() * Math.PI * 2;
  let best = null;
  for (let ring = 0; ring < 3; ring++) for (let i = 0; i < 20; i++) {
    const angle = phase + i * Math.PI / 10;
    const distance = reach + radius + 22 + ring * 32;
    const x = site.x + Math.cos(angle) * distance, z = site.z + Math.sin(angle) * distance;
    if (occupied.some(p => Math.hypot(p.x - x, p.z - z) < p.radius + radius + 10)) continue;
    let clear = true, relief = 0;
    const centreY = world.height(x, z);
    // Validate the grazing area, not only the herd's first standing point.
    for (let sample = -1; sample < 8; sample++) {
      const a = sample * Math.PI / 4, r = sample < 0 ? 0 : radius;
      const sx = x + Math.cos(a) * r, sz = z + Math.sin(a) * r;
      if (!livestockGroundSuitable(world, plan, sx, sz, blockedAt)
        || (species === 'cow' && world.biomeAt(sx, sz).id === 'tundra')) { clear = false; break; }
      relief = Math.max(relief, Math.abs(world.height(sx, sz) - centreY));
    }
    if (!clear || relief > radius * 0.20) continue;
    const score = (world.openFactor?.(x, z) ?? 0.9) * 3 - relief * 0.4 - ring * 0.15;
    if (!best || score > best.score) best = { id: `${site.id}:pasture:${species}`, x, z, radius, score };
  }
  return best;
}
