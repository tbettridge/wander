// A restrained painterly finish for foliage. The geometry still uses Three's
// ordinary light/shadow plumbing, but its final lit colour is grouped into soft
// value masses and steered from cool shadow pigment toward warm sun pigment.
// This is deliberately a shader injection rather than a new material family so
// it composes with canopy sway, atlas UVs, per-instance colour and cave masks.

import * as THREE from 'three';

export const painterFoliageUniforms = {
  enabled: { value: true },
  strength: { value: 0.78 },
  grouping: { value: 0.20 },
  // Keep GUI-exposed colours within display gamut; the light tint may exceed
  // one slightly in linear HDR, but a >1 colour-picker channel wraps in lil-gui.
  shadowTint: { value: new THREE.Color(0.78, 0.86, 1.00) },
  lightTint: { value: new THREE.Color(1.045, 1.015, 0.93) },
};

export function injectPainterFoliage(material, { greenGate = false } = {}) {
  const previous = material.onBeforeCompile;
  const gate = greenGate
    ? 'smoothstep(0.0, 0.055, gl_FragColor.g - max(gl_FragColor.r, gl_FragColor.b))'
    : '1.0';

  material.onBeforeCompile = (shader, renderer) => {
    if (previous) previous.call(material, shader, renderer);
    for (const [name, uniform] of Object.entries(painterFoliageUniforms)) {
      shader.uniforms[`uPainterFoliage${name[0].toUpperCase()}${name.slice(1)}`] = uniform;
    }
    shader.fragmentShader = `
uniform bool uPainterFoliageEnabled;
uniform float uPainterFoliageStrength;
uniform float uPainterFoliageGrouping;
uniform vec3 uPainterFoliageShadowTint;
uniform vec3 uPainterFoliageLightTint;
` + shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `#include <opaque_fragment>
       if (uPainterFoliageEnabled) {
         float _pfMask = ${gate};
         float _pfLuma = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
         float _pfLight = smoothstep(0.18, 0.68, _pfLuma);
         vec3 _pfTint = mix(uPainterFoliageShadowTint, uPainterFoliageLightTint, _pfLight);
         vec3 _pfPaint = gl_FragColor.rgb * _pfTint;
         float _pfPaintLuma = dot(_pfPaint, vec3(0.2126, 0.7152, 0.0722));
         float _pfBand = (floor(_pfPaintLuma * 6.0) + 0.5) / 6.0;
         float _pfGrouped = mix(_pfPaintLuma, _pfBand, uPainterFoliageGrouping);
         _pfPaint *= _pfPaintLuma > 0.002 ? _pfGrouped / _pfPaintLuma : 1.0;
         gl_FragColor.rgb = mix(gl_FragColor.rgb, _pfPaint,
           uPainterFoliageStrength * _pfMask);
       }`,
    );
  };

  const previousKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${previousKey?.() || ''}:painter-foliage:${greenGate ? 'green' : 'all'}`;
  material.needsUpdate = true;
  return material;
}
