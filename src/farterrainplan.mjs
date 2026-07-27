// Geometry-only policy for the distant landscape. Kept free of THREE so the
// topology and rebuild budget can be checked in Node without a browser.

export const FAR_SURFACE_ANGULAR = 160;
export const FAR_SURFACE_RINGS = 40;
// Match the inner surface's spokes at the 3 km handoff so independently drawn
// meshes share identical boundary vertices and cannot open a skyline crack.
export const FAR_RIBBON_ANGULAR = FAR_SURFACE_ANGULAR;
export const FAR_RIBBON_RADII = Object.freeze([3000, 5000, 7500]);
export const FAR_REBUILD_DIST = 450;

export function fillSurfaceRadii(nearField, target) {
  if (!target || target.length !== FAR_SURFACE_RINGS) {
    throw new RangeError(`Expected ${FAR_SURFACE_RINGS} surface radii`);
  }
  const outer = FAR_RIBBON_RADII[0];
  const inner = Math.min(outer * 0.75, Math.max(120, nearField * 0.6));
  for (let i = 0; i < target.length; i++) {
    target[i] = inner * Math.pow(outer / inner, i / (target.length - 1));
  }
  // Avoid Float32 rounding leaving a sub-pixel crack against the first ribbon.
  target[target.length - 1] = outer;
  return target;
}

export function farTerrainTopology() {
  const ribbonCount = FAR_RIBBON_RADII.length;
  const surfaceVertices = FAR_SURFACE_RINGS * FAR_SURFACE_ANGULAR;
  const surfaceTriangles = (FAR_SURFACE_RINGS - 1) * FAR_SURFACE_ANGULAR * 2;
  const ribbonVertices = ribbonCount * FAR_RIBBON_ANGULAR * 2;
  const ribbonTriangles = ribbonCount * FAR_RIBBON_ANGULAR * 2;
  return {
    ribbonCount,
    surfaceVertices,
    surfaceTriangles,
    ribbonVertices,
    ribbonTriangles,
    totalVertices: surfaceVertices + ribbonVertices,
    totalTriangles: surfaceTriangles + ribbonTriangles,
  };
}
