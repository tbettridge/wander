// Shared render-only state for the currently previewed cave mouth.  Keeping
// this separate from cave generation lets terrain and vegetation respond to a
// selected entrance without importing the cave worker/THREE representation.

import * as THREE from 'three';

export const CAVE_WOODY_EXCLUSION_RADIUS = 12;

export const caveEntranceUniforms = {
  // xyz = surface mouth, w = enabled
  uCaveEntrance: { value: new THREE.Vector4(0, 0, 0, 0) },
  // xy = inward direction, z = corridor half width, w = inward reach
  uCaveEntranceShape: { value: new THREE.Vector4(0, 1, 4.6, 8.0) },
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
    spec.vegetationWidth ?? spec.width ?? 4.6,
    // Reach the whole carved corridor, not just the mouth: a cave that runs
    // shallowly under the surface (and the partial-wall geologies) cuts the
    // terrain far past the aperture, and vegetation must clear all of it.
    spec.vegetationReach ?? spec.vegetationDepth ?? spec.depth ?? 8.0,
  );
}

// The carved entrance is a corridor: the aperture at the mouth plus the passage
// that runs beneath the surface inward of it. Model the cleared region as a
// rounded rectangle along the inward axis — [mouth-3.5 .. mouth+reach] long,
// ±halfWidth wide — fading over ~1.4m so vegetation disappears exactly where the
// terrain has been cut away and stays everywhere else (no sterile oval on the
// intact ground or the rock walls around the mouth).
export const CAVE_EXCLUSION_GLSL = `
uniform vec4 uCaveEntrance;
uniform vec4 uCaveEntranceShape;
float caveRoundedCorridorMask(vec2 worldXZ, float outward, float halfWidth, float reach, float feather) {
  vec2 inward = normalize(uCaveEntranceShape.xy);
  vec2 d = worldXZ - uCaveEntrance.xz;
  float along = dot(d, inward);
  float side = dot(d, vec2(inward.y, -inward.x));
  float alongExcess = max(0.0, max(-outward - along, along - reach));
  float sideExcess = max(0.0, abs(side) - halfWidth);
  float dist = length(vec2(alongExcess, sideExcess));
  return 1.0 - smoothstep(0.0, feather, dist);
}
float caveEntranceMask(vec2 worldXZ) {
  if (uCaveEntrance.w < 0.5) return 0.0;
  return caveRoundedCorridorMask(
    worldXZ, 3.5, uCaveEntranceShape.z, uCaveEntranceShape.w, 1.4
  );
}
float caveWoodyMask(vec2 worldXZ) {
  if (uCaveEntrance.w < 0.5) return 0.0;
  // Give the aperture a generous, unconditional clearing from woody objects.
  // The full exclusion holds through 12m, then feathers out to avoid popping.
  float mouthDistance = distance(worldXZ, uCaveEntrance.xz);
  float woodyRadius = 1.0 - smoothstep(
    ${CAVE_WOODY_EXCLUSION_RADIUS.toFixed(1)},
    ${(CAVE_WOODY_EXCLUSION_RADIUS + 1.5).toFixed(1)},
    mouthDistance
  );
  return max(caveEntranceMask(worldXZ), woodyRadius);
}
`;
