function positionOf(card) {
  return card?.position || { x: 0, y: 0, z: 0 };
}

function distanceSquared(card, origin) {
  const position = positionOf(card);
  const dx = (position.x || 0) - (origin?.x || 0);
  const dy = (position.y || 0) - (origin?.y || 0);
  const dz = (position.z || 0) - (origin?.z || 0);
  return dx * dx + dy * dy + dz * dz;
}

export function packedCloudCardOrder(cards, sortOrigin = null) {
  const visible = cards.filter((card) => card?.visible
    && Number(card?.material?.opacity) > 0.003);
  if (sortOrigin && visible.length > 1) {
    visible.sort((a, b) => distanceSquared(b, sortOrigin)
      - distanceSquared(a, sortOrigin));
  }
  return visible;
}

// One instanced submission per non-empty texture-atlas layer, independent of
// the number of cloud cards packed into that layer.
export function cloudLayerDrawBudget(layerCardCounts) {
  return layerCardCounts.reduce((total, count) => total + (count > 0 ? 1 : 0), 0);
}
