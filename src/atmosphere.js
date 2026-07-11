// Atmosphere shader injection — three cheap, stackable effects applied to the
// world's lit materials via onBeforeCompile, all driven by one shared set of
// uniforms (one per-frame update covers every material):
//
//   1. Cloud shadows  — a low-frequency noise drifts across the world and
//      darkens the ground/foliage in soft moving patches.
//   2. Leaf back-light — when you look toward the sun through foliage/grass,
//      light scatters forward and the leaves glow (translucency).
//   3. Aerial haze    — distant surfaces desaturate toward a hazy blue with
//      distance, giving depth and scale (atmospheric perspective).
//
// Effects modify the LINEAR lit colour right after <opaque_fragment>, before
// tonemapping, so they compose correctly with the rest of the pipeline.

import * as THREE from 'three';
import { windUniforms } from './wind.js';

const u = {
  uAtmoTime:   { value: 0 },
  uAtmoSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uAtmoSunCol: { value: new THREE.Color(1, 1, 1) },
  uAtmoDay:    { value: 1 },
  uAtmoAerial: { value: new THREE.Color(0.30, 0.43, 0.62) },
  uAtmoCloudCover:  { value: 0.4 },
  uAtmoCloudShadow: { value: 0.65 },
};
// shared so custom materials (e.g. the GPU grass field) can light to match
export const atmoUniforms = u;

// uniquely-named noise so it never clashes with a material's own injected noise
const ATMO_GLSL = /* glsl */`
uniform float uAtmoTime;
uniform float uAtmoDay;
uniform float uAtmoCloudCover, uAtmoCloudShadow;
uniform vec2 uWindOffset;
uniform vec3 uAtmoSunDir;
uniform vec3 uAtmoSunCol;
uniform vec3 uAtmoAerial;
varying vec3 vAtmoWP;
float aCloudHash(vec2 p){ p = fract(p * vec2(127.31, 311.7)); p += dot(p, p + 34.53); return fract(p.x * p.y); }
float aCloudNoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = aCloudHash(i), b = aCloudHash(i + vec2(1,0)), c = aCloudHash(i + vec2(0,1)), d = aCloudHash(i + vec2(1,1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float aCloudFbm(vec2 p){ return aCloudNoise(p) * 0.65 + aCloudNoise(p * 2.7) * 0.35; }
`;

// Add the effects to a material. opts: { clouds, aerial, backlight }.
export function injectAtmosphere(material, opts = {}) {
  const { clouds = true, aerial = true, backlight = false } = opts;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer); // keep the material's own shader work

    shader.uniforms.uAtmoTime = u.uAtmoTime;
    shader.uniforms.uAtmoSunDir = u.uAtmoSunDir;
    shader.uniforms.uAtmoSunCol = u.uAtmoSunCol;
    shader.uniforms.uAtmoDay = u.uAtmoDay;
    shader.uniforms.uAtmoAerial = u.uAtmoAerial;
    shader.uniforms.uAtmoCloudCover = u.uAtmoCloudCover;
    shader.uniforms.uAtmoCloudShadow = u.uAtmoCloudShadow;
    shader.uniforms.uWindOffset = windUniforms.uWindOffset;

    // capture world position (instancing-aware) after project_vertex
    shader.vertexShader = 'varying vec3 vAtmoWP;\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      {
        vec4 _awp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          _awp = instanceMatrix * _awp;
        #endif
        vAtmoWP = (modelMatrix * _awp).xyz;
      }`
    );

    let fx = '';
    if (clouds) fx += `
      {
        // Low cloud shadows travel at the visible flat layer's 70% wind rate.
        vec2 _cp = (vAtmoWP.xz - uWindOffset * 0.70) * 0.0016;
        float _threshold = mix(0.70, 0.38, uAtmoCloudCover);
        float _mask = smoothstep(_threshold - 0.08, _threshold + 0.08, aCloudFbm(_cp));
        gl_FragColor.rgb *= 1.0 - _mask * (0.40 * uAtmoCloudShadow * uAtmoDay);
      }`;
    if (backlight) fx += `
      {
        vec3 _Vw = normalize(cameraPosition - vAtmoWP);
        float _bk = pow(max(dot(-_Vw, uAtmoSunDir), 0.0), 3.0);
        gl_FragColor.rgb += uAtmoSunCol * gl_FragColor.rgb * (_bk * 0.6 * uAtmoDay);
      }`;
    if (aerial) fx += `
      {
        float _d = length(cameraPosition - vAtmoWP);
        float _a = (1.0 - exp(-max(_d - 300.0, 0.0) * 0.00030)) * 0.55 * uAtmoDay;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uAtmoAerial, clamp(_a, 0.0, 0.55));
      }`;

    shader.fragmentShader = ATMO_GLSL + shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      '#include <opaque_fragment>\n' + fx
    );
  };
  material.needsUpdate = true;
}

export function updateAtmosphere(dt, sky, fog, weather) {
  u.uAtmoTime.value += dt;
  const day = u.uAtmoDay.value = THREE.MathUtils.smoothstep(sky.sunElevation, -0.04, 0.12);
  u.uAtmoCloudCover.value = weather?.cloudCover ?? sky.day.cloudCover;
  u.uAtmoCloudShadow.value = weather?.cloudShadow ?? 0.65;
  u.uAtmoSunDir.value.copy(sky.sunDir);
  u.uAtmoSunCol.value.copy(sky.sun.color).multiplyScalar(Math.min(sky.sun.intensity / 3.1, 1));
  // hazy blue that follows the horizon/fog and fades to near-black at night
  u.uAtmoAerial.value.setRGB(0.40, 0.50, 0.66).multiplyScalar(0.25 + 0.75 * day).lerp(fog.color, 0.35);
}
