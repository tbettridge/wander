// Explicit headset world complexity. XR display profiles own framebuffer,
// foveation, grass and shadow cadence; this tier owns the actual world that is
// streamed around the player. Keeping it separate prevents Quest's mobile
// startup guess (normally desktop Low) from silently limiting XR scenery.

export const DEFAULT_XR_WORLD_TIER = 'high';

export const XR_WORLD_TIERS = Object.freeze({
  high: Object.freeze({
    name: 'xr-high',
    label: 'XR High',
    viewRadius: 6,          // full terrain / rivers to 840m
    treeRadius: 3,          // full geometry to 420m, pooled impostors beyond
    impostorRadius: 10,     // forest silhouettes to 1.4km
    grassRadius: 1,         // XR grass profiles own the actual patch radius
    clutterRadius: 2,       // authored ground detail through the near 280m
    grassPerChunk: 0,       // ignored while XR planted patches are active
    treeDensityScale: 1.0,
    clutterDensityScale: 0.72,
    nearRes: 80,            // above desktop Medium, below desktop High
    shadowSize: 256,        // cadence/range remain display-profile policy
    rainTier: 'high',
  }),
});

export function normalizeXRWorldTierName(name) {
  return Object.hasOwn(XR_WORLD_TIERS, name) ? name : DEFAULT_XR_WORLD_TIER;
}

export function xrWorldTierForName(name) {
  return XR_WORLD_TIERS[normalizeXRWorldTierName(name)];
}

export function xrWorldTierLabel(tier) {
  if (!tier) return 'inactive';
  return `${tier.label} · terrain ${tier.viewRadius * 140}m · real trees ${tier.treeRadius * 140}m · forest ${tier.impostorRadius * 140}m · ${tier.nearRes}² near terrain`;
}
