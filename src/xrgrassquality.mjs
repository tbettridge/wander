// VR-only grass proportions and transition policy. Desktop grass has its own
// geometry and remains untouched by these values.
export const XR_GRASS_WIDTH_SCALE = 0.70;
export const XR_GRASS_HEIGHT_SCALE = 0.75;
export const XR_GRASS_OUTER_FADE_METERS = 2;
export const XR_GRASS_RECEIVES_SHADOWS = false;

export function scaledXRGrassDimensions(height, width) {
  return {
    height: height * XR_GRASS_HEIGHT_SCALE,
    width: width * XR_GRASS_WIDTH_SCALE,
  };
}
