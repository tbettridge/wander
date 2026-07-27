// Three.js reserves layers 1 and 2 for its left- and right-eye WebXR cameras.
// XR-only utility geometry must never use either layer or it becomes visible
// to just one eye, causing severe binocular rivalry in a headset.
export const THREE_XR_LEFT_EYE_LAYER = 1;
export const THREE_XR_RIGHT_EYE_LAYER = 2;
export const THREE_XR_EYE_LAYERS = Object.freeze([
  THREE_XR_LEFT_EYE_LAYER,
  THREE_XR_RIGHT_EYE_LAYER,
]);

// Keep this below 31 so its bit mask remains a positive signed 32-bit value.
// It is enabled only on the sun shadow camera, never on either view camera.
export const XR_SHADOW_LAYER = 30;

export function isThreeXREyeLayer(layer) {
  return THREE_XR_EYE_LAYERS.includes(layer);
}
