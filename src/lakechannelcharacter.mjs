// Lake contacts use the same bank/width vocabulary as regional rivers.
// Small incoming creeks feed a larger receiving outlet; connected terrain
// continues to own the water head, rather than a visual ribbon.
export function lakeChannelProfile(world, basin, id, { inlet = false, morphology = true } = {}) {
  const halfWidth = inlet ? 2.4 : 4;
  return {
    id, variationSeed: world.seed, arcOffset: 0, morphology,
    halfWidth, startHalfWidth: halfWidth * 0.92, endHalfWidth: halfWidth * 1.16,
    depth: 1.2,
  };
}
