// Lightweight terrain treatment used only while WebXR is presenting. The
// desktop MeshStandardMaterial keeps its full ground-detail pipeline; this
// Lambert path spends its budget on broad colour grouping, warm/cool light,
// one cached cloud-shadow lookup, aerial depth, and an animated meadow wash.

import * as THREE from 'three';
import { atmoUniforms, injectAtmosphere } from './atmosphere.js';

export function createXRTerrainMaterial() {
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true,
    fog: true,
    dithering: true,
  });
  material.name = 'xr-painterly-terrain';

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uXRMeadowTime = atmoUniforms.uAtmoTime;
    shader.vertexShader = `
attribute float aGroundMacro;
attribute float aXRShade;
varying float vXRGroundMacro;
varying float vXRShade;
varying float vXRUp;
varying vec3 vXRWorldPosition;
` + shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
       vXRGroundMacro = aGroundMacro;
       vXRShade = aXRShade;
       vXRUp = normal.y;
       vXRWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
    );

    shader.fragmentShader = `
uniform float uXRMeadowTime;
varying float vXRGroundMacro;
varying float vXRShade;
varying float vXRUp;
varying vec3 vXRWorldPosition;
` + shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `{
         // Group diffuse light into soft painted masses without discarding the
         // hue of Three's live sun, hemisphere fill, moonlight, or shadows.
         float _xrBaseLuma = max(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.025);
         float _xrLitLuma = max(dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722)), 0.002);
         float _xrRelative = clamp(_xrLitLuma / _xrBaseLuma, 0.0, 2.4);
         float _xrLow = mix(0.56, 0.78, smoothstep(0.18, 0.62, _xrRelative));
         float _xrHigh = mix(0.78, 1.34, smoothstep(0.62, 1.55, _xrRelative));
         float _xrGrouped = mix(_xrLow, _xrHigh, smoothstep(0.54, 0.86, _xrRelative));
         _xrGrouped = mix(_xrRelative, _xrGrouped, 0.38);

         // Worker-baked curvature gives shade weight without an AO pass. Steep
         // faces keep a little extra cool value so mountain relief stays clear.
         float _xrShape = clamp(vXRShade * mix(0.90, 1.0, smoothstep(0.28, 0.82, vXRUp)), 0.68, 1.10);
         float _xrLightAmount = smoothstep(0.58, 1.25, _xrRelative);
         vec3 _xrPigmentLight = mix(vec3(0.80, 0.88, 1.06), vec3(1.08, 1.015, 0.89), _xrLightAmount);
         outgoingLight *= (_xrGrouped / max(_xrRelative, 0.08)) * _xrShape;
         outgoingLight *= mix(vec3(1.0), _xrPigmentLight, 0.26 * uAtmoDay);

         // Past the true-blade ring, ground pigment carries a travelling gust
         // highlight. It is shared with grass's macro dryness and costs no far
         // geometry, making the meadow continue visually toward the treeline.
         float _xrGreen = smoothstep(0.0, 0.075,
           diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
         float _xrDistance = length(cameraPosition - vXRWorldPosition);
         float _xrFarMeadow = smoothstep(13.0, 28.0, _xrDistance)
                            * (1.0 - smoothstep(85.0, 165.0, _xrDistance));
         float _xrWave = sin(dot(vXRWorldPosition.xz, vec2(0.052, 0.037))
                           - uXRMeadowTime * 1.35
                           + sin(vXRWorldPosition.x * 0.016 + uXRMeadowTime * 0.45) * 1.6);
         float _xrGust = smoothstep(0.35, 0.94, _xrWave)
                       * mix(0.60, 1.0, vXRGroundMacro);
         outgoingLight *= 1.0 + _xrGreen * _xrFarMeadow * _xrGust * 0.11 * uAtmoDay;
       }
       #include <opaque_fragment>`,
    );
  };

  material.customProgramCacheKey = () => 'xr-painterly-terrain-v1';
  injectAtmosphere(material, { clouds: true, aerial: true });
  return material;
}
