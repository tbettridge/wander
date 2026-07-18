// Shared render-only state for the currently previewed cave mouth.  Keeping
// this separate from cave generation lets terrain and vegetation respond to a
// selected entrance without importing the cave worker/THREE representation.

import * as THREE from 'three';

export const caveEntranceUniforms = {
  // xyz = surface mouth, w = enabled
  uCaveEntrance: { value: new THREE.Vector4(0, 0, 0, 0) },
  // xy = inward direction, z = half width, w = half depth
  uCaveEntranceShape: { value: new THREE.Vector4(0, 1, 4.8, 6.2) },
};

export function setCaveEntranceVisual(spec = null) {
  if (!spec) {
    caveEntranceUniforms.uCaveEntrance.value.w = 0;
    return;
  }
  caveEntranceUniforms.uCaveEntrance.value.set(spec.x, spec.y, spec.z, 1);
  caveEntranceUniforms.uCaveEntranceShape.value.set(
    spec.inwardX,
    spec.inwardZ,
    spec.vegetationWidth ?? spec.width ?? 4.8,
    spec.vegetationDepth ?? spec.depth ?? 6.2,
  );
}

export const CAVE_EXCLUSION_GLSL = `
uniform vec4 uCaveEntrance;
uniform vec4 uCaveEntranceShape;
float caveEntranceMask(vec2 worldXZ) {
  if (uCaveEntrance.w < 0.5) return 0.0;
  vec2 d = worldXZ - uCaveEntrance.xz;
  vec2 inward = normalize(uCaveEntranceShape.xy);
  float along = dot(d, inward) - 0.75;
  float side = dot(d, vec2(inward.y, -inward.x));
  vec2 q = vec2(side / uCaveEntranceShape.z, along / uCaveEntranceShape.w);
  return 1.0 - step(1.0, dot(q, q));
}
`;
