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
import { LIGHT, MEADOW, PAINT } from './palette.mjs';

// Spatial fields evaluated by the terrain's vertices. Near chunks have a
// roughly two-metre grid and trail ribbons are denser still, so interpolating
// these broad painted fields is visually stable in a headset while avoiding
// duplicate noise, distance and trigonometry work for every pixel in both eyes.
const XR_TERRAIN_VERTEX_FIELDS = /* glsl */`
float xrTerrainHash(vec2 p) {
  p = fract(p * vec2(127.31, 311.7));
  p += dot(p, p + 34.53);
  return fract(p.x * p.y);
}
float xrTerrainNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = xrTerrainHash(i), b = xrTerrainHash(i + vec2(1.0, 0.0));
  float c = xrTerrainHash(i + vec2(0.0, 1.0)), d = xrTerrainHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

export function createXRTerrainMaterial() {
  const grassBands = {
    uXRGrassFarNear: { value: 96 },
    uXRGrassFarFull: { value: 124 },
    uXRGrassFarFade: { value: 190 },
  };
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true,
    fog: true,
    dithering: true,
  });
  material.name = 'xr-painterly-terrain';

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uXRMeadowTime = atmoUniforms.uAtmoTime;
    shader.uniforms.uAtmoSunDir = atmoUniforms.uAtmoSunDir;
    Object.assign(shader.uniforms, grassBands);
    shader.vertexShader = `
attribute float aGroundMacro;
attribute float aXRShade;
uniform float uXRMeadowTime;
uniform float uXRGrassFarNear;
uniform float uXRGrassFarFull;
uniform float uXRGrassFarFade;
uniform vec3 uAtmoSunDir;
varying vec4 vXRViewDistance;
varying vec4 vXRNormalShape;
varying vec4 vXRMeadowPaint;
varying vec3 vXRShadeTone;
varying vec3 vXRMidTone;
varying vec3 vXRLitTone;
${XR_TERRAIN_VERTEX_FIELDS}
` + shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
       vec3 _xrWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
       vec3 _xrWorldNormal = normalize(mat3(modelMatrix) * normal);
       vec3 _xrToEye = cameraPosition - _xrWorldPosition;
       float _xrDistance = length(_xrToEye);
       float _xrShape = clamp(aXRShade * mix(0.90, 1.0,
         smoothstep(0.28, 0.82, _xrWorldNormal.y)), 0.68, 1.10);
       float _xrGreen = smoothstep(0.0, 0.075,
         color.g - max(color.r, color.b));
       float _xrStroke = xrTerrainNoise(_xrWorldPosition.xz * ${MEADOW.strokeScale.toFixed(4)});
       float _xrDryness = clamp(mix(aGroundMacro, _xrStroke,
         ${MEADOW.strokeAmount.toFixed(4)}), 0.0, 1.0);
       float _xrFarMeadow = smoothstep(
         uXRGrassFarNear, uXRGrassFarFull, _xrDistance)
         * (1.0 - smoothstep(
           uXRGrassFarFade * 0.82, uXRGrassFarFade, _xrDistance));
       float _xrWave = sin(dot(_xrWorldPosition.xz, vec2(0.052, 0.037))
                         - uXRMeadowTime * 1.35
                         + sin(_xrWorldPosition.x * 0.016 + uXRMeadowTime * 0.45) * 1.6);
       float _xrGust = smoothstep(0.35, 0.94, _xrWave)
                     * mix(0.60, 1.0, aGroundMacro);
       float _xrJitter = (xrTerrainNoise(
         _xrWorldPosition.xz * 3.9 + _xrWorldPosition.y * 1.7) - 0.5)
         * ${PAINT.jitter.toFixed(4)};
       // The authored ground pigment is a vertex attribute, so derive its
       // complete painted palette here rather than repeating the same luma,
       // hue and clamp work for every covered pixel in both eyes.
       const vec3 _xrLumaWeights = vec3(0.2126, 0.7152, 0.0722);
       const vec3 _xrShadowPigment = vec3(${LIGHT.shadowDay.map((v) => v.toFixed(5)).join(', ')});
       const vec3 _xrSunPigment = vec3(${LIGHT.sunWarm.map((v) => v.toFixed(5)).join(', ')});
       float _xrPigmentLuma = max(dot(color, _xrLumaWeights), 1e-4);
       vXRMidTone = clamp(mix(vec3(_xrPigmentLuma), color,
         ${PAINT.midSat.toFixed(4)}), 0.0, 1.0);
       vec3 _xrShadeBase = color * ${PAINT.shadeMul.toFixed(4)};
       vec3 _xrShadeTint = _xrShadowPigment
         * (_xrPigmentLuma * ${PAINT.shadeMul.toFixed(4)}
           / max(dot(_xrShadowPigment, _xrLumaWeights), 1e-3));
       vXRShadeTone = clamp(mix(_xrShadeBase, _xrShadeTint,
         ${PAINT.shadeHue.toFixed(4)}), 0.0, 1.0);
       vec3 _xrLitBase = color * ${PAINT.litMul.toFixed(4)};
       vec3 _xrLitTint = _xrSunPigment
         * (_xrPigmentLuma * ${PAINT.litMul.toFixed(4)}
           / max(dot(_xrSunPigment, _xrLumaWeights), 1e-3));
       vXRLitTone = clamp(mix(_xrLitBase, _xrLitTint,
         ${PAINT.litHue.toFixed(4)}), 0.0, 1.2);
       vXRViewDistance = vec4(_xrToEye / max(_xrDistance, 1e-3), _xrDistance);
       vXRNormalShape = vec4(_xrWorldNormal, _xrShape);
       vXRMeadowPaint = vec4(_xrDryness, _xrGreen,
         _xrGreen * _xrFarMeadow * _xrGust * 0.11, _xrJitter);`,
    );

    shader.fragmentShader = `
varying vec4 vXRViewDistance;
varying vec4 vXRNormalShape;
varying vec4 vXRMeadowPaint;
varying vec3 vXRShadeTone;
varying vec3 vXRMidTone;
varying vec3 vXRLitTone;
${PAINTERLY_GLSL}
` + shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `{
         vec3 _xrN = normalize(vXRNormalShape.xyz);
         vec3 _xrV = normalize(vXRViewDistance.xyz);
         float _xrDistance = vXRViewDistance.w;

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
         float _xrShape = vXRNormalShape.w;

         // How green the authored pigment is. Gates both the meadow mosaic and
         // the far gust wash below — computed once and passed around rather
         // than derived twice from the same three channels.
         float _xrGreen = vXRMeadowPaint.y;

         Surf _xrS;
         _xrS.shade = vXRShadeTone;
         _xrS.mid = vXRMidTone;
         _xrS.lit = vXRLitTone;
         _xrS.N = _xrN;
         _xrS.V = _xrV;
         _xrS.shadow = _xrShadow;
         _xrS.ao = _xrShape;
         // Far ground goes flat, near ground keeps a crisp edge — the same
         // reason a background matte gets fewer strokes than a foreground cel.
         _xrS.soft = mix(K_SOFT_NEAR, K_SOFT_FAR, clamp(_xrDistance * 0.004, 0.0, 1.0));
         // world-space wobble, so the band edge crawls over the ground with the
         // terrain rather than swimming across it with the head
         _xrS.jit = vXRMeadowPaint.w;
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
         outgoingLight *= mix(vec3(1.0),
           meadowTint(diffuseColor.rgb, vXRMeadowPaint.x, _xrGreen), uAtmoDay);

         // Past the true-blade ring, ground pigment carries a travelling gust
         // highlight. It is shared with grass's macro dryness and costs no far
         // geometry, making the meadow continue visually toward the treeline.
         outgoingLight *= 1.0 + vXRMeadowPaint.z * uAtmoDay;
       }
       #include <opaque_fragment>`,
    );
  };

  material.userData.setXRGrassPlan = (plan) => {
    if (!plan?.far) return false;
    grassBands.uXRGrassFarNear.value = plan.far.near;
    grassBands.uXRGrassFarFull.value = plan.far.full;
    grassBands.uXRGrassFarFade.value = plan.far.fade;
    return true;
  };

  material.customProgramCacheKey = () => 'xr-painterly-terrain-v5-vertex-fields';
  injectAtmosphere(material, { clouds: true, aerial: true });
  return material;
}
