// Lightweight terrain treatment used only while WebXR is presenting. The
// desktop MeshStandardMaterial keeps its full ground-detail pipeline; this
// Lambert path spends its budget on the painted three-tone ramp, warm/cool
// light, one cached cloud-shadow lookup, aerial depth, and an animated meadow
// wash.
//
// The ramp replaces what used to be a screen-space luma regrouping here. That
// grouped VALUE, which is only half the job: it could darken a slope but never
// change the colour a shadow falls to, and it grouped across surfaces rather
// than along them. paintSurface() has the world normal and the authored pigment
// in hand, so the bands land on the terrain's own form and the shade tone
// carries the palette's shadow hue.
//
// It is also cheaper than what it replaces on Quest: the old block ran four
// smoothsteps and two luma dots to approximate banding; this runs two
// smoothsteps over a triple derived with cheap arithmetic, and the noise it
// adds is two hashes.

import * as THREE from 'three';
import { atmoUniforms, injectAtmosphere } from './atmosphere.js';
import { PAINTERLY_GLSL } from './painterly.mjs';

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
varying vec3 vXRWorldNormal;
` + shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
       vXRGroundMacro = aGroundMacro;
       vXRShade = aXRShade;
       vXRUp = normal.y;
       vXRWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
       vXRWorldNormal = normalize(mat3(modelMatrix) * normal);`,
    );

    shader.fragmentShader = `
uniform float uXRMeadowTime;
varying float vXRGroundMacro;
varying float vXRShade;
varying float vXRUp;
varying vec3 vXRWorldPosition;
varying vec3 vXRWorldNormal;
${PAINTERLY_GLSL}
` + shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `{
         vec3 _xrN = normalize(vXRWorldNormal);
         vec3 _xrToEye = cameraPosition - vXRWorldPosition;
         float _xrDistance = length(_xrToEye);
         vec3 _xrV = _xrToEye / max(_xrDistance, 1e-3);

         // How much of the base pigment survived Three's lighting. This folds
         // the live sun colour, hemisphere fill, moonlight AND the shadow map
         // into one term without re-deriving any of them — which is what lets a
         // fixed-palette shading model live inside a full day/night cycle.
         float _xrBaseLuma = max(dot(diffuseColor.rgb, K_LUMA), 0.025);
         float _xrLitLuma = max(dot(outgoingLight, K_LUMA), 0.002);
         float _xrRelative = clamp(_xrLitLuma / _xrBaseLuma, 0.0, 2.4);
         float _xrShadow = smoothstep(0.18, 0.95, _xrRelative);

         // Worker-baked curvature gives shade weight without an AO pass. Steep
         // faces keep a little extra cool value so mountain relief stays clear.
         float _xrShape = clamp(vXRShade * mix(0.90, 1.0, smoothstep(0.28, 0.82, vXRUp)), 0.68, 1.10);

         // How green the authored pigment is. Gates both the meadow mosaic and
         // the far gust wash below — computed once and passed around rather
         // than derived twice from the same three channels.
         float _xrGreen = smoothstep(0.0, 0.075,
           diffuseColor.g - max(diffuseColor.r, diffuseColor.b));

         Surf _xrS;
         pigments(diffuseColor.rgb, K_SHADOW_DAY, _xrS.shade, _xrS.mid, _xrS.lit);
         _xrS.N = _xrN;
         _xrS.V = _xrV;
         _xrS.shadow = _xrShadow;
         _xrS.ao = _xrShape;
         // Far ground goes flat, near ground keeps a crisp edge — the same
         // reason a background matte gets fewer strokes than a foreground cel.
         _xrS.soft = mix(K_SOFT_NEAR, K_SOFT_FAR, clamp(_xrDistance * 0.004, 0.0, 1.0));
         // world-space wobble, so the band edge crawls over the ground with the
         // terrain rather than swimming across it with the head
         _xrS.jit = (pnValue(vXRWorldPosition.xz * 3.9 + vXRWorldPosition.y * 1.7) - 0.5) * K_JITTER;
         _xrS.rim = 0.16;

         vec3 _xrPainted = paintSurface(_xrS, uAtmoSunDir);

         // The ramp is applied as a TRANSFER around the midtone, not as a
         // replacement for Three's lighting.
         //
         // paintSurface returns colour at pigment scale, which is the right
         // answer in a world with one fixed hour and no other light model — but
         // here Three owns absolute brightness, the day/night cycle and the
         // colour temperature of the sun. Substituting the painted value
         // outright relights dusk as noon, and the desktop grade then turns
         // that bright-but-shadowed pigment into a neon field. Dividing by the
         // midtone yields a multiplier near 1.0 that carries only what the ramp
         // is actually for: the banding, and the hue the shade and lit tones
         // walk toward. How much light there is stays Three's answer.
         vec3 _xrTransfer = _xrPainted / max(_xrS.mid, vec3(0.02));
         // Keep the transfer's value structure, pull most of its chroma out.
         // A per-channel multiplier is an aggressive way to shift hue — the
         // bands are what the eye reads, and post.js already owns the colour a
         // shadow falls to.
         _xrTransfer = mix(vec3(dot(_xrTransfer, K_LUMA)), _xrTransfer, K_XFER_CHROMA);
         outgoingLight *= mix(vec3(1.0), _xrTransfer, uAtmoDay);

         // ── meadow mosaic ─────────────────────────────────────────────────
         // Ground pigment varies with the SAME field the blades standing on it
         // were planted from: groundMacroPatch(), already carried per terrain
         // vertex as aGroundMacro and per blade instance as its patch macro.
         // Nothing new is sampled — the field is already here, it was simply
         // only being used for the gust wash.
         //
         // Sharing it is the point. An independent noise field would give the
         // ground a mosaic too, but it would cut across the mosaic in the grass
         // rather than agree with it; here a dry stand of blades stands on
         // visibly dry ground. The stroke band adds the finer variation that a
         // per-vertex value cannot carry, and stops the mid-ground reading as a
         // flat painted plane between blades.
         float _xrStroke = pnValue(vXRWorldPosition.xz * K_MEADOW_FREQ);
         float _xrDryness = clamp(
           mix(vXRGroundMacro, _xrStroke, K_MEADOW_STRK), 0.0, 1.0);
         outgoingLight *= mix(vec3(1.0),
           meadowTint(diffuseColor.rgb, _xrDryness, _xrGreen), uAtmoDay);

         // Past the true-blade ring, ground pigment carries a travelling gust
         // highlight. It is shared with grass's macro dryness and costs no far
         // geometry, making the meadow continue visually toward the treeline.
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

  material.customProgramCacheKey = () => 'xr-painterly-terrain-v3';
  injectAtmosphere(material, { clouds: true, aerial: true });
  return material;
}
