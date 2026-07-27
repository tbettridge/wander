// VR-only grass proportions and transition policy. Desktop grass has its own
// geometry and remains untouched by these values.
export const XR_GRASS_WIDTH_SCALE = 0.70;
export const XR_GRASS_HEIGHT_SCALE = 0.75;
// Thin the population at layer boundaries instead of scaling blade geometry.
// A wider middle-distance transition lets the meadow dissolve into the
// terrain pigment before its geometry ends.
export const XR_GRASS_NEAR_EDGE_BLEND_METERS = 3;
export const XR_GRASS_MID_EDGE_BLEND_METERS = 8;
export const XR_GRASS_RECEIVES_SHADOWS = false;

export function scaledXRGrassDimensions(height, width) {
  return {
    height: height * XR_GRASS_HEIGHT_SCALE,
    width: width * XR_GRASS_WIDTH_SCALE,
  };
}
