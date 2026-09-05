/** The generation inputs that must travel with a region's seed. */
export function normalizeRailwayLayout(value) {
  if (!value || value.version !== 1) return null;
  const { center, radius, searchRadius, stationCount } = value;
  if (
    !Number.isFinite(center?.x) ||
    !Number.isFinite(center?.z) ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    radius > 20000 ||
    !Number.isFinite(searchRadius) ||
    searchRadius < 0 ||
    searchRadius > 20000 ||
    !Number.isInteger(stationCount) ||
    stationCount < 4 ||
    stationCount > 6
  )
    return null;
  return {
    version: 1,
    center: { x: center.x, z: center.z },
    radius,
    searchRadius,
    stationCount,
    terrainEnabled: value.terrainEnabled !== false,
    trackEnabled: value.trackEnabled !== false,
  };
}

export function captureRailwayLayout(railway) {
  return normalizeRailwayLayout({
    version: 1,
    center: railway.requestedCenter,
    radius: railway.radius,
    searchRadius: railway.searchRadius,
    stationCount: railway.debug.stationCount,
    terrainEnabled: railway.debug.terrainEnabled,
    trackEnabled: railway.debug.trackEnabled,
  });
}
